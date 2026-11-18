//! What the app does when an MCP server (a client connection of ours) asks
//! something of it: list its roots, ask the user for input (elicitation), run
//! a model call for it (sampling). Also the in-memory log of the calls the
//! clients make.

use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock, Weak};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use crate::Result;
use crate::assistant::bridge::Pending;
use crate::assistant::events::AssistantEvent;
use crate::assistant::providers::{self, ApiRequest};
use crate::assistant::tools::Risk;
use crate::assistant::types::{Block, Message, Role};
use crate::assistant::{Assistant, ToolScope};
use crate::workspace::PathKind;

/// A JSON-RPC error answer: code and message.
pub(crate) type RpcError = (i64, String);

const ELICIT_TIMEOUT: Duration = Duration::from_secs(600);
const SAMPLING_TIMEOUT: Duration = Duration::from_secs(600);

// ---- call log ----------------------------------------------------------------

const LOG_CAP: usize = 500;
const ARGS_LIMIT: usize = 2048;

/// One call an MCP client made to a server.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CallLogEntry {
  pub id: u64,
  /// `"tool"` (`tools/call`) or `"resource"` (`resources/read`).
  pub kind: &'static str,
  pub server: String,
  /// The server's own tool name, or the resource URI.
  pub tool: String,
  /// The arguments as JSON, cut at 2 KB.
  pub args: String,
  /// Unix milliseconds.
  pub started_at: i64,
  pub duration_ms: u64,
  pub result_bytes: usize,
  pub error: Option<String>,
}

fn log() -> &'static Mutex<VecDeque<CallLogEntry>> {
  static LOG: OnceLock<Mutex<VecDeque<CallLogEntry>>> = OnceLock::new();
  LOG.get_or_init(|| Mutex::new(VecDeque::new()))
}

/// The log, newest first.
pub fn call_log() -> Vec<CallLogEntry> {
  log().lock().unwrap_or_else(|e| e.into_inner()).iter().rev().cloned().collect()
}

pub fn clear_call_log() {
  log().lock().unwrap_or_else(|e| e.into_inner()).clear();
}

fn clip_bytes(s: &str, max: usize) -> String {
  if s.len() <= max {
    return s.to_string();
  }
  let mut end = max;
  while !s.is_char_boundary(end) {
    end -= 1;
  }
  format!("{}…", &s[..end])
}

/// A call being timed; [`Self::finish`] files it in the log.
pub(crate) struct LoggedCall {
  kind: &'static str,
  server: String,
  tool: String,
  args: String,
  started_at: i64,
  start: Instant,
}

impl LoggedCall {
  pub fn start(kind: &'static str, server: &str, tool: &str, args: &Value) -> Self {
    let started_at = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0);
    Self {
      kind,
      server: server.to_string(),
      tool: tool.to_string(),
      args: clip_bytes(&args.to_string(), ARGS_LIMIT),
      started_at,
      start: Instant::now(),
    }
  }

  /// Logs the outcome and hands the result back.
  pub fn finish(self, result: Result<String>) -> Result<String> {
    match &result {
      Ok(text) => self.record(text.len(), None),
      Err(e) => self.record(0, Some(e.to_string())),
    }
    result
  }

  /// Files the call with the size of its result or its error.
  pub fn record(self, result_bytes: usize, error: Option<String>) {
    static SEQ: AtomicU64 = AtomicU64::new(1);
    let error = error.map(|e| clip_bytes(&e, 500));
    let mut log = log().lock().unwrap_or_else(|e| e.into_inner());
    if log.len() >= LOG_CAP {
      log.pop_front();
    }
    log.push_back(CallLogEntry {
      id: SEQ.fetch_add(1, Ordering::Relaxed),
      kind: self.kind,
      server: self.server,
      tool: self.tool,
      args: self.args,
      started_at: self.started_at,
      duration_ms: self.start.elapsed().as_millis() as u64,
      result_bytes,
      error,
    });
  }
}

// ---- roots -------------------------------------------------------------------

/// `file:///C:/a%20b` for a path.
pub fn file_uri(path: &Path) -> String {
  let s = path.to_string_lossy().replace('\\', "/");
  let s = s.strip_prefix("//?/").unwrap_or(&s);
  let mut out = String::from("file://");
  if !s.starts_with('/') {
    out.push('/');
  }
  for b in s.bytes() {
    match b {
      b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' | b'/' | b':' => out.push(b as char),
      _ => out.push_str(&format!("%{b:02X}")),
    }
  }
  out
}

impl Assistant {
  /// What servers may look at: the workspace folder, the entity folder and the
  /// repository clones, as MCP roots (`{ uri, name }`).
  pub async fn mcp_roots(&self) -> Vec<Value> {
    let ws = self.workspace();
    let mut folders: Vec<(PathBuf, String)> = Vec::new();
    if let Some(root) = ws.root() {
      folders.push((root.to_path_buf(), "Workspace".into()));
    }
    if let Some(dir) = ws.resolve(PathKind::TwxEntities).filter(|d| d.is_dir()) {
      folders.push((dir, "twx-entities".into()));
    }
    if let Some(repos) = ws.resolve(PathKind::Repo) {
      let pool = self.pool().await;
      for slot in [1, 2] {
        let Ok(repo) = crate::db::repo::get(&pool, slot).await else { continue };
        if repo.repo_slug.is_empty() {
          continue;
        }
        if let Ok(dir) = crate::repo::files::safe_join(&repos, &repo.repo_slug) {
          if dir.is_dir() {
            folders.push((dir, format!("repo: {}", repo.repo_slug)));
          }
        }
      }
    }
    let mut seen = Vec::new();
    folders
      .into_iter()
      .filter(|(p, _)| {
        let fresh = !seen.contains(p);
        seen.push(p.clone());
        fresh
      })
      .map(|(p, name)| json!({ "uri": file_uri(&p), "name": name }))
      .collect()
  }
}

// ---- requests from a server --------------------------------------------------

/// Answers the requests one server sends us.
#[derive(Clone)]
pub(crate) struct Handler {
  pub host: Weak<Assistant>,
  pub server: String,
  /// The chat whose tool call is running on this server, so a card shows where it belongs.
  pub chat: Arc<Mutex<Option<String>>>,
}

impl Handler {
  pub fn new(host: Weak<Assistant>, server: &str) -> Self {
    Self { host, server: server.to_string(), chat: Arc::new(Mutex::new(None)) }
  }

  fn chat(&self) -> Option<String> {
    self.chat.lock().unwrap_or_else(|e| e.into_inner()).clone()
  }

  pub async fn handle(&self, method: &str, params: Value) -> std::result::Result<Value, RpcError> {
    if method == "ping" {
      return Ok(json!({}));
    }
    let Some(a) = self.host.upgrade() else { return Err((-32603, "singl is shutting down.".into())) };
    match method {
      "roots/list" => Ok(json!({ "roots": a.mcp_roots().await })),
      "elicitation/create" => Ok(a.mcp_elicit(&self.server, self.chat(), &params).await),
      "sampling/createMessage" => a.mcp_sample(&self.server, self.chat(), &params).await,
      other => Err((-32601, format!("Method not found: {other}"))),
    }
  }

  /// The JSON-RPC response to a request with `id`.
  pub async fn respond(&self, id: Value, method: &str, params: Value) -> Value {
    match self.handle(method, params).await {
      Ok(result) => json!({ "jsonrpc": "2.0", "id": id, "result": result }),
      Err((code, message)) => json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } }),
    }
  }
}

// ---- elicitation -------------------------------------------------------------

/// The user's answer to a form a server asked for.
#[derive(Debug, Clone, Deserialize)]
pub struct ElicitAnswer {
  /// `"accept"`, `"decline"` or `"cancel"`.
  pub action: String,
  #[serde(default)]
  pub content: Option<Value>,
}

fn elicitations() -> &'static Pending<ElicitAnswer> {
  static PENDING: OnceLock<Pending<ElicitAnswer>> = OnceLock::new();
  PENDING.get_or_init(Pending::default)
}

impl Assistant {
  /// Answers an `elicitationRequest` event. False when nothing waits any more.
  pub fn mcp_elicit_reply(&self, request_id: &str, answer: ElicitAnswer) -> bool {
    let resolved = elicitations().resolve(request_id, answer);
    if resolved {
      self.emit(AssistantEvent::ElicitationResolved { request_id: request_id.into() });
    }
    resolved
  }

  /// Shows the server's form in the chat and returns the user's answer.
  pub(crate) async fn mcp_elicit(&self, server: &str, chat_id: Option<String>, params: &Value) -> Value {
    if !self.has_ui() {
      return json!({ "action": "decline" });
    }
    let (request_id, rx) = elicitations().open();
    self.emit(AssistantEvent::ElicitationRequest {
      request_id: request_id.clone(),
      chat_id: chat_id.clone(),
      server: server.into(),
      message: params.get("message").and_then(Value::as_str).unwrap_or_default().into(),
      schema: params.get("requestedSchema").cloned().unwrap_or_else(|| json!({ "type": "object", "properties": {} })),
    });
    let cancel = chat_id.as_deref().and_then(|c| self.turn_cancel(c));
    let wait = async {
      match cancel {
        Some(token) => tokio::select! {
          r = rx => r.ok(),
          () = token.cancelled() => None,
        },
        None => rx.await.ok(),
      }
    };
    match tokio::time::timeout(ELICIT_TIMEOUT, wait).await.ok().flatten() {
      Some(answer) => match answer.action.as_str() {
        "accept" => json!({ "action": "accept", "content": answer.content.unwrap_or_else(|| json!({})) }),
        "decline" => json!({ "action": "decline" }),
        _ => json!({ "action": "cancel" }),
      },
      None => {
        elicitations().forget(&request_id);
        self.emit(AssistantEvent::ElicitationResolved { request_id });
        json!({ "action": "cancel" })
      }
    }
  }
}

// ---- sampling ----------------------------------------------------------------

/// The text of a sampling content block (or array of them).
fn sampling_text(content: &Value) -> String {
  let one = |c: &Value| match c.get("type").and_then(Value::as_str) {
    Some("text") => c.get("text").and_then(Value::as_str).unwrap_or_default().to_string(),
    Some(other) => format!("[{other} omitted]"),
    None => String::new(),
  };
  match content {
    Value::Array(items) => items.iter().map(one).collect::<Vec<_>>().join("\n"),
    c => one(c),
  }
}

/// The request's messages as chat messages, neighbours of one role joined.
fn sampling_messages(params: &Value) -> Vec<(Role, String)> {
  let mut out: Vec<(Role, String)> = Vec::new();
  for m in params.get("messages").and_then(Value::as_array).into_iter().flatten() {
    let role = if m.get("role").and_then(Value::as_str) == Some("assistant") { Role::Assistant } else { Role::User };
    let text = sampling_text(m.get("content").unwrap_or(&Value::Null));
    match out.last_mut() {
      Some((last, joined)) if *last == role => {
        joined.push('\n');
        joined.push_str(&text);
      }
      _ => out.push((role, text)),
    }
  }
  out
}

impl Assistant {
  /// Asks the user, with the same card tool approvals use. "Always" is
  /// remembered for the server until the app closes.
  async fn ask_sampling(&self, server: &str, chat_id: Option<String>, input: Value) -> bool {
    let key = format!("sampling:{server}");
    if self.allow_all.lock().unwrap_or_else(|e| e.into_inner()).contains(&key) {
      return true;
    }
    if !self.has_ui() {
      return false;
    }
    let (request_id, rx) = self.approvals.open();
    self.emit(AssistantEvent::ApprovalRequest {
      request_id: request_id.clone(),
      chat_id: chat_id.clone(),
      tool: format!("{server} asks the model"),
      input,
      risk: Risk::Write,
      scope: ToolScope::Local,
      source: server.into(),
    });
    let cancel = chat_id.as_deref().and_then(|c| self.turn_cancel(c));
    let wait = async {
      match cancel {
        Some(token) => tokio::select! {
          r = rx => r.ok(),
          () = token.cancelled() => None,
        },
        None => rx.await.ok(),
      }
    };
    let Some(answer) = tokio::time::timeout(SAMPLING_TIMEOUT, wait).await.ok().flatten() else {
      self.approvals.forget(&request_id);
      self.emit(AssistantEvent::ApprovalResolved { request_id, approved: false });
      return false;
    };
    if answer.approved && answer.always {
      self.allow_all.lock().unwrap_or_else(|e| e.into_inner()).insert(key);
    }
    answer.approved
  }

  /// `sampling/createMessage`: runs the server's request through the default
  /// API provider once the user agrees. Agent CLIs cannot do this.
  pub(crate) async fn mcp_sample(&self, server: &str, chat_id: Option<String>, params: &Value) -> std::result::Result<Value, RpcError> {
    let fail = |message: String| (-32603, message);
    let settings = self.settings().await.map_err(|e| fail(e.to_string()))?;
    let provider = settings.default_provider.clone();
    if !providers::is_api(&provider) {
      return Err(fail(format!(
        "{server} asked the model for a completion, but sampling only works when the default provider in Settings > AI is the Anthropic API or OpenRouter (it is {}).",
        providers::title(&provider)
      )));
    }
    let api_key = if provider == "anthropic" { settings.anthropic_key() } else { settings.openrouter_key() };
    if api_key.is_empty() {
      return Err(fail(format!("Add a {} key in Settings > AI to answer sampling requests.", providers::title(&provider))));
    }
    let model = match (provider.as_str(), settings.default_model.trim()) {
      ("anthropic", "") => crate::assistant::runner::DEFAULT_ANTHROPIC_MODEL.to_string(),
      ("openrouter", "") => return Err(fail("Pick a default OpenRouter model in Settings > AI to answer sampling requests.".into())),
      (_, m) => m.to_string(),
    };
    let messages = sampling_messages(params);
    if messages.first().map(|(r, _)| *r) != Some(Role::User) {
      return Err((-32602, "A sampling request must start with a user message.".into()));
    }
    let system = params.get("systemPrompt").and_then(Value::as_str).unwrap_or_default().trim().to_string();
    let max_tokens = params.get("maxTokens").and_then(Value::as_u64).unwrap_or(1024).clamp(1, 16_000) as u32;

    let preview: Vec<Value> =
      messages.iter().map(|(r, t)| json!({ "role": if *r == Role::User { "user" } else { "assistant" }, "text": clip_bytes(t, 1500) })).collect();
    let input = json!({
      "server": server,
      "provider": providers::title(&provider),
      "model": model,
      "maxTokens": max_tokens,
      "systemPrompt": clip_bytes(&system, 1500),
      "messages": preview,
    });
    if !self.ask_sampling(server, chat_id, input).await {
      return Err((-1, "The user declined the sampling request.".into()));
    }

    let request = ApiRequest {
      api_key,
      model: model.clone(),
      system: if system.is_empty() { "You are a helpful assistant.".into() } else { system },
      messages: messages.into_iter().map(|(role, text)| Message::new(role, vec![Block::Text { text }])).collect(),
      tools: Vec::new(),
      max_tokens,
      effort: String::new(),
    };
    let cancel = CancellationToken::new();
    let sink = |_: &str| {};
    let reply = if provider == "anthropic" {
      providers::anthropic::complete(&request, &sink, &sink, &cancel).await
    } else {
      providers::openrouter::complete(&request, &sink, &sink, &cancel).await
    }
    .map_err(|e| fail(e.to_string()))?;
    let text: String = reply
      .blocks
      .iter()
      .filter_map(|b| match b {
        Block::Text { text } => Some(text.as_str()),
        _ => None,
      })
      .collect::<Vec<_>>()
      .join("");
    let stop = match reply.stop_reason.as_str() {
      "max_tokens" => "maxTokens",
      "stop_sequence" => "stopSequence",
      _ => "endTurn",
    };
    Ok(json!({ "role": "assistant", "content": { "type": "text", "text": text }, "model": model, "stopReason": stop }))
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn file_uris() {
    assert_eq!(file_uri(Path::new("C:\\My Files\\a")), "file:///C:/My%20Files/a");
    assert_eq!(file_uri(Path::new("\\\\?\\C:\\x")), "file:///C:/x");
    assert_eq!(file_uri(Path::new("/home/u/p")), "file:///home/u/p");
  }

  #[test]
  fn sampling_messages_join_neighbours() {
    let p = json!({ "messages": [
      { "role": "user", "content": { "type": "text", "text": "a" } },
      { "role": "user", "content": [{ "type": "text", "text": "b" }, { "type": "image", "data": "x" }] },
      { "role": "assistant", "content": { "type": "text", "text": "c" } },
    ]});
    let m = sampling_messages(&p);
    assert_eq!(m.len(), 2);
    assert_eq!(m[0].1, "a\nb\n[image omitted]");
  }

  #[test]
  fn log_keeps_the_newest_and_clips_arguments() {
    clear_call_log();
    for i in 0..LOG_CAP + 5 {
      let call = LoggedCall::start("tool", "s", "t", &json!({ "i": i, "pad": "x".repeat(5000) }));
      let _ = call.finish(if i % 2 == 0 { Ok("ok".into()) } else { Err(crate::CoreError::Invalid("bad".into())) });
    }
    let all = call_log();
    assert_eq!(all.len(), LOG_CAP);
    assert!(all[0].id > all[1].id);
    assert!(all[0].args.len() <= ARGS_LIMIT + 3);
    assert!(all.iter().any(|e| e.error.is_some()));
  }
}
