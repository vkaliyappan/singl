//! ThingWorx logs: `/Logs/<Log>/Services/QueryLogEntries`, normalized to one
//! row shape, plus the property write the assistant uses next to it.
//!
//! The service takes `maxItems`, `searchExpression` (wildcard match, so a bare
//! word needs `*…*`), `fromLogLevel` / `toLogLevel` (inclusive, TRACE..ERROR),
//! `startDate` / `endDate` (epoch ms), `origin`, `instance`, `thread`, `user`
//! and `oldestFirst`. Rows carry `timestamp` (epoch ms), `level`, `origin`,
//! `thread`, `user`, `instance`, `session`, `platformId` and `content`.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

use super::api::Client;
use crate::{CoreError, Result};

pub const LOGS: [&str; 6] =
  ["ApplicationLog", "ScriptLog", "ErrorLog", "SecurityLog", "CommunicationLog", "ConfigurationLog"];

const LEVELS: [&str; 5] = ["TRACE", "DEBUG", "INFO", "WARN", "ERROR"];

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct LogQuery {
  /// One of [`LOGS`]; defaults to ApplicationLog.
  pub log: Option<String>,
  pub search: Option<String>,
  /// Minimum level.
  pub level: Option<String>,
  /// Epoch ms.
  pub since: Option<i64>,
  pub until: Option<i64>,
  pub origin: Option<String>,
  pub instance: Option<String>,
  pub thread: Option<String>,
  pub user: Option<String>,
  pub limit: Option<u32>,
  pub oldest_first: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogRow {
  /// Epoch ms.
  pub timestamp: i64,
  pub level: String,
  pub origin: String,
  pub thread: String,
  pub user: String,
  pub instance: String,
  pub session: String,
  pub message: String,
}

pub fn now_ms() -> i64 {
  std::time::SystemTime::now()
    .duration_since(std::time::UNIX_EPOCH)
    .map(|d| d.as_millis() as i64)
    .unwrap_or(0)
}

/// The log's canonical name, or an error listing the valid ones.
pub fn log_name(name: Option<&str>) -> Result<&'static str> {
  let name = name.map(str::trim).filter(|n| !n.is_empty()).unwrap_or("ApplicationLog");
  LOGS
    .iter()
    .find(|l| l.eq_ignore_ascii_case(name) || l.trim_end_matches("Log").eq_ignore_ascii_case(name))
    .copied()
    .ok_or_else(|| CoreError::Invalid(format!("Unknown log \"{name}\". Use one of: {}.", LOGS.join(", "))))
}

fn clean(s: &Option<String>) -> Option<&str> {
  s.as_deref().map(str::trim).filter(|s| !s.is_empty())
}

/// The service inputs for a query.
fn inputs(q: &LogQuery) -> Result<Value> {
  let mut body = Map::new();
  body.insert("maxItems".into(), json!(q.limit.unwrap_or(200).clamp(1, 5000)));
  body.insert("oldestFirst".into(), json!(q.oldest_first));
  if let Some(level) = clean(&q.level) {
    let level = level.to_uppercase();
    let level = if level == "WARNING" { "WARN".to_string() } else { level };
    if !LEVELS.contains(&level.as_str()) {
      return Err(CoreError::Invalid(format!("Unknown level \"{level}\". Use one of: {}.", LEVELS.join(", "))));
    }
    // The server ignores a lone fromLogLevel above WARN; give it both ends.
    body.insert("fromLogLevel".into(), json!(level));
    body.insert("toLogLevel".into(), json!("ERROR"));
  }
  if let Some(s) = clean(&q.search) {
    let s = if s.contains('*') { s.to_string() } else { format!("*{s}*") };
    body.insert("searchExpression".into(), json!(s));
  }
  for (key, value) in [("origin", &q.origin), ("instance", &q.instance), ("thread", &q.thread), ("user", &q.user)] {
    if let Some(v) = clean(value) {
      body.insert(key.into(), json!(v));
    }
  }
  if let Some(t) = q.since {
    body.insert("startDate".into(), json!(t));
  }
  if let Some(t) = q.until {
    body.insert("endDate".into(), json!(t));
  }
  Ok(Value::Object(body))
}

fn text(row: &Value, keys: &[&str]) -> String {
  keys.iter().find_map(|k| row.get(*k).and_then(Value::as_str)).unwrap_or_default().to_string()
}

/// Rows from a QueryLogEntries reply.
pub fn parse_rows(reply: &str) -> Result<Vec<LogRow>> {
  let json: Value =
    serde_json::from_str(reply).map_err(|e| CoreError::Invalid(format!("Unexpected log response: {e}")))?;
  let rows = json.get("rows").and_then(Value::as_array).cloned().unwrap_or_default();
  Ok(
    rows
      .iter()
      .map(|r| LogRow {
        timestamp: r.get("timestamp").and_then(Value::as_i64).unwrap_or(0),
        level: text(r, &["level"]).to_uppercase(),
        origin: text(r, &["origin"]),
        thread: text(r, &["thread"]),
        user: text(r, &["user"]),
        instance: text(r, &["instance"]),
        session: text(r, &["session"]),
        message: text(r, &["content", "message"]),
      })
      .collect(),
  )
}

/// Log entries matching `q`, newest first unless `oldest_first`.
pub async fn query(client: &Client, q: &LogQuery) -> Result<Vec<LogRow>> {
  let log = log_name(q.log.as_deref())?;
  let reply = client.execute_service("Logs", log, "QueryLogEntries", &inputs(q)?).await?;
  parse_rows(&reply)
}

/// Writes property values on a Thing. `values` maps property name to value.
pub async fn set_property_values(client: &Client, thing: &str, values: &Value) -> Result<()> {
  if thing.trim().is_empty() {
    return Err(CoreError::Invalid("thing is required.".into()));
  }
  match values.as_object() {
    Some(o) if !o.is_empty() => client.set_property_values(thing.trim(), values).await,
    _ => Err(CoreError::Invalid("values must be an object with at least one property.".into())),
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn builds_inputs() {
    let q = LogQuery {
      search: Some("dispatch".into()),
      level: Some("warning".into()),
      since: Some(5),
      limit: Some(0),
      ..Default::default()
    };
    let b = inputs(&q).unwrap();
    assert_eq!(b["searchExpression"], "*dispatch*");
    assert_eq!(b["fromLogLevel"], "WARN");
    assert_eq!(b["toLogLevel"], "ERROR");
    assert_eq!(b["maxItems"], 1);
    assert_eq!(b["startDate"], 5);
    assert!(inputs(&LogQuery { level: Some("loud".into()), ..Default::default() }).is_err());
  }

  #[test]
  fn names_and_rows() {
    assert_eq!(log_name(Some("script")).unwrap(), "ScriptLog");
    assert_eq!(log_name(None).unwrap(), "ApplicationLog");
    assert!(log_name(Some("nope")).is_err());
    let rows = parse_rows(r#"{"rows":[{"timestamp":7,"level":"error","content":"x\ny","user":"u"}]}"#).unwrap();
    assert_eq!((rows[0].timestamp, rows[0].level.as_str(), rows[0].message.as_str()), (7, "ERROR", "x\ny"));
  }
}
