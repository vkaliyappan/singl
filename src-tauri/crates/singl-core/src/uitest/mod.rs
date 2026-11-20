//! UI tests: AI-driven browser test cases, in the Azure DevOps test case layout.
//! `csv` reads and writes Azure's CSV, `session` keeps a saved ThingWorx login
//! per environment, `runner` has the assistant drive Playwright MCP through the steps.

pub mod csv;
pub mod report;
pub mod runner;
pub mod session;

use serde::{Deserialize, Serialize};
use sqlx::{Row, SqlitePool, sqlite::SqliteRow};

use crate::{CoreError, Result};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct UiTestSuite {
  pub id: String,
  pub name: String,
  pub description: String,
  pub env_id: String,
  pub provider: String,
  pub model: String,
  /// `headless` or `headed`.
  pub mode: String,
  /// Filled by list / get, ignored on save.
  pub case_count: i64,
  pub created_at: i64,
  pub updated_at: i64,
}

impl Default for UiTestSuite {
  fn default() -> Self {
    Self {
      id: String::new(),
      name: String::new(),
      description: String::new(),
      env_id: String::new(),
      provider: String::new(),
      model: String::new(),
      mode: "headless".into(),
      case_count: 0,
      created_at: 0,
      updated_at: 0,
    }
  }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct UiTestStep {
  #[serde(default)]
  pub action: String,
  #[serde(default)]
  pub expected: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct UiStepResult {
  pub step: i64,
  /// `passed`, `failed` or `skipped`.
  pub status: String,
  #[serde(default)]
  pub note: String,
  /// Absolute path of the screenshot taken after this step; empty if none.
  #[serde(default)]
  pub screenshot: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct UiTestCase {
  /// Empty for a new case on save.
  pub id: String,
  pub suite_id: String,
  pub position: i64,
  pub ado_id: Option<i64>,
  pub title: String,
  pub area_path: String,
  pub assigned_to: String,
  pub state: String,
  pub tags: String,
  /// Empty = the suite's mode.
  pub mode: String,
  pub steps: Vec<UiTestStep>,
  /// `notRun`, `running`, `passed`, `failed`, `needsReview` or `error`.
  pub status: String,
  pub reason: String,
  pub step_results: Vec<UiStepResult>,
  pub chat_id: String,
  pub last_run_at: Option<i64>,
  pub duration_ms: Option<i64>,
  pub updated_at: i64,
}

impl Default for UiTestCase {
  fn default() -> Self {
    Self {
      id: String::new(),
      suite_id: String::new(),
      position: 0,
      ado_id: None,
      title: String::new(),
      area_path: String::new(),
      assigned_to: String::new(),
      state: String::new(),
      tags: String::new(),
      mode: String::new(),
      steps: Vec::new(),
      status: "notRun".into(),
      reason: String::new(),
      step_results: Vec::new(),
      chat_id: String::new(),
      last_run_at: None,
      duration_ms: None,
      updated_at: 0,
    }
  }
}

#[derive(Debug, Clone, Serialize)]
pub struct SuiteDetail {
  pub suite: UiTestSuite,
  pub cases: Vec<UiTestCase>,
}

/// Milliseconds since the epoch.
pub fn now_ms() -> i64 {
  std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

fn invalid(msg: &str) -> CoreError {
  CoreError::Invalid(msg.into())
}

// ---- suites -----------------------------------------------------------------

const SUITE_SELECT: &str = "SELECT s.id, s.name, s.description, s.envId, s.provider, s.model, s.mode, s.createdAt, s.updatedAt,
  (SELECT COUNT(*) FROM ui_test_cases c WHERE c.suiteId = s.id) AS caseCount FROM ui_test_suites s";

fn suite_row(r: &SqliteRow) -> UiTestSuite {
  UiTestSuite {
    id: r.get("id"),
    name: r.get("name"),
    description: r.get("description"),
    env_id: r.get("envId"),
    provider: r.get("provider"),
    model: r.get("model"),
    mode: r.get("mode"),
    case_count: r.get("caseCount"),
    created_at: r.get("createdAt"),
    updated_at: r.get("updatedAt"),
  }
}

pub async fn list_suites(pool: &SqlitePool) -> Result<Vec<UiTestSuite>> {
  let rows = sqlx::query(&format!("{SUITE_SELECT} ORDER BY s.name COLLATE NOCASE, s.createdAt")).fetch_all(pool).await?;
  Ok(rows.iter().map(suite_row).collect())
}

pub async fn get_suite(pool: &SqlitePool, id: &str) -> Result<UiTestSuite> {
  let row = sqlx::query(&format!("{SUITE_SELECT} WHERE s.id = ?1")).bind(id).fetch_optional(pool).await?;
  row.as_ref().map(suite_row).ok_or_else(|| CoreError::NotFound(format!("No UI test suite \"{id}\".")))
}

pub async fn get_detail(pool: &SqlitePool, id: &str) -> Result<SuiteDetail> {
  Ok(SuiteDetail { suite: get_suite(pool, id).await?, cases: list_cases(pool, id).await? })
}

/// Creates (empty `id`) or updates a suite and returns it as stored.
pub async fn save_suite(pool: &SqlitePool, mut suite: UiTestSuite) -> Result<UiTestSuite> {
  suite.name = suite.name.trim().to_string();
  if suite.name.is_empty() {
    return Err(invalid("A suite needs a name."));
  }
  if suite.mode != "headed" {
    suite.mode = "headless".into();
  }
  let at = super::db::now();
  if suite.id.trim().is_empty() {
    suite.id = uuid::Uuid::new_v4().to_string();
    sqlx::query(
      "INSERT INTO ui_test_suites (id, name, description, envId, provider, model, mode, createdAt, updatedAt)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)",
    )
    .bind(&suite.id)
    .bind(&suite.name)
    .bind(&suite.description)
    .bind(&suite.env_id)
    .bind(&suite.provider)
    .bind(&suite.model)
    .bind(&suite.mode)
    .bind(at)
    .execute(pool)
    .await?;
  } else {
    let done = sqlx::query(
      "UPDATE ui_test_suites SET name = ?2, description = ?3, envId = ?4, provider = ?5, model = ?6, mode = ?7, updatedAt = ?8 WHERE id = ?1",
    )
    .bind(&suite.id)
    .bind(&suite.name)
    .bind(&suite.description)
    .bind(&suite.env_id)
    .bind(&suite.provider)
    .bind(&suite.model)
    .bind(&suite.mode)
    .bind(at)
    .execute(pool)
    .await?;
    if done.rows_affected() == 0 {
      return Err(CoreError::NotFound(format!("No UI test suite \"{}\".", suite.id)));
    }
  }
  get_suite(pool, &suite.id).await
}

/// Deletes a suite and its cases.
pub async fn delete_suite(pool: &SqlitePool, id: &str) -> Result<()> {
  // Explicit, so it does not depend on foreign keys being enforced.
  sqlx::query("DELETE FROM ui_test_cases WHERE suiteId = ?1").bind(id).execute(pool).await?;
  sqlx::query("DELETE FROM ui_test_suites WHERE id = ?1").bind(id).execute(pool).await?;
  Ok(())
}

// ---- cases ------------------------------------------------------------------

fn case_row(r: &SqliteRow) -> UiTestCase {
  let steps: String = r.get("steps");
  let results: String = r.get("stepResults");
  UiTestCase {
    id: r.get("id"),
    suite_id: r.get("suiteId"),
    position: r.get("position"),
    ado_id: r.get("adoId"),
    title: r.get("title"),
    area_path: r.get("areaPath"),
    assigned_to: r.get("assignedTo"),
    state: r.get("state"),
    tags: r.get("tags"),
    mode: r.get("mode"),
    steps: serde_json::from_str(&steps).unwrap_or_default(),
    status: r.get("status"),
    reason: r.get("reason"),
    step_results: serde_json::from_str(&results).unwrap_or_default(),
    chat_id: r.get("chatId"),
    last_run_at: r.get("lastRunAt"),
    duration_ms: r.get("durationMs"),
    updated_at: r.get("updatedAt"),
  }
}

pub async fn list_cases(pool: &SqlitePool, suite_id: &str) -> Result<Vec<UiTestCase>> {
  let rows = sqlx::query("SELECT * FROM ui_test_cases WHERE suiteId = ?1 ORDER BY position, rowid").bind(suite_id).fetch_all(pool).await?;
  Ok(rows.iter().map(case_row).collect())
}

/// Replaces a suite's cases with `cases` (position = index). A case that keeps
/// its id keeps its last run; one whose title or steps changed goes back to `notRun`.
pub async fn save_cases(pool: &SqlitePool, suite_id: &str, cases: Vec<UiTestCase>) -> Result<Vec<UiTestCase>> {
  get_suite(pool, suite_id).await?;
  let existing = list_cases(pool, suite_id).await?;
  let at = super::db::now();
  let mut tx = pool.begin().await?;
  let keep: Vec<&str> = cases.iter().map(|c| c.id.as_str()).filter(|i| !i.is_empty()).collect();
  for old in existing.iter().filter(|o| !keep.contains(&o.id.as_str())) {
    sqlx::query("DELETE FROM ui_test_cases WHERE id = ?1").bind(&old.id).execute(&mut *tx).await?;
  }
  for (i, mut c) in cases.into_iter().enumerate() {
    c.title = c.title.trim().to_string();
    if c.title.is_empty() {
      return Err(invalid("A test case needs a title."));
    }
    if c.mode != "headless" && c.mode != "headed" {
      c.mode.clear();
    }
    let steps = serde_json::to_string(&c.steps).unwrap_or_else(|_| "[]".into());
    let old = existing.iter().find(|o| !c.id.is_empty() && o.id == c.id);
    match old {
      Some(old) => {
        let changed = old.title != c.title || old.steps != c.steps;
        let (status, reason, results) = if changed {
          ("notRun".to_string(), String::new(), "[]".to_string())
        } else {
          (old.status.clone(), old.reason.clone(), serde_json::to_string(&old.step_results).unwrap_or_else(|_| "[]".into()))
        };
        sqlx::query(
          "UPDATE ui_test_cases SET position = ?2, adoId = ?3, title = ?4, areaPath = ?5, assignedTo = ?6, state = ?7,
             tags = ?8, mode = ?9, steps = ?10, status = ?11, reason = ?12, stepResults = ?13, updatedAt = ?14 WHERE id = ?1",
        )
        .bind(&old.id)
        .bind(i as i64)
        .bind(c.ado_id)
        .bind(&c.title)
        .bind(&c.area_path)
        .bind(&c.assigned_to)
        .bind(&c.state)
        .bind(&c.tags)
        .bind(&c.mode)
        .bind(&steps)
        .bind(&status)
        .bind(&reason)
        .bind(&results)
        .bind(at)
        .execute(&mut *tx)
        .await?;
      }
      None => {
        let id = if c.id.is_empty() { uuid::Uuid::new_v4().to_string() } else { c.id.clone() };
        sqlx::query(
          "INSERT INTO ui_test_cases (id, suiteId, position, adoId, title, areaPath, assignedTo, state, tags, mode, steps, updatedAt)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
        )
        .bind(&id)
        .bind(suite_id)
        .bind(i as i64)
        .bind(c.ado_id)
        .bind(&c.title)
        .bind(&c.area_path)
        .bind(&c.assigned_to)
        .bind(&c.state)
        .bind(&c.tags)
        .bind(&c.mode)
        .bind(&steps)
        .bind(at)
        .execute(&mut *tx)
        .await?;
      }
    }
  }
  sqlx::query("UPDATE ui_test_suites SET updatedAt = ?2 WHERE id = ?1").bind(suite_id).bind(at).execute(&mut *tx).await?;
  tx.commit().await?;
  list_cases(pool, suite_id).await
}

/// What a run learned about one case.
pub struct CaseResult<'a> {
  pub status: &'a str,
  pub reason: &'a str,
  pub step_results: &'a [UiStepResult],
  pub chat_id: &'a str,
  pub last_run_at: Option<i64>,
  pub duration_ms: Option<i64>,
}

/// Stores a case's run fields (a `running` mark or a verdict).
pub async fn set_case_result(pool: &SqlitePool, case_id: &str, r: &CaseResult<'_>) -> Result<()> {
  sqlx::query(
    "UPDATE ui_test_cases SET status = ?2, reason = ?3, stepResults = ?4,
       chatId = CASE WHEN ?5 = '' THEN chatId ELSE ?5 END,
       lastRunAt = COALESCE(?6, lastRunAt), durationMs = COALESCE(?7, durationMs) WHERE id = ?1",
  )
  .bind(case_id)
  .bind(r.status)
  .bind(r.reason)
  .bind(serde_json::to_string(r.step_results).unwrap_or_else(|_| "[]".into()))
  .bind(r.chat_id)
  .bind(r.last_run_at)
  .bind(r.duration_ms)
  .execute(pool)
  .await?;
  Ok(())
}

// ---- CSV --------------------------------------------------------------------

fn from_csv(c: csv::CsvCase) -> UiTestCase {
  UiTestCase {
    ado_id: c.ado_id,
    title: c.title,
    area_path: c.area_path,
    assigned_to: c.assigned_to,
    state: c.state,
    tags: c.tags,
    steps: c.steps.into_iter().map(|s| UiTestStep { action: s.action, expected: s.expected }).collect(),
    ..Default::default()
  }
}

/// Imports Azure CSV into a suite and returns all its cases. `replace` drops the
/// existing ones; otherwise a case whose Azure id matches an existing one updates it.
pub async fn import_csv(pool: &SqlitePool, suite_id: &str, text: &str, replace: bool) -> Result<Vec<UiTestCase>> {
  let imported = csv::parse_azure_csv(text).map_err(CoreError::Invalid)?;
  if imported.is_empty() {
    return Err(invalid("The CSV has no test cases."));
  }
  let mut cases = if replace { Vec::new() } else { list_cases(pool, suite_id).await? };
  for c in imported {
    let found = c.ado_id.and_then(|a| cases.iter().position(|o| o.ado_id == Some(a)));
    match found {
      Some(i) => {
        let new = from_csv(c);
        let old = &mut cases[i];
        old.title = new.title;
        old.area_path = new.area_path;
        old.assigned_to = new.assigned_to;
        old.state = new.state;
        old.tags = new.tags;
        old.steps = new.steps;
      }
      None => cases.push(from_csv(c)),
    }
  }
  save_cases(pool, suite_id, cases).await
}

/// Azure CSV of a suite's cases (`case_ids` picks some; `None` = all).
pub async fn export_csv(pool: &SqlitePool, suite_id: &str, case_ids: Option<&[String]>) -> Result<String> {
  get_suite(pool, suite_id).await?;
  let cases: Vec<csv::CsvCase> = list_cases(pool, suite_id)
    .await?
    .into_iter()
    .filter(|c| case_ids.is_none_or(|ids| ids.contains(&c.id)))
    .map(|c| csv::CsvCase {
      ado_id: c.ado_id,
      title: c.title,
      area_path: c.area_path,
      assigned_to: c.assigned_to,
      state: c.state,
      tags: c.tags,
      steps: c.steps.into_iter().map(|s| csv::CsvStep { action: s.action, expected: s.expected }).collect(),
    })
    .collect();
  Ok(csv::export_azure_csv(&cases))
}

#[cfg(test)]
mod tests {
  use super::*;

  async fn pool() -> (tempfile::TempDir, SqlitePool) {
    let dir = tempfile::tempdir().unwrap();
    let pool = crate::db::open(&dir.path().join("singl.db")).await.unwrap();
    (dir, pool)
  }

  fn case(title: &str, action: &str) -> UiTestCase {
    UiTestCase { title: title.into(), steps: vec![UiTestStep { action: action.into(), expected: "ok".into() }], ..Default::default() }
  }

  #[tokio::test]
  async fn crud_round_trip_cascade_and_reset() {
    let (_dir, pool) = pool().await;
    let suite = save_suite(&pool, UiTestSuite { name: "Smoke".into(), ..Default::default() }).await.unwrap();
    assert_eq!(suite.mode, "headless");
    let saved = save_cases(&pool, &suite.id, vec![case("A", "open"), case("B", "click")]).await.unwrap();
    assert_eq!(saved.len(), 2);
    assert_eq!(saved[1].position, 1);
    assert_eq!(get_suite(&pool, &suite.id).await.unwrap().case_count, 2);

    let r = CaseResult { status: "passed", reason: "fine", step_results: &[], chat_id: "chat1", last_run_at: Some(5), duration_ms: Some(9) };
    set_case_result(&pool, &saved[0].id, &r).await.unwrap();

    // Unchanged case keeps its run, even if the client sends stale run fields.
    let mut a = saved[0].clone();
    a.status = "notRun".into();
    a.tags = "x".into();
    let mut b = saved[1].clone();
    b.steps[0].action = "click harder".into();
    let after = save_cases(&pool, &suite.id, vec![a, b]).await.unwrap();
    assert_eq!(after[0].status, "passed");
    assert_eq!(after[0].chat_id, "chat1");
    assert_eq!(after[0].tags, "x");
    assert_eq!(after[1].status, "notRun");

    // Changed steps reset a finished case.
    let r = CaseResult { status: "failed", reason: "no", step_results: &[], chat_id: "", last_run_at: None, duration_ms: None };
    set_case_result(&pool, &after[1].id, &r).await.unwrap();
    let mut a = after[0].clone();
    a.steps.push(UiTestStep { action: "more".into(), expected: String::new() });
    let again = save_cases(&pool, &suite.id, vec![a, list_cases(&pool, &suite.id).await.unwrap()[1].clone()]).await.unwrap();
    assert_eq!(again[0].status, "notRun");
    assert_eq!(again[1].status, "failed");

    // Dropping a case from the list deletes it.
    let one = save_cases(&pool, &suite.id, vec![again[0].clone()]).await.unwrap();
    assert_eq!(one.len(), 1);

    delete_suite(&pool, &suite.id).await.unwrap();
    assert!(list_suites(&pool).await.unwrap().is_empty());
    let left: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM ui_test_cases").fetch_one(&pool).await.unwrap();
    assert_eq!(left, 0);
  }

  #[tokio::test]
  async fn csv_import_matches_ado_id_and_exports() {
    let (_dir, pool) = pool().await;
    let suite = save_suite(&pool, UiTestSuite { name: "S".into(), ..Default::default() }).await.unwrap();
    let csv1 = "ID,Work Item Type,Title,Test Step,Step Action,Step Expected,Area Path,Assigned To,State,Tags\n\
                42,Test Case,Login,,,,Proj,me,Design,t1\n,,,1,Open page,Page shows,,,,\n";
    let all = import_csv(&pool, &suite.id, csv1, false).await.unwrap();
    assert_eq!(all.len(), 1);
    assert_eq!(all[0].ado_id, Some(42));
    assert_eq!(all[0].steps[0].action, "Open page");
    let csv2 = csv1.replace("Login", "Login v2");
    let all = import_csv(&pool, &suite.id, &csv2, false).await.unwrap();
    assert_eq!(all.len(), 1);
    assert_eq!(all[0].title, "Login v2");
    assert_eq!(all[0].id, all[0].id);
    let out = export_csv(&pool, &suite.id, None).await.unwrap();
    assert!(out.contains("Login v2"));
    assert!(export_csv(&pool, &suite.id, Some(&[])).await.unwrap().lines().count() <= 1);
    let replaced = import_csv(&pool, &suite.id, csv1, true).await.unwrap();
    assert_eq!(replaced.len(), 1);
    assert_eq!(replaced[0].title, "Login");
  }
}
