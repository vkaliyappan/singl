//! What the assistant tells the UI. The app crate forwards each event as the
//! Tauri event `assistant://event`; a turn started over MCP produces the same
//! events as one started from the panel.

use serde::Serialize;
use serde_json::Value;

use super::tools::Risk;
use super::types::Message;

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum AssistantEvent {
  #[serde(rename_all = "camelCase")]
  TurnStarted { chat_id: String, provider: String, model: String },
  /// Streamed text, appended to the reply being written.
  #[serde(rename_all = "camelCase")]
  Text { chat_id: String, text: String },
  /// Streamed reasoning (a summary, on models that only give one), shown apart from the reply.
  #[serde(rename_all = "camelCase")]
  Thinking { chat_id: String, text: String },
  /// What an agent CLI is busy with between visible output ("Reading x.js"),
  /// for work that has no tool card: its own tools, sub-agents, hidden thinking.
  #[serde(rename_all = "camelCase")]
  Status { chat_id: String, text: String },
  #[serde(rename_all = "camelCase")]
  ToolCall { chat_id: Option<String>, call_id: String, name: String, input: Value, source: String },
  #[serde(rename_all = "camelCase")]
  ToolResult { chat_id: Option<String>, call_id: String, content: String, is_error: bool },
  /// A message was stored; the UI replaces its streamed copy with this one.
  #[serde(rename_all = "camelCase")]
  MessageSaved { chat_id: String, message: Message },
  #[serde(rename_all = "camelCase")]
  TurnEnded { chat_id: String, error: Option<String>, cancelled: bool },
  #[serde(rename_all = "camelCase")]
  ApprovalRequest { request_id: String, chat_id: Option<String>, tool: String, input: Value, risk: Risk, source: String },
  #[serde(rename_all = "camelCase")]
  ApprovalResolved { request_id: String, approved: bool },
  /// Asks the UI to do something only it can (navigate, select…). Answered with `assistant_ui_reply`.
  #[serde(rename_all = "camelCase")]
  UiRequest { request_id: String, action: String, args: Value },
  ChatsChanged,
}
