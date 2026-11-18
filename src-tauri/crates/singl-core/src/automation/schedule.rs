//! Schedules: what runs when, and the loop that runs it while the app is open.
//!
//! Times are unix seconds. Daily and weekly times are wall-clock in the zone
//! the page reported when the schedule was saved (`utc_offset_min`, minutes
//! ahead of UTC), so they hold across restarts but do not follow DST changes
//! until the schedule is saved again.

use std::collections::HashSet;
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::SqlitePool;
use tokio_util::sync::CancellationToken;

use super::{Outcome, drift, notify, suites};
use crate::assistant::runner::SendRequest;
use crate::assistant::{ApprovalMode, Assistant};
use crate::db::{self, flows, now};
use crate::twx::projects;
use crate::{CoreError, Result, agents, flow};

const TICK: Duration = Duration::from_secs(30);

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Repeat {
  /// Every `minutes` minutes.
  Interval { minutes: u32 },
  /// Every day at `time` (`HH:MM`).
  Daily { time: String },
  /// On `days` (0 = Sunday … 6 = Saturday) at `time`.
  Weekly { days: Vec<u8>, time: String },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Target {
  Suite { suite_id: String },
  Drift { env_a: String, env_b: String, #[serde(default)] projects: Vec<String>, #[serde(default)] compare_xml: bool },
  Flow { flow_id: String, #[serde(default)] env: String },
  /// Starts a new assistant chat with this prompt; the turn can only read.
  Assistant { prompt: String },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Schedule {
  pub id: String,
  pub name: String,
  pub enabled: bool,
  pub repeat: Repeat,
  pub target: Target,
  pub utc_offset_min: i64,
  pub last_run_at: Option<i64>,
  /// `ok`, `failed` (the run found problems) or `error` (it could not run).
  pub last_status: Option<String>,
  pub last_message: Option<String>,
  pub next_run_at: Option<i64>,
  pub created_at: i64,
  pub updated_at: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleInput {
  /// Updates this schedule when set, otherwise creates one.
  pub id: Option<String>,
  pub name: String,
  #[serde(default = "yes")]
  pub enabled: bool,
  pub repeat: Repeat,
  pub target: Target,
  /// Minutes ahead of UTC; the previous value (or 0) when omitted.
  pub utc_offset_min: Option<i64>,
}

fn yes() -> bool {
  true
}

/// Called with `(title, body)` after a run raised a notification, for a desktop notification.
pub type Notifier = Arc<dyn Fn(&str, &str) + Send + Sync>;

// ---- next run -------------------------------------------------------------

fn parse_time(time: &str) -> std::result::Result<i64, String> {
  let bad = || format!("\"{time}\" is not a time of day; use HH:MM.");
  let (h, m) = time.trim().split_once(':').ok_or_else(bad)?;
  let (h, m): (i64, i64) = (h.parse().map_err(|_| bad())?, m.parse().map_err(|_| bad())?);
  if (0..24).contains(&h) && (0..60).contains(&m) { Ok(h * 3600 + m * 60) } else { Err(bad()) }
}

fn weekday(day: i64) -> u8 {
  // 1970-01-01 was a Thursday.
  (day + 4).rem_euclid(7) as u8
}

/// The first run strictly after `after`.
pub fn next_run(repeat: &Repeat, after: i64, utc_offset_min: i64) -> std::result::Result<i64, String> {
  let offset = utc_offset_min * 60;
  let local = after + offset;
  let day = local.div_euclid(86_400);
  match repeat {
    Repeat::Interval { minutes } => {
      if *minutes == 0 {
        return Err("The interval must be at least one minute.".into());
      }
      Ok(after + i64::from(*minutes) * 60)
    }
    Repeat::Daily { time } => {
      let at = parse_time(time)?;
      let candidate = day * 86_400 + at;
      Ok(if candidate > local { candidate } else { candidate + 86_400 } - offset)
    }
    Repeat::Weekly { days, time } => {
      let at = parse_time(time)?;
      if days.is_empty() || days.iter().any(|d| *d > 6) {
        return Err("Pick at least one weekday.".into());
      }
      (0..=7)
        .map(|d| (day + d) * 86_400 + at)
        .find(|c| *c > local && days.contains(&weekday(c.div_euclid(86_400))))
        .map(|c| c - offset)
        .ok_or_else(|| "Pick at least one weekday.".to_string())
    }
  }
}

// ---- storage --------------------------------------------------------------

#[derive(sqlx::FromRow)]
#[sqlx(rename_all = "camelCase")]
struct Row {
  id: String,
  name: String,
  enabled: bool,
  kind: String,
  target: String,
  utc_offset_min: i64,
  last_run_at: Option<i64>,
  last_status: Option<String>,
  last_message: Option<String>,
  next_run_at: Option<i64>,
  created_at: i64,
  updated_at: i64,
}

const SELECT: &str = "SELECT id, name, enabled, kind, target, utcOffsetMin, lastRunAt, lastStatus, lastMessage, nextRunAt, createdAt, updatedAt FROM automation_schedules";

fn schedule_of(r: Row) -> Result<Schedule> {
  let damaged = |e: serde_json::Error| CoreError::Invalid(format!("Schedule \"{}\" is damaged: {e}", r.name));
  Ok(Schedule {
    repeat: serde_json::from_str(&r.kind).map_err(damaged)?,
    target: serde_json::from_str(&r.target).map_err(damaged)?,
    id: r.id,
    name: r.name,
    enabled: r.enabled,
    utc_offset_min: r.utc_offset_min,
    last_run_at: r.last_run_at,
    last_status: r.last_status,
    last_message: r.last_message,
    next_run_at: r.next_run_at,
    created_at: r.created_at,
    updated_at: r.updated_at,
  })
}

pub async fn list(pool: &SqlitePool) -> Result<Vec<Schedule>> {
  let rows: Vec<Row> = sqlx::query_as(&format!("{SELECT} ORDER BY name COLLATE NOCASE")).fetch_all(pool).await?;
  // One damaged row must not hide the others.
  Ok(rows.into_iter().filter_map(|r| schedule_of(r).ok()).collect())
}

pub async fn get(pool: &SqlitePool, id: &str) -> Result<Schedule> {
  let row: Option<Row> = sqlx::query_as(&format!("{SELECT} WHERE id = ?1")).bind(id).fetch_optional(pool).await?;
  schedule_of(row.ok_or_else(|| CoreError::NotFound("That schedule no longer exists.".into()))?)
}

/// A schedule by id, or else by (case-insensitive) name.
pub async fn find(pool: &SqlitePool, id_or_name: &str) -> Result<Schedule> {
  if let Ok(s) = get(pool, id_or_name).await {
    return Ok(s);
  }
  list(pool)
    .await?
    .into_iter()
    .find(|s| s.name.eq_ignore_ascii_case(id_or_name.trim()))
    .ok_or_else(|| CoreError::NotFound(format!("No schedule \"{id_or_name}\". Use automation_list to see them.")))
}

/// The offset most recently saved, so a tool call without one keeps the user's zone.
async fn known_offset(pool: &SqlitePool) -> i64 {
  sqlx::query_scalar("SELECT utcOffsetMin FROM automation_schedules ORDER BY updatedAt DESC LIMIT 1")
    .fetch_optional(pool)
    .await
    .ok()
    .flatten()
    .unwrap_or(0)
}

pub async fn save(pool: &SqlitePool, input: ScheduleInput) -> Result<Schedule> {
  let name = input.name.trim();
  if name.is_empty() {
    return Err(CoreError::Invalid("Give the schedule a name.".into()));
  }
  match &input.target {
    Target::Suite { suite_id } if suite_id.is_empty() => return Err(CoreError::Invalid("Choose a test suite.".into())),
    Target::Drift { env_a, env_b, .. } if env_a.is_empty() || env_b.is_empty() || env_a == env_b => {
      return Err(CoreError::Invalid("Choose two different environments to compare.".into()));
    }
    Target::Flow { flow_id, .. } if flow_id.is_empty() => return Err(CoreError::Invalid("Choose a flow.".into())),
    Target::Assistant { prompt } if prompt.trim().is_empty() => return Err(CoreError::Invalid("Write the prompt to send.".into())),
    _ => {}
  }
  let offset = match input.utc_offset_min {
    Some(o) => o,
    None => known_offset(pool).await,
  };
  let t = now();
  let next = if input.enabled { Some(next_run(&input.repeat, t, offset).map_err(CoreError::Invalid)?) } else {
    next_run(&input.repeat, t, offset).map_err(CoreError::Invalid)?;
    None
  };
  let kind = serde_json::to_string(&input.repeat).unwrap_or_default();
  let target = serde_json::to_string(&input.target).unwrap_or_default();
  let id = match input.id.filter(|i| !i.is_empty()) {
    Some(id) => {
      let done = sqlx::query(
        "UPDATE automation_schedules SET name = ?2, enabled = ?3, kind = ?4, target = ?5, utcOffsetMin = ?6,
           nextRunAt = ?7, updatedAt = ?8 WHERE id = ?1",
      )
      .bind(&id)
      .bind(name)
      .bind(input.enabled)
      .bind(kind)
      .bind(target)
      .bind(offset)
      .bind(next)
      .bind(t)
      .execute(pool)
      .await?;
      if done.rows_affected() == 0 {
        return Err(CoreError::NotFound("That schedule no longer exists.".into()));
      }
      id
    }
    None => {
      let id = uuid::Uuid::new_v4().to_string();
      sqlx::query(
        "INSERT INTO automation_schedules (id, name, enabled, kind, target, utcOffsetMin, nextRunAt, createdAt, updatedAt)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)",
      )
      .bind(&id)
      .bind(name)
      .bind(input.enabled)
      .bind(kind)
      .bind(target)
      .bind(offset)
      .bind(next)
      .bind(t)
      .execute(pool)
      .await?;
      id
    }
  };
  get(pool, &id).await
}

pub async fn set_enabled(pool: &SqlitePool, id: &str, enabled: bool) -> Result<Schedule> {
  let s = get(pool, id).await?;
  let next = if enabled { Some(next_run(&s.repeat, now(), s.utc_offset_min).map_err(CoreError::Invalid)?) } else { None };
  sqlx::query("UPDATE automation_schedules SET enabled = ?2, nextRunAt = ?3, updatedAt = ?4 WHERE id = ?1")
    .bind(id)
    .bind(enabled)
    .bind(next)
    .bind(now())
    .execute(pool)
    .await?;
  get(pool, id).await
}

pub async fn delete(pool: &SqlitePool, id: &str) -> Result<()> {
  sqlx::query("DELETE FROM automation_schedules WHERE id = ?1").bind(id).execute(pool).await?;
  Ok(())
}

// ---- running --------------------------------------------------------------

async fn execute(a: &Arc<Assistant>, target: &Target) -> Result<Outcome> {
  let pool = a.pool().await;
  match target {
    Target::Suite { suite_id } => suites::run_scheduled(&pool, suite_id).await,
    Target::Drift { env_a, env_b, projects, compare_xml } => {
      let req = drift::DriftRequest {
        env_a: env_a.clone(),
        env_b: env_b.clone(),
        projects: projects.clone(),
        compare_xml: *compare_xml,
      };
      drift::run_scheduled(&pool, &req).await
    }
    Target::Flow { flow_id, env } => run_flow(a, &pool, flow_id, env).await,
    Target::Assistant { prompt } => {
      let settings = a.settings().await?;
      let chat_id = a
        .send(SendRequest {
          chat_id: None,
          provider: settings.default_provider.clone(),
          model: settings.default_model.clone(),
          effort: String::new(),
          text: prompt.clone(),
          attachments: Vec::new(),
          tools: None,
          skills: Vec::new(),
          // Nobody is there to approve a write.
          approval: ApprovalMode::ReadOnly,
          server_approval: None,
          inline_attachments: Vec::new(),
          references: Vec::new(),
          images: Vec::new(),
          sub_agents: None,
        })
        .await?;
      Ok(Outcome { ok: true, message: "Started a new assistant chat.".into(), ref_type: "chat".into(), ref_id: chat_id })
    }
  }
}

async fn run_flow(a: &Arc<Assistant>, pool: &SqlitePool, flow_id: &str, env: &str) -> Result<Outcome> {
  let saved = flows::get(pool, flow_id).await?.ok_or_else(|| CoreError::NotFound("That flow no longer exists.".into()))?;
  let graph: Value = serde_json::from_str(&saved.graph)
    .map_err(|e| CoreError::Invalid(format!("Flow \"{}\" has a damaged graph: {e}", saved.name)))?;
  let env = if env.is_empty() { saved.environment.as_str() } else { env };
  let client = projects::connect(pool, env).await?;
  let agent_env = flow::AgentEnv {
    registry: a.procs.clone(),
    root: agents::agent_root(a.workspace().root()),
    disabled: db::settings::disabled_agents(pool).await?,
  };
  let events = Arc::new(Mutex::new(Vec::<String>::new()));
  let sink = events.clone();
  let emit: flow::Emit = Arc::new(move |event: String| sink.lock().unwrap_or_else(|e| e.into_inner()).push(event));
  let request = serde_json::json!({ "graph": graph }).to_string();
  flow::run(pool.clone(), client, request, CancellationToken::new(), emit, agent_env).await?;
  let events = events.lock().unwrap_or_else(|e| e.into_inner()).clone();
  let failure = events.iter().filter_map(|e| serde_json::from_str::<Value>(e).ok()).find_map(|e| {
    match e.get("type").and_then(Value::as_str) {
      Some("error") => Some(e.get("message").and_then(Value::as_str).unwrap_or("the flow failed").to_string()),
      Some("node-end") if e.pointer("/state/status").and_then(Value::as_str) == Some("error") => Some(format!(
        "node {} failed: {}",
        e.get("id").and_then(Value::as_str).unwrap_or("?"),
        e.pointer("/state/error").and_then(Value::as_str).unwrap_or("error")
      )),
      _ => None,
    }
  });
  Ok(Outcome {
    ok: failure.is_none(),
    message: match failure {
      Some(f) => format!("Flow \"{}\": {f}", saved.name),
      None => format!("Flow \"{}\" finished", saved.name),
    },
    ref_type: "flow".into(),
    ref_id: saved.id,
  })
}

/// Runs a schedule's target now, records the result on the schedule and
/// raises a notification when the run failed. Does not change the next run.
pub async fn run_now(a: &Arc<Assistant>, id: &str, notifier: Option<&Notifier>) -> Result<Schedule> {
  let pool = a.pool().await;
  let s = get(&pool, id).await?;
  let outcome = execute(a, &s.target).await;
  let (status, message, ref_type, ref_id) = match outcome {
    Ok(o) => (if o.ok { "ok" } else { "failed" }, o.message, o.ref_type, o.ref_id),
    Err(e) => ("error", e.to_string(), "schedule".into(), s.id.clone()),
  };
  sqlx::query("UPDATE automation_schedules SET lastRunAt = ?2, lastStatus = ?3, lastMessage = ?4 WHERE id = ?1")
    .bind(id)
    .bind(now())
    .bind(status)
    .bind(&message)
    .execute(&pool)
    .await?;
  if status != "ok" {
    let title = format!("Scheduled task needs attention: {}", s.name);
    notify(&pool, &title, &message, "/automation", &ref_type, &ref_id).await?;
    if let Some(n) = notifier {
      n(&title, &message);
    }
  }
  get(&pool, id).await
}

static RUNNING: LazyLock<Mutex<HashSet<String>>> = LazyLock::new(Default::default);

/// Starts every enabled schedule that is due. A schedule already running is skipped.
async fn tick(a: &Arc<Assistant>, notifier: &Notifier) -> Result<()> {
  let pool = a.pool().await;
  let t = now();
  let due: Vec<Row> = sqlx::query_as(&format!("{SELECT} WHERE enabled = 1 AND nextRunAt IS NOT NULL AND nextRunAt <= ?1"))
    .bind(t)
    .fetch_all(&pool)
    .await?;
  for row in due {
    let Ok(s) = schedule_of(row) else { continue };
    if !RUNNING.lock().unwrap_or_else(|e| e.into_inner()).insert(s.id.clone()) {
      continue;
    }
    // Move the next run on first, so a slow run is not started twice.
    let next = next_run(&s.repeat, t, s.utc_offset_min).ok();
    sqlx::query("UPDATE automation_schedules SET nextRunAt = ?2 WHERE id = ?1").bind(&s.id).bind(next).execute(&pool).await?;
    let (a, notifier) = (a.clone(), notifier.clone());
    tokio::spawn(async move {
      if let Err(e) = run_now(&a, &s.id, Some(&notifier)).await {
        eprintln!("scheduled run of {} failed: {e}", s.name);
      }
      RUNNING.lock().unwrap_or_else(|e| e.into_inner()).remove(&s.id);
    });
  }
  Ok(())
}

/// Checks for due schedules every 30 seconds, for as long as the app runs.
pub async fn run_loop(a: Arc<Assistant>, notifier: Notifier) {
  loop {
    if let Err(e) = tick(&a, &notifier).await {
      eprintln!("scheduler: {e}");
    }
    tokio::time::sleep(TICK).await;
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::db::open;

  /// Monday 2024-01-01 00:00:00 UTC.
  const MON: i64 = 1_704_067_200;
  const H: i64 = 3600;
  const DAY: i64 = 86_400;

  fn daily(t: &str) -> Repeat {
    Repeat::Daily { time: t.into() }
  }

  #[test]
  fn interval() {
    assert_eq!(next_run(&Repeat::Interval { minutes: 15 }, MON, 0).unwrap(), MON + 900);
    assert!(next_run(&Repeat::Interval { minutes: 0 }, MON, 0).is_err());
  }

  #[test]
  fn daily_before_and_after_the_time() {
    assert_eq!(next_run(&daily("09:30"), MON, 0).unwrap(), MON + 9 * H + 1800);
    assert_eq!(next_run(&daily("09:30"), MON + 10 * H, 0).unwrap(), MON + DAY + 9 * H + 1800);
    // Exactly at the time means tomorrow.
    assert_eq!(next_run(&daily("09:30"), MON + 9 * H + 1800, 0).unwrap(), MON + DAY + 9 * H + 1800);
  }

  #[test]
  fn daily_in_a_zone() {
    // 09:00 in IST (+05:30) is 03:30 UTC.
    assert_eq!(next_run(&daily("09:00"), MON, 330).unwrap(), MON + 3 * H + 1800);
    // At 23:00 UTC it is already 04:30 local the next day, so the next 09:00 local is that day's.
    assert_eq!(next_run(&daily("09:00"), MON + 23 * H, 330).unwrap(), MON + DAY + 3 * H + 1800);
    // West of UTC: 20:00 at -05:00 is 01:00 UTC the next day.
    assert_eq!(next_run(&daily("20:00"), MON + 6 * H, -300).unwrap(), MON + DAY + H);
  }

  #[test]
  fn weekly() {
    let mon_wed = Repeat::Weekly { days: vec![1, 3], time: "08:00".into() };
    assert_eq!(next_run(&mon_wed, MON, 0).unwrap(), MON + 8 * H);
    assert_eq!(next_run(&mon_wed, MON + 10 * H, 0).unwrap(), MON + 2 * DAY + 8 * H);
    // After Wednesday's run: the following Monday.
    assert_eq!(next_run(&mon_wed, MON + 2 * DAY + 9 * H, 0).unwrap(), MON + 7 * DAY + 8 * H);
    let sunday = Repeat::Weekly { days: vec![0], time: "00:00".into() };
    assert_eq!(next_run(&sunday, MON, 0).unwrap(), MON + 6 * DAY);
    // The same weekday next week when today's time has passed.
    let only_mon = Repeat::Weekly { days: vec![1], time: "08:00".into() };
    assert_eq!(next_run(&only_mon, MON + 9 * H, 0).unwrap(), MON + 7 * DAY + 8 * H);
    assert!(next_run(&Repeat::Weekly { days: vec![], time: "08:00".into() }, MON, 0).is_err());
    assert!(next_run(&Repeat::Weekly { days: vec![7], time: "08:00".into() }, MON, 0).is_err());
  }

  #[test]
  fn bad_times() {
    for t in ["", "9", "25:00", "10:60", "ab:cd"] {
      assert!(next_run(&daily(t), MON, 0).is_err(), "{t}");
    }
    assert!(next_run(&daily("9:05"), MON, 0).is_ok());
  }

  #[test]
  fn json_shapes() {
    let r: Repeat = serde_json::from_str(r#"{"type":"weekly","days":[1],"time":"08:00"}"#).unwrap();
    assert_eq!(r, Repeat::Weekly { days: vec![1], time: "08:00".into() });
    let t: Target = serde_json::from_str(r#"{"type":"drift","envA":"A","envB":"B"}"#).unwrap();
    assert_eq!(t, Target::Drift { env_a: "A".into(), env_b: "B".into(), projects: vec![], compare_xml: false });
    let t: Target = serde_json::from_str(r#"{"type":"suite","suiteId":"x"}"#).unwrap();
    assert_eq!(t, Target::Suite { suite_id: "x".into() });
  }

  #[tokio::test]
  async fn saves_toggles_and_deletes() {
    let dir = tempfile::tempdir().unwrap();
    let pool = open(&dir.path().join("t.db")).await.unwrap();
    let input = |id: Option<String>, enabled: bool| ScheduleInput {
      id,
      name: " Nightly ".into(),
      enabled,
      repeat: Repeat::Interval { minutes: 10 },
      target: Target::Suite { suite_id: "s1".into() },
      utc_offset_min: Some(330),
    };
    let s = save(&pool, input(None, true)).await.unwrap();
    assert_eq!((s.name.as_str(), s.utc_offset_min), ("Nightly", 330));
    assert!(s.next_run_at.unwrap() > now());
    let off = save(&pool, input(Some(s.id.clone()), false)).await.unwrap();
    assert_eq!(off.next_run_at, None);
    assert!(set_enabled(&pool, &s.id, true).await.unwrap().next_run_at.is_some());
    assert_eq!(find(&pool, "nightly").await.unwrap().id, s.id);
    let bad = ScheduleInput { repeat: Repeat::Daily { time: "99:00".into() }, ..input(None, true) };
    assert!(save(&pool, bad).await.is_err());
    delete(&pool, &s.id).await.unwrap();
    assert!(list(&pool).await.unwrap().is_empty());
  }
}
