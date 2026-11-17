//! Streamable-HTTP transport for the app's MCP server, on 127.0.0.1 only.
//!
//! Deliberately small: POST `/mcp` with one JSON-RPC message or a batch, a
//! JSON reply (`application/json`, no SSE stream), 202 for notifications.
//! Every request needs `Authorization: Bearer <token>`: the app's token
//! (outside clients) or a per-turn token (agent CLIs running a chat's turn).
//! Browsers are kept out by refusing any non-local `Origin`.

use std::sync::Arc;

use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream};
use tokio_util::sync::CancellationToken;

use super::server::{Caller, error_response, handle_payload};
use crate::Result;
use crate::assistant::Assistant;

const MAX_HEADER_BYTES: usize = 64 * 1024;
const MAX_BODY_BYTES: usize = 32 * 1024 * 1024;

/// Binds `127.0.0.1:port` (any free port when it is taken) and serves until `cancel`.
/// Returns the port it listens on.
pub async fn serve(assistant: Arc<Assistant>, port: u16, token: String, cancel: CancellationToken) -> Result<u16> {
  let listener = match TcpListener::bind(("127.0.0.1", port)).await {
    Ok(l) => l,
    Err(e) => {
      crate::assistant::log_warn(&format!("assistant MCP: port {port} unavailable ({e}), using a free one"));
      TcpListener::bind(("127.0.0.1", 0)).await?
    }
  };
  let bound = listener.local_addr()?.port();
  tokio::spawn(async move {
    loop {
      tokio::select! {
        () = cancel.cancelled() => break,
        accepted = listener.accept() => {
          let Ok((stream, _)) = accepted else { continue };
          let (assistant, token, cancel) = (assistant.clone(), token.clone(), cancel.clone());
          tokio::spawn(async move {
            tokio::select! {
              () = cancel.cancelled() => {}
              _ = connection(assistant, stream, token) => {}
            }
          });
        }
      }
    }
  });
  Ok(bound)
}

struct Request {
  method: String,
  path: String,
  headers: Vec<(String, String)>,
  body: Vec<u8>,
}

impl Request {
  fn header(&self, name: &str) -> Option<&str> {
    self.headers.iter().find(|(k, _)| k == name).map(|(_, v)| v.as_str())
  }
}

/// Serves requests on one connection until it closes.
async fn connection(assistant: Arc<Assistant>, stream: TcpStream, token: String) -> std::io::Result<()> {
  let (read, mut write) = stream.into_split();
  let mut reader = BufReader::new(read);
  loop {
    let request = match read_request(&mut reader).await? {
      Some(r) => r,
      None => return Ok(()),
    };
    let close = request.header("connection").is_some_and(|v| v.eq_ignore_ascii_case("close"));
    let (status, body, extra) = respond(&assistant, &request, &token).await;
    let mut head = format!(
      "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nCache-Control: no-store\r\n",
      body.len()
    );
    for (k, v) in extra {
      head.push_str(&format!("{k}: {v}\r\n"));
    }
    if close {
      head.push_str("Connection: close\r\n");
    }
    head.push_str("\r\n");
    write.write_all(head.as_bytes()).await?;
    write.write_all(body.as_bytes()).await?;
    write.flush().await?;
    if close {
      return Ok(());
    }
  }
}

async fn read_request<R: tokio::io::AsyncRead + Unpin>(reader: &mut BufReader<R>) -> std::io::Result<Option<Request>> {
  let mut line = String::new();
  if reader.read_line(&mut line).await? == 0 {
    return Ok(None);
  }
  let mut parts = line.split_whitespace();
  let method = parts.next().unwrap_or_default().to_uppercase();
  let path = parts.next().unwrap_or("/").to_string();
  let mut headers = Vec::new();
  let mut total = line.len();
  loop {
    let mut h = String::new();
    let n = reader.read_line(&mut h).await?;
    total += n;
    if n == 0 || total > MAX_HEADER_BYTES {
      return Ok(None);
    }
    let h = h.trim_end();
    if h.is_empty() {
      break;
    }
    if let Some((k, v)) = h.split_once(':') {
      headers.push((k.trim().to_lowercase(), v.trim().to_string()));
    }
  }
  let len: usize = headers.iter().find(|(k, _)| k == "content-length").and_then(|(_, v)| v.parse().ok()).unwrap_or(0);
  if len > MAX_BODY_BYTES {
    return Ok(None);
  }
  let mut body = vec![0; len];
  reader.read_exact(&mut body).await?;
  Ok(Some(Request { method, path, headers, body }))
}

fn local_origin(origin: &str) -> bool {
  let o = origin.trim().to_lowercase();
  if o == "null" {
    return false;
  }
  let Some((scheme, rest)) = o.split_once("://") else { return false };
  let host = rest.split(['/', ':']).next().unwrap_or_default();
  match scheme {
    "tauri" => true,
    "http" | "https" => matches!(host, "127.0.0.1" | "localhost" | "tauri.localhost" | "[::1]"),
    _ => false,
  }
}

async fn respond(assistant: &Arc<Assistant>, req: &Request, token: &str) -> (&'static str, String, Vec<(&'static str, String)>) {
  let json_err = |msg: &str| error_response(Value::Null, -32600, msg).to_string();
  if let Some(origin) = req.header("origin") {
    if !local_origin(origin) {
      return ("403 Forbidden", json_err("Origin not allowed."), vec![]);
    }
  }
  let path = req.path.split('?').next().unwrap_or("/");
  if path != "/mcp" && path != "/" {
    return ("404 Not Found", json_err("Use /mcp."), vec![]);
  }
  let bearer = req.header("authorization").and_then(|v| v.strip_prefix("Bearer ").or_else(|| v.strip_prefix("bearer ")));
  let caller = match bearer.map(str::trim) {
    Some(t) if !token.is_empty() && t == token => Caller::external(),
    Some(t) => match assistant.chat_for_token(t) {
      Some(chat_id) => Caller { chat_id: Some(chat_id) },
      None => return ("401 Unauthorized", json_err("Bad or missing bearer token."), vec![("WWW-Authenticate", "Bearer".into())]),
    },
    None => return ("401 Unauthorized", json_err("Bad or missing bearer token."), vec![("WWW-Authenticate", "Bearer".into())]),
  };
  match req.method.as_str() {
    "POST" => {}
    "DELETE" => return ("200 OK", "{}".into(), vec![]),
    // No server-initiated stream: this server never sends requests or notifications.
    _ => return ("405 Method Not Allowed", json_err("Only POST is supported."), vec![("Allow", "POST, DELETE".into())]),
  }
  let payload: Value = match serde_json::from_slice(&req.body) {
    Ok(v) => v,
    Err(e) => return ("400 Bad Request", error_response(Value::Null, -32700, &format!("Parse error: {e}")).to_string(), vec![]),
  };
  let is_initialize = payload.get("method").and_then(Value::as_str) == Some("initialize");
  match handle_payload(assistant, payload, &caller).await {
    Some(reply) => {
      let extra = if is_initialize { vec![("Mcp-Session-Id", uuid::Uuid::new_v4().to_string())] } else { vec![] };
      ("200 OK", reply.to_string(), extra)
    }
    None => ("202 Accepted", String::new(), vec![]),
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn only_local_origins_pass() {
    assert!(local_origin("http://localhost:3000"));
    assert!(local_origin("http://tauri.localhost"));
    assert!(!local_origin("https://evil.example"));
    assert!(!local_origin("http://localhost.evil.example"));
    assert!(local_origin("tauri://localhost"));
  }
}
