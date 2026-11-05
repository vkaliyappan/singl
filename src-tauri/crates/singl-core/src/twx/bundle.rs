//! Packs each project's alias folder into `<dest>/<alias>.zip`, with entries
//! under `<alias>/`. From singl-web's `bundler.ts` (adm-zip `addLocalFolder`).

use std::io::Write;
use std::path::Path;

use serde::Serialize;
use tokio_util::sync::CancellationToken;
use zip::write::SimpleFileOptions;

use super::projects::DeployProject;
use crate::{CoreError, Result};

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BundleResult {
  pub projects_processed: u32,
  pub zips_created: u32,
  pub errors: Vec<String>,
}

/// Zips `src` into `dest` as `<prefix>/…`. Returns the number of entries.
fn zip_folder(src: &Path, prefix: &str, dest: &Path) -> Result<usize> {
  let mut zip = zip::ZipWriter::new(std::fs::File::create(dest)?);
  let opts = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
  let mut entries = 0;
  for entry in walkdir::WalkDir::new(src).min_depth(1).sort_by_file_name() {
    let entry = entry.map_err(|e| CoreError::Io(e.into()))?;
    let rel = entry.path().strip_prefix(src).unwrap_or(entry.path()).to_string_lossy().replace('\\', "/");
    let name = format!("{prefix}/{rel}");
    let zipped = if entry.file_type().is_dir() { zip.add_directory(name, opts) } else { zip.start_file(name, opts) };
    zipped.map_err(|e| CoreError::Invalid(e.to_string()))?;
    if entry.file_type().is_file() {
      zip.write_all(&std::fs::read(entry.path())?)?;
    }
    entries += 1;
  }
  zip.finish().map_err(|e| CoreError::Invalid(e.to_string()))?;
  Ok(entries)
}

/// One bundle per alias folder; several projects can share an alias.
pub fn run(
  projects: &[DeployProject],
  src: &Path,
  dest: &Path,
  filter: Option<&str>,
  dry_run: bool,
  cancel: &CancellationToken,
  log: &mut (dyn FnMut(String) + Send),
) -> Result<BundleResult> {
  let mut result = BundleResult::default();
  let mut seen = std::collections::HashSet::new();
  for proj in projects.iter().filter(|p| seen.insert(p.alias.clone())) {
    if cancel.is_cancelled() {
      return Err(CoreError::Cancelled);
    }
    let alias = &proj.alias;
    if filter.is_some_and(|f| !f.is_empty() && f != alias && f != proj.project_name) {
      continue;
    }
    let project_src = src.join(alias);
    let zip_name = format!("{alias}.zip");
    let zip_dest = dest.join(&zip_name);
    if !project_src.exists() {
      log(format!("[{alias}] Skipping — source folder not found: {}", project_src.display()));
      continue;
    }
    log(format!("[{alias}] Zipping {} → {}", project_src.display(), zip_dest.display()));
    if dry_run {
      log(format!("[{alias}] (dry-run) Would create {zip_name}"));
      result.projects_processed += 1;
      continue;
    }
    match std::fs::create_dir_all(dest).map_err(CoreError::from).and_then(|()| zip_folder(&project_src, alias, &zip_dest)) {
      Ok(entries) => {
        log(format!("[{alias}] Done — {zip_name} ({entries} entries)"));
        result.projects_processed += 1;
        result.zips_created += 1;
      }
      Err(err) => {
        log(format!("[{alias}] Error: {err}"));
        result.errors.push(format!("{alias}: {err}"));
      }
    }
  }
  Ok(result)
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn bundles_alias_folders() {
    let dir = tempfile::tempdir().unwrap();
    let src = dir.path().join("src");
    std::fs::create_dir_all(src.join("App/P/Things")).unwrap();
    std::fs::write(src.join("App/P/Things/T.xml"), "<x/>").unwrap();
    let projects = [
      DeployProject { key: "P".into(), alias: "App".into(), project_name: "P".into(), exports: vec![] },
      DeployProject { key: "Q".into(), alias: "App".into(), project_name: "Q".into(), exports: vec![] },
      DeployProject { key: "R".into(), alias: "Missing".into(), project_name: "R".into(), exports: vec![] },
    ];
    let dest = dir.path().join("bundles");
    let result = run(&projects, &src, &dest, None, false, &CancellationToken::new(), &mut |_| {}).unwrap();
    assert_eq!((result.projects_processed, result.zips_created), (1, 1));
    let mut archive = zip::ZipArchive::new(std::fs::File::open(dest.join("App.zip")).unwrap()).unwrap();
    assert!(archive.by_name("App/P/Things/T.xml").is_ok());
  }
}
