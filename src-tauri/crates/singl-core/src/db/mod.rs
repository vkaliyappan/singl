//! SQLite database. The schema is singl-web's: `migrations/0000`–`0019` are its
//! Drizzle migrations copied byte for byte (so [`import`] can match them by
//! hash), and later files are sqlx-only.
//!
//! Encodings follow Drizzle's integer modes: timestamps are unix **seconds**
//! (`i64`, see [`now`]) and booleans are `0`/`1`.

pub mod environments;
pub mod flows;
pub mod import;
pub mod models;
pub mod repo;
pub mod service_presets;
pub mod settings;

use std::path::Path;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use sqlx::SqlitePool;
use sqlx::migrate::Migrator;
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions};

use crate::Result;

pub static MIGRATOR: Migrator = sqlx::migrate!("./migrations");

/// Opens (creating if needed) the database at `path` and applies pending migrations.
pub async fn open(path: &Path) -> Result<SqlitePool> {
  if let Some(dir) = path.parent() {
    std::fs::create_dir_all(dir)?;
  }
  let pool = SqlitePoolOptions::new()
    .max_connections(5)
    .connect_with(connect_options(path).create_if_missing(true))
    .await?;
  MIGRATOR.run(&pool).await?;
  Ok(pool)
}

fn connect_options(path: &Path) -> SqliteConnectOptions {
  SqliteConnectOptions::new()
    .filename(path)
    .journal_mode(SqliteJournalMode::Wal)
    .foreign_keys(true)
    .busy_timeout(Duration::from_secs(5))
}

/// Current time in Drizzle's `integer({ mode: "timestamp" })` encoding.
pub fn now() -> i64 {
  SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

/// Versions of the migrations applied to `pool`, oldest first.
pub async fn applied_migrations(pool: &SqlitePool) -> Result<Vec<i64>> {
  Ok(
    sqlx::query_scalar("SELECT version FROM _sqlx_migrations WHERE success = 1 ORDER BY version")
      .fetch_all(pool)
      .await?,
  )
}

#[cfg(test)]
mod tests {
  use super::*;

  #[tokio::test]
  async fn fresh_db_migrates() {
    let dir = tempfile::tempdir().unwrap();
    let pool = open(&dir.path().join("singl.db")).await.unwrap();
    let applied = applied_migrations(&pool).await.unwrap();
    assert_eq!(applied.len(), MIGRATOR.iter().count());
    assert_eq!(settings::workspace_root(&pool).await.unwrap(), None);
  }
}
