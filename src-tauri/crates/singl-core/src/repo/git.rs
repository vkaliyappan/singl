//! Git through the `git` CLI, as singl-web did with simple-git. The PAT goes
//! to git as an `http.extraHeader` set through the environment, so it is
//! never written into the remote URL, onto disk, or onto the command line.

use std::collections::HashSet;
use std::path::Path;
use std::process::Stdio;

use base64::Engine;
use serde::Serialize;
use tokio::io::{AsyncBufReadExt, AsyncRead, BufReader};
use tokio::process::Command;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use super::files::{MAX_FILE_SIZE, normalize_text};
use crate::{CoreError, Result};

/// Credentials for one remote.
#[derive(Clone, Default)]
pub struct Auth {
  header: Option<String>,
}

impl Auth {
  /// Azure DevOps takes the PAT with an empty user name; GitHub and others as the password.
  pub fn new(repo_url: &str, pat: Option<&str>) -> Self {
    let header = pat.filter(|pat| !pat.is_empty()).map(|pat| {
      let lower = repo_url.to_lowercase();
      let user = if lower.contains("dev.azure.com") || lower.contains("visualstudio.com") { "" } else { "x-oauth-basic" };
      let basic = base64::engine::general_purpose::STANDARD.encode(format!("{user}:{pat}"));
      format!("Authorization: Basic {basic}")
    });
    Self { header }
  }
}

/// The folder name a clone of `repo_url` goes in: its last path segment without `.git`.
pub fn slug(repo_url: &str) -> String {
  let name = repo_url.trim().trim_end_matches('/').rsplit('/').next().unwrap_or("");
  let name = name.strip_suffix(".git").unwrap_or(name);
  if name.is_empty() { "repo".into() } else { name.into() }
}

fn command(dir: Option<&Path>, auth: &Auth) -> Command {
  let mut cmd = Command::new("git");
  if let Some(dir) = dir {
    cmd.current_dir(dir);
  }
  // An empty `credential.helper` keeps Git Credential Manager from prompting.
  let mut config = vec![("credential.helper", String::new())];
  if let Some(header) = &auth.header {
    config.push(("http.extraHeader", header.clone()));
  }
  cmd.env("GIT_CONFIG_COUNT", config.len().to_string());
  for (i, (key, value)) in config.into_iter().enumerate() {
    cmd.env(format!("GIT_CONFIG_KEY_{i}"), key).env(format!("GIT_CONFIG_VALUE_{i}"), value);
  }
  cmd
    .env("GIT_TERMINAL_PROMPT", "0")
    .env("GCM_INTERACTIVE", "never")
    .stdin(Stdio::null())
    .stdout(Stdio::piped())
    .stderr(Stdio::piped())
    .kill_on_drop(true);
  #[cfg(windows)]
  cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
  cmd
}

enum Line {
  Out(String),
  Err(String),
}

/// Sends each line of `stream` to `tx`. Progress meters redraw with `\r`, so
/// only the last state of each line is kept.
async fn pump(stream: impl AsyncRead + Unpin, tx: mpsc::UnboundedSender<Line>, wrap: fn(String) -> Line) {
  let mut reader = BufReader::new(stream);
  let mut buf = Vec::new();
  while reader.read_until(b'\n', &mut buf).await.unwrap_or(0) > 0 {
    let text = String::from_utf8_lossy(&buf);
    let line = text.trim_end_matches(['\r', '\n']).rsplit('\r').next().unwrap_or("").to_string();
    if tx.send(wrap(line)).is_err() {
      break;
    }
    buf.clear();
  }
}

/// Runs `git args` to completion and returns its stdout. stderr lines, where
/// git reports progress, go to `log` as they arrive; so does stdout when
/// `log_stdout` is set.
async fn run(
  dir: Option<&Path>,
  auth: &Auth,
  args: &[&str],
  cancel: &CancellationToken,
  log_stdout: bool,
  log: &mut (dyn FnMut(String) + Send),
) -> Result<String> {
  let mut child = command(dir, auth).args(args).spawn().map_err(spawn_error)?;
  let (tx, mut rx) = mpsc::unbounded_channel();
  tokio::spawn(pump(child.stdout.take().expect("piped"), tx.clone(), Line::Out));
  tokio::spawn(pump(child.stderr.take().expect("piped"), tx, Line::Err));

  let mut stdout = String::new();
  let mut stderr = Vec::new();
  loop {
    tokio::select! {
      line = rx.recv() => match line {
        Some(Line::Out(line)) => {
          if log_stdout && !line.is_empty() {
            log(line.clone());
          }
          stdout.push_str(&line);
          stdout.push('\n');
        }
        Some(Line::Err(line)) => {
          if !line.is_empty() {
            log(line.clone());
            stderr.push(line);
          }
        }
        None => break,
      },
      _ = cancel.cancelled() => return Err(CoreError::Cancelled),
    }
  }
  let status = tokio::select! {
    status = child.wait() => status?,
    _ = cancel.cancelled() => return Err(CoreError::Cancelled),
  };
  if status.success() { Ok(stdout) } else { Err(failure(args, status, &stderr)) }
}

/// Runs a quick local `git args` in `dir` and returns its stdout as is.
async fn output(dir: &Path, args: &[&str]) -> Result<String> {
  let out = command(Some(dir), &Auth::default()).args(args).output().await.map_err(spawn_error)?;
  if out.status.success() {
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
  } else {
    let stderr = String::from_utf8_lossy(&out.stderr);
    Err(failure(args, out.status, &stderr.lines().map(String::from).collect::<Vec<_>>()))
  }
}

fn spawn_error(err: std::io::Error) -> CoreError {
  match err.kind() {
    std::io::ErrorKind::NotFound => CoreError::Git("git was not found. Install Git and make sure it is on PATH.".into()),
    _ => err.into(),
  }
}

/// The `fatal:`/`error:` line git printed, else its last stderr line.
fn failure(args: &[&str], status: std::process::ExitStatus, stderr: &[String]) -> CoreError {
  let message = stderr.iter().rev().find(|l| l.starts_with("fatal:") || l.starts_with("error:")).or(stderr.last());
  CoreError::Git(message.cloned().unwrap_or_else(|| format!("git {} failed ({status})", args[0])))
}

fn ensure_repo(path: &Path) -> Result<()> {
  if path.join(".git").exists() {
    Ok(())
  } else {
    // Without this git would walk up to an enclosing repository and report on that.
    Err(CoreError::NotFound(format!("Repository not found at {}. Try cloning again.", path.display())))
  }
}

/// Branch names on the remote.
pub async fn branches(repo_url: &str, auth: &Auth) -> Result<Vec<String>> {
  let out = run(None, auth, &["ls-remote", "--heads", repo_url], &CancellationToken::new(), false, &mut |_| {}).await?;
  Ok(out.lines().filter_map(|line| line.split('\t').nth(1)?.strip_prefix("refs/heads/").map(String::from)).collect())
}

/// Clones `branch` alone into `dest`, replacing whatever is there.
pub async fn clone(
  dest: &Path,
  repo_url: &str,
  branch: &str,
  auth: &Auth,
  cancel: &CancellationToken,
  log: &mut (dyn FnMut(String) + Send),
) -> Result<()> {
  if let Some(parent) = dest.parent() {
    std::fs::create_dir_all(parent)?;
  }
  if dest.exists() {
    log("Removing existing clone...".into());
    super::files::remove_dir_all(dest)?;
  }
  log(format!("Cloning branch \"{branch}\" from {repo_url}..."));
  let dest = dest.to_string_lossy();
  run(None, auth, &["clone", "--progress", "--branch", branch, "--single-branch", "--", repo_url, &dest], cancel, true, log)
    .await?;
  log("Clone complete.".into());
  Ok(())
}

/// Points `origin` at the plain URL. Clones made by singl-web carry the PAT in it.
async fn reset_origin(path: &Path, repo_url: &str) -> Result<()> {
  if !repo_url.is_empty() {
    output(path, &["remote", "set-url", "origin", repo_url]).await?;
  }
  Ok(())
}

/// Fetches `branch` and switches to it. The clone is single-branch, so the
/// branch is first added to origin's fetch list; otherwise it would get no
/// upstream and later pulls would not update it.
pub async fn checkout(
  path: &Path,
  repo_url: &str,
  branch: &str,
  auth: &Auth,
  cancel: &CancellationToken,
  log: &mut (dyn FnMut(String) + Send),
) -> Result<()> {
  ensure_repo(path)?;
  reset_origin(path, repo_url).await?;
  let tracked = output(path, &["config", "--get-all", "remote.origin.fetch"]).await.unwrap_or_default();
  let refspec = format!("+refs/heads/{branch}:refs/remotes/origin/{branch}");
  if !tracked.lines().any(|l| l == refspec || l == "+refs/heads/*:refs/remotes/origin/*") {
    output(path, &["remote", "set-branches", "--add", "origin", branch]).await?;
  }
  log(format!("Fetching branch \"{branch}\" from remote..."));
  run(Some(path), auth, &["fetch", "--progress", "origin", &refspec], cancel, true, log).await?;
  log(format!("Switching to \"{branch}\"..."));
  run(Some(path), auth, &["checkout", branch], cancel, true, log).await?;
  // A branch switched to before this fix has no upstream; give it one.
  let upstream = format!("origin/{branch}");
  output(path, &["branch", "--set-upstream-to", &upstream, branch]).await?;
  Ok(())
}

pub async fn fetch(
  path: &Path,
  repo_url: &str,
  auth: &Auth,
  cancel: &CancellationToken,
  log: &mut (dyn FnMut(String) + Send),
) -> Result<()> {
  ensure_repo(path)?;
  reset_origin(path, repo_url).await?;
  log("Fetching from remote...".into());
  run(Some(path), auth, &["fetch", "--all", "--progress"], cancel, true, log).await?;
  log("Fetch complete.".into());
  Ok(())
}

/// Returns git's one-line summary: "Already up to date." or the `--stat` totals.
pub async fn pull(
  path: &Path,
  repo_url: &str,
  auth: &Auth,
  cancel: &CancellationToken,
  log: &mut (dyn FnMut(String) + Send),
) -> Result<String> {
  ensure_repo(path)?;
  reset_origin(path, repo_url).await?;
  log("Pulling latest changes...".into());
  let out = run(Some(path), auth, &["pull", "--progress", "--stat"], cancel, true, log).await?;
  Ok(
    out
      .lines()
      .map(str::trim)
      .find(|l| l.starts_with("Already up to date") || l.contains(" changed,"))
      .unwrap_or("Pull complete.")
      .to_string(),
  )
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct ChangedFile {
  pub path: String,
  /// `M`, `A`, `D` or `?` (untracked).
  pub status: &'static str,
}

/// Uncommitted changes. Files git calls modified only because of line
/// endings (`core.autocrlf`) are left out: `git diff HEAD` does not list them.
pub async fn status(path: &Path) -> Result<Vec<ChangedFile>> {
  ensure_repo(path)?;
  let (status, names) = tokio::join!(
    output(path, &["status", "--porcelain", "-uall", "-z"]),
    output(path, &["diff", "HEAD", "--name-only", "-z"]),
  );
  let names = names.unwrap_or_default();
  let changed: HashSet<&str> = names.trim_end_matches('\n').split('\0').filter(|n| !n.is_empty()).collect();
  Ok(parse_status(status?.trim_end_matches('\n'), &changed))
}

fn parse_status(porcelain: &str, changed: &HashSet<&str>) -> Vec<ChangedFile> {
  let mut seen = HashSet::new();
  let mut files = Vec::new();
  let mut entries = porcelain.split('\0');
  while let Some(entry) = entries.next() {
    let (Some(codes), Some(path)) = (entry.get(..2), entry.get(3..)) else { continue };
    let (x, y) = (codes.as_bytes()[0], codes.as_bytes()[1]);
    // Renames and copies are followed by their source path.
    if matches!(x, b'R' | b'C') {
      entries.next();
    }
    if !seen.insert(path) {
      continue;
    }
    let code = if x != b' ' && x != b'?' { x } else { y };
    let status = match code {
      b'A' => "A",
      b'D' => "D",
      b'?' => "?",
      _ => "M",
    };
    if status == "M" && !changed.contains(path) {
      continue;
    }
    files.push(ChangedFile { path: path.to_string(), status });
  }
  files
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileDiff {
  /// Empty for a file HEAD does not have.
  pub original: String,
  /// Empty for a deleted file.
  pub modified: String,
  pub has_textual_changes: bool,
}

/// `file` (relative to the repo, `/`-separated) at HEAD against the working tree.
pub async fn diff(path: &Path, file: &str) -> Result<FileDiff> {
  ensure_repo(path)?;
  let full = super::files::safe_join(path, file)?;
  let file = file.replace('\\', "/");

  let head = output(path, &["show", &format!("HEAD:{file}")]).await;
  let in_head = head.is_ok();
  let original = head.map(|s| normalize_text(&s)).unwrap_or_default();

  let on_disk = full.is_file();
  let modified = if on_disk {
    if std::fs::metadata(&full)?.len() > MAX_FILE_SIZE {
      return Err(CoreError::Invalid("File too large (> 1 MB)".into()));
    }
    normalize_text(&String::from_utf8_lossy(&std::fs::read(&full)?))
  } else {
    String::new()
  };

  let has_textual_changes = if in_head && on_disk {
    !output(path, &["diff", "HEAD", "--", &file]).await.unwrap_or_default().trim().is_empty()
  } else {
    true
  };
  Ok(FileDiff { original, modified, has_textual_changes })
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn slugs() {
    assert_eq!(slug("https://dev.azure.com/org/proj/_git/Windchill"), "Windchill");
    assert_eq!(slug("https://github.com/u/r.git"), "r");
    assert_eq!(slug("https://github.com/u/r/"), "r");
    assert_eq!(slug(""), "repo");
  }

  #[test]
  fn auth_user_by_host() {
    let azure = Auth::new("https://dev.azure.com/o/p/_git/r", Some("pat")).header.unwrap();
    assert_eq!(azure, "Authorization: Basic OnBhdA=="); // ":pat"
    assert!(Auth::new("https://github.com/u/r", Some("")).header.is_none());
  }

  #[test]
  fn status_codes() {
    let changed: HashSet<&str> = ["a.txt", "new.txt"].into();
    let porcelain = " M a.txt\0 M crlf-only.txt\0A  new.txt\0 D gone.txt\0?? x/untracked.txt\0R  b.txt\0old-b.txt\0";
    let files = parse_status(porcelain, &changed);
    let got: Vec<_> = files.iter().map(|f| (f.path.as_str(), f.status)).collect();
    assert_eq!(got, [("a.txt", "M"), ("new.txt", "A"), ("gone.txt", "D"), ("x/untracked.txt", "?")]);
  }

  #[tokio::test]
  async fn clone_checkout_fetch_pull_from_local_origin() {
    let dir = tempfile::tempdir().unwrap();
    let origin = dir.path().join("origin");
    std::fs::create_dir(&origin).unwrap();
    let git = |args: &'static [&'static str]| {
      let origin = origin.clone();
      async move { output(&origin, args).await.unwrap() }
    };
    git(&["init", "-q", "-b", "main"]).await;
    git(&["config", "user.email", "t@t"]).await;
    git(&["config", "user.name", "t"]).await;
    std::fs::write(origin.join("a.txt"), "one\n").unwrap();
    git(&["add", "."]).await;
    git(&["commit", "-qm", "init"]).await;
    git(&["branch", "dev"]).await;

    let url = origin.to_string_lossy().into_owned();
    assert_eq!(branches(&url, &Auth::default()).await.unwrap(), ["dev", "main"]);

    let clone_dir = dir.path().join("repo/origin");
    let cancel = CancellationToken::new();
    let mut lines = Vec::new();
    clone(&clone_dir, &url, "main", &Auth::default(), &cancel, &mut |l| lines.push(l)).await.unwrap();
    assert!(lines.iter().any(|l| l == "Clone complete."));
    assert!(clone_dir.join("a.txt").is_file());

    checkout(&clone_dir, &url, "dev", &Auth::default(), &cancel, &mut |_| {}).await.unwrap();
    assert_eq!(output(&clone_dir, &["branch", "--show-current"]).await.unwrap().trim(), "dev");

    fetch(&clone_dir, &url, &Auth::default(), &cancel, &mut |_| {}).await.unwrap();
    assert_eq!(pull(&clone_dir, &url, &Auth::default(), &cancel, &mut |_| {}).await.unwrap(), "Already up to date.");

    git(&["checkout", "-q", "dev"]).await;
    std::fs::write(origin.join("a.txt"), "two\n").unwrap();
    git(&["commit", "-qam", "change"]).await;
    let summary = pull(&clone_dir, &url, &Auth::default(), &cancel, &mut |_| {}).await.unwrap();
    assert!(summary.contains("1 file changed"), "{summary}");

    // Cloning again replaces the old clone, read-only pack files included.
    clone(&clone_dir, &url, "main", &Auth::default(), &cancel, &mut |_| {}).await.unwrap();
    assert_eq!(std::fs::read_to_string(clone_dir.join("a.txt")).unwrap().trim_end(), "one");

    let cancelled = CancellationToken::new();
    cancelled.cancel();
    assert!(matches!(fetch(&clone_dir, &url, &Auth::default(), &cancelled, &mut |_| {}).await, Err(CoreError::Cancelled)));
  }

  #[tokio::test]
  async fn status_and_diff_on_a_real_repo() {
    let dir = tempfile::tempdir().unwrap();
    let repo = dir.path();
    for args in [&["init", "-q"][..], &["config", "user.email", "t@t"], &["config", "user.name", "t"]] {
      output(repo, args).await.unwrap();
    }
    std::fs::write(repo.join("a.txt"), "one\n").unwrap();
    output(repo, &["add", "."]).await.unwrap();
    output(repo, &["commit", "-qm", "init"]).await.unwrap();
    std::fs::write(repo.join("a.txt"), "two\n").unwrap();
    std::fs::write(repo.join("b.txt"), "new\n").unwrap();

    let files = status(repo).await.unwrap();
    assert_eq!(files.len(), 2);
    let d = diff(repo, "a.txt").await.unwrap();
    assert_eq!((d.original.as_str(), d.modified.as_str(), d.has_textual_changes), ("one\n", "two\n", true));
    let d = diff(repo, "b.txt").await.unwrap();
    assert_eq!(d.original, "");
    assert!(diff(repo, "../escape.txt").await.is_err());
  }
}
