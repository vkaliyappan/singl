//! Assistant settings: one JSON value in `app_settings.assistantSettings`.
//! API keys and the MCP token never leave the backend except as `has…` flags,
//! and the token through [`super::Assistant::mcp_info`] for the Settings page.

use std::collections::HashMap;
use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::SqlitePool;

use crate::Result;
use crate::db::now;

pub const DEFAULT_MCP_PORT: u16 = 47821;
pub const DEFAULT_TOOL_TIMEOUT_MINUTES: u32 = 30;
const MAX_TOOL_TIMEOUT_MINUTES: u32 = 24 * 60;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AssistantSettings {
  pub anthropic_api_key: String,
  pub openrouter_api_key: String,
  pub default_provider: String,
  pub default_model: String,
  /// Serve the app's tools over MCP on localhost.
  pub mcp_enabled: bool,
  pub mcp_port: u16,
  pub mcp_token: String,
  /// Run `write` tools without asking. `destructive` ones always ask.
  pub auto_approve_writes: bool,
  /// How calls from outside MCP clients (not the app's own chats) are approved.
  pub external_mcp_mode: super::ApprovalMode,
  /// The same for their ThingWorx server calls; unset follows `external_mcp_mode`.
  pub external_mcp_server_mode: Option<super::ApprovalMode>,
  /// Servers added on the Settings page.
  pub mcp_servers: Vec<McpServerConfig>,
  /// Also load the project MCP files (`.mcp.json`, `.codex/config.toml`, `.vscode/mcp.json`).
  pub use_project_mcp: bool,
  /// Folder those files are read from; empty means the workspace root.
  pub project_mcp_root: String,
  /// Names of project (`.mcp.json`) servers switched off.
  pub disabled_project_servers: Vec<String>,
  /// How long one MCP tool call may take, approval wait included, in minutes.
  pub tool_timeout_minutes: u32,
  /// What each outside MCP client (by `clientInfo.name`, or `*`) may use. Empty: everything.
  pub mcp_profiles: Vec<super::mcp::profiles::McpProfile>,
  /// OAuth sign-ins by server URL. Never in the view.
  pub mcp_oauth: HashMap<String, super::mcp::oauth::OAuthToken>,
  /// Tools switched off per project (`.mcp.json`) server; Settings-page servers keep theirs in their config.
  pub project_disabled_tools: HashMap<String, Vec<String>>,
}

impl Default for AssistantSettings {
  fn default() -> Self {
    Self {
      anthropic_api_key: String::new(),
      openrouter_api_key: String::new(),
      default_provider: "anthropic".into(),
      default_model: String::new(),
      mcp_enabled: true,
      mcp_port: DEFAULT_MCP_PORT,
      mcp_token: String::new(),
      auto_approve_writes: false,
      external_mcp_mode: super::ApprovalMode::Ask,
      external_mcp_server_mode: None,
      mcp_servers: Vec::new(),
      use_project_mcp: true,
      project_mcp_root: String::new(),
      disabled_project_servers: Vec::new(),
      tool_timeout_minutes: DEFAULT_TOOL_TIMEOUT_MINUTES,
      mcp_profiles: Vec::new(),
      mcp_oauth: HashMap::new(),
      project_disabled_tools: HashMap::new(),
    }
  }
}

/// An MCP server the assistant connects to. `url` set means streamable HTTP,
/// otherwise `command` is started over stdio.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct McpServerConfig {
  pub name: String,
  pub enabled: bool,
  pub command: String,
  pub args: Vec<String>,
  pub env: HashMap<String, String>,
  pub url: String,
  pub headers: HashMap<String, String>,
  /// Working directory for a stdio server (the workspace root for project servers).
  pub cwd: String,
  /// Its tools only read, so they run without approval, and only the ones
  /// that resolve to a read are offered.
  pub read_only: bool,
  /// The server's own names of tools switched off.
  pub disabled_tools: Vec<String>,
  /// `"app"` (Settings page) or `"project"` (`.mcp.json`). Not stored.
  #[serde(skip_deserializing)]
  pub source: String,
  /// Its `Authorization` header comes from an OAuth sign-in. Not stored.
  #[serde(skip)]
  pub signed_in: bool,
}

/// What the Settings page sees.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssistantSettingsView {
  pub has_anthropic_api_key: bool,
  pub has_openrouter_api_key: bool,
  pub default_provider: String,
  pub default_model: String,
  pub mcp_enabled: bool,
  pub mcp_port: u16,
  pub auto_approve_writes: bool,
  pub external_mcp_mode: super::ApprovalMode,
  pub external_mcp_server_mode: super::ApprovalMode,
  pub mcp_servers: Vec<McpServerConfig>,
  pub use_project_mcp: bool,
  pub project_mcp_root: String,
  pub disabled_project_servers: Vec<String>,
  pub tool_timeout_minutes: u32,
}

/// A partial update; `None` leaves a field alone. An empty key clears it.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AssistantSettingsPatch {
  pub anthropic_api_key: Option<String>,
  pub openrouter_api_key: Option<String>,
  pub default_provider: Option<String>,
  pub default_model: Option<String>,
  pub mcp_enabled: Option<bool>,
  pub mcp_port: Option<u16>,
  pub auto_approve_writes: Option<bool>,
  pub external_mcp_mode: Option<super::ApprovalMode>,
  pub external_mcp_server_mode: Option<super::ApprovalMode>,
  pub mcp_servers: Option<Vec<McpServerConfig>>,
  pub use_project_mcp: Option<bool>,
  pub project_mcp_root: Option<String>,
  pub disabled_project_servers: Option<Vec<String>>,
  pub tool_timeout_minutes: Option<u32>,
  /// Makes a new MCP token, cutting off every client that holds the old one.
  pub regenerate_mcp_token: Option<bool>,
}

impl AssistantSettings {
  pub fn view(&self) -> AssistantSettingsView {
    AssistantSettingsView {
      has_anthropic_api_key: !self.anthropic_key().is_empty(),
      has_openrouter_api_key: !self.openrouter_key().is_empty(),
      default_provider: self.default_provider.clone(),
      default_model: self.default_model.clone(),
      mcp_enabled: self.mcp_enabled,
      mcp_port: self.mcp_port,
      auto_approve_writes: self.auto_approve_writes,
      external_mcp_mode: self.external_mcp_mode,
      external_mcp_server_mode: self.external_modes().server,
      mcp_servers: self.mcp_servers.iter().cloned().map(|mut s| {
        s.source = "app".into();
        s
      }).collect(),
      use_project_mcp: self.use_project_mcp,
      project_mcp_root: self.project_mcp_root.clone(),
      disabled_project_servers: self.disabled_project_servers.clone(),
      tool_timeout_minutes: self.tool_timeout().as_secs() as u32 / 60,
    }
  }

  /// How long one MCP tool call may take (stored minutes, clamped; 0 = the default).
  pub fn tool_timeout(&self) -> std::time::Duration {
    let m = match self.tool_timeout_minutes {
      0 => DEFAULT_TOOL_TIMEOUT_MINUTES,
      m => m.min(MAX_TOOL_TIMEOUT_MINUTES),
    };
    std::time::Duration::from_secs(u64::from(m) * 60)
  }

  /// Approval modes for outside MCP clients.
  pub fn external_modes(&self) -> super::TurnModes {
    super::TurnModes {
      local: self.external_mcp_mode,
      server: self.external_mcp_server_mode.unwrap_or(self.external_mcp_mode),
    }
  }

  /// The stored key, else `ANTHROPIC_API_KEY`.
  pub fn anthropic_key(&self) -> String {
    key_or_env(&self.anthropic_api_key, "ANTHROPIC_API_KEY")
  }

  /// The stored key, else `OPENROUTER_API_KEY`.
  pub fn openrouter_key(&self) -> String {
    key_or_env(&self.openrouter_api_key, "OPENROUTER_API_KEY")
  }

  fn apply(&mut self, patch: AssistantSettingsPatch) {
    let trim = |s: String| s.trim().to_string();
    if let Some(v) = patch.anthropic_api_key {
      self.anthropic_api_key = trim(v);
    }
    if let Some(v) = patch.openrouter_api_key {
      self.openrouter_api_key = trim(v);
    }
    if let Some(v) = patch.default_provider {
      self.default_provider = trim(v);
    }
    if let Some(v) = patch.default_model {
      self.default_model = trim(v);
    }
    if let Some(v) = patch.mcp_enabled {
      self.mcp_enabled = v;
    }
    if let Some(v) = patch.mcp_port {
      self.mcp_port = if v == 0 { DEFAULT_MCP_PORT } else { v };
    }
    if let Some(v) = patch.auto_approve_writes {
      self.auto_approve_writes = v;
    }
    if let Some(v) = patch.external_mcp_mode {
      self.external_mcp_mode = v;
    }
    if let Some(v) = patch.external_mcp_server_mode {
      self.external_mcp_server_mode = Some(v);
    }
    if let Some(v) = patch.mcp_servers {
      self.mcp_servers = v
        .into_iter()
        .filter(|s| !s.name.trim().is_empty())
        .map(|mut s| {
          s.name = sanitize_name(&s.name);
          s.source = String::new();
          s
        })
        .collect();
    }
    if let Some(v) = patch.use_project_mcp {
      self.use_project_mcp = v;
    }
    if let Some(v) = patch.project_mcp_root {
      self.project_mcp_root = trim(v);
    }
    if let Some(v) = patch.disabled_project_servers {
      self.disabled_project_servers = v;
    }
    if let Some(v) = patch.tool_timeout_minutes {
      self.tool_timeout_minutes = if v == 0 { DEFAULT_TOOL_TIMEOUT_MINUTES } else { v.min(MAX_TOOL_TIMEOUT_MINUTES) };
    }
    if patch.regenerate_mcp_token == Some(true) || self.mcp_token.is_empty() {
      self.mcp_token = new_token();
    }
  }
}

fn key_or_env(stored: &str, var: &str) -> String {
  if !stored.trim().is_empty() {
    return stored.trim().to_string();
  }
  std::env::var(var).map(|v| v.trim().to_string()).unwrap_or_default()
}

pub fn new_token() -> String {
  format!("{}{}", uuid::Uuid::new_v4().simple(), uuid::Uuid::new_v4().simple())
}

/// Server names become tool prefixes (`<name>__<tool>`), so keep them to `[A-Za-z0-9_-]`.
pub fn sanitize_name(name: &str) -> String {
  name.trim().chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' }).collect()
}

/// The settings, with a token made (and stored) on first use.
pub async fn load(pool: &SqlitePool) -> Result<AssistantSettings> {
  let raw: Option<String> =
    sqlx::query_scalar("SELECT assistantSettings FROM app_settings WHERE id = 1").fetch_optional(pool).await?;
  let mut settings: AssistantSettings = raw.and_then(|r| serde_json::from_str(&r).ok()).unwrap_or_default();
  if settings.mcp_token.is_empty() {
    settings.mcp_token = new_token();
    store(pool, &settings).await?;
  }
  Ok(settings)
}

/// Replaces the MCP client tool profiles.
pub async fn set_mcp_profiles(pool: &SqlitePool, profiles: Vec<super::mcp::profiles::McpProfile>) -> Result<()> {
  let mut settings = load(pool).await?;
  settings.mcp_profiles = super::mcp::profiles::normalize(profiles);
  store(pool, &settings).await
}

/// Stores (`Some`) or forgets (`None`) the sign-in for the server at `url`.
pub async fn set_oauth(pool: &SqlitePool, url: &str, token: Option<super::mcp::oauth::OAuthToken>) -> Result<()> {
  let mut settings = load(pool).await?;
  match token {
    Some(t) => {
      settings.mcp_oauth.insert(url.to_string(), t);
    }
    None => {
      settings.mcp_oauth.remove(url);
    }
  }
  store(pool, &settings).await
}

/// Switches off exactly `tools` (the server's own names) of the server `server`.
pub async fn set_disabled_tools(pool: &SqlitePool, server: &str, tools: Vec<String>) -> Result<()> {
  let mut settings = load(pool).await?;
  match settings.mcp_servers.iter_mut().find(|s| s.name == server) {
    Some(s) => s.disabled_tools = tools,
    None if tools.is_empty() => {
      settings.project_disabled_tools.remove(server);
    }
    None => {
      settings.project_disabled_tools.insert(server.to_string(), tools);
    }
  }
  store(pool, &settings).await
}

pub async fn update(pool: &SqlitePool, patch: AssistantSettingsPatch) -> Result<AssistantSettings> {
  let mut settings = load(pool).await?;
  settings.apply(patch);
  store(pool, &settings).await?;
  Ok(settings)
}

async fn store(pool: &SqlitePool, settings: &AssistantSettings) -> Result<()> {
  sqlx::query(
    "INSERT INTO app_settings (id, assistantSettings, updatedAt) VALUES (1, ?1, ?2)
     ON CONFLICT(id) DO UPDATE SET assistantSettings = excluded.assistantSettings, updatedAt = excluded.updatedAt",
  )
  .bind(serde_json::to_string(settings).unwrap_or_else(|_| "{}".into()))
  .bind(now())
  .execute(pool)
  .await?;
  Ok(())
}

/// The project MCP files read from a folder, first one wins on a name clash:
/// Claude Code's `.mcp.json` (`mcpServers`), Codex's `.codex/config.toml`
/// (`[mcp_servers.<name>]`) and VS Code / Copilot's `.vscode/mcp.json` (`servers`).
pub fn project_servers(root: &Path) -> Vec<McpServerConfig> {
  let read = |rel: &str| std::fs::read_to_string(root.join(rel)).ok();
  let sources = [
    read(".mcp.json").and_then(|t| serde_json::from_str::<Value>(&t).ok()).and_then(|v| v.get("mcpServers").cloned()),
    read(".codex/config.toml").and_then(|t| toml::from_str::<Value>(&t).ok()).and_then(|v| v.get("mcp_servers").cloned()),
    read(".vscode/mcp.json").and_then(|t| serde_json::from_str::<Value>(&t).ok()).and_then(|v| v.get("servers").cloned()),
  ];
  let mut out: Vec<McpServerConfig> = Vec::new();
  for servers in sources.iter().flatten().filter_map(Value::as_object) {
    for (name, def) in servers {
      let s = server_from(name, def, root);
      // The app's own server is never loaded back into itself.
      if s.name != "singl" && !out.iter().any(|o| o.name == s.name) {
        out.push(s);
      }
    }
  }
  out
}

/// One project server entry; the field names of all three files are accepted.
fn server_from(name: &str, def: &Value, root: &Path) -> McpServerConfig {
  let root_str = root.to_string_lossy().into_owned();
  // VS Code's `${workspaceFolder}`; other `${...}` variables are left as they are.
  let expand = |s: &str| s.replace("${workspaceFolder}", &root_str);
  let text = |key: &str| def.get(key).and_then(Value::as_str).map(expand).unwrap_or_default();
  let strings = |key: &str| -> HashMap<String, String> {
    def
      .get(key)
      .and_then(Value::as_object)
      .map(|m| m.iter().filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), expand(s)))).collect())
      .unwrap_or_default()
  };
  let mut headers = strings("headers");
  headers.extend(strings("http_headers"));
  // Codex: a bearer token named by an environment variable.
  if let Some(token) = def.get("bearer_token_env_var").and_then(Value::as_str).and_then(|v| std::env::var(v).ok()) {
    headers.insert("Authorization".into(), format!("Bearer {token}"));
  }
  let cwd = text("cwd");
  McpServerConfig {
    name: sanitize_name(name),
    enabled: !def.get("disabled").and_then(Value::as_bool).unwrap_or(false)
      && def.get("enabled").and_then(Value::as_bool).unwrap_or(true),
    command: text("command"),
    args: def
      .get("args")
      .and_then(Value::as_array)
      .map(|a| a.iter().filter_map(|v| v.as_str().map(expand)).collect())
      .unwrap_or_default(),
    env: strings("env"),
    url: text("url"),
    headers,
    cwd: if cwd.is_empty() { root_str.clone() } else { root.join(cwd).to_string_lossy().into_owned() },
    read_only: false,
    disabled_tools: Vec::new(),
    source: "project".into(),
    signed_in: false,
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[tokio::test]
  async fn token_is_made_once_and_keys_stay_hidden() {
    let dir = tempfile::tempdir().unwrap();
    let pool = crate::db::open(&dir.path().join("singl.db")).await.unwrap();
    let first = load(&pool).await.unwrap();
    assert!(!first.mcp_token.is_empty());
    assert_eq!(load(&pool).await.unwrap().mcp_token, first.mcp_token);
    let saved = update(&pool, AssistantSettingsPatch { anthropic_api_key: Some(" k ".into()), ..Default::default() })
      .await
      .unwrap();
    assert_eq!(saved.anthropic_api_key, "k");
    assert!(saved.view().has_anthropic_api_key);
    assert_eq!(saved.mcp_token, first.mcp_token);
  }

  #[test]
  fn project_config_parses() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(
      dir.path().join(".mcp.json"),
      r#"{"mcpServers":{"a b":{"command":"node","args":["x.js"]},"web":{"type":"http","url":"http://h/mcp"},"singl":{"url":"x"}}}"#,
    )
    .unwrap();
    let servers = project_servers(dir.path());
    assert_eq!(servers.len(), 2);
    assert!(servers.iter().any(|s| s.name == "a_b" && s.command == "node"));
    assert!(servers.iter().any(|s| s.name == "web" && s.url == "http://h/mcp"));
  }

  #[test]
  fn codex_and_vscode_project_files_are_read() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join(".mcp.json"), r#"{"mcpServers":{"ado":{"command":"npx"}}}"#).unwrap();
    std::fs::create_dir(dir.path().join(".codex")).unwrap();
    std::fs::write(
      dir.path().join(".codex/config.toml"),
      "[mcp_servers.ado]\ncommand = \"other\"\n\n[mcp_servers.docs]\nurl = \"http://d/mcp\"\nenabled = false\n\n[mcp_servers.docs.http_headers]\nX-Key = \"k\"\n",
    )
    .unwrap();
    std::fs::create_dir(dir.path().join(".vscode")).unwrap();
    std::fs::write(
      dir.path().join(".vscode/mcp.json"),
      r#"{"servers":{"fs":{"type":"stdio","command":"node","args":["${workspaceFolder}/s.js"]}}}"#,
    )
    .unwrap();
    let servers = project_servers(dir.path());
    let get = |n: &str| servers.iter().find(|s| s.name == n).unwrap();
    assert_eq!(servers.len(), 3);
    assert_eq!(get("ado").command, "npx", ".mcp.json wins a name clash");
    assert!(!get("docs").enabled);
    assert_eq!(get("docs").headers["X-Key"], "k");
    assert!(get("fs").args[0].ends_with("/s.js") && !get("fs").args[0].contains("${"));
  }
}
