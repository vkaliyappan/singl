//! Assistant tools for the automation feature: test suites, drift reports and schedules.

use serde_json::{Value, json};

use super::{Args, Risk, Tool, schema, ser, tool};
use crate::automation::drift::{self, DriftEntity, DriftRequest};
use crate::automation::schedule::{self, ScheduleInput};
use crate::automation::{list_runs, suites};
use crate::{CoreError, Result};

/// At most this many entities per drift group are listed in a tool result.
const LIST_LIMIT: usize = 40;

fn names(list: &[DriftEntity]) -> Value {
  let shown: Vec<String> = list.iter().take(LIST_LIMIT).map(|e| format!("{}/{} ({})", e.project, e.name, e.entity_type)).collect();
  json!({ "count": list.len(), "shown": shown, "truncated": list.len() > shown.len() })
}

pub fn tools() -> Vec<Tool> {
  let env = json!({ "type": "string", "description": "Environment name from Settings." });

  vec![
    tool(
      "automation_list",
      "The automation page's contents: test suites (id, name, environments, cases and their assertions), schedules \
       (id, name, enabled, repeat, target, last run and status, next run) and the most recent suite runs and drift reports.",
      schema(json!({}), &[]),
      Risk::Read,
      |a, _, _| async move {
        let pool = a.pool().await;
        let suite_rows = suites::list(&pool).await?;
        let schedules = schedule::list(&pool).await?;
        let suite_runs = list_runs(&pool, "suite", None, 10).await?;
        let drift_runs = list_runs(&pool, "drift", None, 10).await?;
        ser(&json!({ "suites": suite_rows, "schedules": schedules, "recentSuiteRuns": suite_runs, "recentDriftReports": drift_runs }))
      },
    ),
    tool(
      "automation_run_suite",
      "Run a test suite: every case calls its ThingWorx service on each environment and its assertions are checked. \
       Services really execute and may change server data, so the user approves each run. Returns pass/fail per case and \
       environment with the actual values; the run is stored in the suite's history.",
      schema(
        json!({
          "suite": { "type": "string", "description": "Suite id or name from automation_list." },
          "envs": { "type": "array", "items": { "type": "string" }, "description": "Environments to run on. Default: the suite's own." },
        }),
        &["suite"],
      ),
      Risk::Destructive,
      |a, args, _| async move {
        let x = Args(&args);
        let pool = a.pool().await;
        let suite = suites::find(&pool, x.need("suite")?).await?;
        let envs = x.strings("envs");
        let run = suites::run(&pool, &suite.id, Some(envs)).await?;
        let results: Vec<Value> = run
          .results
          .iter()
          .map(|r| {
            let failed: Vec<_> = r.checks.iter().filter(|c| !c.passed).collect();
            json!({
              "case": r.case_name, "env": r.env, "passed": r.passed, "durationMs": r.duration_ms,
              "error": r.error, "failedChecks": failed,
            })
          })
          .collect();
        ser(&json!({
          "suite": run.suite_name, "runId": run.run_id, "envs": run.envs, "total": run.total,
          "passed": run.passed, "failed": run.failed, "durationMs": run.duration_ms, "results": results,
        }))
      },
    ),
    tool(
      "automation_drift_report",
      "Compare two ThingWorx environments' entities (read only): which entities exist only in A, only in B, and, with \
       compareXml, which shared ones differ once their exported XML is normalised. Optionally limited to projects. \
       The report is stored on the Automation page.",
      schema(
        json!({
          "envA": env, "envB": env,
          "projects": { "type": "array", "items": { "type": "string" }, "description": "Project names. Default: all projects." },
          "compareXml": { "type": "boolean", "description": "Also compare each shared entity's XML. Slower. Default false." },
        }),
        &["envA", "envB"],
      ),
      Risk::Read,
      |a, args, _| async move {
        let x = Args(&args);
        let req = DriftRequest {
          env_a: x.need("envA")?.into(),
          env_b: x.need("envB")?.into(),
          projects: x.strings("projects"),
          compare_xml: x.bool("compareXml").unwrap_or(false),
        };
        let r = drift::run(&a.pool().await, &req).await?;
        ser(&json!({
          "runId": r.run_id, "summary": r.summary(), "durationMs": r.duration_ms,
          "onlyInA": names(&r.only_a), "onlyInB": names(&r.only_b), "different": names(&r.different),
          "same": r.same.len(), "notCompared": r.unchecked.len(), "warnings": r.warnings,
        }))
      },
    ),
    tool(
      "automation_schedule_upsert",
      "Create or update a schedule that runs a test suite, a drift report, a flow or an assistant prompt while the \
       app is open. Update by id (or by an existing name). The new next run is computed from now.",
      schema(
        json!({
          "id": { "type": "string", "description": "Schedule id from automation_list; omit to create (or update the one with this name)." },
          "name": { "type": "string" },
          "enabled": { "type": "boolean", "description": "Default true." },
          "repeat": {
            "type": "object",
            "description": "{\"type\":\"interval\",\"minutes\":30} | {\"type\":\"daily\",\"time\":\"HH:MM\"} | \
              {\"type\":\"weekly\",\"days\":[1,3],\"time\":\"HH:MM\"} (days 0=Sunday..6=Saturday). Times are in the user's local zone.",
          },
          "target": {
            "type": "object",
            "description": "{\"type\":\"suite\",\"suiteId\":id} | {\"type\":\"drift\",\"envA\":..,\"envB\":..,\"projects\":[..],\"compareXml\":bool} | \
              {\"type\":\"flow\",\"flowId\":id,\"env\":optional} | {\"type\":\"assistant\",\"prompt\":text} (starts a new read-only chat).",
          },
          "utcOffsetMin": { "type": "integer", "description": "Minutes ahead of UTC for daily/weekly times. Default: the zone of existing schedules, else UTC." },
        }),
        &["name", "repeat", "target"],
      ),
      Risk::Write,
      |a, args, _| async move {
        let pool = a.pool().await;
        let mut input: ScheduleInput = serde_json::from_value(args.clone())
          .map_err(|e| CoreError::Invalid(format!("Bad schedule arguments: {e}")))?;
        if input.id.as_deref().is_none_or(str::is_empty) {
          input.id = schedule::find(&pool, &input.name).await.ok().map(|s| s.id);
        }
        let saved: Result<_> = schedule::save(&pool, input).await;
        ser(&saved?)
      },
    ),
  ]
}
