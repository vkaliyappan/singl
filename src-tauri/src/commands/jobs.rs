use tauri::State;

use crate::state::AppState;

/// Trips a running job's cancellation token. False when no such job is running.
#[tauri::command]
pub fn job_cancel(state: State<'_, AppState>, id: String) -> bool {
  state.jobs.cancel(&id)
}
