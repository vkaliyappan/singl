//! OpenRouter, speaking the OpenAI chat-completions protocol (what the OpenAI
//! SDKs speak), streamed. The stored format is Anthropic-shaped, so the
//! conversion splits tool results into `tool` messages and folds tool uses
//! into the assistant message's `tool_calls`.

use std::collections::BTreeMap;

use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use super::{ApiReply, ApiRequest, TextSink, sse};
use crate::assistant::types::{Block, Message, ModelInfo, Role};
use crate::{CoreError, Result};

fn base() -> String {
  let base = std::env::var("OPENROUTER_BASE_URL").ok().filter(|b| !b.trim().is_empty());
  base.as_deref().unwrap_or("https://openrouter.ai/api/v1").trim_end_matches('/').to_string()
}

/// The system prompt plus the stored conversation as chat-completions messages.
pub fn convert_messages(system: &str, messages: &[Message]) -> Vec<Value> {
  let mut out = vec![json!({"role": "system", "content": system})];
  for m in messages {
    match m.role {
      Role::User => {
        // Tool messages must directly follow the assistant's tool_calls, so
        // they go before any text the user added.
        for b in &m.blocks {
          if let Block::ToolResult { tool_use_id, content, is_error } = b {
            let content = if *is_error { format!("Error: {content}") } else { content.clone() };
            out.push(json!({"role": "tool", "tool_call_id": tool_use_id, "content": content}));
          }
        }
        let text = m.prompt_text();
        let images: Vec<Value> = m
          .images()
          .map(|(_, media_type, data)| json!({"type": "image_url", "image_url": {"url": format!("data:{media_type};base64,{data}")}}))
          .collect();
        if !images.is_empty() {
          let mut parts = Vec::new();
          if !text.trim().is_empty() {
            parts.push(json!({"type": "text", "text": text}));
          }
          parts.extend(images);
          out.push(json!({"role": "user", "content": parts}));
        } else if !text.trim().is_empty() {
          out.push(json!({"role": "user", "content": text}));
        }
      }
      Role::Assistant => {
        let text = m.text();
        let calls: Vec<Value> = m
          .blocks
          .iter()
          .filter_map(|b| match b {
            Block::ToolUse { id, name, input } => {
              Some(json!({"id": id, "type": "function", "function": {"name": name, "arguments": input.to_string()}}))
            }
            _ => None,
          })
          .collect();
        if text.trim().is_empty() && calls.is_empty() {
          continue;
        }
        let mut msg = json!({"role": "assistant", "content": if text.trim().is_empty() { Value::Null } else { Value::String(text) }});
        if !calls.is_empty() {
          msg["tool_calls"] = Value::Array(calls);
        }
        out.push(msg);
      }
    }
  }
  out
}

pub fn build_body(req: &ApiRequest) -> Value {
  let mut body = json!({
    "model": req.model,
    "max_tokens": req.max_tokens,
    "stream": true,
    "usage": {"include": true},
    "messages": convert_messages(&req.system, &req.messages),
  });
  if !req.effort.is_empty() {
    body["reasoning"] = json!({"effort": req.effort});
  }
  if !req.tools.is_empty() {
    body["tools"] = req
      .tools
      .iter()
      .map(|t| json!({"type": "function", "function": {"name": t.name, "description": t.description, "parameters": t.input_schema}}))
      .collect();
    body["tool_choice"] = json!("auto");
  }
  body
}

#[derive(Default)]
struct Call {
  id: String,
  name: String,
  args: String,
}

/// Folds stream chunks into the reply. Tool calls arrive as fragments keyed by `index`.
#[derive(Default)]
pub struct Accumulator {
  text: String,
  reasoning: String,
  calls: BTreeMap<u64, Call>,
  finish_reason: String,
  usage: super::super::usage::Usage,
}

impl Accumulator {
  pub fn feed(&mut self, data: &str, on_text: TextSink<'_>, on_thinking: TextSink<'_>) -> Result<()> {
    let data = data.trim();
    if data == "[DONE]" {
      return Ok(());
    }
    let Ok(chunk) = serde_json::from_str::<Value>(data) else { return Ok(()) };
    if let Some(err) = chunk.get("error").filter(|e| !e.is_null()) {
      let msg = err["message"].as_str().or_else(|| err.as_str()).unwrap_or("The provider reported an error.");
      return Err(CoreError::Invalid(msg.to_string()));
    }
    if chunk["usage"].is_object() {
      self.usage = super::super::usage::Usage::from_openai(&chunk["usage"]);
    }
    let choice = &chunk["choices"][0];
    if let Some(t) = choice["delta"]["reasoning"].as_str().filter(|t| !t.is_empty()) {
      self.reasoning.push_str(t);
      on_thinking(t);
    }
    if let Some(t) = choice["delta"]["content"].as_str().filter(|t| !t.is_empty()) {
      self.text.push_str(t);
      on_text(t);
    }
    if let Some(calls) = choice["delta"]["tool_calls"].as_array() {
      for (pos, c) in calls.iter().enumerate() {
        let call = self.calls.entry(c["index"].as_u64().unwrap_or(pos as u64)).or_default();
        if let Some(id) = c["id"].as_str().filter(|s| !s.is_empty()) {
          call.id = id.to_string();
        }
        let f = &c["function"];
        // Some gateways repeat the whole name on every fragment; others split it.
        if let Some(n) = f["name"].as_str().filter(|s| !s.is_empty()) {
          if call.name.is_empty() {
            call.name = n.to_string();
          } else if call.name != n {
            call.name.push_str(n);
          }
        }
        if let Some(a) = f["arguments"].as_str() {
          call.args.push_str(a);
        }
      }
    }
    if let Some(r) = choice["finish_reason"].as_str() {
      self.finish_reason = r.to_string();
    }
    Ok(())
  }

  pub fn finish(self) -> ApiReply {
    let mut blocks: Vec<Block> = super::shown_thinking(self.reasoning).into_iter().collect();
    if !self.text.is_empty() {
      blocks.push(Block::Text { text: self.text });
    }
    for (_, c) in self.calls {
      if c.name.is_empty() {
        continue;
      }
      let id = if c.id.is_empty() { format!("call_{}", uuid::Uuid::new_v4().simple()) } else { c.id };
      let input = if c.args.trim().is_empty() { json!({}) } else { serde_json::from_str(&c.args).unwrap_or_else(|_| json!({})) };
      blocks.push(Block::ToolUse { id, name: c.name, input });
    }
    let has_tools = blocks.iter().any(|b| matches!(b, Block::ToolUse { .. }));
    let mut stop_reason = match self.finish_reason.as_str() {
      "tool_calls" => "tool_use".to_string(),
      "stop" | "" => "end_turn".to_string(),
      "length" => "max_tokens".to_string(),
      other => other.to_string(),
    };
    // Some models say "stop" while still asking for tools.
    if has_tools && stop_reason == "end_turn" {
      stop_reason = "tool_use".into();
    }
    ApiReply { blocks, stop_reason, usage: self.usage }
  }
}

pub async fn complete(req: &ApiRequest, on_text: TextSink<'_>, on_thinking: TextSink<'_>, cancel: &CancellationToken) -> Result<ApiReply> {
  let client = sse::client()?;
  let url = format!("{}/chat/completions", base());
  let body = build_body(req);
  let res = sse::open("OpenRouter", cancel, || {
    client
      .post(&url)
      .bearer_auth(req.api_key.trim())
      .header("X-Title", "singl")
      .header("HTTP-Referer", "https://singl.app")
      .json(&body)
  })
  .await?;
  let mut acc = Accumulator::default();
  sse::read_events(res, cancel, |data| acc.feed(data, on_text, on_thinking)).await?;
  Ok(acc.finish())
}

pub async fn models(api_key: &str) -> Result<Vec<ModelInfo>> {
  let cancel = CancellationToken::new();
  let client = sse::client()?;
  let url = format!("{}/models", base());
  let res = sse::open("OpenRouter", &cancel, || {
    let req = client.get(&url).timeout(std::time::Duration::from_secs(20));
    // The list is public; a key is sent only when there is one.
    if api_key.trim().is_empty() { req } else { req.bearer_auth(api_key.trim()) }
  })
  .await?;
  let v: Value = res.json().await.map_err(|e| CoreError::Invalid(format!("OpenRouter models: {e}")))?;
  let mut list: Vec<ModelInfo> = v["data"]
    .as_array()
    .map(|a| {
      a.iter()
        .filter_map(|m| {
          let id = m["id"].as_str()?;
          Some(ModelInfo { id: id.to_string(), name: m["name"].as_str().unwrap_or(id).to_string() })
        })
        .collect()
    })
    .unwrap_or_default();
  list.sort_by_key(|m| m.name.to_lowercase());
  Ok(list)
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::assistant::tools::{Risk, ToolSpec};
  use std::sync::Mutex;

  fn msg(role: Role, blocks: Vec<Block>) -> Message {
    Message::new(role, blocks)
  }

  #[test]
  fn converts_conversation() {
    let out = convert_messages(
      "sys",
      &[
        msg(Role::User, vec![Block::Text { text: "go".into() }]),
        msg(
          Role::Assistant,
          vec![
            Block::Text { text: "on it".into() },
            Block::ToolUse { id: "a".into(), name: "ls".into(), input: json!({"p": "."}) },
            Block::ToolUse { id: "b".into(), name: "cat".into(), input: json!({}) },
          ],
        ),
        msg(
          Role::User,
          vec![
            Block::Text { text: "also".into() },
            Block::ToolResult { tool_use_id: "a".into(), content: "files".into(), is_error: false },
            Block::ToolResult { tool_use_id: "b".into(), content: "nope".into(), is_error: true },
          ],
        ),
        msg(Role::Assistant, vec![Block::ToolUse { id: "c".into(), name: "x".into(), input: json!({}) }]),
      ],
    );
    assert_eq!(out[0], json!({"role": "system", "content": "sys"}));
    assert_eq!(out[1], json!({"role": "user", "content": "go"}));
    assert_eq!(out[2]["content"], "on it");
    assert_eq!(out[2]["tool_calls"][0]["function"], json!({"name": "ls", "arguments": "{\"p\":\".\"}"}));
    assert_eq!(out[2]["tool_calls"][1]["id"], "b");
    // Tool messages first, then the user's own text.
    assert_eq!(out[3], json!({"role": "tool", "tool_call_id": "a", "content": "files"}));
    assert_eq!(out[4], json!({"role": "tool", "tool_call_id": "b", "content": "Error: nope"}));
    assert_eq!(out[5], json!({"role": "user", "content": "also"}));
    assert_eq!(out[6]["content"], Value::Null);
    assert!(out[1].get("tool_calls").is_none());
  }

  #[test]
  fn body_omits_tools_when_empty() {
    let mut req = ApiRequest { api_key: "k".into(), model: "m".into(), system: "s".into(), messages: vec![], tools: vec![], max_tokens: 10, effort: String::new() };
    let b = build_body(&req);
    assert!(b.get("tools").is_none() && b.get("tool_choice").is_none());
    req.tools.push(ToolSpec { name: "t".into(), description: "d".into(), input_schema: json!({"type": "object"}), risk: Risk::Read, external_only: false });
    let b = build_body(&req);
    assert_eq!(b["tools"][0]["function"]["parameters"], json!({"type": "object"}));
    assert_eq!(b["tool_choice"], "auto");
  }

  fn run(lines: &[&str]) -> (Result<ApiReply>, String) {
    let seen = Mutex::new(String::new());
    let on_text = |t: &str| seen.lock().unwrap().push_str(t);
    let mut acc = Accumulator::default();
    for l in lines {
      if let Some(d) = sse::data_of(l) {
        if let Err(e) = acc.feed(d, &on_text, &|_| {}) {
          return (Err(e), seen.into_inner().unwrap());
        }
      }
    }
    (Ok(acc.finish()), seen.into_inner().unwrap())
  }

  #[test]
  fn accumulates_tool_call_fragments() {
    let (reply, text) = run(&[
      ": OPENROUTER PROCESSING",
      r#"data: {"choices":[{"delta":{"role":"assistant","content":"Look"}}]}"#,
      r#"data: {"choices":[{"delta":{"content":"ing"}}]}"#,
      r#"data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"find","arguments":""}}]}}]}"#,
      r#"data: {"choices":[{"delta":{"tool_calls":[{"index":1,"id":"","function":{"name":"bad","arguments":"{oops"}}]}}]}"#,
      r#"data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\"q\":"}}]}}]}"#,
      r#"data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\"x\"}"}}]}}]}"#,
      r#"data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}"#,
      "data: [DONE]",
    ]);
    let reply = reply.unwrap();
    assert_eq!(text, "Looking");
    assert_eq!(reply.stop_reason, "tool_use");
    assert_eq!(reply.blocks.len(), 3);
    assert_eq!(reply.blocks[0], Block::Text { text: "Looking".into() });
    assert_eq!(reply.blocks[1], Block::ToolUse { id: "call_1".into(), name: "find".into(), input: json!({"q": "x"}) });
    match &reply.blocks[2] {
      Block::ToolUse { id, name, input } => {
        assert!(id.starts_with("call_") && id.len() > 6);
        assert_eq!(name, "bad");
        assert_eq!(input, &json!({}));
      }
      other => panic!("{other:?}"),
    }
  }

  #[test]
  fn reasoning_is_streamed_and_kept_for_display() {
    let thought = Mutex::new(String::new());
    let on_thinking = |t: &str| thought.lock().unwrap().push_str(t);
    let mut acc = Accumulator::default();
    for d in [r#"{"choices":[{"delta":{"reasoning":"Hmm"}}]}"#, r#"{"choices":[{"delta":{"content":"Hi"}}]}"#] {
      acc.feed(d, &|_| {}, &on_thinking).unwrap();
    }
    assert_eq!(thought.into_inner().unwrap(), "Hmm");
    let blocks = acc.finish().blocks;
    assert_eq!(blocks[0], Block::Opaque { provider: "ui".into(), data: json!({"type": "thinking", "thinking": "Hmm"}) });
    assert_eq!(blocks[1], Block::Text { text: "Hi".into() });
    // Never sent back.
    assert_eq!(convert_messages("s", &[msg(Role::Assistant, blocks)])[1]["content"], "Hi");
  }

  #[test]
  fn maps_finish_reasons() {
    let r = |reason: &str| run(&[&format!(r#"data: {{"choices":[{{"delta":{{"content":"x"}},"finish_reason":"{reason}"}}]}}"#)]).0.unwrap().stop_reason;
    assert_eq!(r("stop"), "end_turn");
    assert_eq!(r("length"), "max_tokens");
    assert_eq!(r("content_filter"), "content_filter");
  }

  #[test]
  fn error_chunk_fails() {
    let (r, _) = run(&[r#"data: {"error":{"code":429,"message":"Rate limited"}}"#]);
    assert_eq!(r.unwrap_err().to_string(), "Rate limited");
  }

  /// `OPENROUTER_API_KEY=... cargo test -p singl-core openrouter_live -- --ignored`
  #[tokio::test]
  #[ignore]
  async fn openrouter_live() {
    let key = std::env::var("OPENROUTER_API_KEY").unwrap();
    assert!(!models("").await.unwrap().is_empty());
    let req = ApiRequest {
      api_key: key,
      model: "openai/gpt-4o-mini".into(),
      system: "Reply with one word.".into(),
      messages: vec![msg(Role::User, vec![Block::Text { text: "Say hi".into() }])],
      tools: vec![],
      max_tokens: 50,
      effort: String::new(),
    };
    let reply = complete(&req, &|_| {}, &|_| {}, &CancellationToken::new()).await.unwrap();
    assert!(!reply.blocks.is_empty());
  }
}
