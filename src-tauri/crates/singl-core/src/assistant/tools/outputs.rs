//! Tool results too big for a model turn.
//!
//! A result over [`SPILL_OVER`] bytes is saved to a file and the model gets a
//! preview plus an id. `tool_output_query` then runs a JavaScript snippet over
//! the whole saved result in the flow sandbox (no file, network or process
//! access) and returns only the snippet's answer.

use std::path::PathBuf;
use std::time::{Duration, SystemTime};

use serde_json::{Value, json};

use super::{Args, Risk, Tool, schema, tool};
use crate::flow::sandbox;
use crate::{CoreError, Result};

/// Results larger than this are saved and previewed.
pub const SPILL_OVER: usize = 100_000;
/// How much of a saved result the model sees right away.
const PREVIEW: usize = 20_000;
/// Saved results are removed after this long…
const KEEP_FOR: Duration = Duration::from_secs(3 * 24 * 3600);
/// …or, oldest first, once all of them together pass this.
const KEEP_BYTES: u64 = 2 * 1024 * 1024 * 1024;
/// Parsing a result of several MB needs far more than a Code node's 128 MB.
const QUERY_MEMORY_MB: usize = 1024;
const DEFAULT_QUERY_MS: u64 = 30_000;
const MAX_QUERY_MS: u64 = 120_000;

fn dir() -> PathBuf {
  std::env::temp_dir().join("singl-tool-outputs")
}

fn path_for(id: &str) -> Result<PathBuf> {
  let ok = !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
  if !ok {
    return Err(CoreError::Invalid(format!("\"{id}\" is not a saved tool output id.")));
  }
  Ok(dir().join(format!("{id}.txt")))
}

/// `out` as the model should see it: unchanged when small, else saved under
/// `call_id` and replaced by a preview that says how to query the rest.
pub fn spill(call_id: &str, tool_name: &str, out: String) -> String {
  if out.len() <= SPILL_OVER {
    return out;
  }
  let id = format!("out_{}", call_id.chars().filter(char::is_ascii_alphanumeric).take(24).collect::<String>());
  let saved = path_for(&id).and_then(|p| {
    std::fs::create_dir_all(dir())?;
    prune();
    std::fs::write(&p, &out)?;
    Ok(())
  });
  let preview = crate::assistant::context::clip(&out, PREVIEW);
  match saved {
    Ok(()) => format!(
      "[{tool_name} returned {}; only the start is shown. The full result is saved as \"{id}\". {} \
       To answer from all of it, call tool_output_query with id \"{id}\" and a JavaScript snippet.]\n\n{preview}",
      size(out.len()),
      describe(&out),
    ),
    Err(e) => {
      crate::assistant::log_warn(&format!("assistant: could not save a large tool result: {e}"));
      crate::assistant::context::clip(&out, SPILL_OVER)
    }
  }
}

fn size(bytes: usize) -> String {
  match bytes {
    b if b >= 1024 * 1024 => format!("{:.1} MB", b as f64 / (1024.0 * 1024.0)),
    b => format!("{} KB", b / 1024),
  }
}

/// One line on the shape of a result, so the model can write its snippet.
fn describe(out: &str) -> String {
  let Ok(v) = serde_json::from_str::<Value>(out) else {
    return format!("It is text ({} lines), not JSON.", out.lines().count());
  };
  let fields = |row: Option<&Value>| -> String {
    row.and_then(Value::as_object).map(|o| o.keys().take(60).cloned().collect::<Vec<_>>().join(", ")).unwrap_or_default()
  };
  match &v {
    Value::Array(a) => format!("It is a JSON array of {} items; the first has fields: {}.", a.len(), fields(a.first())),
    Value::Object(o) => match o.get("rows").and_then(Value::as_array) {
      Some(rows) => format!(
        "It is a ThingWorx InfoTable with {} rows; fields: {}.",
        rows.len(),
        o.get("dataShape")
          .and_then(|d| d.get("fieldDefinitions"))
          .and_then(Value::as_object)
          .map(|f| f.keys().cloned().collect::<Vec<_>>().join(", "))
          .unwrap_or_else(|| fields(rows.first()))
      ),
      None => format!("It is a JSON object with keys: {}.", o.keys().take(60).cloned().collect::<Vec<_>>().join(", ")),
    },
    _ => "It is a single JSON value.".into(),
  }
}

/// Removes expired results, then the oldest until the rest fit [`KEEP_BYTES`].
fn prune() {
  let Ok(read) = std::fs::read_dir(dir()) else { return };
  let now = SystemTime::now();
  let mut files: Vec<(SystemTime, u64, PathBuf)> = read
    .flatten()
    .filter_map(|e| {
      let m = e.metadata().ok()?;
      Some((m.modified().ok()?, m.len(), e.path()))
    })
    .collect();
  files.retain(|(at, _, p)| {
    let old = now.duration_since(*at).is_ok_and(|age| age > KEEP_FOR);
    if old {
      let _ = std::fs::remove_file(p);
    }
    !old
  });
  files.sort_by_key(|(at, _, _)| *at);
  let mut total: u64 = files.iter().map(|(_, len, _)| len).sum();
  for (_, len, p) in files {
    if total <= KEEP_BYTES {
      break;
    }
    let _ = std::fs::remove_file(&p);
    total -= len;
  }
}

/// The snippet runs as an async function body with `data`, `rows`, `text` and `console.log`.
fn wrap(code: &str) -> String {
  format!(
    r#"(async () => {{
  const text = __inputJson;
  let data = text;
  try {{ data = JSON.parse(text); }} catch (_) {{}}
  const rows = Array.isArray(data) ? data
    : data && typeof data === "object" && Array.isArray(data.rows) ? data.rows
    : typeof data === "string" ? data.split(/\r?\n/) : [];
  const logs = [];
  const show = (x) => typeof x === "string" ? x : JSON.stringify(x);
  const console = {{ log: (...a) => logs.push(a.map(show).join(" ")) }};
  console.error = console.warn = console.info = console.log;
  try {{
    const value = await (async () => {{
{code}
    }})();
    return JSON.stringify({{ ok: true, value: value === undefined ? null : value, logs }});
  }} catch (e) {{
    return JSON.stringify({{ ok: false, error: String(e && e.message || e), logs }});
  }}
}})()"#
  )
}

async fn query(id: &str, code: &str, timeout_ms: u64) -> Result<String> {
  let path = path_for(id)?;
  let text = tokio::fs::read_to_string(&path).await.map_err(|_| {
    CoreError::NotFound(format!("No saved tool output \"{id}\" (results are kept for 3 days)."))
  })?;
  let source = wrap(code);
  let raw = tokio::task::spawn_blocking(move || sandbox::run_with(&source, &text, timeout_ms, QUERY_MEMORY_MB))
    .await
    .map_err(|e| CoreError::Invalid(format!("The query did not finish: {e}")))?;
  let env: Value = serde_json::from_str(&raw).map_err(|e| CoreError::Invalid(format!("Bad sandbox reply: {e}")))?;
  let logs = env["logs"].as_array().map(|l| l.iter().filter_map(Value::as_str).collect::<Vec<_>>().join("\n")).unwrap_or_default();
  if env["ok"] == true {
    let value = match &env["value"] {
      Value::String(s) => s.clone(),
      v => serde_json::to_string_pretty(v).unwrap_or_default(),
    };
    return Ok(if logs.is_empty() { value } else { format!("{value}\n\n[console]\n{logs}") });
  }
  let why = match env["limit"].as_str() {
    Some("timeout") => format!("The query ran past {timeout_ms} ms."),
    Some("memory") => format!("The query ran out of memory ({QUERY_MEMORY_MB} MB)."),
    _ => env["error"].as_str().unwrap_or("The query failed.").to_string(),
  };
  Err(CoreError::Invalid(if logs.is_empty() { why } else { format!("{why}\n[console]\n{logs}") }))
}

pub fn tools() -> Vec<Tool> {
  vec![tool(
    "tool_output_query",
    "Answer a question from a large tool result that was saved instead of shown (the result says \"saved as \
     out_…\"). Runs `code` as the body of an async JavaScript function over the whole result and returns what it \
     returns (keep it small: counts, filtered rows, distinct values). In scope: `data` (the parsed JSON, or the \
     text when it is not JSON), `rows` (an InfoTable's or array's rows, else the text's lines), `text` (the raw \
     result) and `console.log`. No files, network or imports. Example: \
     `return rows.filter(r => !r.FeatureGroup).length;`",
    schema(
      json!({
        "id": { "type": "string", "description": "The saved result's id, e.g. out_1a2b3c." },
        "code": { "type": "string", "description": "JavaScript function body; `return` the answer." },
        "timeoutMs": { "type": "integer", "description": "Default 30000, at most 120000." },
      }),
      &["id", "code"],
    ),
    Risk::Read,
    |_a, args, _| async move {
      let x = Args(&args);
      let ms = x.i64("timeoutMs").map_or(DEFAULT_QUERY_MS, |v| (v.max(100) as u64).min(MAX_QUERY_MS));
      query(x.need("id")?, x.need("code")?, ms).await
    },
  )]
}

#[cfg(test)]
mod tests {
  use super::*;

  fn big_table(rows: usize) -> String {
    let rows: Vec<Value> =
      (0..rows).map(|i| json!({ "GroupId": format!("OP{i:08}"), "FeatureGroup": if i % 7 == 0 { "" } else { "Plumbing" } })).collect();
    json!({ "dataShape": { "fieldDefinitions": { "GroupId": {}, "FeatureGroup": {} } }, "rows": rows }).to_string()
  }

  #[test]
  fn small_results_pass_through() {
    assert_eq!(spill("c1", "t", "hello".into()), "hello");
  }

  #[tokio::test]
  async fn large_results_are_saved_and_queryable() {
    let out = big_table(5000);
    assert!(out.len() > SPILL_OVER);
    let shown = spill("test-call-1", "twx__invoke", out);
    assert!(shown.len() < PREVIEW + 1000);
    assert!(shown.contains("\"out_testcall1\""), "{}", &shown[..300]);
    assert!(shown.contains("InfoTable with 5000 rows; fields: "));
    assert!(shown.contains("GroupId") && shown.contains("FeatureGroup"));
    let n = query("out_testcall1", "return rows.filter(r => !r.FeatureGroup).length;", 10_000).await.unwrap();
    assert_eq!(n, "715");
    let logged = query("out_testcall1", "console.log('n', rows.length); return 'done';", 10_000).await.unwrap();
    assert_eq!(logged, "done\n\n[console]\nn 5000");
    let err = query("out_testcall1", "throw new Error('nope');", 10_000).await.unwrap_err();
    assert!(err.to_string().contains("nope"));
    assert!(query("../etc", "return 1;", 1000).await.is_err());
  }
}

#[cfg(test)]
mod size_check {
  use super::*;

  /// About the size of a whole-container GetOptionCostingReport (~11 MB).
  #[tokio::test]
  #[ignore = "slow; run by hand"]
  async fn eleven_mb_infotable() {
    let rows: Vec<Value> = (0..40_000)
      .map(|i| {
        json!({ "ContainerName": "Dresden", "Floorplan": format!("021CHAS_{i:06}"), "GroupId": format!("OP{:08}_OP{:08}", i % 500, i % 77),
          "FeatureGroup": if i % 9 == 0 { "" } else { "Exterior" }, "Description": "x".repeat(120), "Cost": i as f64 * 1.25,
          "GID": i, "GOPID": i * 2, "GCHID": i * 3, "BomItems": "y".repeat(40) })
      })
      .collect();
    let out = json!({ "dataShape": { "fieldDefinitions": {} }, "rows": rows }).to_string();
    println!("size {}", out.len());
    let at = std::time::Instant::now();
    spill("size-check", "t", out);
    let n = query("out_sizecheck", "return rows.filter(r => !r.FeatureGroup).length;", 120_000).await.unwrap();
    println!("blank {n} in {:?}", at.elapsed());
    assert_eq!(n, "4445");
  }
}
