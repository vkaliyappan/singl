//! Integration connectors carry environment-specific endpoints in two places
//! of their entity XML: the Thing's own ConfigurationTables (BaseURL,
//! AuthUsername, …) and its ThingProperties (e.g. SwaggerJSON `servers[].url`).
//! Service definitions further down hold their own nested ConfigurationTables
//! and code; those are left alone. From singl-web's `connector-config.ts`.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Component, Path, PathBuf};
use std::sync::LazyLock;

use regex::Regex;
use serde::{Deserialize, Serialize};
use tokio_util::sync::CancellationToken;

use crate::repo::files::{remove_dir_all, safe_join};
use crate::{CoreError, Result};

static URL_ORIGIN: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"https?://[A-Za-z0-9.-]+(?::\d+)?").unwrap());
static FULL_ORIGIN: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^https?://[A-Za-z0-9.-]+(?::\d+)?$").unwrap());
static THING_TAG: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"<Thing\s[^>]*>").unwrap());
static CDATA: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?s)<!\[CDATA\[(.*?)\]\]>").unwrap());
static AUTH_USERNAME: LazyLock<Regex> =
  LazyLock::new(|| Regex::new(r"(?m)^([ \t]*)<AuthUsername>(?s:.*?)</AuthUsername>").unwrap());

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct ConnectorUrl {
  /// Scheme + host (+ port), e.g. "https://example.ptcmscloud.com".
  pub origin: String,
  pub occurrences: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectorInfo {
  pub name: String,
  pub thing_template: String,
  /// Path relative to the source directory, forward slashes.
  pub rel_path: String,
  pub urls: Vec<ConnectorUrl>,
  /// BaseURL from HTTPConnectorConnectionSettings, shown as context.
  pub base_url: Option<String>,
  /// AuthUsername, or `None` when the connector has no such field.
  pub username: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectorUpdate {
  pub rel_path: String,
  /// Old origin → new origin.
  #[serde(default)]
  pub url_map: BTreeMap<String, String>,
  /// New AuthUsername; `None` leaves it unchanged.
  #[serde(default)]
  pub username: Option<String>,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectorUpdateResult {
  pub connectors_found: u32,
  pub connectors_updated: u32,
  pub urls_replaced: u32,
  pub usernames_updated: u32,
  pub files_copied: u32,
  pub dest_dir: String,
  pub errors: Vec<String>,
}

type Section = (usize, usize);

/// The Thing-level ConfigurationTables block (the first one in the file).
fn config_section(xml: &str) -> Option<Section> {
  let start = xml.find("<ConfigurationTables>")?;
  let end = start + xml[start..].find("</ConfigurationTables>")?;
  Some((start, end))
}

/// The Thing-level ThingProperties block, which follows the ThingShape.
fn properties_section(xml: &str) -> Option<Section> {
  let from = xml.rfind("</ThingShape>").unwrap_or(0);
  let start = from + xml[from..].find("<ThingProperties>")?;
  let end = start + xml[start..].find("</ThingProperties>")?;
  Some((start, end))
}

fn sections(xml: &str) -> Vec<Section> {
  [config_section(xml), properties_section(xml)].into_iter().flatten().collect()
}

/// Text of the first `<tag>…</tag>`, CDATA unwrapped and trimmed.
fn tag_value(text: &str, tag: &str) -> Option<String> {
  let open = format!("<{tag}>");
  let start = text.find(&open)? + open.len();
  let end = start + text[start..].find(&format!("</{tag}>"))?;
  let inner = &text[start..end];
  Some(CDATA.captures(inner).map_or(inner, |c| c.get(1).unwrap().as_str()).trim().to_string())
}

fn attr(tag: &str, name: &str) -> String {
  Regex::new(&format!(r#"\s{}="([^"]*)""#, regex::escape(name)))
    .unwrap()
    .captures(tag)
    .map(|c| c[1].to_string())
    .unwrap_or_default()
}

pub fn parse_connector(xml: &str, rel_path: &str) -> Option<ConnectorInfo> {
  let thing_tag = THING_TAG.find(xml)?.as_str();
  let thing_template = attr(thing_tag, "thingTemplate");
  if !thing_template.to_lowercase().contains("connector") {
    return None;
  }

  let mut counts: Vec<ConnectorUrl> = Vec::new();
  for (start, end) in sections(xml) {
    for m in URL_ORIGIN.find_iter(&xml[start..end]) {
      match counts.iter_mut().find(|u| u.origin == m.as_str()) {
        Some(url) => url.occurrences += 1,
        None => counts.push(ConnectorUrl { origin: m.as_str().into(), occurrences: 1 }),
      }
    }
  }

  let config_text = config_section(xml).map_or("", |(s, e)| &xml[s..e]);
  let stem = Path::new(rel_path).file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
  let name = attr(thing_tag, "name");
  Some(ConnectorInfo {
    name: if name.is_empty() { stem } else { name },
    thing_template,
    rel_path: rel_path.into(),
    urls: counts,
    base_url: tag_value(config_text, "BaseURL"),
    username: config_text.contains("<AuthUsername>").then(|| tag_value(config_text, "AuthUsername").unwrap_or_default()),
  })
}

/// Writes `value` into the first `<AuthUsername>` in the layout the extractor
/// produces, keeping the file's own line endings.
fn set_username(config_text: &str, value: &str) -> String {
  let nl = if config_text.contains("\r\n") { "\r\n" } else { "\n" };
  AUTH_USERNAME
    .replacen(config_text, 1, |c: &regex::Captures| {
      let indent = &c[1];
      if value.is_empty() {
        format!("{indent}<AuthUsername></AuthUsername>")
      } else {
        [
          format!("{indent}<AuthUsername>"),
          format!("{indent}<![CDATA["),
          format!("{indent}{value}"),
          format!("{indent}]]>"),
          format!("{indent}</AuthUsername>"),
        ]
        .join(nl)
      }
    })
    .into_owned()
}

/// Returns the rewritten XML, how many URLs changed, and whether the username did.
pub fn apply_update(xml: &str, update: &ConnectorUpdate) -> (String, u32, bool) {
  let entries: HashMap<&str, &str> = update
    .url_map
    .iter()
    .filter(|(from, to)| !from.is_empty() && !to.is_empty() && from != to)
    .map(|(f, t)| (f.as_str(), t.as_str()))
    .collect();
  let config = config_section(xml);
  let mut ordered = sections(xml);
  // Rewrite back to front so earlier offsets stay valid.
  ordered.sort_by_key(|s| std::cmp::Reverse(s.0));

  let (mut urls_replaced, mut username_updated) = (0, false);
  let mut out = xml.to_string();
  for (start, end) in ordered {
    let mut text = out[start..end].to_string();
    if !entries.is_empty() {
      text = URL_ORIGIN
        .replace_all(&text, |c: &regex::Captures| match entries.get(&c[0]) {
          Some(next) => {
            urls_replaced += 1;
            (*next).to_string()
          }
          None => c[0].to_string(),
        })
        .into_owned();
    }
    if config.is_some_and(|c| c.0 == start)
      && let Some(username) = &update.username
    {
      let before = text.clone();
      text = set_username(&text, username);
      username_updated = text != before;
    }
    out.replace_range(start..end, &text);
  }
  (out, urls_replaced, username_updated)
}

/// Every `.xml` directly in a `Things` folder under `dir`, relative, sorted.
fn list_thing_files(dir: &Path) -> Result<Vec<String>> {
  let mut files = Vec::new();
  let walk = walkdir::WalkDir::new(dir)
    .into_iter()
    .filter_entry(|e| e.depth() == 0 || !e.file_name().to_string_lossy().starts_with('.'));
  for entry in walk {
    let entry = entry.map_err(|e| CoreError::Io(e.into()))?;
    let in_things = entry.path().parent().and_then(Path::file_name).is_some_and(|n| n == "Things");
    if entry.file_type().is_file() && in_things && entry.file_name().to_string_lossy().to_lowercase().ends_with(".xml")
    {
      files.push(entry.path().strip_prefix(dir).unwrap_or(entry.path()).to_string_lossy().replace('\\', "/"));
    }
  }
  files.sort();
  Ok(files)
}

pub fn scan(source: &Path) -> Result<Vec<ConnectorInfo>> {
  let mut connectors = Vec::new();
  for rel in list_thing_files(source)? {
    let xml = String::from_utf8_lossy(&std::fs::read(source.join(&rel))?).into_owned();
    connectors.extend(parse_connector(&xml, &rel));
  }
  Ok(connectors)
}

/// Lexically normalised, so `a/./b/../c` and `a/c` compare equal.
fn normalize(path: &Path) -> PathBuf {
  let mut out = PathBuf::new();
  for part in path.components() {
    match part {
      Component::CurDir => {}
      Component::ParentDir => {
        out.pop();
      }
      other => out.push(other),
    }
  }
  out
}

fn copy_dir(src: &Path, dest: &Path) -> Result<()> {
  for entry in walkdir::WalkDir::new(src) {
    let entry = entry.map_err(|e| CoreError::Io(e.into()))?;
    let target = dest.join(entry.path().strip_prefix(src).unwrap_or(entry.path()));
    if entry.file_type().is_dir() {
      std::fs::create_dir_all(&target)?;
    } else {
      std::fs::copy(entry.path(), &target)?;
    }
  }
  Ok(())
}

/// Copies `source` to `dest` and rewrites the connector files there. When
/// both are the same folder the connectors are updated in place.
pub fn run_update(
  source: &Path,
  dest: &Path,
  updates: &[ConnectorUpdate],
  clean_dest: bool,
  dry_run: bool,
  cancel: &CancellationToken,
  log: &mut (dyn FnMut(String) + Send),
) -> Result<ConnectorUpdateResult> {
  for update in updates {
    for to in update.url_map.values() {
      if !to.is_empty() && !FULL_ORIGIN.is_match(to) {
        return Err(CoreError::Invalid(format!("\"{to}\" is not a URL of the form https://host[:port].")));
      }
    }
  }
  let (src_n, dest_n) = (normalize(source), normalize(dest));
  let in_place = src_n == dest_n;
  if !in_place && (dest_n.starts_with(&src_n) || src_n.starts_with(&dest_n)) {
    return Err(CoreError::Invalid("Source and destination must not be inside one another.".into()));
  }
  if !source.is_dir() {
    return Err(CoreError::NotFound(format!("Source directory not found: {}", source.display())));
  }

  let connectors = scan(source)?;
  let known: HashSet<&str> = connectors.iter().map(|c| c.rel_path.as_str()).collect();
  let mut result = ConnectorUpdateResult {
    connectors_found: connectors.len() as u32,
    dest_dir: dest.display().to_string(),
    ..Default::default()
  };
  log(format!("Found {} integration connector(s) in {}", connectors.len(), source.display()));
  let dry = if dry_run { "(dry-run) " } else { "" };

  if !in_place {
    if clean_dest {
      log(format!("{} {}", if dry_run { "(dry-run) Would clear" } else { "Clearing" }, dest.display()));
      if !dry_run && dest.exists() {
        remove_dir_all(dest)?;
      }
    }
    log(format!(
      "{} {} → {}",
      if dry_run { "(dry-run) Would copy" } else { "Copying" },
      source.display(),
      dest.display()
    ));
    if !dry_run {
      copy_dir(source, dest)?;
    }
  }

  for update in updates {
    if cancel.is_cancelled() {
      return Err(CoreError::Cancelled);
    }
    let rel = &update.rel_path;
    if !known.contains(rel.as_str()) {
      result.errors.push(format!("{rel}: not an integration connector in the source directory"));
      log(format!("[{rel}] Not found among connectors, skipping."));
      continue;
    }
    let applied = (|| {
      let xml = String::from_utf8_lossy(&std::fs::read(safe_join(source, rel)?)?).into_owned();
      let (updated, urls, username_updated) = apply_update(&xml, update);
      let label = Path::new(rel).file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
      if urls == 0 && !username_updated {
        log(format!("[{label}] No changes."));
        return Ok(None);
      }
      for (from, to) in &update.url_map {
        if !from.is_empty() && !to.is_empty() && from != to {
          log(format!("[{label}] {dry}{from} → {to}"));
        }
      }
      if username_updated {
        let shown = update.username.as_deref().filter(|u| !u.is_empty()).unwrap_or("(empty)");
        log(format!("[{label}] {dry}AuthUsername → {shown}"));
      }
      if !dry_run {
        std::fs::write(safe_join(dest, rel)?, updated)?;
      }
      Ok::<_, CoreError>(Some((urls, username_updated)))
    })();
    match applied {
      Ok(Some((urls, username_updated))) => {
        result.connectors_updated += 1;
        result.urls_replaced += urls;
        result.usernames_updated += u32::from(username_updated);
      }
      Ok(None) => {}
      Err(err) => {
        log(format!("[{rel}] Failed: {err}"));
        result.errors.push(format!("{rel}: {err}"));
      }
    }
  }

  if !in_place && !dry_run {
    result.files_copied =
      walkdir::WalkDir::new(dest).into_iter().flatten().filter(|e| e.file_type().is_file()).count() as u32;
  }
  Ok(result)
}

#[cfg(test)]
mod tests {
  use super::*;

  const XML: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<Entities>
    <Things>
        <Thing
         name="ERPConnector"
         thingTemplate="SwaggerConnector">
            <ConfigurationTables>
                <BaseURL>https://old.example.com:8443/api</BaseURL>
                <AuthUsername>
                <![CDATA[
                svc_user
                ]]>
                </AuthUsername>
            </ConfigurationTables>
            <ThingShape>
                <ServiceDefinitions><x>https://old.example.com:8443/untouched</x></ServiceDefinitions>
            </ThingShape>
            <ThingProperties>
                <SwaggerJSON>{"servers":[{"url":"https://old.example.com:8443"}]}</SwaggerJSON>
            </ThingProperties>
        </Thing>
    </Things>
</Entities>
"#;

  #[test]
  fn parses_and_rewrites_only_thing_level_sections() {
    let info = parse_connector(XML, "App/P/Things/ERPConnector.xml").unwrap();
    assert_eq!(info.urls, [ConnectorUrl { origin: "https://old.example.com:8443".into(), occurrences: 2 }]);
    assert_eq!(info.base_url.as_deref(), Some("https://old.example.com:8443/api"));
    assert_eq!(info.username.as_deref(), Some("svc_user"));

    let update = ConnectorUpdate {
      rel_path: info.rel_path.clone(),
      url_map: [("https://old.example.com:8443".to_string(), "https://new.example.com".to_string())].into(),
      username: Some("other".into()),
    };
    let (out, urls, username) = apply_update(XML, &update);
    assert_eq!((urls, username), (2, true));
    assert!(out.contains("https://old.example.com:8443/untouched"));
    assert!(out.contains("<BaseURL>https://new.example.com/api</BaseURL>"));
    assert!(out.contains("                <![CDATA[\n                other\n                ]]>"));
  }

  #[test]
  fn copies_then_updates() {
    let dir = tempfile::tempdir().unwrap();
    let src = dir.path().join("src");
    std::fs::create_dir_all(src.join("App/P/Things")).unwrap();
    std::fs::write(src.join("App/P/Things/ERPConnector.xml"), XML).unwrap();
    std::fs::write(src.join("App/P/Things/Plain.xml"), "<Thing name=\"x\" thingTemplate=\"GenericThing\">").unwrap();
    assert_eq!(scan(&src).unwrap().len(), 1);

    let dest = dir.path().join("dest");
    let update = ConnectorUpdate {
      rel_path: "App/P/Things/ERPConnector.xml".into(),
      url_map: [("https://old.example.com:8443".to_string(), "https://new.example.com".to_string())].into(),
      username: None,
    };
    let result = run_update(&src, &dest, &[update], false, false, &CancellationToken::new(), &mut |_| {}).unwrap();
    assert_eq!((result.connectors_updated, result.urls_replaced, result.files_copied), (1, 2, 2));
    assert!(std::fs::read_to_string(dest.join("App/P/Things/ERPConnector.xml")).unwrap().contains("new.example.com"));
    assert!(std::fs::read_to_string(src.join("App/P/Things/ERPConnector.xml")).unwrap().contains("old.example.com"));
    assert!(run_update(&src, &src.join("sub"), &[], false, true, &CancellationToken::new(), &mut |_| {}).is_err());
  }
}
