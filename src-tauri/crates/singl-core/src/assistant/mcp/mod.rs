//! MCP both ways: the app's own server ([`server`] over [`http`]) and clients
//! for project / Settings-page servers ([`client`]).
//!
//! While the server runs, its address and token are written to a discovery
//! file next to the database, so the `singl-mcp` stdio shim can forward to it.

pub mod client;
pub mod http;
pub mod server;

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

use serde::Serialize;
use serde_json::json;
use tokio_util::sync::CancellationToken;

use super::{Assistant, McpEndpoint};
use crate::Result;

pub const DISCOVERY_FILE: &str = "assistant-mcp.json";

/// The discovery file for a database at `db_path`.
pub fn discovery_path(db_path: &Path) -> PathBuf {
  db_path.parent().map(|d| d.join(DISCOVERY_FILE)).unwrap_or_else(|| PathBuf::from(DISCOVERY_FILE))
}

fn running() -> &'static Mutex<Option<CancellationToken>> {
  static RUNNING: OnceLock<Mutex<Option<CancellationToken>>> = OnceLock::new();
  RUNNING.get_or_init(|| Mutex::new(None))
}

/// What the Settings page shows to connect an outside client.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpInfo {
  pub enabled: bool,
  pub running: bool,
  pub url: Option<String>,
  pub token: String,
  /// Ready-to-paste `.mcp.json` / Claude Desktop entry.
  pub config_snippet: String,
  /// `claude mcp add` command line.
  pub claude_command: String,
}

impl Assistant {
  /// (Re)starts the app's MCP server per settings. Safe to call again after a settings change.
  pub async fn start_mcp(self: &Arc<Self>, discovery: &Path) -> Result<()> {
    if let Some(old) = running().lock().unwrap_or_else(|e| e.into_inner()).take() {
      old.cancel();
    }
    self.set_mcp_endpoint(None);
    let _ = std::fs::remove_file(discovery);

    let settings = self.settings().await?;
    if !settings.mcp_enabled {
      return Ok(());
    }
    let cancel = CancellationToken::new();
    let port = http::serve(self.clone(), settings.mcp_port, settings.mcp_token.clone(), cancel.clone()).await?;
    *running().lock().unwrap_or_else(|e| e.into_inner()) = Some(cancel);
    let endpoint = McpEndpoint { url: format!("http://127.0.0.1:{port}/mcp"), token: settings.mcp_token.clone() };
    let file = json!({ "url": endpoint.url, "token": endpoint.token, "pid": std::process::id() });
    if let Err(e) = std::fs::write(discovery, serde_json::to_string_pretty(&file).unwrap_or_default()) {
      super::log_warn(&format!("assistant MCP: could not write {}: {e}", discovery.display()));
    }
    self.set_mcp_endpoint(Some(endpoint));
    Ok(())
  }

  pub fn stop_mcp(&self, discovery: &Path) {
    if let Some(old) = running().lock().unwrap_or_else(|e| e.into_inner()).take() {
      old.cancel();
    }
    self.set_mcp_endpoint(None);
    let _ = std::fs::remove_file(discovery);
  }

  pub async fn mcp_info(&self) -> Result<McpInfo> {
    let settings = self.settings().await?;
    let endpoint = self.mcp_endpoint();
    let url = endpoint.as_ref().map(|e| e.url.clone());
    let shown_url = url.clone().unwrap_or_else(|| format!("http://127.0.0.1:{}/mcp", settings.mcp_port));
    let snippet = json!({
      "mcpServers": {
        "singl": {
          "type": "http",
          "url": shown_url,
          "headers": { "Authorization": format!("Bearer {}", settings.mcp_token) },
        }
      }
    });
    Ok(McpInfo {
      enabled: settings.mcp_enabled,
      running: endpoint.is_some(),
      url,
      token: settings.mcp_token.clone(),
      config_snippet: serde_json::to_string_pretty(&snippet).unwrap_or_default(),
      claude_command: format!(
        "claude mcp add --transport http singl {shown_url} --header \"Authorization: Bearer {}\"",
        settings.mcp_token
      ),
    })
  }

  /// A token that lets an agent CLI call tools on behalf of `chat_id` until dropped.
  pub(crate) fn turn_token(&self, chat_id: &str) -> String {
    let token = super::settings::new_token();
    self.turn_tokens.lock().unwrap_or_else(|e| e.into_inner()).insert(token.clone(), chat_id.to_string());
    token
  }

  pub(crate) fn drop_turn_token(&self, token: &str) {
    self.turn_tokens.lock().unwrap_or_else(|e| e.into_inner()).remove(token);
  }
}
