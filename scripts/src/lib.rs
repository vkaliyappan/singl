//! Shared helpers for the `singl-scripts` binaries.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

/// Prints `msg` to stderr and exits with `code`.
pub fn fail(code: i32, msg: impl std::fmt::Display) -> ! {
  eprintln!("{msg}");
  std::process::exit(code);
}

/// The singl checkout: the nearest folder at or above the current directory
/// that has `src-tauri/tauri.conf.json`.
pub fn project_root() -> Option<PathBuf> {
  let cwd = std::env::current_dir().ok()?;
  cwd.ancestors().find(|p| p.join("src-tauri").join("tauri.conf.json").is_file()).map(Path::to_path_buf)
}

/// A `pnpm` command. On Windows pnpm is a `.cmd` shim, which only `cmd` can run.
pub fn pnpm(args: &[&str]) -> Command {
  if cfg!(windows) {
    let mut cmd = Command::new("cmd");
    cmd.arg("/C").arg("pnpm").args(args);
    cmd
  } else {
    let mut cmd = Command::new("pnpm");
    cmd.args(args);
    cmd
  }
}

/// The current time as `YYYY-MM-DDTHH:MM:SS.mmmZ`, like JavaScript's `toISOString()`.
pub fn iso_now() -> String {
  let d = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default();
  iso_millis(d.as_millis() as u64)
}

/// Formats Unix milliseconds (civil-from-days, Howard Hinnant).
pub fn iso_millis(ms: u64) -> String {
  let secs = ms / 1000;
  let days = (secs / 86_400) as i64;
  let rem = secs % 86_400;
  let z = days + 719_468;
  let era = z.div_euclid(146_097);
  let doe = z.rem_euclid(146_097);
  let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
  let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
  let mp = (5 * doy + 2) / 153;
  let day = doy - (153 * mp + 2) / 5 + 1;
  let m = if mp < 10 { mp + 3 } else { mp - 9 };
  let y = yoe + era * 400 + i64::from(m <= 2);
  format!("{y:04}-{m:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z", rem / 3600, rem % 3600 / 60, rem % 60, ms % 1000)
}

/// PIDs listening on TCP `port`, from `netstat -ano`. Matches the port exactly
/// (`:3001`, not `:30010`), on IPv4 and IPv6.
pub fn listening_pids(port: u16) -> Vec<u32> {
  let Ok(out) = hidden("netstat").args(["-ano"]).output() else { return Vec::new() };
  parse_listening(&String::from_utf8_lossy(&out.stdout), port)
}

pub fn parse_listening(netstat: &str, port: u16) -> Vec<u32> {
  let suffix = format!(":{port}");
  let mut pids: Vec<u32> = netstat
    .lines()
    .filter_map(|line| {
      let cols: Vec<&str> = line.split_whitespace().collect();
      // Proto  Local Address  Foreign Address  State  PID
      match cols.as_slice() {
        [proto, local, _, state, pid] if proto.eq_ignore_ascii_case("TCP") && state.eq_ignore_ascii_case("LISTENING") && local.ends_with(&suffix) => {
          pid.parse().ok().filter(|p| *p > 0)
        }
        _ => None,
      }
    })
    .collect();
  pids.sort_unstable();
  pids.dedup();
  pids
}

/// Force-kills each PID and its child processes. Returns how many were killed.
pub fn kill_tree(pids: &[u32]) -> usize {
  pids
    .iter()
    .filter(|pid| {
      hidden("taskkill").args(["/F", "/T", "/PID", &pid.to_string()]).output().is_ok_and(|o| o.status.success())
    })
    .count()
}

/// A command that opens no console window of its own.
pub fn hidden(program: &str) -> Command {
  #[allow(unused_mut)]
  let mut cmd = Command::new(program);
  #[cfg(windows)]
  {
    use std::os::windows::process::CommandExt;
    cmd.creation_flags(CREATE_NO_WINDOW);
  }
  cmd
}

pub const CREATE_NO_WINDOW: u32 = 0x0800_0000;
pub const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn formats_iso_millis() {
    assert_eq!(iso_millis(0), "1970-01-01T00:00:00.000Z");
    assert_eq!(iso_millis(951_782_400_007), "2000-02-29T00:00:00.007Z");
    assert_eq!(iso_millis(1_793_801_445_123), "2026-11-04T14:10:45.123Z");
  }

  #[test]
  fn parses_netstat() {
    let text = "\
Active Connections

  Proto  Local Address          Foreign Address        State           PID
  TCP    0.0.0.0:3001           0.0.0.0:0              LISTENING       4242
  TCP    0.0.0.0:30010          0.0.0.0:0              LISTENING       999
  TCP    127.0.0.1:3001         127.0.0.1:50000        ESTABLISHED     4242
  TCP    [::]:3001              [::]:0                 LISTENING       4242
  TCP    [::1]:3001             [::]:0                 LISTENING       5151
  UDP    0.0.0.0:3001           *:*                                    777
";
    assert_eq!(parse_listening(text, 3001), vec![4242, 5151]);
    assert!(parse_listening(text, 8080).is_empty());
  }
}
