//! One-time import of singl-web's `local.db`.
//!
//! Drizzle records applied migrations in `__drizzle_migrations` (sha256 of each
//! file), sqlx in `_sqlx_migrations`. The import copies the source with
//! `VACUUM INTO`, checks its Drizzle hashes against the embedded copies of the
//! same files, and stamps those as applied so sqlx never re-runs them. Opening
//! the result with [`super::open`] then applies only the sqlx-only migrations.

use std::path::Path;

use serde::Serialize;
use sha2::{Digest, Sha256};
use sqlx::migrate::Migrate;
use sqlx::sqlite::SqliteConnectOptions;
use sqlx::{ConnectOptions, Connection};

use super::MIGRATOR;
use crate::{CoreError, Result};

/// Migrations `0000`–`0019` came from Drizzle; anything later is sqlx-only.
pub const DRIZZLE_MIGRATIONS: usize = 20;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportReport {
  /// Drizzle migrations found applied in the source and stamped for sqlx.
  pub stamped: usize,
}

/// Copies the Drizzle database at `source` to a new file at `dest`.
/// `dest` must not exist; on failure it is removed again.
pub async fn import_drizzle(source: &Path, dest: &Path) -> Result<ImportReport> {
  if !source.is_file() {
    return Err(CoreError::NotFound(format!("no database at {}", source.display())));
  }
  if dest.exists() {
    return Err(CoreError::Invalid(format!("{} already exists", dest.display())));
  }
  if let Some(dir) = dest.parent() {
    std::fs::create_dir_all(dir)?;
  }

  let mut src = SqliteConnectOptions::new().filename(source).read_only(true).connect().await?;
  let hashes: Vec<String> = sqlx::query_scalar("SELECT hash FROM __drizzle_migrations ORDER BY rowid")
    .fetch_all(&mut src)
    .await
    .map_err(|e| CoreError::Invalid(format!("not a singl-web database: {e}")))?;
  check_hashes(&hashes)?;

  sqlx::query("VACUUM INTO ?").bind(dest.to_string_lossy().into_owned()).execute(&mut src).await?;
  src.close().await?;

  let stamped = stamp(dest, hashes.len()).await;
  if stamped.is_err() {
    let _ = std::fs::remove_file(dest);
  }
  stamped.map(|stamped| ImportReport { stamped })
}

fn check_hashes(hashes: &[String]) -> Result<()> {
  if hashes.len() > DRIZZLE_MIGRATIONS {
    return Err(CoreError::Invalid(format!(
      "source has {} Drizzle migrations; this build knows {DRIZZLE_MIGRATIONS}",
      hashes.len()
    )));
  }
  for (migration, hash) in MIGRATOR.iter().zip(hashes) {
    // singl-web's checkout flipped some files between LF and CRLF after they were
    // applied, so the recorded hash may be of either form.
    let lf = migration.sql.replace("\r\n", "\n");
    if drizzle_hash(&lf) != *hash && drizzle_hash(&lf.replace('\n', "\r\n")) != *hash {
      return Err(CoreError::Invalid(format!(
        "migration {} ({}) differs from the one applied to the source",
        migration.version, migration.description
      )));
    }
  }
  Ok(())
}

/// Drizzle's hash: sha256 of the whole file, hex.
fn drizzle_hash(sql: &str) -> String {
  hex::encode(Sha256::digest(sql.as_bytes()))
}

async fn stamp(dest: &Path, count: usize) -> Result<usize> {
  let mut conn = SqliteConnectOptions::new().filename(dest).connect().await?;
  conn.ensure_migrations_table().await?;
  let mut tx = conn.begin().await?;
  sqlx::query("DROP TABLE IF EXISTS __drizzle_migrations").execute(&mut *tx).await?;
  for migration in MIGRATOR.iter().take(count) {
    // Same row sqlx writes for a migration it ran itself.
    sqlx::query(
      "INSERT INTO _sqlx_migrations (version, description, success, checksum, execution_time)
       VALUES (?1, ?2, TRUE, ?3, -1)",
    )
    .bind(migration.version)
    .bind(&*migration.description)
    .bind(&*migration.checksum)
    .execute(&mut *tx)
    .await?;
  }
  tx.commit().await?;
  conn.close().await?;
  Ok(count)
}

#[cfg(test)]
mod tests {
  use super::*;
  use sqlx::SqliteConnection;

  use crate::db::{applied_migrations, models::EnvironmentSettings, open};

  /// Builds a database the way Drizzle would have, with the first `count` migrations.
  async fn drizzle_db(path: &Path, count: usize) -> SqliteConnection {
    let mut conn = SqliteConnectOptions::new().filename(path).create_if_missing(true).connect().await.unwrap();
    sqlx::query("CREATE TABLE __drizzle_migrations (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric)")
      .execute(&mut conn)
      .await
      .unwrap();
    for migration in MIGRATOR.iter().take(count) {
      sqlx::raw_sql(&migration.sql).execute(&mut conn).await.unwrap();
      sqlx::query("INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, 0)")
        .bind(drizzle_hash(&migration.sql))
        .execute(&mut conn)
        .await
        .unwrap();
    }
    conn
  }

  #[tokio::test]
  async fn imports_and_keeps_rows() {
    let dir = tempfile::tempdir().unwrap();
    let (source, dest) = (dir.path().join("local.db"), dir.path().join("singl.db"));
    let mut conn = drizzle_db(&source, DRIZZLE_MIGRATIONS).await;
    sqlx::query("INSERT INTO environment_settings (environment, twxBaseUrl, createdAt) VALUES ('dev', 'https://x', 1)")
      .execute(&mut conn)
      .await
      .unwrap();
    conn.close().await.unwrap();

    let report = import_drizzle(&source, &dest).await.unwrap();
    assert_eq!(report.stamped, DRIZZLE_MIGRATIONS);

    let pool = open(&dest).await.unwrap();
    assert_eq!(applied_migrations(&pool).await.unwrap().len(), MIGRATOR.iter().count());
    let env: EnvironmentSettings = sqlx::query_as("SELECT * FROM environment_settings").fetch_one(&pool).await.unwrap();
    assert_eq!((env.environment.as_str(), env.enabled), ("dev", true));
  }

  #[tokio::test]
  async fn partially_migrated_source_catches_up() {
    let dir = tempfile::tempdir().unwrap();
    let (source, dest) = (dir.path().join("local.db"), dir.path().join("singl.db"));
    drizzle_db(&source, 15).await.close().await.unwrap();

    assert_eq!(import_drizzle(&source, &dest).await.unwrap().stamped, 15);
    let pool = open(&dest).await.unwrap();
    assert_eq!(applied_migrations(&pool).await.unwrap().len(), MIGRATOR.iter().count());
  }

  #[tokio::test]
  async fn refuses_existing_dest() {
    let dir = tempfile::tempdir().unwrap();
    let (source, dest) = (dir.path().join("local.db"), dir.path().join("singl.db"));
    drizzle_db(&source, 1).await.close().await.unwrap();
    std::fs::write(&dest, b"").unwrap();
    assert!(matches!(import_drizzle(&source, &dest).await, Err(CoreError::Invalid(_))));
  }

  /// Runs against a real singl-web database:
  /// `SINGL_LEGACY_DB=C:/…/singl-web/local.db cargo test -p singl-core -- --ignored`
  #[tokio::test]
  #[ignore]
  async fn imports_real_legacy_db() {
    let source = std::path::PathBuf::from(std::env::var("SINGL_LEGACY_DB").expect("SINGL_LEGACY_DB"));
    let dir = tempfile::tempdir().unwrap();
    let dest = dir.path().join("singl.db");
    import_drizzle(&source, &dest).await.unwrap();
    let pool = open(&dest).await.unwrap();
    use crate::db::models::*;
    macro_rules! decode_all {
      ($($ty:ty => $table:literal),* $(,)?) => {$(
        let rows: Vec<$ty> = sqlx::query_as(concat!("SELECT * FROM ", $table)).fetch_all(&pool).await
          .unwrap_or_else(|e| panic!("{}: {e}", $table));
        println!("{}: {} rows", $table, rows.len());
      )*};
    }
    decode_all!(
      AppSettings => "app_settings",
      RepoSettings => "repo_settings",
      EnvironmentSettings => "environment_settings",
      TwxProject => "twx_projects",
      FlowFolder => "flow_folders",
      ServiceFlow => "service_flows",
      Notification => "notifications",
      TwxServicePreset => "twx_service_presets",
      AssistantChat => "assistant_chats",
      AssistantSession => "assistant_sessions",
      TodoStatus => "todo_statuses",
      Todo => "todos",
    );
  }
}
