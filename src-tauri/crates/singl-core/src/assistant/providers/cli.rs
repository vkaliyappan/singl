//! Agent CLIs as assistant providers. They run their own tool loop; the app's
//! tools reach them over its streamable-HTTP MCP server, registered under the
//! name `singl` for just this run (a temp config file or `-c` overrides, never
//! the user's own CLI configuration).
//!
//! Argv and stream shapes come from `src/lib/twx-flow/agents.ts`; the MCP flags
//! were read from each CLI's `--help`:
//!   * claude: `--mcp-config <file> --strict-mcp-config` (JSON file, `type: http`).
//!   * codex: `-c mcp_servers.singl.url=…` and `bearer_token_env_var` (the token
//!     travels in the environment, not on the command line).
//!   * copilot: `--additional-mcp-config=@<file>`, same JSON as claude's.
//!   * antigravity (`agy`): no per-run MCP flag. `agy mcp add` writes the user's
//!     global config, which a background chat must not do, so `agy` runs
//!     without the app's tools and is told so in the prompt.

use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use super::{CliReply, CliRequest, TextSink, check_cancel};
use crate::agents::process::{ProcEvent, ProcRegistry, Sink, SpawnSpec, capture};
use crate::assistant::types::ModelInfo;
use crate::{CoreError, Result};

/// The name the app's tools carry in the CLI (`mcp__singl__<tool>` in claude).
const SERVER: &str = "singl";
/// `agy` silently answers nothing past about 20 kB on its stdin line; see agents.ts.
const AGY_MAX_PROMPT_CHARS: usize = 16_000;
/// Built-in claude tools that change the machine. The app's own tools go through
/// the assistant's approval flow instead.
const CLAUDE_DENIED: &str = "Bash,PowerShell,Edit,Write,MultiEdit,NotebookEdit";

/// Temp files holding secrets or long text, removed when dropped (so also on errors and cancel).
#[derive(Default)]
struct TempFiles(Vec<PathBuf>);

impl TempFiles {
  fn write(&mut self, ext: &str, content: &str) -> Result<PathBuf> {
    self.write_bytes(ext, content.as_bytes())
  }

  fn write_bytes(&mut self, ext: &str, content: &[u8]) -> Result<PathBuf> {
    let dir = std::env::temp_dir().join("singl-assistant");
    std::fs::create_dir_all(&dir)?;
    let path = dir.join(format!("{}.{ext}", uuid::Uuid::new_v4()));
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    {
      use std::os::unix::fs::OpenOptionsExt;
      opts.mode(0o600);
    }
    use std::io::Write;
    opts.open(&path)?.write_all(content)?;
    self.0.push(path.clone());
    Ok(path)
  }
}

impl Drop for TempFiles {
  fn drop(&mut self) {
    for p in &self.0 {
      let _ = std::fs::remove_file(p);
    }
  }
}

/// What to start.
#[derive(Debug, Default, PartialEq)]
pub struct Launch {
  pub args: Vec<String>,
  pub stdin: String,
  pub env: HashMap<String, String>,
}

/// The JSON claude and copilot read their MCP servers from.
fn mcp_config_json(req: &CliRequest, copilot: bool) -> String {
  let mut server = json!({"type": "http", "url": req.mcp_url, "headers": {"Authorization": format!("Bearer {}", req.mcp_token)}});
  if copilot {
    server["tools"] = json!(["*"]);
  }
  json!({"mcpServers": {SERVER: server}}).to_string()
}

/// Provider CLIs without a system-prompt flag get it in front of the prompt.
fn with_instructions(system: &str, prompt: &str, note: &str) -> String {
  let note = if note.is_empty() { String::new() } else { format!("\n\n{note}") };
  format!("<instructions>\n{system}{note}\n</instructions>\n\n{prompt}")
}

/// The prompt plus where the attached images were saved, for CLIs that only read them from disk.
fn with_image_paths(prompt: &str, images: &[PathBuf]) -> String {
  if images.is_empty() {
    return prompt.to_string();
  }
  let list: Vec<String> = images.iter().map(|p| format!("- {}", p.display())).collect();
  format!("{prompt}\n\nThe user attached these images; open them to see them:\n{}", list.join("\n"))
}

fn flag(args: &mut Vec<String>, name: &str, value: &str) {
  if !value.trim().is_empty() {
    args.push(name.into());
    args.push(value.trim().into());
  }
}

/// argv, stdin and environment for one turn. `mcp_file` / `system_file` are the
/// temp files already written for claude and copilot.
pub fn build_launch(req: &CliRequest, mcp_file: Option<&Path>, system_file: Option<&Path>, images: &[PathBuf]) -> Result<Launch> {
  let path_str = |p: Option<&Path>| p.map(|p| p.to_string_lossy().into_owned()).unwrap_or_default();
  let resume = req.resume.as_deref().map(str::trim).filter(|s| !s.is_empty());
  let mut l = Launch::default();
  match req.provider.as_str() {
    "claude" => {
      l.args = ["-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages"].map(String::from).to_vec();
      l.args.extend(["--mcp-config".into(), path_str(mcp_file), "--strict-mcp-config".into()]);
      l.args.extend(["--append-system-prompt-file".into(), path_str(system_file)]);
      // `=` keeps each variadic flag from swallowing what follows.
      l.args.push(format!("--allowedTools=mcp__{SERVER}"));
      l.args.push(format!("--disallowedTools={CLAUDE_DENIED}"));
      flag(&mut l.args, "--model", &req.model);
      flag(&mut l.args, "--effort", &req.effort);
      if let Some(id) = resume {
        l.args.extend(["--resume".into(), id.into()]);
      }
      // Print mode connects MCP servers in the background and may look for tools first.
      l.env.insert("MCP_CONNECTION_NONBLOCKING".into(), "0".into());
      if req.images.is_empty() {
        l.stdin = req.prompt.clone();
      } else {
        // Images need structured input: one SDK user message on stdin.
        l.args.extend(["--input-format".into(), "stream-json".into()]);
        let mut content = vec![json!({"type": "text", "text": req.prompt})];
        for i in &req.images {
          content.push(json!({"type": "image", "source": {"type": "base64", "media_type": i.media_type, "data": i.data}}));
        }
        let msg = json!({"type": "user", "session_id": "", "parent_tool_use_id": null, "message": {"role": "user", "content": content}});
        l.stdin = format!("{msg}\n");
      }
    }
    "codex" => {
      l.args = ["exec", "--json", "--skip-git-repo-check", "-s", "read-only"].map(String::from).to_vec();
      let q = |s: &str| serde_json::to_string(s).unwrap_or_default();
      for kv in [
        format!("mcp_servers.{SERVER}.url={}", q(&req.mcp_url)),
        format!("mcp_servers.{SERVER}.bearer_token_env_var=\"SINGL_MCP_TOKEN\""),
        format!("mcp_servers.{SERVER}.default_tools_approval_mode=\"approve\""),
      ] {
        l.args.extend(["-c".into(), kv]);
      }
      // Only the app's server: every MCP server from the user's Codex config is off for this run.
      for name in req.foreign_mcp.iter().filter(|n| *n != SERVER) {
        l.args.extend(["-c".into(), format!("mcp_servers.{}.enabled=false", toml_key(name))]);
      }
      flag(&mut l.args, "-m", &req.model);
      for p in images {
        l.args.push(format!("--image={}", p.display()));
      }
      if !req.effort.is_empty() {
        l.args.extend(["-c".into(), format!("model_reasoning_effort={}", q(&req.effort))]);
      }
      // `exec resume <id>` takes the exec options ahead of the subcommand.
      if let Some(id) = resume {
        l.args.extend(["resume".into(), id.into()]);
      }
      l.args.push("-".into());
      l.env.insert("SINGL_MCP_TOKEN".into(), req.mcp_token.clone());
      l.stdin = with_instructions(&req.system, &req.prompt, "");
    }
    "copilot" => {
      l.args = ["-p", "", "--no-color", "--log-level", "none", "--output-format", "json", "--no-ask-user", "--disable-builtin-mcps"]
        .map(String::from)
        .to_vec();
      l.args.push(format!("--additional-mcp-config=@{}", path_str(mcp_file)));
      l.args.push(format!("--allow-tool={SERVER}"));
      l.args.extend(["--deny-tool=shell".into(), "--deny-tool=write".into()]);
      for name in req.foreign_mcp.iter().filter(|n| *n != SERVER) {
        l.args.push(format!("--disable-mcp-server={name}"));
      }
      flag(&mut l.args, "--model", &req.model);
      flag(&mut l.args, "--reasoning-effort", &req.effort);
      if let Some(id) = resume {
        l.args.push(format!("--resume={id}"));
      }
      for p in images {
        l.args.push(format!("--attachment={}", p.display()));
      }
      l.stdin = with_instructions(&req.system, &req.prompt, "");
    }
    "antigravity" => {
      // agy loads the MCP servers from its global config and has no per-run way to
      // switch them off, so it cannot promise a read-only turn.
      if req.read_only {
        return Err(CoreError::Invalid(
          "Antigravity can't be limited to read-only: it uses its own MCP servers, which the app can't switch off. \
Pick another provider or another approval mode."
            .into(),
        ));
      }
      // `-p=` (empty value) plus stream-json: the prompt travels as one NDJSON line on stdin.
      l.args = ["-p=", "--input-format", "stream-json", "--output-format", "stream-json"].map(String::from).to_vec();
      flag(&mut l.args, "--model", &req.model);
      flag(&mut l.args, "--effort", &req.effort);
      if let Some(id) = resume {
        l.args.extend(["--conversation".into(), id.into()]);
      }
      let note = "The assistant tools of the app are not reachable from this CLI in this session. \
Do not claim to have changed anything in the app; answer from your own knowledge and from the conversation.";
      let prompt = with_instructions(&req.system, &with_image_paths(&req.prompt, images), note);
      let len = prompt.chars().count();
      if len > AGY_MAX_PROMPT_CHARS {
        return Err(CoreError::Invalid(format!(
          "Antigravity takes at most {AGY_MAX_PROMPT_CHARS} characters per turn and this one is {len}. Start a new chat or pick another provider."
        )));
      }
      l.stdin = format!("{}\n", json!({"event": "user", "message": {"content": prompt}}));
    }
    other => return Err(CoreError::Invalid(format!("\"{other}\" is not an agent CLI."))),
  }
  Ok(l)
}

/// Reads one CLI's JSON-lines output into text and a session id.
pub struct Parser {
  provider: String,
  pub session: Option<String>,
  /// Everything shown to the user, with segments (messages around tool calls) apart.
  streamed: String,
  /// The current segment, the fallback answer when no result event says better.
  segment: String,
  need_sep: bool,
  /// claude: a text delta came in, so the whole `assistant` message would repeat it.
  partial_seen: bool,
  last_step: Option<i64>,
  final_text: Option<String>,
  /// Ends the turn as a failure.
  error: Option<String>,
  /// Only explains an empty answer (codex also reports retried hiccups as errors).
  soft_error: Option<String>,
}

impl Parser {
  pub fn new(provider: &str) -> Self {
    Self {
      provider: provider.into(),
      session: None,
      streamed: String::new(),
      segment: String::new(),
      need_sep: false,
      partial_seen: false,
      last_step: None,
      final_text: None,
      error: None,
      soft_error: None,
    }
  }

  fn start_segment(&mut self) {
    self.need_sep = true;
    self.segment.clear();
  }

  fn emit(&mut self, text: &str, on_text: TextSink<'_>) {
    if text.is_empty() {
      return;
    }
    if self.need_sep && !self.streamed.is_empty() {
      on_text("\n\n");
      self.streamed.push_str("\n\n");
    }
    self.need_sep = false;
    self.streamed.push_str(text);
    self.segment.push_str(text);
    on_text(text);
  }

  fn set_session(&mut self, id: Option<&str>) {
    if let Some(id) = id.filter(|s| !s.is_empty()) {
      self.session = Some(id.to_string());
    }
  }

  pub fn feed_line(&mut self, line: &str, on_text: TextSink<'_>) {
    let line = line.trim();
    if !line.starts_with('{') {
      return;
    }
    let Ok(ev) = serde_json::from_str::<Value>(line) else { return };
    match self.provider.as_str() {
      "claude" => self.claude(&ev, on_text),
      "codex" => self.codex(&ev, on_text),
      "copilot" => self.copilot(&ev, on_text),
      "antigravity" => self.agy(&ev, on_text),
      _ => {}
    }
  }

  fn claude(&mut self, ev: &Value, on_text: TextSink<'_>) {
    // Sub-agents' own chatter is not the answer.
    if !ev["parent_tool_use_id"].is_null() {
      return;
    }
    match ev["type"].as_str().unwrap_or("") {
      "system" if ev["subtype"] == "init" => self.set_session(ev["session_id"].as_str()),
      "stream_event" => {
        let e = &ev["event"];
        match e["type"].as_str() {
          Some("content_block_start") if e["content_block"]["type"] == "text" => self.start_segment(),
          Some("content_block_delta") if e["delta"]["type"] == "text_delta" => {
            self.partial_seen = true;
            self.emit(e["delta"]["text"].as_str().unwrap_or(""), on_text);
          }
          _ => {}
        }
      }
      // Without partial messages (older CLI) each whole message is all there is.
      "assistant" => {
        if !self.partial_seen {
          for b in ev["message"]["content"].as_array().into_iter().flatten() {
            if b["type"] == "text" {
              self.start_segment();
              self.emit(b["text"].as_str().unwrap_or(""), on_text);
            }
          }
        }
        self.partial_seen = false;
      }
      "result" => {
        self.set_session(ev["session_id"].as_str());
        let text = ev["result"].as_str().unwrap_or("").trim().to_string();
        if ev["is_error"].as_bool().unwrap_or(false) {
          let why = if text.is_empty() { ev["subtype"].as_str().unwrap_or("Claude Code failed.").to_string() } else { text };
          self.error = Some(why);
        } else if !text.is_empty() {
          self.final_text = Some(text);
        }
      }
      _ => {}
    }
  }

  fn codex(&mut self, ev: &Value, on_text: TextSink<'_>) {
    match ev["type"].as_str().unwrap_or("") {
      "thread.started" => self.set_session(ev["thread_id"].as_str()),
      "item.completed" if ev["item"]["type"] == "agent_message" => {
        self.start_segment();
        self.emit(ev["item"]["text"].as_str().unwrap_or(""), on_text);
      }
      "turn.failed" => {
        self.error = Some(ev["error"]["message"].as_str().unwrap_or("Codex failed.").to_string());
      }
      "error" => self.soft_error = ev["message"].as_str().map(str::to_string),
      _ => {}
    }
  }

  fn copilot(&mut self, ev: &Value, on_text: TextSink<'_>) {
    let ty = ev["type"].as_str().unwrap_or("");
    let data = &ev["data"];
    match ty {
      "session.start" => self.set_session(data["sessionId"].as_str()),
      "assistant.message" => {
        self.start_segment();
        self.emit(data["content"].as_str().unwrap_or(""), on_text);
      }
      "result" => {
        self.set_session(ev["sessionId"].as_str());
        if let Some(code) = ev["exitCode"].as_i64().filter(|c| *c != 0) {
          self.soft_error.get_or_insert_with(|| format!("Copilot exited with code {code}."));
        }
      }
      t if t.ends_with(".error") || t.ends_with("_error") => {
        self.soft_error = Some(data["message"].as_str().unwrap_or(t).to_string());
      }
      _ => {}
    }
  }

  fn agy(&mut self, ev: &Value, on_text: TextSink<'_>) {
    match ev["event"].as_str().unwrap_or("") {
      "init" => self.set_session(ev["conversation_id"].as_str()),
      "step_update" => {
        let s = &ev["step_update"];
        if s["step_type"] == "agent_response" {
          let step = s["step_index"].as_i64();
          if step != self.last_step {
            self.last_step = step;
            self.start_segment();
          }
          // The closing event only carries a newline.
          if s["state"] != "DONE" {
            self.emit(s["text_delta"].as_str().unwrap_or(""), on_text);
          }
        }
      }
      "result" => {
        let r = &ev["result"];
        self.set_session(r["conversation_id"].as_str());
        if r["status"].as_str().is_some_and(|s| s != "SUCCESS") {
          self.error = Some(format!("Antigravity ended with status {}.", r["status"].as_str().unwrap_or("?")));
        }
        let text = r["response"].as_str().unwrap_or("").trim().to_string();
        if !text.is_empty() {
          self.final_text = Some(text);
        }
      }
      _ => {}
    }
  }

  /// The turn's outcome once the process is gone.
  pub fn finish(self, exit_code: Option<i32>, stderr_tail: &str) -> Result<CliReply> {
    if let Some(e) = self.error {
      return Err(CoreError::Invalid(e));
    }
    let text = self
      .final_text
      .or_else(|| (!self.segment.trim().is_empty()).then(|| self.segment.trim().to_string()))
      .or_else(|| (!self.streamed.trim().is_empty()).then(|| self.streamed.trim().to_string()));
    match text {
      Some(text) => Ok(CliReply { text, session_id: self.session }),
      None => {
        let why = self
          .soft_error
          .filter(|s| !s.is_empty())
          .or_else(|| (!stderr_tail.trim().is_empty()).then(|| stderr_tail.trim().to_string()))
          .unwrap_or_else(|| match exit_code {
            Some(0) | None => "The agent finished without an answer.".to_string(),
            Some(c) => format!("The agent exited with code {c} and no answer."),
          });
        Err(CoreError::Invalid(why))
      }
    }
  }
}

pub async fn run(procs: &ProcRegistry, mut req: CliRequest, on_text: TextSink<'_>, cancel: &CancellationToken) -> Result<CliReply> {
  check_cancel(cancel)?;
  // Names the binary or the variable to set when it is missing.
  crate::agents::resolve_command(&req.provider)?;
  req.foreign_mcp = foreign_mcp_servers(procs, &req.provider).await?;

  let mut files = TempFiles::default();
  let mcp_file = match req.provider.as_str() {
    "claude" | "copilot" => Some(files.write("json", &mcp_config_json(&req, req.provider == "copilot"))?),
    _ => None,
  };
  let system_file = (req.provider == "claude").then(|| files.write("md", &req.system)).transpose()?;
  // Claude takes images inline; the other CLIs read them from files.
  let image_files = if req.provider == "claude" {
    Vec::new()
  } else {
    use base64::Engine;
    let mut out = Vec::new();
    for i in &req.images {
      let bytes = base64::engine::general_purpose::STANDARD
        .decode(&i.data)
        .map_err(|_| CoreError::Invalid(format!("{} could not be read.", i.name)))?;
      let ext = i.media_type.strip_prefix("image/").unwrap_or("png").replace("jpeg", "jpg");
      out.push(files.write_bytes(&ext, &bytes)?);
    }
    out
  };
  let launch = build_launch(&req, mcp_file.as_deref(), system_file.as_deref(), &image_files)?;

  let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
  let sink: Sink = Arc::new(move |e| {
    let _ = tx.send(e);
  });
  let id = procs.spawn(
    SpawnSpec {
      provider: req.provider.clone(),
      args: launch.args,
      stdin: Some(launch.stdin),
      keep_stdin: false,
      env: launch.env,
      timeout_ms: None,
    },
    &req.cwd,
    sink,
  )?;

  let mut parser = Parser::new(&req.provider);
  let mut stderr: VecDeque<String> = VecDeque::new();
  let mut code = None;
  loop {
    tokio::select! {
      () = cancel.cancelled() => {
        procs.kill(&id);
        return Err(CoreError::Cancelled);
      }
      event = rx.recv() => match event {
        Some(ProcEvent::Stdout { line }) => parser.feed_line(&line, on_text),
        Some(ProcEvent::Stderr { line }) => {
          if stderr.len() == 20 {
            stderr.pop_front();
          }
          stderr.push_back(line);
        }
        Some(ProcEvent::Exit { code: c, .. }) => {
          code = c;
          break;
        }
        None => break,
      }
    }
  }
  parser.finish(code, &stderr.into_iter().collect::<Vec<_>>().join("\n"))
}

fn default_model() -> ModelInfo {
  ModelInfo { id: String::new(), name: "Default".into() }
}

fn push_unique(out: &mut Vec<ModelInfo>, id: &str, name: Option<&str>) {
  let id = id.trim();
  if id.is_empty() || out.iter().any(|m| m.id == id) {
    return;
  }
  out.push(ModelInfo { id: id.into(), name: name.map(str::trim).filter(|n| !n.is_empty()).unwrap_or(id).into() });
}

/// `~/.claude.json`'s `additionalModelOptionsCache`: models this account is offered.
pub fn parse_claude_cache(json: &str) -> Vec<ModelInfo> {
  let mut out = Vec::new();
  let v: Value = serde_json::from_str(json).unwrap_or(Value::Null);
  for o in v["additionalModelOptionsCache"].as_array().into_iter().flatten() {
    if o["disabled"].as_bool().unwrap_or(false) {
      continue;
    }
    if let Some(id) = o["value"].as_str() {
      push_unique(&mut out, id, o["label"].as_str());
    }
  }
  out
}

/// `~/.codex/models_cache.json`: visible models in the CLI's own priority order.
pub fn parse_codex_cache(json: &str) -> Vec<ModelInfo> {
  let v: Value = serde_json::from_str(json).unwrap_or(Value::Null);
  let mut rows: Vec<&Value> = v["models"].as_array().into_iter().flatten().filter(|m| m["visibility"] != "hide").collect();
  rows.sort_by(|a, b| a["priority"].as_f64().unwrap_or(0.0).total_cmp(&b["priority"].as_f64().unwrap_or(0.0)));
  let mut out = Vec::new();
  for m in rows {
    if let Some(slug) = m["slug"].as_str() {
      push_unique(&mut out, slug, m["display_name"].as_str());
    }
  }
  out
}

/// `agy models`: `id<TAB>Human name` per line, after a line of its own.
pub fn parse_tabbed_models(stdout: &str) -> Vec<ModelInfo> {
  let mut out = Vec::new();
  for line in stdout.lines() {
    let mut parts = line.split('\t');
    let id = parts.next().unwrap_or("").trim();
    if id.contains('-') && !id.contains(' ') {
      push_unique(&mut out, id, parts.next());
    }
  }
  out
}

/// `copilot --help` documents `--model` with quoted examples (`'auto'`, …).
pub fn parse_model_flag_help(help: &str) -> Vec<ModelInfo> {
  let lines: Vec<&str> = help.lines().collect();
  let Some(start) = lines.iter().position(|l| l.trim_start().starts_with("--model")) else { return Vec::new() };
  let mut block = lines[start].to_string();
  for l in &lines[start + 1..] {
    // The description is indented; the next option starts at the flag column.
    if l.chars().take_while(|c| c.is_whitespace()).count() <= 6 && l.trim_start().starts_with('-') {
      break;
    }
    block.push(' ');
    block.push_str(l);
  }
  let mut out = Vec::new();
  for part in block.split('\'').skip(1).step_by(2) {
    if part.chars().next().is_some_and(|c| c.is_ascii_alphanumeric()) && part.chars().all(|c| c.is_ascii_alphanumeric() || "._-[]".contains(c)) {
      push_unique(&mut out, part, None);
    }
  }
  out
}

/// `copilot help config` lists models as a quoted bullet list under `model`.
pub fn parse_copilot_config_models(help: &str) -> Vec<ModelInfo> {
  let Some(section) = help.split("`model`:").nth(1) else { return Vec::new() };
  let mut out = Vec::new();
  for line in section.lines() {
    let t = line.trim();
    if let Some(q) = t.strip_prefix('-').map(str::trim).and_then(|r| r.strip_prefix('"')).and_then(|r| r.strip_suffix('"')) {
      push_unique(&mut out, q, None);
    } else if !out.is_empty() && !t.is_empty() && !t.starts_with('-') {
      break;
    }
  }
  out
}

/// A TOML key for `-c`: bare when it can be, else quoted.
fn toml_key(name: &str) -> String {
  if !name.is_empty() && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-') {
    name.to_string()
  } else {
    serde_json::to_string(name).unwrap_or_default()
  }
}

/// Codex's configured MCP server names, from `codex mcp list --json`.
pub fn parse_codex_mcp_list(json: &str) -> Option<Vec<String>> {
  let v: Value = serde_json::from_str(json.trim()).ok()?;
  Some(v.as_array()?.iter().filter_map(|s| s["name"].as_str().map(String::from)).collect())
}

/// Copilot's configured MCP server names (`~/.copilot/mcp-config.json`, or `$COPILOT_HOME`).
fn copilot_mcp_servers() -> Vec<String> {
  let dir = std::env::var_os("COPILOT_HOME")
    .filter(|v| !v.is_empty())
    .map(PathBuf::from)
    .or_else(|| crate::agents::home_dir().map(|h| h.join(".copilot")));
  let Some(text) = dir.and_then(|d| std::fs::read_to_string(d.join("mcp-config.json")).ok()) else { return Vec::new() };
  serde_json::from_str::<Value>(&text)
    .ok()
    .and_then(|v| v["mcpServers"].as_object().map(|m| m.keys().cloned().collect()))
    .unwrap_or_default()
}

/// The MCP servers a CLI would load on its own, so its run can switch them off
/// and reach only the app's server (whose calls go through approvals and the
/// read-only mode). Fails closed: if Codex's list cannot be read, the turn does not start.
async fn foreign_mcp_servers(procs: &ProcRegistry, provider: &str) -> Result<Vec<String>> {
  match provider {
    "codex" => {
      static CACHE: std::sync::Mutex<Option<(std::time::Instant, Vec<String>)>> = std::sync::Mutex::new(None);
      if let Some((at, names)) = CACHE.lock().unwrap_or_else(|e| e.into_inner()).as_ref() {
        if at.elapsed() < std::time::Duration::from_secs(300) {
          return Ok(names.clone());
        }
      }
      let out = capture_stdout(procs, "codex", &["mcp", "list", "--json"]).await;
      let names = parse_codex_mcp_list(&out).ok_or_else(|| {
        CoreError::Invalid("Could not read Codex's MCP server list (`codex mcp list --json`), so they can't be switched off for this turn.".into())
      })?;
      *CACHE.lock().unwrap_or_else(|e| e.into_inner()) = Some((std::time::Instant::now(), names.clone()));
      Ok(names)
    }
    "copilot" => Ok(copilot_mcp_servers()),
    _ => Ok(Vec::new()),
  }
}

async fn capture_stdout(procs: &ProcRegistry, provider: &str, args: &[&str]) -> String {
  let spec = SpawnSpec {
    provider: provider.into(),
    args: args.iter().map(|s| s.to_string()).collect(),
    stdin: None,
    keep_stdin: false,
    env: HashMap::new(),
    timeout_ms: Some(20_000),
  };
  match capture(procs, spec, &std::env::temp_dir()).await {
    Ok((Some(0), out)) => out,
    _ => String::new(),
  }
}

/// The models a CLI offers, Default first. Whatever cannot be read is skipped:
/// the picker must always open.
pub async fn models(procs: &ProcRegistry, provider: &str) -> Result<Vec<ModelInfo>> {
  let mut out = vec![default_model()];
  match provider {
    "claude" => {
      // Versioned ids first (`--model claude-opus-5-5`), then whatever the account's cache offers.
      for (id, name) in super::CLAUDE_MODELS {
        push_unique(&mut out, id, Some(name));
      }
      if let Some(cache) = crate::agents::model_cache("claude").await {
        for m in parse_claude_cache(&cache) {
          push_unique(&mut out, &m.id, Some(&m.name));
        }
      }
    }
    "codex" => {
      if let Some(cache) = crate::agents::model_cache("codex").await {
        for m in parse_codex_cache(&cache) {
          push_unique(&mut out, &m.id, Some(&m.name));
        }
      }
    }
    "antigravity" if crate::agents::installed(provider) => {
      for m in parse_tabbed_models(&capture_stdout(procs, provider, &["models"]).await) {
        push_unique(&mut out, &m.id, Some(&m.name));
      }
    }
    "copilot" if crate::agents::installed(provider) => {
      let found = parse_model_flag_help(&capture_stdout(procs, provider, &["--help"]).await)
        .into_iter()
        .chain(parse_copilot_config_models(&capture_stdout(procs, provider, &["help", "config"]).await));
      for m in found {
        push_unique(&mut out, &m.id, Some(&m.name));
      }
    }
    _ => {}
  }
  Ok(out)
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::sync::Mutex;

  fn req(provider: &str) -> CliRequest {
    CliRequest {
      provider: provider.into(),
      model: "m1".into(),
      system: "SYS".into(),
      prompt: "hello".into(),
      resume: None,
      mcp_url: "http://127.0.0.1:9/mcp".into(),
      mcp_token: "tok".into(),
      cwd: std::env::temp_dir(),
      effort: String::new(),
      read_only: false,
      foreign_mcp: vec!["context7".into(), "my server".into(), "singl".into()],
      images: Vec::new(),
    }
  }

  fn parse(provider: &str, lines: &[&str]) -> (Parser, String) {
    let seen = Mutex::new(String::new());
    let on_text = |t: &str| seen.lock().unwrap().push_str(t);
    let mut p = Parser::new(provider);
    for l in lines {
      p.feed_line(l, &on_text);
    }
    (p, seen.into_inner().unwrap())
  }

  #[test]
  fn images_reach_each_cli() {
    let img = super::super::CliImage { name: "a.png".into(), media_type: "image/png".into(), data: "iVBORw0KGgo=".into() };
    let mut r = req("claude");
    r.images = vec![img.clone()];
    let l = build_launch(&r, Some(Path::new("c.json")), Some(Path::new("s.md")), &[]).unwrap();
    assert!(l.args.windows(2).any(|w| w[0] == "--input-format" && w[1] == "stream-json"));
    let line: Value = serde_json::from_str(l.stdin.trim()).unwrap();
    assert_eq!(line["message"]["content"][1]["source"]["media_type"], "image/png");
    assert_eq!(line["message"]["content"][0]["text"], "hello");

    let files = [std::env::temp_dir().join("x.png")];
    let codex = build_launch(&req("codex"), None, None, &files).unwrap();
    assert!(codex.args.iter().any(|a| a.starts_with("--image=") && a.ends_with("x.png")));
    let copilot = build_launch(&req("copilot"), Some(Path::new("c.json")), None, &files).unwrap();
    assert!(copilot.args.iter().any(|a| a.starts_with("--attachment=") && a.ends_with("x.png")));
    let agy = build_launch(&req("antigravity"), None, None, &files).unwrap();
    assert!(agy.stdin.contains("x.png"));
  }

  #[test]
  fn claude_argv() {
    let mut r = req("claude");
    r.resume = Some("sess-1".into());
    let l = build_launch(&r, Some(Path::new("c.json")), Some(Path::new("s.md")), &[]).unwrap();
    let a = &l.args;
    let at = |f: &str| a.iter().position(|x| x == f).unwrap();
    assert_eq!(a[0], "-p");
    assert_eq!(a[at("--mcp-config") + 1], "c.json");
    assert!(a.contains(&"--strict-mcp-config".to_string()));
    assert_eq!(a[at("--append-system-prompt-file") + 1], "s.md");
    assert!(a.contains(&"--allowedTools=mcp__singl".to_string()));
    assert!(a.iter().any(|x| x.starts_with("--disallowedTools=Bash,")));
    assert_eq!(a[at("--model") + 1], "m1");
    assert_eq!(a[at("--resume") + 1], "sess-1");
    assert_eq!(l.stdin, "hello");
    assert!(!a.iter().any(|x| x.contains("tok")), "token must not be on the command line");
    let json: Value = serde_json::from_str(&mcp_config_json(&r, false)).unwrap();
    assert_eq!(json["mcpServers"]["singl"]["headers"]["Authorization"], "Bearer tok");
    assert_eq!(json["mcpServers"]["singl"]["type"], "http");
  }

  #[test]
  fn codex_argv() {
    let mut r = req("codex");
    r.resume = Some("th-1".into());
    let l = build_launch(&r, None, None, &[]).unwrap();
    assert_eq!(&l.args[..2], ["exec", "--json"]);
    assert!(l.args.contains(&"mcp_servers.singl.url=\"http://127.0.0.1:9/mcp\"".to_string()));
    assert!(l.args.contains(&"mcp_servers.singl.bearer_token_env_var=\"SINGL_MCP_TOKEN\"".to_string()));
    let rs = l.args.iter().position(|x| x == "resume").unwrap();
    assert_eq!(l.args[rs + 1], "th-1");
    assert_eq!(l.args.last().unwrap(), "-");
    assert_eq!(l.env["SINGL_MCP_TOKEN"], "tok");
    assert!(l.stdin.starts_with("<instructions>\nSYS\n</instructions>\n\nhello"));
    assert!(!l.args.iter().any(|x| x.contains("tok") && !x.contains("SINGL_MCP_TOKEN")));
  }

  #[test]
  fn copilot_and_agy_argv() {
    let l = build_launch(&req("copilot"), Some(Path::new("c.json")), None, &[]).unwrap();
    assert!(l.args.contains(&"--additional-mcp-config=@c.json".to_string()));
    assert!(l.args.contains(&"--allow-tool=singl".to_string()));
    assert_eq!(&l.args[..2], ["-p", ""]);

    let l = build_launch(&req("antigravity"), None, None, &[]).unwrap();
    assert_eq!(l.args[0], "-p=");
    let line: Value = serde_json::from_str(l.stdin.trim()).unwrap();
    assert_eq!(line["event"], "user");
    assert!(line["message"]["content"].as_str().unwrap().contains("not reachable"));

    let mut long = req("antigravity");
    long.prompt = "x".repeat(20_000);
    assert!(build_launch(&long, None, None, &[]).is_err());
    assert!(build_launch(&req("bash"), None, None, &[]).is_err());
  }

  #[test]
  fn claude_stream_with_partials() {
    let (p, text) = parse(
      "claude",
      &[
        "not json",
        r#"{"type":"system","subtype":"init","session_id":"s1"}"#,
        r#"{"type":"stream_event","event":{"type":"content_block_start","content_block":{"type":"thinking"}}}"#,
        r#"{"type":"stream_event","event":{"type":"content_block_start","content_block":{"type":"text","text":""}}}"#,
        r#"{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Let me "}}}"#,
        r#"{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"look."}}}"#,
        r#"{"type":"assistant","message":{"content":[{"type":"text","text":"Let me look."}]}}"#,
        r#"{"type":"assistant","parent_tool_use_id":"x","message":{"content":[{"type":"text","text":"sub-agent"}]}}"#,
        r#"{"type":"stream_event","event":{"type":"content_block_start","content_block":{"type":"text","text":""}}}"#,
        r#"{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Done."}}}"#,
        r#"{"type":"result","subtype":"success","is_error":false,"result":"Done.","session_id":"s1"}"#,
      ],
    );
    assert_eq!(text, "Let me look.\n\nDone.");
    let r = p.finish(Some(0), "").unwrap();
    assert_eq!(r.text, "Done.");
    assert_eq!(r.session_id.as_deref(), Some("s1"));
  }

  #[test]
  fn claude_without_partials_and_errors() {
    let (p, text) = parse(
      "claude",
      &[r#"{"type":"assistant","message":{"content":[{"type":"tool_use","name":"x"},{"type":"text","text":"Hi"}]}}"#],
    );
    assert_eq!(text, "Hi");
    assert_eq!(p.finish(Some(0), "").unwrap().text, "Hi");

    let (p, _) = parse("claude", &[r#"{"type":"result","is_error":true,"result":"Invalid API key","session_id":"s"}"#]);
    assert_eq!(p.finish(Some(1), "").unwrap_err().to_string(), "Invalid API key");
  }

  #[test]
  fn codex_events() {
    let (p, text) = parse(
      "codex",
      &[
        r#"{"type":"thread.started","thread_id":"t-9"}"#,
        r#"{"type":"turn.started"}"#,
        r#"{"type":"item.completed","item":{"id":"i0","type":"mcp_tool_call"}}"#,
        r#"{"type":"item.completed","item":{"id":"i1","type":"agent_message","text":"All good"}}"#,
        r#"{"type":"turn.completed"}"#,
      ],
    );
    assert_eq!(text, "All good");
    let r = p.finish(Some(0), "").unwrap();
    assert_eq!((r.text.as_str(), r.session_id.as_deref()), ("All good", Some("t-9")));

    let (p, _) = parse("codex", &[r#"{"type":"turn.failed","error":{"message":"quota"}}"#]);
    assert_eq!(p.finish(Some(1), "").unwrap_err().to_string(), "quota");
    // A retried hiccup does not fail a turn that answered.
    let (p, _) = parse(
      "codex",
      &[r#"{"type":"error","message":"Reconnecting..."}"#, r#"{"type":"item.completed","item":{"type":"agent_message","text":"ok"}}"#],
    );
    assert_eq!(p.finish(Some(0), "").unwrap().text, "ok");
  }

  #[test]
  fn copilot_and_agy_events() {
    let (p, text) = parse(
      "copilot",
      &[
        r#"{"type":"session.start","data":{"sessionId":"c-1"}}"#,
        r#"{"type":"assistant.message","data":{"content":"Hello"}}"#,
        r#"{"type":"result","sessionId":"c-1","exitCode":0}"#,
      ],
    );
    assert_eq!(text, "Hello");
    assert_eq!(p.finish(Some(0), "").unwrap().session_id.as_deref(), Some("c-1"));

    let (p, text) = parse(
      "antigravity",
      &[
        r#"{"event":"init","conversation_id":"a-1"}"#,
        r#"{"event":"step_update","step_update":{"step_index":1,"state":"ACTIVE","step_type":"agent_response","text_delta":"Hi!"}}"#,
        r#"{"event":"step_update","step_update":{"step_index":1,"state":"DONE","step_type":"agent_response","text_delta":"\n"}}"#,
        r#"{"event":"result","result":{"conversation_id":"a-1","status":"SUCCESS","response":"Hi!\n"}}"#,
      ],
    );
    assert_eq!(text, "Hi!");
    let r = p.finish(Some(0), "").unwrap();
    assert_eq!((r.text.as_str(), r.session_id.as_deref()), ("Hi!", Some("a-1")));
  }

  #[test]
  fn empty_answer_reports_stderr() {
    let (p, _) = parse("codex", &[]);
    assert_eq!(p.finish(Some(2), "boom\nbad flag").unwrap_err().to_string(), "boom\nbad flag");
    let (p, _) = parse("codex", &[]);
    assert!(p.finish(Some(2), "").unwrap_err().to_string().contains("code 2"));
  }

  #[test]
  fn model_parsers() {
    let claude = parse_claude_cache(r#"{"additionalModelOptionsCache":[{"value":"a-1","label":"A"},{"value":"b","disabled":true}]}"#);
    assert_eq!((claude.len(), claude[0].name.as_str()), (1, "A"));
    let codex = parse_codex_cache(r#"{"models":[{"slug":"z","priority":2},{"slug":"y","priority":1,"display_name":"Why"},{"slug":"h","visibility":"hide"}]}"#);
    assert_eq!(codex.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(), ["y", "z"]);
    let agy = parse_tabbed_models("Fetching models...\ngemini-3-pro\tGemini 3 Pro\nother line\n");
    assert_eq!((agy.len(), agy[0].name.as_str()), (1, "Gemini 3 Pro"));
    let help = "  --model <model>\n          Set the AI model (use 'auto' to let Copilot pick\n          automatically)\n      --mouse\n          x 'nope'\n";
    assert_eq!(parse_model_flag_help(help).iter().map(|m| m.id.as_str()).collect::<Vec<_>>(), ["auto"]);
    let cfg = "  `model`: the model.\n    - \"gpt-5\"\n    - \"claude-x\"\n  `next`: other\n";
    assert_eq!(parse_copilot_config_models(cfg).len(), 2);
    assert!(parse_claude_cache("garbage").is_empty());
  }

  #[test]
  fn temp_files_are_removed() {
    let path = {
      let mut f = TempFiles::default();
      let p = f.write("json", "{}").unwrap();
      assert!(p.exists());
      p
    };
    assert!(!path.exists());
  }

  /// Needs a signed-in `claude`: `cargo test -p singl-core real_cli_claude -- --ignored`.
  #[tokio::test(flavor = "multi_thread")]
  #[ignore]
  async fn real_cli_claude() {
    let procs = ProcRegistry::default();
    let mut r = req("claude");
    r.model = "haiku".into();
    r.prompt = "Reply with the single word pong.".into();
    r.mcp_url = "http://127.0.0.1:1/mcp".into();
    let reply = run(&procs, r, &|_| {}, &CancellationToken::new()).await.unwrap();
    assert!(reply.text.to_lowercase().contains("pong"));
    assert!(reply.session_id.is_some());
    assert!(models(&procs, "claude").await.unwrap().len() >= 4);
  }

  #[test]
  fn clis_switch_off_their_own_mcp_servers() {
    let codex = build_launch(&req("codex"), None, None, &[]).unwrap();
    assert!(codex.args.contains(&"mcp_servers.context7.enabled=false".to_string()));
    assert!(codex.args.contains(&"mcp_servers.\"my server\".enabled=false".to_string()));
    assert!(!codex.args.iter().any(|a| a.starts_with("mcp_servers.singl.enabled")));
    let copilot = build_launch(&req("copilot"), Some(Path::new("c.json")), None, &[]).unwrap();
    assert!(copilot.args.contains(&"--disable-mcp-server=context7".to_string()));
    let mut agy = req("antigravity");
    agy.read_only = true;
    assert!(build_launch(&agy, None, None, &[]).is_err());
    assert_eq!(parse_codex_mcp_list(r#"[{"name":"a"},{"name":"b"}]"#).unwrap(), vec!["a", "b"]);
    assert!(parse_codex_mcp_list("not json").is_none());
  }
}
