//! Sub-agents: the assistant hands a self-contained piece of work to a fresh
//! model call with its own tool loop and gets back only the answer.
//!
//! The user controls them per message from the composer ([`SubAgentSettings`]):
//! on or off, which models, how many at once, how many per message and how
//! many steps each.
//!
//! * API providers (Anthropic, OpenRouter): the turn gets the `agent_task`
//!   tool; each call runs [`super::Assistant::api_loop`] on a scratch history
//!   with the same tools (minus `agent_task`), approvals and cancel token.
//! * Claude Code: the picked models become `--agents` definitions, and turning
//!   sub-agents off denies its `Task`/`Agent` tool. Counts can only be asked
//!   for in the prompt there.
//! * Other CLIs: their own behaviour; the settings do not reach them.

use std::sync::Arc;
use std::sync::atomic::{AtomicU32, Ordering};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::sync::Semaphore;

use super::Assistant;
use super::tools::{Args, CallMeta, Risk, ToolFuture, ToolSpec};
use super::types::{Block, Message, Role};
use crate::{CoreError, Result};

/// What the model is told when the user stops one sub-agent.
const STOPPED: &str = "The user stopped this sub-agent before it finished. Do not start it again unless they ask; carry on without its answer or tell the user what is missing.";

/// Why a sub-agent ended early: the whole turn was cancelled, or the user stopped just it.
fn stopped(turn: &tokio_util::sync::CancellationToken) -> CoreError {
  if turn.is_cancelled() { CoreError::Cancelled } else { CoreError::Invalid(STOPPED.into()) }
}

/// The tool a turn uses to start a sub-agent.
pub const TOOL: &str = "agent_task";
/// Sub-agent tool calls carry this source plus the parent call id, so the UI
/// can show them inside the sub-agent's card.
pub const SOURCE_PREFIX: &str = "sub-agent:";

pub const PARALLEL_RANGE: (u32, u32) = (1, 8);
pub const PER_TURN_RANGE: (u32, u32) = (1, 20);
pub const STEPS_RANGE: (u32, u32) = (3, 40);

/// Models used when the user picked none: one strong, one fast.
pub const DEFAULT_CLAUDE_MODELS: [&str; 2] = ["claude-sonnet-5-5", "claude-haiku-5-5"];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SubAgentSettings {
  #[serde(default)]
  pub enabled: bool,
  /// Model ids of the turn's provider; empty = [`default_models`].
  #[serde(default)]
  pub models: Vec<String>,
  /// How many run at the same time.
  #[serde(default = "default_parallel")]
  pub max_parallel: u32,
  /// How many one message may start.
  #[serde(default = "default_per_turn")]
  pub max_per_turn: u32,
  /// Model calls each sub-agent may make.
  #[serde(default = "default_steps")]
  pub max_steps: u32,
  /// Reasoning effort for sub-agents; empty = the message's own.
  #[serde(default)]
  pub effort: String,
  /// Nudge the model to split broad work across sub-agents.
  #[serde(default)]
  pub prefer: bool,
}

fn default_parallel() -> u32 {
  3
}
fn default_per_turn() -> u32 {
  5
}
fn default_steps() -> u32 {
  15
}

impl Default for SubAgentSettings {
  fn default() -> Self {
    Self {
      enabled: false,
      models: Vec::new(),
      max_parallel: default_parallel(),
      max_per_turn: default_per_turn(),
      max_steps: default_steps(),
      effort: String::new(),
      prefer: false,
    }
  }
}

/// The models a provider's sub-agents use when none were picked.
pub fn default_models(provider: &str, parent_model: &str) -> Vec<String> {
  match provider {
    "anthropic" | "claude" => DEFAULT_CLAUDE_MODELS.iter().map(|m| m.to_string()).collect(),
    _ if !parent_model.is_empty() => vec![parent_model.to_string()],
    _ => Vec::new(),
  }
}

impl SubAgentSettings {
  /// Clamped limits, trimmed and de-duplicated models (defaults when empty),
  /// effort checked against the provider.
  pub fn normalized(mut self, provider: &str, parent_model: &str) -> Self {
    let clamp = |v: u32, (lo, hi): (u32, u32)| v.clamp(lo, hi);
    self.max_parallel = clamp(self.max_parallel, PARALLEL_RANGE);
    self.max_per_turn = clamp(self.max_per_turn, PER_TURN_RANGE);
    self.max_steps = clamp(self.max_steps, STEPS_RANGE);
    self.max_parallel = self.max_parallel.min(self.max_per_turn);
    let mut models: Vec<String> = Vec::new();
    for m in self.models.iter().map(|m| m.trim()).filter(|m| !m.is_empty()) {
      if !models.iter().any(|x| x == m) {
        models.push(m.to_string());
      }
    }
    self.models = if models.is_empty() { default_models(provider, parent_model) } else { models };
    self.effort = super::providers::normalize_effort(provider, &self.effort);
    self
  }
}

/// What a model is good for, so the parent can pick by the work.
pub fn model_hint(model: &str) -> &'static str {
  let m = model.to_lowercase();
  if m.contains("haiku") {
    "fast and cheap: lookups, searches, reading a few files or entities, listing, summarising"
  } else if m.contains("sonnet") {
    "strong: multi-step investigation, comparing, debugging, reviewing or drafting code changes"
  } else if m.contains("opus") || m.contains("fable") {
    "strongest and slowest: the hardest reasoning and design questions"
  } else {
    "general work"
  }
}

/// Display name: the known Claude name, else the id.
pub fn model_name(model: &str) -> String {
  super::providers::CLAUDE_MODELS
    .iter()
    .find(|(id, _)| *id == model)
    .map(|(_, name)| name.to_string())
    .unwrap_or_else(|| model.to_string())
}

/// The system prompt section that tells the parent how to use sub-agents.
pub fn prompt_section(s: &SubAgentSettings, tool_name: &str) -> String {
  let models: Vec<String> =
    s.models.iter().map(|m| format!("- `{m}` ({}): {}", model_name(m), model_hint(m))).collect();
  let when = if s.prefer {
    "The user prefers sub-agents: hand broad searches, independent parts of the work and long reads to them, \
     and keep your own context for planning and the final answer."
  } else {
    "Use them when the work splits into independent parts or needs a broad search whose details you do not \
     need to keep; do small, quick things yourself."
  };
  format!(
    "\n\n## Sub-agents\n\
     You can hand self-contained work to sub-agents with `{tool_name}`. A sub-agent starts with no memory of \
     this chat: its prompt must say everything it needs (ids, names, paths, what to return). It has the same \
     tools as you, except starting sub-agents, and returns only its final answer.\n\
     {when}\n\
     Pick the model by the work:\n{}\n\
     Limits for this message: at most {} sub-agents in total and {} at the same time; each gets at most {} \
     steps. Several sub-agent calls in one reply run in parallel.",
    models.join("\n"),
    s.max_per_turn,
    s.max_parallel,
    s.max_steps,
  )
}

/// The instructions a sub-agent works under, after the parent's system prompt.
const CHILD_SECTION: &str = "\n\n## You are a sub-agent\n\
Another assistant gave you one task. Do it with your tools, then answer with what it asked for: findings, \
names, paths, values, the change made. Be complete but short; nobody sees your work, only the answer. \
You cannot ask the user anything: if something is unclear, make the best reasonable choice and say so.";

/// Claude Code agent name for a model: `singl-haiku-5-5`.
pub fn claude_agent_name(model: &str) -> String {
  let short: String = model
    .trim_start_matches("claude-")
    .chars()
    .map(|c| if c.is_ascii_alphanumeric() { c.to_ascii_lowercase() } else { '-' })
    .collect();
  format!("singl-{short}")
}

/// The `--agents` JSON for Claude Code: one agent per picked model.
pub fn claude_agents_json(s: &SubAgentSettings) -> String {
  let mut agents = serde_json::Map::new();
  for m in &s.models {
    agents.insert(
      claude_agent_name(m),
      json!({
        "description": format!("Runs on {}. Use for {}.", model_name(m), model_hint(m)),
        "prompt": CHILD_SECTION.trim_start(),
        "model": m,
      }),
    );
  }
  Value::Object(agents).to_string()
}

/// What Claude Code is told about sub-agents. Its counts have no flag, so they
/// are asked for here.
pub fn claude_prompt_section(s: &SubAgentSettings) -> String {
  if !s.enabled {
    return String::new();
  }
  let agents: Vec<String> =
    s.models.iter().map(|m| format!("- `{}` ({}): {}", claude_agent_name(m), model_name(m), model_hint(m))).collect();
  let when = if s.prefer {
    "The user prefers sub-agents: hand broad searches and independent parts of the work to them."
  } else {
    "Use them when the work splits into independent parts or needs a broad search; do small things yourself."
  };
  format!(
    "\n\n## Sub-agents\n{when}\nUse only these sub-agent types, picked by the work:\n{}\n\
     Start at most {} sub-agents for this message and at most {} at the same time. A sub-agent has not seen \
     this chat: give it everything it needs in its prompt.",
    agents.join("\n"),
    s.max_per_turn,
    s.max_parallel,
  )
}

/// A running turn's sub-agent budget.
pub struct Turn {
  pub settings: SubAgentSettings,
  pub provider: String,
  /// The message's own reasoning effort, for sub-agents that do not set one.
  pub effort: String,
  /// Skills picked for the message, so sub-agents get the same instructions.
  pub skills: Vec<String>,
  started: AtomicU32,
  gate: Semaphore,
}

impl Turn {
  pub fn new(settings: SubAgentSettings, provider: &str, effort: &str, skills: Vec<String>) -> Self {
    let gate = Semaphore::new(settings.max_parallel as usize);
    Self { settings, provider: provider.into(), effort: effort.into(), skills, started: AtomicU32::new(0), gate }
  }

  /// Takes one sub-agent from the message's budget.
  fn claim(&self) -> Result<()> {
    let n = self.started.fetch_add(1, Ordering::SeqCst) + 1;
    if n > self.settings.max_per_turn {
      return Err(CoreError::Invalid(format!(
        "The sub-agent limit for this message ({}) is used up. Finish the work yourself.",
        self.settings.max_per_turn
      )));
    }
    Ok(())
  }
}

/// The `agent_task` definition offered to a turn with these settings.
pub fn spec(s: &SubAgentSettings) -> ToolSpec {
  let first = s.models.first().cloned().unwrap_or_default();
  let models: Vec<String> = s.models.iter().map(|m| format!("{m} ({})", model_hint(m))).collect();
  ToolSpec {
    name: TOOL.into(),
    description: format!(
      "Start a sub-agent: a separate assistant with your tools (but no sub-agents of its own) that does one \
       self-contained task and returns only its final answer, keeping its tool output out of your context. \
       Several calls in one reply run in parallel. Models: {}.",
      models.join("; ")
    ),
    input_schema: json!({
      "type": "object",
      "properties": {
        "description": {"type": "string", "description": "3 to 6 words for the user, e.g. \"Find callers of GetBOM\"."},
        "prompt": {"type": "string", "description": "The whole task: context, ids, names, paths, and what to return. The sub-agent has not seen this chat."},
        "model": {"type": "string", "enum": s.models, "description": format!("Which model does the work; default {first}.")},
      },
      "required": ["description", "prompt"],
    }),
    risk: Risk::Read,
    external_only: false,
  }
}

/// Runs one `agent_task` call. Boxed: the sub-agent's loop calls tools, and a
/// tool call can lead back here, so the future type must not be recursive.
pub fn run(a: Arc<Assistant>, args: Value, meta: CallMeta) -> ToolFuture {
  Box::pin(async move {
    let chat_id = meta.chat_id.clone().ok_or_else(|| CoreError::Invalid("Sub-agents run only inside a chat turn.".into()))?;
    if meta.source != "assistant" {
      return Err(CoreError::Invalid("A sub-agent cannot start another sub-agent.".into()));
    }
    let turn = a.sub_agent_turn(&chat_id).ok_or_else(|| CoreError::Invalid("Sub-agents are switched off for this message.".into()))?;
    let turn_cancel = a.turn_cancel(&chat_id).ok_or(CoreError::Cancelled)?;
    // Its own token: the user can stop this sub-agent alone, and stopping the turn stops it too.
    let cancel = turn_cancel.child_token();
    let _tracked = a.track_sub_agent(&meta.call_id, cancel.clone());
    let args = Args(&args);
    let prompt = args.need("prompt")?.to_string();
    let model = match args.str("model") {
      Some(m) if turn.settings.models.iter().any(|x| x == m) => m.to_string(),
      Some(m) => {
        return Err(CoreError::Invalid(format!(
          "\"{m}\" is not one of the sub-agent models the user allowed: {}.",
          turn.settings.models.join(", ")
        )));
      }
      None => turn.settings.models.first().cloned().ok_or_else(|| CoreError::Invalid("No sub-agent model is set.".into()))?,
    };
    turn.claim()?;
    let _slot = tokio::select! {
      p = turn.gate.acquire() => p.map_err(|_| CoreError::Cancelled)?,
      () = cancel.cancelled() => return Err(stopped(&turn_cancel)),
    };

    let tools: Vec<ToolSpec> = a.tool_specs_for(&chat_id).await.into_iter().filter(|t| t.name != TOOL).collect();
    let effort = if turn.settings.effort.is_empty() { turn.effort.clone() } else { turn.settings.effort.clone() };
    let job = super::runner::Job {
      provider: turn.provider.clone(),
      model,
      effort,
      skills: turn.skills.clone(),
      system_extra: CHILD_SECTION.into(),
      tools,
      max_steps: turn.settings.max_steps as usize,
      chat_id,
      source: format!("{SOURCE_PREFIX}{}", meta.call_id),
    };
    let mut history = super::runner::History::Scratch(vec![Message::new(Role::User, vec![Block::Text { text: prompt }])]);
    let answer = match a.api_loop(&job, &mut history, &|_| {}, &|_| {}, &cancel).await {
      Err(CoreError::Cancelled) => return Err(stopped(&turn_cancel)),
      other => other?,
    };
    if answer.trim().is_empty() {
      return Err(CoreError::Invalid("The sub-agent finished without an answer.".into()));
    }
    Ok(answer)
  })
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn settings_are_clamped_and_defaulted() {
    let s = SubAgentSettings {
      enabled: true,
      models: vec![" ".into()],
      max_parallel: 50,
      max_per_turn: 4,
      max_steps: 0,
      effort: "turbo".into(),
      prefer: false,
    }
    .normalized("anthropic", "claude-opus-5-5");
    assert_eq!(s.models, ["claude-sonnet-5-5", "claude-haiku-5-5"]);
    assert_eq!((s.max_parallel, s.max_per_turn, s.max_steps), (4, 4, STEPS_RANGE.0));
    assert_eq!(s.effort, "");
    let s = SubAgentSettings { models: vec!["a".into(), "a".into(), "b".into()], ..Default::default() }.normalized("openrouter", "x/y");
    assert_eq!(s.models, ["a", "b"]);
    let s = SubAgentSettings::default().normalized("openrouter", "x/y");
    assert_eq!(s.models, ["x/y"]);
  }

  #[test]
  fn budget_and_hints() {
    let t = Turn::new(SubAgentSettings { max_per_turn: 2, ..Default::default() }, "anthropic", "", Vec::new());
    assert!(t.claim().is_ok() && t.claim().is_ok());
    assert!(t.claim().is_err());
    assert!(model_hint("claude-haiku-5-5").starts_with("fast"));
    assert!(model_hint("claude-sonnet-5-5").starts_with("strong:"));
    let spec = spec(&SubAgentSettings::default().normalized("anthropic", ""));
    assert_eq!(spec.input_schema["properties"]["model"]["enum"], json!(["claude-sonnet-5-5", "claude-haiku-5-5"]));
    assert!(prompt_section(&SubAgentSettings::default().normalized("anthropic", ""), TOOL).contains("Haiku 5.5"));
  }
}
