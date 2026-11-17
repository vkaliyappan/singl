//! The Repository pages: each slot (1 = TWX, 2 = Windchill) keeps
//! its own clone under `<workspace>/repo/<slug>`. Commands take `slot`,
//! defaulting to 1. Long
//! git operations stream their output over `on_event` as `JobEvent::Log`
//! lines and resolve when git finishes.

use std::path::PathBuf;

use singl_core::db::{self, repo::RepoState};
use singl_core::jobs::JobEvent;
use singl_core::repo::files::{self, SearchFileResult, SearchOptions};
use singl_core::repo::git::{self, Auth, ChangedFile, FileDiff};
use singl_core::workspace::PathKind;
use singl_core::CoreError;
use tauri::ipc::Channel;
use tauri::State;

use crate::error::IpcResult;
use crate::state::AppState;

fn repos_dir(state: &AppState) -> IpcResult<PathBuf> {
  let workspace = state.workspace.read().unwrap_or_else(|e| e.into_inner());
  Ok(
    workspace
      .resolve(PathKind::Repo)
      .ok_or_else(|| CoreError::Invalid("No workspace folder is set. Choose one in Settings.".into()))?,
  )
}

const SLOTS: i64 = 2;

fn slot_id(slot: Option<i64>) -> IpcResult<i64> {
  match slot.unwrap_or(1) {
    s @ 1..=SLOTS => Ok(s),
    s => Err(CoreError::Invalid(format!("Unknown repository slot {s}.")).into()),
  }
}

/// The slot's saved repository, its clone folder, and credentials for its remote.
async fn current(state: &AppState, slot: Option<i64>) -> IpcResult<(RepoState, PathBuf, Auth)> {
  let slot = slot_id(slot)?;
  let pool = state.db().await;
  let repo = db::repo::get(&pool, slot).await?;
  if repo.repo_slug.is_empty() {
    return Err(CoreError::Invalid("No repository configured.".into()).into());
  }
  let path = files::safe_join(&repos_dir(state)?, &repo.repo_slug)?;
  let pat = db::settings::azure_pat_token(&pool).await?;
  let auth = Auth::new(&repo.repo_url, pat.as_deref());
  Ok((repo, path, auth))
}

fn logger(on_event: &Channel<JobEvent>) -> impl FnMut(String) + Send + '_ {
  move |line| {
    let _ = on_event.send(JobEvent::Log { line });
  }
}

#[tauri::command]
pub async fn repo_get(state: State<'_, AppState>, slot: Option<i64>) -> IpcResult<RepoState> {
  Ok(db::repo::get(&state.db().await, slot_id(slot)?).await?)
}

#[tauri::command]
pub async fn repo_branches(state: State<'_, AppState>, repo_url: String) -> IpcResult<Vec<String>> {
  let pat = db::settings::azure_pat_token(&state.db().await).await?;
  Ok(git::branches(repo_url.trim(), &Auth::new(&repo_url, pat.as_deref())).await?)
}

/// Clones `branch` alone, replacing any earlier clone of the same repo, and
/// saves it as the slot's repository. Returns the slug.
#[tauri::command]
pub async fn repo_clone(
  state: State<'_, AppState>,
  slot: Option<i64>,
  repo_url: String,
  branch: String,
  on_event: Channel<JobEvent>,
) -> IpcResult<String> {
  let slot = slot_id(slot)?;
  let repo_url = repo_url.trim();
  let slug = git::slug(repo_url);
  let dest = files::safe_join(&repos_dir(&state)?, &slug)?;
  let pool = state.db().await;
  // Both slots clone under the same folder, so one repo can't sit in two slots.
  for other in (1..=SLOTS).filter(|&s| s != slot) {
    if db::repo::get(&pool, other).await?.repo_slug == slug {
      let msg = format!("\"{slug}\" is already cloned in the other repository page (TWX / Windchill). Use it there.");
      return Err(CoreError::Invalid(msg).into());
    }
  }
  let pat = db::settings::azure_pat_token(&pool).await?;
  let job = state.jobs.start();
  git::clone(&dest, repo_url, &branch, &Auth::new(repo_url, pat.as_deref()), &job.token, &mut logger(&on_event)).await?;
  db::repo::save(&pool, slot, repo_url, &branch, &slug).await?;
  Ok(slug)
}

#[tauri::command]
pub async fn repo_checkout(
  state: State<'_, AppState>,
  slot: Option<i64>,
  branch: String,
  on_event: Channel<JobEvent>,
) -> IpcResult<()> {
  let (repo, path, auth) = current(&state, slot).await?;
  let job = state.jobs.start();
  git::checkout(&path, &repo.repo_url, &branch, &auth, &job.token, &mut logger(&on_event)).await?;
  Ok(db::repo::set_branch(&state.db().await, slot_id(slot)?, &branch).await?)
}

#[tauri::command]
pub async fn repo_fetch(state: State<'_, AppState>, slot: Option<i64>, on_event: Channel<JobEvent>) -> IpcResult<()> {
  let (repo, path, auth) = current(&state, slot).await?;
  let job = state.jobs.start();
  Ok(git::fetch(&path, &repo.repo_url, &auth, &job.token, &mut logger(&on_event)).await?)
}

/// Returns git's summary line, e.g. "Already up to date.".
#[tauri::command]
pub async fn repo_pull(state: State<'_, AppState>, slot: Option<i64>, on_event: Channel<JobEvent>) -> IpcResult<String> {
  let (repo, path, auth) = current(&state, slot).await?;
  let job = state.jobs.start();
  Ok(git::pull(&path, &repo.repo_url, &auth, &job.token, &mut logger(&on_event)).await?)
}

#[tauri::command]
pub async fn repo_status(state: State<'_, AppState>, slot: Option<i64>) -> IpcResult<Vec<ChangedFile>> {
  let (_, path, _) = current(&state, slot).await?;
  Ok(git::status(&path).await?)
}

/// `file` is relative to the clone.
#[tauri::command]
pub async fn repo_diff(state: State<'_, AppState>, slot: Option<i64>, file: String) -> IpcResult<FileDiff> {
  let (_, path, _) = current(&state, slot).await?;
  Ok(git::diff(&path, &file).await?)
}

/// Every path in the clone; see [`files::list_paths`].
#[tauri::command]
pub async fn repo_files(state: State<'_, AppState>, slot: Option<i64>) -> IpcResult<Vec<String>> {
  let (_, path, _) = current(&state, slot).await?;
  Ok(tauri::async_runtime::spawn_blocking(move || files::list_paths(&path)).await.map_err(io_join)??)
}

/// `path` is relative to the clone.
#[tauri::command]
pub async fn repo_file_content(state: State<'_, AppState>, slot: Option<i64>, path: String) -> IpcResult<String> {
  let (_, root, _) = current(&state, slot).await?;
  Ok(files::read_text(&files::safe_join(&root, &path)?)?)
}

#[tauri::command]
pub async fn repo_search(
  state: State<'_, AppState>,
  slot: Option<i64>,
  query: String,
  options: SearchOptions,
) -> IpcResult<Vec<SearchFileResult>> {
  let (_, root, _) = current(&state, slot).await?;
  Ok(tauri::async_runtime::spawn_blocking(move || files::search(&root, &query, options)).await.map_err(io_join)??)
}

/// Removes the `Code/` folders Extract generated. Returns how many projects were cleared.
#[tauri::command]
pub async fn repo_clean(state: State<'_, AppState>, slot: Option<i64>) -> IpcResult<usize> {
  let (_, path, _) = current(&state, slot).await?;
  Ok(tauri::async_runtime::spawn_blocking(move || files::clean_extracted(&path)).await.map_err(io_join)??)
}

fn io_join(err: tauri::Error) -> CoreError {
  CoreError::Io(std::io::Error::other(err.to_string()))
}
