//! singl-web's `/api/twx/*` and `/api/twx-cli/*` routes. Relative paths
//! resolve against the workspace folder, where singl-web used its cwd. Long
//! runs stream progress over `on_event` as `JobEvent::Log` lines and resolve
//! with the run's result.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use singl_core::jobs::JobEvent;
use singl_core::repo::files::safe_join;
use singl_core::twx::connectors::{self, ConnectorInfo, ConnectorUpdate, ConnectorUpdateResult};
use singl_core::twx::deployment::{self, BackupFormat, BackupResult, ExtractResult, UploadOptions, UploadResult};
use singl_core::twx::{api::RepositoryDir, bundle, export, extract_services, projects, run_times, stamp};
use singl_core::workspace::{PathKind, Workspace};
use singl_core::{CoreError, db};
use tauri::State;
use tauri::ipc::Channel;

use crate::error::IpcResult;
use crate::state::AppState;

fn workspace(state: &AppState) -> Workspace {
  state.workspace.read().unwrap_or_else(|e| e.into_inner()).clone()
}

fn no_workspace() -> CoreError {
  CoreError::Invalid("No workspace folder is set. Choose one in Settings.".into())
}

/// `input` (or `default` when blank) against the workspace folder.
fn resolve(state: &AppState, input: Option<&str>, default: &str) -> IpcResult<PathBuf> {
  let path = input.map(str::trim).filter(|p| !p.is_empty()).unwrap_or(default);
  Ok(workspace(state).resolve_path(path).ok_or_else(no_workspace)?)
}

/// Like [`resolve`], but refuses a path outside the workspace folder.
fn resolve_inside(state: &AppState, input: Option<&str>, default: &str) -> IpcResult<PathBuf> {
  let path = resolve(state, input, default)?;
  let root = workspace(state).root().map(Path::to_path_buf).ok_or_else(no_workspace)?;
  if !path.starts_with(&root) {
    return Err(CoreError::Invalid("Invalid path — must be within the workspace folder".into()).into());
  }
  Ok(path)
}

fn logger(on_event: &Channel<JobEvent>) -> impl FnMut(String) + Send + '_ {
  move |line| {
    let _ = on_event.send(JobEvent::Log { line });
  }
}

fn blank_to_none(s: &Option<String>) -> Option<&str> {
  s.as_deref().map(str::trim).filter(|s| !s.is_empty())
}

/// Runs blocking file work off the async runtime.
async fn blocking<T: Send + 'static>(f: impl FnOnce() -> singl_core::Result<T> + Send + 'static) -> IpcResult<T> {
  Ok(
    tauri::async_runtime::spawn_blocking(f)
      .await
      .map_err(|e| CoreError::Io(std::io::Error::other(e.to_string())))??,
  )
}

// ── Entity export ────────────────────────────────────────────────────────────

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportArgs {
  env: String,
  project: Option<String>,
  /// Default `./WindchillClients/ThingWorx`.
  output: Option<String>,
  /// Export into `backup/<timestamp>` instead of `output`.
  #[serde(default)]
  backup: bool,
  #[serde(default)]
  dry_run: bool,
}

/// `POST /api/twx/export`: every configured project's entities as XML files.
#[tauri::command]
pub async fn twx_export(
  state: State<'_, AppState>,
  args: ExportArgs,
  on_event: Channel<JobEvent>,
) -> IpcResult<export::ExportResult> {
  let pool = state.db().await;
  let client = projects::connect(&pool, &args.env).await?;
  let projects = projects::selected_projects(&pool, Some(&args.env), blank_to_none(&args.project)).await?;
  let mut log = logger(&on_event);
  let output = if args.backup {
    let dir = workspace(&state).resolve(PathKind::Backup).ok_or_else(no_workspace)?;
    let dir = dir.join(stamp::iso_now().replace([':', '.'], "-"));
    log(format!("Backup mode: exporting to {}", dir.display()));
    dir
  } else {
    resolve(&state, args.output.as_deref(), "./WindchillClients/ThingWorx")?
  };
  let job = state.jobs.start();
  Ok(export::run(&client, &projects, &output, args.dry_run, &job.token, &mut log).await?)
}

// ── Deployment files ─────────────────────────────────────────────────────────

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportDeploymentArgs {
  env: String,
  project: Option<String>,
  /// Default `./export`.
  output: Option<String>,
  /// Folder for this run; defaults to a UTC timestamp like `20261103-140506`.
  parent: Option<String>,
  suffix: Option<String>,
  #[serde(default)]
  dry_run: bool,
}

/// `POST /api/twx/export-deploymentfiles`: each project as a ZIP, downloaded.
#[tauri::command]
pub async fn twx_export_deployment_files(
  state: State<'_, AppState>,
  args: ExportDeploymentArgs,
  on_event: Channel<JobEvent>,
) -> IpcResult<deployment::ExportResult> {
  let pool = state.db().await;
  let client = projects::connect(&pool, &args.env).await?;
  let projects = projects::selected_projects(&pool, Some(&args.env), blank_to_none(&args.project)).await?;
  let output = resolve(&state, args.output.as_deref(), "./export")?;
  let parent = blank_to_none(&args.parent).map_or_else(stamp::compact_now, str::to_string);
  if parent.split(['/', '\\']).any(|s| s == "..") {
    return Err(CoreError::Invalid("Folder name must not contain \"..\".".into()).into());
  }
  let job = state.jobs.start();
  let mut log = logger(&on_event);
  Ok(
    deployment::export(&client, &projects, &output, &parent, blank_to_none(&args.suffix), args.dry_run, &job.token, &mut log)
      .await?,
  )
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtractDeploymentArgs {
  env: Option<String>,
  project: Option<String>,
  /// Folder holding the per-project folders; default `./export`.
  input: Option<String>,
  /// Default `./WindchillClients/ThingWorx`.
  output: Option<String>,
  #[serde(default)]
  dry_run: bool,
}

/// `POST /api/twx/extract-deploymentfiles`: downloaded ZIPs into formatted entity XML.
#[tauri::command]
pub async fn twx_extract_deployment_files(
  state: State<'_, AppState>,
  args: ExtractDeploymentArgs,
  on_event: Channel<JobEvent>,
) -> IpcResult<ExtractResult> {
  let pool = state.db().await;
  let projects = projects::selected_projects(&pool, blank_to_none(&args.env), blank_to_none(&args.project)).await?;
  let input = resolve(&state, args.input.as_deref(), "./export")?;
  let output = resolve(&state, args.output.as_deref(), "./WindchillClients/ThingWorx")?;
  let job = state.jobs.start();
  let token = job.token.clone();
  blocking(move || deployment::extract(&projects, &input, &output, args.dry_run, &token, &mut logger(&on_event))).await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupArgs {
  env: String,
  project: Option<String>,
  /// Repository folder holding one subfolder per project.
  parent: String,
  suffix: Option<String>,
  #[serde(default = "default_backup_format")]
  format: BackupFormat,
  #[serde(default)]
  dry_run: bool,
}

fn default_backup_format() -> BackupFormat {
  BackupFormat::Entities
}

/// `POST /api/twx/backup-deploymentfiles`: back projects up on the server itself.
#[tauri::command]
pub async fn twx_backup_deployment_files(
  state: State<'_, AppState>,
  args: BackupArgs,
  on_event: Channel<JobEvent>,
) -> IpcResult<BackupResult> {
  let pool = state.db().await;
  let client = projects::connect(&pool, &args.env).await?;
  let projects = projects::selected_projects(&pool, Some(&args.env), blank_to_none(&args.project)).await?;
  let job = state.jobs.start();
  let mut log = logger(&on_event);
  Ok(
    deployment::backup(
      &client,
      &projects,
      &args.parent,
      blank_to_none(&args.suffix),
      args.format,
      args.dry_run,
      &job.token,
      &mut log,
    )
    .await?,
  )
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadArgs {
  env: String,
  /// Local folder to upload.
  source: String,
  /// SystemRepository folder, e.g. `/Deploy/RC1`.
  target: String,
  #[serde(flatten)]
  options: UploadOptions,
}

/// `POST /api/twx/upload-deploymentfiles`: a local folder into SystemRepository.
#[tauri::command]
pub async fn twx_upload_deployment_files(
  state: State<'_, AppState>,
  args: UploadArgs,
  on_event: Channel<JobEvent>,
) -> IpcResult<UploadResult> {
  if args.source.trim().is_empty() {
    return Err(CoreError::Invalid("Source directory is required.".into()).into());
  }
  let source = resolve(&state, Some(&args.source), "")?;
  let client = projects::connect(&state.db().await, &args.env).await?;
  let job = state.jobs.start();
  let mut log = logger(&on_event);
  Ok(deployment::upload(&client, &source, &args.target, args.options, &job.token, &mut log).await?)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoDirs {
  entries: Vec<RepositoryDir>,
  current_path: String,
}

/// `GET /api/twx/repo-dirs`: folders of SystemRepository at `path`.
#[tauri::command]
pub async fn twx_repo_dirs(state: State<'_, AppState>, env: String, path: Option<String>) -> IpcResult<RepoDirs> {
  let current_path = deployment::normalize_repository_dir(path.as_deref().unwrap_or("/"));
  let client = projects::connect(&state.db().await, &env).await?;
  let entries = client.list_repository_directories(deployment::REPOSITORY, &current_path).await?;
  Ok(RepoDirs { entries, current_path })
}

// ── Connectors ───────────────────────────────────────────────────────────────

/// `GET /api/twx/connectors`: integration connectors in a local entity folder.
#[tauri::command]
pub async fn twx_connectors(state: State<'_, AppState>, source: String) -> IpcResult<Vec<ConnectorInfo>> {
  if source.trim().is_empty() {
    return Ok(Vec::new());
  }
  let source = resolve(&state, Some(&source), "")?;
  blocking(move || connectors::scan(&source)).await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateConnectorsArgs {
  source: String,
  dest: String,
  #[serde(default)]
  updates: Vec<ConnectorUpdate>,
  /// Empty `dest` first; only allowed inside the workspace folder.
  #[serde(default)]
  clean_dest: bool,
  #[serde(default)]
  dry_run: bool,
}

/// `POST /api/twx/update-connectors`: copy a folder and rewrite connector endpoints in the copy.
#[tauri::command]
pub async fn twx_update_connectors(
  state: State<'_, AppState>,
  args: UpdateConnectorsArgs,
  on_event: Channel<JobEvent>,
) -> IpcResult<ConnectorUpdateResult> {
  if args.source.trim().is_empty() {
    return Err(CoreError::Invalid("Source directory is required.".into()).into());
  }
  if args.dest.trim().is_empty() {
    return Err(CoreError::Invalid("Destination directory is required.".into()).into());
  }
  let source = resolve(&state, Some(&args.source), "")?;
  let dest = resolve(&state, Some(&args.dest), "")?;
  if args.clean_dest {
    // Clearing deletes a whole folder, so only a subfolder of the workspace qualifies.
    let root = workspace(&state).root().map(Path::to_path_buf).ok_or_else(no_workspace)?;
    if dest == root || !dest.starts_with(&root) {
      return Err(
        CoreError::Invalid("\"Clear destination\" is only allowed for a folder inside the workspace.".into()).into(),
      );
    }
  }
  let job = state.jobs.start();
  let token = job.token.clone();
  blocking(move || {
    connectors::run_update(&source, &dest, &args.updates, args.clean_dest, args.dry_run, &token, &mut logger(&on_event))
  })
  .await
}

// ── twx-cli ──────────────────────────────────────────────────────────────────

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BundleArgs {
  env: Option<String>,
  project: Option<String>,
  /// Defaults to Settings → Bundle Source Directory.
  src: Option<String>,
  /// Defaults to Settings → Bundle Destination Directory.
  dest: Option<String>,
  #[serde(default)]
  dry_run: bool,
}

/// `POST /api/twx-cli/bundle`: one ZIP per project alias folder.
#[tauri::command]
pub async fn twx_cli_bundle(
  state: State<'_, AppState>,
  args: BundleArgs,
  on_event: Channel<JobEvent>,
) -> IpcResult<bundle::BundleResult> {
  let pool = state.db().await;
  let settings = db::settings::get(&pool).await?;
  let src = resolve_inside(&state, args.src.as_deref(), &settings.bundle_src_dir)?;
  let dest = resolve_inside(&state, args.dest.as_deref(), &settings.bundle_dest_dir)?;
  let projects = projects::deploy_projects(&pool, blank_to_none(&args.env)).await?;
  if projects.is_empty() {
    return Err(CoreError::Invalid("No projects found in database. Configure projects in Settings first.".into()).into());
  }
  let job = state.jobs.start();
  let token = job.token.clone();
  blocking(move || {
    bundle::run(&projects, &src, &dest, blank_to_none(&args.project), args.dry_run, &token, &mut logger(&on_event))
  })
  .await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CliExtractArgs {
  /// Extract `twx-entities/<env>`…
  env_name: Option<String>,
  /// …or the clone `repo/<slug>`.
  repo_slug: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliExtractResult {
  projects: usize,
  /// Set when an environment was extracted.
  extracted_at: Option<String>,
}

/// `POST /api/twx-cli/extract`: service code, mashup scripts and DataShape
/// types into each project's `Code/` folder (singl-web's gulp `extract-services`).
#[tauri::command]
pub async fn twx_cli_extract(
  state: State<'_, AppState>,
  args: CliExtractArgs,
  on_event: Channel<JobEvent>,
) -> IpcResult<CliExtractResult> {
  let ws = workspace(&state);
  let (dir, label, env) = if let Some(env) = blank_to_none(&args.env_name) {
    let safe = run_times::safe_env(env);
    let dir = ws.resolve(PathKind::TwxEntities).ok_or_else(no_workspace)?.join(&safe).join("WindchillClients").join("Thingworx");
    (dir, format!("twx-entities/{safe}"), Some(safe))
  } else if let Some(slug) = blank_to_none(&args.repo_slug) {
    let repo = safe_join(&ws.resolve(PathKind::Repo).ok_or_else(no_workspace)?, slug)?;
    let direct = repo.join("ThingWorx");
    let dir = if direct.is_dir() { direct } else { repo.join("WindchillClients").join("ThingWorx") };
    (dir, format!("repo/{slug}"), None)
  } else {
    return Err(CoreError::Invalid("Either envName or repoSlug is required".into()).into());
  };
  if !dir.is_dir() {
    return Err(CoreError::NotFound(format!("WindchillClients/ThingWorx not found in {label}. Run Export first.")).into());
  }

  let run_times_file = ws.resolve(PathKind::RunTimes).ok_or_else(no_workspace)?;
  let job = state.jobs.start();
  let token = job.token.clone();
  blocking(move || {
    let mut log = logger(&on_event);
    log(format!("Running extract-services on {label}..."));
    let projects = extract_services::run(&dir, &token, &mut log)?;
    let extracted_at = match env {
      Some(env) => Some(run_times::record(&run_times_file, &env, run_times::RunKind::Extracted)?),
      None => None,
    };
    Ok(CliExtractResult { projects, extracted_at })
  })
  .await
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn args_from_the_ui() {
    let upload: UploadArgs = serde_json::from_str(
      r#"{"env":"test","source":"./bundles","target":"/Deploy","extract":true,"extractSubfolder":true,"dryRun":true}"#,
    )
    .unwrap();
    assert!(upload.options.extract && upload.options.extract_subfolder && upload.options.dry_run);
    assert!(!upload.options.delete_zip);

    let backup: BackupArgs = serde_json::from_str(r#"{"env":"test","parent":"Backup_1","format":"zip"}"#).unwrap();
    assert_eq!(backup.format, BackupFormat::Zip);
    let backup: BackupArgs = serde_json::from_str(r#"{"env":"test","parent":"Backup_1"}"#).unwrap();
    assert_eq!(backup.format, BackupFormat::Entities);

    let update: UpdateConnectorsArgs = serde_json::from_str(
      r#"{"source":"a","dest":"b","updates":[{"relPath":"x.xml","urlMap":{"https://a":"https://b"},"username":null}]}"#,
    )
    .unwrap();
    assert_eq!(update.updates[0].url_map["https://a"], "https://b");
    let extract: CliExtractArgs = serde_json::from_str(r#"{"repoSlug":"WindchillClients"}"#).unwrap();
    assert_eq!(extract.repo_slug.as_deref(), Some("WindchillClients"));
  }
}
