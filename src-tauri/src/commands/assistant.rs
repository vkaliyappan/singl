//! The app-wide AI assistant (singl-core `assistant`). Events come back as
//! the Tauri event `assistant://event` (see `lib.rs`), not per command.

use serde_json::Value;
use singl_core::assistant::ApprovalMode;
use singl_core::assistant::context::ScreenContext;
use singl_core::assistant::mcp::client::McpServerStatus;
use singl_core::assistant::mcp::{McpInfo, discovery_path};
use singl_core::assistant::prompt::{Suggestion, suggestions};
use singl_core::assistant::providers::{self, ProviderInfo};
use singl_core::assistant::runner::SendRequest;
use singl_core::assistant::settings::{self, AssistantSettingsPatch, AssistantSettingsView};
use singl_core::assistant::tools::ToolSpec;
use singl_core::assistant::types::{Chat, ChatSummary, ModelInfo};
use singl_core::assistant::{ApprovalAnswer, store};
use tauri::State;

use crate::error::IpcResult;
use crate::state::AppState;

/// Starts a turn; returns the chat id (new when `chatId` was omitted).
#[tauri::command]
pub async fn assistant_send(state: State<'_, AppState>, request: SendRequest) -> IpcResult<String> {
  Ok(state.assistant.send(request).await?)
}

#[tauri::command]
pub fn assistant_cancel(state: State<'_, AppState>, chat_id: String) -> bool {
  state.assistant.cancel(&chat_id)
}

/// Changes the approval mode of a chat's running turn (the composer's picker).
#[tauri::command]
pub fn assistant_turn_mode(state: State<'_, AppState>, chat_id: String, mode: ApprovalMode) -> bool {
  state.assistant.change_turn_mode(&chat_id, mode)
}

#[tauri::command]
pub fn assistant_chat_running(state: State<'_, AppState>, chat_id: String) -> bool {
  state.assistant.is_running(&chat_id)
}

#[tauri::command]
pub async fn assistant_chats(state: State<'_, AppState>, limit: Option<i64>) -> IpcResult<Vec<ChatSummary>> {
  Ok(store::list(&state.db().await, limit.unwrap_or(200)).await?)
}

/// Chats whose title or messages contain `query`.
#[tauri::command]
pub async fn assistant_chats_search(state: State<'_, AppState>, query: String, limit: Option<i64>) -> IpcResult<Vec<ChatSummary>> {
  Ok(store::search(&state.db().await, &query, limit.unwrap_or(200)).await?)
}

#[tauri::command]
pub async fn assistant_chat_get(state: State<'_, AppState>, chat_id: String) -> IpcResult<Chat> {
  Ok(store::get(&state.db().await, &chat_id).await?)
}

#[tauri::command]
pub async fn assistant_chat_rename(state: State<'_, AppState>, chat_id: String, title: String) -> IpcResult<()> {
  Ok(store::rename(&state.db().await, &chat_id, &title).await?)
}

#[tauri::command]
pub async fn assistant_chat_delete(state: State<'_, AppState>, chat_id: String) -> IpcResult<()> {
  state.assistant.cancel(&chat_id);
  Ok(store::delete(&state.db().await, &chat_id).await?)
}

/// The page reports what is on screen and selected.
#[tauri::command]
pub fn assistant_context_set(state: State<'_, AppState>, context: ScreenContext) {
  state.assistant.context.set(context);
}

#[tauri::command]
pub fn assistant_context_get(state: State<'_, AppState>) -> ScreenContext {
  state.assistant.context.get()
}

#[tauri::command]
pub fn assistant_suggestions(state: State<'_, AppState>) -> Vec<Suggestion> {
  suggestions(&state.assistant.context.get())
}

/// Answers a `uiRequest` event.
#[tauri::command]
pub fn assistant_ui_reply(
  state: State<'_, AppState>,
  request_id: String,
  ok: bool,
  result: Option<Value>,
  error: Option<String>,
) -> bool {
  let answer = if ok { Ok(result.unwrap_or(Value::Null)) } else { Err(error.unwrap_or_else(|| "The page failed.".into())) };
  state.assistant.ui_reply(&request_id, answer)
}

/// Answers an `approvalRequest` event.
#[tauri::command]
pub fn assistant_approve(state: State<'_, AppState>, request_id: String, approved: bool, always: Option<bool>) -> bool {
  state.assistant.approve(&request_id, ApprovalAnswer { approved, always: always.unwrap_or(false) })
}

#[tauri::command]
pub async fn assistant_settings_get(state: State<'_, AppState>) -> IpcResult<AssistantSettingsView> {
  Ok(state.assistant.settings().await?.view())
}

/// Saves settings; restarts the MCP server when its settings changed.
#[tauri::command]
pub async fn assistant_settings_set(state: State<'_, AppState>, patch: AssistantSettingsPatch) -> IpcResult<AssistantSettingsView> {
  let touches_mcp = patch.mcp_enabled.is_some() || patch.mcp_port.is_some() || patch.regenerate_mcp_token == Some(true);
  let touches_servers = patch.mcp_servers.is_some() || patch.use_project_mcp.is_some() || patch.disabled_project_servers.is_some();
  let saved = settings::update(&state.db().await, patch).await?;
  if touches_mcp {
    state.assistant.start_mcp(&discovery_path(&state.db_path)).await?;
  }
  if touches_servers {
    state.assistant.mcp_clients.shutdown_all().await;
  }
  Ok(saved.view())
}

#[tauri::command]
pub async fn assistant_providers(state: State<'_, AppState>) -> IpcResult<Vec<ProviderInfo>> {
  Ok(providers::list(&state.assistant).await?)
}

#[tauri::command]
pub async fn assistant_models(state: State<'_, AppState>, provider: String) -> IpcResult<Vec<ModelInfo>> {
  Ok(providers::models(&state.assistant, &provider).await?)
}

/// Every tool the assistant (`external: false`) or an outside MCP client (`true`) gets.
#[tauri::command]
pub async fn assistant_tools(state: State<'_, AppState>, external: Option<bool>) -> IpcResult<Vec<ToolSpec>> {
  Ok(state.assistant.tool_specs(external.unwrap_or(false)).await)
}

/// `@` mentions: workspace files matching `query` (empty: newest first).
#[tauri::command]
pub async fn assistant_files_search(state: State<'_, AppState>, query: String, limit: Option<usize>) -> IpcResult<Vec<singl_core::assistant::files::FileHit>> {
  let Some(root) = state.assistant.workspace_root() else { return Ok(Vec::new()) };
  let limit = limit.unwrap_or(30).clamp(1, 200);
  Ok(tauri::async_runtime::spawn_blocking(move || singl_core::assistant::files::search(&root, &query, limit)).await.unwrap_or_default())
}

/// Skills the user can pick: `~/.claude/skills` and the workspace's `.claude/skills`.
#[tauri::command]
pub async fn assistant_skills(state: State<'_, AppState>) -> IpcResult<Vec<singl_core::assistant::skills::SkillInfo>> {
  let root = state.assistant.workspace_root();
  Ok(tauri::async_runtime::spawn_blocking(move || singl_core::assistant::skills::list(root.as_deref())).await.unwrap_or_default())
}

#[tauri::command]
pub async fn assistant_mcp_info(state: State<'_, AppState>) -> IpcResult<McpInfo> {
  Ok(state.assistant.mcp_info().await?)
}

#[tauri::command]
pub async fn assistant_mcp_servers(state: State<'_, AppState>) -> IpcResult<Vec<McpServerStatus>> {
  let servers = state.assistant.mcp_servers().await?;
  Ok(state.assistant.mcp_clients.status(&servers).await)
}

/// Restarts one connected MCP server (or starts it), then reports every server.
#[tauri::command]
pub async fn assistant_mcp_restart(state: State<'_, AppState>, name: String) -> IpcResult<Vec<McpServerStatus>> {
  state.assistant.mcp_clients.restart(&name).await;
  let servers = state.assistant.mcp_servers().await?;
  let _ = state.assistant.mcp_clients.tools(&servers).await;
  Ok(state.assistant.mcp_clients.status(&servers).await)
}
