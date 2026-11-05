//! Service flows (`service_flows`) and the folders they sit in (`flow_folders`):
//! singl-web's `twx-flow/actions.ts` and `twx-flow/folder-actions.ts`.
//!
//! A flow is one JSON document (`graph`); the editor always writes it whole.
//! Folders form an adjacency list. Deleting a folder either lifts its contents
//! to its parent or, when recursive, deletes the subtree and every flow in it.

use std::collections::HashMap;

use sqlx::SqlitePool;

use super::models::{FlowFolder, ServiceFlow};
use super::now;
use crate::{CoreError, Result};

pub const EMPTY_GRAPH: &str = r#"{"nodes":[],"edges":[]}"#;

fn new_id() -> String {
  uuid::Uuid::new_v4().to_string()
}

/* ------------------------------------------------------------------ flows -- */

/// Every flow, most recently changed first.
pub async fn list(pool: &SqlitePool) -> Result<Vec<ServiceFlow>> {
  Ok(sqlx::query_as("SELECT * FROM service_flows ORDER BY updatedAt DESC").fetch_all(pool).await?)
}

pub async fn get(pool: &SqlitePool, id: &str) -> Result<Option<ServiceFlow>> {
  Ok(sqlx::query_as("SELECT * FROM service_flows WHERE id = ?1").bind(id).fetch_optional(pool).await?)
}

/// Creates a flow and returns its id. Blank names and graphs fall back to defaults.
pub async fn create(
  pool: &SqlitePool,
  name: &str,
  environment: &str,
  folder_id: Option<&str>,
  graph: Option<&str>,
) -> Result<String> {
  let id = new_id();
  let name = match name.trim() {
    "" => "Untitled flow",
    trimmed => trimmed,
  };
  let graph = graph.filter(|g| !g.trim().is_empty()).unwrap_or(EMPTY_GRAPH);
  let folder_id = folder_id.map(str::trim).filter(|f| !f.is_empty());
  let at = now();
  sqlx::query(
    "INSERT INTO service_flows (id, name, environment, folderId, graph, createdAt, updatedAt)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
  )
  .bind(&id)
  .bind(name)
  .bind(environment.trim())
  .bind(folder_id)
  .bind(graph)
  .bind(at)
  .execute(pool)
  .await?;
  Ok(id)
}

pub async fn rename(pool: &SqlitePool, id: &str, name: &str) -> Result<()> {
  let name = name.trim();
  if name.is_empty() {
    return Err(CoreError::Invalid("Name is required.".into()));
  }
  sqlx::query("UPDATE service_flows SET name = ?1, updatedAt = ?2 WHERE id = ?3")
    .bind(name)
    .bind(now())
    .bind(id)
    .execute(pool)
    .await?;
  Ok(())
}

pub async fn delete(pool: &SqlitePool, id: &str) -> Result<()> {
  sqlx::query("DELETE FROM service_flows WHERE id = ?1").bind(id).execute(pool).await?;
  Ok(())
}

/// Copies a flow next to the original as "<name> (Copy)" and returns the new id.
pub async fn duplicate(pool: &SqlitePool, id: &str) -> Result<String> {
  let original = get(pool, id).await?.ok_or_else(|| CoreError::NotFound("Flow not found".into()))?;
  create(
    pool,
    &format!("{} (Copy)", original.name),
    &original.environment,
    original.folder_id.as_deref(),
    Some(&original.graph),
  )
  .await
}

/// Full-document write; the editor debounces it.
pub async fn save(pool: &SqlitePool, id: &str, graph: &str, environment: &str) -> Result<()> {
  sqlx::query("UPDATE service_flows SET graph = ?1, environment = ?2, updatedAt = ?3 WHERE id = ?4")
    .bind(graph)
    .bind(environment)
    .bind(now())
    .bind(id)
    .execute(pool)
    .await?;
  Ok(())
}

/// Moves one flow into a folder, or to the root when `folder_id` is `None`.
pub async fn move_flow(pool: &SqlitePool, id: &str, folder_id: Option<&str>) -> Result<()> {
  sqlx::query("UPDATE service_flows SET folderId = ?1, updatedAt = ?2 WHERE id = ?3")
    .bind(folder_id)
    .bind(now())
    .bind(id)
    .execute(pool)
    .await?;
  Ok(())
}

/* ---------------------------------------------------------------- folders -- */

pub async fn folders(pool: &SqlitePool) -> Result<Vec<FlowFolder>> {
  Ok(sqlx::query_as("SELECT * FROM flow_folders").fetch_all(pool).await?)
}

/// Every folder below `root`, at any depth.
async fn descendant_ids(pool: &SqlitePool, root: &str) -> Result<Vec<String>> {
  let rows: Vec<(String, Option<String>)> =
    sqlx::query_as("SELECT id, parentId FROM flow_folders").fetch_all(pool).await?;
  let mut by_parent: HashMap<String, Vec<String>> = HashMap::new();
  for (id, parent) in rows {
    by_parent.entry(parent.unwrap_or_default()).or_default().push(id);
  }
  let mut out = Vec::new();
  let mut stack = vec![root.to_string()];
  while let Some(current) = stack.pop() {
    for child in by_parent.get(&current).into_iter().flatten() {
      out.push(child.clone());
      stack.push(child.clone());
    }
  }
  Ok(out)
}

pub async fn create_folder(pool: &SqlitePool, name: &str, parent_id: Option<&str>) -> Result<String> {
  let name = name.trim();
  if name.is_empty() {
    return Err(CoreError::Invalid("Folder name is required.".into()));
  }
  let id = new_id();
  let at = now();
  sqlx::query("INSERT INTO flow_folders (id, name, parentId, createdAt, updatedAt) VALUES (?1, ?2, ?3, ?4, ?4)")
    .bind(&id)
    .bind(name)
    .bind(parent_id)
    .bind(at)
    .execute(pool)
    .await?;
  Ok(id)
}

pub async fn rename_folder(pool: &SqlitePool, id: &str, name: &str) -> Result<()> {
  let name = name.trim();
  if name.is_empty() {
    return Err(CoreError::Invalid("Folder name is required.".into()));
  }
  sqlx::query("UPDATE flow_folders SET name = ?1, updatedAt = ?2 WHERE id = ?3")
    .bind(name)
    .bind(now())
    .bind(id)
    .execute(pool)
    .await?;
  Ok(())
}

/// Re-parents a folder. Rejects a move into itself or its own subtree.
pub async fn move_folder(pool: &SqlitePool, id: &str, parent_id: Option<&str>) -> Result<()> {
  if Some(id) == parent_id {
    return Err(CoreError::Invalid("A folder cannot contain itself.".into()));
  }
  if let Some(parent) = parent_id
    && descendant_ids(pool, id).await?.iter().any(|d| d == parent)
  {
    return Err(CoreError::Invalid("Cannot move a folder into its own subfolder.".into()));
  }
  sqlx::query("UPDATE flow_folders SET parentId = ?1, updatedAt = ?2 WHERE id = ?3")
    .bind(parent_id)
    .bind(now())
    .bind(id)
    .execute(pool)
    .await?;
  Ok(())
}

/// Deletes a folder. `recursive` also deletes every flow in the subtree;
/// otherwise the folder's direct contents move up to its parent.
pub async fn delete_folder(pool: &SqlitePool, id: &str, recursive: bool) -> Result<()> {
  let folder: Option<FlowFolder> =
    sqlx::query_as("SELECT * FROM flow_folders WHERE id = ?1").bind(id).fetch_optional(pool).await?;
  let folder = folder.ok_or_else(|| CoreError::NotFound("Folder not found.".into()))?;

  let mut tx = pool.begin().await?;
  if recursive {
    let mut subtree = vec![id.to_string()];
    subtree.extend(descendant_ids(pool, id).await?);
    for folder_id in &subtree {
      sqlx::query("DELETE FROM service_flows WHERE folderId = ?1").bind(folder_id).execute(&mut *tx).await?;
      sqlx::query("DELETE FROM flow_folders WHERE id = ?1").bind(folder_id).execute(&mut *tx).await?;
    }
  } else {
    let at = now();
    sqlx::query("UPDATE service_flows SET folderId = ?1, updatedAt = ?2 WHERE folderId = ?3")
      .bind(&folder.parent_id)
      .bind(at)
      .bind(id)
      .execute(&mut *tx)
      .await?;
    sqlx::query("UPDATE flow_folders SET parentId = ?1, updatedAt = ?2 WHERE parentId = ?3")
      .bind(&folder.parent_id)
      .bind(at)
      .bind(id)
      .execute(&mut *tx)
      .await?;
    sqlx::query("DELETE FROM flow_folders WHERE id = ?1").bind(id).execute(&mut *tx).await?;
  }
  tx.commit().await?;
  Ok(())
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::db::open;

  async fn pool() -> (tempfile::TempDir, SqlitePool) {
    let dir = tempfile::tempdir().unwrap();
    let pool = open(&dir.path().join("t.db")).await.unwrap();
    (dir, pool)
  }

  #[tokio::test]
  async fn flow_crud_round_trips() {
    let (_dir, pool) = pool().await;
    let id = create(&pool, "  ", "DEV", None, None).await.unwrap();
    let flow = get(&pool, &id).await.unwrap().unwrap();
    assert_eq!(flow.name, "Untitled flow");
    assert_eq!(flow.graph, EMPTY_GRAPH);

    rename(&pool, &id, "Mine").await.unwrap();
    save(&pool, &id, r#"{"nodes":[1],"edges":[]}"#, "QA").await.unwrap();
    let copy = duplicate(&pool, &id).await.unwrap();
    let copied = get(&pool, &copy).await.unwrap().unwrap();
    assert_eq!(copied.name, "Mine (Copy)");
    assert_eq!(copied.environment, "QA");
    assert_eq!(list(&pool).await.unwrap().len(), 2);

    delete(&pool, &id).await.unwrap();
    assert!(get(&pool, &id).await.unwrap().is_none());
  }

  #[tokio::test]
  async fn folders_refuse_cycles_and_delete_both_ways() {
    let (_dir, pool) = pool().await;
    let a = create_folder(&pool, "A", None).await.unwrap();
    let b = create_folder(&pool, "B", Some(&a)).await.unwrap();
    let c = create_folder(&pool, "C", Some(&b)).await.unwrap();
    assert!(move_folder(&pool, &a, Some(&c)).await.is_err());
    assert!(move_folder(&pool, &a, Some(&a)).await.is_err());

    let in_b = create(&pool, "in b", "", Some(&b), None).await.unwrap();
    delete_folder(&pool, &b, false).await.unwrap();
    assert_eq!(get(&pool, &in_b).await.unwrap().unwrap().folder_id.as_deref(), Some(a.as_str()));
    let c_row = folders(&pool).await.unwrap().into_iter().find(|f| f.id == c).unwrap();
    assert_eq!(c_row.parent_id.as_deref(), Some(a.as_str()));

    delete_folder(&pool, &a, true).await.unwrap();
    assert!(folders(&pool).await.unwrap().is_empty());
    assert!(get(&pool, &in_b).await.unwrap().is_none());
  }
}
