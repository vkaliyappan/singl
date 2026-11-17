//! `repo_settings` holds one row per Repository page slot (id 1 is the main
//! Repository page, id 2 the second one): the repository that slot last
//! cloned, so the page restores it on reload.

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
pub async fn get(pool: &SqlitePool, slot: i64) -> Result<RepoState> {
  let row: Option<RepoSettings> =
    sqlx::query_as("SELECT * FROM repo_settings WHERE id = ?1").bind(slot).fetch_optional(pool).await?;
  Ok(row.map_or_else(RepoState::default, |row| RepoState {
    repo_url: row.repo_url,
    cloned_branch: row.cloned_branch,
    repo_slug: row.repo_slug,
  }))
}

pub async fn save(pool: &SqlitePool, slot: i64, repo_url: &str, branch: &str, slug: &str) -> Result<()> {
  sqlx::query(
    "INSERT INTO repo_settings (id, repoUrl, clonedBranch, repoSlug, updatedAt) VALUES (?5, ?1, ?2, ?3, ?4)
     ON CONFLICT(id) DO UPDATE SET repoUrl = excluded.repoUrl, clonedBranch = excluded.clonedBranch,
       repoSlug = excluded.repoSlug, updatedAt = excluded.updatedAt",
  )
  .bind(repo_url)
  .bind(branch)
  .bind(slug)
  .bind(now())
  .bind(slot)
  .execute(pool)
  .await?;
  Ok(())
}

pub async fn set_branch(pool: &SqlitePool, slot: i64, branch: &str) -> Result<()> {
  sqlx::query("UPDATE repo_settings SET clonedBranch = ?1, updatedAt = ?2 WHERE id = ?3")
    .bind(branch)
    .bind(now())
    .bind(slot)
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

    assert_eq!(get(&pool, 1).await.unwrap().repo_slug, "");
    save(&pool, 1, "https://example.com/r.git", "main", "r").await.unwrap();
    save(&pool, 2, "https://example.com/w.git", "master", "w").await.unwrap();
    set_branch(&pool, 1, "dev").await.unwrap();
    let other = get(&pool, 2).await.unwrap();
    assert_eq!((other.cloned_branch.as_str(), other.repo_slug.as_str()), ("master", "w"));
    let state = get(&pool, 1).await.unwrap();
    assert_eq!((state.repo_url.as_str(), state.cloned_branch.as_str(), state.repo_slug.as_str()), ("https://example.com/r.git", "dev", "r"));
  }
}
