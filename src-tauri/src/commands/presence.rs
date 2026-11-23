//! Teams Presence Keeper, ported from singl-web's /api/teams-presence.
//!
//! Keeps the Windows session from going idle so Microsoft Teams reports
//! "Available" instead of flipping to "Away" after its idle timeout:
//!   - injects a VK_F15 key event once per interval. F15 is on no modern
//!     keyboard, so no application reacts, but it resets the
//!     GetLastInputInfo idle timer that Teams reads;
//!   - holds ES_CONTINUOUS | ES_SYSTEM_REQUIRED | ES_DISPLAY_REQUIRED so the
//!     machine does not sleep or blank the display while the keeper runs.
//!
//! It does NOT work around a locked workstation (Win+L): Teams goes Away
//! regardless. It only prevents the *idle* transition.
//!
//! The keeper is a hidden, independent process that outlives singl on purpose.
//! It is singl's own executable, copied to `<data dir>/teams-presence/` and
//! started with [`KEEPER_ARG`] (see [`run_keeper_if_requested`]): running from
//! a copy keeps the real exe free for rebuilds and updater installs, and lets
//! a PID be confirmed as ours by its image path. State lives in the same folder:
//! `keeper.pid.json` records the launch, `keeper.heartbeat` is rewritten by the
//! keeper each tick so a live keeper can be told from a recycled PID.

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use singl_core::CoreError;
use tauri::State;

use crate::error::IpcResult;
use crate::state::AppState;

/// First argument that turns the singl executable into the keeper.
pub const KEEPER_ARG: &str = "--presence-keeper";
const KEEPER_EXE: &str = "singl-presence-keeper.exe";

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
  exe: PathBuf,
  pid_file: PathBuf,
  heartbeat: PathBuf,
}

impl Paths {
  fn new(state: &AppState) -> Self {
    let base = state.db_path.parent().map(Path::to_path_buf).unwrap_or_else(std::env::temp_dir);
    Self::in_dir(base.join("teams-presence"))
  }

  fn in_dir(dir: PathBuf) -> Self {
    Self {
      exe: dir.join(KEEPER_EXE),
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

  /// Seconds since the Unix epoch of the last heartbeat. The keeper writes an
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

/// `--interval <secs> --heartbeat <path>` after [`KEEPER_ARG`].
fn parse_keeper_args(args: &[String]) -> Option<(u32, PathBuf)> {
  let mut interval = None;
  let mut heartbeat = None;
  let mut it = args.iter();
  while let Some(arg) = it.next() {
    match arg.as_str() {
      "--interval" => interval = it.next().and_then(|v| v.parse::<u32>().ok()),
      "--heartbeat" => heartbeat = it.next().map(PathBuf::from),
      _ => {}
    }
  }
  Some((clamp_interval(interval), heartbeat?))
}

/// Runs the keeper loop when the process was started as one, and never returns
/// then. Called first thing in `main`, before Tauri builds a window.
pub fn run_keeper_if_requested() {
  let args: Vec<String> = std::env::args().skip(1).collect();
  if args.first().map(String::as_str) != Some(KEEPER_ARG) {
    return;
  }
  let code = match parse_keeper_args(&args[1..]) {
    Some((interval, heartbeat)) => keeper_loop(interval, &heartbeat),
    None => 64,
  };
  std::process::exit(code);
}

#[cfg(windows)]
fn keeper_loop(interval_seconds: u32, heartbeat: &Path) -> i32 {
  if let Some(dir) = heartbeat.parent() {
    let _ = std::fs::create_dir_all(dir);
  }
  loop {
    // Re-asserted every tick: the flag is per-thread and cheap to set. A kill
    // skips any cleanup, but Windows drops the execution state with the process.
    win::keep_awake();
    win::tap_f15();
    // Best effort: a missed heartbeat only makes the UI double-check the PID.
    let _ = std::fs::write(heartbeat, iso(now_secs()));
    std::thread::sleep(Duration::from_secs(u64::from(interval_seconds)));
  }
}

#[cfg(not(windows))]
fn keeper_loop(_interval_seconds: u32, _heartbeat: &Path) -> i32 {
  eprintln!("Teams Presence Keeper only runs on Windows.");
  1
}

#[cfg(windows)]
mod win {
  use std::path::{Path, PathBuf};
  use std::time::Duration;

  type Handle = *mut core::ffi::c_void;

  #[link(name = "kernel32")]
  unsafe extern "system" {
    fn OpenProcess(access: u32, inherit: i32, pid: u32) -> Handle;
    fn GetExitCodeProcess(process: Handle, code: *mut u32) -> i32;
    fn TerminateProcess(process: Handle, code: u32) -> i32;
    fn QueryFullProcessImageNameW(process: Handle, flags: u32, name: *mut u16, size: *mut u32) -> i32;
    fn CloseHandle(handle: Handle) -> i32;
    fn SetThreadExecutionState(flags: u32) -> u32;
  }

  #[link(name = "user32")]
  unsafe extern "system" {
    fn keybd_event(vk: u8, scan: u8, flags: u32, extra: usize);
  }

  const PROCESS_TERMINATE: u32 = 0x0001;
  const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;
  const STILL_ACTIVE: u32 = 259;
  const ERROR_ACCESS_DENIED: i32 = 5;
  pub const CREATE_NO_WINDOW: u32 = 0x0800_0000;
  pub const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;

  const ES_CONTINUOUS: u32 = 0x8000_0000;
  const ES_SYSTEM_REQUIRED: u32 = 0x0000_0001;
  const ES_DISPLAY_REQUIRED: u32 = 0x0000_0002;
  const VK_F15: u8 = 0x7E;
  const KEYEVENTF_KEYUP: u32 = 0x0002;

  pub fn keep_awake() {
    // SAFETY: plain Win32 call with constant flags.
    unsafe { SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED | ES_DISPLAY_REQUIRED) };
  }

  pub fn tap_f15() {
    // SAFETY: plain Win32 calls with constant arguments.
    unsafe { keybd_event(VK_F15, 0, 0, 0) };
    std::thread::sleep(Duration::from_millis(40));
    unsafe { keybd_event(VK_F15, 0, KEYEVENTF_KEYUP, 0) };
  }

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

  fn image_path(pid: u32) -> Option<PathBuf> {
    use std::os::windows::ffi::OsStringExt;
    // SAFETY: plain Win32 calls; the buffer outlives the call and the handle is closed.
    unsafe {
      let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
      if handle.is_null() {
        return None;
      }
      let mut buf = vec![0u16; 32_768];
      let mut len = buf.len() as u32;
      let ok = QueryFullProcessImageNameW(handle, 0, buf.as_mut_ptr(), &mut len) != 0;
      CloseHandle(handle);
      ok.then(|| PathBuf::from(std::ffi::OsString::from_wide(&buf[..len as usize])))
    }
  }

  /// Confirms a live PID is our keeper and not a PID Windows recycled for some
  /// unrelated process: its image must be the keeper copy of the executable.
  pub fn owns_pid(pid: u32, keeper_exe: &Path) -> bool {
    let same = |a: &Path, b: &Path| a.to_string_lossy().eq_ignore_ascii_case(&b.to_string_lossy());
    let canon = |p: &Path| std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
    image_path(pid).is_some_and(|img| same(&img, keeper_exe) || same(&canon(&img), &canon(keeper_exe)))
  }

  pub fn terminate(pid: u32) -> std::io::Result<()> {
    // SAFETY: plain Win32 calls; the handle is closed before returning.
    unsafe {
      let handle = OpenProcess(PROCESS_TERMINATE, 0, pid);
      if handle.is_null() {
        return Err(std::io::Error::last_os_error());
      }
      let ok = TerminateProcess(handle, 1) != 0;
      let err = std::io::Error::last_os_error();
      CloseHandle(handle);
      if ok { Ok(()) } else { Err(err) }
    }
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
  if is_stale && !win::owns_pid(record.pid, &paths.exe) {
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

/// Refreshes the keeper copy of this executable so an app update ships keeper
/// changes too. A copy still locked by an orphaned keeper is used as it is.
#[cfg(windows)]
fn install_keeper_exe(paths: &Paths, source: &Path) -> Result<(), CoreError> {
  std::fs::create_dir_all(&paths.dir)?;
  match std::fs::copy(source, &paths.exe) {
    Ok(_) => Ok(()),
    Err(_) if paths.exe.is_file() => Ok(()),
    Err(e) => Err(CoreError::Invalid(format!("Could not prepare the keeper at {}: {e}", paths.exe.display()))),
  }
}

#[cfg(windows)]
fn start_blocking(paths: &Paths, interval_seconds: u32) -> Result<KeeperStatus, CoreError> {
  use std::os::windows::process::CommandExt;

  let current = status_blocking(paths);
  if current.running {
    return Ok(current);
  }

  let me = std::env::current_exe().map_err(|e| CoreError::Invalid(format!("Cannot locate singl's executable: {e}")))?;
  install_keeper_exe(paths, &me)?;
  // Seed the heartbeat so the first status poll doesn't see it as stale
  // before the keeper has written its own.
  let started = now_secs();
  std::fs::write(&paths.heartbeat, iso(started))?;

  // The new process group keeps singl's console signals away from it. Windows
  // doesn't kill children with their parent, so the keeper outlives singl.
  let child = std::process::Command::new(&paths.exe)
    .arg(KEEPER_ARG)
    .arg("--interval")
    .arg(interval_seconds.to_string())
    .arg("--heartbeat")
    .arg(&paths.heartbeat)
    .current_dir(&paths.dir)
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

  if win::is_alive(record.pid) && win::owns_pid(record.pid, &paths.exe) {
    // Termination fails when the process died between the check and the kill;
    // only a still-running process is an actual failure.
    if let Err(e) = win::terminate(record.pid) {
      std::thread::sleep(Duration::from_millis(200));
      if win::is_alive(record.pid) {
        return Err(CoreError::Invalid(format!("Could not stop PID {}: {e}", record.pid)));
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
  use super::{clamp_interval, iso, parse_keeper_args};
  use std::path::PathBuf;

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

  #[test]
  fn parses_keeper_args() {
    let args = |s: &[&str]| s.iter().map(|a| a.to_string()).collect::<Vec<_>>();
    assert_eq!(parse_keeper_args(&args(&["--interval", "30", "--heartbeat", "C:\\hb"])), Some((30, PathBuf::from("C:\\hb"))));
    assert_eq!(parse_keeper_args(&args(&["--heartbeat", "hb", "--interval", "5"])), Some((15, PathBuf::from("hb"))));
    assert_eq!(parse_keeper_args(&args(&["--heartbeat", "hb"])), Some((60, PathBuf::from("hb"))));
    assert_eq!(parse_keeper_args(&args(&["--interval", "30"])), None);
  }
}
