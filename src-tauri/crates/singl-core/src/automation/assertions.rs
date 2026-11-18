//! The assertion engine: what a test case checks about one service call.
//! Pure functions, so it is unit tested without a server.

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Assertion {
  /// The call returned without an error.
  Succeeds,
  /// The call took at most `ms` milliseconds.
  MaxMs { ms: u64 },
  /// The result's row count (an infotable's `rows`, or an array) compares to `value`.
  RowCount { op: String, value: i64 },
  /// The value at `path` (`rows[0].name`) compares to `value`. `op` is
  /// `equals`, `notEquals`, `contains` or `exists`.
  JsonPath {
    path: String,
    op: String,
    #[serde(default)]
    value: Value,
  },
  /// The result's text contains `text`.
  TextContains { text: String },
}

/// What one service call produced.
pub struct Observation<'a> {
  pub error: Option<&'a str>,
  pub text: &'a str,
  pub duration_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Check {
  pub label: String,
  pub passed: bool,
  pub expected: String,
  pub actual: String,
}

/// Runs every assertion against `obs`.
pub fn evaluate(assertions: &[Assertion], obs: &Observation) -> Vec<Check> {
  let json: Option<Value> = if obs.error.is_none() { serde_json::from_str(obs.text).ok() } else { None };
  assertions.iter().map(|a| check(a, obs, json.as_ref())).collect()
}

fn check(a: &Assertion, obs: &Observation, json: Option<&Value>) -> Check {
  let skipped = |label: String, expected: String| Check {
    label,
    passed: false,
    expected,
    actual: format!("not evaluated: {}", obs.error.unwrap_or("the result is not JSON")),
  };
  match a {
    Assertion::Succeeds => Check {
      label: "succeeds".into(),
      passed: obs.error.is_none(),
      expected: "no error".into(),
      actual: obs.error.unwrap_or("no error").into(),
    },
    Assertion::MaxMs { ms } => Check {
      label: format!("takes at most {ms} ms"),
      passed: obs.duration_ms <= *ms,
      expected: format!("<= {ms} ms"),
      actual: format!("{} ms", obs.duration_ms),
    },
    Assertion::TextContains { text } => {
      let label = format!("result contains \"{text}\"");
      if obs.error.is_some() {
        return skipped(label, text.clone());
      }
      Check { label, passed: obs.text.contains(text.as_str()), expected: text.clone(), actual: clip(obs.text) }
    }
    Assertion::RowCount { op, value } => {
      let label = format!("row count {op} {value}");
      let expected = format!("{} {value}", op_symbol(op));
      let Some(json) = json else { return skipped(label, expected) };
      match row_count(json) {
        None => Check { label, passed: false, expected, actual: "the result has no rows".into() },
        Some(n) => match compare_num(op, n as i64, *value) {
          Some(passed) => Check { label, passed, expected, actual: n.to_string() },
          None => Check { label, passed: false, expected, actual: format!("unknown operator \"{op}\"") },
        },
      }
    }
    Assertion::JsonPath { path, op, value } => {
      let label = format!("{path} {op}{}", if op == "exists" { String::new() } else { format!(" {}", show(value)) });
      let expected = if op == "exists" { "present".to_string() } else { format!("{} {}", op_symbol(op), show(value)) };
      let Some(json) = json else { return skipped(label, expected) };
      let found = match get_path(json, path) {
        Ok(v) => v,
        Err(e) => return Check { label, passed: false, expected, actual: e },
      };
      let actual = found.map(show).unwrap_or_else(|| "missing".into());
      let passed = match (op.as_str(), found) {
        ("exists", f) => f.is_some_and(|v| !v.is_null()),
        ("equals", Some(f)) => loose_eq(f, value),
        ("equals", None) => false,
        ("notEquals", Some(f)) => !loose_eq(f, value),
        ("notEquals", None) => true,
        ("contains", Some(f)) => contains(f, value),
        ("contains", None) => false,
        _ => return Check { label, passed: false, expected, actual: format!("unknown operator \"{op}\"") },
      };
      Check { label, passed, expected, actual: clip(&actual) }
    }
  }
}

fn op_symbol(op: &str) -> &str {
  match op {
    "eq" | "=" | "==" | "equals" => "=",
    "ne" | "!=" | "notEquals" => "!=",
    "gt" | ">" => ">",
    "gte" | ">=" => ">=",
    "lt" | "<" => "<",
    "lte" | "<=" => "<=",
    other => other,
  }
}

fn compare_num(op: &str, a: i64, b: i64) -> Option<bool> {
  Some(match op_symbol(op) {
    "=" => a == b,
    "!=" => a != b,
    ">" => a > b,
    ">=" => a >= b,
    "<" => a < b,
    "<=" => a <= b,
    _ => return None,
  })
}

/// Rows of an infotable reply (`{"rows":[..]}`) or the length of a bare array.
pub fn row_count(v: &Value) -> Option<usize> {
  match v {
    Value::Array(a) => Some(a.len()),
    Value::Object(o) => o.get("rows").and_then(Value::as_array).map(Vec::len),
    _ => None,
  }
}

fn show(v: &Value) -> String {
  match v {
    Value::String(s) => s.clone(),
    other => other.to_string(),
  }
}

/// A prefix of `s` for display.
pub fn clip(s: &str) -> String {
  const MAX: usize = 300;
  if s.chars().count() <= MAX { s.to_string() } else { format!("{}…", s.chars().take(MAX).collect::<String>()) }
}

/// Equal, or equal once both are written as text (so `5` matches `"5"`).
fn loose_eq(a: &Value, b: &Value) -> bool {
  a == b || show(a) == show(b)
}

fn contains(actual: &Value, wanted: &Value) -> bool {
  match actual {
    Value::String(s) => s.contains(&show(wanted)),
    Value::Array(items) => items.iter().any(|i| loose_eq(i, wanted)),
    Value::Object(o) => o.contains_key(&show(wanted)),
    other => show(other).contains(&show(wanted)),
  }
}

#[derive(Debug, PartialEq)]
enum Seg {
  Key(String),
  Index(usize),
}

fn parse_path(path: &str) -> Result<Vec<Seg>, String> {
  let path = path.trim();
  let path = path.strip_prefix('$').unwrap_or(path);
  let mut segs = Vec::new();
  for part in path.split('.').filter(|p| !p.is_empty()) {
    let (name, mut rest) = match part.find('[') {
      Some(i) => (&part[..i], &part[i..]),
      None => (part, ""),
    };
    if !name.is_empty() {
      segs.push(match name.parse::<usize>() {
        Ok(i) => Seg::Index(i),
        Err(_) => Seg::Key(name.to_string()),
      });
    }
    while let Some(r) = rest.strip_prefix('[') {
      let end = r.find(']').ok_or_else(|| format!("bad path \"{path}\": missing ]"))?;
      let i = r[..end].trim().parse::<usize>().map_err(|_| format!("bad path \"{path}\": [{}] is not an index", &r[..end]))?;
      segs.push(Seg::Index(i));
      rest = &r[end + 1..];
    }
    if !rest.is_empty() {
      return Err(format!("bad path \"{path}\": unexpected \"{rest}\""));
    }
  }
  Ok(segs)
}

/// The value at a dot / `[i]` path, `None` when nothing is there, an error when the path itself is malformed.
pub fn get_path<'a>(root: &'a Value, path: &str) -> Result<Option<&'a Value>, String> {
  let mut cur = root;
  for seg in parse_path(path)? {
    let next = match (&seg, cur) {
      (Seg::Key(k), Value::Object(o)) => o.get(k),
      (Seg::Index(i), Value::Array(a)) => a.get(*i),
      (Seg::Index(i), Value::Object(o)) => o.get(&i.to_string()),
      _ => None,
    };
    match next {
      Some(v) => cur = v,
      None => return Ok(None),
    }
  }
  Ok(Some(cur))
}

#[cfg(test)]
mod tests {
  use super::*;
  use serde_json::json;

  fn obs(text: &str, ms: u64) -> Observation<'_> {
    Observation { error: None, text, duration_ms: ms }
  }

  const REPLY: &str = r#"{"dataShape":{},"rows":[{"name":"a","n":1},{"name":"b","n":2}],"tags":["x","y"]}"#;

  #[test]
  fn paths() {
    let v: Value = serde_json::from_str(REPLY).unwrap();
    assert_eq!(get_path(&v, "rows[1].name").unwrap(), Some(&json!("b")));
    assert_eq!(get_path(&v, "$.rows.0.n").unwrap(), Some(&json!(1)));
    assert_eq!(get_path(&v, "tags[0]").unwrap(), Some(&json!("x")));
    assert_eq!(get_path(&v, "rows[5].name").unwrap(), None);
    assert_eq!(get_path(&v, "").unwrap(), Some(&v));
    assert!(get_path(&v, "rows[x]").is_err());
    assert!(get_path(&v, "rows[1").is_err());
  }

  #[test]
  fn succeeds_and_timing() {
    let ok = evaluate(&[Assertion::Succeeds, Assertion::MaxMs { ms: 100 }], &obs("1", 80));
    assert!(ok.iter().all(|c| c.passed));
    let slow = evaluate(&[Assertion::MaxMs { ms: 100 }], &obs("1", 101));
    assert!(!slow[0].passed);
    let failed = Observation { error: Some("boom"), text: "", duration_ms: 5 };
    let checks = evaluate(&[Assertion::Succeeds, Assertion::RowCount { op: "gt".into(), value: 0 }], &failed);
    assert!(!checks[0].passed && checks[0].actual == "boom");
    assert!(!checks[1].passed && checks[1].actual.starts_with("not evaluated"));
  }

  #[test]
  fn row_counts() {
    let c = |op: &str, n: i64| evaluate(&[Assertion::RowCount { op: op.into(), value: n }], &obs(REPLY, 1))[0].passed;
    assert!(c("eq", 2) && c("=", 2) && c("gte", 2) && c("gt", 1) && c("lt", 3) && c("lte", 2) && c("ne", 3));
    assert!(!c("eq", 3) && !c("gt", 2));
    let none = evaluate(&[Assertion::RowCount { op: "eq".into(), value: 1 }], &obs("5", 1));
    assert!(!none[0].passed);
    assert!(!evaluate(&[Assertion::RowCount { op: "zz".into(), value: 1 }], &obs(REPLY, 1))[0].passed);
    assert!(evaluate(&[Assertion::RowCount { op: "eq".into(), value: 2 }], &obs("[1,2]", 1))[0].passed);
  }

  #[test]
  fn json_path_operators() {
    let jp = |path: &str, op: &str, value: Value| {
      evaluate(&[Assertion::JsonPath { path: path.into(), op: op.into(), value }], &obs(REPLY, 1))[0].passed
    };
    assert!(jp("rows[0].name", "equals", json!("a")));
    assert!(jp("rows[1].n", "equals", json!("2")), "5 matches \"5\"");
    assert!(!jp("rows[1].n", "equals", json!(3)));
    assert!(jp("rows[1].n", "notEquals", json!(3)));
    assert!(jp("rows[9].n", "notEquals", json!(3)), "missing is not equal");
    assert!(jp("tags", "contains", json!("y")));
    assert!(jp("rows[0].name", "contains", json!("a")));
    assert!(!jp("tags", "contains", json!("z")));
    assert!(jp("rows[0].n", "exists", Value::Null));
    assert!(!jp("rows[7]", "exists", Value::Null));
    assert!(!jp("rows[0].name", "bogus", json!("a")));
  }

  #[test]
  fn text_contains_and_serde() {
    assert!(evaluate(&[Assertion::TextContains { text: "\"b\"".into() }], &obs(REPLY, 1))[0].passed);
    assert!(!evaluate(&[Assertion::TextContains { text: "zzz".into() }], &obs(REPLY, 1))[0].passed);
    let a: Assertion = serde_json::from_value(json!({ "type": "jsonPath", "path": "a", "op": "exists" })).unwrap();
    assert_eq!(a, Assertion::JsonPath { path: "a".into(), op: "exists".into(), value: Value::Null });
    let a: Assertion = serde_json::from_value(json!({ "type": "maxMs", "ms": 5 })).unwrap();
    assert_eq!(a, Assertion::MaxMs { ms: 5 });
  }
}
