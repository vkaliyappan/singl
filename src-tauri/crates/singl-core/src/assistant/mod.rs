//! The app-wide AI assistant.
//!
//! Everything but drawing lives here: the tool registry ([`tools`]), the
//! agent loop ([`runner`]) over every provider ([`providers`]), chat history
//! ([`store`]), screen context ([`context`]), approvals, the app's own MCP
//! server and the MCP clients for project servers ([`mcp`]).
//!
//! The UI talks to it through the app crate's `assistant_*` commands and
//! hears back through [`AssistantEvent`]s. A page can only do two things the
//! backend cannot: report what is on screen ([`context::ScreenContext`]) and
//! carry out UI actions ([`Assistant::ui_request`]).

pub mod bridge;
pub mod context;
pub mod events;
pub mod files;
pub mod mcp;
pub mod prompt;
pub mod providers;
pub mod runner;
pub mod settings;
pub mod skills;
pub mod store;
pub mod tools;
pub mod types;

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, Mutex, RwLock};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::SqlitePool;
use tokio_util::sync::CancellationToken;

use crate::agents::process::ProcRegistry;
use crate::workspace::Workspace;
use crate::{CoreError, Result};
use bridge::Pending;
use context::ContextStore;
use events::AssistantEvent;
use settings::{AssistantSettings, McpServerConfig};
use tools::{CallMeta, Risk, Tool, ToolSpec};
use types::Block;

pub type EventSink = Arc<dyn Fn(AssistantEvent) + Send + Sync>;

/// How a turn's tool calls are approved, picked per message in the composer.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ApprovalMode {
  /// Read tools run; write and destructive ones ask (writes run when Settings auto-approves them).
  #[default]
  Ask,
  /// Everything runs without asking, destructive included.
  Auto,
  /// Only read tools exist for the turn; anything else is refused.
  ReadOnly,
}

/// Tool output past this is cut before it reaches a model.
const TOOL_OUTPUT_LIMIT: usize = 100_000;
const APPROVAL_TIMEOUT: Duration = Duration::from_secs(600);
const UI_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalAnswer {
  pub approved: bool,
  /// Stop asking for the rest of this chat (or, for MCP clients, this app session).
  #[serde(default)]
  pub always: bool,
}

/// Where the app's MCP server listens.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpEndpoint {
  pub url: String,
  pub token: String,
}

pub struct Assistant {
  db: Arc<tokio::sync::RwLock<SqlitePool>>,
  workspace: Arc<RwLock<Workspace>>,
  pub procs: ProcRegistry,
  pub context: ContextStore,
  pub mcp_clients: mcp::client::McpClients,
  sink: RwLock<Option<EventSink>>,
  ui: Pending<std::result::Result<Value, String>>,
  approvals: Pending<ApprovalAnswer>,
  tools: Vec<Tool>,
  /// Chats with a turn in progress, to cancel them.
  running: Mutex<HashMap<String, CancellationToken>>,
  /// Per-turn MCP tokens handed to agent CLIs, mapped to their chat.
  turn_tokens: Mutex<HashMap<String, String>>,
  /// Tool calls made over MCP during a CLI turn, by chat, so the turn can store them.
  collected: Mutex<HashMap<String, Vec<(Block, Block)>>>,
  /// Approval mode of a chat's running turn.
  turn_modes: Mutex<HashMap<String, ApprovalMode>>,
  /// Tools a chat's running turn may use, when the user narrowed them.
  turn_tools: Mutex<HashMap<String, Vec<String>>>,
  /// Chats (or `"mcp"`) where the user said "don't ask again".
  allow_all: Mutex<HashSet<String>>,
  mcp_endpoint: RwLock<Option<McpEndpoint>>,
}

impl Assistant {
  pub fn new(db: Arc<tokio::sync::RwLock<SqlitePool>>, workspace: Arc<RwLock<Workspace>>, procs: ProcRegistry) -> Arc<Self> {
    Arc::new(Self {
      db,
      workspace,
      procs,
      context: ContextStore::default(),
      mcp_clients: Default::default(),
      sink: RwLock::new(None),
      ui: Pending::default(),
      approvals: Pending::default(),
      tools: tools::builtin(),
      running: Mutex::new(HashMap::new()),
      turn_tokens: Mutex::new(HashMap::new()),
      collected: Mutex::new(HashMap::new()),
      turn_tools: Mutex::new(HashMap::new()),
      turn_modes: Mutex::new(HashMap::new()),
      allow_all: Mutex::new(HashSet::new()),
      mcp_endpoint: RwLock::new(None),
    })
  }

  /// Where events go: the app crate forwards them to the window.
  pub fn set_sink(&self, sink: EventSink) {
    *self.sink.write().unwrap_or_else(|e| e.into_inner()) = Some(sink);
  }

  fn has_ui(&self) -> bool {
    self.sink.read().unwrap_or_else(|e| e.into_inner()).is_some()
  }

  pub fn emit(&self, event: AssistantEvent) {
    let sink = self.sink.read().unwrap_or_else(|e| e.into_inner()).clone();
    if let Some(sink) = sink {
      sink(event);
    }
  }

  pub async fn pool(&self) -> SqlitePool {
    self.db.read().await.clone()
  }

  pub fn workspace_root(&self) -> Option<PathBuf> {
    self.workspace.read().unwrap_or_else(|e| e.into_inner()).root().map(PathBuf::from)
  }

  pub fn workspace(&self) -> Workspace {
    self.workspace.read().unwrap_or_else(|e| e.into_inner()).clone()
  }

  pub async fn settings(&self) -> Result<AssistantSettings> {
    settings::load(&self.pool().await).await
  }

  // ---- UI round trips -------------------------------------------------------

  /// Asks the window to do `action` and waits for its answer.
  pub async fn ui_request(&self, action: &str, args: Value) -> Result<Value> {
    if !self.has_ui() {
      return Err(CoreError::Invalid("The singl window is not open, so UI actions are unavailable.".into()));
    }
    let (request_id, rx) = self.ui.open();
    self.emit(AssistantEvent::UiRequest { request_id: request_id.clone(), action: action.into(), args });
    match tokio::time::timeout(UI_TIMEOUT, rx).await {
      Ok(Ok(Ok(value))) => Ok(value),
      Ok(Ok(Err(message))) => Err(CoreError::Invalid(message)),
      _ => {
        self.ui.forget(&request_id);
        Err(CoreError::Invalid(format!("The window did not answer \"{action}\" in time.")))
      }
    }
  }

  pub fn ui_reply(&self, request_id: &str, result: std::result::Result<Value, String>) -> bool {
    self.ui.resolve(request_id, result)
  }

  // ---- approvals ------------------------------------------------------------

  pub fn approve(&self, request_id: &str, answer: ApprovalAnswer) -> bool {
    let resolved = self.approvals.resolve(request_id, answer);
    if resolved {
      self.emit(AssistantEvent::ApprovalResolved { request_id: request_id.into(), approved: answer.approved });
    }
    resolved
  }

  fn allow_key(meta: &CallMeta) -> String {
    meta.chat_id.clone().unwrap_or_else(|| meta.source.clone())
  }

  /// Whether a call may run, asking the user when its risk needs it.
  async fn permit(&self, name: &str, input: &Value, risk: Risk, meta: &CallMeta) -> Result<bool> {
    if risk == Risk::Read {
      return Ok(true);
    }
    let mode = match meta.chat_id.as_deref() {
      Some(chat) => self.turn_mode(Some(chat)),
      None => self.settings().await?.external_mcp_mode,
    };
    match mode {
      ApprovalMode::Auto => return Ok(true),
      ApprovalMode::ReadOnly => {
        return Err(CoreError::Invalid(format!("{name} changes things, and this message is in read-only mode.")));
      }
      ApprovalMode::Ask => {}
    }
    let key = Self::allow_key(meta);
    if self.allow_all.lock().unwrap_or_else(|e| e.into_inner()).contains(&key) {
      return Ok(true);
    }
    if risk == Risk::Write && self.settings().await?.auto_approve_writes {
      return Ok(true);
    }
    if !self.has_ui() {
      return Ok(false);
    }
    let (request_id, rx) = self.approvals.open();
    self.emit(AssistantEvent::ApprovalRequest {
      request_id: request_id.clone(),
      chat_id: meta.chat_id.clone(),
      tool: name.into(),
      input: input.clone(),
      risk,
      source: meta.source.clone(),
    });
    let cancel = meta.chat_id.as_deref().and_then(|c| self.running.lock().unwrap_or_else(|e| e.into_inner()).get(c).cloned());
    let wait = async {
      match cancel {
        Some(token) => tokio::select! {
          r = rx => r.ok(),
          () = token.cancelled() => None,
        },
        None => rx.await.ok(),
      }
    };
    let answer = tokio::time::timeout(APPROVAL_TIMEOUT, wait).await.ok().flatten();
    let Some(answer) = answer else {
      self.approvals.forget(&request_id);
      self.emit(AssistantEvent::ApprovalResolved { request_id, approved: false });
      return Ok(false);
    };
    if answer.approved && answer.always {
      self.allow_all.lock().unwrap_or_else(|e| e.into_inner()).insert(key);
    }
    Ok(answer.approved)
  }

  // ---- tools ----------------------------------------------------------------

  /// MCP servers the assistant connects to: Settings-page ones, then the
  /// workspace's `.mcp.json` (a Settings-page server of the same name wins).
  pub async fn mcp_servers(&self) -> Result<Vec<McpServerConfig>> {
    let settings = self.settings().await?;
    let mut servers: Vec<McpServerConfig> = settings
      .mcp_servers
      .iter()
      .cloned()
      .map(|mut s| {
        s.source = "app".into();
        s
      })
      .collect();
    if settings.use_project_mcp {
      if let Some(root) = self.workspace_root() {
        for mut s in settings::project_servers(&root) {
          if servers.iter().any(|o| o.name == s.name) {
            continue;
          }
          if settings.disabled_project_servers.contains(&s.name) {
            s.enabled = false;
          }
          servers.push(s);
        }
      }
    }
    Ok(servers)
  }

  /// Every tool: built-in ones, then those of connected MCP servers.
  /// `external` includes tools meant only for outside MCP clients.
  pub async fn tool_specs(&self, external: bool) -> Vec<ToolSpec> {
    let mut specs: Vec<ToolSpec> =
      self.tools.iter().filter(|t| external || !t.spec.external_only).map(|t| t.spec.clone()).collect();
    match self.mcp_servers().await {
      Ok(servers) => specs.extend(self.mcp_clients.tools(&servers).await),
      Err(e) => log_warn(&format!("assistant: MCP servers unavailable: {e}")),
    }
    // Outside clients in read-only mode only see read tools.
    if external && self.settings().await.map(|s| s.external_mcp_mode == ApprovalMode::ReadOnly).unwrap_or(false) {
      specs.retain(|t| t.risk == Risk::Read);
    }
    specs
  }

  /// Whether a chat's running turn may use `name` (always true outside a turn
  /// or when the user did not narrow the tools).
  pub fn tool_allowed(&self, chat_id: Option<&str>, name: &str) -> bool {
    let Some(chat_id) = chat_id else { return true };
    match self.turn_tools.lock().unwrap_or_else(|e| e.into_inner()).get(chat_id) {
      Some(allowed) => allowed.iter().any(|a| a == name),
      None => true,
    }
  }

  pub fn turn_mode(&self, chat_id: Option<&str>) -> ApprovalMode {
    chat_id
      .and_then(|c| self.turn_modes.lock().unwrap_or_else(|e| e.into_inner()).get(c).copied())
      .unwrap_or_default()
  }

  pub(crate) fn set_turn_mode(&self, chat_id: &str, mode: Option<ApprovalMode>) {
    let mut map = self.turn_modes.lock().unwrap_or_else(|e| e.into_inner());
    match mode {
      Some(m) => map.insert(chat_id.to_string(), m),
      None => map.remove(chat_id),
    };
  }

  pub(crate) fn set_turn_tools(&self, chat_id: &str, tools: Option<Vec<String>>) {
    let mut map = self.turn_tools.lock().unwrap_or_else(|e| e.into_inner());
    match tools {
      Some(list) => map.insert(chat_id.to_string(), list),
      None => map.remove(chat_id),
    };
  }

  /// The tools a chat's turn sees: [`Self::tool_specs`] narrowed to its selection.
  pub async fn tool_specs_for(&self, chat_id: &str) -> Vec<ToolSpec> {
    let specs = self.tool_specs(false).await;
    let read_only = self.turn_mode(Some(chat_id)) == ApprovalMode::ReadOnly;
    specs
      .into_iter()
      .filter(|t| self.tool_allowed(Some(chat_id), &t.name))
      .filter(|t| !read_only || t.risk == Risk::Read)
      .collect()
  }

  /// The risk of one call. `run_ui_action` takes the risk the page declared.
  fn risk_of(&self, name: &str, args: &Value, fallback: Risk) -> Risk {
    if name == "run_ui_action" {
      let action = args.get("action").and_then(Value::as_str).unwrap_or_default();
      return self.context.get().actions.iter().find(|a| a.name == action).map(|a| a.risk).unwrap_or(Risk::Write);
    }
    fallback
  }

  /// Runs a tool after any approval it needs. Returns its output and whether it failed.
  pub async fn call_tool(self: &Arc<Self>, name: &str, args: Value, meta: CallMeta) -> (String, bool) {
    self.emit(AssistantEvent::ToolCall {
      chat_id: meta.chat_id.clone(),
      call_id: meta.call_id.clone(),
      name: name.into(),
      input: args.clone(),
      source: meta.source.clone(),
    });
    let (content, is_error) = match self.run_tool(name, &args, &meta).await {
      Ok(out) => (context::clip(&out, TOOL_OUTPUT_LIMIT), false),
      Err(e) => (e.to_string(), true),
    };
    self.emit(AssistantEvent::ToolResult {
      chat_id: meta.chat_id.clone(),
      call_id: meta.call_id.clone(),
      content: content.clone(),
      is_error,
    });
    // An agent CLI's calls arrive over MCP; keep them so its turn can store them.
    if meta.source == "assistant" {
      if let Some(chat_id) = &meta.chat_id {
        if let Some(list) = self.collected.lock().unwrap_or_else(|e| e.into_inner()).get_mut(chat_id) {
          list.push((
            Block::ToolUse { id: meta.call_id.clone(), name: name.into(), input: args },
            Block::ToolResult { tool_use_id: meta.call_id.clone(), content: content.clone(), is_error },
          ));
        }
      }
    }
    (content, is_error)
  }

  async fn run_tool(self: &Arc<Self>, name: &str, args: &Value, meta: &CallMeta) -> Result<String> {
    let args = if args.is_null() { json!({}) } else { args.clone() };
    if !self.tool_allowed(meta.chat_id.as_deref(), name) {
      return Err(CoreError::Invalid(format!("{name} is switched off for this message.")));
    }
    if let Some(tool) = self.tools.iter().find(|t| t.spec.name == name) {
      if tool.spec.external_only && meta.source == "assistant" {
        return Err(CoreError::Invalid(format!("{name} is not available inside an assistant turn.")));
      }
      let risk = self.risk_of(name, &args, tool.spec.risk);
      if !self.permit(name, &args, risk, meta).await? {
        return Err(CoreError::Invalid("The user declined this action.".into()));
      }
      return (tool.handler)(self.clone(), args, meta.clone()).await;
    }
    if name.contains("__") {
      let servers = self.mcp_servers().await?;
      let risk = self.mcp_clients.risk_for(&servers, name).await;
      if !self.permit(name, &args, risk, meta).await? {
        return Err(CoreError::Invalid("The user declined this action.".into()));
      }
      return self.mcp_clients.call(&servers, name, args).await;
    }
    Err(CoreError::Invalid(format!("Unknown tool \"{name}\".")))
  }

  // ---- turns ----------------------------------------------------------------

  /// Stops a chat's running turn. False when none runs.
  pub fn cancel(&self, chat_id: &str) -> bool {
    match self.running.lock().unwrap_or_else(|e| e.into_inner()).get(chat_id) {
      Some(token) => {
        token.cancel();
        true
      }
      None => false,
    }
  }

  /// Switches a running turn's approval mode, for calls it has not made yet.
  /// False when the chat has no turn running.
  pub fn change_turn_mode(&self, chat_id: &str, mode: ApprovalMode) -> bool {
    if !self.is_running(chat_id) {
      return false;
    }
    self.set_turn_mode(chat_id, Some(mode));
    true
  }

  /// Ids of the chats with a turn in progress.
  pub fn running_chats(&self) -> Vec<String> {
    self.running.lock().unwrap_or_else(|e| e.into_inner()).keys().cloned().collect()
  }

  pub fn is_running(&self, chat_id: &str) -> bool {
    self.running.lock().unwrap_or_else(|e| e.into_inner()).contains_key(chat_id)
  }

  /// Which chat a per-turn MCP token belongs to.
  pub fn chat_for_token(&self, token: &str) -> Option<String> {
    self.turn_tokens.lock().unwrap_or_else(|e| e.into_inner()).get(token).cloned()
  }

  pub fn mcp_endpoint(&self) -> Option<McpEndpoint> {
    self.mcp_endpoint.read().unwrap_or_else(|e| e.into_inner()).clone()
  }

  fn set_mcp_endpoint(&self, endpoint: Option<McpEndpoint>) {
    *self.mcp_endpoint.write().unwrap_or_else(|e| e.into_inner()) = endpoint;
  }

  /// Stops everything: running turns, project MCP servers.
  pub async fn shutdown(&self) {
    for token in self.running.lock().unwrap_or_else(|e| e.into_inner()).values() {
      token.cancel();
    }
    self.mcp_clients.shutdown_all().await;
  }
}

pub(crate) fn log_warn(message: &str) {
  eprintln!("{message}");
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::workspace::Workspace;

  async fn assistant() -> (tempfile::TempDir, Arc<Assistant>) {
    let dir = tempfile::tempdir().unwrap();
    let pool = crate::db::open(&dir.path().join("singl.db")).await.unwrap();
    let a = Assistant::new(
      Arc::new(tokio::sync::RwLock::new(pool)),
      Arc::new(RwLock::new(Workspace::new(None))),
      ProcRegistry::default(),
    );
    (dir, a)
  }

  fn meta(chat: &str) -> CallMeta {
    CallMeta { chat_id: Some(chat.into()), source: "assistant".into(), call_id: "c".into() }
  }

  #[tokio::test]
  async fn approval_modes() {
    let (_dir, a) = assistant().await;
    let input = json!({});
    // No UI attached: Ask denies writes, Auto runs them, ReadOnly refuses with an error.
    assert!(!a.permit("x", &input, Risk::Write, &meta("c1")).await.unwrap());
    a.set_turn_mode("c1", Some(ApprovalMode::Auto));
    assert!(a.permit("x", &input, Risk::Destructive, &meta("c1")).await.unwrap());
    a.set_turn_mode("c1", Some(ApprovalMode::ReadOnly));
    assert!(a.permit("x", &input, Risk::Write, &meta("c1")).await.is_err());
    assert!(a.permit("x", &input, Risk::Read, &meta("c1")).await.unwrap());
    let specs = a.tool_specs_for("c1").await;
    assert!(!specs.is_empty() && specs.iter().all(|t| t.risk == Risk::Read));
    a.set_turn_mode("c1", None);
    assert!(a.tool_specs_for("c1").await.iter().any(|t| t.risk != Risk::Read));
    // Outside clients follow Settings.
    let ext = CallMeta::external();
    settings::update(
      &a.pool().await,
      settings::AssistantSettingsPatch { external_mcp_mode: Some(ApprovalMode::ReadOnly), ..Default::default() },
    )
    .await
    .unwrap();
    assert!(a.permit("x", &input, Risk::Write, &ext).await.is_err());
    assert!(a.tool_specs(true).await.iter().all(|t| t.risk == Risk::Read));
  }
}
