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
  heal_line_endings(&pool).await?;
  MIGRATOR.run(&pool).await?;
  Ok(pool)
}

/// Git on Windows may check a migration out with CRLF where the build that
/// applied it had LF (or the other way round). sqlx checksums the exact bytes and
/// refuses to start on a mismatch, so a stored checksum that differs from the
/// embedded file only in line endings is updated to match.
async fn heal_line_endings(pool: &SqlitePool) -> Result<()> {
  use sha2::{Digest, Sha384};
  let table: Option<String> =
    sqlx::query_scalar("SELECT name FROM sqlite_master WHERE type = 'table' AND name = '_sqlx_migrations'")
      .fetch_optional(pool)
      .await?;
  if table.is_none() {
    return Ok(());
  }
  let stored: Vec<(i64, Vec<u8>)> = sqlx::query_as("SELECT version, checksum FROM _sqlx_migrations").fetch_all(pool).await?;
  for (version, checksum) in stored {
    let Some(m) = MIGRATOR.iter().find(|m| m.version == version) else { continue };
    if checksum.as_slice() == &*m.checksum {
      continue;
    }
    let lf = m.sql.replace("\r\n", "\n");
    let crlf = lf.replace('\n', "\r\n");
    let same_text = [lf, crlf].iter().any(|v| Sha384::digest(v.as_bytes()).as_slice() == checksum.as_slice());
    if same_text {
      sqlx::query("UPDATE _sqlx_migrations SET checksum = ? WHERE version = ?")
        .bind(&*m.checksum)
        .bind(version)
        .execute(pool)
        .await?;
    }
  }
  Ok(())
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

  #[tokio::test]
  async fn line_ending_only_checksum_changes_are_healed() {
    use sha2::{Digest, Sha384};
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("singl.db");
    let pool = open(&path).await.unwrap();
    let m = MIGRATOR.iter().last().unwrap();
    let flipped = if m.sql.contains("\r\n") { m.sql.replace("\r\n", "\n") } else { m.sql.replace('\n', "\r\n") };
    let other = Sha384::digest(flipped.as_bytes()).to_vec();
    sqlx::query("UPDATE _sqlx_migrations SET checksum = ? WHERE version = ?").bind(&other).bind(m.version).execute(&pool).await.unwrap();
    // A real edit is still refused.
    pool.close().await;
    open(&path).await.unwrap();
    let pool = open(&path).await.unwrap();
    sqlx::query("UPDATE _sqlx_migrations SET checksum = X'00' WHERE version = ?").bind(m.version).execute(&pool).await.unwrap();
    pool.close().await;
    assert!(open(&path).await.is_err());
  }
}
