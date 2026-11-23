//! Assistant tools for App Tests: AI-driven browser tests of ThingWorx mashups,
//! kept as Azure DevOps test cases. Logging in to ThingWorx stays a human step.

use std::path::PathBuf;
use std::sync::Arc;

use serde_json::{Value, json};
use sqlx::SqlitePool;

use super::{Args, Risk, Tool, schema, ser, tool};
use crate::assistant::Assistant;
use crate::automation::list_runs;
use crate::uitest::{self, UiTestCase, UiTestStep, UiTestSuite, runner, session};
use crate::{CoreError, Result};

const AUTHORING: &str = "Write GOOD cases: one behaviour per case; open the mashup by name or URL path in the first step \
  (e.g. \"Open /Thingworx/Runtime/index.html#mashup=MyMashup\"); put test data in the step text (\"Type 'PUMP-01' in the Asset filter\"); \
  give every step a concrete, checkable Expected (visible text, row count, a field's value, a button enabled/disabled, no error toast) \
  and never a vague \"verify it works\". Inspect the mashup first (twx tools) so names and labels are real.";

const LOGIN_NOTE: &str = "Logging in to ThingWorx (SSO/MFA) cannot be done by a tool: if the session is missing or expired, \
  ask the user to log in on the App Tests page (Session chip, then Log in).";

fn invalid(msg: impl Into<String>) -> CoreError {
  CoreError::Invalid(msg.into())
}

/// A suite by id or (case-insensitive) name.
async fn find_suite(pool: &SqlitePool, key: &str) -> Result<UiTestSuite> {
  let all = uitest::list_suites(pool).await?;
  all
    .iter()
    .find(|s| s.id == key)
    .or_else(|| all.iter().find(|s| s.name.eq_ignore_ascii_case(key)))
    .cloned()
    .ok_or_else(|| CoreError::NotFound(format!("No App Tests suite \"{key}\". Use apptests_suites_list.")))
}

/// The environment's stored name, matched case-insensitively.
async fn find_env(pool: &SqlitePool, name: &str) -> Result<String> {
  let names: Vec<(String,)> = sqlx::query_as("SELECT environment FROM environment_settings ORDER BY id").fetch_all(pool).await?;
  names
    .iter()
    .find(|(n,)| n.eq_ignore_ascii_case(name))
    .map(|(n,)| n.clone())
    .ok_or_else(|| invalid(format!("Unknown environment \"{name}\". Known: {}.", names.iter().map(|(n,)| n.as_str()).collect::<Vec<_>>().join(", "))))
}

fn mode_of(v: &str, allow_empty: bool) -> Result<String> {
  match v.trim().to_lowercase().as_str() {
    "headless" => Ok("headless".into()),
    "headed" => Ok("headed".into()),
    "" if allow_empty => Ok(String::new()),
    _ => Err(invalid("mode must be \"headless\" or \"headed\".")),
  }
}

/// Steps as `[{action, expected}]`; a bare string is an action with no expected result.
fn parse_steps(v: &Value) -> Result<Vec<UiTestStep>> {
  let list = v.as_array().ok_or_else(|| invalid("steps must be an array of {action, expected}."))?;
  list
    .iter()
    .map(|s| match s {
      Value::String(a) => Ok(UiTestStep { action: a.trim().into(), expected: String::new() }),
      Value::Object(_) => {
        let get = |k: &str| s.get(k).and_then(Value::as_str).unwrap_or("").trim().to_string();
        let step = UiTestStep { action: get("action"), expected: get("expected") };
        if step.action.is_empty() {
          Err(invalid("Every step needs an action."))
        } else {
          Ok(step)
        }
      }
      _ => Err(invalid("steps must be an array of {action, expected}.")),
    })
    .collect()
}

/// Sets the case fields present in `v` (optional text fields, steps, mode).
fn apply_fields(c: &mut UiTestCase, v: &Value) -> Result<()> {
  let text = |key: &str| v.get(key).and_then(Value::as_str).map(|s| s.trim().to_string());
  if let Some(t) = text("title") {
    c.title = t;
  }
  if let Some(t) = text("areaPath") {
    c.area_path = t;
  }
  if let Some(t) = text("assignedTo") {
    c.assigned_to = t;
  }
  if let Some(t) = text("state") {
    c.state = t;
  }
  if let Some(t) = v.get("tags") {
    c.tags = match t {
      Value::Array(a) => a.iter().filter_map(Value::as_str).collect::<Vec<_>>().join("; "),
      other => other.as_str().unwrap_or("").trim().to_string(),
    };
  }
  if let Some(m) = v.get("mode").and_then(Value::as_str) {
    c.mode = mode_of(m, true)?;
  }
  if let Some(s) = v.get("steps") {
    c.steps = parse_steps(s)?;
  }
  Ok(())
}

fn status_counts(cases: &[UiTestCase]) -> Value {
  let mut m = serde_json::Map::new();
  for c in cases {
    let n = m.get(&c.status).and_then(Value::as_i64).unwrap_or(0);
    m.insert(c.status.clone(), json!(n + 1));
  }
  Value::Object(m)
}

fn case_json(c: &UiTestCase) -> Value {
  json!({
    "id": c.id, "position": c.position, "adoId": c.ado_id, "title": c.title, "areaPath": c.area_path,
    "assignedTo": c.assigned_to, "state": c.state, "tags": c.tags, "mode": c.mode, "steps": c.steps,
    "status": c.status, "reason": c.reason, "stepResults": c.step_results, "lastRunAt": c.last_run_at,
    "durationMs": c.duration_ms,
  })
}

fn suite_json(s: &UiTestSuite) -> Value {
  json!({
    "id": s.id, "name": s.name, "description": s.description, "env": s.env_id, "mode": s.mode,
    "provider": s.provider, "model": s.model, "caseCount": s.case_count,
  })
}

fn host() -> Result<(PathBuf, runner::Emit)> {
  runner::host().ok_or_else(|| invalid("App Tests needs the singl window to be running."))
}

/// The ids of the cases a run should cover, from `cases` (ids), `scope` ("all" | "failed").
fn run_targets(cases: &[UiTestCase], ids: &[String], scope: &str) -> Result<Option<Vec<String>>> {
  if !ids.is_empty() {
    if let Some(bad) = ids.iter().find(|i| !cases.iter().any(|c| &c.id == *i)) {
      return Err(invalid(format!("No case \"{bad}\" in this suite.")));
    }
    return Ok(Some(ids.to_vec()));
  }
  match scope {
    "" | "all" => Ok(None),
    "failed" => {
      let failed: Vec<String> = cases.iter().filter(|c| c.status == "failed" || c.status == "error").map(|c| c.id.clone()).collect();
      if failed.is_empty() { Err(invalid("No failed cases in this suite.")) } else { Ok(Some(failed)) }
    }
    other => Err(invalid(format!("scope must be \"all\" or \"failed\", not \"{other}\"."))),
  }
}

pub fn tools() -> Vec<Tool> {
  let suite_arg = json!({ "type": "string", "description": "Suite id or name from apptests_suites_list." });
  let step_schema = json!({
    "type": "array",
    "description": "Ordered steps. Each: {\"action\": what the tester does, \"expected\": what must be visible/true afterwards}.",
    "items": {
      "type": "object",
      "properties": { "action": { "type": "string" }, "expected": { "type": "string" } },
      "required": ["action"],
    },
  });
  let case_props = json!({
    "title": { "type": "string", "description": "Short, specific: the one behaviour tested, e.g. \"Asset filter narrows the grid to matching rows\"." },
    "steps": step_schema,
    "areaPath": { "type": "string", "description": "Azure Area Path (optional)." },
    "assignedTo": { "type": "string", "description": "Azure Assigned To (optional)." },
    "state": { "type": "string", "description": "Azure state. Default \"Design\"." },
    "tags": { "type": "string", "description": "Azure tags, separated by \"; \"." },
    "mode": { "type": "string", "enum": ["", "headless", "headed"], "description": "Browser mode for this case; empty = the suite's." },
  });

  vec![
    tool(
      "apptests_suites_list",
      "List the App Tests suites (AI-driven browser tests of ThingWorx mashups, in Azure DevOps test case format): id, name, \
       environment, mode, case count and how many cases are passed / failed / notRun etc.",
      schema(json!({}), &[]),
      Risk::Read,
      |a, _, _| async move {
        let pool = a.pool().await;
        let mut out = Vec::new();
        for s in uitest::list_suites(&pool).await? {
          let cases = uitest::list_cases(&pool, &s.id).await?;
          let mut j = suite_json(&s);
          j["statusCounts"] = status_counts(&cases);
          out.push(j);
        }
        ser(&out)
      },
    ),
    tool(
      "apptests_suite_get",
      "One suite with all its cases: Azure fields (title, area path, assigned to, state, tags), steps (action + expected), \
       and the last run's status (notRun, running, passed, failed, needsReview, error), reason and per-step results.",
      schema(json!({ "suite": suite_arg }), &["suite"]),
      Risk::Read,
      |a, args, _| async move {
        let pool = a.pool().await;
        let s = find_suite(&pool, Args(&args).need("suite")?).await?;
        let cases = uitest::list_cases(&pool, &s.id).await?;
        ser(&json!({ "suite": suite_json(&s), "cases": cases.iter().map(case_json).collect::<Vec<_>>() }))
      },
    ),
    tool(
      "apptests_suite_save",
      "Create or update a suite's settings. Pass `suite` (id or name) to update, omit it to create (then `name` is required). \
       `env` is an environment NAME from twx_list_environments; the suite's tests run against that ThingWorx server.",
      schema(
        json!({
          "suite": { "type": "string", "description": "Existing suite id or name to update; omit to create." },
          "name": { "type": "string" },
          "description": { "type": "string" },
          "env": { "type": "string", "description": "Environment name from Settings." },
          "mode": { "type": "string", "enum": ["headless", "headed"], "description": "Default headless." },
          "provider": { "type": "string", "description": "AI provider that drives the browser; empty = the app default." },
          "model": { "type": "string", "description": "Model; empty = the provider's default." },
        }),
        &[],
      ),
      Risk::Write,
      |a, args, _| async move {
        let x = Args(&args);
        let pool = a.pool().await;
        let mut s = match x.str("suite") {
          Some(key) => find_suite(&pool, key).await?,
          None => {
            if x.str("name").is_none() {
              return Err(invalid("A new suite needs a name."));
            }
            UiTestSuite::default()
          }
        };
        if let Some(v) = x.str("name") {
          s.name = v.into();
        }
        if let Some(v) = args.get("description").and_then(Value::as_str) {
          s.description = v.trim().into();
        }
        if let Some(v) = x.str("env") {
          s.env_id = find_env(&pool, v).await?;
        }
        if let Some(v) = x.str("mode") {
          s.mode = mode_of(v, false)?;
        }
        if let Some(v) = args.get("provider").and_then(Value::as_str) {
          s.provider = v.trim().into();
        }
        if let Some(v) = args.get("model").and_then(Value::as_str) {
          s.model = v.trim().into();
        }
        let saved = uitest::save_suite(&pool, s).await?;
        runner::notify_changed(&saved.id);
        ser(&suite_json(&saved))
      },
    ),
    tool(
      "apptests_cases_add",
      &format!(
        "Append test cases to a suite and return their new ids. {AUTHORING} Example case: title \"Filter by asset name\", steps \
         [{{\"action\":\"Open /Thingworx/Runtime/index.html#mashup=AssetListMashup\",\"expected\":\"The Assets grid shows at least 10 rows\"}}, \
         {{\"action\":\"Type 'PUMP-01' in the Asset filter box and press Enter\",\"expected\":\"The grid shows only rows whose Name contains PUMP-01; no error toast\"}}]."
      ),
      schema(
        json!({
          "suite": suite_arg,
          "cases": { "type": "array", "description": "Cases to add, in order.", "items": { "type": "object", "properties": case_props.clone(), "required": ["title", "steps"] } },
        }),
        &["suite", "cases"],
      ),
      Risk::Write,
      |a, args, _| async move {
        let pool = a.pool().await;
        let s = find_suite(&pool, Args(&args).need("suite")?).await?;
        let new = args.get("cases").and_then(Value::as_array).filter(|l| !l.is_empty()).ok_or_else(|| invalid("cases must be a non-empty array."))?;
        let mut all = uitest::list_cases(&pool, &s.id).await?;
        let before = all.len();
        for (i, v) in new.iter().enumerate() {
          let mut c = UiTestCase { state: "Design".into(), ..Default::default() };
          apply_fields(&mut c, v)?;
          if c.title.is_empty() {
            return Err(invalid(format!("Case {} needs a title.", i + 1)));
          }
          if c.steps.is_empty() {
            return Err(invalid(format!("Case \"{}\" needs at least one step.", c.title)));
          }
          if c.state.is_empty() {
            c.state = "Design".into();
          }
          all.push(c);
        }
        let saved = uitest::save_cases(&pool, &s.id, all).await?;
        runner::notify_changed(&s.id);
        let added: Vec<Value> = saved.iter().skip(before).map(|c| json!({ "id": c.id, "title": c.title })).collect();
        ser(&json!({ "suite": s.name, "added": added, "totalCases": saved.len() }))
      },
    ),
    tool(
      "apptests_case_update",
      &format!(
        "Change one case by id; only the fields you pass change. `steps` replaces the whole step list. Changing the title or steps \
         resets the case to notRun. {AUTHORING}"
      ),
      schema(
        {
          let mut p = case_props.clone();
          p["id"] = json!({ "type": "string", "description": "Case id from apptests_suite_get." });
          p
        },
        &["id"],
      ),
      Risk::Write,
      |a, args, _| async move {
        let pool = a.pool().await;
        let id = Args(&args).need("id")?;
        let suite_id: Option<(String,)> = sqlx::query_as("SELECT suiteId FROM ui_test_cases WHERE id = ?1").bind(id).fetch_optional(&pool).await?;
        let (suite_id,) = suite_id.ok_or_else(|| CoreError::NotFound(format!("No App Tests case \"{id}\".")))?;
        let mut cases = uitest::list_cases(&pool, &suite_id).await?;
        let c = cases.iter_mut().find(|c| c.id == id).ok_or_else(|| CoreError::NotFound(format!("No App Tests case \"{id}\".")))?;
        apply_fields(c, &args)?;
        if c.title.is_empty() {
          return Err(invalid("A case needs a title."));
        }
        let saved = uitest::save_cases(&pool, &suite_id, cases).await?;
        runner::notify_changed(&suite_id);
        match saved.iter().find(|c| c.id == id) {
          Some(c) => ser(&case_json(c)),
          None => Err(invalid("The case disappeared while saving.")),
        }
      },
    ),
    tool(
      "apptests_cases_delete",
      "Delete cases by id (their last results go too). Check apptests_suite_get first and name the cases to the user.",
      schema(json!({ "ids": { "type": "array", "items": { "type": "string" }, "description": "Case ids." } }), &["ids"]),
      Risk::Destructive,
      |a, args, _| async move {
        let pool = a.pool().await;
        let ids = Args(&args).strings("ids");
        if ids.is_empty() {
          return Err(invalid("ids must be a non-empty array."));
        }
        let mut deleted = 0usize;
        let mut touched: Vec<String> = Vec::new();
        for suite in uitest::list_suites(&pool).await? {
          let cases = uitest::list_cases(&pool, &suite.id).await?;
          if !cases.iter().any(|c| ids.contains(&c.id)) {
            continue;
          }
          let keep: Vec<UiTestCase> = cases.iter().filter(|c| !ids.contains(&c.id)).cloned().collect();
          deleted += cases.len() - keep.len();
          uitest::save_cases(&pool, &suite.id, keep).await?;
          runner::notify_changed(&suite.id);
          touched.push(suite.name);
        }
        ser(&json!({ "deleted": deleted, "notFound": ids.len() - deleted.min(ids.len()), "suites": touched }))
      },
    ),
    tool(
      "apptests_import_csv",
      "Import Azure DevOps test cases from CSV text (columns ID, Work Item Type, Title, Test Step, Step Action, Step Expected, \
       Area Path, Assigned To, State, Tags; any order). `replace` drops the suite's existing cases first; otherwise cases are \
       appended and ones with a matching Azure ID are updated. Returns the number of cases now in the suite.",
      schema(
        json!({
          "suite": suite_arg,
          "csv": { "type": "string", "description": "The CSV text." },
          "replace": { "type": "boolean", "description": "Default false (append)." },
        }),
        &["suite", "csv"],
      ),
      Risk::Write,
      |a, args, _| async move {
        let x = Args(&args);
        let pool = a.pool().await;
        let s = find_suite(&pool, x.need("suite")?).await?;
        let csv = args.get("csv").and_then(Value::as_str).unwrap_or("");
        let all = uitest::import_csv(&pool, &s.id, csv, x.bool("replace").unwrap_or(false)).await?;
        runner::notify_changed(&s.id);
        ser(&json!({ "suite": s.name, "totalCases": all.len() }))
      },
    ),
    tool(
      "apptests_export_csv",
      "Export a suite's cases as Azure DevOps CSV text (Azure columns only; run results are not included).",
      schema(
        json!({
          "suite": suite_arg,
          "caseIds": { "type": "array", "items": { "type": "string" }, "description": "Only these cases. Default: all." },
        }),
        &["suite"],
      ),
      Risk::Read,
      |a, args, _| async move {
        let x = Args(&args);
        let pool = a.pool().await;
        let s = find_suite(&pool, x.need("suite")?).await?;
        let ids = x.strings("caseIds");
        uitest::export_csv(&pool, &s.id, if ids.is_empty() { None } else { Some(&ids) }).await
      },
    ),
    tool(
      "apptests_session_status",
      &format!("Whether a saved ThingWorx browser login exists for an environment and whether it was last found valid. {LOGIN_NOTE}"),
      schema(json!({ "env": { "type": "string", "description": "Environment name. Default: the suite's, if `suite` is given." }, "suite": suite_arg }), &[]),
      Risk::Read,
      |a, args, _| async move {
        let x = Args(&args);
        let pool = a.pool().await;
        let env = match (x.str("env"), x.str("suite")) {
          (Some(e), _) => find_env(&pool, e).await?,
          (None, Some(s)) => find_suite(&pool, s).await?.env_id,
          _ => return Err(invalid("Pass `env` or `suite`.")),
        };
        let (dir, _) = host()?;
        ser(&session::status(&dir, &env, ""))
      },
    ),
    tool(
      "apptests_run",
      &format!(
        "Start a run of a suite's cases in the background and return its runId immediately; poll apptests_run_status. Pick \
         cases by `cases` (ids) or `scope` \"all\" / \"failed\". Each case is executed by an AI driving a real browser against \
         the suite's environment, so it takes minutes and may change server data: only run what the user asked for. Only one run \
         at a time. `mode` overrides headless/headed. {LOGIN_NOTE}"
      ),
      schema(
        json!({
          "suite": suite_arg,
          "cases": { "type": "array", "items": { "type": "string" }, "description": "Case ids to run." },
          "scope": { "type": "string", "enum": ["all", "failed"], "description": "Used when `cases` is empty. Default all." },
          "mode": { "type": "string", "enum": ["headless", "headed"], "description": "Override for this run." },
          "instructions": { "type": "string", "description": "Extra instructions for the test agent, added to every case of this run." },
        }),
        &["suite"],
      ),
      Risk::Write,
      |a: Arc<Assistant>, args, _| async move {
        let x = Args(&args);
        let pool = a.pool().await;
        let s = find_suite(&pool, x.need("suite")?).await?;
        let (dir, emit) = host()?;
        if s.env_id.is_empty() {
          return Err(invalid("This suite has no environment; set one with apptests_suite_save."));
        }
        if !session::status(&dir, &s.env_id, "").exists {
          return Err(invalid(format!("No saved ThingWorx login for {}. Ask the user to log in on the App Tests page (Session chip), then try again.", s.env_id)));
        }
        let cases = uitest::list_cases(&pool, &s.id).await?;
        let ids = run_targets(&cases, &x.strings("cases"), x.str("scope").unwrap_or("all"))?;
        let mode = x.str("mode").map(|m| mode_of(m, false)).transpose()?;
        let total = ids.as_ref().map_or(cases.len(), Vec::len);
        let run_id = runner::start(&a, dir, emit, &s.id, ids, mode, x.str("instructions").unwrap_or_default().to_string()).await?;
        ser(&json!({ "runId": run_id, "suite": s.name, "cases": total, "next": "Poll apptests_run_status." }))
      },
    ),
    tool(
      "apptests_report_generate",
      "Write a unit test document (Word .docx, PDF or Markdown, with screenshots) from a suite's run, to a file path the user        gave. Uses the suite's latest run unless `run` is given. The layout matches the team's unit test documents (info table, expected, summary, one test case table, captioned screenshots, open issues only if something failed) and the text is written as a human tester would write it. Returns the file path(s) written. Ask the user for the folder if they did not name one.",
      schema(
        json!({
          "suite": suite_arg,
          "run": { "type": "string", "description": "Run id from run history. Default: the latest run." },
          "cases": { "type": "array", "items": { "type": "string" }, "description": "Case ids to include. Default: all cases in the run." },
          "format": { "type": "string", "enum": ["docx", "pdf", "md"] },
          "path": { "type": "string", "description": "Absolute path of the file to write, ending in .docx, .pdf or .md." },
          "title": { "type": "string", "description": "Document title. Default: the user story, else the suite name." },
          "preparedBy": { "type": "string", "description": "Name shown as the author." },
          "screenshots": { "type": "string", "enum": ["all", "failed", "none"], "description": "Which step screenshots to include. Default all." },
          "userStory": { "type": "string", "description": "User story shown in the info table, e.g. \"27432 - Feature Group Column\". Optional." },
          "iteration": { "type": "string", "description": "Iteration shown in the info table, e.g. \"1.18\". Optional." },
          "templatePath": { "type": "string", "description": "Absolute path of a .docx whose fonts and styles the Word document reuses (docx only). Default: built-in styles." },
        }),
        &["suite", "format", "path"],
      ),
      Risk::Write,
      |a: Arc<Assistant>, args, _| async move {
        let x = Args(&args);
        let pool = a.pool().await;
        let s = find_suite(&pool, x.need("suite")?).await?;
        let (dir, emit) = host()?;
        let ids = x.strings("cases");
        let req = uitest::report::ReportRequest {
          suite_id: s.id,
          run_id: x.str("run").map(String::from),
          case_ids: if ids.is_empty() { None } else { Some(ids) },
          format: x.need("format")?.to_string(),
          path: x.need("path")?.to_string(),
          title: x.str("title").unwrap_or_default().to_string(),
          prepared_by: x.str("preparedBy").unwrap_or_default().to_string(),
          screenshots: x.str("screenshots").unwrap_or("all").to_string(),
          user_story: x.str("userStory").unwrap_or_default().to_string(),
          iteration: x.str("iteration").unwrap_or_default().to_string(),
          template_path: x.str("templatePath").unwrap_or_default().to_string(),
        };
        ser(&uitest::report::generate(&a, &dir, req, &emit).await?)
      },
    ),
    tool(
      "apptests_run_status",
      "Progress of the run going now (per-case status and reason) or, if none, the suite's last finished run from run history. \
       Case statuses: notRun, running, passed, failed, needsReview, error.",
      schema(json!({ "suite": suite_arg }), &["suite"]),
      Risk::Read,
      |a, args, _| async move {
        let pool = a.pool().await;
        let s = find_suite(&pool, Args(&args).need("suite")?).await?;
        let cases = uitest::list_cases(&pool, &s.id).await?;
        let active = runner::active();
        let running_here = active.as_ref().filter(|(_, sid)| *sid == s.id).map(|(r, _)| r.clone());
        let last = list_runs(&pool, "uitest", Some(&s.id), 1).await?;
        ser(&json!({
          "running": running_here.is_some(),
          "runId": running_here,
          "otherSuiteRunning": active.as_ref().is_some_and(|(_, sid)| *sid != s.id),
          "statusCounts": status_counts(&cases),
          "cases": cases.iter().map(|c| json!({
            "id": c.id, "title": c.title, "status": c.status, "reason": c.reason,
            "failedSteps": c.step_results.iter().filter(|r| r.status == "failed").collect::<Vec<_>>(),
          })).collect::<Vec<_>>(),
          "lastRun": last.first(),
        }))
      },
    ),
  ]
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn steps_accept_objects_and_strings() {
    let s = parse_steps(&json!([{ "action": " Open ", "expected": "Page" }, "Click Save"])).unwrap();
    assert_eq!(s[0], UiTestStep { action: "Open".into(), expected: "Page".into() });
    assert_eq!(s[1].action, "Click Save");
    assert!(parse_steps(&json!([{ "expected": "x" }])).is_err());
    assert!(parse_steps(&json!("nope")).is_err());
  }

  #[test]
  fn fields_patch_only_what_is_given() {
    let mut c = UiTestCase { title: "A".into(), state: "Design".into(), ..Default::default() };
    apply_fields(&mut c, &json!({ "tags": ["a", "b"], "mode": "headed" })).unwrap();
    assert_eq!((c.title.as_str(), c.tags.as_str(), c.mode.as_str()), ("A", "a; b", "headed"));
    assert!(apply_fields(&mut c, &json!({ "mode": "weird" })).is_err());
  }

  #[test]
  fn run_targets_by_ids_and_scope() {
    let mk = |id: &str, st: &str| UiTestCase { id: id.into(), status: st.into(), ..Default::default() };
    let cases = vec![mk("1", "passed"), mk("2", "failed"), mk("3", "error")];
    assert_eq!(run_targets(&cases, &[], "all").unwrap(), None);
    assert_eq!(run_targets(&cases, &[], "failed").unwrap(), Some(vec!["2".into(), "3".into()]));
    assert_eq!(run_targets(&cases, &["1".into()], "").unwrap(), Some(vec!["1".into()]));
    assert!(run_targets(&cases, &["9".into()], "").is_err());
    assert!(run_targets(&cases[..1], &[], "failed").is_err());
  }

  #[test]
  fn tools_are_named_and_risked() {
    let t = tools();
    assert!(t.iter().all(|t| t.spec.name.starts_with("apptests_")));
    let risk = |n: &str| t.iter().find(|t| t.spec.name == n).unwrap().spec.risk;
    assert_eq!(risk("apptests_cases_delete"), Risk::Destructive);
    assert_eq!(risk("apptests_run"), Risk::Write);
    assert_eq!(risk("apptests_run_status"), Risk::Read);
  }
}
