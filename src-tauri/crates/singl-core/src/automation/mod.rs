//! Automation: service test suites, environment drift reports and scheduled
//! tasks. Suites and schedules live in their own tables; every suite run and
//! drift report is kept as a row of `automation_runs` (the last 50 per suite or
//! environment pair).

pub mod assertions;
pub mod drift;
pub mod schedule;
pub mod suites;

use serde::Serialize;
use serde_json::Value;
use sqlx::SqlitePool;

use crate::db::now;
use crate::{CoreError, Result};

/// How a scheduled run ended.
pub struct Outcome {
  pub ok: bool,
  pub message: String,
  /// What `ref_id` points at, for the notification (`suiteRun`, `driftReport`, `flow`, `chat`).
  pub ref_type: String,
  pub ref_id: String,
}

pub const KEEP_RUNS: i64 = 50;

/// One entry of the run history, without its (large) result.
#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
#[sqlx(rename_all = "camelCase")]
#[serde(rename_all = "camelCase")]
pub struct RunRow {
  pub id: String,
  /// `suite` or `drift`.
  pub kind: String,
  pub ref_id: String,
  pub name: String,
  /// `passed`, `failed`, `same` or `drift`.
  pub status: String,
  pub summary: String,
  pub started_at: i64,
  pub duration_ms: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunDetail {
  #[serde(flatten)]
  pub run: RunRow,
  pub result: Value,
}

#[allow(clippy::too_many_arguments)]
/// Stores a run and drops the oldest ones past [`KEEP_RUNS`] for the same `ref_id`.
pub async fn record_run(
  pool: &SqlitePool,
  kind: &str,
  ref_id: &str,
  name: &str,
  status: &str,
  summary: &str,
  result: &Value,
  started_at: i64,
  duration_ms: i64,
) -> Result<String> {
  let id = uuid::Uuid::new_v4().to_string();
  sqlx::query(
    "INSERT INTO automation_runs (id, kind, refId, name, status, summary, result, startedAt, durationMs)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
  )
  .bind(&id)
  .bind(kind)
  .bind(ref_id)
  .bind(name)
  .bind(status)
  .bind(summary)
  .bind(result.to_string())
  .bind(started_at)
  .bind(duration_ms)
  .execute(pool)
  .await?;
  sqlx::query(
    "DELETE FROM automation_runs WHERE kind = ?1 AND refId = ?2 AND id NOT IN
       (SELECT id FROM automation_runs WHERE kind = ?1 AND refId = ?2 ORDER BY startedAt DESC, rowid DESC LIMIT ?3)",
  )
  .bind(kind)
  .bind(ref_id)
  .bind(KEEP_RUNS)
  .execute(pool)
  .await?;
  Ok(id)
}

/// Newest first. `ref_id` narrows to one suite or environment pair.
pub async fn list_runs(pool: &SqlitePool, kind: &str, ref_id: Option<&str>, limit: i64) -> Result<Vec<RunRow>> {
  Ok(
    sqlx::query_as(
      "SELECT id, kind, refId, name, status, summary, startedAt, durationMs FROM automation_runs
       WHERE kind = ?1 AND (?2 IS NULL OR refId = ?2) ORDER BY startedAt DESC, rowid DESC LIMIT ?3",
    )
    .bind(kind)
    .bind(ref_id)
    .bind(limit)
    .fetch_all(pool)
    .await?,
  )
}

pub async fn get_run(pool: &SqlitePool, id: &str) -> Result<RunDetail> {
  let row: Option<RunRow> =
    sqlx::query_as("SELECT id, kind, refId, name, status, summary, startedAt, durationMs FROM automation_runs WHERE id = ?1")
      .bind(id)
      .fetch_optional(pool)
      .await?;
  let run = row.ok_or_else(|| CoreError::NotFound("That run is no longer in the history.".into()))?;
  let text: String = sqlx::query_scalar("SELECT result FROM automation_runs WHERE id = ?1").bind(id).fetch_one(pool).await?;
  Ok(RunDetail { run, result: serde_json::from_str(&text).unwrap_or(Value::Null) })
}

pub async fn delete_run(pool: &SqlitePool, id: &str) -> Result<()> {
  sqlx::query("DELETE FROM automation_runs WHERE id = ?1").bind(id).execute(pool).await?;
  Ok(())
}

/// Adds a row to the `notifications` table.
pub async fn notify(pool: &SqlitePool, title: &str, body: &str, url: &str, ref_type: &str, ref_id: &str) -> Result<()> {
  sqlx::query(
    "INSERT INTO notifications (id, title, body, url, tag, refType, refId, createdAt)
     VALUES (?1, ?2, ?3, ?4, 'automation', ?5, ?6, ?7)",
  )
  .bind(uuid::Uuid::new_v4().to_string())
  .bind(title)
  .bind(body)
  .bind(url)
  .bind(ref_type)
  .bind(ref_id)
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
  async fn keeps_the_last_fifty_runs_per_ref() {
    let dir = tempfile::tempdir().unwrap();
    let pool = open(&dir.path().join("t.db")).await.unwrap();
    for i in 0..55 {
      record_run(&pool, "suite", "s1", "S", "passed", &format!("run {i}"), &Value::Null, 1000 + i, 1).await.unwrap();
    }
    record_run(&pool, "suite", "s2", "S2", "failed", "other", &Value::Null, 1, 1).await.unwrap();
    let runs = list_runs(&pool, "suite", Some("s1"), 100).await.unwrap();
    assert_eq!(runs.len(), 50);
    assert_eq!(runs[0].summary, "run 54");
    assert_eq!(runs[49].summary, "run 5");
    assert_eq!(list_runs(&pool, "suite", Some("s2"), 100).await.unwrap().len(), 1);
    let detail = get_run(&pool, &runs[0].id).await.unwrap();
    assert_eq!(detail.run.status, "passed");
  }
}
