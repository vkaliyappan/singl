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
  /// Servers added on the Settings page.
  pub mcp_servers: Vec<McpServerConfig>,
  /// Also load the workspace root's `.mcp.json`.
  pub use_project_mcp: bool,
  /// Names of project (`.mcp.json`) servers switched off.
  pub disabled_project_servers: Vec<String>,
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
      mcp_servers: Vec::new(),
      use_project_mcp: true,
      disabled_project_servers: Vec::new(),
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
  /// Its tools only read, so they run without approval.
  pub read_only: bool,
  /// `"app"` (Settings page) or `"project"` (`.mcp.json`). Not stored.
  #[serde(skip_deserializing)]
  pub source: String,
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
  pub mcp_servers: Vec<McpServerConfig>,
  pub use_project_mcp: bool,
  pub disabled_project_servers: Vec<String>,
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
  pub mcp_servers: Option<Vec<McpServerConfig>>,
  pub use_project_mcp: Option<bool>,
  pub disabled_project_servers: Option<Vec<String>>,
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
      mcp_servers: self.mcp_servers.iter().cloned().map(|mut s| {
        s.source = "app".into();
        s
      }).collect(),
      use_project_mcp: self.use_project_mcp,
      disabled_project_servers: self.disabled_project_servers.clone(),
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
    if let Some(v) = patch.disabled_project_servers {
      self.disabled_project_servers = v;
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

/// Servers from `<root>/.mcp.json` (`{"mcpServers": {name: {command,args,env} | {type,url,headers}}}`).
pub fn project_servers(root: &Path) -> Vec<McpServerConfig> {
  let Some(file) = crate::agents::project_mcp_config(root) else { return Vec::new() };
  let Ok(text) = std::fs::read_to_string(file) else { return Vec::new() };
  let Ok(json) = serde_json::from_str::<Value>(&text) else { return Vec::new() };
  let Some(servers) = json.get("mcpServers").and_then(Value::as_object) else { return Vec::new() };
  let strings = |v: Option<&Value>| -> HashMap<String, String> {
    v.and_then(Value::as_object)
      .map(|m| m.iter().filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string()))).collect())
      .unwrap_or_default()
  };
  servers
    .iter()
    .map(|(name, def)| McpServerConfig {
      name: sanitize_name(name),
      enabled: !def.get("disabled").and_then(Value::as_bool).unwrap_or(false),
      command: def.get("command").and_then(Value::as_str).unwrap_or_default().to_string(),
      args: def
        .get("args")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
        .unwrap_or_default(),
      env: strings(def.get("env")),
      url: def.get("url").and_then(Value::as_str).unwrap_or_default().to_string(),
      headers: strings(def.get("headers")),
      cwd: root.to_string_lossy().into_owned(),
      read_only: false,
      source: "project".into(),
    })
    // The app's own server is never loaded back into itself.
    .filter(|s| s.name != "singl")
    .collect()
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
}
