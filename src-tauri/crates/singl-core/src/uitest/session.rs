//! The saved ThingWorx login (a Playwright `storageState`) per environment.
//! The user signs in once in a headed browser; later runs load the file.
//! Sessions live under `<app data>/uitest/sessions/`, never in the repo.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::now_ms;
use crate::assistant::Assistant;
use crate::assistant::settings::McpServerConfig;
use crate::{CoreError, Result};

/// Name of the transient Playwright MCP server.
pub const SERVER: &str = "uitest";
const NAV_TIMEOUT: Duration = Duration::from_secs(120);
const CODE_TIMEOUT: Duration = Duration::from_secs(60);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UiSessionStatus {
  pub env_id: String,
  pub exists: bool,
  pub saved_at: Option<i64>,
  pub verified_at: Option<i64>,
  pub valid: Option<bool>,
  pub login_open: bool,
  pub message: String,
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct Meta {
  saved_at: Option<i64>,
  verified_at: Option<i64>,
  valid: Option<bool>,
}

/// The environment whose headed login window is open.
static LOGIN: Mutex<Option<String>> = Mutex::new(None);

fn login_env() -> Option<String> {
  LOGIN.lock().unwrap_or_else(|e| e.into_inner()).clone()
}

fn set_login(env: Option<String>) {
  *LOGIN.lock().unwrap_or_else(|e| e.into_inner()) = env;
}

fn invalid(msg: impl Into<String>) -> CoreError {
  CoreError::Invalid(msg.into())
}

// ---- files ------------------------------------------------------------------

fn file_stem(env_id: &str) -> String {
  env_id.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' }).collect()
}

pub fn sessions_dir(data_dir: &Path) -> PathBuf {
  data_dir.join("uitest").join("sessions")
}

pub fn session_file(data_dir: &Path, env_id: &str) -> PathBuf {
  sessions_dir(data_dir).join(format!("{}.json", file_stem(env_id)))
}

/// The environment's own Edge profile: keeps the identity provider's cookies,
/// remembered user names and account picks between runs.
pub fn profile_dir(data_dir: &Path, env_id: &str) -> PathBuf {
  data_dir.join("uitest").join("profiles").join(file_stem(env_id))
}

fn meta_file(data_dir: &Path, env_id: &str) -> PathBuf {
  sessions_dir(data_dir).join(format!("{}.meta.json", file_stem(env_id)))
}

fn read_meta(data_dir: &Path, env_id: &str) -> Meta {
  std::fs::read_to_string(meta_file(data_dir, env_id)).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
}

fn write_meta(data_dir: &Path, env_id: &str, meta: &Meta) -> Result<()> {
  std::fs::create_dir_all(sessions_dir(data_dir))?;
  std::fs::write(meta_file(data_dir, env_id), serde_json::to_string(meta).unwrap_or_default())?;
  Ok(())
}

/// A folder for a browser's screenshots and downloads.
pub fn output_dir(data_dir: &Path, name: &str) -> PathBuf {
  let dir = data_dir.join("uitest").join("runs").join(file_stem(name));
  let _ = std::fs::create_dir_all(&dir);
  dir
}

pub fn status(data_dir: &Path, env_id: &str, message: &str) -> UiSessionStatus {
  let exists = session_file(data_dir, env_id).is_file();
  let meta = read_meta(data_dir, env_id);
  let message = if !message.is_empty() {
    message.to_string()
  } else if !exists {
    "No saved login.".to_string()
  } else {
    match meta.valid {
      Some(true) => "Saved login works.".to_string(),
      Some(false) => "Saved login has expired. Log in again.".to_string(),
      None => "Saved login, not checked yet.".to_string(),
    }
  };
  UiSessionStatus {
    env_id: env_id.to_string(),
    exists,
    saved_at: meta.saved_at.filter(|_| exists),
    verified_at: meta.verified_at.filter(|_| exists),
    valid: meta.valid.filter(|_| exists),
    login_open: login_env().as_deref() == Some(env_id),
    message,
  }
}

// ---- URLs -------------------------------------------------------------------

/// The page a login or check opens: the base URL, or its `/Thingworx/` when it has no path.
pub fn landing_url(base: &str) -> String {
  let base = base.trim().trim_end_matches('/');
  let after_scheme = base.split_once("://").map_or(base, |(_, rest)| rest);
  if after_scheme.contains('/') { base.to_string() } else { format!("{base}/Thingworx/") }
}

/// The host (with port) of a URL, lower case.
pub fn host_of(url: &str) -> String {
  let rest = url.split_once("://").map_or(url, |(_, r)| r);
  let end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
  let auth = &rest[..end];
  auth.rsplit_once('@').map_or(auth, |(_, h)| h).to_lowercase()
}

/// Whether `url` looks like a sign-in page.
pub fn is_login_url(url: &str) -> bool {
  let u = url.to_lowercase();
  ["/login", "formlogin", "/adfs/", "login.microsoftonline", "/idp/", "saml", "oauth2/authorize"].iter().any(|m| u.contains(m))
}

/// A session is good when the visit stayed on the TWX host and not on a sign-in page.
pub fn url_is_signed_in(url: &str, base: &str) -> bool {
  !url.is_empty() && host_of(url) == host_of(base) && !is_login_url(url)
}

/// The `Page URL:` a Playwright MCP result reports.
pub fn page_url(text: &str) -> Option<String> {
  let i = text.find("Page URL:")?;
  let rest = &text[i + "Page URL:".len()..];
  let line = rest.lines().next()?.trim();
  (!line.is_empty()).then(|| line.to_string())
}

/// A `storageState` object (has `cookies`) inside a tool result: bare, or as a JSON string.
pub fn extract_storage_state(text: &str) -> Option<Value> {
  let as_state = |v: Value| v.get("cookies").is_some().then_some(v);
  for (i, c) in text.char_indices() {
    if c != '{' && c != '"' {
      continue;
    }
    let Some(Ok(v)) = serde_json::Deserializer::from_str(&text[i..]).into_iter::<Value>().next() else { continue };
    match v {
      Value::Object(_) => {
        if let Some(s) = as_state(v) {
          return Some(s);
        }
      }
      Value::String(s) if s.starts_with('{') => {
        if let Some(s) = serde_json::from_str::<Value>(&s).ok().and_then(as_state) {
          return Some(s);
        }
      }
      _ => {}
    }
  }
  None
}

// ---- the browser ------------------------------------------------------------

/// The Playwright MCP server, as the transient `uitest` server. With a profile the
/// browser keeps its data there between starts; without one it starts clean.
pub fn server_config(out_dir: &Path, profile: Option<&Path>, headless: bool) -> McpServerConfig {
  let mut args: Vec<String> = ["-y", "@playwright/mcp@latest", "--browser", "msedge", "--output-dir"].map(String::from).to_vec();
  args.push(out_dir.to_string_lossy().into_owned());
  match profile {
    Some(p) => {
      let _ = std::fs::create_dir_all(p);
      args.push("--user-data-dir".into());
      args.push(p.to_string_lossy().into_owned());
    }
    None => args.push("--isolated".into()),
  }
  if headless {
    args.push("--headless".into());
  }
  McpServerConfig { name: SERVER.into(), enabled: true, command: "npx".into(), args, ..Default::default() }
}

/// Registers `cfg`, starts it and returns the server list to call it with.
pub async fn start_browser(a: &Arc<Assistant>, cfg: McpServerConfig) -> Result<Vec<McpServerConfig>> {
  a.set_transient_mcp(cfg);
  let servers = a.mcp_servers().await?;
  let specs = a.mcp_clients.tools(&servers).await;
  if !specs.iter().any(|t| t.name.starts_with(crate::assistant::UITEST_PREFIX)) {
    let why = a.mcp_clients.status(&servers).await.into_iter().find(|s| s.name == SERVER).and_then(|s| s.error);
    a.remove_transient_mcp(SERVER).await;
    return Err(invalid(format!(
      "Could not start the browser (Playwright MCP). Node.js with npx and Microsoft Edge must be installed. {}",
      why.unwrap_or_default()
    )));
  }
  Ok(servers)
}

/// The exposed name of the server's tool whose own name starts with `prefix`.
pub async fn tool_named(a: &Arc<Assistant>, servers: &[McpServerConfig], prefix: &str) -> Option<String> {
  a.mcp_clients.server_tools(servers).await.into_iter().find(|t| t.server == SERVER && t.original.starts_with(prefix)).map(|t| t.name)
}

/// Starts the environment's browser (its own profile) and adds the saved login's cookies.
pub async fn start_env_browser(a: &Arc<Assistant>, data_dir: &Path, env_id: &str, out_dir: &Path, headless: bool) -> Result<Vec<McpServerConfig>> {
  let cfg = server_config(out_dir, Some(&profile_dir(data_dir, env_id)), headless);
  let servers = start_browser(a, cfg).await?;
  restore_cookies(a, &servers, &session_file(data_dir, env_id)).await;
  Ok(servers)
}

/// Best effort: a missing or unreadable file leaves the profile's own cookies.
async fn restore_cookies(a: &Arc<Assistant>, servers: &[McpServerConfig], file: &Path) {
  let Some(cookies) = std::fs::read_to_string(file).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()).and_then(|v| v.get("cookies").cloned()) else {
    return;
  };
  if !cookies.as_array().is_some_and(|c| !c.is_empty()) {
    return;
  }
  let Some(name) = tool_named(a, servers, "browser_run_code").await else { return };
  let code = format!("async (page) => {{ await page.context().addCookies({cookies}); return 'ok'; }}");
  if let Err(e) = a.mcp_clients.call(servers, &name, json!({ "code": code }), CODE_TIMEOUT).await {
    crate::assistant::log_warn(&format!("uitest: could not restore the saved login: {e}"));
  }
}

/// Saves the running browser's cookies as the environment's login (keeps the check result).
pub async fn refresh_saved(a: &Arc<Assistant>, data_dir: &Path, env_id: &str) {
  if let Ok(state) = capture_state(a).await {
    let _ = std::fs::write(session_file(data_dir, env_id), serde_json::to_string(&state).unwrap_or_default());
  }
}

/// Opens `url` in the running browser; returns the tool's text (with `Page URL:`).
pub async fn navigate(a: &Arc<Assistant>, servers: &[McpServerConfig], url: &str) -> Result<String> {
  let name = tool_named(a, servers, "browser_navigate").await.ok_or_else(|| invalid("The browser has no navigate tool."))?;
  a.mcp_clients.call(servers, &name, json!({ "url": url }), NAV_TIMEOUT).await
}

async fn base_url(a: &Arc<Assistant>, env_id: &str) -> Result<String> {
  let envs = crate::db::environments::list(&a.pool().await).await?;
  let env = envs.into_iter().find(|e| e.environment == env_id).ok_or_else(|| CoreError::NotFound(format!("No environment \"{env_id}\".")))?;
  if env.twx_base_url.trim().is_empty() {
    return Err(invalid(format!("Environment \"{env_id}\" has no ThingWorx URL.")));
  }
  Ok(env.twx_base_url)
}

fn busy_check(env_id: &str) -> Result<()> {
  if super::runner::active().is_some() {
    return Err(invalid("A UI test run is going. Wait for it to finish."));
  }
  match login_env() {
    Some(e) if e == env_id => Err(invalid("The login window is already open.")),
    Some(e) => Err(invalid(format!("A login window is open for \"{e}\". Finish or cancel it first."))),
    None => Ok(()),
  }
}

// ---- commands ---------------------------------------------------------------

/// Opens a headed browser at the environment for the user to sign in.
pub async fn login_start(a: &Arc<Assistant>, data_dir: &Path, env_id: &str) -> Result<UiSessionStatus> {
  busy_check(env_id)?;
  let base = base_url(a, env_id).await?;
  let servers = start_env_browser(a, data_dir, env_id, &output_dir(data_dir, "login"), false).await?;
  set_login(Some(env_id.to_string()));
  if let Err(e) = navigate(a, &servers, &landing_url(&base)).await {
    set_login(None);
    a.remove_transient_mcp(SERVER).await;
    return Err(e);
  }
  Ok(status(data_dir, env_id, "Sign in in the browser window, then press Save login."))
}

/// Saves the open browser's cookies as the environment's login and closes it.
pub async fn login_finish(a: &Arc<Assistant>, data_dir: &Path, env_id: &str) -> Result<UiSessionStatus> {
  if login_env().as_deref() != Some(env_id) {
    return Err(invalid("No login window is open for this environment."));
  }
  let result = capture_state(a).await;
  let state = match result {
    Ok(s) => s,
    // Leave the window open so the user can retry.
    Err(e) => return Err(e),
  };
  std::fs::create_dir_all(sessions_dir(data_dir))?;
  std::fs::write(session_file(data_dir, env_id), serde_json::to_string(&state).unwrap_or_default())?;
  write_meta(data_dir, env_id, &Meta { saved_at: Some(now_ms()), verified_at: None, valid: None })?;
  set_login(None);
  a.remove_transient_mcp(SERVER).await;
  Ok(status(data_dir, env_id, "Login saved."))
}

async fn capture_state(a: &Arc<Assistant>) -> Result<Value> {
  let servers = a.mcp_servers().await?;
  let name = tool_named(a, &servers, "browser_run_code")
    .await
    .ok_or_else(|| invalid("The browser has no run-code tool, so the login cannot be read."))?;
  let code = "async (page) => JSON.stringify(await page.context().storageState())";
  let text = a.mcp_clients.call(&servers, &name, json!({ "code": code }), CODE_TIMEOUT).await?;
  extract_storage_state(&text).ok_or_else(|| invalid("Could not read the browser's login. Is the window still open?"))
}

pub async fn login_cancel(a: &Arc<Assistant>, data_dir: &Path, env_id: &str) -> Result<UiSessionStatus> {
  if login_env().is_some() {
    set_login(None);
    a.remove_transient_mcp(SERVER).await;
  }
  Ok(status(data_dir, env_id, ""))
}

/// Visits the environment headless with the saved login; records whether it still works.
pub async fn check(a: &Arc<Assistant>, data_dir: &Path, env_id: &str) -> Result<UiSessionStatus> {
  let file = session_file(data_dir, env_id);
  if !file.is_file() {
    return Ok(status(data_dir, env_id, ""));
  }
  busy_check(env_id)?;
  let valid = check_valid(a, data_dir, env_id).await?;
  record_check(data_dir, env_id, valid)?;
  Ok(status(data_dir, env_id, ""))
}

/// Remembers the result of a check.
pub fn record_check(data_dir: &Path, env_id: &str, valid: bool) -> Result<()> {
  let mut meta = read_meta(data_dir, env_id);
  meta.verified_at = Some(now_ms());
  meta.valid = Some(valid);
  write_meta(data_dir, env_id, &meta)
}

/// The headless visit itself; leaves no browser running.
pub async fn check_valid(a: &Arc<Assistant>, data_dir: &Path, env_id: &str) -> Result<bool> {
  let base = base_url(a, env_id).await?;
  let servers = start_env_browser(a, data_dir, env_id, &output_dir(data_dir, "check"), true).await?;
  let visit = navigate(a, &servers, &landing_url(&base)).await;
  a.remove_transient_mcp(SERVER).await;
  let text = visit?;
  Ok(page_url(&text).is_some_and(|u| url_is_signed_in(&u, &base)))
}

pub async fn clear(a: &Arc<Assistant>, data_dir: &Path, env_id: &str) -> Result<UiSessionStatus> {
  if login_env().as_deref() == Some(env_id) {
    login_cancel(a, data_dir, env_id).await?;
  }
  let _ = std::fs::remove_file(session_file(data_dir, env_id));
  let _ = std::fs::remove_file(meta_file(data_dir, env_id));
  let _ = std::fs::remove_dir_all(profile_dir(data_dir, env_id));
  Ok(status(data_dir, env_id, "Saved login removed."))
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn login_pages_are_detected() {
    for u in [
      "https://tw.example.com/Thingworx/FormLogin",
      "https://login.microsoftonline.com/abc/oauth2/authorize?x=1",
      "https://sso.example.com/adfs/ls/?wa=wsignin1.0",
      "https://idp.example.com/idp/SSO.saml2",
      "https://tw.example.com/login",
    ] {
      assert!(is_login_url(u), "{u}");
    }
    assert!(!is_login_url("https://tw.example.com/Thingworx/Composer/index.html"));
    let base = "https://tw.example.com/Thingworx";
    assert!(url_is_signed_in("https://tw.example.com/Thingworx/Composer/", base));
    assert!(!url_is_signed_in("https://sso.other.com/start", base));
    assert!(!url_is_signed_in("https://tw.example.com/Thingworx/FormLogin", base));
    assert!(!url_is_signed_in("", base));
  }

  #[test]
  fn landing_and_page_url() {
    assert_eq!(landing_url("https://tw.example.com/"), "https://tw.example.com/Thingworx/");
    assert_eq!(landing_url("https://tw.example.com/Thingworx/"), "https://tw.example.com/Thingworx");
    assert_eq!(host_of("https://User@TW.example.com:8443/x"), "tw.example.com:8443");
    let text = "### Ran Playwright code\n- Page URL: https://a.com/x?y=1\n- Page Title: T\n";
    assert_eq!(page_url(text).as_deref(), Some("https://a.com/x?y=1"));
  }

  #[test]
  fn storage_state_is_found_bare_or_quoted() {
    let bare = "### Result\n{\"cookies\":[{\"name\":\"a\"}],\"origins\":[]}\n### Ran code";
    assert_eq!(extract_storage_state(bare).unwrap()["cookies"][0]["name"], "a");
    let quoted = "### Result\n\"{\\\"cookies\\\":[],\\\"origins\\\":[]}\"\n";
    assert!(extract_storage_state(quoted).unwrap()["cookies"].is_array());
    assert!(extract_storage_state("{\"foo\":1} nothing").is_none());
  }
}
