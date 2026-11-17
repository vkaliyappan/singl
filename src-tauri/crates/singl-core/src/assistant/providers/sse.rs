//! What both API providers share: opening a streaming request with retries,
//! and reading its body as server-sent events.
//!
//! reqwest is built without its `stream` feature, so the body is read with
//! `chunk()`. A chunk can end anywhere — mid-line, even mid-character — so
//! bytes are buffered and only whole lines are decoded.

use std::time::Duration;

use serde_json::Value;
use tokio_util::sync::CancellationToken;

use crate::{CoreError, Result};

/// Splits a byte stream into lines, whatever way the chunks cut it.
#[derive(Default)]
pub struct LineSplitter {
  buf: Vec<u8>,
}

impl LineSplitter {
  /// Feeds a chunk and returns the lines it completed (`\n` or `\r\n` ended, terminator removed).
  /// Decoding happens per whole line, so a multi-byte character split across chunks stays intact.
  pub fn push(&mut self, chunk: &[u8]) -> Vec<String> {
    self.buf.extend_from_slice(chunk);
    let mut lines = Vec::new();
    while let Some(at) = self.buf.iter().position(|b| *b == b'\n') {
      let mut line: Vec<u8> = self.buf.drain(..=at).collect();
      line.pop();
      if line.last() == Some(&b'\r') {
        line.pop();
      }
      lines.push(String::from_utf8_lossy(&line).into_owned());
    }
    lines
  }

  /// What is left when the stream ends without a final newline.
  pub fn finish(&mut self) -> Option<String> {
    if self.buf.is_empty() {
      return None;
    }
    let rest = std::mem::take(&mut self.buf);
    Some(String::from_utf8_lossy(&rest).trim_end_matches('\r').to_string())
  }
}

/// The payload of a `data:` line; comments (`:`), `event:` and blank lines give `None`.
pub fn data_of(line: &str) -> Option<&str> {
  let rest = line.strip_prefix("data:")?;
  Some(rest.strip_prefix(' ').unwrap_or(rest))
}

/// The `error.message` an API put in a JSON body, when there is one.
pub fn error_message(body: &str) -> Option<String> {
  let v: Value = serde_json::from_str(body).ok()?;
  let e = v.get("error")?;
  e.get("message").and_then(Value::as_str).or_else(|| e.as_str()).map(str::to_string)
}

const BACKOFF: [Duration; 2] = [Duration::from_secs(1), Duration::from_secs(3)];

fn retryable(status: u16) -> bool {
  matches!(status, 429 | 500 | 502 | 503 | 529)
}

pub fn client() -> Result<reqwest::Client> {
  // No overall timeout: a long answer legitimately streams for minutes.
  reqwest::Client::builder()
    .connect_timeout(Duration::from_secs(30))
    .build()
    .map_err(|e| CoreError::Invalid(format!("Could not start the HTTP client: {e}")))
}

/// Sends the request until the response headers arrive, retrying twice (1s, 3s)
/// on throttling, server errors and connection failures. Nothing has been
/// streamed yet at this point, so a retry cannot repeat text the user saw.
pub async fn open(
  who: &str,
  cancel: &CancellationToken,
  build: impl Fn() -> reqwest::RequestBuilder,
) -> Result<reqwest::Response> {
  let mut attempt = 0;
  loop {
    super::check_cancel(cancel)?;
    let sent = tokio::select! {
      () = cancel.cancelled() => return Err(CoreError::Cancelled),
      sent = build().send() => sent,
    };
    let failure = match sent {
      Ok(res) if res.status().is_success() => return Ok(res),
      Ok(res) => {
        let status = res.status().as_u16();
        let body = res.text().await.unwrap_or_default();
        let msg = match error_message(&body) {
          Some(m) => format!("{who} answered {status}: {m}"),
          None => format!("{who} answered {status}."),
        };
        if !retryable(status) {
          return Err(CoreError::Invalid(msg));
        }
        msg
      }
      Err(e) => format!("Could not reach {who}: {e}"),
    };
    let Some(wait) = BACKOFF.get(attempt) else { return Err(CoreError::Invalid(failure)) };
    attempt += 1;
    tokio::select! {
      () = cancel.cancelled() => return Err(CoreError::Cancelled),
      () = tokio::time::sleep(*wait) => {}
    }
  }
}

/// Reads the body to its end, calling `on_data` with each `data:` payload.
pub async fn read_events(
  mut res: reqwest::Response,
  cancel: &CancellationToken,
  mut on_data: impl FnMut(&str) -> Result<()>,
) -> Result<()> {
  let mut lines = LineSplitter::default();
  loop {
    let chunk = tokio::select! {
      () = cancel.cancelled() => return Err(CoreError::Cancelled),
      chunk = res.chunk() => chunk.map_err(|e| CoreError::Invalid(format!("The response stream broke: {e}")))?,
    };
    let Some(chunk) = chunk else { break };
    for line in lines.push(&chunk) {
      if let Some(data) = data_of(&line) {
        on_data(data)?;
      }
    }
  }
  if let Some(line) = lines.finish() {
    if let Some(data) = data_of(&line) {
      on_data(data)?;
    }
  }
  Ok(())
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn lines_split_across_chunks() {
    let mut s = LineSplitter::default();
    assert!(s.push(b"data: {\"a\"").is_empty());
    assert_eq!(s.push(b":1}\r\n\r\ndata: x\n"), vec!["data: {\"a\":1}", "", "data: x"]);
    assert_eq!(s.finish(), None);
  }

  #[test]
  fn multibyte_character_split_across_chunks() {
    let bytes = "data: h\u{e9}llo \u{1f600}\n".as_bytes().to_vec();
    // Cut inside the 4-byte emoji.
    let cut = bytes.len() - 3;
    let mut s = LineSplitter::default();
    assert!(s.push(&bytes[..cut]).is_empty());
    assert_eq!(s.push(&bytes[cut..]), vec!["data: h\u{e9}llo \u{1f600}"]);
  }

  #[test]
  fn unterminated_tail_comes_out_on_finish() {
    let mut s = LineSplitter::default();
    assert!(s.push(b"data: end").is_empty());
    assert_eq!(s.finish().as_deref(), Some("data: end"));
  }

  #[test]
  fn data_lines_only() {
    assert_eq!(data_of("data: {}"), Some("{}"));
    assert_eq!(data_of("data:{}"), Some("{}"));
    assert_eq!(data_of(": OPENROUTER PROCESSING"), None);
    assert_eq!(data_of("event: ping"), None);
  }

  #[test]
  fn error_bodies() {
    assert_eq!(error_message(r#"{"error":{"message":"bad key"}}"#).as_deref(), Some("bad key"));
    assert_eq!(error_message("<html>"), None);
  }
}
