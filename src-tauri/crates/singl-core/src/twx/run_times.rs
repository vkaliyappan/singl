//! When each environment was last exported / extracted, in
//! `twx-run-times.json` (outside `twx-entities`, so it never shows
//! in the entity tree). Same file and shape as singl-web.

use std::collections::BTreeMap;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::Result;

#[derive(Debug, Clone, Copy)]
pub enum RunKind {
  Exported,
  Extracted,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunTimes {
  #[serde(skip_serializing_if = "Option::is_none")]
  pub last_exported: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub last_extracted: Option<String>,
}

fn read_all(file: &Path) -> BTreeMap<String, RunTimes> {
  std::fs::read_to_string(file).ok().and_then(|text| serde_json::from_str(&text).ok()).unwrap_or_default()
}

pub fn get(file: &Path, safe_env: &str) -> RunTimes {
  read_all(file).remove(safe_env).unwrap_or_default()
}

/// Stamps `kind` for `safe_env` with the current time and returns it.
pub fn record(file: &Path, safe_env: &str, kind: RunKind) -> Result<String> {
  let now = super::stamp::iso_now();
  let mut all = read_all(file);
  let entry = all.entry(safe_env.to_string()).or_default();
  match kind {
    RunKind::Exported => entry.last_exported = Some(now.clone()),
    RunKind::Extracted => entry.last_extracted = Some(now.clone()),
  }
  if let Some(dir) = file.parent() {
    std::fs::create_dir_all(dir)?;
  }
  std::fs::write(file, serde_json::to_string_pretty(&all).expect("map serializes"))?;
  Ok(now)
}

/// An environment name made safe for a folder name.
pub fn safe_env(env: &str) -> String {
  env.chars().map(|c| if c.is_ascii_alphanumeric() || c == '_' || c == '-' { c } else { '_' }).collect()
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn records_per_env() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("twx-run-times.json");
    assert!(get(&file, "dev").last_extracted.is_none());
    let at = record(&file, "dev", RunKind::Extracted).unwrap();
    assert_eq!(get(&file, "dev").last_extracted, Some(at));
    assert_eq!(safe_env("my env/1"), "my_env_1");
  }
}
