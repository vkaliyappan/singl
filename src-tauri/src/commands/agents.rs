//! Agent CLIs for flow Agent nodes: singl-web's `/api/twx-flow/agent-models`
//! route, `agent-settings.ts` and the Settings page's AI Agents tab.

use std::collections::HashMap;

use serde::Serialize;
use singl_core::agents::{self, process};
use singl_core::db::settings;
use tauri::State;

use crate::error::IpcResult;
use crate::state::AppState;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentStatus {
  provider: String,
  /// Its binary was found.
  installed: bool,
  /// Switched on in Settings.
  enabled: bool,
}

/// Every provider: whether it is installed and switched on.
#[tauri::command]
pub async fn agents_status(state: State<'_, AppState>) -> IpcResult<Vec<AgentStatus>> {
  let disabled = settings::disabled_agents(&state.db().await).await?;
  let rows = tauri::async_runtime::spawn_blocking(move || {
    agents::PROVIDER_IDS
      .iter()
      .map(|p| AgentStatus { provider: p.to_string(), installed: agents::installed(p), enabled: !disabled.iter().any(|d| d == p) })
      .collect::<Vec<_>>()
  })
  .await
  .map_err(|e| singl_core::CoreError::Invalid(e.to_string()))?;
  Ok(rows)
}

#[tauri::command]
pub async fn agents_disabled_set(state: State<'_, AppState>, providers: Vec<String>) -> IpcResult<()> {
  Ok(settings::set_disabled_agents(&state.db().await, &providers).await?)
}

#[derive(Serialize)]
pub struct Captured {
  code: Option<i32>,
  stdout: String,
}

/// Runs one of a provider's model-listing commands (argv from agents.ts,
/// e.g. `claude --help`) in the agent root, for up to 20 seconds.
#[tauri::command]
pub async fn agent_list_models_run(state: State<'_, AppState>, provider: String, args: Vec<String>) -> IpcResult<Captured> {
  let root = {
    let workspace = state.workspace.read().unwrap_or_else(|e| e.into_inner());
    agents::agent_root(workspace.root())
  };
  let spec = process::SpawnSpec {
    provider,
    args,
    stdin: None,
    keep_stdin: false,
    env: HashMap::new(),
    timeout_ms: Some(20_000),
  };
  let (code, stdout) = process::capture(&state.agents, spec, &root).await?;
  Ok(Captured { code, stdout })
}

/// The model list a CLI caches for itself (`"claude"` or `"codex"`), if any.
#[tauri::command]
pub async fn agent_model_cache(which: String) -> IpcResult<Option<String>> {
  Ok(agents::model_cache(&which).await)
}

/// Every model `ANTHROPIC_API_KEY` can reach, as the Models API's JSON. None without a key.
#[tauri::command]
pub async fn agent_anthropic_models() -> IpcResult<Option<String>> {
  Ok(agents::anthropic_models().await?)
}
