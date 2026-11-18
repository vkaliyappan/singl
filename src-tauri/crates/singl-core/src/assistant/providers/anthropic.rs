//! Anthropic Messages API, streamed. The stored message format is already
//! Anthropic's, so conversion is close to one-to-one.

use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use super::{ApiReply, ApiRequest, TextSink, sse};
use crate::assistant::types::{Block, Message, ModelInfo, Role};
use crate::{CoreError, Result};

fn base() -> String {
  let base = std::env::var("ANTHROPIC_BASE_URL").ok().filter(|b| !b.trim().is_empty());
  base.as_deref().unwrap_or("https://api.anthropic.com").trim_end_matches('/').to_string()
}

/// Stored messages as the API wants them. The API rejects empty text blocks, so
/// they are dropped, and a message left with nothing is dropped too.
pub fn convert_messages(messages: &[Message]) -> Vec<Value> {
  messages
    .iter()
    .filter_map(|m| {
      let content: Vec<Value> = m
        .blocks
        .iter()
        .filter_map(|b| match b {
          Block::Text { text } if text.trim().is_empty() => None,
          Block::Text { text } => Some(json!({"type": "text", "text": text})),
          Block::ToolUse { id, name, input } => Some(json!({"type": "tool_use", "id": id, "name": name, "input": input})),
          Block::ToolResult { tool_use_id, content, is_error } => {
            Some(json!({"type": "tool_result", "tool_use_id": tool_use_id, "content": content, "is_error": is_error}))
          }
          // Thinking blocks go back unchanged; the API drops, unbilled, any it cannot read.
          Block::Opaque { provider, data } if provider == "anthropic" => Some(data.clone()),
          Block::Opaque { .. } => None,
          Block::Image { media_type, data, .. } => {
            Some(json!({"type": "image", "source": {"type": "base64", "media_type": media_type, "data": data}}))
          }
          b @ (Block::Attachment { .. } | Block::Reference { .. }) => {
            Some(json!({"type": "text", "text": b.context_prompt().unwrap_or_default()}))
          }
        })
        .collect();
      if content.is_empty() {
        return None;
      }
      let role = if m.role == Role::User { "user" } else { "assistant" };
      Some(json!({"role": role, "content": content}))
    })
    .collect()
}

/// The request body. `cache_control` on the system prompt and the last tool
/// makes everything up to there a cached prefix across a turn's model calls.
pub fn build_body(req: &ApiRequest) -> Value {
  let mut body = json!({
    "model": req.model,
    "max_tokens": req.max_tokens,
    "system": [{"type": "text", "text": req.system, "cache_control": {"type": "ephemeral"}}],
    "messages": convert_messages(&req.messages),
    "stream": true,
  });
  if !req.effort.is_empty() {
    body["output_config"] = json!({"effort": req.effort});
  }
  // Current models stream empty thinking unless asked for a summary.
  if adaptive_thinking(&req.model) {
    body["thinking"] = json!({"type": "adaptive", "display": "summarized"});
  }
  if !req.tools.is_empty() {
    let mut tools: Vec<Value> = req
      .tools
      .iter()
      .map(|t| json!({"name": t.name, "description": t.description, "input_schema": t.input_schema}))
      .collect();
    if let Some(last) = tools.last_mut() {
      last["cache_control"] = json!({"type": "ephemeral"});
    }
    body["tools"] = Value::Array(tools);
  }
  body
}

/// Models that take `thinking: {type: "adaptive"}`. Older ones (Haiku 4.5,
/// the 4.5 family and before) reject it, so they get no `thinking` field.
fn adaptive_thinking(model: &str) -> bool {
  let m = model.trim().to_ascii_lowercase();
  let m = m.rsplit('/').next().unwrap_or(&m);
  ["claude-fable-", "claude-mythos-", "claude-opus-5", "claude-sonnet-5", "claude-haiku-5", "claude-opus-4-6", "claude-opus-4-7", "claude-opus-4-8", "claude-sonnet-4-6"]
    .iter()
    .any(|p| m.starts_with(p))
}

/// The block being streamed. Blocks arrive one at a time, in order.
enum Open {
  Text(String),
  Tool { id: String, name: String, json: String },
  /// Kept verbatim (with its signature) to send back next request.
  Thinking { thinking: String, signature: String },
  /// Server tools and anything unknown: nothing to keep.
  Skip,
}

/// Folds stream events into the reply.
#[derive(Default)]
pub struct Accumulator {
  blocks: Vec<Block>,
  open: Option<Open>,
  stop_reason: String,
  usage: super::super::usage::Usage,
}

impl Accumulator {
  pub fn feed(&mut self, data: &str, on_text: TextSink<'_>, on_thinking: TextSink<'_>) -> Result<()> {
    let Ok(ev) = serde_json::from_str::<Value>(data) else { return Ok(()) };
    match ev["type"].as_str().unwrap_or("") {
      "content_block_start" => {
        let cb = &ev["content_block"];
        self.open = Some(match cb["type"].as_str() {
          Some("text") => {
            let text = cb["text"].as_str().unwrap_or("").to_string();
            if !text.is_empty() {
              on_text(&text);
            }
            Open::Text(text)
          }
          Some("tool_use") => Open::Tool {
            id: cb["id"].as_str().unwrap_or("").to_string(),
            name: cb["name"].as_str().unwrap_or("").to_string(),
            json: String::new(),
          },
          Some("thinking") => {
            let thinking = cb["thinking"].as_str().unwrap_or("").to_string();
            if !thinking.is_empty() {
              on_thinking(&thinking);
            }
            Open::Thinking { thinking, signature: cb["signature"].as_str().unwrap_or("").to_string() }
          }
          Some("redacted_thinking") => {
            self.blocks.push(Block::Opaque { provider: "anthropic".into(), data: cb.clone() });
            Open::Skip
          }
          _ => Open::Skip,
        });
      }
      "content_block_delta" => {
        let d = &ev["delta"];
        match (&mut self.open, d["type"].as_str()) {
          (Some(Open::Text(buf)), Some("text_delta")) => {
            let t = d["text"].as_str().unwrap_or("");
            if !t.is_empty() {
              buf.push_str(t);
              on_text(t);
            }
          }
          (Some(Open::Tool { json, .. }), Some("input_json_delta")) => json.push_str(d["partial_json"].as_str().unwrap_or("")),
          (Some(Open::Thinking { thinking, .. }), Some("thinking_delta")) => {
            let t = d["thinking"].as_str().unwrap_or("");
            if !t.is_empty() {
              thinking.push_str(t);
              on_thinking(t);
            }
          }
          (Some(Open::Thinking { signature, .. }), Some("signature_delta")) => {
            signature.push_str(d["signature"].as_str().unwrap_or(""))
          }
          _ => {}
        }
      }
      "content_block_stop" => match self.open.take() {
        Some(Open::Text(text)) if !text.is_empty() => self.blocks.push(Block::Text { text }),
        Some(Open::Tool { id, name, json }) => {
          let input = if json.trim().is_empty() { json!({}) } else { serde_json::from_str(&json).unwrap_or_else(|_| json!({})) };
          self.blocks.push(Block::ToolUse { id, name, input });
        }
        Some(Open::Thinking { thinking, signature }) => self.blocks.push(Block::Opaque {
          provider: "anthropic".into(),
          data: json!({"type": "thinking", "thinking": thinking, "signature": signature}),
        }),
        _ => {}
      },
      "message_start" => self.usage.merge_anthropic(&ev["message"]["usage"]),
      "message_delta" => {
        self.usage.merge_anthropic(&ev["usage"]);
        if let Some(r) = ev["delta"]["stop_reason"].as_str() {
          self.stop_reason = r.to_string();
        }
      }
      "error" => {
        let msg = ev["error"]["message"].as_str().unwrap_or("The Anthropic API reported an error.");
        return Err(CoreError::Invalid(msg.to_string()));
      }
      // message_stop, ping
      _ => {}
    }
    Ok(())
  }

  pub fn finish(self) -> ApiReply {
    let has_tools = self.blocks.iter().any(|b| matches!(b, Block::ToolUse { .. }));
    let stop_reason = if !self.stop_reason.is_empty() {
      self.stop_reason
    } else if has_tools {
      "tool_use".into()
    } else {
      "end_turn".into()
    };
    ApiReply { blocks: self.blocks, stop_reason, usage: self.usage }
  }
}

pub async fn complete(req: &ApiRequest, on_text: TextSink<'_>, on_thinking: TextSink<'_>, cancel: &CancellationToken) -> Result<ApiReply> {
  let client = sse::client()?;
  let url = format!("{}/v1/messages", base());
  let body = build_body(req);
  let res = sse::open("Anthropic", cancel, || {
    client
      .post(&url)
      .header("x-api-key", req.api_key.trim())
      .header("anthropic-version", "2023-06-01")
      .header("content-type", "application/json")
      .json(&body)
  })
  .await?;
  let mut acc = Accumulator::default();
  sse::read_events(res, cancel, |data| acc.feed(data, on_text, on_thinking)).await?;
  Ok(acc.finish())
}

pub async fn models(api_key: &str) -> Result<Vec<ModelInfo>> {
  if api_key.trim().is_empty() {
    return Ok(Vec::new());
  }
  let cancel = CancellationToken::new();
  let client = sse::client()?;
  let url = format!("{}/v1/models?limit=1000", base());
  let res = sse::open("Anthropic", &cancel, || {
    client
      .get(&url)
      .header("x-api-key", api_key.trim())
      .header("anthropic-version", "2023-06-01")
      .timeout(std::time::Duration::from_secs(15))
  })
  .await?;
  let v: Value = res.json().await.map_err(|e| CoreError::Invalid(format!("Anthropic models: {e}")))?;
  Ok(
    v["data"]
      .as_array()
      .map(|a| {
        a.iter()
          .filter_map(|m| {
            let id = m["id"].as_str()?;
            Some(ModelInfo { id: id.to_string(), name: m["display_name"].as_str().unwrap_or(id).to_string() })
          })
          .collect()
      })
      .unwrap_or_default(),
  )
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
  fn converts_blocks_and_skips_empty_text() {
    let out = convert_messages(&[
      msg(Role::User, vec![Block::Text { text: "hi".into() }, Block::Text { text: "  ".into() }]),
      msg(
        Role::Assistant,
        vec![Block::Text { text: String::new() }, Block::ToolUse { id: "t1".into(), name: "ls".into(), input: json!({"a": 1}) }],
      ),
      msg(Role::User, vec![Block::ToolResult { tool_use_id: "t1".into(), content: "ok".into(), is_error: true }]),
      msg(Role::Assistant, vec![Block::Text { text: String::new() }]),
    ]);
    assert_eq!(out.len(), 3);
    assert_eq!(out[0], json!({"role": "user", "content": [{"type": "text", "text": "hi"}]}));
    assert_eq!(out[1]["content"][0], json!({"type": "tool_use", "id": "t1", "name": "ls", "input": {"a": 1}}));
    assert_eq!(out[2]["content"][0], json!({"type": "tool_result", "tool_use_id": "t1", "content": "ok", "is_error": true}));
  }

  fn spec(name: &str) -> ToolSpec {
    ToolSpec { name: name.into(), description: "d".into(), input_schema: json!({"type": "object"}), risk: Risk::Read, external_only: false }
  }

  #[test]
  fn body_caches_system_and_last_tool() {
    let mut req = ApiRequest {
      api_key: "k".into(),
      model: "m".into(),
      system: "sys".into(),
      messages: vec![],
      tools: vec![spec("a"), spec("b")],
      max_tokens: 100,
      effort: String::new(),
    };
    let b = build_body(&req);
    assert_eq!(b["system"][0]["cache_control"]["type"], "ephemeral");
    assert!(b["tools"][0].get("cache_control").is_none());
    assert_eq!(b["tools"][1]["cache_control"]["type"], "ephemeral");
    assert_eq!(b["stream"], true);
    req.tools.clear();
    assert!(build_body(&req).get("tools").is_none());
    assert!(build_body(&req).get("output_config").is_none());
    req.effort = "high".into();
    assert_eq!(build_body(&req)["output_config"]["effort"], "high");
    assert!(build_body(&req).get("thinking").is_none());
    req.model = "claude-opus-5-5".into();
    assert_eq!(build_body(&req)["thinking"], json!({"type": "adaptive", "display": "summarized"}));
    req.model = "claude-haiku-4-5".into();
    assert!(build_body(&req).get("thinking").is_none());
  }

  /// One SSE event as bytes.
  fn ev(v: Value) -> String {
    format!("event: {}\ndata: {}\n\n", v["type"].as_str().unwrap(), v)
  }

  fn run(chunks: &[&[u8]]) -> (Result<ApiReply>, String) {
    let seen = Mutex::new(String::new());
    let on_text = |t: &str| seen.lock().unwrap().push_str(t);
    let mut split = sse::LineSplitter::default();
    let mut acc = Accumulator::default();
    for c in chunks {
      for line in split.push(c) {
        if let Some(d) = sse::data_of(&line) {
          if let Err(e) = acc.feed(d, &on_text, &|_| {}) {
            return (Err(e), seen.into_inner().unwrap());
          }
        }
      }
    }
    (Ok(acc.finish()), seen.into_inner().unwrap())
  }

  #[test]
  fn streams_text_and_tool_use_across_split_chunks() {
    let stream = [
      json!({"type": "message_start", "message": {}}),
      json!({"type": "ping"}),
      json!({"type": "content_block_start", "index": 0, "content_block": {"type": "thinking", "thinking": ""}}),
      json!({"type": "content_block_delta", "index": 0, "delta": {"type": "thinking_delta", "thinking": "hm"}}),
      json!({"type": "content_block_stop", "index": 0}),
      json!({"type": "content_block_start", "index": 1, "content_block": {"type": "text", "text": ""}}),
      json!({"type": "content_block_delta", "index": 1, "delta": {"type": "text_delta", "text": "Caf\u{e9} "}}),
      json!({"type": "content_block_delta", "index": 1, "delta": {"type": "text_delta", "text": "ok"}}),
      json!({"type": "content_block_stop", "index": 1}),
      json!({"type": "content_block_start", "index": 2, "content_block": {"type": "tool_use", "id": "tu1", "name": "search", "input": {}}}),
      json!({"type": "content_block_delta", "index": 2, "delta": {"type": "input_json_delta", "partial_json": "{\"q\":"}}),
      json!({"type": "content_block_delta", "index": 2, "delta": {"type": "input_json_delta", "partial_json": "\"x\"}"}}),
      json!({"type": "content_block_stop", "index": 2}),
      json!({"type": "content_block_start", "index": 3, "content_block": {"type": "tool_use", "id": "tu2", "name": "noargs", "input": {}}}),
      json!({"type": "content_block_stop", "index": 3}),
      json!({"type": "message_delta", "delta": {"stop_reason": "tool_use"}}),
    ]
    .into_iter()
    .map(ev)
    .collect::<String>();
    let bytes = stream.as_bytes();
    // serde_json writes the accent raw (2 bytes); cut between them and mid-line elsewhere.
    let e = bytes.windows(2).position(|w| w == [0xc3, 0xa9]).unwrap() + 1;
    let (reply, text) = run(&[&bytes[..40], &bytes[40..e], &bytes[e..]]);
    let reply = reply.unwrap();
    assert_eq!(text, "Caf\u{e9} ok");
    assert_eq!(reply.stop_reason, "tool_use");
    assert_eq!(
      reply.blocks,
      vec![
        // Thinking is kept (to send back), never shown as text.
        Block::Opaque { provider: "anthropic".into(), data: json!({"type": "thinking", "thinking": "hm", "signature": ""}) },
        Block::Text { text: "Caf\u{e9} ok".into() },
        Block::ToolUse { id: "tu1".into(), name: "search".into(), input: json!({"q": "x"}) },
        Block::ToolUse { id: "tu2".into(), name: "noargs".into(), input: json!({}) },
      ]
    );
  }

  #[test]
  fn error_event_fails() {
    let line = ev(json!({"type": "error", "error": {"type": "overloaded_error", "message": "Overloaded"}}));
    let (r, _) = run(&[line.as_bytes()]);
    assert_eq!(r.unwrap_err().to_string(), "Overloaded");
  }

  /// `ANTHROPIC_API_KEY=... cargo test -p singl-core anthropic_live -- --ignored`
  #[tokio::test]
  #[ignore]
  async fn anthropic_live() {
    let key = std::env::var("ANTHROPIC_API_KEY").unwrap();
    let list = models(&key).await.unwrap();
    assert!(!list.is_empty());
    let req = ApiRequest {
      api_key: key,
      model: list[0].id.clone(),
      system: "Reply with one word.".into(),
      messages: vec![msg(Role::User, vec![Block::Text { text: "Say hi".into() }])],
      tools: vec![],
      max_tokens: 50,
      effort: String::new(),
    };
    let reply = complete(&req, &|_| {}, &|_| {}, &CancellationToken::new()).await.unwrap();
    assert!(!reply.blocks.is_empty());
  }

  #[test]
  fn thinking_blocks_are_kept_and_sent_back() {
    let mut acc = Accumulator::default();
    let noop = |_: &str| {};
    let thought = Mutex::new(String::new());
    let on_thinking = |t: &str| thought.lock().unwrap().push_str(t);
    for e in [
      json!({"type": "content_block_start", "index": 0, "content_block": {"type": "thinking", "thinking": "", "signature": ""}}),
      json!({"type": "content_block_delta", "index": 0, "delta": {"type": "thinking_delta", "thinking": "hm"}}),
      json!({"type": "content_block_delta", "index": 0, "delta": {"type": "signature_delta", "signature": "SIG"}}),
      json!({"type": "content_block_stop", "index": 0}),
      json!({"type": "content_block_start", "index": 1, "content_block": {"type": "redacted_thinking", "data": "X"}}),
      json!({"type": "content_block_stop", "index": 1}),
    ] {
      acc.feed(&e.to_string(), &noop, &on_thinking).unwrap();
    }
    assert_eq!(thought.into_inner().unwrap(), "hm");
    let reply = acc.finish();
    assert_eq!(reply.blocks.len(), 2);
    let back = convert_messages(&[msg(Role::Assistant, reply.blocks)]);
    assert_eq!(back[0]["content"][0], json!({"type": "thinking", "thinking": "hm", "signature": "SIG"}));
    assert_eq!(back[0]["content"][1], json!({"type": "redacted_thinking", "data": "X"}));
  }
}
