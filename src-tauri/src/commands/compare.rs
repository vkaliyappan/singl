//! singl-web's `/api/compare/*` routes: the repository clone under
//! `<workspace>/repo/<slug>/<repo subpath>` (left) against
//! `<workspace>/twx-entities/<env>/<TWX root prefix>` (right), with the
//! subpath and prefix from Settings. Paths are relative to both roots.

use std::path::{Path, PathBuf};

use serde::Serialize;
use singl_core::compare::{self, DiffTree, SearchResults, Side};
use singl_core::repo::files::{SearchOptions, safe_join};
use singl_core::twx::run_times::safe_env;
use singl_core::workspace::PathKind;
use singl_core::{CoreError, db};
use tauri::State;

use crate::error::IpcResult;
use crate::state::AppState;

struct Roots {
  workspace: PathBuf,
  left: PathBuf,
  right: PathBuf,
}

async fn roots(state: &AppState, env: &str) -> IpcResult<Roots> {
  if env.trim().is_empty() {
    return Err(CoreError::Invalid("env is required".into()).into());
  }
  let workspace = state.workspace.read().unwrap_or_else(|e| e.into_inner()).clone();
  let no_workspace = || CoreError::Invalid("No workspace folder is set. Choose one in Settings.".into());
  let (Some(root), Some(repos), Some(entities)) =
    (workspace.root(), workspace.resolve(PathKind::Repo), workspace.resolve(PathKind::TwxEntities))
  else {
    return Err(no_workspace().into());
  };

  let pool = state.db().await;
  let repo = db::repo::get(&pool, 1).await?;
  if repo.repo_slug.is_empty() {
    return Err(CoreError::Invalid("No repository configured. Clone a repo first.".into()).into());
  }
  let app = db::settings::get(&pool).await?;
  let left = safe_join(&safe_join(&repos, &repo.repo_slug)?, &app.repo_root_subpath)
    .map_err(|_| CoreError::Invalid("Invalid repo subpath".into()))?;
  let right = safe_join(&entities.join(safe_env(env)), &app.twx_root_prefix)
    .map_err(|_| CoreError::Invalid("Invalid TWX root prefix".into()))?;
  Ok(Roots { workspace: root.to_path_buf(), left, right })
}

/// Relative to the workspace and `/`-separated, for messages.
fn shown(workspace: &Path, path: &Path) -> String {
  path.strip_prefix(workspace).unwrap_or(path).to_string_lossy().replace('\\', "/")
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompareTree {
  left_root: String,
  right_root: String,
  #[serde(flatten)]
  tree: DiffTree,
}

/// Both sides merged into one tree, each node marked by how it differs.
#[tauri::command]
pub async fn compare_tree(state: State<'_, AppState>, env: String) -> IpcResult<CompareTree> {
  let Roots { workspace, left, right } = roots(&state, &env).await?;
  if !left.is_dir() {
    return Err(CoreError::NotFound(format!("Repository path not found: {}", shown(&workspace, &left))).into());
  }
  if !right.is_dir() {
    return Err(
      CoreError::NotFound(format!("No TWX entities found for environment \"{env}\". Pull entities from the server first."))
        .into(),
    );
  }
  let (left_root, right_root) = (shown(&workspace, &left), shown(&workspace, &right));
  let tree = tauri::async_runtime::spawn_blocking(move || compare::merge_trees(&left, &right))
    .await
    .map_err(|e| CoreError::Io(std::io::Error::other(e.to_string())))?;
  Ok(CompareTree { left_root, right_root, tree })
}

#[derive(Serialize)]
pub struct CompareContent {
  left: Side,
  right: Side,
}

/// One file from both sides, normalised for the diff.
#[tauri::command]
pub async fn compare_content(state: State<'_, AppState>, env: String, path: String) -> IpcResult<CompareContent> {
  let Roots { left, right, .. } = roots(&state, &env).await?;
  let (left, right) = (safe_join(&left, &path)?, safe_join(&right, &path)?);
  Ok(CompareContent { left: compare::read_side(&left), right: compare::read_side(&right) })
}

/// Text search on both sides; a file found on both is reported once.
#[tauri::command]
pub async fn compare_search(
  state: State<'_, AppState>,
  env: String,
  query: String,
  options: SearchOptions,
) -> IpcResult<SearchResults> {
  if query.trim().is_empty() {
    return Ok(SearchResults { results: Vec::new(), warnings: Vec::new() });
  }
  let Roots { left, right, .. } = roots(&state, &env).await?;
  Ok(
    tauri::async_runtime::spawn_blocking(move || compare::search(&left, &right, &query, options))
      .await
      .map_err(|e| CoreError::Io(std::io::Error::other(e.to_string())))??,
  )
}
