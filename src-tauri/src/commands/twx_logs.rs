//! ThingWorx log viewer commands.

use singl_core::twx::logs::{self, LogQuery, LogRow};
use singl_core::twx::projects;
use tauri::State;

use crate::error::IpcResult;
use crate::state::AppState;

/// Log entries of one environment, newest first unless `oldestFirst`.
#[tauri::command]
pub async fn twx_logs_query(state: State<'_, AppState>, env: String, query: LogQuery) -> IpcResult<Vec<LogRow>> {
  let client = projects::connect(&state.db().await, &env).await?;
  Ok(logs::query(&client, &query).await?)
}
