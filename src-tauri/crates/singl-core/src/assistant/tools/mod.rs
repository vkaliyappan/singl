//! The tool registry: everything the assistant can do, and everything the
//! app's MCP server offers. One list, two ways in:
//!   * API providers (Anthropic, OpenRouter) get [`ToolSpec`]s as function definitions;
//!   * agent CLIs and outside MCP clients reach the same tools over MCP.
//!
//! Adding a feature to the assistant means adding a [`Tool`] in one of the
//! submodules and listing it in [`builtin`].

pub mod app;
pub mod compare;
pub mod deploy;
pub mod entities;
pub mod flows;
pub mod fs;
pub mod outputs;
pub mod repo;
pub mod services;
pub mod twx;
pub mod twx_access;
pub mod twx_admin;
pub mod twx_import;
pub mod twx_logs;
pub mod deps;
pub mod automation;
pub mod undo;
pub mod twx_events;

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::Assistant;
use crate::{CoreError, Result};

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "lowercase")]
pub enum Risk {
  /// Looks only. Runs without asking.
  #[default]
  Read,
  /// Changes something that can be changed back. Asks unless writes are auto-approved.
  Write,
  /// Deletes, deploys, pushes, overwrites a server. Always asks.
  Destructive,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolSpec {
  pub name: String,
  pub description: String,
  pub input_schema: Value,
  pub risk: Risk,
  /// Offered to outside MCP clients only, never to the assistant's own turns
  /// (e.g. `assistant_ask`, which would let a turn start itself).
  #[serde(skip_serializing_if = "std::ops::Not::not")]
  pub external_only: bool,
}

/// Who is calling a tool.
#[derive(Debug, Clone)]
pub struct CallMeta {
  /// The chat whose turn made the call; `None` for outside MCP clients.
  pub chat_id: Option<String>,
  /// `"assistant"` or `"mcp"`.
  pub source: String,
  pub call_id: String,
}

impl CallMeta {
  pub fn external() -> Self {
    Self { chat_id: None, source: "mcp".into(), call_id: uuid::Uuid::new_v4().to_string() }
  }
}

pub type ToolFuture = Pin<Box<dyn Future<Output = Result<String>> + Send>>;
pub type Handler = Arc<dyn Fn(Arc<Assistant>, Value, CallMeta) -> ToolFuture + Send + Sync>;

#[derive(Clone)]
pub struct Tool {
  pub spec: ToolSpec,
  pub handler: Handler,
}

/// Builds a tool from an async closure.
pub fn tool<F, Fut>(name: &str, description: &str, input_schema: Value, risk: Risk, f: F) -> Tool
where
  F: Fn(Arc<Assistant>, Value, CallMeta) -> Fut + Send + Sync + 'static,
  Fut: Future<Output = Result<String>> + Send + 'static,
{
  Tool {
    spec: ToolSpec {
      name: name.into(),
      description: description.into(),
      input_schema,
      risk,
      external_only: false,
    },
    handler: Arc::new(move |a, v, m| Box::pin(f(a, v, m))),
  }
}

impl Tool {
  pub fn external_only(mut self) -> Self {
    self.spec.external_only = true;
    self
  }
}

/// `{"type":"object","properties":props,"required":required}`.
pub fn schema(props: Value, required: &[&str]) -> Value {
  json!({ "type": "object", "properties": props, "required": required })
}

/// Every built-in tool.
pub fn builtin() -> Vec<Tool> {
  let mut tools = Vec::new();
  tools.extend(app::tools());
  tools.extend(fs::tools());
  tools.extend(twx::tools());
  tools.extend(entities::tools());
  tools.extend(services::tools());
  tools.extend(flows::tools());
  tools.extend(repo::tools());
  tools.extend(compare::tools());
  tools.extend(deploy::tools());
  tools.extend(outputs::tools());
  tools.extend(twx_logs::tools());
  tools.extend(twx_access::tools());
  tools.extend(twx_admin::tools());
  tools.extend(twx_import::tools());
  tools.extend(deps::tools());
  tools.extend(automation::tools());
  tools.extend(undo::tools());
  tools.extend(twx_events::tools());
  tools
}

/// Reading tool arguments.
pub struct Args<'a>(pub &'a Value);

impl<'a> Args<'a> {
  pub fn str(&self, key: &str) -> Option<&'a str> {
    self.0.get(key).and_then(Value::as_str).map(str::trim).filter(|v| !v.is_empty())
  }

  pub fn need(&self, key: &str) -> Result<&'a str> {
    self.str(key).ok_or_else(|| CoreError::Invalid(format!("Missing required argument \"{key}\".")))
  }

  pub fn bool(&self, key: &str) -> Option<bool> {
    self.0.get(key).and_then(Value::as_bool)
  }

  pub fn i64(&self, key: &str) -> Option<i64> {
    self.0.get(key).and_then(Value::as_i64)
  }

  pub fn strings(&self, key: &str) -> Vec<String> {
    self
      .0
      .get(key)
      .and_then(Value::as_array)
      .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
      .unwrap_or_default()
  }

  pub fn object(&self, key: &str) -> Result<Value> {
    match self.0.get(key) {
      None | Some(Value::Null) => Ok(json!({})),
      Some(v @ Value::Object(_)) => Ok(v.clone()),
      Some(_) => Err(CoreError::Invalid(format!("\"{key}\" must be an object."))),
    }
  }
}

/// Pretty JSON for any serializable result.
pub fn ser<T: Serialize>(v: &T) -> Result<String> {
  serde_json::to_string_pretty(v).map_err(|e| CoreError::Invalid(e.to_string()))
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn names_are_unique_and_valid() {
    let tools = builtin();
    let mut names: Vec<&str> = tools.iter().map(|t| t.spec.name.as_str()).collect();
    names.sort();
    let before = names.len();
    names.dedup();
    assert_eq!(before, names.len(), "duplicate tool name");
    for name in names {
      // Anthropic and OpenAI both require ^[a-zA-Z0-9_-]{1,64}$.
      assert!(name.len() <= 64 && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-'), "{name}");
      assert!(!name.contains("__"), "{name}: `__` is reserved for MCP server prefixes");
    }
    for t in tools {
      assert_eq!(t.spec.input_schema["type"], "object", "{}", t.spec.name);
    }
  }
}
