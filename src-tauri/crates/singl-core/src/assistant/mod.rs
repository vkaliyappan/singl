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
pub mod compact;
pub mod context;
pub mod events;
pub mod files;
pub mod mcp;
pub mod memory;
pub mod prompt;
pub mod providers;
pub mod runner;
pub mod settings;
pub mod skills;
pub mod snapshots;
pub mod store;
pub mod subagents;
pub mod tools;
pub mod types;
pub mod usage;

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

/// Which approval setting a tool falls under.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ToolScope {
  /// Changes only this machine: entity files, flows, presets, the repo clone, screens.
  Local,
  /// Runs or changes something on a ThingWorx server.
  Server,
}

/// Tools that run services or write on a ThingWorx server. Exports only read
/// the server (and write local files), so they are `Local`.
const SERVER_TOOLS: &[&str] = &[
  "service_execute",
  "twx_invoke_service",
  "flow_run",
  "deploy_backup_deployment_files",
  "deploy_upload_deployment_files",
  "twx_set_property_values",
  "twx_set_subscription_enabled",
  "twx_fire_event",
  "twx_set_thing_enabled",
  "twx_import_entities",
  "automation_run_suite",
  // Saves locally, but the schedule later runs services or flows unattended.
  "automation_schedule_upsert",
];

pub fn scope_of(tool: &str) -> ToolScope {
  if SERVER_TOOLS.contains(&tool) { ToolScope::Server } else { ToolScope::Local }
}

/// A turn's approval modes: one for local changes, one for the ThingWorx server.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TurnModes {
  pub local: ApprovalMode,
  pub server: ApprovalMode,
}

impl TurnModes {
  pub fn same(mode: ApprovalMode) -> Self {
    Self { local: mode, server: mode }
  }

  pub fn for_tool(&self, tool: &str) -> ApprovalMode {
    match scope_of(tool) {
      ToolScope::Local => self.local,
      ToolScope::Server => self.server,
    }
  }

  /// Whether a tool is offered at all: read tools always, others unless their scope is read-only.
  fn offers(&self, tool: &str, risk: Risk) -> bool {
    risk == Risk::Read || self.for_tool(tool) != ApprovalMode::ReadOnly
  }
}

/// Tool output past this is cut before it reaches a model (bigger results are
/// already previewed by `tools::outputs::spill`; this only catches failures).
const TOOL_OUTPUT_LIMIT: usize = tools::outputs::SPILL_OVER + 4_000;
/// How much of a big result the chat itself shows.
const DISPLAY_LIMIT: usize = 100_000;

/// Forgets a sub-agent's stop token when it ends.
pub(crate) struct SubAgentGuard {
  assistant: Arc<Assistant>,
  call_id: String,
}

impl Drop for SubAgentGuard {
  fn drop(&mut self) {
    self.assistant.sub_agent_cancels.lock().unwrap_or_else(|e| e.into_inner()).remove(&self.call_id);
  }
}

/// One tool call's result.
#[derive(Debug, Clone)]
pub struct ToolOutcome {
  /// What the model reads.
  pub content: String,
  /// The fuller text the chat shows, when it differs from `content`.
  pub display: Option<String>,
  pub is_error: bool,
}

impl ToolOutcome {
  pub fn error(content: impl Into<String>) -> Self {
    Self { content: content.into(), display: None, is_error: true }
  }

  pub fn block(self, tool_use_id: String) -> Block {
    Block::ToolResult { tool_use_id, content: self.content, is_error: self.is_error, display: self.display }
  }
}
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
  /// Agent CLI processes kept running between a chat's turns, by chat.
  live_cli: Mutex<HashMap<String, runner::LiveChat>>,
  /// Tool calls made over MCP during a CLI turn, by chat, so the turn can store them.
  collected: Mutex<HashMap<String, Vec<(Block, Block)>>>,
  /// Approval mode of a chat's running turn.
  turn_modes: Mutex<HashMap<String, TurnModes>>,
  /// Tools a chat's running turn may use, when the user narrowed them.
  turn_tools: Mutex<HashMap<String, Vec<String>>>,
  /// Sub-agent settings and budget of a chat's running turn, when it may start them.
  turn_sub_agents: Mutex<HashMap<String, Arc<subagents::Turn>>>,
  /// Running sub-agents' own stop tokens, by the `agent_task` call that started them.
  sub_agent_cancels: Mutex<HashMap<String, CancellationToken>>,
  /// Messages the user sent into a running API turn, not yet read by it. An
  /// entry exists only while the turn can take them.
  steered: Mutex<HashMap<String, Vec<String>>>,
  /// Chats (or `"mcp"`) where the user said "don't ask again".
  allow_all: Mutex<HashSet<String>>,
  mcp_endpoint: RwLock<Option<McpEndpoint>>,
  /// MCP servers the app itself runs for a while (the UI tests' browser). Not stored in settings.
  transient_mcp: Mutex<Vec<McpServerConfig>>,
}

impl Assistant {
  pub fn new(db: Arc<tokio::sync::RwLock<SqlitePool>>, workspace: Arc<RwLock<Workspace>>, procs: ProcRegistry) -> Arc<Self> {
    let this = Arc::new(Self {
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
      live_cli: Mutex::new(HashMap::new()),
      collected: Mutex::new(HashMap::new()),
      turn_tools: Mutex::new(HashMap::new()),
      turn_modes: Mutex::new(HashMap::new()),
      turn_sub_agents: Mutex::new(HashMap::new()),
      sub_agent_cancels: Mutex::new(HashMap::new()),
      steered: Mutex::new(HashMap::new()),
      allow_all: Mutex::new(HashSet::new()),
      mcp_endpoint: RwLock::new(None),
      transient_mcp: Mutex::new(Vec::new()),
    });
    this.mcp_clients.set_host(Arc::downgrade(&this));
    this
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
    let modes = match meta.chat_id.as_deref() {
      Some(chat) => self.turn_mode(Some(chat)),
      None => self.settings().await?.external_modes(),
    };
    match modes.for_tool(name) {
      ApprovalMode::Auto => return Ok(true),
      ApprovalMode::ReadOnly => {
        return Err(CoreError::Invalid(match scope_of(name) {
          ToolScope::Server => {
            format!("{name} runs or changes things on the ThingWorx server, which is read-only for this message.")
          }
          ToolScope::Local => format!("{name} changes things, and this message is in read-only mode."),
        }));
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
      scope: scope_of(name),
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
  /// project MCP files (a Settings-page server of the same name wins).
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
      let root = match settings.project_mcp_root.as_str() {
        "" => self.workspace_root(),
        dir => Some(std::path::PathBuf::from(dir)),
      };
      if let Some(root) = root {
        for mut s in settings::project_servers(&root) {
          if servers.iter().any(|o| o.name == s.name) {
            continue;
          }
          if settings.disabled_project_servers.contains(&s.name) {
            s.enabled = false;
          }
          s.disabled_tools = settings.project_disabled_tools.get(&s.name).cloned().unwrap_or_default();
          servers.push(s);
        }
      }
    }
    self.attach_sign_ins(&settings, &mut servers).await;
    for t in self.transient_mcp.lock().unwrap_or_else(|e| e.into_inner()).iter() {
      servers.retain(|s| s.name != t.name);
      let mut t = t.clone();
      t.source = "transient".into();
      servers.push(t);
    }
    Ok(servers)
  }

  /// Adds (or replaces) a runtime-only MCP server. Its tools stay out of chats
  /// unless a turn lists them by name (see [`UITEST_PREFIX`]).
  pub fn set_transient_mcp(&self, cfg: McpServerConfig) {
    let mut list = self.transient_mcp.lock().unwrap_or_else(|e| e.into_inner());
    list.retain(|s| s.name != cfg.name);
    list.push(cfg);
  }

  /// Drops a runtime-only MCP server and stops it.
  pub async fn remove_transient_mcp(&self, name: &str) {
    self.transient_mcp.lock().unwrap_or_else(|e| e.into_inner()).retain(|s| s.name != name);
    self.mcp_clients.restart(name).await;
  }

  /// Adds the stored OAuth token to each HTTP server that has no `Authorization`
  /// header of its own, refreshing it first when it is about to expire.
  async fn attach_sign_ins(&self, settings: &AssistantSettings, servers: &mut [McpServerConfig]) {
    static REFRESH: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    for s in servers.iter_mut().filter(|s| !s.url.is_empty()) {
      if s.headers.keys().any(|k| k.eq_ignore_ascii_case("authorization")) {
        continue;
      }
      let Some(mut token) = settings.mcp_oauth.get(&s.url).filter(|t| t.signed_in()).cloned() else { continue };
      if token.expiring() {
        // One refresh at a time: a rotated refresh token works only once.
        let _gate = REFRESH.lock().await;
        let pool = self.pool().await;
        let current = settings::load(&pool).await.ok().and_then(|st| st.mcp_oauth.get(&s.url).cloned());
        match current {
          Some(t) if !t.expiring() => token = t,
          _ => match mcp::oauth::refresh(&s.url, &token).await {
            Ok(t) => {
              if let Err(e) = settings::set_oauth(&pool, &s.url, Some(t.clone())).await {
                log_warn(&format!("assistant MCP: could not save refreshed token for {}: {e}", s.name));
              }
              token = t;
            }
            Err(e) => log_warn(&format!("assistant MCP: refreshing the sign-in for {} failed: {e}", s.name)),
          },
        }
      }
      s.headers.insert("Authorization".into(), format!("Bearer {}", token.access_token));
      s.signed_in = true;
    }
  }

  /// Browser sign-in for the HTTP server `name`; restarts it with the new token.
  pub async fn mcp_sign_in(&self, name: &str, client_id: Option<String>, client_secret: Option<String>) -> Result<()> {
    let servers = self.mcp_servers().await?;
    let s = servers.iter().find(|s| s.name == name).ok_or_else(|| CoreError::Invalid(format!("No MCP server \"{name}\".")))?;
    if s.url.is_empty() {
      return Err(CoreError::Invalid(format!("\"{name}\" is not an HTTP server; it has nothing to sign in to.")));
    }
    let pool = self.pool().await;
    let known = settings::load(&pool).await?.mcp_oauth.get(&s.url).cloned();
    let token = mcp::oauth::sign_in(&s.url, client_id, client_secret, known.as_ref()).await?;
    settings::set_oauth(&pool, &s.url, Some(token)).await?;
    self.mcp_clients.restart(name).await;
    Ok(())
  }

  /// Forgets the sign-in for `name` (its client id too, so a new one can be entered).
  pub async fn mcp_sign_out(&self, name: &str) -> Result<()> {
    let servers = self.mcp_servers().await?;
    if let Some(s) = servers.iter().find(|s| s.name == name && !s.url.is_empty()) {
      settings::set_oauth(&self.pool().await, &s.url, None).await?;
    }
    self.mcp_clients.restart(name).await;
    Ok(())
  }

  /// Every tool: built-in ones, then those of connected MCP servers.
  /// `external` includes tools meant only for outside MCP clients.
  pub async fn tool_specs(&self, external: bool) -> Vec<ToolSpec> {
    let mut specs = self.all_tool_specs(external).await;
    specs.retain(|t| !is_hidden_tool(&t.name));
    specs
  }

  async fn all_tool_specs(&self, external: bool) -> Vec<ToolSpec> {
    let mut specs: Vec<ToolSpec> =
      self.tools.iter().filter(|t| external || !t.spec.external_only).map(|t| t.spec.clone()).collect();
    self.mcp_clients.sync_roots(&self.mcp_roots().await).await;
    match self.mcp_servers().await {
      Ok(servers) => specs.extend(self.mcp_clients.tools(&servers).await),
      Err(e) => log_warn(&format!("assistant: MCP servers unavailable: {e}")),
    }
    // Outside clients only see the changes their modes allow.
    if external {
      let modes = self.settings().await.map(|s| s.external_modes()).unwrap_or_default();
      specs.retain(|t| modes.offers(&t.name, t.risk));
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

  /// Whether the chat's turn names `name` in its narrowed tool list.
  fn turn_lists(&self, chat_id: &str, name: &str) -> bool {
    self.turn_tools.lock().unwrap_or_else(|e| e.into_inner()).get(chat_id).is_some_and(|l| l.iter().any(|a| a == name))
  }

  pub fn turn_mode(&self, chat_id: Option<&str>) -> TurnModes {
    chat_id
      .and_then(|c| self.turn_modes.lock().unwrap_or_else(|e| e.into_inner()).get(c).copied())
      .unwrap_or_default()
  }

  pub(crate) fn set_turn_mode(&self, chat_id: &str, mode: Option<TurnModes>) {
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

  pub(crate) fn set_sub_agent_turn(&self, chat_id: &str, turn: Option<Arc<subagents::Turn>>) {
    let mut map = self.turn_sub_agents.lock().unwrap_or_else(|e| e.into_inner());
    match turn {
      Some(t) => map.insert(chat_id.to_string(), t),
      None => map.remove(chat_id),
    };
  }

  /// The running turn's sub-agent budget; `None` when it may not start any.
  pub fn sub_agent_turn(&self, chat_id: &str) -> Option<Arc<subagents::Turn>> {
    self.turn_sub_agents.lock().unwrap_or_else(|e| e.into_inner()).get(chat_id).cloned()
  }

  /// The cancel token of a chat's running turn.
  pub(crate) fn turn_cancel(&self, chat_id: &str) -> Option<CancellationToken> {
    self.running.lock().unwrap_or_else(|e| e.into_inner()).get(chat_id).cloned()
  }

  /// The tools a chat's turn is offered: see [`Self::offered_specs`].
  pub async fn tool_specs_for(&self, chat_id: &str) -> Vec<ToolSpec> {
    self.offered_specs(chat_id).await.0
  }

  /// `(offered, available)`. Available is every tool the turn may use;
  /// offered is the part sent with each model call: the `core` tools and the
  /// screen's groups, with `tools_find` / `tools_call` reaching the rest. A
  /// turn whose tools the user picked, or Settings → "Load all tools", gets
  /// everything it may use.
  pub async fn offered_specs(&self, chat_id: &str) -> (Vec<ToolSpec>, Vec<ToolSpec>) {
    let all = self.available_specs(chat_id).await;
    let is_meta = |t: &ToolSpec| t.name == tools::catalog::FIND || t.name == tools::catalog::CALL;
    let narrowed = self.turn_tools.lock().unwrap_or_else(|e| e.into_inner()).contains_key(chat_id);
    let load_all = self.settings().await.map(|s| s.load_all_tools).unwrap_or(false);
    if narrowed || load_all {
      return (all.iter().filter(|t| !is_meta(t)).cloned().collect(), all);
    }
    let groups = self.screen_groups();
    let (mut offered, hidden): (Vec<&ToolSpec>, Vec<&ToolSpec>) = all.iter().partition(|t| {
      let g = self.tool_group(&t.name);
      g == tools::catalog::CORE || groups.contains(&g.as_str())
    });
    let mut offered: Vec<ToolSpec> = if hidden.is_empty() {
      offered.retain(|t| !is_meta(t));
      offered.into_iter().cloned().collect()
    } else {
      let find = tools::catalog::find_description(&hidden, |n| self.tool_group(n));
      offered
        .into_iter()
        .cloned()
        .map(|mut t| {
          if t.name == tools::catalog::FIND {
            t.description = find.clone();
          }
          t
        })
        .collect()
    };
    offered.sort_by_key(|t| is_meta(t));
    (offered, all)
  }

  /// A tool's group: its built-in group, the MCP server it comes from, or `core`.
  pub fn tool_group(&self, name: &str) -> String {
    if let Some(server) = tools::catalog::mcp_group(name) {
      return server.to_string();
    }
    self.tools.iter().find(|t| t.spec.name == name).map_or(tools::catalog::CORE, |t| t.group).to_string()
  }

  /// The tool groups the current screen lists.
  fn screen_groups(&self) -> &'static [&'static str] {
    let ctx = self.context.get();
    if ctx.screen.is_empty() && ctx.route.is_empty() {
      return tools::catalog::DEFAULT_GROUPS;
    }
    let screen = if ctx.screen.is_empty() { prompt::screen_for_route(&ctx.route) } else { ctx.screen };
    prompt::profile(&screen).map_or(tools::catalog::DEFAULT_GROUPS, |p| p.tools)
  }

  /// Every tool a chat's turn may use: [`Self::tool_specs`] narrowed to its
  /// selection, plus `agent_task` when the turn may start sub-agents (the
  /// composer's sub-agent switch decides that, not the tool selection).
  pub async fn available_specs(&self, chat_id: &str) -> Vec<ToolSpec> {
    let specs = self.all_tool_specs(false).await;
    let modes = self.turn_mode(Some(chat_id));
    let mut out: Vec<ToolSpec> = specs
      .into_iter()
      .filter(|t| self.tool_allowed(Some(chat_id), &t.name))
      .filter(|t| !is_hidden_tool(&t.name) || self.turn_lists(chat_id, &t.name))
      .filter(|t| modes.offers(&t.name, t.risk))
      .collect();
    if let Some(turn) = self.sub_agent_turn(chat_id) {
      out.push(subagents::spec(&turn.settings));
    }
    out
  }

  /// The risk of one call. `run_ui_action` takes the risk the page declared.
  fn risk_of(&self, name: &str, args: &Value, fallback: Risk) -> Risk {
    if name == "run_ui_action" {
      let action = args.get("action").and_then(Value::as_str).unwrap_or_default();
      return self.context.get().actions.iter().find(|a| a.name == action).map(|a| a.risk).unwrap_or(Risk::Write);
    }
    fallback
  }

  /// Runs a tool after any approval it needs.
  pub async fn call_tool(self: &Arc<Self>, name: &str, args: Value, meta: CallMeta) -> ToolOutcome {
    // `tools_call` runs the tool it names, as if that were called directly.
    let unwrapped = (name == tools::catalog::CALL).then(|| tools::catalog::unwrap(&args));
    let (name, args, failed) = match unwrapped {
      Some(Ok((inner, input))) => (inner, input, None),
      Some(Err(e)) => (name.to_string(), args, Some(e)),
      None => (name.to_string(), args, None),
    };
    let name = name.as_str();
    self.emit(AssistantEvent::ToolCall {
      chat_id: meta.chat_id.clone(),
      call_id: meta.call_id.clone(),
      name: name.into(),
      input: args.clone(),
      source: meta.source.clone(),
    });
    let run = match failed {
      Some(e) => Err(e),
      None => self.run_tool(name, &args, &meta).await,
    };
    let outcome = match run {
      // Big results are saved for `tool_output_query`; the model gets a preview, the chat more.
      Ok(out) => {
        let display = (out.len() > tools::outputs::SPILL_OVER).then(|| context::clip(&out, DISPLAY_LIMIT));
        let content = context::clip(&tools::outputs::spill(&meta.call_id, name, out), TOOL_OUTPUT_LIMIT);
        ToolOutcome { content, display, is_error: false }
      }
      Err(e) => ToolOutcome::error(e.to_string()),
    };
    self.emit(AssistantEvent::ToolResult {
      chat_id: meta.chat_id.clone(),
      call_id: meta.call_id.clone(),
      content: outcome.display.clone().unwrap_or_else(|| outcome.content.clone()),
      is_error: outcome.is_error,
    });
    // An agent CLI's calls arrive over MCP; keep them so its turn can store them.
    if meta.source == "assistant" {
      if let Some(chat_id) = &meta.chat_id {
        if let Some(list) = self.collected.lock().unwrap_or_else(|e| e.into_inner()).get_mut(chat_id) {
          list.push((
            Block::ToolUse { id: meta.call_id.clone(), name: name.into(), input: args },
            outcome.clone().block(meta.call_id.clone()),
          ));
        }
      }
    }
    outcome
  }

  async fn run_tool(self: &Arc<Self>, name: &str, args: &Value, meta: &CallMeta) -> Result<String> {
    let args = if args.is_null() { json!({}) } else { args.clone() };
    if name == subagents::TOOL {
      return subagents::run(self.clone(), args, meta.clone()).await;
    }
    if !self.tool_allowed(meta.chat_id.as_deref(), name) {
      return Err(CoreError::Invalid(format!("{name} is switched off for this message.")));
    }
    if is_hidden_tool(name) && !meta.chat_id.as_deref().is_some_and(|c| self.turn_lists(c, name)) {
      return Err(CoreError::Invalid(format!("{name} is switched off for this message.")));
    }
    if let Some(tool) = self.tools.iter().find(|t| t.spec.name == name) {
      if tool.spec.external_only && meta.source != "mcp" {
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
      let timeout = self.settings().await?.tool_timeout();
      return self.mcp_clients.call_in(&servers, name, args, timeout, meta.chat_id.as_deref()).await;
    }
    Err(CoreError::Invalid(format!("Unknown tool \"{name}\".")))
  }

  // ---- turns ----------------------------------------------------------------

  /// Stops one running sub-agent (by its `agent_task` call id); the turn goes
  /// on. False when none runs under that id.
  pub fn stop_sub_agent(&self, call_id: &str) -> bool {
    match self.sub_agent_cancels.lock().unwrap_or_else(|e| e.into_inner()).get(call_id) {
      Some(token) => {
        token.cancel();
        true
      }
      None => false,
    }
  }

  /// Registers a sub-agent's stop token until the returned guard drops.
  pub(crate) fn track_sub_agent(self: &Arc<Self>, call_id: &str, token: CancellationToken) -> SubAgentGuard {
    self.sub_agent_cancels.lock().unwrap_or_else(|e| e.into_inner()).insert(call_id.to_string(), token);
    SubAgentGuard { assistant: self.clone(), call_id: call_id.to_string() }
  }

  /// Stops a chat's running turn. False when none runs.
  pub fn cancel(&self, chat_id: &str) -> bool {
    // An idle kept CLI goes too (the chat may be on its way out); a running
    // turn holds its own and drops it when cancelled.
    self.end_live(chat_id);
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
  pub fn change_turn_mode(&self, chat_id: &str, mode: TurnModes) -> bool {
    if !self.is_running(chat_id) {
      return false;
    }
    self.set_turn_mode(chat_id, Some(mode));
    true
  }

  /// Adds a message to a chat's running turn; the model reads it before its
  /// next step. False when no turn can take it (none running, or an agent CLI).
  pub fn steer(&self, chat_id: &str, text: &str) -> bool {
    let text = text.trim();
    if text.is_empty() {
      return false;
    }
    match self.steered.lock().unwrap_or_else(|e| e.into_inner()).get_mut(chat_id) {
      Some(inbox) => {
        inbox.push(text.to_string());
        true
      }
      None => false,
    }
  }

  /// Opens (`true`) or closes a chat's steer inbox; closing returns what was never read.
  pub(crate) fn steer_inbox(&self, chat_id: &str, open: bool) -> Vec<String> {
    let mut map = self.steered.lock().unwrap_or_else(|e| e.into_inner());
    if open {
      map.insert(chat_id.to_string(), Vec::new());
      Vec::new()
    } else {
      map.remove(chat_id).unwrap_or_default()
    }
  }

  /// Takes the messages steered into a chat's turn so far.
  pub(crate) fn take_steered(&self, chat_id: &str) -> Vec<String> {
    self.steered.lock().unwrap_or_else(|e| e.into_inner()).get_mut(chat_id).map(std::mem::take).unwrap_or_default()
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
    self.live_cli.lock().unwrap_or_else(|e| e.into_inner()).clear();
    self.mcp_clients.shutdown_all().await;
  }
}

/// Prefix of the UI tests' browser tools: only a turn that lists them by name gets them.
pub const UITEST_PREFIX: &str = "uitest__";

fn is_hidden_tool(name: &str) -> bool {
  name.starts_with(UITEST_PREFIX)
}

pub(crate) fn log_warn(message: &str) {
  eprintln!("{message}");
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::workspace::Workspace;

  #[test]
  fn server_tools_exist_and_are_not_read_only() {
    let tools = tools::builtin();
    for name in SERVER_TOOLS {
      let t = tools.iter().find(|t| t.spec.name == *name).unwrap_or_else(|| panic!("{name} is not a tool"));
      assert_ne!(t.spec.risk, Risk::Read, "{name}");
    }
  }

  async fn assistant()-> (tempfile::TempDir, Arc<Assistant>) {
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
    a.set_turn_mode("c1", Some(TurnModes::same(ApprovalMode::Auto)));
    assert!(a.permit("x", &input, Risk::Destructive, &meta("c1")).await.unwrap());
    // Local changes run, the server is read-only: a service call is refused and not offered.
    a.set_turn_mode("c1", Some(TurnModes { local: ApprovalMode::Auto, server: ApprovalMode::ReadOnly }));
    assert!(a.permit("entity_write", &input, Risk::Write, &meta("c1")).await.unwrap());
    assert!(a.permit("service_execute", &input, Risk::Destructive, &meta("c1")).await.is_err());
    let specs = a.tool_specs_for("c1").await;
    assert!(specs.iter().any(|t| t.name == "entity_write"));
    assert!(!specs.iter().any(|t| t.name == "service_execute"));
    // Local Auto, server Ask: no UI attached, so the server call is declined.
    a.set_turn_mode("c1", Some(TurnModes { local: ApprovalMode::Auto, server: ApprovalMode::Ask }));
    assert!(!a.permit("flow_run", &input, Risk::Write, &meta("c1")).await.unwrap());
    a.set_turn_mode("c1", Some(TurnModes::same(ApprovalMode::ReadOnly)));
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

  #[tokio::test]
  async fn screens_offer_their_groups_and_find_the_rest() {
    let (_dir, a) = assistant().await;
    let names = |specs: Vec<ToolSpec>| specs.into_iter().map(|t| t.name).collect::<Vec<_>>();
    a.context.set(context::ScreenContext { route: "/repo".into(), screen: "repo".into(), ..Default::default() });
    let (offered, all) = a.offered_specs("c1").await;
    let (offered, all) = (names(offered), names(all));
    assert!(offered.contains(&"repo_diff".to_string()) && offered.contains(&"navigate".to_string()));
    assert!(!offered.contains(&"flow_run".to_string()) && all.contains(&"flow_run".to_string()));
    assert_eq!(offered.last().map(String::as_str), Some(tools::catalog::CALL));
    let find = a.tool_specs_for("c1").await.into_iter().find(|t| t.name == tools::catalog::FIND).unwrap();
    assert!(find.description.contains("flows (visual service flows)"));
    // Found and run through tools_find / tools_call.
    let found = a.call_tool(tools::catalog::FIND, json!({"query": "flow list"}), meta("c1")).await;
    assert!(!found.is_error && found.content.contains("\"flow_list\""), "{}", found.content);
    let ran = a.call_tool(tools::catalog::CALL, json!({"name": "flow_list", "arguments": {}}), meta("c1")).await;
    assert!(!ran.is_error, "{}", ran.content);
    let bad = a.call_tool(tools::catalog::CALL, json!({"name": "no_such_tool"}), meta("c1")).await;
    assert!(bad.is_error);
    // Picked tools, or "load all", offer everything without the catalog tools.
    a.set_turn_tools("c1", Some(vec!["flow_run".into()]));
    assert_eq!(names(a.tool_specs_for("c1").await), ["flow_run"]);
    a.set_turn_tools("c1", None);
    settings::update(&a.pool().await, settings::AssistantSettingsPatch { load_all_tools: Some(true), ..Default::default() }).await.unwrap();
    let every = names(a.tool_specs_for("c1").await);
    assert!(every.contains(&"flow_run".to_string()) && !every.contains(&tools::catalog::FIND.to_string()));
  }

  #[tokio::test]
  async fn steering_inbox() {
    let (_dir, a) = assistant().await;
    assert!(!a.steer("c1", "a"));
    assert!(a.steer_inbox("c1", true).is_empty());
    assert!(a.steer("c1", "a"));
    assert!(!a.steer("c1", "  "));
    assert!(a.steer("c1", " b "));
    assert_eq!(a.take_steered("c1"), ["a", "b"]);
    assert!(a.take_steered("c1").is_empty());
    assert!(a.steer("c1", "c"));
    assert_eq!(a.steer_inbox("c1", false), ["c"]);
    assert!(!a.steer("c1", "d"));
  }
}
