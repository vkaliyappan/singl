//! Model providers.
//!
//! * API providers ([`anthropic`], [`openrouter`]) answer one model call at a
//!   time; [`super::runner`] runs the tool loop around them.
//! * Agent CLIs ([`cli`]: Claude Code, Codex, Antigravity, Copilot) run their
//!   own loop and reach the app's tools through its MCP server.

pub mod anthropic;
pub mod cli;
pub mod openrouter;
pub mod sse;

use std::path::PathBuf;

use serde::Serialize;
use tokio_util::sync::CancellationToken;

use super::tools::ToolSpec;
use super::types::{Block, Message};

pub const API_PROVIDERS: [&str; 2] = ["anthropic", "openrouter"];

/// Every provider id the UI can pick, in display order.
pub const ALL_PROVIDERS: [&str; 6] = ["anthropic", "openrouter", "claude", "codex", "antigravity", "copilot"];

pub fn title(provider: &str) -> &'static str {
  match provider {
    "anthropic" => "Anthropic API",
    "openrouter" => "OpenRouter",
    "claude" => "Claude Code",
    "codex" => "Codex CLI",
    "antigravity" => "Antigravity CLI",
    "copilot" => "GitHub Copilot CLI",
    _ => "Unknown",
  }
}

pub fn is_api(provider: &str) -> bool {
  API_PROVIDERS.contains(&provider)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderInfo {
  pub id: String,
  pub title: String,
  /// `"api"` or `"cli"`.
  pub kind: String,
  /// Has a key (API) or its binary is installed (CLI).
  pub available: bool,
  /// Why it is not available.
  pub note: Option<String>,
  /// Reasoning effort levels it takes, lowest first; empty when it has none.
  pub efforts: Vec<String>,
}

/// Reasoning effort levels per provider, lowest first.
///   * Anthropic API: `output_config.effort`; Claude Code `--effort`; agy `--effort`;
///     Copilot `--reasoning-effort`: low … max.
///   * Codex `model_reasoning_effort`: low … xhigh.
///   * OpenRouter `reasoning.effort`: low / medium / high.
pub fn efforts(provider: &str) -> &'static [&'static str] {
  match provider {
    "anthropic" | "claude" | "antigravity" | "copilot" => &["low", "medium", "high", "xhigh", "max"],
    "codex" => &["low", "medium", "high", "xhigh"],
    "openrouter" => &["low", "medium", "high"],
    _ => &[],
  }
}

/// `effort` if the provider takes it, else the nearest level it does take
/// (`max` → `xhigh` for Codex), else empty (provider default).
pub fn normalize_effort(provider: &str, effort: &str) -> String {
  let effort = effort.trim().to_lowercase();
  let levels = efforts(provider);
  if effort.is_empty() || levels.is_empty() {
    return String::new();
  }
  if levels.contains(&effort.as_str()) {
    return effort;
  }
  const ORDER: [&str; 5] = ["low", "medium", "high", "xhigh", "max"];
  match ORDER.iter().position(|l| *l == effort) {
    Some(rank) => ORDER[..=rank].iter().rev().find(|l| levels.contains(l)).map(|l| l.to_string()).unwrap_or_default(),
    None => String::new(),
  }
}

/// Current Claude models, newest first in each family. Claude Code takes these
/// ids for `--model`; the Anthropic API list is topped up with them.
pub const CLAUDE_MODELS: &[(&str, &str)] = &[
  ("claude-fable-5-2", "Fable 5.2"),
  ("claude-fable-5-1", "Fable 5.1"),
  ("claude-fable-5", "Fable 5"),
  ("claude-opus-5-5", "Opus 5.5"),
  ("claude-opus-5", "Opus 5"),
  ("claude-opus-4-8", "Opus 4.8"),
  ("claude-opus-4-7", "Opus 4.7"),
  ("claude-opus-4-6", "Opus 4.6"),
  ("claude-sonnet-5-5", "Sonnet 5.5"),
  ("claude-sonnet-5", "Sonnet 5"),
  ("claude-sonnet-4-6", "Sonnet 4.6"),
  ("claude-haiku-5-5", "Haiku 5.5"),
  ("claude-haiku-4-5", "Haiku 4.5"),
];

/// One model call for an API provider.
pub struct ApiRequest {
  pub api_key: String,
  pub model: String,
  pub system: String,
  /// The whole conversation so far, in the stored format.
  pub messages: Vec<Message>,
  pub tools: Vec<ToolSpec>,
  pub max_tokens: u32,
  /// Reasoning effort, already checked against [`efforts`]; empty = provider default.
  pub effort: String,
}

/// What the model answered: text and/or tool calls, in order.
#[derive(Debug, Clone)]
pub struct ApiReply {
  pub blocks: Vec<Block>,
  /// `"end_turn"`, `"tool_use"`, `"max_tokens"`… (provider wording mapped to Anthropic's).
  pub stop_reason: String,
}

/// Streamed answer text, or (as the second sink providers take) streamed reasoning.
pub type TextSink<'a> = &'a (dyn Fn(&str) + Send + Sync);

/// Reasoning kept only to show it again: no provider is sent a block with this
/// provider name, so it never goes back to a model.
pub fn shown_thinking(text: String) -> Option<crate::assistant::types::Block> {
  (!text.trim().is_empty()).then(|| crate::assistant::types::Block::Opaque {
    provider: "ui".into(),
    data: serde_json::json!({"type": "thinking", "thinking": text}),
  })
}

/// One turn for an agent CLI.
pub struct CliRequest {
  pub provider: String,
  /// Empty: the CLI's default model.
  pub model: String,
  pub system: String,
  /// What the CLI is told this turn: the new message, or the transcript plus
  /// the new message when it cannot resume.
  pub prompt: String,
  /// A session to resume.
  pub resume: Option<String>,
  /// The app's MCP server for this turn (token scoped to the chat).
  pub mcp_url: String,
  pub mcp_token: String,
  pub cwd: PathBuf,
  /// Reasoning effort, already checked against [`efforts`]; empty = the CLI's default.
  pub effort: String,
  /// The turn is read-only: CLIs that cannot be confined to the app's tools refuse to run.
  pub read_only: bool,
  /// The CLI's own MCP servers, switched off for this run (filled in by [`cli::run`]).
  pub foreign_mcp: Vec<String>,
  /// Images of the new message (base64).
  pub images: Vec<CliImage>,
}

#[derive(Debug, Clone)]
pub struct CliImage {
  pub name: String,
  pub media_type: String,
  pub data: String,
}

#[derive(Debug, Clone, Default)]
pub struct CliReply {
  pub text: String,
  /// The reasoning the CLI streamed, if any.
  pub thinking: String,
  /// The CLI's session id, to resume next turn.
  pub session_id: Option<String>,
}

/// Cancelled is reported as [`crate::CoreError::Cancelled`].
pub fn check_cancel(cancel: &CancellationToken) -> crate::Result<()> {
  if cancel.is_cancelled() { Err(crate::CoreError::Cancelled) } else { Ok(()) }
}

/// Every provider with whether it can be used right now.
pub async fn list(a: &super::Assistant) -> crate::Result<Vec<ProviderInfo>> {
  let settings = a.settings().await?;
  let disabled = crate::db::settings::disabled_agents(&a.pool().await).await?;
  let mcp_on = a.mcp_endpoint().is_some();
  let mut out = Vec::new();
  for id in ALL_PROVIDERS {
    let (available, note) = match id {
      "anthropic" => {
        let ok = !settings.anthropic_key().is_empty();
        (ok, (!ok).then(|| "Add an Anthropic API key in Settings → AI.".to_string()))
      }
      "openrouter" => {
        let ok = !settings.openrouter_key().is_empty();
        (ok, (!ok).then(|| "Add an OpenRouter API key in Settings → AI.".to_string()))
      }
      cli => {
        let installed = tokio::task::spawn_blocking(move || crate::agents::installed(cli)).await.unwrap_or(false);
        if disabled.iter().any(|d| d == cli) {
          (false, Some("Switched off in Settings → AI.".to_string()))
        } else if !installed {
          (false, Some("Not installed (not found on PATH).".to_string()))
        } else if !mcp_on {
          (false, Some("Needs the app's MCP server (Settings → AI).".to_string()))
        } else {
          (true, None)
        }
      }
    };
    out.push(ProviderInfo {
      id: id.into(),
      title: title(id).into(),
      kind: if is_api(id) { "api".into() } else { "cli".into() },
      available,
      note,
      efforts: efforts(id).iter().map(|e| e.to_string()).collect(),
    });
  }
  Ok(out)
}

/// The models a provider offers.
pub async fn models(a: &super::Assistant, provider: &str) -> crate::Result<Vec<super::types::ModelInfo>> {
  let settings = a.settings().await?;
  match provider {
    "anthropic" => {
      // The live list when there is a key, topped up with the known current models.
      let mut list = anthropic::models(&settings.anthropic_key()).await.unwrap_or_default();
      for (id, name) in CLAUDE_MODELS {
        if !list.iter().any(|m| m.id == *id) {
          list.push(super::types::ModelInfo { id: id.to_string(), name: name.to_string() });
        }
      }
      Ok(list)
    }
    "openrouter" => openrouter::models(&settings.openrouter_key()).await,
    cli => self::cli::models(&a.procs, cli).await,
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn effort_falls_back_to_nearest_lower_level() {
    assert_eq!(normalize_effort("anthropic", "Max"), "max");
    assert_eq!(normalize_effort("codex", "max"), "xhigh");
    assert_eq!(normalize_effort("openrouter", "xhigh"), "high");
    assert_eq!(normalize_effort("anthropic", ""), "");
    assert_eq!(normalize_effort("anthropic", "turbo"), "");
  }
}
