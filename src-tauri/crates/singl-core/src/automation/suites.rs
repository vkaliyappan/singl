//! Test suites: saved service calls with assertions, run across environments.

use std::time::Instant;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::SqlitePool;

use super::assertions::{Assertion, Check, Observation, evaluate};
use super::{Outcome, record_run};
use crate::db::now;
use crate::twx::api::collection_name;
use crate::twx::projects;
use crate::{CoreError, Result};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Case {
  #[serde(default)]
  pub id: String,
  pub name: String,
  /// Run only on these environments; empty = every environment the suite runs on.
  #[serde(default)]
  pub envs: Vec<String>,
  /// `Things`, `ThingTemplates`, `Resources`, … (or the singular type).
  pub collection: String,
  pub entity: String,
  pub service: String,
  #[serde(default = "empty_object")]
  pub inputs: Value,
  #[serde(default)]
  pub assertions: Vec<Assertion>,
}

fn empty_object() -> Value {
  json!({})
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Suite {
  pub id: String,
  pub name: String,
  #[serde(default)]
  pub description: String,
  /// Environments the suite runs on by default.
  #[serde(default)]
  pub envs: Vec<String>,
  #[serde(default)]
  pub cases: Vec<Case>,
  #[serde(default)]
  pub created_at: i64,
  #[serde(default)]
  pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaseResult {
  pub case_id: String,
  pub case_name: String,
  pub env: String,
  pub passed: bool,
  pub duration_ms: u64,
  pub error: Option<String>,
  pub checks: Vec<Check>,
  /// The reply, cut to a few KB.
  pub output: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SuiteRun {
  pub run_id: String,
  pub suite_id: String,
  pub suite_name: String,
  pub started_at: i64,
  pub duration_ms: u64,
  pub envs: Vec<String>,
  pub total: usize,
  pub passed: usize,
  pub failed: usize,
  pub results: Vec<CaseResult>,
}

const OUTPUT_LIMIT: usize = 4000;

type Row = (String, String, String, String, String, i64, i64);

fn suite_of(r: Row) -> Suite {
  Suite {
    id: r.0,
    name: r.1,
    description: r.2,
    envs: serde_json::from_str(&r.3).unwrap_or_default(),
    cases: serde_json::from_str(&r.4).unwrap_or_default(),
    created_at: r.5,
    updated_at: r.6,
  }
}

const COLUMNS: &str = "id, name, description, envs, cases, createdAt, updatedAt";

pub async fn list(pool: &SqlitePool) -> Result<Vec<Suite>> {
  let rows: Vec<Row> =
    sqlx::query_as(&format!("SELECT {COLUMNS} FROM automation_suites ORDER BY name COLLATE NOCASE")).fetch_all(pool).await?;
  Ok(rows.into_iter().map(suite_of).collect())
}

pub async fn get(pool: &SqlitePool, id: &str) -> Result<Suite> {
  let row: Option<Row> =
    sqlx::query_as(&format!("SELECT {COLUMNS} FROM automation_suites WHERE id = ?1")).bind(id).fetch_optional(pool).await?;
  row.map(suite_of).ok_or_else(|| CoreError::NotFound("That test suite no longer exists.".into()))
}

/// A suite by id, or else by (case-insensitive) name.
pub async fn find(pool: &SqlitePool, id_or_name: &str) -> Result<Suite> {
  if let Ok(s) = get(pool, id_or_name).await {
    return Ok(s);
  }
  list(pool)
    .await?
    .into_iter()
    .find(|s| s.name.eq_ignore_ascii_case(id_or_name.trim()))
    .ok_or_else(|| CoreError::NotFound(format!("No test suite \"{id_or_name}\". Use automation_list to see them.")))
}

/// Creates (empty `id`) or replaces a suite; returns it as stored.
pub async fn save(pool: &SqlitePool, mut suite: Suite) -> Result<Suite> {
  suite.name = suite.name.trim().to_string();
  if suite.name.is_empty() {
    return Err(CoreError::Invalid("Give the suite a name.".into()));
  }
  for c in &mut suite.cases {
    if c.id.is_empty() {
      c.id = uuid::Uuid::new_v4().to_string();
    }
    if !c.inputs.is_object() {
      return Err(CoreError::Invalid(format!("Case \"{}\": inputs must be a JSON object.", c.name)));
    }
  }
  let t = now();
  let envs = serde_json::to_string(&suite.envs).unwrap_or_else(|_| "[]".into());
  let cases = serde_json::to_string(&suite.cases).unwrap_or_else(|_| "[]".into());
  if suite.id.is_empty() {
    suite.id = uuid::Uuid::new_v4().to_string();
    sqlx::query(&format!("INSERT INTO automation_suites ({COLUMNS}) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)"))
      .bind(&suite.id)
      .bind(&suite.name)
      .bind(&suite.description)
      .bind(envs)
      .bind(cases)
      .bind(t)
      .execute(pool)
      .await?;
    suite.created_at = t;
  } else {
    let done = sqlx::query("UPDATE automation_suites SET name = ?2, description = ?3, envs = ?4, cases = ?5, updatedAt = ?6 WHERE id = ?1")
      .bind(&suite.id)
      .bind(&suite.name)
      .bind(&suite.description)
      .bind(envs)
      .bind(cases)
      .bind(t)
      .execute(pool)
      .await?;
    if done.rows_affected() == 0 {
      return Err(CoreError::NotFound("That test suite no longer exists.".into()));
    }
  }
  suite.updated_at = t;
  Ok(suite)
}

pub async fn delete(pool: &SqlitePool, id: &str) -> Result<()> {
  sqlx::query("DELETE FROM automation_suites WHERE id = ?1").bind(id).execute(pool).await?;
  sqlx::query("DELETE FROM automation_runs WHERE kind = 'suite' AND refId = ?1").bind(id).execute(pool).await?;
  Ok(())
}

fn cut(s: &str) -> String {
  if s.len() <= OUTPUT_LIMIT {
    return s.to_string();
  }
  let mut end = OUTPUT_LIMIT;
  while !s.is_char_boundary(end) {
    end -= 1;
  }
  format!("{}…", &s[..end])
}

/// Runs a suite on `envs` (default: the suite's own) and stores the run.
/// Services really execute, so a suite should call only what is safe to repeat.
pub async fn run(pool: &SqlitePool, suite_id: &str, envs: Option<Vec<String>>) -> Result<SuiteRun> {
  let suite = get(pool, suite_id).await?;
  let envs = envs.filter(|e| !e.is_empty()).unwrap_or_else(|| suite.envs.clone());
  if envs.is_empty() {
    return Err(CoreError::Invalid("Choose at least one environment to run the suite on.".into()));
  }
  if suite.cases.is_empty() {
    return Err(CoreError::Invalid("The suite has no test cases yet.".into()));
  }
  let started_at = now();
  let timer = Instant::now();
  let mut results = Vec::new();
  for env in &envs {
    let client = projects::connect(pool, env).await;
    for case in suite.cases.iter().filter(|c| c.envs.is_empty() || c.envs.contains(env)) {
      let call = Instant::now();
      let outcome = match &client {
        Ok(client) => client.execute_service(collection_name(&case.collection), &case.entity, &case.service, &case.inputs).await,
        Err(e) => Err(CoreError::Invalid(e.to_string())),
      };
      let duration_ms = call.elapsed().as_millis() as u64;
      let (error, text) = match outcome {
        Ok(text) => (None, text),
        Err(e) => (Some(e.to_string()), String::new()),
      };
      let assertions = if case.assertions.is_empty() { vec![Assertion::Succeeds] } else { case.assertions.clone() };
      let checks = evaluate(&assertions, &Observation { error: error.as_deref(), text: &text, duration_ms });
      results.push(CaseResult {
        case_id: case.id.clone(),
        case_name: case.name.clone(),
        env: env.clone(),
        passed: error.is_none() && checks.iter().all(|c| c.passed),
        duration_ms,
        error,
        checks,
        output: cut(&text),
      });
    }
  }
  let passed = results.iter().filter(|r| r.passed).count();
  let mut run = SuiteRun {
    run_id: String::new(),
    suite_id: suite.id.clone(),
    suite_name: suite.name.clone(),
    started_at,
    duration_ms: timer.elapsed().as_millis() as u64,
    envs,
    total: results.len(),
    passed,
    failed: results.len() - passed,
    results,
  };
  let summary = format!("{}/{} passed on {}", run.passed, run.total, run.envs.join(", "));
  let status = if run.failed == 0 { "passed" } else { "failed" };
  let result = serde_json::to_value(&run).unwrap_or(Value::Null);
  run.run_id = record_run(pool, "suite", &suite.id, &suite.name, status, &summary, &result, started_at, run.duration_ms as i64).await?;
  Ok(run)
}

/// Runs a suite for a schedule.
pub async fn run_scheduled(pool: &SqlitePool, suite_id: &str) -> Result<Outcome> {
  let run = run(pool, suite_id, None).await?;
  Ok(Outcome {
    ok: run.failed == 0,
    message: format!("{}: {}/{} cases passed", run.suite_name, run.passed, run.total),
    ref_type: "suiteRun".into(),
    ref_id: run.run_id,
  })
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::db::open;

  #[tokio::test]
  async fn saves_finds_and_deletes_suites() {
    let dir = tempfile::tempdir().unwrap();
    let pool = open(&dir.path().join("t.db")).await.unwrap();
    let suite = Suite {
      id: String::new(),
      name: " Smoke ".into(),
      description: String::new(),
      envs: vec!["DEV".into()],
      cases: vec![serde_json::from_value(json!({
        "name": "ping", "collection": "Things", "entity": "T", "service": "Ping",
        "assertions": [{ "type": "succeeds" }, { "type": "rowCount", "op": "gt", "value": 0 }]
      }))
      .unwrap()],
      created_at: 0,
      updated_at: 0,
    };
    let saved = save(&pool, suite).await.unwrap();
    assert_eq!(saved.name, "Smoke");
    assert!(!saved.cases[0].id.is_empty());
    assert_eq!(find(&pool, "smoke").await.unwrap().id, saved.id);
    assert_eq!(get(&pool, &saved.id).await.unwrap().cases[0].assertions.len(), 2);
    // No environment connection is configured, so every case fails with that reason.
    let run = run(&pool, &saved.id, None).await.unwrap();
    assert_eq!((run.total, run.failed), (1, 1));
    assert!(run.results[0].error.as_deref().unwrap().contains("DEV"));
    delete(&pool, &saved.id).await.unwrap();
    assert!(list(&pool).await.unwrap().is_empty());
  }
}
