//! The app's MCP server protocol: JSON-RPC 2.0 over whatever transport
//! ([`super::http`], or the `singl-mcp` stdio shim). Its tools are the
//! assistant's registry, so an outside client can do anything the built-in
//! assistant can.

use std::sync::Arc;

use serde_json::{Value, json};

use crate::assistant::Assistant;
use crate::assistant::tools::{CallMeta, Risk};

pub const SERVER_NAME: &str = "singl";
const LATEST_PROTOCOL: &str = "2025-06-18";
const SUPPORTED_PROTOCOLS: &[&str] = &["2025-06-18", "2025-03-26", "2024-11-05"];

const INSTRUCTIONS: &str = "singl is a desktop app for ThingWorx development: entities, services, flows, \
repositories, compare and deploy. These tools act inside the running app as the signed-in user. \
Call get_screen_context first to see what the user is looking at and what they selected. \
Tools marked destructive ask the user in the app before they run.";

/// Who is on the other end.
#[derive(Debug, Clone)]
pub struct Caller {
  /// Set for an agent CLI running one of the assistant's turns.
  pub chat_id: Option<String>,
}

impl Caller {
  pub fn external() -> Self {
    Self { chat_id: None }
  }

  fn internal(&self) -> bool {
    self.chat_id.is_some()
  }
}

pub fn error_response(id: Value, code: i64, message: &str) -> Value {
  json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

/// One JSON-RPC message in, at most one reply out (notifications get none).
pub async fn handle(assistant: &Arc<Assistant>, msg: Value, caller: &Caller) -> Option<Value> {
  let method = msg.get("method").and_then(Value::as_str).unwrap_or_default().to_string();
  let params = msg.get("params").cloned().unwrap_or(Value::Null);
  let id = match msg.get("id").cloned() {
    Some(id) if !method.is_empty() => id,
    _ => return None,
  };

  let result = match method.as_str() {
    "initialize" => {
      let asked = params.get("protocolVersion").and_then(Value::as_str).unwrap_or(LATEST_PROTOCOL);
      let version = if SUPPORTED_PROTOCOLS.contains(&asked) { asked } else { LATEST_PROTOCOL };
      json!({
        "protocolVersion": version,
        "capabilities": { "tools": { "listChanged": false } },
        "serverInfo": { "name": SERVER_NAME, "version": env!("CARGO_PKG_VERSION") },
        "instructions": INSTRUCTIONS,
      })
    }
    "ping" => json!({}),
    "tools/list" => {
      let specs = match &caller.chat_id {
        Some(chat_id) => assistant.tool_specs_for(chat_id).await,
        None => assistant.tool_specs(true).await,
      };
      let tools: Vec<Value> = specs
        .into_iter()
        .map(|t| {
          json!({
            "name": t.name,
            "description": t.description,
            "inputSchema": t.input_schema,
            "annotations": {
              "readOnlyHint": t.risk == Risk::Read,
              "destructiveHint": t.risk == Risk::Destructive,
            },
          })
        })
        .collect();
      json!({ "tools": tools })
    }
    "tools/call" => {
      let Some(name) = params.get("name").and_then(Value::as_str) else {
        return Some(error_response(id, -32602, "tools/call needs a name."));
      };
      let args = params.get("arguments").cloned().unwrap_or_else(|| json!({}));
      let meta = CallMeta {
        chat_id: caller.chat_id.clone(),
        source: if caller.internal() { "assistant".into() } else { "mcp".into() },
        call_id: uuid::Uuid::new_v4().to_string(),
      };
      let (text, is_error) = assistant.call_tool(name, args, meta).await;
      let mut out = json!({ "content": [{ "type": "text", "text": text }] });
      if is_error {
        out["isError"] = json!(true);
      }
      out
    }
    "resources/list" => json!({ "resources": [] }),
    "prompts/list" => json!({ "prompts": [] }),
    other => return Some(error_response(id, -32601, &format!("Method not found: {other}"))),
  };
  Some(json!({ "jsonrpc": "2.0", "id": id, "result": result }))
}

/// A whole HTTP/stdio payload: one message or a batch. `None` when nothing needs an answer.
pub async fn handle_payload(assistant: &Arc<Assistant>, payload: Value, caller: &Caller) -> Option<Value> {
  match payload {
    Value::Array(items) => {
      let mut out = Vec::new();
      for item in items {
        if let Some(reply) = handle(assistant, item, caller).await {
          out.push(reply);
        }
      }
      (!out.is_empty()).then_some(Value::Array(out))
    }
    one => handle(assistant, one, caller).await,
  }
}
