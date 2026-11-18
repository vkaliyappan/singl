//! The Access & Mashups page: entity permissions, "can user X do Y", and the mashup list.

use singl_core::twx::permissions::{self, Decision, EntityPermissions, MashupInfo};
use singl_core::twx::projects;
use tauri::State;

use crate::error::IpcResult;
use crate::state::AppState;

/// Run-time, design-time and visibility rules of one entity.
#[tauri::command]
pub async fn twx_entity_permissions(
  state: State<'_, AppState>,
  env: String,
  entity_type: String,
  entity_name: String,
) -> IpcResult<EntityPermissions> {
  let client = projects::connect(&state.db().await, &env).await?;
  Ok(permissions::entity_permissions(&client, &entity_type, &entity_name).await?)
}

/// Whether `user` may do `action` (on `member`) on an entity, and why.
#[tauri::command]
pub async fn twx_check_permission(
  state: State<'_, AppState>,
  env: String,
  entity_type: String,
  entity_name: String,
  user: String,
  action: String,
  member: Option<String>,
) -> IpcResult<Decision> {
  let client = projects::connect(&state.db().await, &env).await?;
  let member = member.as_deref().map(str::trim).filter(|m| !m.is_empty());
  Ok(permissions::check_permission(&client, &entity_type, &entity_name, user.trim(), &action, member).await?)
}

/// Mashups whose names match `name_mask`.
#[tauri::command]
pub async fn twx_list_mashups(state: State<'_, AppState>, env: String, name_mask: Option<String>) -> IpcResult<Vec<MashupInfo>> {
  let client = projects::connect(&state.db().await, &env).await?;
  Ok(permissions::list_mashups(&client, name_mask.as_deref().unwrap_or("*")).await?)
}
