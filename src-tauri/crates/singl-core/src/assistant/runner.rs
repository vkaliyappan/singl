//! Turns: one user message in, the assistant's work and answer out.
//!
//! API providers get the tool loop here: call the model, run the tools it
//! asks for, feed the results back, repeat until it answers. Agent CLIs run
//! their own loop and call tools over the app's MCP server with a token
//! scoped to the chat; their calls are collected and stored the same way.

use std::sync::Arc;

use serde::Deserialize;
use tokio_util::sync::CancellationToken;

use super::events::AssistantEvent;
use super::providers::{self, ApiRequest, CliRequest, TextSink};
use super::subagents::{self, SubAgentSettings};
use super::tools::{CallMeta, ToolSpec};
use super::types::{Block, Chat, Message, Role};
use super::{Assistant, prompt, store};
use crate::{CoreError, Result};

const MAX_STEPS: usize = 40;
const MAX_TOKENS: u32 = 16_000;
pub const DEFAULT_ANTHROPIC_MODEL: &str = "claude-sonnet-5-5";
const TRANSCRIPT_LIMIT: usize = 40_000;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SendRequest {
  /// Continue this chat; `None` starts a new one.
  #[serde(default)]
  pub chat_id: Option<String>,
  pub provider: String,
  #[serde(default)]
  pub model: String,
  /// Reasoning effort (`low` … `max`); empty = provider default.
  #[serde(default)]
  pub effort: String,
  pub text: String,
  /// Absolute paths of text files to attach.
  #[serde(default)]
  pub attachments: Vec<String>,
  /// Only these tools for this turn; `None` = every tool.
  #[serde(default)]
  pub tools: Option<Vec<String>>,
  /// Skill ids (see [`super::skills::list`]) whose instructions join this turn's system prompt.
  #[serde(default)]
  pub skills: Vec<String>,
  /// How this turn's tool calls are approved.
  #[serde(default)]
  pub approval: super::ApprovalMode,
  /// The same for ThingWorx server calls; `None` follows `approval`.
  #[serde(default)]
  pub server_approval: Option<super::ApprovalMode>,
  /// Files dropped from outside the app, read by the page (a browser drop
  /// carries no path). Same limits as `attachments`.
  #[serde(default)]
  pub inline_attachments: Vec<InlineAttachment>,
  /// Items pinned from screens with "Add to chat".
  #[serde(default)]
  pub references: Vec<Reference>,
  /// Pasted, dropped or picked images (base64).
  #[serde(default)]
  pub images: Vec<ImageInput>,
  /// Sub-agent controls from the composer; `None` = off (Claude Code keeps its own default).
  #[serde(default)]
  pub sub_agents: Option<SubAgentSettings>,
}

/// One model loop's fixed inputs: a turn's, or a sub-agent's.
pub struct Job {
  pub provider: String,
  pub model: String,
  pub effort: String,
  /// Skills whose instructions join the system prompt (rebuilt every step, so it follows the screen).
  pub skills: Vec<String>,
  /// Appended to the system prompt.
  pub system_extra: String,
  pub tools: Vec<ToolSpec>,
  pub max_steps: usize,
  pub chat_id: String,
  /// `"assistant"` for a turn, `sub-agent:<call id>` for a sub-agent.
  pub source: String,
}

impl Job {
  /// A sub-agent's call ids get its own prefix: models number calls per
  /// conversation, and two sub-agents must not share a card in the UI.
  fn meta(&self, id: &str) -> CallMeta {
    let call_id = if self.source == "assistant" { id.to_string() } else { format!("{}/{id}", self.source) };
    CallMeta { chat_id: Some(self.chat_id.clone()), source: self.source.clone(), call_id }
  }
}

/// Where a loop keeps its messages: the chat (stored and shown) or, for a
/// sub-agent, a scratch list only it sees.
pub enum History<'a> {
  Chat(&'a mut Chat),
  Scratch(Vec<Message>),
}

impl History<'_> {
  fn messages(&self) -> &[Message] {
    match self {
      Self::Chat(chat) => &chat.messages,
      Self::Scratch(list) => list,
    }
  }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageInput {
  pub name: String,
  pub media_type: String,
  pub data: String,
}

const MAX_IMAGES: usize = 8;
/// Base64 size per image the Anthropic API accepts (5 MB); the page shrinks images before sending.
const IMAGE_LIMIT: usize = 5 * 1024 * 1024;
const IMAGE_TYPES: &[&str] = &["image/png", "image/jpeg", "image/gif", "image/webp"];

/// Images as blocks, checked for count, type, size and valid base64.
fn images(items: &[ImageInput]) -> Result<Vec<Block>> {
  use base64::Engine;
  if items.len() > MAX_IMAGES {
    return Err(CoreError::Invalid(format!("Attach at most {MAX_IMAGES} images per message.")));
  }
  items
    .iter()
    .map(|i| {
      if !IMAGE_TYPES.contains(&i.media_type.as_str()) {
        return Err(CoreError::Invalid(format!("{} is not a PNG, JPEG, GIF or WebP image.", i.name)));
      }
      if i.data.len() > IMAGE_LIMIT {
        return Err(CoreError::Invalid(format!("{} is larger than 5 MB.", i.name)));
      }
      base64::engine::general_purpose::STANDARD
        .decode(&i.data)
        .map_err(|_| CoreError::Invalid(format!("{} could not be read.", i.name)))?;
      Ok(Block::Image { name: i.name.clone(), media_type: i.media_type.clone(), data: i.data.clone() })
    })
    .collect()
}

#[derive(Debug, Clone, Deserialize)]
pub struct Reference {
  pub kind: String,
  pub label: String,
  #[serde(default)]
  pub screen: Option<String>,
  pub content: String,
}

const MAX_REFERENCES: usize = 20;
/// Each pinned item is clipped to this; the model fetches more with tools.
const REFERENCE_LIMIT: usize = 48 * 1024;
const REFERENCES_TOTAL: usize = 256 * 1024;

/// Pinned items as blocks: clipped one by one, refused past the count or total size.
fn references(items: &[Reference]) -> Result<Vec<Block>> {
  if items.len() > MAX_REFERENCES {
    return Err(CoreError::Invalid(format!("Pin at most {MAX_REFERENCES} items per message.")));
  }
  let mut total = 0;
  let mut out = Vec::new();
  for r in items {
    let content = super::context::clip(&r.content, REFERENCE_LIMIT);
    total += content.len();
    if total > REFERENCES_TOTAL {
      return Err(CoreError::Invalid(format!("Pinned items add up to more than {} KB.", REFERENCES_TOTAL / 1024)));
    }
    out.push(Block::Reference { kind: r.kind.clone(), label: r.label.clone(), screen: r.screen.clone(), content });
  }
  Ok(out)
}

#[derive(Debug, Clone, Deserialize)]
pub struct InlineAttachment {
  pub name: String,
  pub content: String,
}

/// Dropped files as attachment blocks, checked against the limits together with `read`.
fn inline_attachments(items: &[InlineAttachment], read: &[Block]) -> Result<Vec<Block>> {
  if read.len() + items.len() > MAX_ATTACHMENTS {
    return Err(CoreError::Invalid(format!("Attach at most {MAX_ATTACHMENTS} files per message.")));
  }
  let mut total: u64 = read
    .iter()
    .map(|b| match b {
      Block::Attachment { content, directory: false, .. } => content.len() as u64,
      _ => 0,
    })
    .sum();
  let mut out = Vec::new();
  for item in items {
    let size = item.content.len() as u64;
    if size > ATTACHMENT_LIMIT {
      return Err(CoreError::Invalid(format!("{} is larger than {} KB.", item.name, ATTACHMENT_LIMIT / 1024)));
    }
    total += size;
    if total > ATTACHMENTS_TOTAL {
      return Err(CoreError::Invalid(format!("Attachments add up to more than {} KB.", ATTACHMENTS_TOTAL / 1024)));
    }
    out.push(Block::Attachment {
      name: item.name.clone(),
      path: format!("(dropped file) {}", item.name),
      content: item.content.clone(),
      directory: false,
    });
  }
  Ok(out)
}

const MAX_ATTACHMENTS: usize = 10;
const ATTACHMENT_LIMIT: u64 = 256 * 1024;
const ATTACHMENTS_TOTAL: u64 = 1024 * 1024;

/// Reads the attached files (text only, size-limited); a folder attaches as its file tree.
fn read_attachments(paths: &[String], root: Option<&std::path::Path>) -> Result<Vec<Block>> {
  if paths.len() > MAX_ATTACHMENTS {
    return Err(CoreError::Invalid(format!("Attach at most {MAX_ATTACHMENTS} files per message.")));
  }
  let mut total = 0;
  let mut out = Vec::new();
  for raw in paths {
    // Explorer trees may hand over paths relative to the workspace folder.
    let given = std::path::Path::new(raw.trim());
    let joined = match root {
      Some(root) if !given.is_absolute() => root.join(given),
      _ => given.to_path_buf(),
    };
    let path = joined.as_path();
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| raw.clone());
    let meta = std::fs::metadata(path).map_err(|_| CoreError::NotFound(format!("Cannot read \"{raw}\".")))?;
    if path.is_absolute() && meta.is_dir() {
      let content = super::files::tree(path, super::files::TREE_LIMIT);
      out.push(Block::Attachment { name: format!("{name}/"), path: path.display().to_string(), content, directory: true });
      continue;
    }
    if !path.is_absolute() || !meta.is_file() {
      return Err(CoreError::Invalid(format!("\"{raw}\" is not a file.")));
    }
    if meta.len() > ATTACHMENT_LIMIT {
      return Err(CoreError::Invalid(format!("{name} is larger than {} KB.", ATTACHMENT_LIMIT / 1024)));
    }
    total += meta.len();
    if total > ATTACHMENTS_TOTAL {
      return Err(CoreError::Invalid(format!("Attachments add up to more than {} KB.", ATTACHMENTS_TOTAL / 1024)));
    }
    let content = String::from_utf8(std::fs::read(path)?)
      .map_err(|_| CoreError::Invalid(format!("{name} is not a text file; only text files can be attached.")))?;
    out.push(Block::Attachment { name, path: path.display().to_string(), content, directory: false });
  }
  Ok(out)
}

impl Assistant {
  /// Starts a turn in the background and returns its chat id at once.
  pub async fn send(self: &Arc<Self>, req: SendRequest) -> Result<String> {
    let (chat, cancel, req) = self.begin(req).await?;
    let chat_id = chat.id.clone();
    let this = self.clone();
    tokio::spawn(async move {
      let _ = this.finish(chat, req, cancel).await;
    });
    Ok(chat_id)
  }

  /// Runs a turn to the end: `(chat id, final answer)`. For `assistant_ask`.
  pub async fn ask(self: &Arc<Self>, req: SendRequest) -> Result<(String, String)> {
    let (chat, cancel, req) = self.begin(req).await?;
    let chat_id = chat.id.clone();
    let text = self.finish(chat, req, cancel).await?;
    Ok((chat_id, text))
  }

  /// Loads or creates the chat, stores the user's message, marks the chat running.
  async fn begin(self: &Arc<Self>, mut req: SendRequest) -> Result<(Chat, CancellationToken, SendRequest)> {
    let text = req.text.trim().to_string();
    if text.is_empty() && req.images.is_empty() {
      return Err(CoreError::Invalid("Type a message first.".into()));
    }
    if !providers::ALL_PROVIDERS.contains(&req.provider.as_str()) {
      return Err(CoreError::Invalid(format!("Unknown provider \"{}\".", req.provider)));
    }
    req.model = req.model.trim().to_string();
    req.effort = providers::normalize_effort(&req.provider, &req.effort);
    if req.provider == "anthropic" && req.model.is_empty() {
      req.model = DEFAULT_ANTHROPIC_MODEL.into();
    }
    if req.provider == "openrouter" && req.model.is_empty() {
      return Err(CoreError::Invalid("Pick an OpenRouter model first.".into()));
    }
    let pool = self.pool().await;
    let mut chat = match &req.chat_id {
      Some(id) => store::get(&pool, id).await?,
      None => store::create(&pool).await?,
    };
    // Everything that can fail on the request comes before the chat is marked
    // running: an early return after that would leave it "still answering"
    // for good, refusing every later message.
    let mut blocks = read_attachments(&req.attachments, self.workspace_root().as_deref())?;
    let dropped = inline_attachments(&req.inline_attachments, &blocks)?;
    blocks.extend(dropped);
    blocks.extend(references(&req.references)?);
    blocks.extend(images(&req.images)?);
    if !text.is_empty() || blocks.is_empty() {
      blocks.push(Block::Text { text });
    }
    let skill_names: Vec<String> = {
      let known = super::skills::list(self.workspace_root().as_deref());
      req
        .skills
        .iter()
        .map(|id| {
          known
            .iter()
            .find(|s| &s.id == id)
            .map(|s| s.name.clone())
            .ok_or_else(|| CoreError::NotFound("A selected skill is no longer available.".into()))
        })
        .collect::<Result<_>>()?
    };
    let cancel = CancellationToken::new();
    {
      let mut running = self.running.lock().unwrap_or_else(|e| e.into_inner());
      if running.contains_key(&chat.id) {
        return Err(CoreError::Invalid("This chat is still answering. Stop it or wait.".into()));
      }
      running.insert(chat.id.clone(), cancel.clone());
    }
    self.set_turn_tools(&chat.id, req.tools.clone());
    self.set_turn_mode(
      &chat.id,
      Some(super::TurnModes { local: req.approval, server: req.server_approval.unwrap_or(req.approval) }),
    );
    let mut msg = Message::new(Role::User, blocks);
    msg.skills = skill_names;
    msg.provider = Some(req.provider.clone());
    msg.model = Some(req.model.clone());
    msg.effort = Some(req.effort.clone()).filter(|e| !e.is_empty());
    msg.context = serde_json::to_value(self.context.get()).ok();
    chat.messages.push(msg.clone());
    if let Err(e) = store::save(&pool, &mut chat).await {
      self.running.lock().unwrap_or_else(|e| e.into_inner()).remove(&chat.id);
      self.set_turn_tools(&chat.id, None);
      self.set_turn_mode(&chat.id, None);
      return Err(e);
    }
    let sub_agents = req
      .sub_agents
      .clone()
      .filter(|s| s.enabled && providers::is_api(&req.provider))
      .map(|s| s.normalized(&req.provider, &req.model));
    if let Some(s) = sub_agents {
      let turn = subagents::Turn::new(s, &req.provider, &req.effort, req.skills.clone());
      self.set_sub_agent_turn(&chat.id, Some(Arc::new(turn)));
    }
    self.emit(AssistantEvent::ChatsChanged);
    self.emit(AssistantEvent::MessageSaved { chat_id: chat.id.clone(), message: msg });
    self.emit(AssistantEvent::TurnStarted { chat_id: chat.id.clone(), provider: req.provider.clone(), model: req.model.clone() });
    Ok((chat, cancel, req))
  }

  /// Runs the turn, then always unmarks the chat and reports how it ended.
  async fn finish(self: &Arc<Self>, mut chat: Chat, req: SendRequest, cancel: CancellationToken) -> Result<String> {
    let result = if providers::is_api(&req.provider) {
      self.steer_inbox(&chat.id, true);
      self.api_turn(&mut chat, &req, &cancel).await
    } else {
      self.cli_turn(&mut chat, &req, &cancel).await
    };
    // Closed before the chat stops running, so a later steer fails and is sent as its own message.
    let unread = self.steer_inbox(&chat.id, false);
    self.running.lock().unwrap_or_else(|e| e.into_inner()).remove(&chat.id);
    self.set_turn_tools(&chat.id, None);
    self.set_turn_mode(&chat.id, None);
    self.set_sub_agent_turn(&chat.id, None);
    let cancelled = matches!(result, Err(CoreError::Cancelled)) || cancel.is_cancelled();
    let error = match &result {
      Err(CoreError::Cancelled) | Ok(_) => None,
      Err(e) => Some(e.to_string()),
    };
    self.emit(AssistantEvent::TurnEnded { chat_id: chat.id.clone(), error, cancelled, unread });
    self.emit(AssistantEvent::ChatsChanged);
    result
  }

  async fn push(&self, chat: &mut Chat, msg: Message) -> Result<()> {
    chat.messages.push(msg.clone());
    store::save(&self.pool().await, chat).await?;
    self.emit(AssistantEvent::MessageSaved { chat_id: chat.id.clone(), message: msg });
    Ok(())
  }

  /// The system prompt, plus the instructions of the skills picked for this turn.
  fn system(&self, req: &SendRequest) -> Result<String> {
    self.system_for(&req.skills)
  }

  /// The system prompt with these skills' instructions.
  pub(crate) fn system_for(&self, skills: &[String]) -> Result<String> {
    let skills = super::skills::prompt_section(self.workspace_root().as_deref(), skills)?;
    Ok(prompt::system_prompt(&self.context.prompt_block(), &self.context.get()) + &skills)
  }

  async fn api_turn(self: &Arc<Self>, chat: &mut Chat, req: &SendRequest, cancel: &CancellationToken) -> Result<String> {
    let system_extra = self
      .sub_agent_turn(&chat.id)
      .map(|t| subagents::prompt_section(&t.settings, subagents::TOOL))
      .unwrap_or_default();
    let job = Job {
      provider: req.provider.clone(),
      model: req.model.clone(),
      effort: req.effort.clone(),
      skills: req.skills.clone(),
      system_extra,
      tools: self.tool_specs_for(&chat.id).await,
      max_steps: MAX_STEPS,
      chat_id: chat.id.clone(),
      source: "assistant".into(),
    };
    let chat_id = chat.id.clone();
    let this = self.clone();
    let on_text = move |t: &str| this.emit(AssistantEvent::Text { chat_id: chat_id.clone(), text: t.to_string() });
    let (chat_id, this) = (chat.id.clone(), self.clone());
    let on_thinking = move |t: &str| this.emit(AssistantEvent::Thinking { chat_id: chat_id.clone(), text: t.to_string() });
    self.api_loop(&job, &mut History::Chat(chat), &on_text, &on_thinking, cancel).await
  }

  async fn record(&self, history: &mut History<'_>, msg: Message) -> Result<()> {
    match history {
      History::Chat(chat) => self.push(chat, msg).await,
      History::Scratch(list) => {
        list.push(msg);
        Ok(())
      }
    }
  }

  /// The API tool loop: call the model, run the tools it asks for, feed the
  /// results back, until it answers. Serves both a turn and a sub-agent;
  /// `agent_task` calls in one reply run in parallel.
  pub(crate) async fn api_loop(
    self: &Arc<Self>,
    job: &Job,
    history: &mut History<'_>,
    on_text: TextSink<'_>,
    on_thinking: TextSink<'_>,
    cancel: &CancellationToken,
  ) -> Result<String> {
    let settings = self.settings().await?;
    let api_key = match job.provider.as_str() {
      "anthropic" => settings.anthropic_key(),
      _ => settings.openrouter_key(),
    };
    if api_key.is_empty() {
      return Err(CoreError::Invalid(format!("Add a {} key in Settings → AI.", providers::title(&job.provider))));
    }
    let mut last_text = String::new();
    for _ in 0..job.max_steps {
      providers::check_cancel(cancel)?;
      let request = ApiRequest {
        api_key: api_key.clone(),
        model: job.model.clone(),
        system: self.system_for(&job.skills)? + &job.system_extra,
        messages: sanitize(history.messages()),
        tools: job.tools.clone(),
        max_tokens: MAX_TOKENS,
        effort: job.effort.clone(),
      };
      let reply = match job.provider.as_str() {
        "anthropic" => providers::anthropic::complete(&request, on_text, on_thinking, cancel).await?,
        _ => providers::openrouter::complete(&request, on_text, on_thinking, cancel).await?,
      };
      let mut msg = Message::new(Role::Assistant, reply.blocks);
      msg.provider = Some(job.provider.clone());
      msg.model = Some(job.model.clone());
      msg.effort = Some(job.effort.clone()).filter(|e| !e.is_empty());
      let text = msg.text();
      if !text.is_empty() {
        last_text = text;
      }
      let calls: Vec<(String, String, serde_json::Value)> = msg
        .blocks
        .iter()
        .filter_map(|b| match b {
          Block::ToolUse { id, name, input } => Some((id.clone(), name.clone(), input.clone())),
          _ => None,
        })
        .collect();
      if msg.blocks.is_empty() {
        msg.blocks.push(Block::Text { text: String::new() });
      }
      self.record(history, msg).await?;
      if calls.is_empty() {
        // Something the user sent meanwhile gets an answer too.
        if self.read_steered(job, history).await? {
          continue;
        }
        return Ok(last_text);
      }
      // Sub-agents start at once and run side by side; other calls run in order meanwhile.
      let spawned: Vec<Option<tokio::task::JoinHandle<(String, bool)>>> = calls
        .iter()
        .map(|(id, name, input)| {
          (name == subagents::TOOL && !cancel.is_cancelled()).then(|| {
            let (this, name, input, meta) = (self.clone(), name.clone(), input.clone(), job.meta(id));
            tokio::spawn(async move { this.call_tool(&name, input, meta).await })
          })
        })
        .collect();
      let mut results = Vec::new();
      for ((id, name, input), handle) in calls.into_iter().zip(spawned) {
        let (content, is_error) = if let Some(handle) = handle {
          handle.await.unwrap_or_else(|_| ("The sub-agent stopped unexpectedly.".to_string(), true))
        } else if cancel.is_cancelled() {
          ("Cancelled by the user.".to_string(), true)
        } else {
          self.call_tool(&name, input, job.meta(&id)).await
        };
        results.push(Block::ToolResult { tool_use_id: id, content, is_error });
      }
      self.record(history, Message::new(Role::User, results)).await?;
      self.read_steered(job, history).await?;
    }
    Err(CoreError::Invalid(format!("Stopped after {} steps without a final answer.", job.max_steps)))
  }

  /// Records what the user steered into a turn (not a sub-agent's loop) as
  /// their message, for the next model call. True when there was any.
  async fn read_steered(&self, job: &Job, history: &mut History<'_>) -> Result<bool> {
    if job.source != "assistant" || !matches!(history, History::Chat(_)) {
      return Ok(false);
    }
    let texts = self.take_steered(&job.chat_id);
    if texts.is_empty() {
      return Ok(false);
    }
    let mut msg = Message::new(Role::User, texts.into_iter().map(|text| Block::Text { text }).collect());
    msg.context = serde_json::to_value(self.context.get()).ok();
    self.record(history, msg).await?;
    Ok(true)
  }

  async fn cli_turn(self: &Arc<Self>, chat: &mut Chat, req: &SendRequest, cancel: &CancellationToken) -> Result<String> {
    let disabled = crate::db::settings::disabled_agents(&self.pool().await).await?;
    if disabled.contains(&req.provider) {
      return Err(CoreError::Invalid(format!("{} is switched off in Settings → AI.", providers::title(&req.provider))));
    }
    let endpoint = self
      .mcp_endpoint()
      .ok_or_else(|| CoreError::Invalid("CLI providers reach the app through its MCP server: turn it on in Settings → AI.".into()))?;
    let pool = self.pool().await;
    let prior = chat.messages.len() as i64 - 1;
    let latest = chat.messages.last().map(Message::prompt_text).unwrap_or_default();
    let resume = store::session(&pool, &chat.id)
      .await?
      .filter(|s| s.provider == req.provider && s.model == req.model && s.turn_count == prior)
      .map(|s| s.session_id);
    let prompt = if resume.is_some() || prior == 0 {
      latest
    } else {
      format!("{}\n\n---\nNew message from the user:\n{latest}", transcript(&chat.messages[..prior as usize]))
    };

    let token = self.turn_token(&chat.id);
    self.collected.lock().unwrap_or_else(|e| e.into_inner()).insert(chat.id.clone(), Vec::new());
    let chat_id = chat.id.clone();
    let this = self.clone();
    let on_text = move |t: &str| this.emit(AssistantEvent::Text { chat_id: chat_id.clone(), text: t.to_string() });
    let (chat_id, this) = (chat.id.clone(), self.clone());
    let on_thinking = move |t: &str| this.emit(AssistantEvent::Thinking { chat_id: chat_id.clone(), text: t.to_string() });
    let (chat_id, this) = (chat.id.clone(), self.clone());
    let on_status = move |t: &str| this.emit(AssistantEvent::Status { chat_id: chat_id.clone(), text: t.to_string() });
    let cwd = crate::agents::agent_root(self.workspace_root().as_deref());
    // Only Claude Code takes sub-agent settings: models as `--agents`, off as a denied tool.
    let claude_sub_agents =
      req.sub_agents.clone().filter(|_| req.provider == "claude").map(|s| s.normalized(&req.provider, &req.model));
    let result = providers::cli::run(
      &self.procs,
      CliRequest {
        provider: req.provider.clone(),
        model: req.model.clone(),
        system: self.system(req)? + &claude_sub_agents.as_ref().map(subagents::claude_prompt_section).unwrap_or_default(),
        prompt,
        resume,
        mcp_url: endpoint.url,
        mcp_token: token.clone(),
        tool_timeout_secs: self.settings().await.map(|s| s.tool_timeout()).unwrap_or_default().as_secs(),
        cwd,
        effort: req.effort.clone(),
        read_only: req.approval == super::ApprovalMode::ReadOnly,
        foreign_mcp: Vec::new(),
        sub_agents: claude_sub_agents.clone(),
        agents_file: None,
        images: chat
          .messages
          .last()
          .map(|m| m.images().map(|(n, t, d)| providers::CliImage { name: n.into(), media_type: t.into(), data: d.into() }).collect())
          .unwrap_or_default(),
      },
      &on_text,
      &on_thinking,
      &on_status,
      cancel,
    )
    .await;
    self.drop_turn_token(&token);
    let calls = self.collected.lock().unwrap_or_else(|e| e.into_inner()).remove(&chat.id).unwrap_or_default();

    let tag = |mut m: Message| {
      m.provider = Some(req.provider.clone());
      m.model = Some(req.model.clone());
      m.effort = Some(req.effort.clone()).filter(|e| !e.is_empty());
      m
    };
    for (use_block, result_block) in calls {
      self.push(chat, tag(Message::new(Role::Assistant, vec![use_block]))).await?;
      self.push(chat, Message::new(Role::User, vec![result_block])).await?;
    }
    let reply = result?;
    let mut blocks: Vec<Block> = providers::shown_thinking(reply.thinking).into_iter().collect();
    blocks.push(Block::Text { text: reply.text.clone() });
    self.push(chat, tag(Message::new(Role::Assistant, blocks))).await?;
    if let Some(session_id) = reply.session_id.filter(|s| !s.is_empty()) {
      store::save_session(&pool, &chat.id, &req.provider, &req.model, &session_id, chat.messages.len() as i64).await?;
    }
    Ok(reply.text)
  }
}

/// History an API accepts: every tool call answered by the next message and
/// every result tied to a call; anything left dangling (a turn that crashed
/// or was cancelled mid-way) is dropped.
pub fn sanitize(messages: &[Message]) -> Vec<Message> {
  let mut out: Vec<Message> = Vec::with_capacity(messages.len());
  for (i, msg) in messages.iter().enumerate() {
    let mut m = msg.clone();
    match m.role {
      Role::Assistant => {
        let answered: Vec<String> = messages
          .get(i + 1)
          .map(|next| {
            next
              .blocks
              .iter()
              .filter_map(|b| match b {
                Block::ToolResult { tool_use_id, .. } if next.role == Role::User => Some(tool_use_id.clone()),
                _ => None,
              })
              .collect()
          })
          .unwrap_or_default();
        m.blocks.retain(|b| match b {
          Block::ToolUse { id, .. } => answered.contains(id),
          Block::Text { text } => !text.is_empty(),
          Block::Opaque { .. } => true,
          _ => false,
        });
        if m.blocks.iter().all(|b| matches!(b, Block::Opaque { .. })) {
          m.blocks.clear();
        }
      }
      Role::User => {
        let asked: Vec<String> = out
          .last()
          .filter(|p| p.role == Role::Assistant)
          .map(|p| {
            p.blocks
              .iter()
              .filter_map(|b| match b {
                Block::ToolUse { id, .. } => Some(id.clone()),
                _ => None,
              })
              .collect()
          })
          .unwrap_or_default();
        m.blocks.retain(|b| match b {
          Block::ToolResult { tool_use_id, .. } => asked.contains(tool_use_id),
          Block::Text { text } => !text.is_empty(),
          Block::Attachment { .. } | Block::Reference { .. } | Block::Image { .. } => true,
          _ => false,
        });
      }
    }
    if m.blocks.is_empty() {
      continue;
    }
    // Two in a row from the same side (after drops) become one message.
    match out.last_mut() {
      Some(prev) if prev.role == m.role => prev.blocks.extend(m.blocks),
      _ => out.push(m),
    }
  }
  // A conversation must start with the user.
  while out.first().is_some_and(|m| m.role != Role::User) {
    out.remove(0);
  }
  out
}

/// The chat so far as plain text, for a CLI that cannot resume its session.
pub fn transcript(messages: &[Message]) -> String {
  let mut out = String::from("Conversation so far (you may have answered some turns with another model):\n");
  for m in messages {
    for b in &m.blocks {
      let line = match (m.role, b) {
        (Role::User, Block::Text { text }) => format!("\nUser: {text}\n"),
        (Role::Assistant, Block::Text { text }) => format!("\nAssistant: {text}\n"),
        (_, Block::ToolUse { name, input, .. }) => format!("\n[Assistant called {name} with {input}]\n"),
        (_, Block::ToolResult { content, is_error, .. }) => {
          let content = super::context::clip(content, 1_500);
          format!("[{}: {content}]\n", if *is_error { "Tool error" } else { "Tool result" })
        }
        (_, Block::Opaque { .. }) => continue,
        (_, Block::Attachment { name, content, .. }) => {
          format!("\n[User attached {name}:]\n{}\n", super::context::clip(content, 4_000))
        }
        (_, Block::Image { name, .. }) => format!("\n[User attached image {name}]\n"),
        (_, Block::Reference { kind, label, content, .. }) => {
          format!("\n[User pinned {kind} {label}:]\n{}\n", super::context::clip(content, 4_000))
        }
      };
      out.push_str(&line);
    }
  }
  if out.len() > TRANSCRIPT_LIMIT {
    let mut start = out.len() - TRANSCRIPT_LIMIT;
    while !out.is_char_boundary(start) {
      start += 1;
    }
    out = format!("[earlier conversation cut]\n{}", &out[start..]);
  }
  out
}

#[cfg(test)]
mod tests {
  use super::*;
  use serde_json::json;

  fn text(role: Role, t: &str) -> Message {
    Message::new(role, vec![Block::Text { text: t.into() }])
  }

  #[test]
  fn sanitize_drops_dangling_calls() {
    let call = Message::new(Role::Assistant, vec![
      Block::Text { text: "looking".into() },
      Block::ToolUse { id: "a".into(), name: "x".into(), input: json!({}) },
    ]);
    let msgs = vec![text(Role::User, "hi"), call, text(Role::User, "again")];
    let out = sanitize(&msgs);
    assert_eq!(out.len(), 3);
    assert!(out[1].blocks.iter().all(|b| matches!(b, Block::Text { .. })));
  }

  #[test]
  fn sanitize_keeps_answered_calls() {
    let call = Message::new(Role::Assistant, vec![Block::ToolUse { id: "a".into(), name: "x".into(), input: json!({}) }]);
    let res = Message::new(Role::User, vec![Block::ToolResult { tool_use_id: "a".into(), content: "ok".into(), is_error: false }]);
    let out = sanitize(&[text(Role::User, "hi"), call, res, text(Role::Assistant, "done")]);
    assert_eq!(out.len(), 4);
  }

  #[test]
  fn transcript_names_speakers() {
    let t = transcript(&[text(Role::User, "hi"), text(Role::Assistant, "hello")]);
    assert!(t.contains("User: hi") && t.contains("Assistant: hello"));
  }

  #[test]
  fn attachments_are_text_and_size_limited() {
    let dir = tempfile::tempdir().unwrap();
    let ok = dir.path().join("a.js");
    std::fs::write(&ok, "var x = 1;").unwrap();
    let bin = dir.path().join("b.bin");
    std::fs::write(&bin, [0xff, 0xfe, 0x00]).unwrap();
    let blocks = read_attachments(&[ok.display().to_string()], None).unwrap();
    assert!(matches!(&blocks[0], Block::Attachment { name, content, .. } if name == "a.js" && content == "var x = 1;"));
    assert!(read_attachments(&[bin.display().to_string()], None).is_err());
    assert!(read_attachments(&["relative.txt".into()], None).is_err());
    assert!(read_attachments(&["a.js".into()], Some(dir.path())).is_ok());
    let folder = read_attachments(&[dir.path().display().to_string()], None).unwrap();
    assert!(matches!(&folder[0], Block::Attachment { directory: true, content, .. } if content.contains("a.js")));
    let mut msg = Message::new(Role::User, blocks);
    msg.blocks.push(Block::Text { text: "explain".into() });
    assert_eq!(msg.text(), "explain");
    assert!(msg.prompt_text().starts_with("<attached_file name=\"a.js\""));
  }

  #[test]
  fn images_are_checked() {
    let img = |t: &str, d: &str| ImageInput { name: "a".into(), media_type: t.into(), data: d.into() };
    assert!(images(&[img("image/png", "iVBORw0KGgo=")]).is_ok());
    assert!(images(&[img("image/bmp", "iVBORw0KGgo=")]).is_err());
    assert!(images(&[img("image/png", "not base64!")]).is_err());
    assert!(images(&vec![img("image/png", "iVBORw0KGgo="); MAX_IMAGES + 1]).is_err());
    let msg = Message::new(Role::User, images(&[img("image/png", "iVBORw0KGgo=")]).unwrap());
    assert_eq!(msg.images().count(), 1);
    assert!(msg.prompt_text().is_empty());
  }

  #[test]
  fn references_are_clipped_and_limited() {
    let r = |content: String| Reference { kind: "service".into(), label: "GetX".into(), screen: Some("twx-services".into()), content };
    let blocks = references(&[r("{\"a\":1}".into())]).unwrap();
    let msg = Message::new(Role::User, blocks);
    assert!(msg.prompt_text().starts_with("<pinned kind=\"service\" label=\"GetX\" screen=\"twx-services\">"));
    let big = references(&[r("x".repeat(REFERENCE_LIMIT * 2))]).unwrap();
    assert!(matches!(&big[0], Block::Reference { content, .. } if content.len() < REFERENCE_LIMIT + 200));
    assert!(references(&vec![r("x".into()); MAX_REFERENCES + 1]).is_err());
    assert!(references(&vec![r("x".repeat(REFERENCE_LIMIT)); 6]).is_err());
  }
}
