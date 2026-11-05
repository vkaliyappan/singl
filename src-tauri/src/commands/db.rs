use std::path::PathBuf;

use serde::Serialize;
use singl_core::db::{self, import::ImportReport};
use tauri::State;

use crate::error::IpcResult;
use crate::state::AppState;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DbInfo {
  path: String,
  migrations: Vec<i64>,
}

#[tauri::command]
pub async fn db_info(state: State<'_, AppState>) -> IpcResult<DbInfo> {
  let migrations = db::applied_migrations(&state.db().await).await?;
  Ok(DbInfo { path: state.db_path.display().to_string(), migrations })
}

/// Imports singl-web's `local.db`, replacing the current database.
#[tauri::command]
pub async fn db_import(state: State<'_, AppState>, source: String) -> IpcResult<ImportReport> {
  Ok(state.import_db(&PathBuf::from(source)).await?)
}
