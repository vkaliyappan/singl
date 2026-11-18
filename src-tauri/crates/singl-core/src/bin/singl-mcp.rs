//! `singl-mcp`: a stdio MCP server for clients that cannot speak HTTP.
//!
//! If the singl app is running with its MCP server on (see the discovery file
//! `assistant-mcp.json` next to the database), every message is forwarded to it
//! so tools act in the live app. Otherwise the assistant's tools are served
//! in-process, without a window: UI tools fail cleanly and non-read tools are
//! denied unless writes are auto-approved.
//!
//! The database is `--db <path>`, else `SINGL_DB`, else
//! `%APPDATA%\com.singl.app\singl.db`. Newline-delimited JSON-RPC on
//! stdin/stdout; logs go to stderr.

use std::path::PathBuf;
use std::sync::{Arc, RwLock};
use std::time::Duration;

use serde_json::{Value, json};
use singl_core::agents::process::ProcRegistry;
use singl_core::assistant::Assistant;
use singl_core::assistant::mcp::server::{Caller, client_name, error_response, handle_payload};
use singl_core::assistant::mcp::discovery_path;
use singl_core::db;
use singl_core::workspace::Workspace;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::mpsc;

/// What answers a message: the running app, or this process.
enum Backend {
  Proxy { client: reqwest::Client, url: String, token: String },
  Local(Arc<Assistant>),
}

#[tokio::main]
async fn main() {
  let db_path = db_path();
  let backend = match running_app(&db_path).await {
    Some(proxy) => {
      eprintln!("singl-mcp: forwarding to the running app");
      Arc::new(proxy)
    }
    None => match local(&db_path).await {
      Ok(assistant) => {
        eprintln!("singl-mcp: app not running, serving in-process from {}", db_path.display());
        Arc::new(Backend::Local(assistant))
      }
      Err(e) => {
        eprintln!("singl-mcp: could not open {}: {e}", db_path.display());
        std::process::exit(1);
      }
    },
  };

  let (tx, mut rx) = mpsc::unbounded_channel::<Value>();
  let writer = tokio::spawn(async move {
    let mut out = tokio::io::stdout();
    while let Some(msg) = rx.recv().await {
      let mut line = msg.to_string();
      line.push('\n');
      if out.write_all(line.as_bytes()).await.is_err() || out.flush().await.is_err() {
        break;
      }
    }
  });

  let mut client: Option<String> = None;
  let mut lines = BufReader::new(tokio::io::stdin()).lines();
  while let Ok(Some(line)) = lines.next_line().await {
    if line.trim().is_empty() {
      continue;
    }
    let msg: Value = match serde_json::from_str(&line) {
      Ok(v) => v,
      Err(e) => {
        let _ = tx.send(error_response(Value::Null, -32700, &format!("Parse error: {e}")));
        continue;
      }
    };
    // The client's name (from `initialize`) picks its tool profile in the app.
    if let Some(name) = client_name(&msg) {
      client = Some(name);
    }
    let (backend, tx, client) = (backend.clone(), tx.clone(), client.clone());
    tokio::spawn(async move {
      if let Some(reply) = backend.handle(msg, client).await {
        let _ = tx.send(reply);
      }
    });
  }
  drop(tx);
  // Let in-flight calls finish answering before exit.
  let _ = tokio::time::timeout(Duration::from_secs(600), writer).await;
  if let Backend::Local(a) = backend.as_ref() {
    a.shutdown().await;
  }
}

impl Backend {
  async fn handle(&self, msg: Value, client: Option<String>) -> Option<Value> {
    match self {
      Backend::Local(assistant) => handle_payload(assistant, msg, &Caller::external_as(client)).await,
      Backend::Proxy { client: http, url, token } => {
        let id = msg.get("id").cloned();
        match forward(http, url, token, client.as_deref(), &msg).await {
          Ok(reply) => reply,
          Err(e) => id.map(|id| error_response(id, -32603, &format!("Could not reach the singl app: {e}"))),
        }
      }
    }
  }
}

async fn forward(
  http: &reqwest::Client,
  url: &str,
  token: &str,
  client: Option<&str>,
  msg: &Value,
) -> Result<Option<Value>, String> {
  let mut req = http.post(url);
  if let Some(name) = client.filter(|n| n.is_ascii()) {
    req = req.header("X-Singl-Client", name);
  }
  let resp = req
    .header("Authorization", format!("Bearer {token}"))
    .header("Content-Type", "application/json")
    .header("Accept", "application/json, text/event-stream")
    .body(msg.to_string())
    .send()
    .await
    .map_err(|e| e.to_string())?;
  let status = resp.status();
  let body = resp.text().await.map_err(|e| e.to_string())?;
  if status.as_u16() == 202 || body.trim().is_empty() {
    return Ok(None);
  }
  match serde_json::from_str::<Value>(&body) {
    Ok(v) => Ok(Some(v)),
    Err(_) => Err(format!("HTTP {status}: {}", body.chars().take(200).collect::<String>())),
  }
}

/// The app's MCP endpoint, when its discovery file points at something that answers.
async fn running_app(db_path: &std::path::Path) -> Option<Backend> {
  let text = std::fs::read_to_string(discovery_path(db_path)).ok()?;
  let file: Value = serde_json::from_str(&text).ok()?;
  let url = file.get("url")?.as_str()?.to_string();
  let token = file.get("token")?.as_str()?.to_string();
  let client = reqwest::Client::builder().connect_timeout(Duration::from_secs(3)).build().ok()?;
  let probe = json!({ "jsonrpc": "2.0", "id": 0, "method": "ping" });
  let reply = tokio::time::timeout(Duration::from_secs(3), forward(&client, &url, &token, None, &probe)).await.ok()?;
  reply.ok()??;
  Some(Backend::Proxy { client, url, token })
}

async fn local(db_path: &std::path::Path) -> singl_core::Result<Arc<Assistant>> {
  let pool = db::open(db_path).await?;
  let workspace = Workspace::new(db::settings::workspace_root(&pool).await?);
  Ok(Assistant::new(Arc::new(tokio::sync::RwLock::new(pool)), Arc::new(RwLock::new(workspace)), ProcRegistry::default()))
}

/// `--db <path>`, else `SINGL_DB`, else the installed app's database.
fn db_path() -> PathBuf {
  let mut args = std::env::args().skip(1);
  while let Some(arg) = args.next() {
    if arg == "--db" {
      if let Some(path) = args.next() {
        return PathBuf::from(path);
      }
    } else if let Some(path) = arg.strip_prefix("--db=") {
      return PathBuf::from(path);
    }
  }
  if let Ok(path) = std::env::var("SINGL_DB") {
    if !path.trim().is_empty() {
      return PathBuf::from(path);
    }
  }
  let base = std::env::var("APPDATA").map(PathBuf::from).unwrap_or_else(|_| std::env::temp_dir());
  base.join("com.singl.app").join("singl.db")
}
