//! MCP clients for project / Settings-page servers, over stdio (a child
//! process speaking newline-delimited JSON-RPC) or streamable HTTP.
//!
//! Servers start lazily on [`McpClients::tools`], are cached, and are stopped
//! when removed, disabled or changed. Their tools are exposed as
//! `<server>__<tool>`.

use std::collections::{HashMap, HashSet, VecDeque};
use std::hash::{Hash, Hasher};
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex, Weak};
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{Mutex, mpsc, oneshot};

use super::host::{Handler, LoggedCall};
use crate::assistant::Assistant;
use crate::assistant::settings::McpServerConfig;
use crate::assistant::tools::{Risk, ToolSpec};
use crate::{CoreError, Result};

const PROTOCOL: &str = "2025-06-18";
const START_TIMEOUT: Duration = Duration::from_secs(30);
pub(super) const LIST_TIMEOUT: Duration = Duration::from_secs(30);
const RETRY_AFTER: Duration = Duration::from_secs(60);
const STDERR_LINES: usize = 50;
const MAX_NAME: usize = 64;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerStatus {
  pub name: String,
  pub source: String,
  pub enabled: bool,
  /// `"stopped" | "starting" | "running" | "error"`.
  pub state: String,
  pub error: Option<String>,
  pub tool_count: usize,
  /// An HTTP server, so it can take an OAuth sign-in.
  pub http: bool,
  pub signed_in: bool,
}

fn invalid(msg: impl Into<String>) -> CoreError {
  CoreError::Invalid(msg.into())
}

// ---- names, risk, content ----------------------------------------------------

fn sanitize_tool(name: &str) -> String {
  name.chars().map(|c| if c.is_ascii_alphanumeric() || c == '_' || c == '-' { c } else { '_' }).collect()
}

fn short_hash(s: &str) -> String {
  let mut h = std::collections::hash_map::DefaultHasher::new();
  s.hash(&mut h);
  format!("{:08x}", h.finish() as u32)
}

/// `<server>__<tool>` within 64 chars; a short hash keeps long or colliding names apart.
fn expose_name(server: &str, tool: &str, used: &HashSet<String>) -> String {
  let plain = format!("{server}__{}", sanitize_tool(tool));
  if plain.len() <= MAX_NAME && !used.contains(&plain) {
    return plain;
  }
  let hash = short_hash(tool);
  let keep: String = plain.chars().take(MAX_NAME - 9).collect();
  let mut candidate = format!("{keep}_{hash}");
  let mut n = 2;
  while used.contains(&candidate) {
    let suffix = format!("_{hash}{n}");
    let keep: String = plain.chars().take(MAX_NAME - suffix.len()).collect();
    candidate = format!("{keep}{suffix}");
    n += 1;
  }
  candidate
}

/// Verbs that run something or delete/publish: a tool named with one is
/// destructive whatever its server claims.
const DESTRUCTIVE_VERBS: &[&str] = &[
  "invoke", "execute", "exec", "run", "call", "eval", "delete", "remove", "drop", "purge", "destroy", "deploy",
  "push", "upload", "publish", "send", "merge", "kill", "terminate", "reset", "clear", "truncate", "uninstall",
  "restart", "shutdown", "trash",
];
/// Verbs that change something.
const WRITE_VERBS: &[&str] = &[
  "write", "create", "update", "set", "put", "post", "patch", "import", "save", "rename", "move", "add", "insert",
  "edit", "modify", "apply", "commit", "install", "enable", "disable", "approve", "start", "stop", "fill", "click",
  "type", "press", "navigate", "upsert", "assign", "close", "open", "lock", "unlock", "label", "tag", "share",
];

/// A tool name's words: `twx_InvokeService` → `twx`, `invoke`, `service`.
fn words(name: &str) -> Vec<String> {
  let mut out = Vec::new();
  let mut cur = String::new();
  let mut prev_lower = false;
  for c in name.chars() {
    if !c.is_ascii_alphanumeric() {
      if !cur.is_empty() {
        out.push(std::mem::take(&mut cur));
      }
      prev_lower = false;
      continue;
    }
    if c.is_ascii_uppercase() && prev_lower && !cur.is_empty() {
      out.push(std::mem::take(&mut cur));
    }
    prev_lower = c.is_ascii_lowercase() || c.is_ascii_digit();
    cur.push(c.to_ascii_lowercase());
  }
  if !cur.is_empty() {
    out.push(cur);
  }
  out
}

/// The risk of one MCP tool. The name decides first, so a server marked
/// read-only (or a wrong `readOnlyHint`) never makes `invoke_service` a read:
///   1. a destructive verb in the name, or `destructiveHint` → destructive;
///   2. `readOnlyHint` → read;
///   3. a write verb in the name → write;
///   4. a server marked read-only in Settings → read;
///   5. otherwise write.
fn risk_from(name: &str, read_only: bool, annotations: Option<&Value>) -> Risk {
  let hint = |k: &str| annotations.and_then(|a| a.get(k)).and_then(Value::as_bool) == Some(true);
  let words = words(name);
  let has = |verbs: &[&str]| words.iter().any(|w| verbs.contains(&w.as_str()));
  if has(DESTRUCTIVE_VERBS) || hint("destructiveHint") {
    Risk::Destructive
  } else if hint("readOnlyHint") {
    Risk::Read
  } else if has(WRITE_VERBS) {
    Risk::Write
  } else if read_only {
    Risk::Read
  } else {
    Risk::Write
  }
}

/// A `tools/call` result as text; `isError` becomes an error.
fn flatten_result(result: &Value) -> Result<String> {
  let mut parts: Vec<String> = Vec::new();
  let mut has_text = false;
  for item in result.get("content").and_then(Value::as_array).into_iter().flatten() {
    let field = |k: &str| item.get(k).and_then(Value::as_str);
    match field("type").unwrap_or_default() {
      "text" => {
        has_text = true;
        parts.push(field("text").unwrap_or_default().to_string());
      }
      "image" => parts.push("[image omitted]".into()),
      "audio" => parts.push("[audio omitted]".into()),
      "resource" => {
        let res = item.get("resource");
        let text = res.and_then(|r| r.get("text")).and_then(Value::as_str);
        let uri = res.and_then(|r| r.get("uri")).and_then(Value::as_str);
        if let Some(t) = text.or(uri) {
          has_text = true;
          parts.push(t.to_string());
        }
      }
      "resource_link" => {
        if let Some(uri) = field("uri") {
          has_text = true;
          parts.push(uri.to_string());
        }
      }
      _ => {}
    }
  }
  if !has_text {
    if let Some(s) = result.get("structuredContent").filter(|s| !s.is_null()) {
      parts.push(serde_json::to_string_pretty(s).unwrap_or_default());
    }
  }
  let text = parts.join("\n");
  if result.get("isError").and_then(Value::as_bool) == Some(true) {
    return Err(CoreError::Invalid(if text.is_empty() { "The tool reported an error.".into() } else { text }));
  }
  Ok(text)
}

// ---- JSON-RPC helpers --------------------------------------------------------

/// The `result` of a response, or its error.
fn rpc_result(msg: &Value) -> Result<Value> {
  if let Some(err) = msg.get("error") {
    let code = err.get("code").and_then(Value::as_i64).unwrap_or(0);
    let message = err.get("message").and_then(Value::as_str).unwrap_or("unknown error");
    return Err(invalid(format!("MCP error {code}: {message}")));
  }
  Ok(msg.get("result").cloned().unwrap_or(Value::Null))
}

fn is_response(msg: &Value, id: u64) -> bool {
  msg.get("method").is_none() && msg.get("id").and_then(Value::as_u64) == Some(id)
}

/// Every JSON-RPC message in an SSE body. Unless `done`, only events closed by a
/// blank line count, since the last one may still be arriving.
fn sse_messages(body: &str, done: bool) -> Vec<Value> {
  let body = body.replace("\r\n", "\n");
  let mut events: Vec<&str> = body.split("\n\n").collect();
  if !done {
    events.pop();
  }
  let mut out = Vec::new();
  for event in events {
    let data: Vec<&str> = event.lines().filter_map(|l| l.strip_prefix("data:")).map(|d| d.strip_prefix(' ').unwrap_or(d)).collect();
    if data.is_empty() {
      continue;
    }
    match serde_json::from_str::<Value>(&data.join("\n")) {
      Ok(Value::Array(items)) => out.extend(items),
      Ok(one) => out.push(one),
      Err(_) => {}
    }
  }
  out
}

/// The response with `id` in an SSE body (see [`sse_messages`]).
#[cfg(test)]
fn sse_find(body: &str, id: u64, done: bool) -> Option<Value> {
  sse_messages(body, done).into_iter().find(|m| is_response(m, id))
}

fn clip(s: &str, max: usize) -> String {
  if s.chars().count() <= max { s.to_string() } else { format!("{}...", s.chars().take(max).collect::<String>()) }
}

// ---- stdio transport ---------------------------------------------------------

type Pending = StdMutex<HashMap<u64, oneshot::Sender<std::result::Result<Value, String>>>>;

struct StdioShared {
  stdin: Mutex<ChildStdin>,
  pending: Pending,
  alive: AtomicBool,
  stale: AtomicBool,
  stderr: StdMutex<VecDeque<String>>,
  handler: Handler,
}

impl StdioShared {
  fn tail(&self) -> String {
    let lines = self.stderr.lock().unwrap_or_else(|e| e.into_inner());
    lines.iter().cloned().collect::<Vec<_>>().join("\n")
  }

  async fn send(&self, msg: &Value) -> Result<()> {
    let mut line = msg.to_string();
    line.push('\n');
    let mut stdin = self.stdin.lock().await;
    stdin.write_all(line.as_bytes()).await?;
    stdin.flush().await?;
    Ok(())
  }
}

pub(super) struct StdioConn {
  shared: Arc<StdioShared>,
  child: StdMutex<Option<Child>>,
  pid: Option<u32>,
  next_id: AtomicU64,
}

#[cfg(windows)]
fn resolve_windows(command: &str, cwd: &str) -> Option<PathBuf> {
  let pathext = std::env::var("PATHEXT").unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".into());
  let exts: Vec<String> = pathext.split(';').filter(|e| !e.is_empty()).map(str::to_lowercase).collect();
  let has_ext = std::path::Path::new(command).extension().is_some();
  let probe = |base: PathBuf| -> Option<PathBuf> {
    if has_ext && base.is_file() {
      return Some(base);
    }
    exts.iter().find_map(|e| {
      let mut s = base.clone().into_os_string();
      s.push(e);
      let c = PathBuf::from(s);
      c.is_file().then_some(c)
    })
  };
  if command.contains(['/', '\\']) || std::path::Path::new(command).is_absolute() {
    let p = PathBuf::from(command);
    let p = if p.is_absolute() || cwd.is_empty() { p } else { PathBuf::from(cwd).join(p) };
    return probe(p);
  }
  std::env::var_os("PATH").and_then(|path| std::env::split_paths(&path).find_map(|dir| probe(dir.join(command))))
}

/// `"..."`, for a `cmd.exe /s /c "<line>"` command line.
fn quote_cmd(s: &str) -> String {
  format!("\"{}\"", s.replace('"', "\\\""))
}

fn build_command(cfg: &McpServerConfig) -> Command {
  #[cfg(windows)]
  let mut cmd = {
    let program = resolve_windows(&cfg.command, &cfg.cwd).unwrap_or_else(|| PathBuf::from(&cfg.command));
    let ext = program.extension().and_then(|e| e.to_str()).unwrap_or_default().to_lowercase();
    if ext == "cmd" || ext == "bat" {
      // Batch files (npx, ...) only run through cmd.exe.
      let mut line = quote_cmd(&program.to_string_lossy());
      for a in &cfg.args {
        line.push(' ');
        line.push_str(&quote_cmd(a));
      }
      let mut c = Command::new("cmd.exe");
      c.raw_arg(format!("/d /s /c \"{line}\""));
      c
    } else {
      let mut c = Command::new(program);
      c.args(&cfg.args);
      c
    }
  };
  #[cfg(not(windows))]
  let mut cmd = {
    let mut c = Command::new(&cfg.command);
    c.args(&cfg.args);
    c
  };
  cmd.envs(&cfg.env).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
  if !cfg.cwd.is_empty() {
    cmd.current_dir(&cfg.cwd);
  }
  #[cfg(windows)]
  cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
  cmd
}

fn kill_tree(pid: u32) {
  #[cfg(windows)]
  {
    use std::os::windows::process::CommandExt as _;
    let _ = std::process::Command::new("taskkill")
      .args(["/PID", &pid.to_string(), "/T", "/F"])
      .creation_flags(0x0800_0000)
      .stdin(Stdio::null())
      .stdout(Stdio::null())
      .stderr(Stdio::null())
      .status();
  }
  #[cfg(not(windows))]
  {
    let _ = std::process::Command::new("kill").args(["-KILL", &pid.to_string()]).status();
  }
}

impl StdioConn {
  fn spawn(cfg: &McpServerConfig, handler: Handler) -> Result<Self> {
    if cfg.command.trim().is_empty() {
      return Err(invalid("No command or url is set for this MCP server."));
    }
    let mut child = build_command(cfg).spawn().map_err(|e| {
      if e.kind() == std::io::ErrorKind::NotFound {
        invalid(format!("Could not start \"{}\": command not found.", cfg.command))
      } else {
        CoreError::Io(e)
      }
    })?;
    let pid = child.id();
    let stdin = child.stdin.take().ok_or_else(|| invalid("no stdin"))?;
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let shared = Arc::new(StdioShared {
      stdin: Mutex::new(stdin),
      pending: StdMutex::new(HashMap::new()),
      alive: AtomicBool::new(true),
      stale: AtomicBool::new(false),
      stderr: StdMutex::new(VecDeque::new()),
      handler,
    });
    if let Some(stderr) = stderr {
      let shared = shared.clone();
      tokio::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
          let mut buf = shared.stderr.lock().unwrap_or_else(|e| e.into_inner());
          if buf.len() >= STDERR_LINES {
            buf.pop_front();
          }
          buf.push_back(line.trim_end().to_string());
        }
      });
    }
    if let Some(stdout) = stdout {
      let shared = shared.clone();
      tokio::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
          let Ok(msg) = serde_json::from_str::<Value>(line.trim()) else { continue };
          Self::incoming(&shared, msg).await;
        }
        shared.alive.store(false, Ordering::SeqCst);
        tokio::time::sleep(Duration::from_millis(100)).await;
        let mut message = "The MCP server process exited.".to_string();
        let tail = shared.tail();
        if !tail.is_empty() {
          message = format!("{message}\n{tail}");
        }
        let waiting: Vec<_> = shared.pending.lock().unwrap_or_else(|e| e.into_inner()).drain().collect();
        for (_, tx) in waiting {
          let _ = tx.send(Err(message.clone()));
        }
      });
    }
    Ok(Self { shared, child: StdMutex::new(Some(child)), pid, next_id: AtomicU64::new(1) })
  }

  async fn incoming(shared: &Arc<StdioShared>, msg: Value) {
    let method = msg.get("method").and_then(Value::as_str);
    let id = msg.get("id").cloned();
    match (method, id) {
      (Some(method), Some(id)) => {
        // A request from the server; answering may wait on the user, so not on the reader.
        let method = method.to_string();
        let params = msg.get("params").cloned().unwrap_or(Value::Null);
        let shared = shared.clone();
        tokio::spawn(async move {
          let reply = shared.handler.respond(id, &method, params).await;
          let _ = shared.send(&reply).await;
        });
      }
      (Some("notifications/tools/list_changed"), None) => shared.stale.store(true, Ordering::SeqCst),
      (Some(_), None) => {}
      (None, Some(id)) => {
        if let Some(id) = id.as_u64() {
          let tx = shared.pending.lock().unwrap_or_else(|e| e.into_inner()).remove(&id);
          if let Some(tx) = tx {
            let _ = tx.send(Ok(msg));
          }
        }
      }
      (None, None) => {}
    }
  }

  async fn request(&self, method: &str, params: Value, timeout: Duration) -> Result<Value> {
    let id = self.next_id.fetch_add(1, Ordering::SeqCst);
    let (tx, rx) = oneshot::channel();
    self.shared.pending.lock().unwrap_or_else(|e| e.into_inner()).insert(id, tx);
    if !self.shared.alive.load(Ordering::SeqCst) {
      self.shared.pending.lock().unwrap_or_else(|e| e.into_inner()).remove(&id);
      return Err(invalid(self.death()));
    }
    if let Err(e) = self.shared.send(&json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params })).await {
      self.shared.pending.lock().unwrap_or_else(|e| e.into_inner()).remove(&id);
      return Err(invalid(format!("{e}\n{}", self.death())));
    }
    match tokio::time::timeout(timeout, rx).await {
      Ok(Ok(Ok(msg))) => rpc_result(&msg),
      Ok(Ok(Err(message))) => Err(invalid(message)),
      Ok(Err(_)) => Err(invalid(self.death())),
      Err(_) => {
        self.shared.pending.lock().unwrap_or_else(|e| e.into_inner()).remove(&id);
        Err(invalid(format!("\"{method}\" timed out after {}s.", timeout.as_secs())))
      }
    }
  }

  async fn notify(&self, method: &str, params: Value) -> Result<()> {
    self.shared.send(&json!({ "jsonrpc": "2.0", "method": method, "params": params })).await
  }

  fn death(&self) -> String {
    let tail = self.shared.tail();
    if tail.is_empty() { "The MCP server process is not running.".into() } else { format!("The MCP server process is not running.\n{tail}") }
  }

  fn kill(&self) {
    self.shared.alive.store(false, Ordering::SeqCst);
    let child = self.child.lock().unwrap_or_else(|e| e.into_inner()).take();
    if let Some(mut child) = child {
      if let Some(pid) = self.pid {
        kill_tree(pid);
      }
      let _ = child.start_kill();
    }
  }
}

impl Drop for StdioConn {
  fn drop(&mut self) {
    self.kill();
  }
}

// ---- streamable HTTP transport -----------------------------------------------

pub(super) struct HttpConn {
  client: reqwest::Client,
  url: String,
  headers: Vec<(String, String)>,
  session: StdMutex<Option<String>>,
  protocol: StdMutex<Option<String>>,
  next_id: AtomicU64,
  stale: AtomicBool,
  handler: Handler,
}

impl HttpConn {
  fn new(cfg: &McpServerConfig, handler: Handler) -> Result<Self> {
    let client = reqwest::Client::builder().connect_timeout(Duration::from_secs(15)).build().map_err(|e| invalid(e.to_string()))?;
    Ok(Self {
      client,
      url: cfg.url.clone(),
      headers: cfg.headers.iter().map(|(k, v)| (k.clone(), v.clone())).collect(),
      session: StdMutex::new(None),
      protocol: StdMutex::new(None),
      next_id: AtomicU64::new(1),
      stale: AtomicBool::new(false),
      handler,
    })
  }

  async fn post(&self, body: &Value) -> Result<reqwest::Response> {
    let mut req = self
      .client
      .post(&self.url)
      .header("Accept", "application/json, text/event-stream")
      .header("Content-Type", "application/json");
    for (k, v) in &self.headers {
      req = req.header(k.as_str(), v.as_str());
    }
    if let Some(s) = self.session.lock().unwrap_or_else(|e| e.into_inner()).clone() {
      req = req.header("Mcp-Session-Id", s);
    }
    if let Some(p) = self.protocol.lock().unwrap_or_else(|e| e.into_inner()).clone() {
      req = req.header("MCP-Protocol-Version", p);
    }
    let resp = req.body(body.to_string()).send().await.map_err(|e| invalid(format!("Could not reach {}: {e}", self.url)))?;
    if !resp.status().is_success() {
      let status = resp.status();
      let text = resp.text().await.unwrap_or_default();
      return Err(invalid(format!("HTTP {status}: {}", clip(text.trim(), 500))));
    }
    Ok(resp)
  }

  fn note(&self, msg: &Value) {
    if msg.get("method").and_then(Value::as_str) == Some("notifications/tools/list_changed") {
      self.stale.store(true, Ordering::SeqCst);
    }
  }

  /// A message from the server inside a response stream: answers a request
  /// (once), notes a notification.
  fn serve(&self, msg: &Value, replies: &mpsc::UnboundedSender<Value>, answered: &mut HashSet<String>) {
    let method = msg.get("method").and_then(Value::as_str);
    match (method, msg.get("id")) {
      (Some(method), Some(id)) => {
        if !answered.insert(id.to_string()) {
          return;
        }
        let (handler, method, id) = (self.handler.clone(), method.to_string(), id.clone());
        let params = msg.get("params").cloned().unwrap_or(Value::Null);
        let tx = replies.clone();
        tokio::spawn(async move {
          let _ = tx.send(handler.respond(id, &method, params).await);
        });
      }
      (Some(_), None) => self.note(msg),
      _ => {}
    }
  }

  async fn exchange(&self, body: Value, id: u64, is_init: bool) -> Result<Value> {
    let mut resp = self.post(&body).await?;
    if is_init {
      if let Some(s) = resp.headers().get("mcp-session-id").and_then(|v| v.to_str().ok()) {
        *self.session.lock().unwrap_or_else(|e| e.into_inner()) = Some(s.to_string());
      }
    }
    let sse = resp
      .headers()
      .get("content-type")
      .and_then(|v| v.to_str().ok())
      .is_some_and(|v| v.to_ascii_lowercase().contains("text/event-stream"));
    if sse {
      // Requests from the server (elicitation, sampling...) arrive in this stream;
      // their answers go back as separate POSTs while the stream stays open.
      let (tx, mut replies) = mpsc::unbounded_channel::<Value>();
      let mut answered: HashSet<String> = HashSet::new();
      let mut raw: Vec<u8> = Vec::new();
      let mut open = true;
      loop {
        tokio::select! {
          chunk = resp.chunk(), if open => {
            match chunk.map_err(|e| invalid(format!("Stream failed: {e}")))? {
              Some(chunk) => raw.extend_from_slice(&chunk),
              None => open = false,
            }
            let buf = String::from_utf8_lossy(&raw).into_owned();
            for msg in sse_messages(&buf, !open) {
              if is_response(&msg, id) {
                return rpc_result(&msg);
              }
              self.serve(&msg, &tx, &mut answered);
            }
            if !open {
              return Err(invalid("The server's event stream ended without a response."));
            }
          }
          Some(reply) = replies.recv() => {
            if let Err(e) = self.post(&reply).await {
              super::super::log_warn(&format!("assistant MCP: could not answer a server request: {e}"));
            }
          }
        }
      }
    }
    let bytes = resp.bytes().await.map_err(|e| invalid(e.to_string()))?;
    let value: Value = serde_json::from_slice(&bytes).map_err(|e| invalid(format!("Bad JSON reply: {e}")))?;
    let items = match value {
      Value::Array(items) => items,
      one => vec![one],
    };
    for m in &items {
      self.note(m);
    }
    match items.iter().find(|m| is_response(m, id)) {
      Some(m) => rpc_result(m),
      None => Err(invalid("The server's reply had no matching response.")),
    }
  }

  async fn request(&self, method: &str, params: Value, timeout: Duration) -> Result<Value> {
    let id = self.next_id.fetch_add(1, Ordering::SeqCst);
    let body = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
    match tokio::time::timeout(timeout, self.exchange(body, id, method == "initialize")).await {
      Ok(r) => r,
      Err(_) => Err(invalid(format!("\"{method}\" timed out after {}s.", timeout.as_secs()))),
    }
  }

  async fn notify(&self, method: &str, params: Value) -> Result<()> {
    self.post(&json!({ "jsonrpc": "2.0", "method": method, "params": params })).await.map(|_| ())
  }
}

// ---- connection --------------------------------------------------------------

pub(super) enum Conn {
  Stdio(StdioConn),
  Http(HttpConn),
}

impl Conn {
  pub(super) async fn request(&self, method: &str, params: Value, timeout: Duration) -> Result<Value> {
    match self {
      Conn::Stdio(c) => c.request(method, params, timeout).await,
      Conn::Http(c) => c.request(method, params, timeout).await,
    }
  }

  async fn notify(&self, method: &str, params: Value) -> Result<()> {
    match self {
      Conn::Stdio(c) => c.notify(method, params).await,
      Conn::Http(c) => c.notify(method, params).await,
    }
  }

  fn alive(&self) -> bool {
    match self {
      Conn::Stdio(c) => c.shared.alive.load(Ordering::SeqCst),
      Conn::Http(_) => true,
    }
  }

  fn take_stale(&self) -> bool {
    match self {
      Conn::Stdio(c) => c.shared.stale.swap(false, Ordering::SeqCst),
      Conn::Http(c) => c.stale.swap(false, Ordering::SeqCst),
    }
  }

  fn death(&self) -> String {
    match self {
      Conn::Stdio(c) => c.death(),
      Conn::Http(_) => "Connection lost.".into(),
    }
  }

  fn close(&self) {
    if let Conn::Stdio(c) = self {
      c.kill();
    }
  }

  /// `initialize`, `notifications/initialized`. Returns what the server can do.
  async fn handshake(&self) -> Result<Value> {
    let params = json!({
      "protocolVersion": PROTOCOL,
      "capabilities": { "roots": { "listChanged": true }, "sampling": {}, "elicitation": {} },
      "clientInfo": { "name": "singl", "version": env!("CARGO_PKG_VERSION") },
    });
    let result = self.request("initialize", params, START_TIMEOUT).await?;
    if let Conn::Http(h) = self {
      let version = result.get("protocolVersion").and_then(Value::as_str).unwrap_or(PROTOCOL).to_string();
      *h.protocol.lock().unwrap_or_else(|e| e.into_inner()) = Some(version);
    }
    self.notify("notifications/initialized", json!({})).await?;
    Ok(result.get("capabilities").cloned().unwrap_or_else(|| json!({})))
  }

  /// Every item of a paginated list (`tools/list`, `resources/list`...) under
  /// `key`, following `nextCursor`.
  pub(super) async fn list_paged(&self, method: &str, key: &str) -> Result<Vec<Value>> {
    let mut items = Vec::new();
    let mut cursor: Option<String> = None;
    for _ in 0..50 {
      let params = match &cursor {
        Some(c) => json!({ "cursor": c }),
        None => json!({}),
      };
      let result = self.request(method, params, LIST_TIMEOUT).await?;
      items.extend(result.get(key).and_then(Value::as_array).cloned().unwrap_or_default());
      cursor = result.get("nextCursor").and_then(Value::as_str).filter(|c| !c.is_empty()).map(String::from);
      if cursor.is_none() {
        break;
      }
    }
    Ok(items)
  }

  async fn list_tools(&self) -> Result<Vec<Value>> {
    self.list_paged("tools/list", "tools").await
  }
}

#[derive(Clone)]
pub(super) struct ToolEntry {
  original: String,
  spec: ToolSpec,
}

/// Whether a tool is offered: not switched off, and on a read-only server only reads.
fn visible(cfg: &McpServerConfig, tool: &ToolEntry) -> bool {
  !cfg.disabled_tools.iter().any(|d| *d == tool.original) && (!cfg.read_only || tool.spec.risk == Risk::Read)
}

/// Whether a changed config needs a new connection; the tool filter does not.
fn needs_restart(old: &McpServerConfig, new: &McpServerConfig) -> bool {
  let mut old = old.clone();
  old.disabled_tools = new.disabled_tools.clone();
  old != *new
}

/// One tool of a running server as Settings lists it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpToolInfo {
  pub server: String,
  /// The name the assistant sees (`<server>__<tool>`).
  pub name: String,
  /// The server's own name for it; what `disabledTools` holds.
  pub original: String,
  pub description: String,
  pub risk: Risk,
  /// Switched off in Settings.
  pub disabled: bool,
  /// Not offered because the server is read-only and this tool is not a read.
  pub hidden: bool,
}

fn build_tools(cfg: &McpServerConfig, raw: &[Value]) -> Vec<ToolEntry> {
  let mut used = HashSet::new();
  let mut out = Vec::new();
  for t in raw {
    let Some(original) = t.get("name").and_then(Value::as_str) else { continue };
    let exposed = expose_name(&cfg.name, original, &used);
    used.insert(exposed.clone());
    let description = t.get("description").and_then(Value::as_str).unwrap_or_default();
    out.push(ToolEntry {
      original: original.to_string(),
      spec: ToolSpec {
        name: exposed,
        description: format!("[{}] {description}", cfg.name),
        input_schema: t.get("inputSchema").cloned().unwrap_or_else(|| json!({ "type": "object" })),
        risk: risk_from(original, cfg.read_only, t.get("annotations")),
        external_only: false,
      },
    });
  }
  out
}

/// Starts a server and lists its tools; also returns its capabilities. A failed start kills the process.
async fn connect(cfg: &McpServerConfig, handler: &Handler) -> Result<(Arc<Conn>, Vec<ToolEntry>, Value)> {
  let conn = Arc::new(if cfg.url.trim().is_empty() {
    Conn::Stdio(StdioConn::spawn(cfg, handler.clone())?)
  } else {
    Conn::Http(HttpConn::new(cfg, handler.clone())?)
  });
  let result = async {
    let caps = conn.handshake().await?;
    let tools = match conn.list_tools().await {
      Ok(tools) => tools,
      // A server with only resources or prompts may not know the method.
      Err(_) if caps.get("tools").is_none() => Vec::new(),
      Err(e) => return Err(e),
    };
    Ok::<_, CoreError>((tools, caps))
  }
  .await;
  match result {
    Ok((raw, caps)) => Ok((conn.clone(), build_tools(cfg, &raw), caps)),
    Err(e) => {
      let message = if conn.alive() { e.to_string() } else { format!("{e}\n{}", conn.death()) };
      conn.close();
      Err(invalid(message))
    }
  }
}

// ---- lifecycle ---------------------------------------------------------------

struct Info {
  config: McpServerConfig,
  state: &'static str,
  error: Option<String>,
  tools: Arc<Vec<ToolEntry>>,
  conn: Option<Arc<Conn>>,
  failed_at: Option<Instant>,
  /// What the server said it can do (`initialize`).
  caps: Value,
}

impl Info {
  fn new(config: McpServerConfig) -> Self {
    Self { config, state: "stopped", error: None, tools: Arc::new(Vec::new()), conn: None, failed_at: None, caps: Value::Null }
  }

  /// Back to stopped; returns the connection to close.
  fn reset(&mut self) -> Option<Arc<Conn>> {
    self.state = "stopped";
    self.error = None;
    self.tools = Arc::new(Vec::new());
    self.failed_at = None;
    self.caps = Value::Null;
    self.conn.take()
  }

  fn fail(&mut self, message: String) -> Option<Arc<Conn>> {
    self.state = "error";
    self.error = Some(message);
    self.tools = Arc::new(Vec::new());
    self.failed_at = Some(Instant::now());
    self.conn.take()
  }
}

struct Slot {
  /// Serializes start / stop / refresh of this server.
  gate: Mutex<()>,
  info: StdMutex<Info>,
  handler: Handler,
}

impl Slot {
  fn info(&self) -> std::sync::MutexGuard<'_, Info> {
    self.info.lock().unwrap_or_else(|e| e.into_inner())
  }

  fn close(conn: Option<Arc<Conn>>) {
    if let Some(c) = conn {
      c.close();
    }
  }

  async fn ensure(&self, cfg: McpServerConfig) {
    let _gate = self.gate.lock().await;
    let old = {
      let mut info = self.info();
      if needs_restart(&info.config, &cfg) {
        let old = info.reset();
        info.config = cfg.clone();
        old
      } else {
        info.config = cfg.clone();
        None
      }
    };
    Self::close(old);

    if !cfg.enabled {
      let old = self.info().reset();
      Self::close(old);
      return;
    }

    let conn = self.info().conn.clone();
    if let Some(conn) = conn {
      if !conn.alive() {
        let old = self.info().fail(conn.death());
        Self::close(old);
      } else {
        if conn.take_stale() {
          match tokio::time::timeout(LIST_TIMEOUT, conn.list_tools()).await {
            Ok(Ok(raw)) => self.info().tools = Arc::new(build_tools(&cfg, &raw)),
            Ok(Err(e)) => super::super::log_warn(&format!("assistant MCP: refreshing {} failed: {e}", cfg.name)),
            Err(_) => super::super::log_warn(&format!("assistant MCP: refreshing {} timed out", cfg.name)),
          }
        }
        return;
      }
    }

    {
      let mut info = self.info();
      if info.failed_at.is_some_and(|t| t.elapsed() < RETRY_AFTER) {
        return;
      }
      info.state = "starting";
      info.error = None;
    }
    match tokio::time::timeout(START_TIMEOUT, connect(&cfg, &self.handler)).await {
      Ok(Ok((conn, tools, caps))) => {
        let mut info = self.info();
        info.state = "running";
        info.tools = Arc::new(tools);
        info.caps = caps;
        info.conn = Some(conn);
        info.failed_at = None;
      }
      Ok(Err(e)) => {
        super::super::log_warn(&format!("assistant MCP: {} failed to start: {e}", cfg.name));
        let old = self.info().fail(e.to_string());
        Self::close(old);
      }
      Err(_) => {
        let old = self.info().fail(format!("Timed out after {}s starting the server.", START_TIMEOUT.as_secs()));
        Self::close(old);
      }
    }
  }

  async fn stop(&self) {
    let _gate = self.gate.lock().await;
    let old = self.info().reset();
    Self::close(old);
  }
}

#[derive(Default)]
pub struct McpClients {
  slots: StdMutex<HashMap<String, Arc<Slot>>>,
  /// The assistant, for requests a server makes of us (roots, elicitation, sampling).
  host: StdMutex<Weak<Assistant>>,
  /// Hash of the roots the servers last heard of.
  roots_seen: StdMutex<Option<u64>>,
}

impl McpClients {
  pub(crate) fn set_host(&self, host: Weak<Assistant>) {
    *self.host.lock().unwrap_or_else(|e| e.into_inner()) = host;
  }

  /// Tells running servers when the roots changed since the last call.
  pub async fn sync_roots(&self, roots: &[Value]) {
    let mut h = std::collections::hash_map::DefaultHasher::new();
    roots.iter().for_each(|r| r.to_string().hash(&mut h));
    let hash = h.finish();
    let changed = self.roots_seen.lock().unwrap_or_else(|e| e.into_inner()).replace(hash).is_some_and(|old| old != hash);
    if !changed {
      return;
    }
    for (_, slot) in self.slots() {
      let conn = slot.info().conn.clone();
      if let Some(conn) = conn {
        let _ = conn.notify("notifications/roots/list_changed", json!({})).await;
      }
    }
  }

  /// The live connection and capabilities of a running server.
  pub(super) fn conn_for(&self, server: &str) -> Result<(Arc<Conn>, Value)> {
    let slot = self.slots.lock().unwrap_or_else(|e| e.into_inner()).get(server).cloned();
    let info = slot.as_ref().map(|s| s.info());
    match info.as_ref().and_then(|i| i.conn.clone().map(|c| (c, i.caps.clone()))) {
      Some(found) => Ok(found),
      None => Err(invalid(format!("MCP server \"{server}\" is not running."))),
    }
  }

  fn slots(&self) -> Vec<(String, Arc<Slot>)> {
    self.slots.lock().unwrap_or_else(|e| e.into_inner()).iter().map(|(k, v)| (k.clone(), v.clone())).collect()
  }

  /// Starts what is enabled and not running, stops what was removed, disabled
  /// or changed, and returns every running server's tools.
  pub async fn tools(&self, servers: &[McpServerConfig]) -> Vec<ToolSpec> {
    let removed: Vec<Arc<Slot>> = {
      let mut map = self.slots.lock().unwrap_or_else(|e| e.into_inner());
      let gone: Vec<String> = map.keys().filter(|k| !servers.iter().any(|s| &s.name == *k)).cloned().collect();
      gone.iter().filter_map(|k| map.remove(k)).collect()
    };
    for slot in removed {
      slot.stop().await;
    }

    let mut handles = Vec::new();
    for cfg in servers {
      let slot = {
        let mut map = self.slots.lock().unwrap_or_else(|e| e.into_inner());
        map
          .entry(cfg.name.clone())
          .or_insert_with(|| {
            let host = self.host.lock().unwrap_or_else(|e| e.into_inner()).clone();
            Arc::new(Slot { gate: Mutex::new(()), info: StdMutex::new(Info::new(cfg.clone())), handler: Handler::new(host, &cfg.name) })
          })
          .clone()
      };
      let cfg = cfg.clone();
      handles.push(tokio::spawn(async move {
        slot.ensure(cfg.clone()).await;
        let info = slot.info();
        if info.state == "running" { Some((cfg, info.tools.clone())) } else { None }
      }));
    }
    let mut specs = Vec::new();
    for h in handles {
      if let Ok(Some((cfg, tools))) = h.await {
        specs.extend(tools.iter().filter(|t| visible(&cfg, t)).map(|t| t.spec.clone()));
      }
    }
    specs
  }

  /// Every tool of every running server, including the ones switched off or hidden.
  pub async fn server_tools(&self, servers: &[McpServerConfig]) -> Vec<McpToolInfo> {
    let mut out = Vec::new();
    for cfg in servers.iter().filter(|s| s.enabled) {
      let slot = self.slots.lock().unwrap_or_else(|e| e.into_inner()).get(&cfg.name).cloned();
      let Some(slot) = slot else { continue };
      let info = slot.info();
      if info.state != "running" {
        continue;
      }
      for t in info.tools.iter() {
        let description = t.spec.description.split_once("] ").map(|(_, d)| d).unwrap_or(&t.spec.description);
        out.push(McpToolInfo {
          server: cfg.name.clone(),
          name: t.spec.name.clone(),
          original: t.original.clone(),
          description: description.to_string(),
          risk: t.spec.risk,
          disabled: cfg.disabled_tools.iter().any(|d| *d == t.original),
          hidden: cfg.read_only && t.spec.risk != Risk::Read,
        });
      }
    }
    out
  }

  fn find(&self, name: &str) -> Option<(Arc<Slot>, ToolEntry, Option<Arc<Conn>>, McpServerConfig)> {
    for (_, slot) in self.slots() {
      let info = slot.info();
      if let Some(t) = info.tools.iter().find(|t| t.spec.name == name) {
        let found = (t.clone(), info.conn.clone(), info.config.clone());
        drop(info);
        return Some((slot, found.0, found.1, found.2));
      }
    }
    None
  }

  /// The risk of a prefixed tool: from the server's config and the tool's annotations.
  pub async fn risk_for(&self, _servers: &[McpServerConfig], prefixed: &str) -> Risk {
    if let Some((_, tool, _, _)) = self.find(prefixed) {
      // Rated when listed; changing a server in Settings restarts and re-lists it.
      return tool.spec.risk;
    }
    // Unknown tool: rate by name alone, never as a read.
    let name = prefixed.split("__").nth(1).unwrap_or(prefixed);
    risk_from(name, false, None)
  }

  pub async fn call(&self, servers: &[McpServerConfig], name: &str, args: Value, timeout: Duration) -> Result<String> {
    self.call_in(servers, name, args, timeout, None).await
  }

  /// [`Self::call`] for a tool call made in chat `chat_id`, so a question the
  /// server asks meanwhile (elicitation, sampling) shows up there. Logged.
  pub async fn call_in(&self, servers: &[McpServerConfig], name: &str, args: Value, timeout: Duration, chat_id: Option<&str>) -> Result<String> {
    let unknown = || invalid(format!("Unknown tool \"{name}\"."));
    let (slot, tool, conn, cfg) = self.find(name).ok_or_else(unknown)?;
    let live = servers.iter().find(|s| s.name == cfg.name && s.enabled).ok_or_else(unknown)?;
    if !visible(live, &tool) {
      return Err(invalid(format!("{name} is switched off in Settings.")));
    }
    let conn = conn.ok_or_else(|| invalid(format!("MCP server \"{}\" is not running.", cfg.name)))?;
    let args = if args.is_null() { json!({}) } else { args };
    let logged = LoggedCall::start("tool", &cfg.name, &tool.original, &args);
    *slot.handler.chat.lock().unwrap_or_else(|e| e.into_inner()) = chat_id.map(String::from);
    let result = conn.request("tools/call", json!({ "name": tool.original, "arguments": args }), timeout).await;
    *slot.handler.chat.lock().unwrap_or_else(|e| e.into_inner()) = None;
    let out = match result {
      Ok(v) => flatten_result(&v),
      Err(e) => {
        if !conn.alive() {
          let mut info = slot.info();
          if info.conn.as_ref().is_some_and(|c| Arc::ptr_eq(c, &conn)) {
            let old = info.fail(conn.death());
            drop(info);
            Slot::close(old);
          }
        }
        Err(e)
      }
    };
    logged.finish(out)
  }

  pub async fn status(&self, servers: &[McpServerConfig]) -> Vec<McpServerStatus> {
    let map = self.slots.lock().unwrap_or_else(|e| e.into_inner());
    servers
      .iter()
      .map(|s| {
        let (state, error, tool_count) = match map.get(&s.name).filter(|_| s.enabled) {
          Some(slot) => {
            let i = slot.info();
            (i.state, i.error.clone(), i.tools.len())
          }
          None => ("stopped", None, 0),
        };
        McpServerStatus {
          name: s.name.clone(),
          source: s.source.clone(),
          enabled: s.enabled,
          state: state.into(),
          error,
          tool_count,
          http: !s.url.is_empty(),
          signed_in: s.signed_in,
        }
      })
      .collect()
  }

  /// Stops one server and clears its failure, so the next `tools` starts it again.
  pub async fn restart(&self, name: &str) {
    let slot = self.slots.lock().unwrap_or_else(|e| e.into_inner()).get(name).cloned();
    if let Some(slot) = slot {
      slot.stop().await;
    }
  }

  pub async fn shutdown_all(&self) {
    let all: Vec<Arc<Slot>> = self.slots.lock().unwrap_or_else(|e| e.into_inner()).drain().map(|(_, s)| s).collect();
    for slot in all {
      slot.stop().await;
    }
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::assistant::Assistant;
  use crate::assistant::mcp::http;
  use crate::workspace::Workspace;
  use std::sync::RwLock;
  use tokio_util::sync::CancellationToken;

  #[test]
  fn names_are_sanitized_and_bounded() {
    let used = HashSet::new();
    assert_eq!(expose_name("srv", "read file.v2", &used), "srv__read_file_v2");
    let long = "a".repeat(100);
    let n = expose_name("srv", &long, &used);
    assert!(n.len() <= 64, "{n}");
    assert!(n.starts_with("srv__aaaa"));
  }

  #[test]
  fn colliding_names_get_unique_suffixes() {
    let raw: Vec<Value> = ["a.b", "a b", "a_b"].iter().map(|n| json!({ "name": n })).collect();
    let cfg = McpServerConfig { name: "s".into(), enabled: true, ..Default::default() };
    let tools = build_tools(&cfg, &raw);
    let names: HashSet<_> = tools.iter().map(|t| t.spec.name.clone()).collect();
    assert_eq!(names.len(), 3);
    assert!(names.iter().all(|n| n.len() <= 64));
    assert_eq!(tools[1].original, "a b");
    let long: Vec<Value> = ["x".repeat(80), format!("{}y", "x".repeat(80))].iter().map(|n| json!({ "name": n })).collect();
    let names: HashSet<_> = build_tools(&cfg, &long).iter().map(|t| t.spec.name.clone()).collect();
    assert_eq!(names.len(), 2);
  }

  #[test]
  fn risk_mapping() {
    assert_eq!(risk_from("list_things", true, Some(&json!({ "destructiveHint": true }))), Risk::Destructive);
    assert_eq!(risk_from("list_things", false, Some(&json!({ "readOnlyHint": true }))), Risk::Read);
    assert_eq!(risk_from("list_things", false, Some(&json!({ "destructiveHint": true }))), Risk::Destructive);
    assert_eq!(risk_from("list_things", false, Some(&json!({ "readOnlyHint": false }))), Risk::Write);
    assert_eq!(risk_from("list_things", false, None), Risk::Write);
    assert_eq!(risk_from("list_things", true, None), Risk::Read);
    // The name wins over a read-only server and a wrong hint.
    assert_eq!(risk_from("twx_invoke_service", true, Some(&json!({ "readOnlyHint": true }))), Risk::Destructive);
    assert_eq!(risk_from("InvokeService", true, None), Risk::Destructive);
    assert_eq!(risk_from("update_entity", true, None), Risk::Write);
    assert_eq!(risk_from("get_settings", true, None), Risk::Read);
  }

  #[test]
  fn sse_picks_the_matching_response() {
    let body = "event: message\ndata: {\"jsonrpc\":\"2.0\",\"method\":\"notifications/progress\"}\n\nevent: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":7,\"result\":{\"ok\":true}}\n\n";
    let msg = sse_find(body, 7, false).unwrap();
    assert_eq!(msg["result"]["ok"], true);
    assert!(sse_find(body, 8, true).is_none());
    // An event still arriving is not complete.
    let partial = "data: {\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{}}";
    assert!(sse_find(partial, 1, false).is_none());
    assert!(sse_find(partial, 1, true).is_some());
    assert!(sse_find("data: {\"jsonrpc\":\"2.0\",\r\ndata: \"id\":1,\"result\":{}}\r\n\r\n", 1, false).is_some());
  }

  #[test]
  fn content_is_flattened() {
    let r = json!({ "content": [
      { "type": "text", "text": "one" },
      { "type": "image", "data": "xx", "mimeType": "image/png" },
      { "type": "resource", "resource": { "uri": "file:///a", "text": "body" } },
      { "type": "resource", "resource": { "uri": "file:///b" } },
    ]});
    assert_eq!(flatten_result(&r).unwrap(), "one\n[image omitted]\nbody\nfile:///b");
    let s = json!({ "content": [], "structuredContent": { "n": 1 } });
    assert!(flatten_result(&s).unwrap().contains("\"n\": 1"));
    let e = json!({ "content": [{ "type": "text", "text": "boom" }], "isError": true });
    assert_eq!(flatten_result(&e).unwrap_err().to_string(), "boom");
  }

  #[test]
  fn cmd_quoting() {
    assert_eq!(quote_cmd("a b"), "\"a b\"");
    assert_eq!(quote_cmd("say \"hi\""), "\"say \\\"hi\\\"\"");
  }

  #[tokio::test(flavor = "multi_thread")]
  async fn connects_to_the_apps_own_http_server() {
    let dir = tempfile::tempdir().unwrap();
    let pool = crate::db::open(&dir.path().join("singl.db")).await.unwrap();
    let assistant = Assistant::new(
      Arc::new(tokio::sync::RwLock::new(pool)),
      Arc::new(RwLock::new(Workspace::new(None))),
      Default::default(),
    );
    let cancel = CancellationToken::new();
    let port = http::serve(assistant.clone(), 0, "secret".into(), cancel.clone()).await.unwrap();
    let cfg = |token: &str| McpServerConfig {
      name: "self".into(),
      enabled: true,
      url: format!("http://127.0.0.1:{port}/mcp"),
      headers: HashMap::from([("Authorization".to_string(), format!("Bearer {token}"))]),
      source: "app".into(),
      ..Default::default()
    };

    let clients = McpClients::default();
    let servers = vec![cfg("secret")];
    let tools = clients.tools(&servers).await;
    assert!(tools.iter().any(|t| t.name == "self__get_screen_context"), "{:?}", tools.iter().map(|t| &t.name).collect::<Vec<_>>());
    let out = clients.call(&servers, "self__list_screens", json!({}), Duration::from_secs(30)).await.unwrap();
    assert!(out.contains("twx-entities"), "{out}");
    let status = clients.status(&servers).await;
    assert_eq!(status[0].state, "running");
    assert!(status[0].tool_count > 0);
    assert_eq!(clients.risk_for(&servers, "self__list_screens").await, Risk::Read);

    let bad = McpClients::default();
    let servers = vec![cfg("wrong")];
    assert!(bad.tools(&servers).await.is_empty());
    let status = bad.status(&servers).await;
    assert_eq!(status[0].state, "error");
    assert!(status[0].error.as_deref().unwrap_or_default().contains("401"), "{:?}", status[0].error);
    assert!(bad.call(&servers, "self__list_screens", json!({}), Duration::from_secs(30)).await.is_err());

    clients.shutdown_all().await;
    cancel.cancel();
  }

  /// An HTTP server that, during `tools/call`, asks `roots/list` inside its event
  /// stream and finishes only once the client POSTs the answer.
  #[tokio::test(flavor = "multi_thread")]
  async fn answers_requests_made_inside_an_event_stream() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let waiting: Arc<StdMutex<Option<oneshot::Sender<Value>>>> = Arc::new(StdMutex::new(None));
    tokio::spawn(async move {
      loop {
        let Ok((mut sock, _)) = listener.accept().await else { return };
        let waiting = waiting.clone();
        tokio::spawn(async move {
          let mut buf = Vec::new();
          let (head_end, len) = loop {
            let mut chunk = [0u8; 4096];
            let n = sock.read(&mut chunk).await.unwrap_or(0);
            if n == 0 {
              return;
            }
            buf.extend_from_slice(&chunk[..n]);
            let text = String::from_utf8_lossy(&buf).into_owned();
            if let Some(at) = text.find("\r\n\r\n") {
              let len = text[..at]
                .lines()
                .find_map(|l| l.to_ascii_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse::<usize>().unwrap_or(0)))
                .unwrap_or(0);
              break (at + 4, len);
            }
          };
          while buf.len() < head_end + len {
            let mut chunk = [0u8; 4096];
            let n = sock.read(&mut chunk).await.unwrap_or(0);
            if n == 0 {
              return;
            }
            buf.extend_from_slice(&chunk[..n]);
          }
          let msg: Value = serde_json::from_slice(&buf[head_end..head_end + len]).unwrap();
          let json_reply = |result: Value| {
            let body = json!({ "jsonrpc": "2.0", "id": msg["id"], "result": result }).to_string();
            format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len())
          };
          let accepted = "HTTP/1.1 202 Accepted\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_string();
          let reply = match msg.get("method").and_then(Value::as_str) {
            Some("initialize") => json_reply(json!({ "protocolVersion": "2025-06-18", "capabilities": { "tools": {} } })),
            Some("tools/list") => json_reply(json!({ "tools": [{ "name": "ask", "inputSchema": { "type": "object" } }] })),
            Some("tools/call") => {
              let (tx, rx) = oneshot::channel();
              *waiting.lock().unwrap() = Some(tx);
              let ask = json!({ "jsonrpc": "2.0", "id": 77, "method": "roots/list" });
              let head = format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\ndata: {ask}\n\n");
              sock.write_all(head.as_bytes()).await.unwrap();
              let answer = rx.await.unwrap();
              let done = json!({ "jsonrpc": "2.0", "id": msg["id"], "result": { "content": [{ "type": "text", "text": answer.to_string() }] } });
              sock.write_all(format!("data: {done}\n\n").as_bytes()).await.unwrap();
              return;
            }
            Some(_) => accepted,
            None => {
              if let Some(tx) = waiting.lock().unwrap().take() {
                let _ = tx.send(msg["result"].clone());
              }
              accepted
            }
          };
          let _ = sock.write_all(reply.as_bytes()).await;
        });
      }
    });

    let dir = tempfile::tempdir().unwrap();
    let pool = crate::db::open(&dir.path().join("singl.db")).await.unwrap();
    let assistant = Assistant::new(
      Arc::new(tokio::sync::RwLock::new(pool)),
      Arc::new(RwLock::new(Workspace::new(Some(dir.path().to_path_buf())))),
      Default::default(),
    );
    let servers = vec![McpServerConfig { name: "h".into(), enabled: true, url: format!("http://127.0.0.1:{port}/mcp"), ..Default::default() }];
    assert_eq!(assistant.mcp_clients.tools(&servers).await.len(), 1);
    let out = assistant.mcp_clients.call(&servers, "h__ask", json!({}), Duration::from_secs(20)).await.unwrap();
    let v: Value = serde_json::from_str(&out).unwrap();
    assert!(v["roots"][0]["uri"].as_str().unwrap().starts_with("file:///"), "{out}");
    assistant.mcp_clients.shutdown_all().await;
  }

  #[tokio::test(flavor = "multi_thread")]
  #[ignore = "needs node on PATH"]
  async fn answers_server_requests_and_lists_resources_and_prompts() {
    let script = r#"
      const rl = require('readline').createInterface({ input: process.stdin });
      const send = (o) => console.log(JSON.stringify({ jsonrpc: '2.0', ...o }));
      let callId = null, roots = null;
      rl.on('line', l => {
        const m = JSON.parse(l);
        if (m.method === undefined && m.id === 'r1') { roots = m.result; send({ id: 'r2', method: 'elicitation/create', params: { message: 'm', requestedSchema: { type: 'object', properties: {} } } }); return; }
        if (m.method === undefined && m.id === 'r2') { send({ id: callId, result: { content: [{ type: 'text', text: JSON.stringify({ roots, elicit: m.result }) }] } }); return; }
        if (m.id === undefined) return;
        let r = {};
        if (m.method === 'initialize') r = { protocolVersion: '2025-06-18', capabilities: { tools: {}, resources: {}, prompts: {} }, serverInfo: { name: 't', version: '1' } };
        else if (m.method === 'tools/list') r = { tools: [{ name: 'ask', inputSchema: { type: 'object' } }, { name: 'update_it', inputSchema: { type: 'object' } }] };
        else if (m.method === 'tools/call') { callId = m.id; send({ id: 'r1', method: 'roots/list' }); return; }
        else if (m.method === 'resources/list') r = m.params.cursor ? { resources: [{ uri: 'mem://b', name: 'b' }] } : { resources: [{ uri: 'mem://a', name: 'a' }], nextCursor: '2' };
        else if (m.method === 'resources/read') r = { contents: [{ uri: m.params.uri, mimeType: 'text/plain', text: 'body of ' + m.params.uri }] };
        else if (m.method === 'prompts/list') r = { prompts: [{ name: 'p', arguments: [{ name: 'x', required: true }] }] };
        else if (m.method === 'prompts/get') r = { messages: [{ role: 'user', content: { type: 'text', text: 'hello ' + m.params.arguments.x } }] };
        send({ id: m.id, result: r });
      });
    "#;
    let dir = tempfile::tempdir().unwrap();
    let pool = crate::db::open(&dir.path().join("singl.db")).await.unwrap();
    let work = dir.path().join("my work");
    std::fs::create_dir_all(&work).unwrap();
    let assistant = Assistant::new(
      Arc::new(tokio::sync::RwLock::new(pool)),
      Arc::new(RwLock::new(Workspace::new(Some(work)))),
      Default::default(),
    );
    let mut cfg = McpServerConfig {
      name: "n".into(),
      enabled: true,
      command: "node".into(),
      args: vec!["-e".into(), script.into()],
      ..Default::default()
    };
    let clients = &assistant.mcp_clients;

    // Tool filters: a switched-off tool is neither offered nor callable; read-only hides writes.
    cfg.disabled_tools = vec!["ask".into()];
    let servers = vec![cfg.clone()];
    let names: Vec<_> = clients.tools(&servers).await.into_iter().map(|t| t.name).collect();
    assert_eq!(names, ["n__update_it"]);
    assert!(clients.call(&servers, "n__ask", json!({}), Duration::from_secs(30)).await.is_err());
    cfg.disabled_tools.clear();
    let servers = vec![cfg.clone()];
    let all = clients.tools(&servers).await;
    assert_eq!(all.len(), 2);
    assert_eq!(clients.server_tools(&servers).await.len(), 2);

    // The server's roots/list and elicitation requests are answered (no window: declined).
    let out = clients.call(&servers, "n__ask", json!({}), Duration::from_secs(30)).await.unwrap();
    let v: Value = serde_json::from_str(&out).unwrap();
    assert_eq!(v["roots"]["roots"][0]["uri"].as_str().unwrap().ends_with("/my%20work"), true, "{out}");
    assert_eq!(v["elicit"]["action"], "decline");

    // Resources page through the cursor; prompts expand.
    let list = clients.resources(&servers, false).await;
    assert_eq!(list.iter().map(|r| r.uri.as_str()).collect::<Vec<_>>(), ["mem://a", "mem://b"]);
    assert_eq!(clients.read_resource("n", "mem://a").await.unwrap().text, "body of mem://a");
    let prompts = clients.prompts(&servers).await;
    assert!(prompts[0].arguments[0].required);
    let got = clients.get_prompt("n", "p", HashMap::from([("x".to_string(), "w".to_string())])).await.unwrap();
    assert_eq!(got.messages[0].text, "hello w");
    let log = crate::assistant::mcp::host::call_log();
    assert!(log.iter().any(|e| e.kind == "resource" && e.tool == "mem://a" && e.error.is_none()));

    // Read-only: the write-named tool disappears.
    cfg.read_only = true;
    let servers = vec![cfg];
    let names: Vec<_> = clients.tools(&servers).await.into_iter().map(|t| t.name).collect();
    assert_eq!(names, ["n__ask"]);
    clients.shutdown_all().await;
  }

  #[tokio::test(flavor = "multi_thread")]
  #[ignore = "needs node on PATH"]
  async fn talks_to_a_stdio_server() {
    let script = r#"
      const rl = require('readline').createInterface({ input: process.stdin });
      rl.on('line', l => {
        const m = JSON.parse(l);
        if (m.id === undefined) return;
        let r = {};
        if (m.method === 'initialize') r = { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 't', version: '1' } };
        else if (m.method === 'tools/list') r = { tools: [{ name: 'echo.it', description: 'd', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } }] };
        else if (m.method === 'tools/call') r = { content: [{ type: 'text', text: 'echo:' + JSON.stringify(m.params.arguments) }] };
        console.log(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: r }));
      });
    "#;
    let servers = vec![McpServerConfig {
      name: "n".into(),
      enabled: true,
      command: "node".into(),
      args: vec!["-e".into(), script.into()],
      ..Default::default()
    }];
    let clients = McpClients::default();
    let tools = clients.tools(&servers).await;
    assert_eq!(tools.len(), 1);
    assert_eq!(tools[0].name, "n__echo_it");
    assert_eq!(tools[0].risk, Risk::Read);
    assert_eq!(clients.call(&servers, "n__echo_it", json!({ "a": 1 }), Duration::from_secs(30)).await.unwrap(), "echo:{\"a\":1}");
    clients.shutdown_all().await;
    assert!(clients.status(&servers).await[0].state == "stopped");
  }
}
