use singl_core::db::environments::{self, Environment, ProjectInput};
use singl_core::db::settings::{self, AppSettingsView};
use tauri::State;

use crate::error::IpcResult;
use crate::state::AppState;

#[tauri::command]
pub async fn settings_get(state: State<'_, AppState>) -> IpcResult<AppSettingsView> {
  Ok(settings::get(&state.db().await).await?)
}

/// An empty token clears it.
#[tauri::command]
pub async fn settings_azure_pat_set(state: State<'_, AppState>, token: String) -> IpcResult<()> {
  Ok(settings::set_azure_pat_token(&state.db().await, &token).await?)
}

#[tauri::command]
pub async fn settings_compare_paths_set(
  state: State<'_, AppState>,
  twx_root_prefix: String,
  repo_root_subpath: String,
) -> IpcResult<()> {
  Ok(settings::set_compare_paths(&state.db().await, &twx_root_prefix, &repo_root_subpath).await?)
}

#[tauri::command]
pub async fn settings_bundle_dirs_set(
  state: State<'_, AppState>,
  bundle_src_dir: String,
  bundle_dest_dir: String,
) -> IpcResult<()> {
  Ok(settings::set_bundle_dirs(&state.db().await, &bundle_src_dir, &bundle_dest_dir).await?)
}

#[tauri::command]
pub async fn environments_list(state: State<'_, AppState>) -> IpcResult<Vec<Environment>> {
  Ok(environments::list(&state.db().await).await?)
}

/// A blank `app_key` keeps the stored one.
#[tauri::command]
pub async fn environment_save(
  state: State<'_, AppState>,
  environment: String,
  twx_base_url: String,
  app_key: String,
) -> IpcResult<()> {
  Ok(environments::save(&state.db().await, &environment, &twx_base_url, &app_key).await?)
}

#[tauri::command]
pub async fn environment_set_enabled(state: State<'_, AppState>, environment: String, enabled: bool) -> IpcResult<()> {
  Ok(environments::set_enabled(&state.db().await, &environment, enabled).await?)
}

#[tauri::command]
pub async fn environment_clone(state: State<'_, AppState>, source: String, new_environment: String) -> IpcResult<()> {
  Ok(environments::clone(&state.db().await, &source, &new_environment).await?)
}

#[tauri::command]
pub async fn environment_delete(state: State<'_, AppState>, environment: String) -> IpcResult<()> {
  Ok(environments::delete(&state.db().await, &environment).await?)
}

#[tauri::command]
pub async fn project_save(state: State<'_, AppState>, project: ProjectInput) -> IpcResult<()> {
  Ok(environments::save_project(&state.db().await, &project).await?)
}

#[tauri::command]
pub async fn project_delete(state: State<'_, AppState>, id: i64) -> IpcResult<()> {
  Ok(environments::delete_project(&state.db().await, id).await?)
}
