//! Runs UI test cases: one assistant turn per case, driving Playwright MCP,
//! then a verdict read from the model's answer.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use super::session;
use super::{CaseResult, UiStepResult, UiTestCase, UiTestSuite, now_ms};
use crate::assistant::runner::SendRequest;
use crate::assistant::{ApprovalMode, Assistant, store};
use crate::{CoreError, Result};

/// How long one case may take before it is stopped.
const CASE_TIMEOUT: Duration = Duration::from_secs(20 * 60);
const EXPIRED: &str = "ThingWorx session expired — log in again";

/// Sends a named event with a JSON payload to the window.
pub type Emit = Arc<dyn Fn(&str, Value) + Send + Sync>;

struct Active {
  run_id: String,
  suite_id: String,
  cancel: CancellationToken,
  chat_id: Option<String>,
}

static ACTIVE: Mutex<Option<Active>> = Mutex::new(None);

fn with_active<R>(f: impl FnOnce(&mut Option<Active>) -> R) -> R {
  f(&mut ACTIVE.lock().unwrap_or_else(|e| e.into_inner()))
}

/// Where the app keeps sessions and run output, and how it reaches the window.
/// Set once at startup so assistant tools can start runs and announce changes.
static HOST: Mutex<Option<(PathBuf, Emit)>> = Mutex::new(None);

pub fn set_host(data_dir: PathBuf, emit: Emit) {
  *HOST.lock().unwrap_or_else(|e| e.into_inner()) = Some((data_dir, emit));
}

pub fn host() -> Option<(PathBuf, Emit)> {
  HOST.lock().unwrap_or_else(|e| e.into_inner()).clone()
}

/// Tells the App Tests page that `suite_id` (empty = the suite list) was changed outside it.
pub fn notify_changed(suite_id: &str) {
  if let Some((_, emit)) = host() {
    emit("uitest://changed", serde_json::json!({ "suiteId": suite_id }));
  }
}

/// `(run id, suite id)` of the run going now.
pub fn active() -> Option<(String, String)> {
  with_active(|a| a.as_ref().map(|r| (r.run_id.clone(), r.suite_id.clone())))
}

/// Stops a run: after the case in progress is aborted, no further case starts.
pub fn cancel(a: &Assistant, run_id: &str) -> bool {
  with_active(|cur| match cur.as_ref().filter(|r| r.run_id == run_id) {
    Some(r) => {
      r.cancel.cancel();
      if let Some(chat) = &r.chat_id {
        a.cancel(chat);
      }
      true
    }
    None => false,
  })
}

struct ActiveGuard;

impl Drop for ActiveGuard {
  fn drop(&mut self) {
    with_active(|a| *a = None);
  }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Progress {
  run_id: String,
  suite_id: String,
  case_id: String,
  status: String,
  reason: String,
  step_results: Vec<UiStepResult>,
  chat_id: String,
  index: usize,
  total: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Done {
  run_id: String,
  suite_id: String,
  passed: usize,
  failed: usize,
  total: usize,
  cancelled: bool,
  error: String,
}

// ---- verdict ------------------------------------------------------------------

#[derive(Debug, PartialEq)]
pub struct Verdict {
  /// `passed`, `failed` or `needsReview`.
  pub status: String,
  pub reason: String,
  pub steps: Vec<UiStepResult>,
}

fn verdict_from(v: &Value) -> Option<Verdict> {
  let status = v.get("status")?.as_str()?;
  let status = match status {
    "passed" | "failed" | "needsReview" => status,
    _ => "needsReview",
  };
  let steps = v
    .get("steps")
    .and_then(Value::as_array)
    .map(|a| {
      a.iter()
        .filter_map(|s| {
          let step = s.get("step").and_then(Value::as_i64)?;
          let st = s.get("status").and_then(Value::as_str).unwrap_or("skipped");
          let st = if matches!(st, "passed" | "failed" | "skipped") { st } else { "skipped" };
          Some(UiStepResult { step, status: st.into(), note: s.get("note").and_then(Value::as_str).unwrap_or_default().into(), screenshot: String::new() })
        })
        .collect()
    })
    .unwrap_or_default();
  Some(Verdict { status: status.into(), reason: v.get("reason").and_then(Value::as_str).unwrap_or_default().into(), steps })
}

/// The last JSON object with a `status` in the model's answer (a fenced block first).
/// Anything unreadable is `needsReview`.
pub fn parse_verdict(answer: &str) -> Verdict {
  let mut found: Option<Verdict> = None;
  // Fenced blocks, last wins.
  for part in answer.split("```").skip(1).step_by(2) {
    let body = part.strip_prefix("json").or_else(|| part.strip_prefix("JSON")).unwrap_or(part);
    if let Some(v) = serde_json::from_str::<Value>(body.trim()).ok().as_ref().and_then(verdict_from) {
      found = Some(v);
    }
  }
  if found.is_none() {
    for (i, c) in answer.char_indices() {
      if c != '{' {
        continue;
      }
      if let Some(Ok(v)) = serde_json::Deserializer::from_str(&answer[i..]).into_iter::<Value>().next() {
        if let Some(v) = verdict_from(&v) {
          found = Some(v);
        }
      }
    }
  }
  found.unwrap_or_else(|| Verdict {
    status: "needsReview".into(),
    reason: "The model did not give a readable verdict. Check the chat.".into(),
    steps: Vec::new(),
  })
}

fn build_prompt(base: &str, case: &UiTestCase, case_no: usize) -> String {
  let mut p = format!(
    "You are running one UI test in a real browser with the browser_* tools.\n\
     Application: ThingWorx at {base} (you are already signed in).\n\
     Test case: {}\n\nSteps:\n",
    case.title
  );
  for (i, s) in case.steps.iter().enumerate() {
    p.push_str(&format!("{}. {}\n", i + 1, s.action.trim()));
    if !s.expected.trim().is_empty() {
      p.push_str(&format!("   Expected: {}\n", s.expected.trim()));
    }
  }
  p.push_str(
    "\nHow to run it:\n\
     - The browser stays open between the test cases of this run. If the page is blank, shows something unrelated, or the first step says to open the application, open the application URL above; otherwise continue from the current page.\n\
     - Do the steps in order. Use browser_snapshot to read the page state before and after acting; do not guess what is on screen.\n\
     - Check each expected result against what you actually see. Never invent results.\n\
     - After EVERY step, take a screenshot with browser_take_screenshot (even when the step failed). Set its filename to \"case-CASE-step-N.png\" where N is the step's number from the list above.\n\
     - If a step fails or its expected result is not met, stop at the first hard failure (after its screenshot). Mark the remaining steps skipped.\n\
     - If you cannot tell whether a result is right (unclear, ambiguous), use needsReview and say why.\n\
     - If the page shows a sign-in screen instead of ThingWorx, fail the test and say the session expired.\n\
     \nEnd your reply with exactly one fenced json block:\n\
     ```json\n\
     {\"status\":\"passed|failed|needsReview\",\"reason\":\"one or two sentences\",\"steps\":[{\"step\":1,\"status\":\"passed|failed|skipped\",\"note\":\"what you saw\"}]}\n\
     ```\n",
  );
  p.replace("case-CASE-step-", &format!("case-{case_no}-step-"))
}

/// The folder one case's screenshots go to: `<data>/uitest/runs/<run id>/<case id>/`.
pub fn case_dir(data_dir: &Path, run_id: &str, case_id: &str) -> PathBuf {
  let safe: String = case_id.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' }).collect();
  let dir = session::output_dir(data_dir, run_id).join(safe);
  let _ = std::fs::create_dir_all(&dir);
  dir
}

fn collect_images(dir: &Path, out: &mut Vec<PathBuf>) {
  let Ok(rd) = std::fs::read_dir(dir) else { return };
  for e in rd.flatten() {
    let p = e.path();
    if p.is_dir() {
      collect_images(&p, out);
    } else if matches!(p.extension().and_then(|x| x.to_str()).map(str::to_ascii_lowercase).as_deref(), Some("png" | "jpg" | "jpeg")) {
      out.push(p);
    }
  }
}

/// Every image under `dir` (any depth).
fn images_in(dir: &Path) -> std::collections::BTreeSet<PathBuf> {
  let mut files = Vec::new();
  collect_images(dir, &mut files);
  files.into_iter().collect()
}

/// Screenshot files in `dir` (any depth) by step number: the `step-<n>` in the file name,
/// else, when no name carries one, the order the files were written (1, 2, ...).
pub fn screenshots_by_step(dir: &Path) -> std::collections::BTreeMap<i64, String> {
  let mut files = Vec::new();
  collect_images(dir, &mut files);
  files.sort_by_key(|p| (p.metadata().and_then(|m| m.modified()).ok(), p.clone()));
  let re = regex::Regex::new(r"(?i)step[-_ ]?(\d+)").expect("static regex");
  let mut map = std::collections::BTreeMap::new();
  let mut unnumbered = Vec::new();
  for f in &files {
    let name = f.file_name().and_then(|n| n.to_str()).unwrap_or_default();
    match re.captures(name).and_then(|c| c[1].parse::<i64>().ok()) {
      // A later file for the same step (a retry) replaces the earlier one.
      Some(n) => {
        map.insert(n, f.to_string_lossy().into_owned());
      }
      None => unnumbered.push(f),
    }
  }
  if map.is_empty() {
    for (i, f) in unnumbered.into_iter().enumerate() {
      map.insert(i as i64 + 1, f.to_string_lossy().into_owned());
    }
  }
  map
}

/// Sets each step result's `screenshot` from `shots`.
pub fn attach_screenshots(steps: &mut [UiStepResult], shots: &std::collections::BTreeMap<i64, String>) {
  for s in steps {
    if let Some(p) = shots.get(&s.step) {
      s.screenshot = p.clone();
    }
  }
}

/// Deletes run folders (`<data>/uitest/runs/<run id>`) whose run is no longer in the history.
pub async fn prune_run_dirs(pool: &sqlx::SqlitePool, data_dir: &Path) {
  let Ok(rd) = std::fs::read_dir(data_dir.join("uitest").join("runs")) else { return };
  let kept: Vec<String> = sqlx::query_scalar("SELECT json_extract(result, '$.runId') FROM automation_runs WHERE kind = 'uitest'")
    .fetch_all(pool)
    .await
    .unwrap_or_default();
  let current = active().map(|(r, _)| r);
  for e in rd.flatten() {
    let name = e.file_name().to_string_lossy().into_owned();
    // Only run folders (uuid names); `login` and `check` belong to the session code.
    if e.path().is_dir() && uuid::Uuid::parse_str(&name).is_ok() && !kept.contains(&name) && current.as_deref() != Some(name.as_str()) {
      let _ = std::fs::remove_dir_all(e.path());
    }
  }
}

// ---- running ------------------------------------------------------------------

/// Starts a run in the background and returns its id.
pub async fn start(
  a: &Arc<Assistant>,
  data_dir: PathBuf,
  emit: Emit,
  suite_id: &str,
  case_ids: Option<Vec<String>>,
  mode: Option<String>,
) -> Result<String> {
  let pool = a.pool().await;
  let suite = super::get_suite(&pool, suite_id).await?;
  let mut cases = super::list_cases(&pool, suite_id).await?;
  if let Some(ids) = &case_ids {
    cases.retain(|c| ids.contains(&c.id));
  }
  if cases.is_empty() {
    return Err(CoreError::Invalid("There are no test cases to run.".into()));
  }
  if suite.env_id.trim().is_empty() {
    return Err(CoreError::Invalid("Pick an environment for this suite first.".into()));
  }
  let run_id = uuid::Uuid::new_v4().to_string();
  let cancel = CancellationToken::new();
  with_active(|cur| {
    if cur.is_some() {
      return Err(CoreError::Invalid("A UI test run is already going.".into()));
    }
    *cur = Some(Active { run_id: run_id.clone(), suite_id: suite_id.to_string(), cancel: cancel.clone(), chat_id: None });
    Ok(())
  })?;
  let a = a.clone();
  let id = run_id.clone();
  tokio::spawn(async move {
    let _guard = ActiveGuard;
    run(&a, &data_dir, &emit, &id, suite, cases, mode, cancel).await;
  });
  Ok(run_id)
}

/// The tool names a case's turn may use: the browser's, minus the code-running ones.
async fn browser_tools(a: &Arc<Assistant>, servers: &[crate::assistant::settings::McpServerConfig]) -> Vec<String> {
  a.mcp_clients
    .server_tools(servers)
    .await
    .into_iter()
    .filter(|t| t.server == session::SERVER && !t.original.starts_with("browser_run_code"))
    .map(|t| t.name)
    .collect()
}

#[allow(clippy::too_many_arguments)]
async fn run(
  a: &Arc<Assistant>,
  data_dir: &Path,
  emit: &Emit,
  run_id: &str,
  suite: UiTestSuite,
  cases: Vec<UiTestCase>,
  mode: Option<String>,
  cancel: CancellationToken,
) {
  let pool = a.pool().await;
  let started = Instant::now();
  let started_at = crate::db::now();
  let total = cases.len();
  let (mut passed, mut failed, mut cancelled) = (0usize, 0usize, false);
  let mut fatal = String::new();
  let mut summaries: Vec<Value> = Vec::new();

  let say = |case: &UiTestCase, status: &str, reason: &str, steps: &[UiStepResult], chat_id: &str, index: usize| {
    let p = Progress {
      run_id: run_id.into(),
      suite_id: suite.id.clone(),
      case_id: case.id.clone(),
      status: status.into(),
      reason: reason.into(),
      step_results: steps.to_vec(),
      chat_id: chat_id.into(),
      index,
      total,
    };
    emit("uitest://progress", serde_json::to_value(&p).unwrap_or(Value::Null));
  };

  // One session check per run.
  let session_ok = match session_state(a, data_dir, &suite.env_id).await {
    Ok(ok) => ok,
    Err(e) => {
      fatal = e.to_string();
      false
    }
  };
  let base = session_base(a, &suite.env_id).await.unwrap_or_default();
  let (provider, model) = match models(a, &suite).await {
    Ok(m) => m,
    Err(e) => {
      fatal = e.to_string();
      (String::new(), String::new())
    }
  };

  // One browser for the whole run: cases continue in the same window. It restarts
  // only when a case needs the other headed/headless mode.
  let run_dir = session::output_dir(data_dir, run_id);
  let _ = std::fs::create_dir_all(&run_dir);
  let mut browser: Option<(bool, Vec<crate::assistant::settings::McpServerConfig>)> = None;

  for (i, case) in cases.iter().enumerate() {
    if cancel.is_cancelled() {
      cancelled = true;
      break;
    }
    let case_start = Instant::now();
    let mut chat_id = String::new();
    let (status, reason, steps): (String, String, Vec<UiStepResult>) = 'case: {
      if !fatal.is_empty() {
        break 'case ("error".into(), fatal.clone(), Vec::new());
      }
      if !session_ok {
        break 'case ("error".into(), EXPIRED.into(), Vec::new());
      }
      if case.steps.is_empty() {
        break 'case ("error".into(), "This test case has no steps.".into(), Vec::new());
      }
      match store::create(&pool).await {
        Ok(chat) => chat_id = chat.id,
        Err(e) => break 'case ("error".into(), e.to_string(), Vec::new()),
      }
      with_active(|cur| {
        if let Some(r) = cur {
          r.chat_id = Some(chat_id.clone());
        }
      });
      let _ = super::set_case_result(
        &pool,
        &case.id,
        &CaseResult { status: "running", reason: "", step_results: &[], chat_id: &chat_id, last_run_at: None, duration_ms: None },
      )
      .await;
      say(case, "running", "", &[], &chat_id, i);

      let headless = match mode.as_deref().filter(|m| !m.is_empty()).unwrap_or(if case.mode.is_empty() { &suite.mode } else { &case.mode }) {
        "headed" => false,
        _ => true,
      };
      let shots_dir = case_dir(data_dir, run_id, &case.id);
      if browser.as_ref().is_none_or(|(h, _)| *h != headless) {
        let file = session::session_file(data_dir, &suite.env_id);
        let cfg = session::server_config(&run_dir, Some(&file), headless);
        match session::start_browser(a, cfg).await {
          Ok(s) => browser = Some((headless, s)),
          Err(e) => {
            browser = None;
            break 'case ("error".into(), e.to_string(), Vec::new());
          }
        }
      }
      let servers = browser.as_ref().map(|(_, s)| s.clone()).unwrap_or_default();
      let tools = browser_tools(a, &servers).await;
      let before = images_in(&run_dir);
      let case_started = std::time::SystemTime::now();
      // Absolute screenshot paths: Playwright MCP resolves a bare file name against
      // the workspace root, not its output folder.
      let shot_prefix = format!("case-{}-step-", i + 1);
      let shots_fwd = shots_dir.to_string_lossy().replace('\\', "/");
      let prompt = build_prompt(&base, case, i + 1).replace(&format!("\"{shot_prefix}"), &format!("\"{shots_fwd}/{shot_prefix}"));
      let outcome = ask(a, &provider, &model, &chat_id, prompt, tools).await;
      // Fallback: screenshots that still landed in the workspace root.
      if let Some(root) = a.workspace_root() {
        if let Ok(rd) = std::fs::read_dir(&root) {
          for e in rd.flatten() {
            let f = e.path();
            let name = f.file_name().and_then(|n| n.to_str()).unwrap_or_default().to_string();
            let fresh = e.metadata().and_then(|m| m.modified()).is_ok_and(|t| t >= case_started);
            if fresh && name.starts_with(&shot_prefix) && f.is_file() {
              let to = shots_dir.join(&name);
              if std::fs::rename(&f, &to).is_err() && std::fs::copy(&f, &to).is_ok() {
                let _ = std::fs::remove_file(&f);
              }
            }
          }
        }
      }
      // Move this case's new screenshots from the shared run folder into its own folder.
      for f in images_in(&run_dir).difference(&before) {
        if f.starts_with(&shots_dir) {
          continue;
        }
        if let Some(name) = f.file_name() {
          let to = shots_dir.join(name);
          if std::fs::rename(f, &to).is_err() && std::fs::copy(f, &to).is_ok() {
            let _ = std::fs::remove_file(f);
          }
        }
      }
      match outcome {
        Ok(answer) => {
          let v = parse_verdict(&answer);
          let mut steps = v.steps;
          attach_screenshots(&mut steps, &screenshots_by_step(&shots_dir));
          (v.status, v.reason, steps)
        }
        Err(CoreError::Cancelled) => {
          cancelled = true;
          ("error".into(), "Run cancelled.".into(), Vec::new())
        }
        Err(e) => ("error".into(), e.to_string(), Vec::new()),
      }
    };
    if status == "passed" {
      passed += 1;
    } else {
      failed += 1;
    }
    let duration = case_start.elapsed().as_millis() as i64;
    if let Err(e) = super::set_case_result(
      &pool,
      &case.id,
      &CaseResult { status: &status, reason: &reason, step_results: &steps, chat_id: &chat_id, last_run_at: Some(now_ms()), duration_ms: Some(duration) },
    )
    .await
    {
      fatal = format!("Could not save a result: {e}");
    }
    summaries.push(json!({
      "caseId": case.id, "title": case.title, "status": status, "reason": reason,
      "stepResults": steps, "chatId": chat_id, "durationMs": duration,
    }));
    say(case, &status, &reason, &steps, &chat_id, i);
    if cancelled {
      break;
    }
  }
  if cancel.is_cancelled() {
    cancelled = true;
  }
  a.remove_transient_mcp(session::SERVER).await;

  let duration = started.elapsed().as_millis() as i64;
  let status = if cancelled {
    "cancelled"
  } else if failed == 0 && passed == total {
    "passed"
  } else {
    "failed"
  };
  let summary = format!("{passed}/{total} passed{}", if cancelled { " (cancelled)" } else { "" });
  let result = json!({
    "runId": run_id, "suiteId": suite.id, "envId": suite.env_id, "passed": passed, "failed": failed,
    "total": total, "cancelled": cancelled, "error": fatal, "cases": summaries,
  });
  if let Err(e) = crate::automation::record_run(&pool, "uitest", &suite.id, &suite.name, status, &summary, &result, started_at, duration).await {
    crate::assistant::log_warn(&format!("uitest: could not record the run: {e}"));
  }
  prune_run_dirs(&pool, data_dir).await;
  let done = Done { run_id: run_id.into(), suite_id: suite.id.clone(), passed, failed, total, cancelled, error: fatal };
  emit("uitest://done", serde_json::to_value(&done).unwrap_or(Value::Null));
}

/// Whether the saved login works; a failed check is recorded.
async fn session_state(a: &Arc<Assistant>, data_dir: &Path, env_id: &str) -> Result<bool> {
  if !session::session_file(data_dir, env_id).is_file() {
    return Ok(false);
  }
  let ok = session::check_valid(a, data_dir, env_id).await?;
  session::record_check(data_dir, env_id, ok)?;
  Ok(ok)
}

async fn session_base(a: &Arc<Assistant>, env_id: &str) -> Result<String> {
  let envs = crate::db::environments::list(&a.pool().await).await?;
  let env = envs.into_iter().find(|e| e.environment == env_id).ok_or_else(|| CoreError::NotFound(format!("No environment \"{env_id}\".")))?;
  Ok(session::landing_url(&env.twx_base_url))
}

/// The suite's provider and model, else the app's defaults.
pub(super) async fn models(a: &Arc<Assistant>, suite: &UiTestSuite) -> Result<(String, String)> {
  let settings = a.settings().await?;
  let provider = if suite.provider.is_empty() { settings.default_provider.clone() } else { suite.provider.clone() };
  let model = if !suite.model.is_empty() {
    suite.model.clone()
  } else if provider == settings.default_provider {
    settings.default_model.clone()
  } else {
    String::new()
  };
  Ok((provider, model))
}

/// One turn in `chat_id`, stopped (and reported as an error) after [`CASE_TIMEOUT`].
async fn ask(a: &Arc<Assistant>, provider: &str, model: &str, chat_id: &str, text: String, tools: Vec<String>) -> Result<String> {
  let req = SendRequest {
    chat_id: Some(chat_id.to_string()),
    provider: provider.to_string(),
    model: model.to_string(),
    effort: String::new(),
    text,
    attachments: Vec::new(),
    tools: Some(tools),
    skills: Vec::new(),
    approval: ApprovalMode::Auto,
    server_approval: Some(ApprovalMode::Auto),
    inline_attachments: Vec::new(),
    references: Vec::new(),
    images: Vec::new(),
    sub_agents: None,
  };
  let fut = a.ask(req);
  tokio::pin!(fut);
  tokio::select! {
    r = &mut fut => r.map(|(_, answer)| answer),
    _ = tokio::time::sleep(CASE_TIMEOUT) => {
      a.cancel(chat_id);
      let _ = fut.await;
      Err(CoreError::Invalid(format!("The test took longer than {} minutes and was stopped.", CASE_TIMEOUT.as_secs() / 60)))
    }
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn verdict_from_fenced_json() {
    let answer = "I checked.\n```json\n{\"status\":\"passed\",\"reason\":\"ok\",\"steps\":[{\"step\":1,\"status\":\"passed\",\"note\":\"saw it\"}]}\n```\nDone, thanks.";
    let v = parse_verdict(answer);
    assert_eq!(v.status, "passed");
    assert_eq!(v.reason, "ok");
    assert_eq!(v.steps, vec![UiStepResult { step: 1, status: "passed".into(), note: "saw it".into(), screenshot: String::new() }]);
  }

  #[test]
  fn last_verdict_wins_and_unfenced_works() {
    let answer = "```json\n{\"status\":\"passed\"}\n```\nWait, no.\n```json\n{\"status\":\"failed\",\"reason\":\"x\",\"steps\":[]}\n```";
    assert_eq!(parse_verdict(answer).status, "failed");
    let bare = "Result: {\"status\":\"failed\",\"reason\":\"button missing\"} end";
    let v = parse_verdict(bare);
    assert_eq!((v.status.as_str(), v.reason.as_str()), ("failed", "button missing"));
    assert_eq!(parse_verdict("{\"status\":\"maybe\"}").status, "needsReview");
  }

  #[test]
  fn garbage_is_needs_review() {
    for s in ["", "all good!", "```json\n{not json\n```", "{\"foo\":1}"] {
      let v = parse_verdict(s);
      assert_eq!(v.status, "needsReview", "{s}");
      assert!(v.steps.is_empty());
    }
  }

  #[test]
  fn screenshots_map_to_steps_by_name_then_order() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(dir.path().join("sub")).unwrap();
    std::fs::write(dir.path().join("case-1-step-2.png"), b"x").unwrap();
    std::fs::write(dir.path().join("sub").join("case-1-step-1.jpeg"), b"x").unwrap();
    std::fs::write(dir.path().join("notes.txt"), b"x").unwrap();
    let m = screenshots_by_step(dir.path());
    assert_eq!(m.keys().copied().collect::<Vec<_>>(), vec![1, 2]);
    let mut steps = vec![UiStepResult { step: 2, status: "passed".into(), note: String::new(), screenshot: String::new() }];
    attach_screenshots(&mut steps, &m);
    assert!(steps[0].screenshot.ends_with("case-1-step-2.png"));
    let d2 = tempfile::tempdir().unwrap();
    std::fs::write(d2.path().join("page.png"), b"x").unwrap();
    assert_eq!(screenshots_by_step(d2.path()).keys().copied().collect::<Vec<_>>(), vec![1]);
  }

  #[test]
  fn prompt_lists_steps() {
    let case = UiTestCase {
      title: "Login".into(),
      steps: vec![super::super::UiTestStep { action: "Open".into(), expected: "Page".into() }],
      ..Default::default()
    };
    let p = build_prompt("https://x/Thingworx", &case, 2);
    assert!(p.contains("case-2-step-N.png") && p.contains("1. Open") && p.contains("Expected: Page") && p.contains("https://x/Thingworx"));
  }
}
