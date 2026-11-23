//! Runs singl-web's production server (Next.js, `pnpm start`). Port of
//! singl-web's `redeploy.bat`, `restart.bat`, `start-dev.bat` and `start-dev.vbs`.
//!
//!   singl-web start [--foreground]   start the built server (hidden and detached unless --foreground)
//!   singl-web restart                stop whatever listens on the port, start again, wait until it listens
//!   singl-web redeploy               stop, `pnpm build`, start (only if the build passed)
//!   singl-web stop                   stop whatever listens on the port
//!
//! Options: --dir <singl-web checkout> (else SINGL_WEB_DIR, else C:\MyFiles\Develop\singl-web),
//! --port <n> (default 3001). For a Task Scheduler "At log on" task, run `singl-web start`.

use std::path::PathBuf;
use std::process::Stdio;
use std::time::{Duration, Instant};

use singl_scripts::{CREATE_NEW_PROCESS_GROUP, CREATE_NO_WINDOW, fail, kill_tree, listening_pids, pnpm};

const DEFAULT_DIR: &str = r"C:\MyFiles\Develop\singl-web";
const DEFAULT_PORT: u16 = 3001;
const START_TIMEOUT: Duration = Duration::from_secs(30);
const USAGE: &str = "Usage: singl-web <start|restart|redeploy|stop> [--foreground] [--dir <path>] [--port <n>]";

struct Opts {
  cmd: String,
  dir: PathBuf,
  port: u16,
  foreground: bool,
}

fn parse_opts() -> Opts {
  let mut it = std::env::args().skip(1);
  let cmd = it.next().filter(|c| ["start", "restart", "redeploy", "stop"].contains(&c.as_str())).unwrap_or_else(|| fail(64, USAGE));
  let mut dir = std::env::var("SINGL_WEB_DIR").ok().filter(|s| !s.trim().is_empty()).map(PathBuf::from);
  let mut port = DEFAULT_PORT;
  let mut foreground = false;
  while let Some(arg) = it.next() {
    match arg.as_str() {
      "--dir" => dir = Some(PathBuf::from(it.next().unwrap_or_else(|| fail(64, USAGE)))),
      "--port" => port = it.next().and_then(|p| p.parse().ok()).unwrap_or_else(|| fail(64, "--port needs a number.")),
      "--foreground" => foreground = true,
      _ => fail(64, USAGE),
    }
  }
  let dir = dir.unwrap_or_else(|| PathBuf::from(DEFAULT_DIR));
  if !dir.join("package.json").is_file() {
    fail(1, format!("{} is not the singl-web checkout (no package.json). Pass --dir.", dir.display()));
  }
  Opts { cmd, dir, port, foreground }
}

fn main() {
  let o = parse_opts();
  match o.cmd.as_str() {
    "stop" => stop(o.port),
    "start" if o.foreground => start_foreground(&o),
    "start" => {
      start_hidden(&o);
      wait_listening(o.port);
    }
    "restart" => {
      stop(o.port);
      // Give the OS a moment to release the port.
      std::thread::sleep(Duration::from_secs(2));
      start_hidden(&o);
      wait_listening(o.port);
    }
    "redeploy" => {
      stop(o.port);
      println!("Building...");
      let ok = pnpm(&["build"]).current_dir(&o.dir).status().is_ok_and(|s| s.success());
      if !ok {
        fail(1, "Build failed. Not starting server.");
      }
      start_hidden(&o);
      wait_listening(o.port);
    }
    _ => unreachable!(),
  }
}

fn stop(port: u16) {
  println!("Stopping old server on port {port}...");
  let pids = listening_pids(port);
  if pids.is_empty() {
    println!("  nothing listening");
    return;
  }
  let killed = kill_tree(&pids);
  println!("  stopped {killed} of {} process(es): {pids:?}", pids.len());
}

/// Runs `pnpm start` in this terminal until it exits (the old start-dev.bat).
fn start_foreground(o: &Opts) {
  let status = pnpm(&["start"]).current_dir(&o.dir).status().unwrap_or_else(|e| fail(1, format!("Cannot run pnpm: {e}")));
  std::process::exit(status.code().unwrap_or(1));
}

/// Starts `pnpm start` hidden and detached, so it outlives this process (the old start-dev.vbs).
fn start_hidden(o: &Opts) {
  println!("Starting server (hidden, detached)...");
  let mut cmd = pnpm(&["start"]);
  cmd.current_dir(&o.dir).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
  #[cfg(windows)]
  {
    use std::os::windows::process::CommandExt;
    // CREATE_NO_WINDOW gives cmd/node a hidden console, which they need; the
    // new process group keeps this terminal's Ctrl+C away from the server.
    cmd.creation_flags(CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP);
  }
  #[cfg(not(windows))]
  let _ = (CREATE_NO_WINDOW, CREATE_NEW_PROCESS_GROUP);
  // Dropping the child releases our handle; it keeps running.
  drop(cmd.spawn().unwrap_or_else(|e| fail(1, format!("Cannot start pnpm: {e}"))));
}

fn wait_listening(port: u16) {
  println!("Waiting for server to listen on port {port}...");
  let deadline = Instant::now() + START_TIMEOUT;
  while listening_pids(port).is_empty() {
    if Instant::now() >= deadline {
      fail(1, format!("Server did not come up within {} seconds.", START_TIMEOUT.as_secs()));
    }
    std::thread::sleep(Duration::from_secs(1));
  }
  println!("Done. Server running in background on port {port}.");
}
