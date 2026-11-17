//! What the user is looking at. Pages push it (`useAssistantContext`), the
//! runner puts a short version in every system prompt, and tools hand out the
//! full version on request.

use std::sync::RwLock;

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ScreenContext {
  /// The route, e.g. `/twx-entities`.
  #[serde(default)]
  pub route: String,
  /// Stable screen id, e.g. `twx-entities`. Picks the screen profile.
  #[serde(default)]
  pub screen: String,
  #[serde(default)]
  pub title: Option<String>,
  /// One line the page writes about its state, e.g. "Thing:Foo open in dev".
  #[serde(default)]
  pub summary: Option<String>,
  /// Page state: open entity, environment, filters…
  #[serde(default)]
  pub data: Value,
  /// What is selected: rows, nodes, files, a code range and its text…
  #[serde(default)]
  pub selection: Value,
  /// Actions the page can do for the assistant right now (`run_ui_action`).
  #[serde(default)]
  pub actions: Vec<UiActionSpec>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UiActionSpec {
  pub name: String,
  #[serde(default)]
  pub description: String,
  /// JSON Schema of its arguments.
  #[serde(default)]
  pub input_schema: Value,
  #[serde(default = "default_risk")]
  pub risk: super::tools::Risk,
}

fn default_risk() -> super::tools::Risk {
  super::tools::Risk::Read
}

#[derive(Default)]
pub struct ContextStore {
  inner: RwLock<ScreenContext>,
}

const PROMPT_LIMIT: usize = 4_000;

impl ContextStore {
  pub fn set(&self, ctx: ScreenContext) {
    *self.inner.write().unwrap_or_else(|e| e.into_inner()) = ctx;
  }

  pub fn get(&self) -> ScreenContext {
    self.inner.read().unwrap_or_else(|e| e.into_inner()).clone()
  }

  /// The compact block every system prompt carries. Big values are cut; the
  /// model calls `get_screen_context` / `get_selection` for the rest.
  pub fn prompt_block(&self) -> String {
    let ctx = self.get();
    if ctx.route.is_empty() && ctx.screen.is_empty() {
      return "No screen context: the app window has not reported one.".into();
    }
    let screen = if ctx.screen.is_empty() { "?" } else { ctx.screen.as_str() };
    let mut out = format!("Screen: {screen} (route {})", ctx.route);
    if let Some(title) = ctx.title.as_deref().filter(|t| !t.is_empty()) {
      out.push_str(&format!("\nTitle: {title}"));
    }
    if let Some(summary) = ctx.summary.as_deref().filter(|s| !s.is_empty()) {
      out.push_str(&format!("\nSummary: {summary}"));
    }
    if !is_empty(&ctx.data) {
      out.push_str(&format!("\nState: {}", clip(&ctx.data.to_string(), PROMPT_LIMIT / 2)));
    }
    if is_empty(&ctx.selection) {
      out.push_str("\nSelection: nothing selected");
    } else {
      out.push_str(&format!("\nSelection: {}", clip(&ctx.selection.to_string(), PROMPT_LIMIT / 2)));
    }
    if !ctx.actions.is_empty() {
      let names: Vec<&str> = ctx.actions.iter().map(|a| a.name.as_str()).collect();
      out.push_str(&format!("\nPage actions (run_ui_action): {}", names.join(", ")));
    }
    out
  }
}

pub fn is_empty(v: &Value) -> bool {
  match v {
    Value::Null => true,
    Value::Object(m) => m.is_empty(),
    Value::Array(a) => a.is_empty(),
    Value::String(s) => s.is_empty(),
    _ => false,
  }
}

/// Cuts `s` to at most `max` bytes on a char boundary, marking the cut.
pub fn clip(s: &str, max: usize) -> String {
  if s.len() <= max {
    return s.to_string();
  }
  let mut end = max;
  while !s.is_char_boundary(end) {
    end -= 1;
  }
  format!("{}… [truncated, {} more bytes]", &s[..end], s.len() - end)
}
