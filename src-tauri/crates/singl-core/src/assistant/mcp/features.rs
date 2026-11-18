//! Resources and prompts of the connected MCP servers: what the composer's `@`
//! and `/` pickers list, and what they fetch once one is picked.

use std::collections::HashMap;

use serde::Serialize;
use serde_json::{Value, json};

use super::client::{LIST_TIMEOUT, McpClients};
use super::host::LoggedCall;
use crate::assistant::Assistant;
use crate::assistant::settings::McpServerConfig;
use crate::{CoreError, Result};

/// A resource read is cut here before it is attached to a message.
const READ_LIMIT: usize = 200_000;

fn invalid(msg: impl Into<String>) -> CoreError {
  CoreError::Invalid(msg.into())
}

fn text_of<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
  v.get(key).and_then(Value::as_str).filter(|s| !s.is_empty())
}

/// A resource, or with `template` a URI template (`file:///{path}`) that needs filling.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpResource {
  pub server: String,
  /// The URI, or the URI template.
  pub uri: String,
  pub name: String,
  pub title: Option<String>,
  pub description: Option<String>,
  pub mime_type: Option<String>,
  pub size: Option<u64>,
  pub template: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpPromptArg {
  pub name: String,
  pub description: Option<String>,
  pub required: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpPrompt {
  pub server: String,
  pub name: String,
  pub title: Option<String>,
  pub description: Option<String>,
  pub arguments: Vec<McpPromptArg>,
}

#[derive(Debug, Clone, Serialize)]
pub struct McpPromptMessage {
  pub role: String,
  pub text: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpPromptResult {
  pub description: Option<String>,
  pub messages: Vec<McpPromptMessage>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpResourceText {
  pub server: String,
  pub uri: String,
  pub mime_type: Option<String>,
  pub text: String,
}

fn parse_resource(server: &str, v: &Value, template: bool) -> Option<McpResource> {
  let uri = text_of(v, if template { "uriTemplate" } else { "uri" })?;
  Some(McpResource {
    server: server.to_string(),
    uri: uri.to_string(),
    name: text_of(v, "name").unwrap_or(uri).to_string(),
    title: text_of(v, "title").map(String::from),
    description: text_of(v, "description").map(String::from),
    mime_type: text_of(v, "mimeType").map(String::from),
    size: v.get("size").and_then(Value::as_u64),
    template,
  })
}

fn parse_prompt(server: &str, v: &Value) -> Option<McpPrompt> {
  let name = text_of(v, "name")?;
  let arguments = v
    .get("arguments")
    .and_then(Value::as_array)
    .into_iter()
    .flatten()
    .filter_map(|a| {
      Some(McpPromptArg {
        name: text_of(a, "name")?.to_string(),
        description: text_of(a, "description").map(String::from),
        required: a.get("required").and_then(Value::as_bool).unwrap_or(false),
      })
    })
    .collect();
  Some(McpPrompt {
    server: server.to_string(),
    name: name.to_string(),
    title: text_of(v, "title").map(String::from),
    description: text_of(v, "description").map(String::from),
    arguments,
  })
}

/// The text of a prompt message's content (text, embedded resource, other media as a note).
fn content_text(c: &Value) -> String {
  match text_of(c, "type").unwrap_or_default() {
    "text" => text_of(c, "text").unwrap_or_default().to_string(),
    "resource" => {
      let r = c.get("resource").unwrap_or(&Value::Null);
      text_of(r, "text").or(text_of(r, "uri")).unwrap_or_default().to_string()
    }
    "resource_link" => text_of(c, "uri").unwrap_or_default().to_string(),
    other => format!("[{other} omitted]"),
  }
}

impl McpClients {
  /// What `resources/list` (or `resources/templates/list`) returns for every
  /// running server that has resources. A server that fails is left out.
  pub async fn resources(&self, servers: &[McpServerConfig], templates: bool) -> Vec<McpResource> {
    let (method, key) = if templates { ("resources/templates/list", "resourceTemplates") } else { ("resources/list", "resources") };
    let mut tasks = Vec::new();
    for cfg in servers.iter().filter(|s| s.enabled) {
      let Ok((conn, caps)) = self.conn_for(&cfg.name) else { continue };
      if caps.get("resources").is_none() {
        continue;
      }
      let name = cfg.name.clone();
      tasks.push(tokio::spawn(async move {
        let items = conn.list_paged(method, key).await.unwrap_or_default();
        items.iter().filter_map(|v| parse_resource(&name, v, templates)).collect::<Vec<_>>()
      }));
    }
    let mut out = Vec::new();
    for t in tasks {
      out.extend(t.await.unwrap_or_default());
    }
    out
  }

  /// `resources/read`, as text. Logged.
  pub async fn read_resource(&self, server: &str, uri: &str) -> Result<McpResourceText> {
    let (conn, caps) = self.conn_for(server)?;
    if caps.get("resources").is_none() {
      return Err(invalid(format!("{server} has no resources.")));
    }
    let logged = LoggedCall::start("resource", server, uri, &json!({}));
    let read = async {
      let result = conn.request("resources/read", json!({ "uri": uri }), LIST_TIMEOUT).await?;
      let mut mime = None;
      let mut parts = Vec::new();
      for c in result.get("contents").and_then(Value::as_array).into_iter().flatten() {
        mime = mime.or(text_of(c, "mimeType").map(String::from));
        match text_of(c, "text") {
          Some(t) => parts.push(t.to_string()),
          None if c.get("blob").is_some() => {
            parts.push(format!("[binary content omitted: {}]", text_of(c, "mimeType").unwrap_or("unknown type")))
          }
          None => {}
        }
      }
      Ok::<_, CoreError>((mime, parts.join("\n")))
    }
    .await;
    let (mime, mut text) = match read {
      Ok(found) => found,
      Err(e) => {
        logged.record(0, Some(e.to_string()));
        return Err(e);
      }
    };
    logged.record(text.len(), None);
    if text.len() > READ_LIMIT {
      let mut end = READ_LIMIT;
      while !text.is_char_boundary(end) {
        end -= 1;
      }
      text.truncate(end);
      text.push_str("\n[cut: the resource is longer than 200 KB]");
    }
    Ok(McpResourceText { server: server.to_string(), uri: uri.to_string(), mime_type: mime, text })
  }

  /// `prompts/list` of every running server that has prompts.
  pub async fn prompts(&self, servers: &[McpServerConfig]) -> Vec<McpPrompt> {
    let mut tasks = Vec::new();
    for cfg in servers.iter().filter(|s| s.enabled) {
      let Ok((conn, caps)) = self.conn_for(&cfg.name) else { continue };
      if caps.get("prompts").is_none() {
        continue;
      }
      let name = cfg.name.clone();
      tasks.push(tokio::spawn(async move {
        let items = conn.list_paged("prompts/list", "prompts").await.unwrap_or_default();
        items.iter().filter_map(|v| parse_prompt(&name, v)).collect::<Vec<_>>()
      }));
    }
    let mut out = Vec::new();
    for t in tasks {
      out.extend(t.await.unwrap_or_default());
    }
    out
  }

  /// `prompts/get`: the messages a prompt expands to, as text.
  pub async fn get_prompt(&self, server: &str, name: &str, arguments: HashMap<String, String>) -> Result<McpPromptResult> {
    let (conn, caps) = self.conn_for(server)?;
    if caps.get("prompts").is_none() {
      return Err(invalid(format!("{server} has no prompts.")));
    }
    let result = conn.request("prompts/get", json!({ "name": name, "arguments": arguments }), LIST_TIMEOUT).await?;
    let messages = result
      .get("messages")
      .and_then(Value::as_array)
      .into_iter()
      .flatten()
      .map(|m| McpPromptMessage {
        role: text_of(m, "role").unwrap_or("user").to_string(),
        text: content_text(m.get("content").unwrap_or(&Value::Null)),
      })
      .collect();
    Ok(McpPromptResult { description: text_of(&result, "description").map(String::from), messages })
  }
}

impl Assistant {
  /// The configured servers, started if they are not yet.
  async fn started_servers(&self) -> Result<Vec<McpServerConfig>> {
    let servers = self.mcp_servers().await?;
    self.mcp_clients.tools(&servers).await;
    Ok(servers)
  }

  pub async fn mcp_resources(&self, templates: bool) -> Result<Vec<McpResource>> {
    let servers = self.started_servers().await?;
    Ok(self.mcp_clients.resources(&servers, templates).await)
  }

  pub async fn mcp_prompts(&self) -> Result<Vec<McpPrompt>> {
    let servers = self.started_servers().await?;
    Ok(self.mcp_clients.prompts(&servers).await)
  }

  /// The tools of the servers that are running now (none are started for this).
  pub async fn mcp_tool_infos(&self) -> Result<Vec<super::client::McpToolInfo>> {
    let servers = self.mcp_servers().await?;
    Ok(self.mcp_clients.server_tools(&servers).await)
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn resources_and_prompts_parse() {
    let r = parse_resource("s", &json!({ "uri": "file:///a", "name": "a", "mimeType": "text/plain", "size": 3 }), false).unwrap();
    assert_eq!((r.uri.as_str(), r.size, r.template), ("file:///a", Some(3), false));
    let t = parse_resource("s", &json!({ "uriTemplate": "file:///{p}" }), true).unwrap();
    assert_eq!(t.name, "file:///{p}");
    assert!(parse_resource("s", &json!({ "name": "x" }), false).is_none());
    let p = parse_prompt("s", &json!({ "name": "p", "arguments": [{ "name": "a", "required": true }, { "x": 1 }] })).unwrap();
    assert_eq!(p.arguments.len(), 1);
    assert!(p.arguments[0].required);
  }

  #[test]
  fn prompt_content_becomes_text() {
    assert_eq!(content_text(&json!({ "type": "text", "text": "hi" })), "hi");
    assert_eq!(content_text(&json!({ "type": "resource", "resource": { "uri": "u", "text": "body" } })), "body");
    assert_eq!(content_text(&json!({ "type": "image" })), "[image omitted]");
  }
}
