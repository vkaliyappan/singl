use singl_core::db;
use singl_core::workspace::Workspace;
use tauri::State;

use crate::error::IpcResult;
use crate::state::AppState;

#[tauri::command]
pub fn workspace_root_get(state: State<'_, AppState>) -> Option<String> {
  let workspace = state.workspace.read().unwrap_or_else(|e| e.into_inner());
  workspace.root().map(|root| root.display().to_string())
}

/// Sets the folder that holds `twx-entities/`, `repo/`, `bundles/`, `export/`, `backup/` and the ThingWorx sources.
#[tauri::command]
pub async fn workspace_root_set(state: State<'_, AppState>, root: String) -> IpcResult<()> {
  let root = root.trim().to_string();
  if !root.is_empty() && !std::path::Path::new(&root).is_dir() {
    return Err(singl_core::CoreError::NotFound(format!("{root} is not a folder")).into());
  }
  db::settings::set_workspace_root(&state.db().await, &root).await?;
  *state.workspace.write().unwrap_or_else(|e| e.into_inner()) = Workspace::new(Some(root.into()));
  Ok(())
}
