//! singl-web's `/api/twx-services/*` routes and the preset server actions of
//! its TWX Services page.

use serde_json::Value;
use singl_core::CoreError;
use singl_core::db::models::TwxServicePreset;
use singl_core::db::service_presets::{self, PresetInput};
use singl_core::jobs::until_cancelled;
use singl_core::twx::api::{EntitySearchResult, ServiceDef};
use singl_core::twx::projects;
use tauri::State;

use crate::error::IpcResult;
use crate::state::AppState;

fn require(value: &str, name: &str) -> IpcResult<()> {
  if value.trim().is_empty() { Err(CoreError::Invalid(format!("{name} is required")).into()) } else { Ok(()) }
}

/// `POST /api/twx-services/search`: entities of `entityType` whose names match `nameMask`.
#[tauri::command]
pub async fn service_search(
  state: State<'_, AppState>,
  env: String,
  entity_type: String,
  name_mask: Option<String>,
) -> IpcResult<Vec<EntitySearchResult>> {
  require(&entity_type, "type")?;
  let client = projects::connect(&state.db().await, &env).await?;
  Ok(client.search_entities(&entity_type, name_mask.as_deref().unwrap_or("*")).await?)
}

/// `POST /api/twx-services/definitions`: every service of one entity.
#[tauri::command]
pub async fn service_definitions(
  state: State<'_, AppState>,
  env: String,
  collection: String,
  entity_name: String,
) -> IpcResult<Vec<ServiceDef>> {
  require(&collection, "collection")?;
  require(&entity_name, "entityName")?;
  let client = projects::connect(&state.db().await, &env).await?;
  Ok(client.service_definitions(&collection, &entity_name).await?)
}

/// `POST /api/twx-services/execute`: runs a service and returns its JSON reply
/// as text. With `requestId`, `job_cancel(requestId)` abandons the call.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn service_execute(
  state: State<'_, AppState>,
  env: String,
  collection: String,
  entity_name: String,
  service_name: String,
  inputs: Option<Value>,
  request_id: Option<String>,
) -> IpcResult<String> {
  require(&collection, "collection")?;
  require(&entity_name, "entityName")?;
  require(&service_name, "serviceName")?;
  let client = projects::connect(&state.db().await, &env).await?;
  let inputs = inputs.filter(|v| !v.is_null()).unwrap_or_else(|| Value::Object(Default::default()));
  let job = match request_id.filter(|id| !id.is_empty()) {
    Some(id) => state.jobs.start_with_id(id),
    None => state.jobs.start(),
  };
  let work = client.execute_service(&collection, &entity_name, &service_name, &inputs);
  Ok(until_cancelled(&job.token, work).await?)
}

#[tauri::command]
pub async fn service_presets_list(state: State<'_, AppState>) -> IpcResult<Vec<TwxServicePreset>> {
  Ok(service_presets::list(&state.db().await).await?)
}

/// Creates or updates a preset; returns its id.
#[tauri::command]
pub async fn service_preset_save(state: State<'_, AppState>, preset: PresetInput) -> IpcResult<i64> {
  Ok(service_presets::save(&state.db().await, &preset).await?)
}

#[tauri::command]
pub async fn service_preset_delete(state: State<'_, AppState>, id: i64) -> IpcResult<()> {
  Ok(service_presets::delete(&state.db().await, id).await?)
}
