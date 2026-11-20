//! Long chats get summarised. Every model call re-reads the whole
//! conversation, so once the part since the last summary passes Settings →
//! "Summarise chats after" (KB), the model that just answered writes a summary
//! of it, while that conversation is still in its cache. The summary is stored
//! as a message ([`Message::summary_of`]); from then on models see it instead
//! of everything before it ([`visible`]), and an agent CLI starts a new session
//! from it.

use std::sync::Arc;

use tokio_util::sync::CancellationToken;

use super::events::AssistantEvent;
use super::providers::{self, ApiRequest};
use super::runner::{SendRequest, sanitize};
use super::types::{Block, Chat, Message, Role};
use super::{Assistant, store};
use crate::{CoreError, Result};

const PROMPT: &str = "This conversation is getting long. Write a summary of it that will replace \
everything above: from now on you will see only this summary, not the earlier messages or tool results. Keep \
what is needed to carry on: the user's goals and requests, decisions made, the important facts (entity, \
service, file and environment names, ids, values), what was changed and where, and open questions and next \
steps. Leave out raw tool output; say which tool to call again if details are needed. Do not call any tools. \
Reply with the summary only, in Markdown, in at most about 600 words.";

/// What a summary message starts with, so the model knows what it is reading.
pub const HEADER: &str = "Summary of the earlier conversation (the messages before it are no longer shown):";

const SUMMARY_MAX_TOKENS: u32 = 4_000;
/// Fewer messages than this since the last summary are never summarised.
const MIN_MESSAGES: usize = 6;
/// An image's share of the size estimate.
const IMAGE_BYTES: usize = 6_000;

/// Index of the last summary, where what a model sees starts; 0 without one.
pub fn start(messages: &[Message]) -> usize {
  messages.iter().rposition(|m| m.summary_of.is_some()).unwrap_or(0)
}

/// The messages a model sees: the last summary and everything after it.
pub fn visible(messages: &[Message]) -> &[Message] {
  &messages[start(messages)..]
}

/// Rough size in bytes of what a model reads of these messages.
pub fn size(messages: &[Message]) -> usize {
  messages
    .iter()
    .flat_map(|m| &m.blocks)
    .map(|b| match b {
      Block::Text { text } => text.len(),
      Block::ToolUse { name, input, .. } => name.len() + input.to_string().len(),
      Block::ToolResult { content, .. } => content.len(),
      Block::Opaque { data, .. } => data.to_string().len(),
      Block::Attachment { content, .. } | Block::Reference { content, .. } => content.len(),
      Block::Image { .. } => IMAGE_BYTES,
    })
    .sum()
}

/// Whether the part since the last summary is over `limit_kb` (0 = never).
pub fn due(messages: &[Message], limit_kb: u32) -> bool {
  let tail = visible(messages);
  limit_kb > 0 && tail.len() >= MIN_MESSAGES && size(tail) > limit_kb as usize * 1024
}

impl Assistant {
  /// Summarises the chat when it is due (best effort: a failure is logged and
  /// the chat simply stays long).
  pub(crate) async fn compact_if_due(
    self: &Arc<Self>,
    chat: &mut Chat,
    req: &SendRequest,
    cancel: &CancellationToken,
  ) {
    let limit = self.settings().await.map(|s| s.compact_after_kb).unwrap_or(0);
    if cancel.is_cancelled() || !due(&chat.messages, limit) {
      return;
    }
    self.emit(AssistantEvent::Status { chat_id: chat.id.clone(), text: "Summarising the earlier conversation".into() });
    if let Err(e) = self.compact(chat, req, cancel).await {
      super::log_warn(&format!("assistant: could not summarise chat {}: {e}", chat.id));
    }
  }

  async fn compact(self: &Arc<Self>, chat: &mut Chat, req: &SendRequest, cancel: &CancellationToken) -> Result<()> {
    let covered = chat.messages.len() - start(&chat.messages);
    let (text, usage) = if providers::is_api(&req.provider) {
      self.summary_from_api(chat, req, cancel).await?
    } else {
      self.summary_from_cli(chat, req, cancel).await?
    };
    let text = text.trim();
    if text.is_empty() {
      return Err(CoreError::Invalid("The model returned an empty summary.".into()));
    }
    let mut msg = Message::new(Role::User, vec![Block::Text { text: format!("{HEADER}\n\n{text}") }]);
    msg.summary_of = Some(covered as u32);
    msg.provider = Some(req.provider.clone());
    msg.model = Some(req.model.clone());
    self.record_usage(&chat.id, &msg.id, &req.provider, &req.model, &usage).await;
    let pool = self.pool().await;
    // A CLI session holds the old conversation; the next turn starts a new one from the summary.
    store::clear_session(&pool, &chat.id).await?;
    chat.messages.push(msg.clone());
    store::save(&pool, chat).await?;
    self.emit(AssistantEvent::MessageSaved { chat_id: chat.id.clone(), message: msg });
    Ok(())
  }

  /// One more call with the turn's own system prompt and tools, so it reads from the cache.
  async fn summary_from_api(&self, chat: &Chat, req: &SendRequest, cancel: &CancellationToken) -> Result<(String, super::usage::Usage)> {
    let settings = self.settings().await?;
    let api_key = if req.provider == "anthropic" { settings.anthropic_key() } else { settings.openrouter_key() };
    let mut messages = sanitize(visible(&chat.messages));
    messages.push(Message::new(Role::User, vec![Block::Text { text: PROMPT.into() }]));
    let request = ApiRequest {
      api_key,
      model: req.model.clone(),
      system: self.system_for(&req.skills)?,
      messages: sanitize(&messages),
      tools: self.tool_specs_for(&chat.id).await,
      max_tokens: SUMMARY_MAX_TOKENS,
      effort: req.effort.clone(),
    };
    let quiet = |_: &str| {};
    let reply = match req.provider.as_str() {
      "anthropic" => providers::anthropic::complete(&request, &quiet, &quiet, cancel).await?,
      _ => providers::openrouter::complete(&request, &quiet, &quiet, cancel).await?,
    };
    let text = Message::new(Role::Assistant, reply.blocks).text();
    Ok((text, reply.usage))
  }

  /// Resumes the session the turn just used (its context is cached), else
  /// starts one from the transcript.
  async fn summary_from_cli(
    self: &Arc<Self>,
    chat: &Chat,
    req: &SendRequest,
    cancel: &CancellationToken,
  ) -> Result<(String, super::usage::Usage)> {
    let session = store::session(&self.pool().await, &chat.id)
      .await?
      .filter(|s| s.provider == req.provider && s.model == req.model && s.turn_count == chat.messages.len() as i64)
      .map(|s| s.session_id);
    let prompt = match &session {
      Some(_) => PROMPT.to_string(),
      None => format!("{}\n\n---\n{PROMPT}", super::runner::transcript(&chat.messages)),
    };
    let token = self.turn_token(&chat.id);
    let request = self.cli_request(req, prompt, session, &token, Vec::new()).await;
    let quiet = |_: &str| {};
    let reply = match request {
      Ok(request) => providers::cli::run(&self.procs, request, &quiet, &quiet, &quiet, None, None, cancel).await,
      Err(e) => Err(e),
    };
    self.drop_turn_token(&token);
    let reply = reply?;
    Ok((reply.text, reply.usage))
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  fn text(role: Role, t: &str) -> Message {
    Message::new(role, vec![Block::Text { text: t.into() }])
  }

  #[test]
  fn due_counts_only_what_follows_the_last_summary() {
    let big = "x".repeat(30 * 1024);
    let mut msgs: Vec<Message> = (0..6).map(|i| text(if i % 2 == 0 { Role::User } else { Role::Assistant }, &big)).collect();
    assert!(due(&msgs, 150));
    assert!(!due(&msgs, 0));
    assert!(!due(&msgs, 200));
    let mut summary = text(Role::User, "sum");
    summary.summary_of = Some(6);
    msgs.push(summary);
    assert!(!due(&msgs, 150));
    assert_eq!(visible(&msgs).len(), 1);
    assert_eq!(start(&msgs), 6);
  }
}
