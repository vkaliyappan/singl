//! `app_settings` is a single row with id 1, as in singl-web.

use std::path::PathBuf;

use serde::Serialize;
use sqlx::SqlitePool;

use super::models::AppSettings;
use super::now;
use crate::Result;

const BUNDLE_DEST_DIR: &str = "./bundles";
/// The `bundleDestDir` column default (migration 0006), from when bundles lived under `dist/`.
const LEGACY_BUNDLE_DEST_DIR: &str = "./dist/bundles";

/// What the Settings page shows. The PAT itself never leaves the backend.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettingsView {
  pub has_azure_pat_token: bool,
  pub twx_root_prefix: String,
  pub repo_root_subpath: String,
  pub bundle_src_dir: String,
  pub bundle_dest_dir: String,
  pub workspace_root: String,
  pub update_dir: String,
}

/// The row, or the column defaults when it has never been written.
pub async fn get(pool: &SqlitePool) -> Result<AppSettingsView> {
  let row: Option<AppSettings> = sqlx::query_as("SELECT * FROM app_settings WHERE id = 1").fetch_optional(pool).await?;
  Ok(match row {
    Some(row) => AppSettingsView {
      has_azure_pat_token: !row.azure_pat_token.is_empty(),
      twx_root_prefix: row.twx_root_prefix,
      repo_root_subpath: row.repo_root_subpath,
      bundle_src_dir: row.bundle_src_dir,
      bundle_dest_dir: if row.bundle_dest_dir == LEGACY_BUNDLE_DEST_DIR {
        BUNDLE_DEST_DIR.into()
      } else {
        row.bundle_dest_dir
      },
      workspace_root: row.workspace_root,
      update_dir: row.update_dir,
    },
    None => AppSettingsView {
      has_azure_pat_token: false,
      twx_root_prefix: "WindchillClients/Thingworx".into(),
      repo_root_subpath: String::new(),
      bundle_src_dir: "./WindchillClients/Thingworx".into(),
      bundle_dest_dir: BUNDLE_DEST_DIR.into(),
      workspace_root: String::new(),
      update_dir: String::new(),
    },
  })
}

pub async fn azure_pat_token(pool: &SqlitePool) -> Result<Option<String>> {
  let token: Option<String> = sqlx::query_scalar("SELECT azurePatToken FROM app_settings WHERE id = 1")
    .fetch_optional(pool)
    .await?;
  Ok(token.filter(|t| !t.is_empty()))
}

/// An empty token clears it.
pub async fn set_azure_pat_token(pool: &SqlitePool, token: &str) -> Result<()> {
  sqlx::query(
    "INSERT INTO app_settings (id, azurePatToken, updatedAt) VALUES (1, ?1, ?2)
     ON CONFLICT(id) DO UPDATE SET azurePatToken = excluded.azurePatToken, updatedAt = excluded.updatedAt",
  )
  .bind(token.trim())
  .bind(now())
  .execute(pool)
  .await?;
  Ok(())
}

/// How `twx-entities/{env}/` paths line up with the cloned repo on the compare page.
pub async fn set_compare_paths(pool: &SqlitePool, twx_root_prefix: &str, repo_root_subpath: &str) -> Result<()> {
  sqlx::query(
    "INSERT INTO app_settings (id, twxRootPrefix, repoRootSubpath, updatedAt) VALUES (1, ?1, ?2, ?3)
     ON CONFLICT(id) DO UPDATE SET twxRootPrefix = excluded.twxRootPrefix,
       repoRootSubpath = excluded.repoRootSubpath, updatedAt = excluded.updatedAt",
  )
  .bind(twx_root_prefix.trim())
  .bind(repo_root_subpath.trim())
  .bind(now())
  .execute(pool)
  .await?;
  Ok(())
}

/// Default source and output folders for the deploy bundler.
pub async fn set_bundle_dirs(pool: &SqlitePool, bundle_src_dir: &str, bundle_dest_dir: &str) -> Result<()> {
  sqlx::query(
    "INSERT INTO app_settings (id, bundleSrcDir, bundleDestDir, updatedAt) VALUES (1, ?1, ?2, ?3)
     ON CONFLICT(id) DO UPDATE SET bundleSrcDir = excluded.bundleSrcDir,
       bundleDestDir = excluded.bundleDestDir, updatedAt = excluded.updatedAt",
  )
  .bind(bundle_src_dir.trim())
  .bind(bundle_dest_dir.trim())
  .bind(now())
  .execute(pool)
  .await?;
  Ok(())
}

pub async fn workspace_root(pool: &SqlitePool) -> Result<Option<PathBuf>> {
  let root: Option<String> = sqlx::query_scalar("SELECT workspaceRoot FROM app_settings WHERE id = 1")
    .fetch_optional(pool)
    .await?;
  Ok(root.filter(|r| !r.is_empty()).map(PathBuf::from))
}

pub async fn set_workspace_root(pool: &SqlitePool, root: &str) -> Result<()> {
  sqlx::query(
    "INSERT INTO app_settings (id, workspaceRoot, updatedAt) VALUES (1, ?1, ?2)
     ON CONFLICT(id) DO UPDATE SET workspaceRoot = excluded.workspaceRoot, updatedAt = excluded.updatedAt",
  )
  .bind(root)
  .bind(now())
  .execute(pool)
  .await?;
  Ok(())
}

pub async fn update_dir(pool: &SqlitePool) -> Result<Option<PathBuf>> {
  let dir: Option<String> = sqlx::query_scalar("SELECT updateDir FROM app_settings WHERE id = 1")
    .fetch_optional(pool)
    .await?;
  Ok(dir.filter(|d| !d.is_empty()).map(PathBuf::from))
}

/// Folder the in-app updater reads `latest.json` and installers from.
pub async fn set_update_dir(pool: &SqlitePool, dir: &str) -> Result<()> {
  sqlx::query(
    "INSERT INTO app_settings (id, updateDir, updatedAt) VALUES (1, ?1, ?2)
     ON CONFLICT(id) DO UPDATE SET updateDir = excluded.updateDir, updatedAt = excluded.updatedAt",
  )
  .bind(dir)
  .bind(now())
  .execute(pool)
  .await?;
  Ok(())
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::db::open;

  #[tokio::test]
  async fn defaults_then_partial_writes() {
    let dir = tempfile::tempdir().unwrap();
    let pool = open(&dir.path().join("singl.db")).await.unwrap();

    let fresh = get(&pool).await.unwrap();
    assert!(!fresh.has_azure_pat_token);
    assert_eq!(fresh.bundle_dest_dir, "./bundles");

    set_compare_paths(&pool, " Root/Prefix ", "sub").await.unwrap();
    set_azure_pat_token(&pool, "secret").await.unwrap();
    let saved = get(&pool).await.unwrap();
    assert_eq!(saved.twx_root_prefix, "Root/Prefix");
    assert_eq!(saved.repo_root_subpath, "sub");
    assert!(saved.has_azure_pat_token);
    // Columns the first write left alone keep their defaults.
    assert_eq!(saved.bundle_src_dir, "./WindchillClients/Thingworx");
    assert_eq!(saved.bundle_dest_dir, "./bundles");
    assert_eq!(azure_pat_token(&pool).await.unwrap().as_deref(), Some("secret"));

    set_azure_pat_token(&pool, "").await.unwrap();
    assert!(!get(&pool).await.unwrap().has_azure_pat_token);
  }
}
