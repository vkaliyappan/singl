//! Teams Presence Keeper, ported from singl-web's /api/teams-presence.
//!
//! Runs `scripts/teams-presence-keeper.ps1` (embedded below) as a hidden,
//! independent PowerShell process that nudges the idle timer every interval.
//! It outlives singl on purpose; state lives in `<data dir>/teams-presence/`:
//! `keeper.pid.json` records the launch, `keeper.heartbeat` is rewritten by
//! the script each tick so a live keeper can be told from a recycled PID.

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use singl_core::CoreError;
use tauri::State;

use crate::error::IpcResult;
use crate::state::AppState;

const SCRIPT_NAME: &str = "teams-presence-keeper.ps1";
const SCRIPT: &str = include_str!("../../../scripts/teams-presence-keeper.ps1");

const DEFAULT_INTERVAL_SECONDS: u32 = 60;
const MIN_INTERVAL_SECONDS: u32 = 15;
const MAX_INTERVAL_SECONDS: u32 = 240;
/// A heartbeat older than this many missed ticks means the PID may not be ours.
const STALE_TICK_ALLOWANCE: u64 = 3;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeeperStatus {
  pub supported: bool,
  pub running: bool,
  pub pid: Option<u32>,
  /// RFC 3339 / ISO-8601 UTC.
  pub started_at: Option<String>,
  pub last_tick_at: Option<String>,
  pub interval_seconds: u32,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct KeeperRecord {
  pid: u32,
  started_at: String,
  interval_seconds: u32,
}

struct Paths {
  dir: PathBuf,
  script: PathBuf,
  pid_file: PathBuf,
  heartbeat: PathBuf,
}

impl Paths {
  fn new(state: &AppState) -> Self {
    let base = state.db_path.parent().map(Path::to_path_buf).unwrap_or_else(std::env::temp_dir);
    let dir = base.join("teams-presence");
    Self {
      script: dir.join(SCRIPT_NAME),
      pid_file: dir.join("keeper.pid.json"),
      heartbeat: dir.join("keeper.heartbeat"),
      dir,
    }
  }

  fn read_record(&self) -> Option<KeeperRecord> {
    let raw = std::fs::read_to_string(&self.pid_file).ok()?;
    serde_json::from_str::<KeeperRecord>(&raw).ok().filter(|r| r.pid > 0)
  }

  fn clear(&self) {
    let _ = std::fs::remove_file(&self.pid_file);
    let _ = std::fs::remove_file(&self.heartbeat);
  }

  /// Seconds since the Unix epoch of the last heartbeat. The script writes an
  /// ISO timestamp, but the file's mtime is the same instant and needs no parsing.
  fn heartbeat_secs(&self) -> Option<u64> {
    let modified = std::fs::metadata(&self.heartbeat).ok()?.modified().ok()?;
    modified.duration_since(UNIX_EPOCH).ok().map(|d| d.as_secs())
  }
}

fn now_secs() -> u64 {
  SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// Formats Unix seconds as `YYYY-MM-DDTHH:MM:SSZ` (civil-from-days, Howard Hinnant).
fn iso(secs: u64) -> String {
  let days = (secs / 86_400) as i64;
  let rem = secs % 86_400;
  let z = days + 719_468;
  let era = z.div_euclid(146_097);
  let doe = z.rem_euclid(146_097);
  let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
  let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
  let mp = (5 * doy + 2) / 153;
  let d = doy - (153 * mp + 2) / 5 + 1;
  let m = if mp < 10 { mp + 3 } else { mp - 9 };
  let y = yoe + era * 400 + i64::from(m <= 2);
  format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z", rem / 3600, rem % 3600 / 60, rem % 60)
}

fn stopped(interval_seconds: u32) -> KeeperStatus {
  KeeperStatus {
    supported: cfg!(windows),
    running: false,
    pid: None,
    started_at: None,
    last_tick_at: None,
    interval_seconds,
  }
}

fn clamp_interval(value: Option<u32>) -> u32 {
  value.unwrap_or(DEFAULT_INTERVAL_SECONDS).clamp(MIN_INTERVAL_SECONDS, MAX_INTERVAL_SECONDS)
}

#[cfg(windows)]
mod win {
  use std::os::windows::process::CommandExt;
  use std::process::Command;

  type Handle = *mut core::ffi::c_void;

  #[link(name = "kernel32")]
  unsafe extern "system" {
    fn OpenProcess(access: u32, inherit: i32, pid: u32) -> Handle;
    fn GetExitCodeProcess(process: Handle, code: *mut u32) -> i32;
    fn CloseHandle(handle: Handle) -> i32;
  }

  const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;
  const STILL_ACTIVE: u32 = 259;
  const ERROR_ACCESS_DENIED: i32 = 5;
  pub const CREATE_NO_WINDOW: u32 = 0x0800_0000;
  pub const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;

  /// Cheap liveness check, no child process. Access denied means it exists
  /// but belongs to someone else.
  pub fn is_alive(pid: u32) -> bool {
    // SAFETY: plain Win32 calls; the handle is closed before returning.
    unsafe {
      let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
      if handle.is_null() {
        return std::io::Error::last_os_error().raw_os_error() == Some(ERROR_ACCESS_DENIED);
      }
      let mut code = 0u32;
      let ok = GetExitCodeProcess(handle, &mut code) != 0;
      CloseHandle(handle);
      ok && code == STILL_ACTIVE
    }
  }

  pub fn hidden(program: &str) -> Command {
    let mut cmd = Command::new(program);
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd
  }

  /// Confirms a live PID is our keeper and not a PID Windows recycled for some
  /// unrelated process. Costs a PowerShell round trip, so only used before
  /// killing and when the heartbeat looks stale.
  pub fn owns_pid(pid: u32) -> bool {
    hidden("powershell.exe")
      .args([
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        &format!("(Get-CimInstance Win32_Process -Filter \"ProcessId = {pid}\").CommandLine"),
      ])
      .output()
      .map(|out| String::from_utf8_lossy(&out.stdout).contains(super::SCRIPT_NAME))
      .unwrap_or(false)
  }
}

#[cfg(windows)]
fn status_blocking(paths: &Paths) -> KeeperStatus {
  let Some(record) = paths.read_record() else { return stopped(DEFAULT_INTERVAL_SECONDS) };

  if !win::is_alive(record.pid) {
    paths.clear();
    return stopped(record.interval_seconds);
  }

  let last_tick = paths.heartbeat_secs();
  let stale_after = u64::from(record.interval_seconds) * STALE_TICK_ALLOWANCE;
  let is_stale = last_tick.is_none_or(|t| now_secs().saturating_sub(t) > stale_after);

  // Alive but not ticking: a hung keeper or a recycled PID. Verify before
  // trusting it, so the UI never shows a phantom "Active".
  if is_stale && !win::owns_pid(record.pid) {
    paths.clear();
    return stopped(record.interval_seconds);
  }

  KeeperStatus {
    supported: true,
    running: true,
    pid: Some(record.pid),
    started_at: Some(record.started_at),
    last_tick_at: last_tick.map(iso),
    interval_seconds: record.interval_seconds,
  }
}

#[cfg(not(windows))]
fn status_blocking(_paths: &Paths) -> KeeperStatus {
  stopped(DEFAULT_INTERVAL_SECONDS)
}

#[cfg(windows)]
fn start_blocking(paths: &Paths, interval_seconds: u32) -> Result<KeeperStatus, CoreError> {
  use std::os::windows::process::CommandExt;

  let current = status_blocking(paths);
  if current.running {
    return Ok(current);
  }

  std::fs::create_dir_all(&paths.dir)?;
  // Rewritten each start so an app update ships script changes too.
  std::fs::write(&paths.script, SCRIPT)?;
  // Seed the heartbeat so the first status poll doesn't see it as stale
  // before the script has written its own.
  let started = now_secs();
  std::fs::write(&paths.heartbeat, iso(started))?;

  // CREATE_NO_WINDOW still gives PowerShell a (hidden) console, which it needs;
  // the new process group keeps singl's console signals away from it. Windows
  // doesn't kill children with their parent, so the keeper outlives singl.
  let child = std::process::Command::new("powershell.exe")
    .args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File"])
    .arg(&paths.script)
    .arg("-IntervalSeconds")
    .arg(interval_seconds.to_string())
    .arg("-HeartbeatPath")
    .arg(&paths.heartbeat)
    .creation_flags(win::CREATE_NO_WINDOW | win::CREATE_NEW_PROCESS_GROUP)
    .stdin(std::process::Stdio::null())
    .stdout(std::process::Stdio::null())
    .stderr(std::process::Stdio::null())
    .spawn()
    .map_err(|e| {
      paths.clear();
      CoreError::Invalid(format!("Failed to launch the keeper: {e}"))
    })?;

  let record = KeeperRecord { pid: child.id(), started_at: iso(started), interval_seconds };
  // Dropping `child` does not kill it; it just releases our handle.
  drop(child);
  std::fs::write(&paths.pid_file, serde_json::to_string(&record).expect("record serializes"))?;

  Ok(KeeperStatus {
    supported: true,
    running: true,
    pid: Some(record.pid),
    started_at: Some(record.started_at),
    last_tick_at: None,
    interval_seconds,
  })
}

#[cfg(not(windows))]
fn start_blocking(_paths: &Paths, _interval_seconds: u32) -> Result<KeeperStatus, CoreError> {
  Err(CoreError::Invalid("Teams Presence Keeper only runs on Windows.".into()))
}

#[cfg(windows)]
fn stop_blocking(paths: &Paths) -> Result<KeeperStatus, CoreError> {
  let Some(record) = paths.read_record() else { return Ok(stopped(DEFAULT_INTERVAL_SECONDS)) };

  if win::is_alive(record.pid) && win::owns_pid(record.pid) {
    let result = win::hidden("taskkill").args(["/PID", &record.pid.to_string(), "/T", "/F"]).output();
    // taskkill fails when the process died between the check and the kill;
    // only a still-running process is an actual failure.
    let failed = !matches!(&result, Ok(out) if out.status.success());
    if failed {
      std::thread::sleep(Duration::from_millis(200));
      if win::is_alive(record.pid) {
        let detail = match result {
          Ok(out) => String::from_utf8_lossy(&out.stderr).trim().to_string(),
          Err(e) => e.to_string(),
        };
        return Err(CoreError::Invalid(format!("Could not stop PID {}: {detail}", record.pid)));
      }
    }
  }

  paths.clear();
  Ok(stopped(record.interval_seconds))
}

#[cfg(not(windows))]
fn stop_blocking(paths: &Paths) -> Result<KeeperStatus, CoreError> {
  paths.clear();
  Ok(stopped(DEFAULT_INTERVAL_SECONDS))
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, CoreError> + Send + 'static) -> IpcResult<T> {
  tauri::async_runtime::spawn_blocking(f)
    .await
    .map_err(|e| CoreError::Invalid(format!("keeper task failed: {e}")))?
    .map_err(Into::into)
}

#[tauri::command]
pub async fn presence_status(state: State<'_, AppState>) -> IpcResult<KeeperStatus> {
  let paths = Paths::new(&state);
  blocking(move || Ok(status_blocking(&paths))).await
}

#[tauri::command]
pub async fn presence_start(state: State<'_, AppState>, interval_seconds: Option<u32>) -> IpcResult<KeeperStatus> {
  let paths = Paths::new(&state);
  let interval = clamp_interval(interval_seconds);
  blocking(move || start_blocking(&paths, interval)).await
}

#[tauri::command]
pub async fn presence_stop(state: State<'_, AppState>) -> IpcResult<KeeperStatus> {
  let paths = Paths::new(&state);
  blocking(move || stop_blocking(&paths)).await
}

#[cfg(test)]
mod tests {
  use super::{clamp_interval, iso};

  #[test]
  fn formats_iso() {
    assert_eq!(iso(0), "1970-01-01T00:00:00Z");
    assert_eq!(iso(951_782_400), "2000-02-29T00:00:00Z");
    assert_eq!(iso(1_793_801_445), "2026-11-04T14:10:45Z");
  }

  #[test]
  fn clamps_interval() {
    assert_eq!(clamp_interval(None), 60);
    assert_eq!(clamp_interval(Some(1)), 15);
    assert_eq!(clamp_interval(Some(999)), 240);
  }

  /// Launches a real keeper for a few seconds: `cargo test -- --ignored keeper_lifecycle`.
  #[cfg(windows)]
  #[test]
  #[ignore]
  fn keeper_lifecycle() {
    use super::*;
    let dir = std::env::temp_dir().join(format!("singl-presence-test-{}", std::process::id()));
    let paths = Paths {
      script: dir.join(SCRIPT_NAME),
      pid_file: dir.join("keeper.pid.json"),
      heartbeat: dir.join("keeper.heartbeat"),
      dir: dir.clone(),
    };
    let started = start_blocking(&paths, 15).expect("starts");
    let pid = started.pid.expect("pid");
    std::thread::sleep(Duration::from_secs(4));
    assert!(win::is_alive(pid), "keeper should still be running");
    assert!(win::owns_pid(pid), "command line should name the script");
    let status = status_blocking(&paths);
    assert!(status.running && status.pid == Some(pid));
    let stopped = stop_blocking(&paths).expect("stops");
    assert!(!stopped.running);
    std::thread::sleep(Duration::from_millis(500));
    assert!(!win::is_alive(pid), "keeper should be gone");
    assert!(!status_blocking(&paths).running);
    let _ = std::fs::remove_dir_all(dir);
  }
}
