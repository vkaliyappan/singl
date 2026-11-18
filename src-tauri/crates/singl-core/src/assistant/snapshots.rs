//! Undo for the assistant's local entity file changes.
//!
//! Before an entity tool changes a file under the entities folder, it saves a
//! snapshot of what the change overwrites, keyed by the tool call
//! (`entity_snapshots`). [`undo`] puts the files back. It refuses when a file
//! no longer holds what the tool left there, so a later hand edit is never
//! overwritten. The undo is saved as a snapshot of its own, so it can be undone.
//!
//! A snapshot is a list of [`Step`]s, one per path a call touched. Deleting a
//! folder gives one step per file and folder inside it, folders last.

use std::collections::{HashMap, HashSet};
use std::path::{Component, Path, PathBuf};

use serde::Serialize;
use sha2::{Digest, Sha256};
use sqlx::SqlitePool;

use super::Assistant;
use super::tools::CallMeta;
use crate::db::now;
use crate::workspace::PathKind;
use crate::{CoreError, Result};

/// Tool calls kept; the newest win.
const MAX_CALLS: i64 = 500;
const MAX_AGE_SECS: i64 = 30 * 24 * 60 * 60;

/// What a path holds.
#[derive(Debug, Clone)]
pub enum Node {
  Missing,
  Dir,
  /// `bytes` is kept only where undo must write the content back.
  File {
    hash: String,
    bytes: Option<Vec<u8>>,
  },
}

impl Node {
  /// Same kind and, for files, same content hash.
  fn matches(&self, other: &Node) -> bool {
    match (self, other) {
      (Node::Missing, Node::Missing) | (Node::Dir, Node::Dir) => true,
      (Node::File { hash: a, .. }, Node::File { hash: b, .. }) => a == b,
      _ => false,
    }
  }

  fn without_bytes(&self) -> Node {
    match self {
      Node::File { hash, .. } => Node::File { hash: hash.clone(), bytes: None },
      other => other.clone(),
    }
  }
}

/// One change to one path. `before` is what `path` held before the change;
/// `after` is what the change left at `new_path` (a rename) or at `path`.
#[derive(Debug, Clone)]
pub struct Step {
  pub path: String,
  pub new_path: Option<String>,
  pub before: Node,
  pub after: Node,
}

impl Step {
  /// Where the change left the item.
  fn at(&self) -> &str {
    self.new_path.as_deref().unwrap_or(&self.path)
  }
}

fn invalid(msg: impl Into<String>) -> CoreError {
  CoreError::Invalid(msg.into())
}

/// `rel` with `/` separators and no `.` parts. `..` and roots are refused.
fn norm(rel: &str) -> Result<String> {
  let mut parts = Vec::new();
  for part in Path::new(&rel.replace('\\', "/")).components() {
    match part {
      Component::Normal(name) => parts.push(name.to_string_lossy().into_owned()),
      Component::CurDir => {}
      _ => return Err(invalid("Invalid path")),
    }
  }
  Ok(parts.join("/"))
}

/// The file or folder `rel` under `base`. The base itself is refused.
fn resolve(base: &Path, rel: &str) -> Result<PathBuf> {
  let rel = norm(rel)?;
  if rel.is_empty() {
    return Err(invalid("Invalid path"));
  }
  crate::repo::files::safe_join(base, &rel)
}

fn parent_of(rel: &str) -> &str {
  rel.rfind('/').map_or("", |i| &rel[..i])
}

fn hash(bytes: &[u8]) -> String {
  hex::encode(Sha256::digest(bytes))
}

fn file_node(bytes: &[u8]) -> Node {
  Node::File { hash: hash(bytes), bytes: None }
}

/// What `rel` holds now.
pub fn capture(base: &Path, rel: &str) -> Result<Node> {
  let path = resolve(base, rel)?;
  match std::fs::symlink_metadata(&path) {
    Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Node::Missing),
    Err(e) => Err(e.into()),
    Ok(meta) if meta.is_dir() => Ok(Node::Dir),
    Ok(_) => {
      let bytes = std::fs::read(&path)?;
      Ok(Node::File { hash: hash(&bytes), bytes: Some(bytes) })
    }
  }
}

/// The step for overwriting the existing file `rel` with `new`. Call before writing.
pub fn write_step(base: &Path, rel: &str, new: &[u8]) -> Result<Step> {
  Ok(Step { path: norm(rel)?, new_path: None, before: capture(base, rel)?, after: file_node(new) })
}

/// The step for creating the empty file or folder `rel`.
pub fn create_step(rel: &str, dir: bool) -> Result<Step> {
  let after = if dir { Node::Dir } else { file_node(&[]) };
  Ok(Step { path: norm(rel)?, new_path: None, before: Node::Missing, after })
}

/// The step for moving `from` to `to`, where `before` is [`capture`]d from `from`
/// before the move. None when the name did not change.
pub fn move_step(from: &str, to: &str, before: Node) -> Result<Option<Step>> {
  let (from, to) = (norm(from)?, norm(to)?);
  if from == to {
    return Ok(None);
  }
  let after = before.without_bytes();
  Ok(Some(Step { path: from, new_path: Some(to), before, after }))
}

/// The steps for deleting `rel`: its files and folders, folders after their
/// contents. Call before deleting.
pub fn delete_steps(base: &Path, rel: &str) -> Result<Vec<Step>> {
  let mut steps = Vec::new();
  collect_delete(base, &norm(rel)?, &mut steps)?;
  Ok(steps)
}

fn collect_delete(base: &Path, rel: &str, steps: &mut Vec<Step>) -> Result<()> {
  let before = capture(base, rel)?;
  if matches!(before, Node::Dir) {
    let mut names = Vec::new();
    for entry in std::fs::read_dir(resolve(base, rel)?)? {
      names.push(entry?.file_name().to_string_lossy().into_owned());
    }
    names.sort();
    for name in names {
      collect_delete(base, &format!("{rel}/{name}"), steps)?;
    }
  }
  steps.push(Step { path: rel.into(), new_path: None, before, after: Node::Missing });
  Ok(())
}

/// Checks that the change saved as `steps` can still be undone. Returns the
/// steps that undo that undo, in the order they should be saved (see
/// [`apply_undo`]). Changes nothing.
pub fn plan_undo(base: &Path, steps: &[Step]) -> Result<Vec<Step>> {
  let mut all_before = true;
  for s in steps {
    if !capture(base, &s.path)?.matches(&s.before) {
      all_before = false;
      break;
    }
  }
  if all_before {
    return Err(invalid("This change is already undone."));
  }

  let restored_dirs: HashSet<&str> =
    steps.iter().filter(|s| s.new_path.is_none() && matches!(s.before, Node::Dir)).map(|s| s.path.as_str()).collect();
  let mut redo = Vec::with_capacity(steps.len());
  for s in steps.iter().rev() {
    let at = s.at();
    let now_at = capture(base, at)?;
    if !now_at.matches(&s.after) {
      return Err(invalid(format!(
        "{at} has changed since the assistant changed it, so the change was not undone. Undo any later change to it first, or check the file."
      )));
    }
    if s.new_path.is_some() {
      if !capture(base, &s.path)?.matches(&Node::Missing) {
        return Err(invalid(format!("Something is now at {}, so {at} cannot be moved back.", s.path)));
      }
      check_parent(base, &s.path, &restored_dirs)?;
      redo.push(Step {
        path: at.into(),
        new_path: Some(s.path.clone()),
        before: now_at,
        after: s.before.without_bytes(),
      });
    } else {
      if matches!(s.before, Node::Missing) {
        // Removed folders must be empty, or hold only items this change also removes (applied first).
        if matches!(now_at, Node::Dir) {
          for entry in std::fs::read_dir(resolve(base, at)?)? {
            let child = format!("{at}/{}", entry?.file_name().to_string_lossy());
            if !steps.iter().any(|t| t.path == child) {
              return Err(invalid(format!("{at} is no longer empty, so it cannot be removed.")));
            }
          }
        }
      } else {
        check_parent(base, &s.path, &restored_dirs)?;
      }
      redo.push(Step { path: s.path.clone(), new_path: None, before: now_at, after: s.before.without_bytes() });
    }
  }
  Ok(redo)
}

/// The folder a restored item goes into must exist, or be restored with the change.
fn check_parent(base: &Path, rel: &str, restored_dirs: &HashSet<&str>) -> Result<()> {
  let parent = parent_of(rel);
  if parent.is_empty() || restored_dirs.contains(parent) || resolve(base, parent)?.is_dir() {
    return Ok(());
  }
  Err(invalid(format!("The folder {parent} no longer exists, so {rel} cannot be put back.")))
}

/// Puts the files of `steps` back, last change first. Run [`plan_undo`] first.
pub fn apply_undo(base: &Path, steps: &[Step]) -> Result<()> {
  for s in steps.iter().rev() {
    undo_one(base, s)?;
  }
  Ok(())
}

fn undo_one(base: &Path, s: &Step) -> Result<()> {
  match &s.new_path {
    Some(to) => std::fs::rename(resolve(base, to)?, resolve(base, &s.path)?)?,
    None => {
      let path = resolve(base, &s.path)?;
      match &s.before {
        Node::Missing => remove(&path)?,
        Node::Dir => std::fs::create_dir(&path)?,
        Node::File { bytes: Some(bytes), .. } => std::fs::write(&path, bytes)?,
        Node::File { bytes: None, .. } => return Err(invalid(format!("No saved content for {}.", s.path))),
      }
    }
  }
  Ok(())
}

/// Removes a file, or an empty folder.
fn remove(path: &Path) -> Result<()> {
  if std::fs::symlink_metadata(path)?.is_dir() {
    Ok(std::fs::remove_dir(path)?)
  } else {
    Ok(std::fs::remove_file(path)?)
  }
}

// ── Storage ──────────────────────────────────────────────────────────────────

#[derive(sqlx::FromRow)]
#[sqlx(rename_all = "camelCase")]
struct SnapRow {
  chat_id: Option<String>,
  call_id: String,
  tool: String,
  path: String,
  new_path: Option<String>,
  before_kind: String,
  before_hash: Option<String>,
  before_content: Option<Vec<u8>>,
  after_kind: String,
  after_hash: Option<String>,
  created_at: i64,
}

fn kind_of(n: &Node) -> (&'static str, Option<&str>) {
  match n {
    Node::Missing => ("missing", None),
    Node::Dir => ("dir", None),
    Node::File { hash, .. } => ("file", Some(hash)),
  }
}

fn node_of(kind: &str, hash: Option<String>, bytes: Option<Vec<u8>>) -> Node {
  match kind {
    "dir" => Node::Dir,
    "file" => Node::File { hash: hash.unwrap_or_default(), bytes },
    _ => Node::Missing,
  }
}

fn step_of(r: &SnapRow) -> Step {
  Step {
    path: r.path.clone(),
    new_path: r.new_path.clone(),
    before: node_of(&r.before_kind, r.before_hash.clone(), r.before_content.clone()),
    after: node_of(&r.after_kind, r.after_hash.clone(), None),
  }
}

/// Saves `steps` as the snapshot of one tool call, then drops snapshots past the limits.
async fn save_group(pool: &SqlitePool, call_id: &str, chat_id: Option<&str>, tool: &str, steps: &[Step]) -> Result<()> {
  let at = now();
  let mut tx = pool.begin().await?;
  for (seq, s) in steps.iter().enumerate() {
    let (before_kind, before_hash) = kind_of(&s.before);
    let (after_kind, after_hash) = kind_of(&s.after);
    // A moved file keeps its place, so its content is not saved.
    let content = match &s.before {
      Node::File { bytes: Some(b), .. } if s.new_path.is_none() => Some(b.as_slice()),
      _ => None,
    };
    sqlx::query(
      "INSERT INTO entity_snapshots (id, chatId, callId, seq, tool, path, newPath, beforeKind, beforeHash, beforeContent, afterKind, afterHash, createdAt)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
    )
    .bind(uuid::Uuid::new_v4().to_string())
    .bind(chat_id)
    .bind(call_id)
    .bind(seq as i64)
    .bind(tool)
    .bind(s.path.as_str())
    .bind(s.new_path.as_deref())
    .bind(before_kind)
    .bind(before_hash)
    .bind(content)
    .bind(after_kind)
    .bind(after_hash)
    .bind(at)
    .execute(&mut *tx)
    .await?;
  }
  sqlx::query("DELETE FROM entity_snapshots WHERE createdAt < ?1").bind(at - MAX_AGE_SECS).execute(&mut *tx).await?;
  sqlx::query(
    "DELETE FROM entity_snapshots WHERE callId IN (
       SELECT callId FROM entity_snapshots GROUP BY callId ORDER BY MAX(rowid) DESC LIMIT -1 OFFSET ?1)",
  )
  .bind(MAX_CALLS)
  .execute(&mut *tx)
  .await?;
  tx.commit().await?;
  Ok(())
}

/// Saves `steps` as the snapshot of this tool call, for a change whose steps
/// are only known once it ran.
pub async fn save(pool: &SqlitePool, meta: &CallMeta, tool: &str, steps: &[Step]) -> Result<()> {
  save_group(pool, &meta.call_id, meta.chat_id.as_deref(), tool, steps).await
}

/// Saves `steps` as this tool call's snapshot, then runs `change`. If the
/// change fails, the snapshot is dropped again. Snapshot first, so a change is
/// never made without one.
pub async fn guard<T>(
  pool: &SqlitePool,
  meta: &CallMeta,
  tool: &str,
  steps: &[Step],
  change: impl FnOnce() -> Result<T>,
) -> Result<T> {
  save(pool, meta, tool, steps).await?;
  let out = change();
  if out.is_err() {
    let _ = sqlx::query("DELETE FROM entity_snapshots WHERE callId = ?1").bind(&meta.call_id).execute(pool).await;
  }
  out
}

/// `path`, or `path -> new_path` for a rename.
fn path_text(path: &str, new_path: Option<&str>) -> String {
  match new_path {
    Some(to) => format!("{path} -> {to}"),
    None => path.to_string(),
  }
}

/// One tool call's saved change, as listed to the assistant and the page.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedCall {
  pub call_id: String,
  pub chat_id: Option<String>,
  pub tool: String,
  pub created_at: i64,
  pub paths: Vec<String>,
}

/// The newest saved changes, newest first. `path` matches any path containing it.
pub async fn list(a: &Assistant, chat_id: Option<&str>, path: Option<&str>, limit: i64) -> Result<Vec<SavedCall>> {
  list_in(&a.pool().await, chat_id, path, limit).await
}

async fn list_in(pool: &SqlitePool, chat_id: Option<&str>, path: Option<&str>, limit: i64) -> Result<Vec<SavedCall>> {
  let like = path.map(|p| format!("%{p}%"));
  let rows: Vec<SnapRow> = sqlx::query_as(
    "SELECT * FROM entity_snapshots WHERE callId IN (
       SELECT callId FROM entity_snapshots
       WHERE (?1 IS NULL OR chatId = ?1) AND (?2 IS NULL OR path LIKE ?2 OR newPath LIKE ?2)
       GROUP BY callId ORDER BY MAX(rowid) DESC LIMIT ?3)
     ORDER BY rowid",
  )
  .bind(chat_id)
  .bind(like)
  .bind(limit)
  .fetch_all(pool)
  .await?;

  let mut index: HashMap<String, usize> = HashMap::new();
  let mut calls: Vec<SavedCall> = Vec::new();
  for r in rows {
    let i = *index.entry(r.call_id.clone()).or_insert_with(|| {
      calls.push(SavedCall {
        call_id: r.call_id.clone(),
        chat_id: r.chat_id.clone(),
        tool: r.tool.clone(),
        created_at: r.created_at,
        paths: Vec::new(),
      });
      calls.len() - 1
    });
    calls[i].paths.push(path_text(&r.path, r.new_path.as_deref()));
  }
  calls.reverse();
  Ok(calls)
}

fn base(a: &Assistant) -> Result<PathBuf> {
  a.workspace()
    .resolve(PathKind::TwxEntities)
    .ok_or_else(|| invalid("No workspace folder is set. Choose one in Settings."))
}

/// Undoes the change saved for `id`, a snapshot id or a tool call id. `by` is
/// the call doing the undo (None from the page); the undo is saved as its own
/// snapshot under that call.
pub async fn undo(a: &Assistant, id: &str, by: Option<&CallMeta>) -> Result<String> {
  undo_in(&a.pool().await, &base(a)?, id, by).await
}

async fn undo_in(pool: &SqlitePool, base: &Path, id: &str, by: Option<&CallMeta>) -> Result<String> {
  let call: Option<String> =
    sqlx::query_scalar("SELECT callId FROM entity_snapshots WHERE id = ?1 OR callId = ?1 LIMIT 1")
      .bind(id)
      .fetch_optional(pool)
      .await?;
  let Some(call) = call else {
    return Err(CoreError::NotFound(format!("No saved change for \"{id}\". It may be older than 30 days or pruned.")));
  };
  let rows: Vec<SnapRow> =
    sqlx::query_as("SELECT * FROM entity_snapshots WHERE callId = ?1 ORDER BY seq").bind(&call).fetch_all(pool).await?;
  let first = &rows[0];
  let steps: Vec<Step> = rows.iter().map(step_of).collect();

  let redo = plan_undo(base, &steps)?;
  let undo_call = by.map_or_else(|| uuid::Uuid::new_v4().to_string(), |m| m.call_id.clone());
  let chat = by.and_then(|m| m.chat_id.as_deref()).or(first.chat_id.as_deref());
  save_group(pool, &undo_call, chat, "entity_undo", &redo).await?;
  apply_undo(base, &steps)?;

  let paths: Vec<String> = steps.iter().map(|s| path_text(&s.path, s.new_path.as_deref())).collect();
  Ok(format!("Undid {} on {}.", first.tool, paths.join(", ")))
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::fs;

  /// Undoes `steps` on disk and returns the steps that undo the undo.
  fn undo_steps(base: &Path, steps: &[Step]) -> Result<Vec<Step>> {
    let redo = plan_undo(base, steps)?;
    apply_undo(base, steps)?;
    Ok(redo)
  }

  #[test]
  fn write_is_undone_and_the_undo_is_undone() {
    let dir = tempfile::tempdir().unwrap();
    let base = dir.path();
    fs::create_dir_all(base.join("dev")).unwrap();
    fs::write(base.join("dev/a.xml"), "old").unwrap();

    let steps = vec![write_step(base, "dev/a.xml", b"new").unwrap()];
    fs::write(base.join("dev/a.xml"), "new").unwrap();

    let redo = undo_steps(base, &steps).unwrap();
    assert_eq!(fs::read_to_string(base.join("dev/a.xml")).unwrap(), "old");
    undo_steps(base, &redo).unwrap();
    assert_eq!(fs::read_to_string(base.join("dev/a.xml")).unwrap(), "new");
  }

  #[test]
  fn refuses_when_the_file_changed_since() {
    let dir = tempfile::tempdir().unwrap();
    let base = dir.path();
    fs::write(base.join("a.xml"), "old").unwrap();

    let steps = vec![write_step(base, "a.xml", b"new").unwrap()];
    fs::write(base.join("a.xml"), "new").unwrap();
    fs::write(base.join("a.xml"), "hand edit").unwrap();

    let err = undo_steps(base, &steps).unwrap_err().to_string();
    assert!(err.contains("has changed since"), "{err}");
    assert_eq!(fs::read_to_string(base.join("a.xml")).unwrap(), "hand edit");
  }

  #[test]
  fn created_file_is_removed_and_comes_back() {
    let dir = tempfile::tempdir().unwrap();
    let base = dir.path();
    let steps = vec![create_step("new.xml", false).unwrap()];
    fs::write(base.join("new.xml"), "").unwrap();

    let redo = undo_steps(base, &steps).unwrap();
    assert!(!base.join("new.xml").exists());
    undo_steps(base, &redo).unwrap();
    assert!(base.join("new.xml").is_file());
  }

  #[test]
  fn created_folder_refuses_when_it_has_content() {
    let dir = tempfile::tempdir().unwrap();
    let base = dir.path();
    let steps = vec![create_step("Folder", true).unwrap()];
    fs::create_dir(base.join("Folder")).unwrap();
    fs::write(base.join("Folder/x.xml"), "x").unwrap();

    let err = undo_steps(base, &steps).unwrap_err().to_string();
    assert!(err.contains("changed since") || err.contains("no longer empty"), "{err}");
    assert!(base.join("Folder/x.xml").is_file());
  }

  #[test]
  fn deleted_folder_comes_back_with_its_contents() {
    let dir = tempfile::tempdir().unwrap();
    let base = dir.path();
    fs::create_dir_all(base.join("dev/A/sub")).unwrap();
    fs::write(base.join("dev/A/x.xml"), "1").unwrap();
    fs::write(base.join("dev/A/sub/y.xml"), "2").unwrap();

    let steps = delete_steps(base, "dev/A").unwrap();
    fs::remove_dir_all(base.join("dev/A")).unwrap();

    let redo = undo_steps(base, &steps).unwrap();
    assert_eq!(fs::read_to_string(base.join("dev/A/x.xml")).unwrap(), "1");
    assert_eq!(fs::read_to_string(base.join("dev/A/sub/y.xml")).unwrap(), "2");

    undo_steps(base, &redo).unwrap();
    assert!(!base.join("dev/A").exists());
  }

  #[test]
  fn rename_moves_back_and_refuses_when_the_old_name_is_taken() {
    let dir = tempfile::tempdir().unwrap();
    let base = dir.path();
    fs::write(base.join("a.xml"), "a").unwrap();
    let before = capture(base, "a.xml").unwrap();
    fs::rename(base.join("a.xml"), base.join("b.xml")).unwrap();
    let steps = vec![move_step("a.xml", "b.xml", before).unwrap().unwrap()];

    fs::write(base.join("a.xml"), "taken").unwrap();
    let err = undo_steps(base, &steps).unwrap_err().to_string();
    assert!(err.contains("Something is now at a.xml"), "{err}");

    fs::remove_file(base.join("a.xml")).unwrap();
    undo_steps(base, &steps).unwrap();
    assert_eq!(fs::read_to_string(base.join("a.xml")).unwrap(), "a");
    assert!(!base.join("b.xml").exists());
  }

  #[test]
  fn undoing_twice_is_refused() {
    let dir = tempfile::tempdir().unwrap();
    let base = dir.path();
    fs::write(base.join("a.xml"), "old").unwrap();
    let steps = vec![write_step(base, "a.xml", b"new").unwrap()];
    fs::write(base.join("a.xml"), "new").unwrap();

    undo_steps(base, &steps).unwrap();
    let err = plan_undo(base, &steps).unwrap_err().to_string();
    assert!(err.contains("already undone"), "{err}");
  }

  #[test]
  fn move_to_the_same_name_is_not_a_step() {
    let dir = tempfile::tempdir().unwrap();
    assert!(move_step("a.xml", "a.xml", capture(dir.path(), "a.xml").unwrap()).unwrap().is_none());
  }

  #[tokio::test]
  async fn saved_change_is_listed_undone_and_its_undo_undone() {
    let dir = tempfile::tempdir().unwrap();
    let pool = crate::db::open(&dir.path().join("test.db")).await.unwrap();
    let base = dir.path().join("entities");
    fs::create_dir_all(&base).unwrap();
    fs::write(base.join("a.xml"), "old").unwrap();
    let meta = CallMeta { chat_id: Some("chat".into()), source: "assistant".into(), call_id: "call-1".into() };

    // A change that fails leaves no snapshot behind.
    let step = write_step(&base, "a.xml", b"new").unwrap();
    let failed =
      guard(&pool, &meta, "entity_write", std::slice::from_ref(&step), || -> Result<()> { Err(invalid("disk full")) })
        .await;
    assert!(failed.is_err());
    assert!(list_in(&pool, None, None, 20).await.unwrap().is_empty());

    guard(&pool, &meta, "entity_write", &[step], || -> Result<()> {
      fs::write(base.join("a.xml"), "new")?;
      Ok(())
    })
    .await
    .unwrap();
    let calls = list_in(&pool, Some("chat"), Some("a.xml"), 20).await.unwrap();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].tool, "entity_write");
    assert_eq!(calls[0].paths, vec!["a.xml".to_string()]);

    undo_in(&pool, &base, "call-1", None).await.unwrap();
    assert_eq!(fs::read_to_string(base.join("a.xml")).unwrap(), "old");
    assert!(undo_in(&pool, &base, "call-1", None).await.is_err(), "second undo is refused");

    // The undo is a saved change too, newest in the list, and undoing it puts the new text back.
    let calls = list_in(&pool, None, None, 20).await.unwrap();
    assert_eq!(calls.len(), 2);
    assert_eq!(calls[0].tool, "entity_undo");
    undo_in(&pool, &base, &calls[0].call_id, None).await.unwrap();
    assert_eq!(fs::read_to_string(base.join("a.xml")).unwrap(), "new");
  }

  #[test]
  fn paths_cannot_leave_the_folder() {
    let dir = tempfile::tempdir().unwrap();
    assert!(write_step(dir.path(), "../x.xml", b"").is_err());
    assert!(capture(dir.path(), "").is_err());
  }
}
