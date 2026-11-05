//! Agent CLIs (Claude Code, Codex, Copilot, Antigravity): singl-web's
//! `agent-run.ts` / `agent-live.ts` process handling.
//!
//! Only the process side lives here: which binary a provider may start, the
//! working directory it may start in, and spawning, feeding, streaming and
//! killing it ([`process`]). What to pass a CLI and how to read what it prints
//! stays in `src/lib/twx-flow/agents.ts`, shared with the editor.
//!
//! The rules singl-web enforced stay:
//!   * only the four known binaries start; a provider names a binary, never a
//!     path, and only its `TWX_FLOW_AGENT_*_BIN` variable can point it elsewhere;
//!   * argv is a list and no shell ever runs, so prompt text cannot become a command;
//!   * the working directory must sit inside the agent root.

pub mod process;

use std::path::{Path, PathBuf};

use crate::{CoreError, Result};

/// `(provider, binary, override variable, title)`, as in `AGENT_DEFS`.
const PROVIDERS: &[(&str, &str, &str, &str)] = &[
  ("claude", "claude", "TWX_FLOW_AGENT_CLAUDE_BIN", "Claude Code"),
  ("codex", "codex", "TWX_FLOW_AGENT_CODEX_BIN", "Codex CLI"),
  ("copilot", "copilot", "TWX_FLOW_AGENT_COPILOT_BIN", "GitHub Copilot CLI"),
  ("antigravity", "agy", "TWX_FLOW_AGENT_ANTIGRAVITY_BIN", "Antigravity CLI"),
];

pub const PROVIDER_IDS: [&str; 4] = ["claude", "codex", "copilot", "antigravity"];

fn provider(id: &str) -> Result<(&'static str, &'static str, &'static str)> {
  PROVIDERS
    .iter()
    .find(|(p, ..)| *p == id)
    .map(|(_, bin, env, title)| (*bin, *env, *title))
    .ok_or_else(|| CoreError::Invalid(format!("Unknown agent \"{id}\".")))
}

/// What actually gets spawned: an executable and the argv in front of the caller's own.
#[derive(Debug, Clone, PartialEq)]
pub struct Command {
  pub file: PathBuf,
  pub prefix: Vec<String>,
}

fn is_file(path: &Path) -> bool {
  path.is_file()
}

fn path_dirs() -> Vec<PathBuf> {
  std::env::var_os("PATH").map(|p| std::env::split_paths(&p).collect()).unwrap_or_default()
}

/// Extensions worth trying on Windows, best first. `.ps1` needs a shell, so it is out.
const WINDOWS_EXTS: &[&str] = &[".exe", ".com", ".cmd", ".bat"];

fn find_on_path(bin: &str) -> Vec<PathBuf> {
  let exts: &[&str] = if cfg!(windows) { WINDOWS_EXTS } else { &[""] };
  path_dirs().into_iter().flat_map(|dir| exts.iter().map(move |ext| dir.join(format!("{bin}{ext}")))).collect()
}

/// npm/pnpm install CLIs on Windows as a `.cmd` shim, which cannot run without
/// a shell — and a shell would re-parse the prompt. The shim names the
/// JavaScript entry point it runs, so that is run with `node` directly.
fn unwrap_shim(shim: &Path) -> Option<Command> {
  let text = std::fs::read_to_string(shim).ok()?;
  let re = regex::Regex::new(r#"(?i)"%~dp0\\?([^"]+\.(?:js|mjs|cjs))""#).ok()?;
  let rel = re.captures(&text)?.get(1)?.as_str().replace('\\', std::path::MAIN_SEPARATOR_STR);
  let entry = shim.parent()?.join(rel);
  if !is_file(&entry) {
    return None;
  }
  // A shim that ships its own node.exe next to it prefers that one, as npm's do.
  let local = shim.parent()?.join("node.exe");
  let node = if is_file(&local) { local } else { find_on_path("node").into_iter().find(|p| is_file(p))? };
  Some(Command { file: node, prefix: vec![entry.to_string_lossy().into_owned()] })
}

fn is_executable(path: &Path) -> bool {
  #[cfg(unix)]
  {
    use std::os::unix::fs::PermissionsExt;
    path.metadata().map(|m| m.permissions().mode() & 0o111 != 0).unwrap_or(false)
  }
  #[cfg(not(unix))]
  {
    let _ = path;
    true
  }
}

/// A provider's binary: its override variable if set, otherwise the first match on PATH.
pub fn resolve_command(provider_id: &str) -> Result<Command> {
  let (bin, env_var, title) = provider(provider_id)?;
  let over = std::env::var(env_var).ok().map(|v| v.trim().to_string()).filter(|v| !v.is_empty());
  let candidates = match &over {
    Some(path) => vec![PathBuf::from(path)],
    None => find_on_path(bin),
  };
  for candidate in candidates {
    if !is_file(&candidate) {
      continue;
    }
    let ext = candidate.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
    if ext == "cmd" || ext == "bat" {
      if let Some(cmd) = unwrap_shim(&candidate) {
        return Ok(cmd);
      }
      continue;
    }
    if !is_executable(&candidate) {
      continue;
    }
    return Ok(Command { file: candidate, prefix: vec![] });
  }
  Err(CoreError::Invalid(match over {
    Some(path) => format!("{env_var} points at \"{path}\", which is not a file singl can run."),
    None => format!("\"{bin}\" is not on PATH. Install {title}, or set {env_var} to its full path."),
  }))
}

/// Whether a provider's binary can be found.
pub fn installed(provider_id: &str) -> bool {
  resolve_command(provider_id).is_ok()
}

/// Where agents run and what relative working directories resolve against:
/// `TWX_FLOW_AGENT_ROOT`, else the workspace folder, else the home folder.
pub fn agent_root(workspace_root: Option<&Path>) -> PathBuf {
  if let Some(root) = std::env::var_os("TWX_FLOW_AGENT_ROOT").filter(|v| !v.is_empty()) {
    return PathBuf::from(root);
  }
  if let Some(root) = workspace_root {
    return root.to_path_buf();
  }
  home_dir().unwrap_or_else(|| PathBuf::from("."))
}

pub fn home_dir() -> Option<PathBuf> {
  std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map(PathBuf::from)
}

/// Resolves a working directory against `root`, refusing anything outside it.
pub fn resolve_cwd(root: &Path, raw: Option<&str>) -> Result<PathBuf> {
  let raw = raw.map(str::trim).filter(|r| !r.is_empty());
  let mut wanted = root.to_path_buf();
  if let Some(raw) = raw {
    let path = Path::new(raw);
    if path.is_absolute() {
      wanted = path.to_path_buf();
    } else {
      for part in path.components() {
        match part {
          std::path::Component::CurDir => {}
          std::path::Component::ParentDir => {
            wanted.pop();
          }
          other => wanted.push(other),
        }
      }
    }
  }
  let inside = |p: &Path| {
    let norm = |p: &Path| p.to_string_lossy().replace('\\', "/").trim_end_matches('/').to_lowercase();
    let (p, r) = (norm(p), norm(root));
    p == r || p.starts_with(&format!("{r}/"))
  };
  if !inside(&wanted) {
    return Err(CoreError::Invalid(format!(
      "Working directory \"{}\" is outside {}.",
      raw.unwrap_or_default(),
      root.display()
    )));
  }
  if !wanted.is_dir() {
    return Err(CoreError::Invalid(format!("Working directory \"{}\" does not exist.", wanted.display())));
  }
  Ok(wanted)
}

/// The `.mcp.json` of the directory an agent runs in, when it has one.
pub fn project_mcp_config(cwd: &Path) -> Option<PathBuf> {
  let file = cwd.join(".mcp.json");
  is_file(&file).then_some(file)
}

/// The model lists the CLIs cache for themselves: `"claude"` reads
/// `~/.claude.json`, `"codex"` reads `~/.codex/models_cache.json`. None when
/// the file is not there yet.
pub async fn model_cache(which: &str) -> Option<String> {
  let env_dir = |var: &str| std::env::var_os(var).filter(|v| !v.is_empty()).map(PathBuf::from);
  let file = match which {
    "claude" => env_dir("CLAUDE_CONFIG_DIR").or_else(home_dir).map(|d| d.join(".claude.json")),
    "codex" => env_dir("CODEX_HOME").or_else(|| home_dir().map(|h| h.join(".codex"))).map(|d| d.join("models_cache.json")),
    _ => None,
  }?;
  tokio::fs::read_to_string(file).await.ok()
}

/// Every model `ANTHROPIC_API_KEY` can reach, as the Models API's JSON.
pub async fn anthropic_models() -> Result<Option<String>> {
  let Some(key) = std::env::var("ANTHROPIC_API_KEY").ok().filter(|k| !k.trim().is_empty()) else {
    return Ok(None);
  };
  let base = std::env::var("ANTHROPIC_BASE_URL").ok().filter(|b| !b.trim().is_empty());
  let base = base.as_deref().unwrap_or("https://api.anthropic.com").trim_end_matches('/').to_string();
  let failed = |e: reqwest::Error| CoreError::Invalid(format!("Anthropic Models API: {e}"));
  let res = reqwest::Client::new()
    .get(format!("{base}/v1/models?limit=1000"))
    .header("x-api-key", key.trim())
    .header("anthropic-version", "2023-06-01")
    .timeout(std::time::Duration::from_secs(10))
    .send()
    .await
    .map_err(failed)?;
  if !res.status().is_success() {
    return Err(CoreError::Invalid(format!("Anthropic Models API answered {}", res.status())));
  }
  Ok(Some(res.text().await.map_err(failed)?))
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn unknown_providers_are_refused() {
    assert!(resolve_command("bash").is_err());
  }

  #[test]
  fn cwd_stays_inside_the_root() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir(dir.path().join("sub")).unwrap();
    assert_eq!(resolve_cwd(dir.path(), None).unwrap(), dir.path());
    assert_eq!(resolve_cwd(dir.path(), Some("sub")).unwrap(), dir.path().join("sub"));
    assert!(resolve_cwd(dir.path(), Some("..")).is_err());
    assert!(resolve_cwd(dir.path(), Some("missing")).is_err());
  }

  #[test]
  fn shims_unwrap_to_node_and_their_entry() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(dir.path().join("node_modules/x")).unwrap();
    std::fs::write(dir.path().join("node_modules/x/cli.js"), "").unwrap();
    std::fs::write(dir.path().join("node.exe"), "").unwrap();
    let shim = dir.path().join("x.cmd");
    std::fs::write(&shim, "@ECHO off\r\n\"%_prog%\"  \"%~dp0\\node_modules\\x\\cli.js\" %*\r\n").unwrap();
    let cmd = unwrap_shim(&shim).unwrap();
    assert_eq!(cmd.file, dir.path().join("node.exe"));
    assert!(cmd.prefix[0].ends_with("cli.js"));
  }
}
