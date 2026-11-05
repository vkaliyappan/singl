//! singl-web's Service Flows: the `twx-flow/actions.ts` and
//! `twx-flow/folder-actions.ts` server actions and the `/api/twx-flow/*` routes
//! (minus `agent-models`: Agent nodes are not in singl yet).

use std::collections::BTreeMap;
use std::sync::Arc;

use singl_core::db::flows;
use singl_core::db::models::{FlowFolder, ServiceFlow};
use singl_core::twx::api::DataShapeField;
use singl_core::twx::projects;
use tauri::State;
use tauri::ipc::Channel;

use crate::error::IpcResult;
use crate::state::AppState;

#[tauri::command]
pub async fn flow_list(state: State<'_, AppState>) -> IpcResult<Vec<ServiceFlow>> {
  Ok(flows::list(&state.db().await).await?)
}

#[tauri::command]
pub async fn flow_get(state: State<'_, AppState>, id: String) -> IpcResult<Option<ServiceFlow>> {
  Ok(flows::get(&state.db().await, &id).await?)
}

/// Creates (or imports, with `graph`) a flow and returns its id.
#[tauri::command]
pub async fn flow_create(
  state: State<'_, AppState>,
  name: String,
  environment: Option<String>,
  folder_id: Option<String>,
  graph: Option<String>,
) -> IpcResult<String> {
  let env = environment.unwrap_or_default();
  Ok(flows::create(&state.db().await, &name, &env, folder_id.as_deref(), graph.as_deref()).await?)
}

#[tauri::command]
pub async fn flow_rename(state: State<'_, AppState>, id: String, name: String) -> IpcResult<()> {
  Ok(flows::rename(&state.db().await, &id, &name).await?)
}

#[tauri::command]
pub async fn flow_delete(state: State<'_, AppState>, id: String) -> IpcResult<()> {
  Ok(flows::delete(&state.db().await, &id).await?)
}

/// Copies a flow and returns the copy's id.
#[tauri::command]
pub async fn flow_duplicate(state: State<'_, AppState>, id: String) -> IpcResult<String> {
  Ok(flows::duplicate(&state.db().await, &id).await?)
}

#[tauri::command]
pub async fn flow_save(state: State<'_, AppState>, id: String, graph: String, environment: String) -> IpcResult<()> {
  Ok(flows::save(&state.db().await, &id, &graph, &environment).await?)
}

#[tauri::command]
pub async fn flow_move(state: State<'_, AppState>, id: String, folder_id: Option<String>) -> IpcResult<()> {
  Ok(flows::move_flow(&state.db().await, &id, folder_id.as_deref()).await?)
}

#[tauri::command]
pub async fn flow_folders_list(state: State<'_, AppState>) -> IpcResult<Vec<FlowFolder>> {
  Ok(flows::folders(&state.db().await).await?)
}

#[tauri::command]
pub async fn flow_folder_create(state: State<'_, AppState>, name: String, parent_id: Option<String>) -> IpcResult<String> {
  Ok(flows::create_folder(&state.db().await, &name, parent_id.as_deref()).await?)
}

#[tauri::command]
pub async fn flow_folder_rename(state: State<'_, AppState>, id: String, name: String) -> IpcResult<()> {
  Ok(flows::rename_folder(&state.db().await, &id, &name).await?)
}

#[tauri::command]
pub async fn flow_folder_move(state: State<'_, AppState>, id: String, parent_id: Option<String>) -> IpcResult<()> {
  Ok(flows::move_folder(&state.db().await, &id, parent_id.as_deref()).await?)
}

#[tauri::command]
pub async fn flow_folder_delete(state: State<'_, AppState>, id: String, recursive: Option<bool>) -> IpcResult<()> {
  Ok(flows::delete_folder(&state.db().await, &id, recursive.unwrap_or(false)).await?)
}

/// `POST /api/twx-flow/datashape`: field definitions of several DataShapes. A
/// shape that cannot be read maps to an empty list rather than failing the lot.
#[tauri::command]
pub async fn flow_datashape_fields(
  state: State<'_, AppState>,
  env: String,
  names: Vec<String>,
) -> IpcResult<BTreeMap<String, Vec<DataShapeField>>> {
  let mut wanted: Vec<String> = names.into_iter().map(|n| n.trim().to_string()).filter(|n| !n.is_empty()).collect();
  wanted.sort();
  wanted.dedup();
  if wanted.is_empty() {
    return Ok(BTreeMap::new());
  }
  let client = projects::connect(&state.db().await, &env).await?;
  let lookups = wanted.into_iter().map(|name| {
    let client = client.clone();
    async move {
      let fields = client.datashape_fields(&name).await.unwrap_or_default();
      (name, fields)
    }
  });
  let mut shapes = BTreeMap::new();
  for handle in lookups.map(tauri::async_runtime::spawn).collect::<Vec<_>>() {
    if let Ok((name, fields)) = handle.await {
      shapes.insert(name, fields);
    }
  }
  Ok(shapes)
}

/// `POST /api/twx-flow/run`. `request` is the JSON body singl-web posted
/// (`{ graph, seed?, seedPorts?, target?, only? }`); each `RunEvent` arrives on
/// `on_event` as a JSON string. `job_cancel(runId)` stops the run.
#[tauri::command]
pub async fn flow_run(
  state: State<'_, AppState>,
  env: String,
  request: String,
  run_id: String,
  on_event: Channel<String>,
) -> IpcResult<()> {
  let pool = state.db().await;
  let client = projects::connect(&pool, &env).await?;
  let job = state.jobs.start_with_id(run_id);
  let emit: singl_core::flow::Emit = Arc::new(move |event: String| {
    let _ = on_event.send(event);
  });
  let root = {
    let workspace = state.workspace.read().unwrap_or_else(|e| e.into_inner());
    singl_core::agents::agent_root(workspace.root())
  };
  let agents = singl_core::flow::AgentEnv {
    registry: state.agents.clone(),
    root,
    disabled: singl_core::db::settings::disabled_agents(&pool).await?,
  };
  Ok(singl_core::flow::run(pool, client, request, job.token.clone(), emit, agents).await?)
}
