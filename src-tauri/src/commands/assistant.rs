//! The app-wide AI assistant (singl-core `assistant`). Events come back as
//! the Tauri event `assistant://event` (see `lib.rs`), not per command.

use serde_json::Value;
use singl_core::assistant::{ApprovalMode, TurnModes};
use singl_core::assistant::context::ScreenContext;
use singl_core::assistant::mcp::client::McpServerStatus;
use singl_core::assistant::mcp::{McpInfo, discovery_path};
use singl_core::assistant::prompt::{Suggestion, suggestions};
use singl_core::assistant::providers::{self, ProviderInfo};
use singl_core::assistant::runner::SendRequest;
use singl_core::assistant::settings::{self, AssistantSettingsPatch, AssistantSettingsView};
use singl_core::assistant::tools::ToolSpec;
use singl_core::assistant::types::{Chat, ChatSummary, ModelInfo};
use singl_core::assistant::{ApprovalAnswer, store, usage};
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

/// Stops one running sub-agent (its `agent_task` call); the turn goes on.
#[tauri::command]
pub fn assistant_stop_sub_agent(state: State<'_, AppState>, call_id: String) -> bool {
  state.assistant.stop_sub_agent(&call_id)
}

/// Adds a message to a chat's running turn. False when it cannot take one:
/// the page then queues it as the next message.
#[tauri::command]
pub fn assistant_steer(state: State<'_, AppState>, chat_id: String, text: String) -> bool {
  state.assistant.steer(&chat_id, &text)
}

/// Changes the approval mode of a chat's running turn (the composer's picker).
#[tauri::command]
pub fn assistant_turn_mode(
  state: State<'_, AppState>,
  chat_id: String,
  mode: ApprovalMode,
  server_mode: Option<ApprovalMode>,
) -> bool {
  state.assistant.change_turn_mode(&chat_id, TurnModes { local: mode, server: server_mode.unwrap_or(mode) })
}

#[tauri::command]
pub fn assistant_running_chats(state: State<'_, AppState>) -> Vec<String> {
  state.assistant.running_chats()
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
  let touches_servers = patch.mcp_servers.is_some() || patch.use_project_mcp.is_some() || patch.project_mcp_root.is_some() || patch.disabled_project_servers.is_some();
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

/// Browser OAuth sign-in for an HTTP MCP server, then reports every server.
#[tauri::command]
pub async fn assistant_mcp_sign_in(
  state: State<'_, AppState>,
  name: String,
  client_id: Option<String>,
  client_secret: Option<String>,
) -> IpcResult<Vec<McpServerStatus>> {
  state.assistant.mcp_sign_in(&name, client_id, client_secret).await?;
  let servers = state.assistant.mcp_servers().await?;
  let _ = state.assistant.mcp_clients.tools(&servers).await;
  Ok(state.assistant.mcp_clients.status(&servers).await)
}

#[tauri::command]
pub async fn assistant_mcp_sign_out(state: State<'_, AppState>, name: String) -> IpcResult<Vec<McpServerStatus>> {
  state.assistant.mcp_sign_out(&name).await?;
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

/// The MCP client tool profiles and the tool groups they pick from.
#[tauri::command]
pub async fn assistant_mcp_profiles_get(state: State<'_, AppState>) -> IpcResult<Value> {
  let profiles = state.assistant.settings().await?.mcp_profiles;
  Ok(serde_json::json!({ "profiles": profiles, "groups": singl_core::assistant::mcp::profiles::GROUPS }))
}

#[tauri::command]
pub async fn assistant_mcp_profiles_set(
  state: State<'_, AppState>,
  profiles: Vec<singl_core::assistant::mcp::profiles::McpProfile>,
) -> IpcResult<Vec<singl_core::assistant::mcp::profiles::McpProfile>> {
  settings::set_mcp_profiles(&state.db().await, profiles).await?;
  Ok(state.assistant.settings().await?.mcp_profiles)
}

/// Token use and cost of one chat.
#[tauri::command]
pub async fn assistant_usage_chat(state: State<'_, AppState>, chat_id: String) -> IpcResult<usage::Totals> {
  Ok(usage::for_chat(&state.db().await, &chat_id).await?)
}

/// Token use and cost of the last `days` days (default 30), by model and by day.
#[tauri::command]
pub async fn assistant_usage_summary(state: State<'_, AppState>, days: Option<i64>) -> IpcResult<usage::UsageSummary> {
  Ok(usage::summary(&state.db().await, days.unwrap_or(30)).await?)
}

/// Every recorded model call (or CLI turn) of one chat, oldest first.
#[tauri::command]
pub async fn assistant_usage_calls(state: State<'_, AppState>, chat_id: String) -> IpcResult<Vec<usage::CallUsage>> {
  Ok(usage::calls(&state.db().await, &chat_id).await?)
}

/// Undoes the local entity file change of one assistant tool call (the Undo button on its card).
#[tauri::command]
pub async fn assistant_entity_undo(state: State<'_, AppState>, call_id: String) -> IpcResult<String> {
  Ok(singl_core::assistant::snapshots::undo(&state.assistant, &call_id, None).await?)
}

// ---- MCP client: tool filters, resources, prompts, elicitation, call log --------

/// Every tool of the running MCP servers with its on / hidden state, for the Settings page.
#[tauri::command]
pub async fn assistant_mcp_tools(state: State<'_, AppState>) -> IpcResult<Vec<singl_core::assistant::mcp::client::McpToolInfo>> {
  Ok(state.assistant.mcp_tool_infos().await?)
}

/// Switches off exactly `tools` (the server's own names) of `server`; takes effect without a restart.
#[tauri::command]
pub async fn assistant_mcp_set_disabled_tools(
  state: State<'_, AppState>,
  server: String,
  tools: Vec<String>,
) -> IpcResult<Vec<singl_core::assistant::mcp::client::McpToolInfo>> {
  settings::set_disabled_tools(&state.db().await, &server, tools).await?;
  Ok(state.assistant.mcp_tool_infos().await?)
}

/// Resources of the running servers (`templates`: their URI templates instead).
#[tauri::command]
pub async fn assistant_mcp_resources(
  state: State<'_, AppState>,
  templates: Option<bool>,
) -> IpcResult<Vec<singl_core::assistant::mcp::features::McpResource>> {
  Ok(state.assistant.mcp_resources(templates.unwrap_or(false)).await?)
}

/// Reads one resource as text (logged in the call log).
#[tauri::command]
pub async fn assistant_mcp_resource_read(
  state: State<'_, AppState>,
  server: String,
  uri: String,
) -> IpcResult<singl_core::assistant::mcp::features::McpResourceText> {
  Ok(state.assistant.mcp_clients.read_resource(&server, &uri).await?)
}

/// Prompts of the running servers.
#[tauri::command]
pub async fn assistant_mcp_prompts(state: State<'_, AppState>) -> IpcResult<Vec<singl_core::assistant::mcp::features::McpPrompt>> {
  Ok(state.assistant.mcp_prompts().await?)
}

/// Expands a prompt with its arguments into message text.
#[tauri::command]
pub async fn assistant_mcp_prompt_get(
  state: State<'_, AppState>,
  server: String,
  name: String,
  arguments: Option<std::collections::HashMap<String, String>>,
) -> IpcResult<singl_core::assistant::mcp::features::McpPromptResult> {
  Ok(state.assistant.mcp_clients.get_prompt(&server, &name, arguments.unwrap_or_default()).await?)
}

/// Answers an `elicitationRequest` event; `action` is `accept`, `decline` or `cancel`.
#[tauri::command]
pub fn assistant_mcp_elicit_reply(state: State<'_, AppState>, request_id: String, action: String, content: Option<Value>) -> bool {
  state.assistant.mcp_elicit_reply(&request_id, singl_core::assistant::mcp::host::ElicitAnswer { action, content })
}

/// The last 500 calls the MCP clients made, newest first.
#[tauri::command]
pub fn assistant_mcp_call_log() -> Vec<singl_core::assistant::mcp::host::CallLogEntry> {
  singl_core::assistant::mcp::host::call_log()
}

#[tauri::command]
pub fn assistant_mcp_call_log_clear() {
  singl_core::assistant::mcp::host::clear_call_log();
}

// ---- Memory: facts the assistant keeps across chats ------------------------

#[tauri::command]
pub async fn assistant_memories(state: State<'_, AppState>) -> IpcResult<Vec<singl_core::assistant::memory::Memory>> {
  Ok(singl_core::assistant::memory::list(&state.assistant.pool().await).await?)
}

#[tauri::command]
pub async fn assistant_memory_update(
  state: State<'_, AppState>,
  id: String,
  text: String,
) -> IpcResult<singl_core::assistant::memory::Memory> {
  Ok(singl_core::assistant::memory::update(&state.assistant.pool().await, &id, &text).await?)
}

#[tauri::command]
pub async fn assistant_memory_delete(state: State<'_, AppState>, id: String) -> IpcResult<()> {
  Ok(singl_core::assistant::memory::delete(&state.assistant.pool().await, &id).await?)
}
