//! The TWX Entities page: exported entity files under `twx-entities`,
//! one folder per environment. Ported from singl-web's `/api/twx-entities/*`
//! routes, `lib/twx/entity-refs.ts` and `lib/twx-entities/find.ts`.
//!
//! Layout under the entities base:
//!   <env>/WindchillClients/Thingworx/<alias>/<project>/<Collection>/<Name>.xml
//!   <env>/WindchillClients/Thingworx/<alias>/Code/<Collection>/<Name>/<Service>.js
//!   <env>/WindchillClients/Thingworx/<alias>/Code/<Collection>/<Name>.ts   (DataShapes)
//!
//! Paths handed in and out are relative to the base and `/`-separated.

use std::collections::VecDeque;
use std::path::{Component, Path};

use serde::Serialize;
use tokio_util::sync::CancellationToken;

use super::api::{Client, TwxEntity};
use super::export::filter_entities;
use super::xmlformat::format_entity_xml;
use crate::repo::files::{list_paths, remove_dir_all, safe_join};
use crate::{CoreError, Result};

/// Large mashup exports exceed 1 MB.
const MAX_READ_SIZE: u64 = 5 * 1024 * 1024;

fn not_found() -> CoreError {
  CoreError::NotFound("File does not exist".into())
}

/// Every file under `rel` (the base when empty), relative to it; folders
/// with nothing in them end in `/`. Empty when `rel` does not exist.
pub fn list(base: &Path, rel: &str) -> Result<Vec<String>> {
  let dir = safe_join(base, rel)?;
  if !dir.is_dir() {
    return Ok(Vec::new());
  }
  list_paths(&dir)
}

/// A file's text, up to 5 MB.
pub fn read(base: &Path, rel: &str) -> Result<String> {
  let path = safe_join(base, rel)?;
  let meta = std::fs::metadata(&path).map_err(|_| not_found())?;
  if meta.is_dir() {
    return Err(CoreError::Invalid("Path is a directory".into()));
  }
  if meta.len() > MAX_READ_SIZE {
    return Err(CoreError::Invalid("File too large to display (> 5 MB)".into()));
  }
  Ok(String::from_utf8_lossy(&std::fs::read(path)?).into_owned())
}

/// Saves an edited file. Only existing files: new ones go through [`create`].
pub fn write(base: &Path, rel: &str, content: &str) -> Result<()> {
  let path = inside(base, rel)?;
  if !path.is_file() {
    return Err(not_found());
  }
  Ok(std::fs::write(path, content)?)
}

/// `rel` under `base`, refusing the base itself.
fn inside(base: &Path, rel: &str) -> Result<std::path::PathBuf> {
  let path = safe_join(base, rel)?;
  if path == base {
    return Err(CoreError::Invalid("Invalid path".into()));
  }
  Ok(path)
}

/// True for the environment folders at the top, which hold whole exports.
fn is_export_root(rel: &str) -> bool {
  Path::new(&rel.replace('\\', "/")).components().filter(|c| matches!(c, Component::Normal(_))).count() == 1
}

/// Rejects names that would escape their folder or that Windows cannot hold.
fn validate_name(name: &str) -> Result<()> {
  let invalid = |msg: &str| Err(CoreError::Invalid(msg.into()));
  if name.trim().is_empty() {
    return invalid("Name is required");
  }
  if name != name.trim() {
    return invalid("Name cannot start or end with spaces");
  }
  if name == "." || name == ".." || name.chars().any(|c| "<>:\"/\\|?*".contains(c) || (c as u32) < 0x20) {
    return invalid("Name contains invalid characters");
  }
  if name.ends_with('.') {
    return invalid("Name cannot end with a dot");
  }
  Ok(())
}

fn join_rel(dir: &str, name: &str) -> String {
  if dir.is_empty() { name.to_string() } else { format!("{dir}/{name}") }
}

fn parent_of(rel: &str) -> &str {
  rel.rfind('/').map_or("", |i| &rel[..i])
}

/// Creates an empty file, or a folder, inside `parent`. Returns its path.
pub fn create(base: &Path, parent: &str, name: &str, dir: bool) -> Result<String> {
  validate_name(name)?;
  let rel = join_rel(parent, name);
  let parent_path = inside(base, parent)?;
  let target = inside(base, &rel)?;
  if !parent_path.is_dir() {
    return Err(CoreError::NotFound("Parent folder does not exist".into()));
  }
  if target.exists() {
    return Err(CoreError::Invalid(format!("\"{name}\" already exists")));
  }
  if dir {
    std::fs::create_dir(target)?;
  } else {
    std::fs::OpenOptions::new().write(true).create_new(true).open(target)?;
  }
  Ok(rel)
}

/// Renames a file or folder in place. Returns its new path.
pub fn rename(base: &Path, rel: &str, name: &str) -> Result<String> {
  validate_name(name)?;
  let new_rel = join_rel(parent_of(rel), name);
  let source = inside(base, rel)?;
  let target = inside(base, &new_rel)?;
  // The top folder is the environment's export root; renaming it would orphan it.
  if is_export_root(rel) {
    return Err(CoreError::Invalid("Cannot rename the export root".into()));
  }
  if !source.exists() {
    return Err(not_found());
  }
  if new_rel == rel {
    return Ok(new_rel);
  }
  // A case-only rename points at the same file on Windows/macOS.
  let same_entry = source.to_string_lossy().to_lowercase() == target.to_string_lossy().to_lowercase();
  if !same_entry && target.exists() {
    return Err(CoreError::Invalid(format!("\"{name}\" already exists")));
  }
  std::fs::rename(source, target)?;
  Ok(new_rel)
}

/// Deletes a file, or a folder with everything in it.
pub fn delete(base: &Path, rel: &str) -> Result<()> {
  let target = inside(base, rel)?;
  if is_export_root(rel) {
    return Err(CoreError::Invalid("Cannot delete the export root".into()));
  }
  let meta = std::fs::symlink_metadata(&target).map_err(|_| not_found())?;
  if meta.is_dir() { remove_dir_all(&target) } else { Ok(std::fs::remove_file(target)?) }
}

// ── Locating an entity ───────────────────────────────────────────────────────

/// Paths relative to the base, each present only when it exists: `path` the
/// XML, `code_dir` the entity's script folder, `code` the script for the
/// service — or, with no service, the entity's own generated file.
#[derive(Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocatedEntity {
  #[serde(skip_serializing_if = "Option::is_none")]
  pub path: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub code_dir: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub code: Option<String>,
}

/// Extensions an extracted script may carry, in order of preference.
const CODE_EXTENSIONS: &[&str] = &[".js", ".ts"];

/// A name that could step outside its folder.
pub fn is_unsafe_name(part: &str) -> bool {
  part.contains(['/', '\\']) || part == "." || part == ".."
}

fn subdirs(dir: &Path) -> Vec<String> {
  let Ok(entries) = std::fs::read_dir(dir) else { return Vec::new() };
  let mut names: Vec<String> = entries
    .flatten()
    .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
    .map(|e| e.file_name().to_string_lossy().into_owned())
    .collect();
  names.sort();
  names
}

fn find_code(dir: &Path, stem: &str) -> Option<String> {
  CODE_EXTENSIONS.iter().map(|ext| format!("{stem}{ext}")).find(|file| dir.join(file).is_file())
}

/// Finds an exported entity's XML file and the scripts extracted from it.
/// `env_dir` is the environment's folder name; `collection` the REST
/// collection, every one tried when absent.
pub fn locate(
  base: &Path,
  env_dir: &str,
  entity: &str,
  collection: Option<&str>,
  service: Option<&str>,
) -> Result<Option<LocatedEntity>> {
  if env_dir.is_empty() || entity.is_empty() {
    return Ok(None);
  }
  if [Some(env_dir), Some(entity), collection, service].into_iter().flatten().any(is_unsafe_name) {
    return Err(CoreError::Invalid("Invalid entity reference".into()));
  }

  let root = base.join(env_dir).join("WindchillClients").join("Thingworx");
  let rel = |alias: &str, parts: &[&str]| {
    [env_dir, "WindchillClients", "Thingworx", alias].iter().chain(parts).copied().collect::<Vec<_>>().join("/")
  };
  let file_name = format!("{entity}.xml");
  let aliases = subdirs(&root);

  for alias in &aliases {
    for project in subdirs(&root.join(alias)) {
      if project == "Code" {
        continue;
      }
      let project_dir = root.join(alias).join(&project);
      let collections = collection.map_or_else(|| subdirs(&project_dir), |c| vec![c.to_string()]);
      for collection in collections {
        if !project_dir.join(&collection).join(&file_name).is_file() {
          continue;
        }
        let code_dir = root.join(alias).join("Code").join(&collection).join(entity);
        let has_code = code_dir.is_dir();
        let code = match service {
          Some(service) if has_code => {
            find_code(&code_dir, service).map(|f| rel(alias, &["Code", &collection, entity, &f]))
          }
          Some(_) => None,
          None => find_code(&root.join(alias).join("Code").join(&collection), entity)
            .map(|f| rel(alias, &["Code", &collection, &f])),
        };
        return Ok(Some(LocatedEntity {
          path: Some(rel(alias, &[&project, &collection, &file_name])),
          code_dir: has_code.then(|| rel(alias, &["Code", &collection, entity])),
          code,
        }));
      }
    }
  }

  // No XML — the generated file may still be there.
  if let (Some(collection), None) = (collection, service) {
    for alias in &aliases {
      if let Some(f) = find_code(&root.join(alias).join("Code").join(collection), entity) {
        return Ok(Some(LocatedEntity { code: Some(rel(alias, &["Code", collection, &f])), ..Default::default() }));
      }
    }
  }
  Ok(None)
}

// ── Finding files by name ────────────────────────────────────────────────────

/// A file or folder under the exports, as `@` mentions list it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct FoundEntry {
  pub path: String,
  pub name: String,
  #[serde(rename = "type")]
  pub kind: &'static str,
}

/// Enough for any export; past this the tree is not something to mention into.
const MAX_FIND_ENTRIES: usize = 50_000;

fn walk(base: &Path, root: &str) -> Vec<FoundEntry> {
  let mut out = Vec::new();
  let mut queue = VecDeque::from([(base.join(root), root.to_string())]);
  while let Some((dir, rel_dir)) = queue.pop_front() {
    if out.len() >= MAX_FIND_ENTRIES {
      break;
    }
    let Ok(entries) = std::fs::read_dir(&dir) else { continue };
    let mut entries: Vec<_> = entries.flatten().collect();
    entries.sort_by_key(|e| e.file_name());
    for entry in entries {
      let name = entry.file_name().to_string_lossy().into_owned();
      let rel = format!("{rel_dir}/{name}");
      let Ok(kind) = entry.file_type() else { continue };
      if kind.is_dir() {
        if name == "node_modules" || name == ".git" {
          continue;
        }
        queue.push_back((entry.path(), rel.clone()));
        out.push(FoundEntry { path: rel, name, kind: "dir" });
      } else if kind.is_file() {
        out.push(FoundEntry { path: rel, name, kind: "file" });
      }
    }
  }
  out
}

/// Lower is better; `None` when the entry does not match at all.
fn match_rank(name: &str, rel: &str, q: &str) -> Option<u8> {
  if q.is_empty() {
    return Some(0);
  }
  // A query with a slash is about where the entry is, not just its name.
  if q.contains('/') {
    return rel.contains(q).then_some(if rel.ends_with(q) { 1 } else { 3 });
  }
  if name == q {
    Some(0)
  } else if name.starts_with(q) {
    Some(1)
  } else if name.contains(q) {
    Some(2)
  } else if rel.contains(q) {
    Some(3)
  } else {
    is_subsequence(q, name).then_some(4)
  }
}

fn is_subsequence(q: &str, text: &str) -> bool {
  let mut want = q.chars().peekable();
  for ch in text.chars() {
    if want.peek() == Some(&ch) {
      want.next();
    }
  }
  want.peek().is_none()
}

/// The best `limit` matches for `query` among one environment folder's files
/// and folders. Without a query, the shallowest entries come first, so `@`
/// alone shows the top of the tree.
pub fn find(base: &Path, root: &str, query: &str, limit: usize) -> Result<Vec<FoundEntry>> {
  // The root is one environment folder, nothing deeper or outside.
  if root.is_empty() || is_unsafe_name(root) {
    return Err(CoreError::Invalid("root must be an environment folder".into()));
  }
  if !base.join(root).is_dir() {
    return Ok(Vec::new());
  }
  let q = query.trim().to_lowercase();
  let mut scored: Vec<_> = walk(base, root)
    .into_iter()
    .filter_map(|entry| {
      let rel = entry.path[root.len() + 1..].to_lowercase();
      let rank = match_rank(&entry.name.to_lowercase(), &rel, &q)?;
      let depth = rel.split('/').count();
      Some((rank, depth, entry))
    })
    .collect();
  scored.sort_by(|a, b| {
    (a.0, a.1, a.2.name.chars().count(), &a.2.path).cmp(&(b.0, b.1, b.2.name.chars().count(), &b.2.path))
  });
  Ok(scored.into_iter().take(limit).map(|(_, _, e)| e).collect())
}

// ── Export ───────────────────────────────────────────────────────────────────

/// One ThingWorx project to export into the explorer.
#[derive(Debug, Clone)]
pub struct ExportJob {
  pub twx_name: String,
  pub folder_name: String,
  pub alias: String,
  pub exports: Vec<String>,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EntityExportResult {
  pub exported: u32,
  pub skipped: u32,
  pub errors: Vec<String>,
  /// The environment folder, relative to the base.
  pub output_dir: String,
  /// Set by the caller once the run time is recorded.
  pub exported_at: Option<String>,
}

/// A name made safe for a folder name; spaces and dots stay.
fn safe_folder(name: &str) -> String {
  name.chars().map(|c| if c.is_ascii_alphanumeric() || "_-. ".contains(c) { c } else { '_' }).collect()
}

/// Exports each job's entities as formatted XML into
/// `<base>/<env_dir>/WindchillClients/Thingworx/<alias>/<folder>/<Collection>/<Name>.xml`.
/// `jobs` of `None` exports every project on the server.
pub async fn export(
  client: &Client,
  base: &Path,
  env_dir: &str,
  jobs: Option<Vec<ExportJob>>,
  cancel: &CancellationToken,
  log: &mut (dyn FnMut(String) + Send),
) -> Result<EntityExportResult> {
  let output = base.join(env_dir);
  let jobs = match jobs {
    Some(jobs) => jobs,
    None => {
      log("No project specified — fetching all projects from ThingWorx...".into());
      let names = client.all_projects().await?;
      log(format!("Found {} project(s): {}", names.len(), names.join(", ")));
      names
        .into_iter()
        .map(|n| ExportJob { folder_name: n.clone(), alias: n.clone(), twx_name: n, exports: vec!["all".into()] })
        .collect()
    }
  };

  let mut result = EntityExportResult { output_dir: env_dir.to_string(), ..Default::default() };
  for job in jobs {
    let alias = safe_folder(&job.alias);
    let folder = safe_folder(&job.folder_name);
    if [&alias, &folder].iter().any(|s| s.trim().is_empty() || is_unsafe_name(s)) {
      log(format!("[WARN] Skipping \"{}\": invalid path", job.twx_name));
      continue;
    }
    if cancel.is_cancelled() {
      return Err(CoreError::Cancelled);
    }
    log(format!("Fetching entities for \"{}\"...", job.twx_name));
    let entities = match client.project_entities(&job.twx_name).await {
      Ok(entities) => entities,
      Err(err) => {
        log(format!("[WARN] Could not fetch entities for \"{}\": {err}", job.twx_name));
        result.errors.push(format!("{}: {err}", job.twx_name));
        continue;
      }
    };
    let total = entities.len();
    let filtered = filter_entities(entities, &job.exports);
    log(format!(
      "[{}] {total} entities found, exporting {} (filter: {})",
      job.twx_name,
      filtered.len(),
      job.exports.join(", ")
    ));

    for TwxEntity { name, entity_type } in filtered {
      if cancel.is_cancelled() {
        return Err(CoreError::Cancelled);
      }
      log(format!("[{}] Exporting {entity_type}/{name}...", job.twx_name));
      let file = super::export::entity_path(&output, &alias, &folder, &entity_type, &name);
      let written = async {
        let xml = format_entity_xml(&client.export_entity(&entity_type, &name).await?);
        std::fs::create_dir_all(file.parent().expect("has a parent"))?;
        std::fs::write(&file, xml)?;
        Ok::<_, CoreError>(())
      }
      .await;
      match written {
        Ok(()) => result.exported += 1,
        Err(err) => {
          log(format!("[WARN] Failed {}/{entity_type}/{name}: {err}", job.twx_name));
          result.skipped += 1;
          result.errors.push(format!("{}/{entity_type}/{name}: {err}", job.twx_name));
        }
      }
    }
  }
  Ok(result)
}

#[cfg(test)]
mod tests {
  use super::*;

  fn touch(path: &Path) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, "x").unwrap();
  }

  #[test]
  fn file_crud() {
    let dir = tempfile::tempdir().unwrap();
    let base = dir.path();
    std::fs::create_dir_all(base.join("dev/a")).unwrap();

    assert!(list(base, "missing").unwrap().is_empty());
    assert_eq!(create(base, "dev/a", "f.js", false).unwrap(), "dev/a/f.js");
    assert!(create(base, "dev/a", "f.js", false).is_err());
    assert!(create(base, "dev/a", "bad:name", false).is_err());
    assert!(create(base, "dev/a", "trail.", false).is_err());
    assert!(create(base, "", "top", true).is_err());
    assert_eq!(create(base, "dev", "empty", true).unwrap(), "dev/empty");
    assert_eq!(list(base, "dev").unwrap(), ["a/f.js", "empty/"]);

    write(base, "dev/a/f.js", "hello").unwrap();
    assert_eq!(read(base, "dev/a/f.js").unwrap(), "hello");
    assert!(write(base, "dev/a/new.js", "x").is_err());
    assert!(read(base, "../x").is_err());

    assert_eq!(rename(base, "dev/a/f.js", "F.js").unwrap(), "dev/a/F.js");
    assert_eq!(read(base, "dev/a/F.js").unwrap(), "hello");
    assert!(rename(base, "dev", "prod").is_err());
    assert!(delete(base, "dev").is_err());
    delete(base, "dev/a").unwrap();
    assert!(!base.join("dev/a").exists());
  }

  #[test]
  fn locates_xml_and_code() {
    let dir = tempfile::tempdir().unwrap();
    let base = dir.path();
    let tw = base.join("dev/WindchillClients/Thingworx/App");
    touch(&tw.join("P.X/Things/T1.xml"));
    touch(&tw.join("Code/Things/T1/Run.js"));
    touch(&tw.join("Code/DataShapes/DS.ts"));

    let found = locate(base, "dev", "T1", None, Some("Run")).unwrap().unwrap();
    assert_eq!(found.path.as_deref(), Some("dev/WindchillClients/Thingworx/App/P.X/Things/T1.xml"));
    assert_eq!(found.code_dir.as_deref(), Some("dev/WindchillClients/Thingworx/App/Code/Things/T1"));
    assert_eq!(found.code.as_deref(), Some("dev/WindchillClients/Thingworx/App/Code/Things/T1/Run.js"));

    let ds = locate(base, "dev", "DS", Some("DataShapes"), None).unwrap().unwrap();
    assert_eq!(ds.code.as_deref(), Some("dev/WindchillClients/Thingworx/App/Code/DataShapes/DS.ts"));
    assert!(locate(base, "dev", "Nope", None, None).unwrap().is_none());
    assert!(locate(base, "dev", "../x", None, None).is_err());
  }

  #[test]
  fn finds_best_first() {
    let dir = tempfile::tempdir().unwrap();
    let base = dir.path();
    touch(&base.join("dev/Things/MyThing.xml"));
    touch(&base.join("dev/Things/Other.xml"));
    touch(&base.join("dev/node_modules/MyThing.js"));

    let names = |q: &str| find(base, "dev", q, 10).unwrap().into_iter().map(|e| e.name).collect::<Vec<_>>();
    assert_eq!(names("mything"), ["MyThing.xml"]);
    assert_eq!(names("mtx"), ["MyThing.xml"]);
    assert_eq!(names("")[0], "Things");
    assert_eq!(names("things/o"), ["Other.xml"]);
    assert!(find(base, "dev/Things", "", 10).is_err());
  }
}
