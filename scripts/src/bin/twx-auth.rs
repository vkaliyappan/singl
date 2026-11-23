//! `twx-auth`: manage the saved ThingWorx login used by UI tests, from a terminal.
//! Port of singl-web's `scripts/twx-auth.ts`, on top of `uitest::session`, so it
//! reads and writes the same per-environment login the app's App Tests page uses.
//!
//!   twx-auth check [--env <id>] [--db <path>]   headless; exit 0 = valid, 1 = no saved login, 2 = expired
//!   twx-auth login [--env <id>] [--db <path>]   opens Edge; finish SSO/MFA there; the login is saved
//!
//! `--env` defaults to the only environment that has a ThingWorx URL (or
//! `SINGL_TWX_ENV`). The database is `--db`, else `SINGL_DB`, else the installed
//! app's. Needs Node.js (npx) and Microsoft Edge, like the app. Never prints
//! cookie values.
//!
//! The browser uses the environment's own Edge profile, so close the app's
//! login window or UI test run for that environment first.

use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};
use std::time::{Duration, Instant};

use serde_json::json;
use singl_core::agents::process::ProcRegistry;
use singl_core::assistant::Assistant;
use singl_core::uitest::session;
use singl_core::workspace::Workspace;
use singl_core::{CoreError, db};

const LOGIN_TIMEOUT: Duration = Duration::from_secs(5 * 60);
const POLL_EVERY: Duration = Duration::from_secs(2);
/// Lets the Runtime finish post-login redirects so the session cookie is final.
const SETTLE: Duration = Duration::from_secs(5);

const EXIT_NO_AUTH: i32 = 1;
const EXIT_EXPIRED: i32 = 2;
const EXIT_LOGIN_FAILED: i32 = 3;
const EXIT_USAGE: i32 = 64;

struct Args {
  mode: String,
  env: Option<String>,
  db: PathBuf,
}

#[tokio::main]
async fn main() {
  let Some(args) = parse_args() else {
    eprintln!("Usage: twx-auth <check|login> [--env <id>] [--db <path>]");
    std::process::exit(EXIT_USAGE);
  };
  let code = match run(&args).await {
    Ok(code) => code,
    Err(e) => {
      println!("ERROR: {e}");
      if args.mode == "login" { EXIT_LOGIN_FAILED } else { EXIT_EXPIRED }
    }
  };
  std::process::exit(code);
}

async fn run(args: &Args) -> singl_core::Result<i32> {
  let pool = db::open(&args.db).await?;
  let (env_id, base) = pick_env(&pool, args.env.as_deref()).await?;
  let workspace = Workspace::new(db::settings::workspace_root(&pool).await?);
  let a = Assistant::new(Arc::new(tokio::sync::RwLock::new(pool)), Arc::new(RwLock::new(workspace)), ProcRegistry::default());
  let data_dir = args.db.parent().map(Path::to_path_buf).unwrap_or_default();

  let code = match args.mode.as_str() {
    "check" => check(&a, &data_dir, &env_id).await,
    _ => login(&a, &data_dir, &env_id, &base).await,
  };
  a.remove_transient_mcp(session::SERVER).await;
  a.shutdown().await;
  code
}

async fn check(a: &Arc<Assistant>, data_dir: &Path, env_id: &str) -> singl_core::Result<i32> {
  let file = session::session_file(data_dir, env_id);
  if !file.is_file() {
    println!("NO_AUTH: no saved login for \"{env_id}\" ({}). Run: twx-auth login --env {env_id}", file.display());
    return Ok(EXIT_NO_AUTH);
  }
  let valid = session::check_valid(a, data_dir, env_id).await?;
  session::record_check(data_dir, env_id, valid)?;
  if valid {
    println!("VALID: saved login for \"{env_id}\" reaches the ThingWorx app.");
    Ok(0)
  } else {
    println!("EXPIRED: saved login for \"{env_id}\" did not reach the app. Run: twx-auth login --env {env_id}");
    Ok(EXIT_EXPIRED)
  }
}

async fn login(a: &Arc<Assistant>, data_dir: &Path, env_id: &str, base: &str) -> singl_core::Result<i32> {
  session::login_start(a, data_dir, env_id).await?;
  println!(
    "Complete the SSO/MFA login in the browser window (waiting up to {} min)...",
    LOGIN_TIMEOUT.as_secs() / 60
  );

  let servers = a.mcp_servers().await?;
  let run_code = session::tool_named(a, &servers, "browser_run_code")
    .await
    .ok_or_else(|| CoreError::Invalid("The browser has no run-code tool.".into()))?;
  let deadline = Instant::now() + LOGIN_TIMEOUT;
  loop {
    tokio::time::sleep(POLL_EVERY).await;
    let url = a
      .mcp_clients
      .call(&servers, &run_code, json!({ "code": "async (page) => page.url()" }), Duration::from_secs(20))
      .await
      .ok()
      .and_then(|text| session::page_url(&text).or_else(|| first_url(&text)));
    if url.is_some_and(|u| session::url_is_signed_in(&u, base)) {
      break;
    }
    if Instant::now() >= deadline {
      session::login_cancel(a, data_dir, env_id).await?;
      println!("LOGIN_FAILED: did not reach the ThingWorx app within {} min.", LOGIN_TIMEOUT.as_secs() / 60);
      return Ok(EXIT_LOGIN_FAILED);
    }
  }

  tokio::time::sleep(SETTLE).await;
  session::login_finish(a, data_dir, env_id).await?;
  session::record_check(data_dir, env_id, true)?;
  println!("SAVED: login for \"{env_id}\" stored at {}", session::session_file(data_dir, env_id).display());
  Ok(0)
}

/// The first `http(s)://` URL in a tool result.
fn first_url(text: &str) -> Option<String> {
  let i = text.find("http")?;
  let url: String = text[i..].chars().take_while(|c| !c.is_whitespace() && *c != '"' && *c != '\'').collect();
  url.contains("://").then_some(url)
}

/// The chosen environment and its ThingWorx URL.
async fn pick_env(pool: &singl_core::SqlitePool, wanted: Option<&str>) -> singl_core::Result<(String, String)> {
  let envs: Vec<_> = db::environments::list(pool).await?.into_iter().filter(|e| !e.twx_base_url.trim().is_empty()).collect();
  let names = || envs.iter().map(|e| e.environment.as_str()).collect::<Vec<_>>().join(", ");
  let env = match wanted {
    Some(id) => envs.iter().find(|e| e.environment == id),
    None if envs.len() == 1 => envs.first(),
    None => {
      return Err(CoreError::Invalid(format!("Pick an environment with --env: {}", if envs.is_empty() { "none configured".into() } else { names() })));
    }
  };
  let env = env.ok_or_else(|| CoreError::NotFound(format!("No environment \"{}\" with a ThingWorx URL. Known: {}", wanted.unwrap_or_default(), names())))?;
  Ok((env.environment.clone(), env.twx_base_url.clone()))
}

fn parse_args() -> Option<Args> {
  let mut it = std::env::args().skip(1);
  let mode = it.next().filter(|m| m == "check" || m == "login")?;
  let mut env = std::env::var("SINGL_TWX_ENV").ok().filter(|s| !s.trim().is_empty());
  let mut db = None;
  while let Some(arg) = it.next() {
    match arg.as_str() {
      "--env" => env = Some(it.next()?),
      "--db" => db = Some(PathBuf::from(it.next()?)),
      _ => {
        if let Some(v) = arg.strip_prefix("--env=") {
          env = Some(v.to_string());
        } else if let Some(v) = arg.strip_prefix("--db=") {
          db = Some(PathBuf::from(v));
        } else {
          return None;
        }
      }
    }
  }
  let db = db.or_else(|| std::env::var("SINGL_DB").ok().filter(|s| !s.trim().is_empty()).map(PathBuf::from)).unwrap_or_else(|| {
    let base = std::env::var("APPDATA").map(PathBuf::from).unwrap_or_else(|_| std::env::temp_dir());
    base.join("com.singl.app").join("singl.db")
  });
  Some(Args { mode, env, db })
}
