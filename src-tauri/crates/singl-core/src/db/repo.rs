//! `repo_settings` is a single row with id 1: the repository the Repository
//! page last cloned, so the page restores it on reload.

use serde::Serialize;
use sqlx::SqlitePool;

use super::models::RepoSettings;
use super::now;
use crate::Result;

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoState {
  pub repo_url: String,
  pub cloned_branch: String,
  pub repo_slug: String,
}

/// The row, or blanks when nothing has been cloned yet.
pub async fn get(pool: &SqlitePool) -> Result<RepoState> {
  let row: Option<RepoSettings> = sqlx::query_as("SELECT * FROM repo_settings WHERE id = 1").fetch_optional(pool).await?;
  Ok(row.map_or_else(RepoState::default, |row| RepoState {
    repo_url: row.repo_url,
    cloned_branch: row.cloned_branch,
    repo_slug: row.repo_slug,
  }))
}

pub async fn save(pool: &SqlitePool, repo_url: &str, branch: &str, slug: &str) -> Result<()> {
  sqlx::query(
    "INSERT INTO repo_settings (id, repoUrl, clonedBranch, repoSlug, updatedAt) VALUES (1, ?1, ?2, ?3, ?4)
     ON CONFLICT(id) DO UPDATE SET repoUrl = excluded.repoUrl, clonedBranch = excluded.clonedBranch,
       repoSlug = excluded.repoSlug, updatedAt = excluded.updatedAt",
  )
  .bind(repo_url)
  .bind(branch)
  .bind(slug)
  .bind(now())
  .execute(pool)
  .await?;
  Ok(())
}

pub async fn set_branch(pool: &SqlitePool, branch: &str) -> Result<()> {
  sqlx::query("UPDATE repo_settings SET clonedBranch = ?1, updatedAt = ?2 WHERE id = 1")
    .bind(branch)
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
  async fn save_then_switch_branch() {
    let dir = tempfile::tempdir().unwrap();
    let pool = open(&dir.path().join("singl.db")).await.unwrap();

    assert_eq!(get(&pool).await.unwrap().repo_slug, "");
    save(&pool, "https://example.com/r.git", "main", "r").await.unwrap();
    set_branch(&pool, "dev").await.unwrap();
    let state = get(&pool).await.unwrap();
    assert_eq!((state.repo_url.as_str(), state.cloned_branch.as_str(), state.repo_slug.as_str()), ("https://example.com/r.git", "dev", "r"));
  }
}
