//! singl-web's `/api/twx-entities/*` routes: the exported entity files under
//! `<workspace>/twx-entities`. Paths are relative to that folder and
//! `/`-separated; the first part is the environment folder.

use std::path::PathBuf;

use singl_core::jobs::JobEvent;
use singl_core::repo::files::{self, SearchFileResult, SearchOptions};
use singl_core::twx::entities::{self, EntityExportResult, ExportJob, FoundEntry, LocatedEntity};
use singl_core::twx::{projects, run_times};
use singl_core::workspace::PathKind;
use singl_core::{CoreError, db};
use tauri::State;
use tauri::ipc::Channel;

use crate::error::IpcResult;
use crate::state::AppState;

fn base(state: &AppState) -> IpcResult<PathBuf> {
  let workspace = state.workspace.read().unwrap_or_else(|e| e.into_inner());
  Ok(
    workspace
      .resolve(PathKind::TwxEntities)
      .ok_or_else(|| CoreError::Invalid("No workspace folder is set. Choose one in Settings.".into()))?,
  )
}

/// Runs blocking file work off the async runtime.
async fn blocking<T: Send + 'static>(f: impl FnOnce() -> singl_core::Result<T> + Send + 'static) -> IpcResult<T> {
  Ok(
    tauri::async_runtime::spawn_blocking(f)
      .await
      .map_err(|e| CoreError::Io(std::io::Error::other(e.to_string())))??,
  )
}

/// Every file under `path`, relative to it; empty folders end in "/".
#[tauri::command]
pub async fn entity_files(state: State<'_, AppState>, path: String) -> IpcResult<Vec<String>> {
  let base = base(&state)?;
  blocking(move || entities::list(&base, &path)).await
}

#[tauri::command]
pub async fn entity_read(state: State<'_, AppState>, path: String) -> IpcResult<String> {
  let base = base(&state)?;
  blocking(move || entities::read(&base, &path)).await
}

/// Saves an existing file.
#[tauri::command]
pub async fn entity_write(state: State<'_, AppState>, path: String, content: String) -> IpcResult<()> {
  let base = base(&state)?;
  blocking(move || entities::write(&base, &path, &content)).await
}

/// An empty file, or a folder when `dir`, inside `parent`. Resolves with its path.
#[tauri::command]
pub async fn entity_create(state: State<'_, AppState>, parent: String, name: String, dir: bool) -> IpcResult<String> {
  let base = base(&state)?;
  blocking(move || entities::create(&base, &parent, &name, dir)).await
}

/// Resolves with the new path.
#[tauri::command]
pub async fn entity_rename(state: State<'_, AppState>, path: String, name: String) -> IpcResult<String> {
  let base = base(&state)?;
  blocking(move || entities::rename(&base, &path, &name)).await
}

#[tauri::command]
pub async fn entity_delete(state: State<'_, AppState>, path: String) -> IpcResult<()> {
  let base = base(&state)?;
  blocking(move || entities::delete(&base, &path)).await
}

/// Text search under `root`; result paths are relative to it.
#[tauri::command]
pub async fn entity_search(
  state: State<'_, AppState>,
  root: String,
  query: String,
  options: SearchOptions,
) -> IpcResult<Vec<SearchFileResult>> {
  let root = files::safe_join(&base(&state)?, &root)?;
  blocking(move || files::search(&root, &query, options)).await
}

/// Files and folders under one environment folder whose name (or path) matches `query`, best first.
#[tauri::command]
pub async fn entity_find(
  state: State<'_, AppState>,
  root: String,
  query: String,
  limit: Option<usize>,
) -> IpcResult<Vec<FoundEntry>> {
  let base = base(&state)?;
  let limit = limit.unwrap_or(30).clamp(1, 100);
  blocking(move || entities::find(&base, &root, &query, limit)).await
}

/// An exported entity's XML file and the scripts extracted from it.
/// `collection` is the REST collection ("Things"); every one is tried without it.
#[tauri::command]
pub async fn entity_locate(
  state: State<'_, AppState>,
  env: String,
  entity: String,
  collection: Option<String>,
  service: Option<String>,
) -> IpcResult<LocatedEntity> {
  let base = base(&state)?;
  let blank = |s: Option<String>| s.map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
  let (env, entity) = (env.trim().to_string(), entity.trim().to_string());
  if env.is_empty() || entity.is_empty() {
    return Err(CoreError::Invalid("env and entity are required".into()).into());
  }
  let (collection, service) = (blank(collection), blank(service));
  let env_dir = run_times::safe_env(&env);
  let found = {
    let entity = entity.clone();
    blocking(move || entities::locate(&base, &env_dir, &entity, collection.as_deref(), service.as_deref())).await?
  };
  found.ok_or_else(|| {
    CoreError::NotFound(format!("{entity} has not been exported for {env} yet — export it from TWX Entities first."))
      .into()
  })
}

/// When `env` was last exported and extracted.
#[tauri::command]
pub async fn entity_run_times(state: State<'_, AppState>, env: String) -> IpcResult<run_times::RunTimes> {
  let workspace = state.workspace.read().unwrap_or_else(|e| e.into_inner()).clone();
  let file = workspace
    .resolve(PathKind::RunTimes)
    .ok_or_else(|| CoreError::Invalid("No workspace folder is set. Choose one in Settings.".into()))?;
  if env.trim().is_empty() {
    return Ok(run_times::RunTimes::default());
  }
  Ok(run_times::get(&file, &run_times::safe_env(&env)))
}

/// Exports `project` (or every project configured for `env`, or every project
/// on the server when none is configured) into `<env folder>/WindchillClients/Thingworx`.
#[tauri::command]
pub async fn entity_export(
  state: State<'_, AppState>,
  env: String,
  project: Option<String>,
  on_event: Channel<JobEvent>,
) -> IpcResult<EntityExportResult> {
  let base = base(&state)?;
  let pool = state.db().await;
  let client = projects::connect(&pool, &env).await?;
  let configured: Vec<ExportJob> = db::environments::list(&pool)
    .await?
    .into_iter()
    .filter(|e| e.environment == env)
    .flat_map(|e| e.projects)
    .map(|p| ExportJob {
      folder_name: Some(p.folder_name.trim()).filter(|f| !f.is_empty()).unwrap_or(&p.project_name).to_string(),
      alias: Some(p.alias.trim()).filter(|a| !a.is_empty()).unwrap_or(&p.project_name).to_string(),
      twx_name: p.project_name,
      exports: p.exports,
    })
    .collect();

  let mut log = move |line: String| {
    let _ = on_event.send(JobEvent::Log { line });
  };
  let jobs = match project.as_deref().map(str::trim).filter(|p| !p.is_empty()) {
    // A specific project: its Settings entry, if any, gives the filter and folders.
    Some(name) => Some(vec![configured.into_iter().find(|j| j.twx_name == name).unwrap_or_else(|| ExportJob {
      twx_name: name.into(),
      folder_name: name.into(),
      alias: name.into(),
      exports: vec!["all".into()],
    })]),
    None if !configured.is_empty() => {
      let names: Vec<_> = configured.iter().map(|j| j.twx_name.as_str()).collect();
      log(format!("Exporting {} configured project(s): {}", names.len(), names.join(", ")));
      Some(configured)
    }
    None => None,
  };

  let safe_env = run_times::safe_env(&env);
  let job = state.jobs.start();
  let mut result = entities::export(&client, &base, &safe_env, jobs, &job.token, &mut log).await?;
  let run_times_file = state.workspace.read().unwrap_or_else(|e| e.into_inner()).resolve(PathKind::RunTimes);
  if let Some(file) = run_times_file {
    result.exported_at = Some(run_times::record(&file, &safe_env, run_times::RunKind::Exported)?);
  }
  Ok(result)
}
