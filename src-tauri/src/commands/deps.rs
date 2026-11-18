//! Entity dependency graph over the exported entity XML (no server calls).
//! Thin wrappers over `singl_core::twx::deps`; the index is cached per file.

use std::path::PathBuf;

use singl_core::twx::deps::{self, Callers, Direction, Graph, Index, Node, Summary, Unused};
use singl_core::twx::run_times::safe_env;
use singl_core::workspace::PathKind;
use singl_core::{CoreError, Result};
use tauri::State;

use crate::error::IpcResult;
use crate::state::AppState;

fn base(state: &AppState) -> Result<PathBuf> {
  let workspace = state.workspace.read().unwrap_or_else(|e| e.into_inner());
  workspace
    .resolve(PathKind::TwxEntities)
    .ok_or_else(|| CoreError::Invalid("No workspace folder is set. Choose one in Settings.".into()))
}

/// Runs `f` on the environment's index off the async runtime.
async fn with_index<T: Send + 'static>(
  state: &AppState,
  env: String,
  f: impl FnOnce(&Index) -> Result<T> + Send + 'static,
) -> IpcResult<T> {
  let base = base(state)?;
  let result = tauri::async_runtime::spawn_blocking(move || -> Result<T> {
    let index = deps::index(&base, &safe_env(env.trim()))?;
    f(&index)
  })
  .await
  .map_err(|e| CoreError::Io(std::io::Error::other(e.to_string())))?;
  Ok(result?)
}

/// Entity counts per type and the number of edges.
#[tauri::command]
pub async fn deps_summary(state: State<'_, AppState>, env: String) -> IpcResult<Summary> {
  with_index(&state, env, |ix| Ok(ix.summary())).await
}

/// Exported entities whose name matches `query`, best first.
#[tauri::command]
pub async fn deps_search(
  state: State<'_, AppState>,
  env: String,
  query: String,
  limit: Option<usize>,
) -> IpcResult<Vec<Node>> {
  let limit = limit.unwrap_or(30).clamp(1, 200);
  with_index(&state, env, move |ix| Ok(ix.search(&query, limit))).await
}

/// `direction` is "in", "out" or "both"; `kinds` empty means all.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn deps_graph(
  state: State<'_, AppState>,
  env: String,
  entity: String,
  entity_type: Option<String>,
  direction: String,
  depth: usize,
  kinds: Vec<String>,
  limit: Option<usize>,
) -> IpcResult<Graph> {
  let direction = Direction::parse(&direction)?;
  let limit = limit.unwrap_or(500).clamp(1, 2000);
  with_index(&state, env, move |ix| ix.dependencies(&entity, entity_type.as_deref(), direction, depth, &kinds, limit))
    .await
}

#[tauri::command]
pub async fn deps_callers(
  state: State<'_, AppState>,
  env: String,
  entity: String,
  entity_type: Option<String>,
  service: String,
) -> IpcResult<Callers> {
  with_index(&state, env, move |ix| ix.service_callers(&entity, entity_type.as_deref(), &service)).await
}

/// Entities nothing references; a heuristic. `entity_type` empty means every type.
#[tauri::command]
pub async fn deps_unused(
  state: State<'_, AppState>,
  env: String,
  entity_type: Option<String>,
  limit: Option<usize>,
) -> IpcResult<Unused> {
  let limit = limit.unwrap_or(500).clamp(1, 5000);
  with_index(&state, env, move |ix| {
    let mut unused = ix.unused(entity_type.as_deref());
    unused.nodes.truncate(limit);
    Ok(unused)
  })
  .await
}
