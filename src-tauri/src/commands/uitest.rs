//! UI tests (singl-core `uitest`). Run progress comes back as the events
//! `uitest://progress` and `uitest://done`.

use std::path::PathBuf;
use std::sync::Arc;

use serde::Serialize;
use singl_core::uitest::session::{self, UiSessionStatus};
use singl_core::uitest::{self, SuiteDetail, UiTestCase, UiTestSuite};
use tauri::{AppHandle, Emitter, State};

use crate::error::IpcResult;
use crate::state::AppState;

/// Where sessions and run output live: next to the database.
fn data_dir(state: &AppState) -> PathBuf {
  state.db_path.parent().map(PathBuf::from).unwrap_or_default()
}

#[tauri::command]
pub async fn uitest_suites_list(state: State<'_, AppState>) -> IpcResult<Vec<UiTestSuite>> {
  Ok(uitest::list_suites(&state.db().await).await?)
}

#[tauri::command]
pub async fn uitest_suite_get(state: State<'_, AppState>, id: String) -> IpcResult<SuiteDetail> {
  Ok(uitest::get_detail(&state.db().await, &id).await?)
}

#[tauri::command]
pub async fn uitest_suite_save(state: State<'_, AppState>, suite: UiTestSuite) -> IpcResult<UiTestSuite> {
  Ok(uitest::save_suite(&state.db().await, suite).await?)
}

#[tauri::command]
pub async fn uitest_suite_delete(state: State<'_, AppState>, id: String) -> IpcResult<()> {
  Ok(uitest::delete_suite(&state.db().await, &id).await?)
}

#[tauri::command]
pub async fn uitest_cases_save(state: State<'_, AppState>, suite_id: String, cases: Vec<UiTestCase>) -> IpcResult<Vec<UiTestCase>> {
  Ok(uitest::save_cases(&state.db().await, &suite_id, cases).await?)
}

#[tauri::command]
pub async fn uitest_import_csv(state: State<'_, AppState>, suite_id: String, csv: String, replace: bool) -> IpcResult<Vec<UiTestCase>> {
  Ok(uitest::import_csv(&state.db().await, &suite_id, &csv, replace).await?)
}

#[tauri::command]
pub async fn uitest_export_csv(state: State<'_, AppState>, suite_id: String, case_ids: Option<Vec<String>>) -> IpcResult<String> {
  Ok(uitest::export_csv(&state.db().await, &suite_id, case_ids.as_deref()).await?)
}

#[tauri::command]
pub fn uitest_session_status(state: State<'_, AppState>, env_id: String) -> UiSessionStatus {
  session::status(&data_dir(&state), &env_id, "")
}

#[tauri::command]
pub async fn uitest_session_login_start(state: State<'_, AppState>, env_id: String) -> IpcResult<UiSessionStatus> {
  Ok(session::login_start(&state.assistant, &data_dir(&state), &env_id).await?)
}

#[tauri::command]
pub async fn uitest_session_login_finish(state: State<'_, AppState>, env_id: String) -> IpcResult<UiSessionStatus> {
  Ok(session::login_finish(&state.assistant, &data_dir(&state), &env_id).await?)
}

#[tauri::command]
pub async fn uitest_session_login_cancel(state: State<'_, AppState>, env_id: String) -> IpcResult<UiSessionStatus> {
  Ok(session::login_cancel(&state.assistant, &data_dir(&state), &env_id).await?)
}

#[tauri::command]
pub async fn uitest_session_check(state: State<'_, AppState>, env_id: String) -> IpcResult<UiSessionStatus> {
  Ok(session::check(&state.assistant, &data_dir(&state), &env_id).await?)
}

#[tauri::command]
pub async fn uitest_session_clear(state: State<'_, AppState>, env_id: String) -> IpcResult<UiSessionStatus> {
  Ok(session::clear(&state.assistant, &data_dir(&state), &env_id).await?)
}

/// Starts a run in the background; returns its id.
#[tauri::command]
pub async fn uitest_run(
  app: AppHandle,
  state: State<'_, AppState>,
  suite_id: String,
  case_ids: Option<Vec<String>>,
  mode: Option<String>,
  instructions: Option<String>,
) -> IpcResult<String> {
  let emit: uitest::runner::Emit = Arc::new(move |event, payload| {
    let _ = app.emit(event, payload);
  });
  Ok(uitest::runner::start(&state.assistant, data_dir(&state), emit, &suite_id, case_ids, mode, instructions.unwrap_or_default()).await?)
}

#[tauri::command]
pub fn uitest_run_cancel(state: State<'_, AppState>, run_id: String) {
  uitest::runner::cancel(&state.assistant, &run_id);
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActiveRun {
  run_id: String,
  suite_id: String,
}

#[tauri::command]
pub fn uitest_run_active() -> Option<ActiveRun> {
  uitest::runner::active().map(|(run_id, suite_id)| ActiveRun { run_id, suite_id })
}

/// Writes the unit test document of a run; progress comes back as `uitest://report`.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn uitest_report_generate(
  app: AppHandle,
  state: State<'_, AppState>,
  suite_id: String,
  run_id: Option<String>,
  case_ids: Option<Vec<String>>,
  format: String,
  path: String,
  title: String,
  prepared_by: String,
  screenshots: String,
  user_story: Option<String>,
  iteration: Option<String>,
  template_path: Option<String>,
) -> IpcResult<uitest::report::ReportOutput> {
  let emit: uitest::runner::Emit = Arc::new(move |event, payload| {
    let _ = app.emit(event, payload);
  });
  let req = uitest::report::ReportRequest {
    suite_id,
    run_id,
    case_ids,
    format,
    path,
    title,
    prepared_by,
    screenshots,
    user_story: user_story.unwrap_or_default(),
    iteration: iteration.unwrap_or_default(),
    template_path: template_path.unwrap_or_default(),
  };
  Ok(uitest::report::generate(&state.assistant, &data_dir(&state), req, &emit).await?)
}
