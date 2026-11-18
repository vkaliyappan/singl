//! Imports entity XML into a ThingWorx server: a diff-before-import preview
//! against the server's current export, and an import that first saves the
//! server's current versions into a timestamped backup folder.
//!
//! Backups live at `<workspace>/twx-backups/<env>/<YYYYMMDD-HHMMSS>/<Collection>/<Name>.xml`
//! as the server exported them (not normalised), so restoring is the same
//! import run over those files.

use std::path::Path;
use std::sync::LazyLock;

use regex::Regex;
use serde::Serialize;

use super::api::{Client, collection_name};
use super::stamp;
use super::xmlformat::format_entity_xml;
use crate::repo::files::{list_paths, safe_join};
use crate::{CoreError, Result};

/// Folder under the workspace holding the backups.
pub const BACKUP_FOLDER: &str = "twx-backups";

/// One file to import: a label for messages (its path) and its XML.
pub struct Source {
  pub path: String,
  pub xml: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EntityId {
  pub entity_type: String,
  pub name: String,
}

static ROOT: LazyLock<Regex> =
  LazyLock::new(|| Regex::new(r"(?s)<Entities\b[^>]*>\s*<(\w+)\b[^>]*>\s*<(\w+)\b([^>]*)>").unwrap());
static NAME_ATTR: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"\bname="([^"]*)""#).unwrap());

fn unescape(s: &str) -> String {
  [("&lt;", "<"), ("&gt;", ">"), ("&quot;", "\""), ("&apos;", "'"), ("&amp;", "&")]
    .iter()
    .fold(s.to_string(), |t, (from, to)| t.replace(from, to))
}

/// Type and name of the first entity in an `<Entities>` export.
pub fn parse_entity(xml: &str) -> Result<EntityId> {
  let bad = || CoreError::Invalid("Not an entity export: expected <Entities><Things><Thing name=\"…\">".into());
  let caps = ROOT.captures(xml).ok_or_else(bad)?;
  let name = NAME_ATTR.captures(&caps[3]).map(|c| unescape(&c[1])).filter(|n| !n.is_empty()).ok_or_else(bad)?;
  Ok(EntityId { entity_type: caps[2].to_string(), name })
}

/// The multipart/form-data body ThingWorx's Importer takes, and its Content-Type.
pub fn multipart(file_name: &str, xml: &str) -> (String, Vec<u8>) {
  let boundary = format!("----singl{}", stamp::compact_now().replace('-', ""));
  let safe = file_name.replace(['"', '\r', '\n'], "_");
  let mut body = format!(
    "--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{safe}\"\r\nContent-Type: text/xml\r\n\r\n"
  )
  .into_bytes();
  body.extend_from_slice(xml.as_bytes());
  body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
  (format!("multipart/form-data; boundary={boundary}"), body)
}

/// A file name that is safe on Windows, for backups.
fn safe_file_name(name: &str) -> String {
  let cleaned: String =
    name.chars().map(|c| if "<>:\"/\\|?*".contains(c) || (c as u32) < 0x20 { '_' } else { c }).collect();
  cleaned.trim_end_matches(['.', ' ']).to_string()
}

fn is_not_found(err: &CoreError) -> bool {
  matches!(err, CoreError::Twx { status: 404, .. })
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewItem {
  pub path: String,
  #[serde(rename = "type")]
  pub entity_type: String,
  pub name: String,
  pub exists_on_server: bool,
  /// The server's current export, normalised; empty when it does not exist.
  pub original: String,
  /// The local file, normalised.
  pub modified: String,
  pub changed: bool,
  /// Why this file could not be compared.
  pub error: Option<String>,
}

/// Compares each file with what the server has now. A file that cannot be
/// read or compared comes back with `error` set.
pub async fn preview(client: &Client, files: &[Source]) -> Vec<PreviewItem> {
  let mut items = Vec::with_capacity(files.len());
  for file in files {
    let mut item = PreviewItem {
      path: file.path.clone(),
      entity_type: String::new(),
      name: String::new(),
      exists_on_server: false,
      original: String::new(),
      modified: format_entity_xml(&file.xml),
      changed: true,
      error: None,
    };
    match parse_entity(&file.xml) {
      Err(e) => item.error = Some(e.to_string()),
      Ok(id) => {
        item.entity_type = id.entity_type;
        item.name = id.name;
        match client.export_entity(&item.entity_type, &item.name).await {
          Ok(xml) => {
            item.exists_on_server = true;
            item.original = format_entity_xml(&xml);
            item.changed = item.original != item.modified;
          }
          Err(e) if is_not_found(&e) => {}
          Err(e) => item.error = Some(e.to_string()),
        }
      }
    }
    items.push(item);
  }
  items
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileResult {
  pub path: String,
  pub ok: bool,
  pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
  /// The backup folder, relative to the workspace and `/`-separated.
  pub backup_dir: String,
  /// How many server versions were saved into it.
  pub backed_up: usize,
  pub results: Vec<FileResult>,
}

/// Saves each file's entity as the server has it now into `backup_dir`.
/// Entities not on the server have nothing to save. Any other failure stops
/// before the first import, so nothing changes without its backup.
async fn backup(client: &Client, files: &[Source], backup_dir: &Path) -> Result<usize> {
  let mut saved = 0;
  for file in files {
    let id = parse_entity(&file.xml).map_err(|e| CoreError::Invalid(format!("{}: {e}", file.path)))?;
    match client.export_entity(&id.entity_type, &id.name).await {
      Ok(xml) => {
        let dir = backup_dir.join(collection_name(&id.entity_type));
        std::fs::create_dir_all(&dir)?;
        std::fs::write(dir.join(format!("{}.xml", safe_file_name(&id.name))), xml)?;
        saved += 1;
      }
      Err(e) if is_not_found(&e) => {}
      Err(e) => return Err(CoreError::Invalid(format!("Backup of {} failed, nothing was imported — {e}", id.name))),
    }
  }
  Ok(saved)
}

/// Backs the current server versions up under
/// `<workspace_root>/twx-backups/<env>/<timestamp>`, then imports each file.
pub async fn import(
  client: &Client,
  env: &str,
  files: &[Source],
  workspace_root: &Path,
  log: &mut (dyn FnMut(String) + Send),
) -> Result<ImportResult> {
  let rel = format!("{BACKUP_FOLDER}/{}/{}", safe_file_name(env), stamp::compact_now());
  let dir = safe_join(workspace_root, &rel)?;
  log(format!("Backing up current server versions to {rel}"));
  let backed_up = backup(client, files, &dir).await?;
  log(format!("Backed up {backed_up} of {} entities", files.len()));

  let mut results = Vec::with_capacity(files.len());
  for (i, file) in files.iter().enumerate() {
    log(format!("Importing {} ({}/{})", file.path, i + 1, files.len()));
    let file_name = file.path.rsplit('/').next().unwrap_or(&file.path);
    let (content_type, body) = multipart(file_name, &file.xml);
    let sent = client
      .post_raw(
        "/Importer?purpose=import&usedefaultdataprovider=false&WithSubsystems=false",
        &content_type,
        body,
        &format!("Import {file_name}"),
      )
      .await;
    results.push(match sent {
      Ok(_) => FileResult { path: file.path.clone(), ok: true, error: None },
      Err(e) => FileResult { path: file.path.clone(), ok: false, error: Some(e.to_string()) },
    });
  }
  Ok(ImportResult { backup_dir: rel, backed_up, results })
}

/// Reads `rels` (`/`-separated, under `base`) as import sources. Only `.xml` files.
pub fn read_sources(base: &Path, rels: &[String]) -> Result<Vec<Source>> {
  if rels.is_empty() {
    return Err(CoreError::Invalid("Choose at least one entity file.".into()));
  }
  rels
    .iter()
    .map(|rel| {
      if !rel.to_lowercase().ends_with(".xml") {
        return Err(CoreError::Invalid(format!("{rel} is not an XML file.")));
      }
      let path = safe_join(base, rel)?;
      let bytes = std::fs::read(&path).map_err(|_| CoreError::NotFound(format!("{rel} does not exist")))?;
      Ok(Source { path: rel.clone(), xml: String::from_utf8_lossy(&bytes).into_owned() })
    })
    .collect()
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupInfo {
  /// Relative to the workspace.
  pub dir: String,
  pub name: String,
  pub files: usize,
}

/// Backup folders for `env`, newest first.
pub fn list_backups(workspace_root: &Path, env: &str) -> Result<Vec<BackupInfo>> {
  let env_rel = format!("{BACKUP_FOLDER}/{}", safe_file_name(env));
  let env_dir = safe_join(workspace_root, &env_rel)?;
  let Ok(read) = std::fs::read_dir(&env_dir) else { return Ok(Vec::new()) };
  let mut out: Vec<BackupInfo> = read
    .flatten()
    .filter(|e| e.path().is_dir())
    .map(|e| {
      let name = e.file_name().to_string_lossy().into_owned();
      let files = list_paths(&e.path()).map(|p| p.iter().filter(|f| f.ends_with(".xml")).count()).unwrap_or(0);
      BackupInfo { dir: format!("{env_rel}/{name}"), name, files }
    })
    .collect();
  out.sort_by(|a, b| b.name.cmp(&a.name));
  Ok(out)
}

/// The XML files of a backup folder (relative to the workspace) as sources.
pub fn backup_sources(workspace_root: &Path, env: &str, dir: &str) -> Result<Vec<Source>> {
  let prefix = format!("{BACKUP_FOLDER}/{}/", safe_file_name(env));
  let dir = dir.replace('\\', "/");
  if !dir.starts_with(&prefix) {
    return Err(CoreError::Invalid("Not a backup folder of this environment.".into()));
  }
  let root = safe_join(workspace_root, &dir)?;
  let rels: Vec<String> = list_paths(&root)?.into_iter().filter(|f| f.ends_with(".xml")).collect();
  if rels.is_empty() {
    return Err(CoreError::NotFound("That backup has no entity files.".into()));
  }
  read_sources(&root, &rels)
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn parses_type_and_name() {
    let xml = "<?xml version=\"1.0\"?>\n<Entities build=\"1\">\n  <Things>\n    <Thing name=\"A&amp;B\" description=\"x\">\n";
    assert_eq!(parse_entity(xml).unwrap(), EntityId { entity_type: "Thing".into(), name: "A&B".into() });
    assert!(parse_entity("<foo/>").is_err());
  }

  #[test]
  fn builds_multipart() {
    let (ct, body) = multipart("My\"Thing.xml", "<Entities/>");
    let boundary = ct.strip_prefix("multipart/form-data; boundary=").unwrap();
    let text = String::from_utf8(body).unwrap();
    assert!(text.starts_with(&format!("--{boundary}\r\n")));
    assert!(text.contains("name=\"file\"; filename=\"My_Thing.xml\""));
    assert!(text.contains("\r\n\r\n<Entities/>\r\n"));
    assert!(text.ends_with(&format!("--{boundary}--\r\n")));
  }

  #[test]
  fn safe_names() {
    assert_eq!(safe_file_name("a/b:c."), "a_b_c");
  }
}
