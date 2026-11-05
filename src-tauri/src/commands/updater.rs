//! In-app updates from a shared folder. `pnpm release` copies the NSIS
//! installer there and writes `latest.json` next to it:
//! `{ "version": "0.2.0", "installer": "singl_0.2.0_x64-setup.exe", "notes": "…" }`.
//! tauri-plugin-updater is not used because it only fetches over HTTP(S).

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use singl_core::db;
use singl_core::CoreError;
use tauri::{AppHandle, Manager, State};

use crate::error::IpcResult;
use crate::state::AppState;

#[derive(Deserialize)]
struct Manifest {
  version: String,
  installer: String,
  #[serde(default)]
  notes: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
  pub current_version: String,
  pub version: String,
  pub notes: String,
}

/// Compares the numeric `major.minor.patch` parts; pre-release tags are ignored.
fn is_newer(candidate: &str, current: &str) -> bool {
  let parts = |v: &str| -> Vec<u64> {
    v.trim_start_matches('v').split(['-', '+']).next().unwrap_or("").split('.').map(|p| p.parse().unwrap_or(0)).collect()
  };
  parts(candidate) > parts(current)
}

async fn read_manifest(state: &AppState) -> IpcResult<(PathBuf, Manifest)> {
  let dir = db::settings::update_dir(&state.db().await)
    .await?
    .ok_or_else(|| CoreError::Invalid("No update folder is set. Choose one in Settings → Updates.".into()))?;
  let path = dir.join("latest.json");
  let text = std::fs::read_to_string(&path).map_err(|e| CoreError::NotFound(format!("Can't read {}: {e}", path.display())))?;
  let manifest: Manifest =
    serde_json::from_str(&text).map_err(|e| CoreError::Invalid(format!("{} is not a valid update manifest: {e}", path.display())))?;
  Ok((dir, manifest))
}

#[tauri::command]
pub async fn update_dir_set(state: State<'_, AppState>, dir: String) -> IpcResult<()> {
  let dir = dir.trim().to_string();
  if !dir.is_empty() && !Path::new(&dir).is_dir() {
    return Err(CoreError::NotFound(format!("{dir} is not a folder")).into());
  }
  Ok(db::settings::set_update_dir(&state.db().await, &dir).await?)
}

/// `None` when the folder holds this version or an older one.
#[tauri::command]
pub async fn update_check(app: AppHandle, state: State<'_, AppState>) -> IpcResult<Option<UpdateInfo>> {
  let current = app.package_info().version.to_string();
  let (_, manifest) = read_manifest(&state).await?;
  Ok(is_newer(&manifest.version, &current).then(|| UpdateInfo {
    current_version: current,
    version: manifest.version,
    notes: manifest.notes,
  }))
}

/// Copies the installer to the temp folder (so the share can go away mid-install),
/// starts it in passive mode, and quits. The installer relaunches singl when done.
#[tauri::command]
pub async fn update_install(app: AppHandle, state: State<'_, AppState>) -> IpcResult<()> {
  let (dir, manifest) = read_manifest(&state).await?;
  if !is_newer(&manifest.version, &app.package_info().version.to_string()) {
    return Err(CoreError::Invalid("singl is already up to date.".into()).into());
  }
  let source = dir.join(&manifest.installer);
  let target = std::env::temp_dir().join("singl-update").join(&manifest.installer);

  tauri::async_runtime::spawn_blocking(move || -> std::io::Result<()> {
    std::fs::create_dir_all(target.parent().expect("target has a parent"))?;
    std::fs::copy(&source, &target)?;
    // Same flags tauri-plugin-updater passes: passive UI, update mode, relaunch.
    std::process::Command::new(&target).args(["/P", "/UPDATE", "/R"]).spawn()?;
    Ok(())
  })
  .await
  .map_err(|e| CoreError::Invalid(format!("update task failed: {e}")))??;

  app.state::<AppState>().jobs.cancel_all();
  app.exit(0);
  Ok(())
}

#[cfg(test)]
mod tests {
  use super::is_newer;

  #[test]
  fn compares_numeric_parts() {
    assert!(is_newer("0.2.0", "0.1.9"));
    assert!(is_newer("0.10.0", "0.9.0"));
    assert!(is_newer("v1.0.0", "0.9.9"));
    assert!(!is_newer("0.1.0", "0.1.0"));
    assert!(!is_newer("0.1.0-beta", "0.1.0"));
    assert!(!is_newer("0.0.9", "0.1.0"));
  }
}
