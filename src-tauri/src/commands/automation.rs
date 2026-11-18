//! Automation: test suites, drift reports and schedules (singl-core `automation`).

use singl_core::automation::drift::{self, DriftReport, DriftRequest};
use singl_core::automation::schedule::{self, Schedule, ScheduleInput};
use singl_core::automation::suites::{self, Suite, SuiteRun};
use singl_core::automation::{self, RunDetail, RunRow};
use tauri::State;

use crate::error::IpcResult;
use crate::state::AppState;

#[tauri::command]
pub async fn automation_suites_list(state: State<'_, AppState>) -> IpcResult<Vec<Suite>> {
  Ok(suites::list(&state.db().await).await?)
}

/// Creates (empty `id`) or replaces a suite and returns it as stored.
#[tauri::command]
pub async fn automation_suite_save(state: State<'_, AppState>, suite: Suite) -> IpcResult<Suite> {
  Ok(suites::save(&state.db().await, suite).await?)
}

#[tauri::command]
pub async fn automation_suite_delete(state: State<'_, AppState>, id: String) -> IpcResult<()> {
  Ok(suites::delete(&state.db().await, &id).await?)
}

/// Runs a suite on `envs` (default: the suite's own). Services really execute.
#[tauri::command]
pub async fn automation_suite_run(state: State<'_, AppState>, id: String, envs: Option<Vec<String>>) -> IpcResult<SuiteRun> {
  Ok(suites::run(&state.db().await, &id, envs).await?)
}

/// Run history, newest first. `kind` is `suite` or `drift`; `ref_id` narrows to one suite or `A|B` pair.
#[tauri::command]
pub async fn automation_runs_list(state: State<'_, AppState>, kind: String, ref_id: Option<String>) -> IpcResult<Vec<RunRow>> {
  Ok(automation::list_runs(&state.db().await, &kind, ref_id.as_deref(), automation::KEEP_RUNS).await?)
}

#[tauri::command]
pub async fn automation_run_get(state: State<'_, AppState>, id: String) -> IpcResult<RunDetail> {
  Ok(automation::get_run(&state.db().await, &id).await?)
}

#[tauri::command]
pub async fn automation_run_delete(state: State<'_, AppState>, id: String) -> IpcResult<()> {
  Ok(automation::delete_run(&state.db().await, &id).await?)
}

/// Compares two environments' entities (read only) and stores the report.
#[tauri::command]
pub async fn automation_drift_run(state: State<'_, AppState>, request: DriftRequest) -> IpcResult<DriftReport> {
  Ok(drift::run(&state.db().await, &request).await?)
}

/// Both environments' normalised XML of one entity, for the diff view. A side without it is empty.
#[tauri::command]
pub async fn automation_drift_entity_xml(
  state: State<'_, AppState>,
  env_a: String,
  env_b: String,
  entity_type: String,
  name: String,
) -> IpcResult<(String, String)> {
  Ok(drift::entity_xml(&state.db().await, &env_a, &env_b, &entity_type, &name).await?)
}

#[tauri::command]
pub async fn automation_schedules_list(state: State<'_, AppState>) -> IpcResult<Vec<Schedule>> {
  Ok(schedule::list(&state.db().await).await?)
}

#[tauri::command]
pub async fn automation_schedule_save(state: State<'_, AppState>, input: ScheduleInput) -> IpcResult<Schedule> {
  Ok(schedule::save(&state.db().await, input).await?)
}

#[tauri::command]
pub async fn automation_schedule_enable(state: State<'_, AppState>, id: String, enabled: bool) -> IpcResult<Schedule> {
  Ok(schedule::set_enabled(&state.db().await, &id, enabled).await?)
}

#[tauri::command]
pub async fn automation_schedule_delete(state: State<'_, AppState>, id: String) -> IpcResult<()> {
  Ok(schedule::delete(&state.db().await, &id).await?)
}

/// Runs a schedule's task now, outside its timetable, and returns the schedule with its new last-run result.
#[tauri::command]
pub async fn automation_schedule_run(state: State<'_, AppState>, id: String) -> IpcResult<Schedule> {
  Ok(schedule::run_now(&state.assistant, &id, None).await?)
}
