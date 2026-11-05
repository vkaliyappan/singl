//! Spawning an agent CLI and talking to it: argv as a list (never a shell),
//! optional stdin, stdout/stderr as lines, a deadline, and a kill that takes
//! the whole process tree with it (agent CLIs shell out to git, ripgrep, MCP
//! servers…, and on Windows run behind a Node shim).

use std::collections::HashMap;
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::ChildStdin;
use tokio_util::sync::CancellationToken;

use super::{Command, resolve_command};
use crate::{CoreError, Result};

/// What to start. `cwd` must already be resolved (see [`super::resolve_cwd`]).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpawnSpec {
  pub provider: String,
  /// Everything after the binary; the resolved shim prefix goes in front.
  pub args: Vec<String>,
  /// Written to stdin, then stdin is closed unless `keep_stdin`.
  #[serde(default)]
  pub stdin: Option<String>,
  #[serde(default)]
  pub keep_stdin: bool,
  /// Extra environment on top of the app's own.
  #[serde(default)]
  pub env: HashMap<String, String>,
  /// Killed after this long; `None` runs until it exits or is killed.
  #[serde(default)]
  pub timeout_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ProcEvent {
  Stdout { line: String },
  Stderr { line: String },
  /// The process is gone. `code` is `None` when it was killed by a signal.
  #[serde(rename_all = "camelCase")]
  Exit { code: Option<i32>, timed_out: bool, killed: bool },
}

pub type Sink = Arc<dyn Fn(ProcEvent) + Send + Sync>;

#[derive(Clone)]
struct Entry {
  stdin: Arc<tokio::sync::Mutex<Option<ChildStdin>>>,
  kill: CancellationToken,
}

/// Running agent processes by id, so later calls can feed or stop them.
#[derive(Clone, Default)]
pub struct ProcRegistry {
  procs: Arc<Mutex<HashMap<String, Entry>>>,
}

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Ends `pid` and everything below it.
fn kill_tree(pid: u32) {
  #[cfg(windows)]
  {
    let _ = std::process::Command::new("taskkill")
      .args(["/PID", &pid.to_string(), "/T", "/F"])
      .creation_flags(CREATE_NO_WINDOW)
      .stdin(Stdio::null())
      .stdout(Stdio::null())
      .stderr(Stdio::null())
      .status();
  }
  #[cfg(not(windows))]
  {
    // The child leads its own process group (see `process_group(0)`).
    let _ = std::process::Command::new("kill").args(["-KILL", &format!("-{pid}")]).status();
  }
}

#[cfg(windows)]
use std::os::windows::process::CommandExt as _;

/// Forwards each line `reader` prints to `sink`.
async fn pump<R: tokio::io::AsyncRead + Unpin>(reader: Option<R>, stderr: bool, sink: Sink) {
  let Some(reader) = reader else { return };
  let mut lines = BufReader::new(reader).lines();
  while let Ok(Some(line)) = lines.next_line().await {
    let line = line.trim_end_matches('\r').to_string();
    sink(if stderr { ProcEvent::Stderr { line } } else { ProcEvent::Stdout { line } });
  }
}

impl ProcRegistry {
  fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, Entry>> {
    self.procs.lock().unwrap_or_else(|e| e.into_inner())
  }

  /// Starts a CLI in `cwd` and returns its id. Events go to `sink` until an `Exit`.
  pub fn spawn(&self, spec: SpawnSpec, cwd: &std::path::Path, sink: Sink) -> Result<String> {
    let Command { file, prefix } = resolve_command(&spec.provider)?;
    let mut cmd = tokio::process::Command::new(&file);
    cmd
      .args(prefix.iter().chain(spec.args.iter()))
      .current_dir(cwd)
      .envs(&spec.env)
      // Agent CLIs light up spinners and colours when they think a human watches.
      .env("CI", "1")
      .env("NO_COLOR", "1")
      .env("TERM", "dumb")
      .stdin(Stdio::piped())
      .stdout(Stdio::piped())
      .stderr(Stdio::piped())
      .kill_on_drop(true);
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    #[cfg(unix)]
    cmd.process_group(0);

    let mut child = cmd.spawn().map_err(|e| {
      if e.kind() == std::io::ErrorKind::NotFound {
        CoreError::Invalid(format!("Could not start \"{}\".", file.display()))
      } else if e.raw_os_error() == Some(206) {
        CoreError::Invalid("The command line is too long for this platform — shorten the extra arguments.".into())
      } else {
        CoreError::Io(e)
      }
    })?;
    let pid = child.id();
    let id = uuid::Uuid::new_v4().to_string();
    let mut stdin = child.stdin.take();
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let kill = CancellationToken::new();

    // The initial payload goes in before anyone else can write; a CLI that
    // rejects its arguments may exit first, which only fails this write.
    let payload = spec.stdin.clone().filter(|s| !s.is_empty());
    let keep = spec.keep_stdin;
    let entry = Entry { stdin: Arc::new(tokio::sync::Mutex::new(None)), kill: kill.clone() };
    self.lock().insert(id.clone(), entry.clone());

    let registry = self.clone();
    let proc_id = id.clone();
    tokio::spawn(async move {
      {
        let mut guard = entry.stdin.lock().await;
        if let (Some(pipe), Some(text)) = (stdin.as_mut(), payload) {
          let _ = pipe.write_all(text.as_bytes()).await;
          let _ = pipe.flush().await;
        }
        // Dropping the pipe is what tells the CLI its input is over.
        *guard = if keep { stdin.take() } else { None };
        drop(stdin);
      }

      let out = tokio::spawn(pump(stdout, false, sink.clone()));
      let err = tokio::spawn(pump(stderr, true, sink.clone()));

      let deadline = async {
        match spec.timeout_ms {
          Some(ms) => tokio::time::sleep(Duration::from_millis(ms)).await,
          None => std::future::pending().await,
        }
      };
      let (mut timed_out, mut killed) = (false, false);
      let status = tokio::select! {
        status = child.wait() => status.ok(),
        () = deadline => { timed_out = true; None },
        () = kill.cancelled() => { killed = true; None },
      };
      let code = match status {
        Some(status) => status.code(),
        None => {
          if let Some(pid) = pid {
            tokio::task::spawn_blocking(move || kill_tree(pid)).await.ok();
          }
          let _ = child.kill().await;
          child.wait().await.ok().and_then(|s| s.code())
        }
      };
      // Whatever was printed before the end still arrives before the Exit.
      let _ = out.await;
      let _ = err.await;
      registry.lock().remove(&proc_id);
      sink(ProcEvent::Exit { code, timed_out, killed });
    });
    Ok(id)
  }

  /// Writes to a running process's stdin (one kept open with `keep_stdin`).
  pub async fn write(&self, id: &str, data: &str) -> Result<()> {
    let entry = self.lock().get(id).cloned().ok_or_else(|| CoreError::NotFound("That process has ended.".into()))?;
    let mut guard = entry.stdin.lock().await;
    let pipe = guard.as_mut().ok_or_else(|| CoreError::Invalid("That process takes no more input.".into()))?;
    pipe.write_all(data.as_bytes()).await?;
    pipe.flush().await?;
    Ok(())
  }

  /// Closes stdin: end of input is most CLIs' cue to finish.
  pub async fn close_stdin(&self, id: &str) {
    if let Some(entry) = self.lock().get(id).cloned() {
      *entry.stdin.lock().await = None;
    }
  }

  /// Kills a process and its tree. False when no such process is running.
  pub fn kill(&self, id: &str) -> bool {
    let entry = self.lock().get(id).cloned();
    match entry {
      Some(entry) => {
        entry.kill.cancel();
        true
      }
      None => false,
    }
  }

  pub fn kill_all(&self) {
    let ids: Vec<String> = self.lock().keys().cloned().collect();
    for id in ids {
      self.kill(&id);
    }
  }
}

/// Runs a CLI to the end and returns its exit code and stdout (stderr is
/// dropped). For short fixed commands such as listing a CLI's models.
pub async fn capture(
  registry: &ProcRegistry,
  spec: SpawnSpec,
  cwd: &std::path::Path,
) -> Result<(Option<i32>, String)> {
  let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
  let sink: Sink = Arc::new(move |event| {
    let _ = tx.send(event);
  });
  registry.spawn(spec, cwd, sink)?;
  let mut stdout = String::new();
  while let Some(event) = rx.recv().await {
    match event {
      ProcEvent::Stdout { line } => {
        if stdout.len() < 400_000 {
          stdout.push_str(&line);
          stdout.push('\n');
        }
      }
      ProcEvent::Stderr { .. } => {}
      ProcEvent::Exit { code, timed_out, .. } => {
        if timed_out {
          return Err(CoreError::Invalid("timed out".into()));
        }
        return Ok((code, stdout));
      }
    }
  }
  Ok((None, stdout))
}

#[cfg(test)]
mod tests {
  use super::*;

  /// Needs a signed-in `claude` on PATH: `cargo test -p singl-core real_claude -- --ignored`.
  #[tokio::test(flavor = "multi_thread")]
  #[ignore]
  async fn real_claude_answers() {
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    let sink: Sink = Arc::new(move |e| {
      let _ = tx.send(e);
    });
    let spec = SpawnSpec {
      provider: "claude".into(),
      args: vec!["-p".into()],
      stdin: Some("Reply with exactly: pong".into()),
      keep_stdin: false,
      env: HashMap::new(),
      timeout_ms: Some(120_000),
    };
    let home = super::super::home_dir().unwrap();
    ProcRegistry::default().spawn(spec, &home, sink).unwrap();
    while let Some(e) = rx.recv().await {
      println!("{e:?}");
      if matches!(e, ProcEvent::Exit { .. }) {
        break;
      }
    }
  }
}
