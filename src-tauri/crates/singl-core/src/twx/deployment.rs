//! Deployment files: export each project as a ZIP from ThingWorx, extract
//! those ZIPs into formatted entity XML, back projects up on the server, and
//! upload a folder into a file repository. From singl-web's
//! `deployment-{exporter,extractor,backup,uploader}.ts`.

use std::io::Read;
use std::path::{Path, PathBuf};

use serde::Serialize;
use tokio_util::sync::CancellationToken;

use super::api::Client;
use super::projects::DeployProject;
use super::xmlformat::format_entity_xml;
use crate::repo::files::safe_join;
use crate::{CoreError, Result};

pub const REPOSITORY: &str = "SystemRepository";

fn check(cancel: &CancellationToken) -> Result<()> {
  if cancel.is_cancelled() { Err(CoreError::Cancelled) } else { Ok(()) }
}

fn folder_name(key: &str, suffix: Option<&str>) -> String {
  match suffix.filter(|s| !s.is_empty()) {
    Some(suffix) => format!("{key}_{suffix}"),
    None => key.to_string(),
  }
}

// ── Export ──────────────────────────────────────────────────────────────────

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportResult {
  pub projects_processed: u32,
  pub zips_saved: u32,
  pub saved_files: Vec<String>,
  pub exported_dir: String,
  pub errors: Vec<String>,
}

/// Exports each project to SystemRepository/`<parent>/<key>[_suffix]` as a
/// ZIP, then downloads it to the same path under `output`.
#[allow(clippy::too_many_arguments)]
pub async fn export(
  client: &Client,
  projects: &[DeployProject],
  output: &Path,
  parent: &str,
  suffix: Option<&str>,
  dry_run: bool,
  cancel: &CancellationToken,
  log: &mut (dyn FnMut(String) + Send),
) -> Result<ExportResult> {
  let mut result =
    ExportResult { exported_dir: output.join(parent).display().to_string(), ..Default::default() };

  for proj in projects {
    check(cancel)?;
    let key = &proj.key;
    let folder = folder_name(key, suffix);
    let file_name = format!("{folder}.zip");
    let remote_dir = format!("{parent}/{folder}");
    let local_dir = output.join(parent).join(&folder);
    let zip_path = local_dir.join(&file_name);
    result.projects_processed += 1;

    if dry_run {
      log(format!(
        "[{key}] (dry-run) Would export {} → {REPOSITORY}/{remote_dir}/{file_name}",
        proj.project_name
      ));
      log(format!("[{key}] (dry-run) Would save locally → {}", zip_path.display()));
      continue;
    }

    log(format!("[{key}] Exporting {} to {REPOSITORY}/{remote_dir}/{file_name}...", proj.project_name));
    if let Err(err) = client.export_project_to_zip(&proj.project_name, &remote_dir, &file_name).await {
      log(format!("[{key}] Export failed: {err}"));
      result.errors.push(format!("{key}: export failed - {err}"));
      continue;
    }
    log(format!("[{key}] Export triggered. Downloading..."));
    let bytes = match client.download_repository_file(&remote_dir, &file_name).await {
      Ok(bytes) => bytes,
      Err(err) => {
        log(format!("[{key}] Download failed: {err}"));
        result.errors.push(format!("{key}: download failed - {err}"));
        continue;
      }
    };
    std::fs::create_dir_all(&local_dir)?;
    std::fs::write(&zip_path, bytes)?;
    log(format!("[{key}] Saved {}", zip_path.display()));
    result.saved_files.push(zip_path.display().to_string());
    result.zips_saved += 1;
  }
  Ok(result)
}

// ── Extract ─────────────────────────────────────────────────────────────────

const ENTITY_TYPE_FOLDERS: &[&str] = &[
  "Things",
  "Mashups",
  "DataShapes",
  "ThingShapes",
  "ThingTemplates",
  "Projects",
  "MediaEntities",
  "StyleThemes",
  "Groups",
  "Organizations",
  "StateDefinitions",
  "StyleDefinitions",
];

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtractResult {
  pub zip_files_processed: u32,
  pub entities_extracted: u32,
  pub entities_skipped: u32,
  pub errors: Vec<String>,
}

/// Where a ZIP entry goes: `(<Collection>, <file within it>)`, the collection
/// being the entry's first or second path segment.
fn entry_target(entry_name: &str) -> Option<(String, String)> {
  let parts: Vec<&str> = entry_name.split(['/', '\\']).filter(|p| !p.is_empty()).collect();
  if parts.len() < 2 {
    return None;
  }
  if ENTITY_TYPE_FOLDERS.contains(&parts[0]) {
    Some((parts[0].into(), parts[1..].join("/")))
  } else if parts.len() >= 3 && ENTITY_TYPE_FOLDERS.contains(&parts[1]) {
    Some((parts[1].into(), parts[2..].join("/")))
  } else {
    None
  }
}

/// For each `<input>/<key>[_suffix]/<same>.zip`, writes its entities as
/// formatted XML to `<output>/<alias>/<key>/<Collection>/`.
pub fn extract(
  projects: &[DeployProject],
  input: &Path,
  output: &Path,
  dry_run: bool,
  cancel: &CancellationToken,
  log: &mut (dyn FnMut(String) + Send),
) -> Result<ExtractResult> {
  let mut result = ExtractResult::default();
  let mut folders: Vec<String> = std::fs::read_dir(input)
    .map_err(|err| {
      CoreError::NotFound(format!(
        "Failed to read input directory \"{}\": {err}. Point to the directory that contains the project folders (e.g. ./export/20260518-120000)",
        input.display()
      ))
    })?
    .flatten()
    .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
    .map(|e| e.file_name().to_string_lossy().into_owned())
    .collect();
  folders.sort();

  for folder in folders {
    check(cancel)?;
    let Some(proj) = projects.iter().find(|p| folder == p.key || folder.starts_with(&format!("{}_", p.key))) else {
      log(format!("[{folder}] No matching project found, skipping."));
      continue;
    };
    let key = &proj.key;
    let zip_path = input.join(&folder).join(format!("{folder}.zip"));
    if !zip_path.is_file() {
      log(format!("[{key}] ZIP not found at {}, skipping.", zip_path.display()));
      continue;
    }

    log(format!("[{key}] Extracting {}...", zip_path.display()));
    let mut archive = match std::fs::File::open(&zip_path).map_err(CoreError::from).and_then(|f| {
      zip::ZipArchive::new(f).map_err(|e| CoreError::Invalid(e.to_string()))
    }) {
      Ok(archive) => archive,
      Err(err) => {
        log(format!("[{key}] Failed to open ZIP: {err}"));
        result.errors.push(format!("{key}: failed to open ZIP - {err}"));
        continue;
      }
    };

    for i in 0..archive.len() {
      let mut entry = match archive.by_index(i) {
        Ok(entry) => entry,
        Err(err) => {
          result.errors.push(format!("{key}: entry {i}: {err}"));
          result.entities_skipped += 1;
          continue;
        }
      };
      if entry.is_dir() {
        continue;
      }
      let name = entry.name().map(|n| n.into_owned()).unwrap_or_else(|_| format!("entry {i}"));
      let Some((collection, file)) = entry_target(&name) else {
        if name.split(['/', '\\']).filter(|p| !p.is_empty()).count() >= 2 {
          log(format!("[{key}] Unrecognised entry \"{name}\", skipping."));
        }
        result.entities_skipped += 1;
        continue;
      };
      let written = (|| {
        let out_file = safe_join(&output.join(&proj.alias).join(key).join(&collection), &file)?;
        if dry_run {
          log(format!("[{key}] (dry-run) Would write {}", out_file.display()));
          return Ok(());
        }
        let mut bytes = Vec::new();
        entry.read_to_end(&mut bytes)?;
        let xml = format_entity_xml(&String::from_utf8_lossy(&bytes));
        std::fs::create_dir_all(out_file.parent().expect("has a parent"))?;
        std::fs::write(&out_file, xml)?;
        Ok::<_, CoreError>(())
      })();
      match written {
        Ok(()) => result.entities_extracted += 1,
        Err(err) => {
          log(format!("[{key}] Failed to write {name}: {err}"));
          result.errors.push(format!("{key}/{name}: {err}"));
          result.entities_skipped += 1;
        }
      }
    }
    result.zip_files_processed += 1;
    log(format!("[{key}] Done."));
  }
  Ok(result)
}

// ── Backup ──────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BackupFormat {
  /// Source-control XML folders.
  Entities,
  /// One ZIP per project.
  Zip,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupResult {
  pub projects_processed: u32,
  pub projects_backed_up: u32,
  /// Repository folder holding the backup, e.g. "/Backup_20261009-101500".
  pub backup_dir: String,
  pub errors: Vec<String>,
}

/// Backs projects up on the server itself, into
/// `SystemRepository/<parent>/<key>[_suffix]`. Nothing is downloaded.
#[allow(clippy::too_many_arguments)]
pub async fn backup(
  client: &Client,
  projects: &[DeployProject],
  parent: &str,
  suffix: Option<&str>,
  format: BackupFormat,
  dry_run: bool,
  cancel: &CancellationToken,
  log: &mut (dyn FnMut(String) + Send),
) -> Result<BackupResult> {
  if parent.trim().is_empty() {
    return Err(CoreError::Invalid("Backup folder name is required.".into()));
  }
  if parent.split(['/', '\\']).any(|s| s == "..") {
    return Err(CoreError::Invalid("Backup folder must not contain \"..\".".into()));
  }
  let parent_dir = parent.split(['/', '\\']).filter(|s| !s.is_empty()).collect::<Vec<_>>().join("/");
  let mut result = BackupResult { backup_dir: format!("/{parent_dir}"), ..Default::default() };

  for proj in projects {
    check(cancel)?;
    let key = &proj.key;
    let folder = folder_name(key, suffix);
    let remote_dir = format!("/{parent_dir}/{folder}");
    let zip_name = format!("{folder}.zip");
    let target = match format {
      BackupFormat::Zip => format!("{REPOSITORY}{remote_dir}/{zip_name}"),
      BackupFormat::Entities => format!("{REPOSITORY}{remote_dir}"),
    };
    result.projects_processed += 1;

    if dry_run {
      log(format!("[{key}] (dry-run) Would back up {} → {target}", proj.project_name));
      result.projects_backed_up += 1;
      continue;
    }
    log(format!("[{key}] Backing up {} → {target}...", proj.project_name));
    let done = match format {
      // ExportSourceControlledEntitiesToZipFile always writes to SystemRepository.
      BackupFormat::Zip => client.export_project_to_zip(&proj.project_name, &remote_dir[1..], &zip_name).await,
      BackupFormat::Entities => {
        client.export_project_to_source_control(&proj.project_name, REPOSITORY, &remote_dir).await
      }
    };
    match done {
      Ok(()) => {
        result.projects_backed_up += 1;
        log(format!("[{key}] Backed up."));
      }
      Err(err) => {
        log(format!("[{key}] Backup failed: {err}"));
        result.errors.push(format!("{key}: {err}"));
      }
    }
  }
  Ok(result)
}

// ── Upload ──────────────────────────────────────────────────────────────────

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadResult {
  pub files_uploaded: u32,
  pub zips_extracted: u32,
  /// Repository folder the files went to, e.g. "/Deploy/RC1".
  pub target_dir: String,
  pub errors: Vec<String>,
}

#[derive(Debug, Clone, Copy, Default, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct UploadOptions {
  /// Extract uploaded ZIPs on the server.
  pub extract: bool,
  /// Extract each ZIP into a folder named after it, next to the ZIP.
  pub extract_subfolder: bool,
  pub delete_zip: bool,
  pub dry_run: bool,
}

/// `"Deploy\\RC1/"` → `"/Deploy/RC1"`; empty → `"/"`.
pub fn normalize_repository_dir(dir: &str) -> String {
  format!("/{}", dir.split(['/', '\\']).filter(|s| !s.is_empty()).collect::<Vec<_>>().join("/"))
}

fn repository_dirname(path: &str) -> String {
  match path.rfind('/') {
    Some(i) if i > 0 => path[..i].to_string(),
    _ => "/".into(),
  }
}

/// Every file under `dir`, depth first and sorted, skipping dot-files and
/// dot-folders: `(relative path with '/', absolute path, size)`.
pub fn list_source_files(dir: &Path) -> Result<Vec<(String, PathBuf, u64)>> {
  let mut files = Vec::new();
  let walk = walkdir::WalkDir::new(dir)
    .sort_by_file_name()
    .into_iter()
    .filter_entry(|e| e.depth() == 0 || !e.file_name().to_string_lossy().starts_with('.'));
  for entry in walk {
    let entry = entry.map_err(|e| CoreError::Io(e.into()))?;
    if entry.file_type().is_file() {
      let rel = entry.path().strip_prefix(dir).unwrap_or(entry.path()).to_string_lossy().replace('\\', "/");
      files.push((rel, entry.path().to_path_buf(), entry.metadata().map(|m| m.len()).unwrap_or(0)));
    }
  }
  Ok(files)
}

/// Uploads every file in `source` to SystemRepository/`target`, optionally
/// extracting (and then deleting) uploaded ZIPs on the server.
pub async fn upload(
  client: &Client,
  source: &Path,
  target: &str,
  opts: UploadOptions,
  cancel: &CancellationToken,
  log: &mut (dyn FnMut(String) + Send),
) -> Result<UploadResult> {
  if target.trim().is_empty() {
    return Err(CoreError::Invalid("Target repository directory is required.".into()));
  }
  if target.split(['/', '\\']).any(|s| s == "..") {
    return Err(CoreError::Invalid("Target directory must not contain \"..\".".into()));
  }
  let dir = normalize_repository_dir(target);
  let mut result = UploadResult { target_dir: dir.clone(), ..Default::default() };

  let files = list_source_files(source)
    .map_err(|err| CoreError::NotFound(format!("Failed to read source directory \"{}\": {err}", source.display())))?;
  if files.is_empty() {
    return Err(CoreError::NotFound(format!("No files found in \"{}\".", source.display())));
  }
  log(format!("Found {} file(s) in {}", files.len(), source.display()));

  // Folders created (or confirmed) this run, so each is checked once.
  let mut ensured = std::collections::HashSet::new();
  for (rel, abs, size) in files {
    check(cancel)?;
    let remote_path = if dir == "/" { format!("/{rel}") } else { format!("{dir}/{rel}") };
    let remote_dir = repository_dirname(&remote_path);
    let should_extract = opts.extract && rel.to_lowercase().ends_with(".zip");
    let extract_dir =
      if opts.extract_subfolder { remote_path[..remote_path.len() - 4].to_string() } else { remote_dir.clone() };
    let size_kb = format!("{:.1}", size as f64 / 1024.0);

    if !ensured.contains(&remote_dir) {
      if opts.dry_run {
        log(format!("(dry-run) Would ensure folder {REPOSITORY}{remote_dir}"));
      } else if let Err(err) = client.ensure_repository_folder(REPOSITORY, &remote_dir).await {
        log(format!("[{rel}] Upload failed: {err}"));
        result.errors.push(format!("{rel}: upload failed - {err}"));
        continue;
      }
      let mut folder = remote_dir.clone();
      while folder != "/" && ensured.insert(folder.clone()) {
        folder = repository_dirname(&folder);
      }
    }

    if opts.dry_run {
      log(format!("[{rel}] (dry-run) Would upload {size_kb} KB → {REPOSITORY}{remote_path}"));
      if should_extract {
        log(format!("[{rel}] (dry-run) Would extract → {REPOSITORY}{extract_dir}"));
        if opts.delete_zip {
          log(format!("[{rel}] (dry-run) Would delete ZIP after extract"));
        }
        result.zips_extracted += 1;
      }
      result.files_uploaded += 1;
      continue;
    }

    log(format!("[{rel}] Uploading {size_kb} KB → {REPOSITORY}{remote_path}..."));
    let uploaded = match std::fs::read(&abs) {
      Ok(content) => client.save_repository_file(REPOSITORY, &remote_path, &content).await,
      Err(err) => Err(err.into()),
    };
    if let Err(err) = uploaded {
      log(format!("[{rel}] Upload failed: {err}"));
      result.errors.push(format!("{rel}: upload failed - {err}"));
      continue;
    }
    result.files_uploaded += 1;
    log(format!("[{rel}] Uploaded."));

    if !should_extract {
      continue;
    }
    log(format!("[{rel}] Extracting → {REPOSITORY}{extract_dir}..."));
    let extracted = match client.extract_repository_zip(REPOSITORY, &remote_path, &extract_dir).await {
      Ok(true) => Ok(()),
      Ok(false) => Err(CoreError::Invalid("ExtractZipArchive reported failure".into())),
      Err(err) => Err(err),
    };
    if let Err(err) = extracted {
      log(format!("[{rel}] Extract failed: {err}"));
      result.errors.push(format!("{rel}: extract failed - {err}"));
      continue;
    }
    result.zips_extracted += 1;
    log(format!("[{rel}] Extracted."));

    if opts.delete_zip {
      match client.delete_repository_file(REPOSITORY, &remote_path).await {
        Ok(()) => log(format!("[{rel}] Deleted uploaded ZIP.")),
        Err(err) => {
          log(format!("[{rel}] Could not delete ZIP: {err}"));
          result.errors.push(format!("{rel}: delete failed - {err}"));
        }
      }
    }
  }
  Ok(result)
}

#[cfg(test)]
mod tests {
  use std::io::Write;

  use super::*;

  fn project(key: &str, alias: &str) -> DeployProject {
    DeployProject { key: key.into(), alias: alias.into(), project_name: key.replace('_', "."), exports: vec![] }
  }

  #[test]
  fn repository_paths() {
    assert_eq!(normalize_repository_dir(r"Deploy\RC1/"), "/Deploy/RC1");
    assert_eq!(normalize_repository_dir(""), "/");
    assert_eq!(repository_dirname("/a/b.zip"), "/a");
    assert_eq!(repository_dirname("/b.zip"), "/");
    assert_eq!(entry_target("ITCI/Things/T.xml"), Some(("Things".into(), "T.xml".into())));
    assert_eq!(entry_target("Mashups/M.xml"), Some(("Mashups".into(), "M.xml".into())));
    assert_eq!(entry_target("readme.txt"), None);
  }

  #[test]
  fn extracts_matching_zips() {
    let dir = tempfile::tempdir().unwrap();
    let input = dir.path().join("export/20260101-000000");
    let folder = input.join("ITCI_App_rc1");
    std::fs::create_dir_all(&folder).unwrap();
    std::fs::create_dir_all(input.join("Unknown")).unwrap();
    let mut zip = zip::ZipWriter::new(std::fs::File::create(folder.join("ITCI_App_rc1.zip")).unwrap());
    let opts = zip::write::SimpleFileOptions::default();
    zip.start_file("ITCI.App/Things/T.xml", opts).unwrap();
    zip.write_all(b"<Entities><Things><Thing name=\"T\"/></Things></Entities>").unwrap();
    zip.start_file("Things/../../../evil.xml", opts).unwrap();
    zip.write_all(b"<x/>").unwrap();
    zip.start_file("other.txt", opts).unwrap();
    zip.finish().unwrap();

    let out = dir.path().join("out");
    let mut lines = Vec::new();
    let result =
      extract(&[project("ITCI_App", "App")], &input, &out, false, &CancellationToken::new(), &mut |l| lines.push(l))
        .unwrap();
    // The entry that climbs out of the output folder is refused, not written.
    assert_eq!((result.zip_files_processed, result.entities_extracted, result.errors.len()), (1, 1, 1));
    let xml = std::fs::read_to_string(out.join("App/ITCI_App/Things/T.xml")).unwrap();
    assert!(xml.starts_with("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<Entities>"));
    assert!(lines.iter().any(|l| l.contains("[Unknown] No matching project")));
    assert!(!dir.path().join("evil.xml").exists());
  }

  #[test]
  fn lists_source_files_without_dot_files() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(dir.path().join(".git")).unwrap();
    std::fs::create_dir_all(dir.path().join("b")).unwrap();
    std::fs::write(dir.path().join(".git/x"), "").unwrap();
    std::fs::write(dir.path().join("b/c.zip"), "zz").unwrap();
    std::fs::write(dir.path().join("a.txt"), "a").unwrap();
    let files: Vec<_> = list_source_files(dir.path()).unwrap().into_iter().map(|f| (f.0, f.2)).collect();
    assert_eq!(files, [("a.txt".to_string(), 1), ("b/c.zip".to_string(), 2)]);
  }

  /// Parity with singl-web: extracts every `<key>/<key>.zip` under
  /// `SINGL_PARITY_EXPORT` into `SINGL_PARITY_OUT`, one project per folder,
  /// for diffing against `runDeploymentExtract`'s output.
  #[test]
  #[ignore]
  fn extract_parity() {
    let input = PathBuf::from(std::env::var("SINGL_PARITY_EXPORT").expect("SINGL_PARITY_EXPORT"));
    let out = PathBuf::from(std::env::var("SINGL_PARITY_OUT").expect("SINGL_PARITY_OUT"));
    let projects: Vec<_> = std::fs::read_dir(&input)
      .unwrap()
      .flatten()
      .map(|e| project(&e.file_name().to_string_lossy(), "Alias"))
      .collect();
    let result = extract(&projects, &input, &out, false, &CancellationToken::new(), &mut |_| {}).unwrap();
    assert!(result.errors.is_empty(), "{:?}", result.errors);
  }
}
