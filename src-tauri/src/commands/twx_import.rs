//! Tauri commands for importing entity XML into a ThingWorx server. File
//! paths are relative to `<workspace>/twx-entities`; backups live under
//! `<workspace>/twx-backups`.

use std::path::PathBuf;

use serde::Deserialize;
use singl_core::jobs::JobEvent;
use singl_core::repo::files::safe_join;
use singl_core::twx::import::{self, BackupInfo, ImportResult, PreviewItem};
use singl_core::twx::projects;
use singl_core::workspace::PathKind;
use singl_core::CoreError;
use tauri::State;
use tauri::ipc::Channel;

use crate::error::IpcResult;
use crate::state::AppState;

/// The workspace root and its twx-entities folder.
fn folders(state: &AppState) -> IpcResult<(PathBuf, PathBuf)> {
  let workspace = state.workspace.read().unwrap_or_else(|e| e.into_inner());
  let none = || CoreError::Invalid("No workspace folder is set. Choose one in Settings.".into());
  let root = workspace.root().map(PathBuf::from).ok_or_else(none)?;
  let entities = workspace.resolve(PathKind::TwxEntities).ok_or_else(none)?;
  Ok((root, entities))
}

fn logger(on_event: &Channel<JobEvent>) -> impl FnMut(String) + Send + '_ {
  move |line| {
    let _ = on_event.send(JobEvent::Log { line });
  }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportArgs {
  env: String,
  files: Vec<String>,
}

/// Each file against the server's current version of its entity.
#[tauri::command]
pub async fn twx_import_preview(state: State<'_, AppState>, args: ImportArgs) -> IpcResult<Vec<PreviewItem>> {
  let (_, base) = folders(&state)?;
  let client = projects::connect(&state.db().await, &args.env).await?;
  let sources = import::read_sources(&base, &args.files)?;
  Ok(import::preview(&client, &sources).await)
}

/// Backs up the server's current versions, then imports the files.
#[tauri::command]
pub async fn twx_import_run(
  state: State<'_, AppState>,
  args: ImportArgs,
  on_event: Channel<JobEvent>,
) -> IpcResult<ImportResult> {
  let (root, base) = folders(&state)?;
  let client = projects::connect(&state.db().await, &args.env).await?;
  let sources = import::read_sources(&base, &args.files)?;
  Ok(import::import(&client, &args.env, &sources, &root, &mut logger(&on_event)).await?)
}

#[tauri::command]
pub async fn twx_import_backups(state: State<'_, AppState>, env: String) -> IpcResult<Vec<BackupInfo>> {
  let (root, _) = folders(&state)?;
  Ok(import::list_backups(&root, &env)?)
}

/// Imports a backup's files (which backs up the current state first, too).
#[tauri::command]
pub async fn twx_import_restore(
  state: State<'_, AppState>,
  env: String,
  dir: String,
  on_event: Channel<JobEvent>,
) -> IpcResult<ImportResult> {
  let (root, _) = folders(&state)?;
  let client = projects::connect(&state.db().await, &env).await?;
  let sources = import::backup_sources(&root, &env, &dir)?;
  Ok(import::import(&client, &env, &sources, &root, &mut logger(&on_event)).await?)
}

/// Shows a backup folder (relative to the workspace) in the file manager.
#[tauri::command]
pub async fn twx_import_open_backup(state: State<'_, AppState>, dir: String) -> IpcResult<()> {
  let (root, _) = folders(&state)?;
  let rel = dir.replace('\\', "/");
  if !rel.starts_with(&format!("{}/", import::BACKUP_FOLDER)) {
    return Err(CoreError::Invalid("Not a backup folder.".into()).into());
  }
  let path = safe_join(&root, &rel)?;
  let program = if cfg!(windows) {
    "explorer"
  } else if cfg!(target_os = "macos") {
    "open"
  } else {
    "xdg-open"
  };
  std::process::Command::new(program).arg(path).spawn().map_err(CoreError::from)?;
  Ok(())
}
