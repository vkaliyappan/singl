//! The stored conversation format. Every provider converts to and from it, so
//! a chat can switch provider or model on any turn.
//!
//! Tool results follow the Anthropic convention: an assistant message holds
//! `ToolUse` blocks and the next user message holds their `ToolResult`s.

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Block {
  Text {
    text: String,
  },
  ToolUse {
    id: String,
    name: String,
    input: Value,
  },
  ToolResult {
    tool_use_id: String,
    /// What the model reads (big results are cut to a preview, see `tools::outputs`).
    content: String,
    #[serde(default)]
    is_error: bool,
    /// The fuller result the chat shows, when it differs from `content`. Never sent to a model.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    display: Option<String>,
  },
  /// A provider block kept verbatim and sent back only to that provider, e.g.
  /// Anthropic `thinking` / `redacted_thinking` blocks, which must be passed
  /// back unchanged on later requests. Other providers and the UI skip it.
  Opaque {
    provider: String,
    data: Value,
  },
  /// A text file the user attached to their message, read when it was sent;
  /// or, with `directory`, a folder: `content` is its file tree, and the model
  /// reads files from it with the `fs_*` tools.
  Attachment {
    name: String,
    path: String,
    content: String,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    directory: bool,
  },
  /// Something the user pinned from a screen ("Add to chat"): a service, its
  /// inputs, a result, a node… `content` is what the model reads (text or JSON).
  Reference {
    kind: String,
    label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    screen: Option<String>,
    content: String,
  },
  /// An image the user pasted, dropped or picked; `data` is base64.
  Image {
    name: String,
    media_type: String,
    data: String,
  },
}

impl Block {
  /// An attachment as the model sees it.
  pub fn attachment_prompt(name: &str, path: &str, content: &str, directory: bool) -> String {
    if directory {
      format!(
        "<attached_directory name=\"{name}\" path=\"{path}\">\n{content}\n</attached_directory>\n\
         (Read files in it with fs_read_file and fs_list_directory when you need them.)"
      )
    } else {
      format!("<attached_file name=\"{name}\" path=\"{path}\">\n{content}\n</attached_file>")
    }
  }

  /// A pinned screen item as the model sees it.
  pub fn reference_prompt(kind: &str, label: &str, screen: Option<&str>, content: &str) -> String {
    let screen = screen.map(|s| format!(" screen=\"{s}\"")).unwrap_or_default();
    format!("<pinned kind=\"{kind}\" label=\"{label}\"{screen}>\n{content}\n</pinned>")
  }

  /// Attachments and pinned items as prompt text; `None` for other blocks.
  pub fn context_prompt(&self) -> Option<String> {
    match self {
      Block::Attachment { name, path, content, directory } => Some(Block::attachment_prompt(name, path, content, *directory)),
      Block::Reference { kind, label, screen, content } => Some(Block::reference_prompt(kind, label, screen.as_deref(), content)),
      _ => None,
    }
  }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Role {
  User,
  Assistant,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Message {
  pub id: String,
  pub role: Role,
  pub blocks: Vec<Block>,
  /// Who answered (assistant messages) or who was asked (user messages).
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub provider: Option<String>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub model: Option<String>,
  /// Names of the skills the user picked for this message.
  #[serde(default, skip_serializing_if = "Vec::is_empty")]
  pub skills: Vec<String>,
  /// Reasoning effort asked for (`low` … `max`); `None` is the provider default.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub effort: Option<String>,
  /// The screen context when a user message was sent, so old chats stay readable.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub context: Option<Value>,
  /// Set on a summary of the conversation before it (see `compact`): the number
  /// of messages it replaces. Models see it instead of them.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub summary_of: Option<u32>,
  #[serde(default)]
  pub created_at: i64,
}

impl Message {
  pub fn new(role: Role, blocks: Vec<Block>) -> Self {
    Self {
      id: uuid::Uuid::new_v4().to_string(),
      role,
      blocks,
      provider: None,
      model: None,
      effort: None,
      skills: Vec::new(),
      context: None,
      summary_of: None,
      created_at: crate::db::now(),
    }
  }

  /// All text blocks joined.
  pub fn text(&self) -> String {
    self
      .blocks
      .iter()
      .filter_map(|b| match b {
        Block::Text { text } => Some(text.as_str()),
        _ => None,
      })
      .collect::<Vec<_>>()
      .join("\n")
  }

  /// What the model reads of this message: attached files, then the text.
  pub fn prompt_text(&self) -> String {
    let mut parts: Vec<String> = self
      .blocks
      .iter()
      .filter_map(Block::context_prompt)
      .collect();
    let text = self.text();
    if !text.is_empty() {
      parts.push(text);
    }
    parts.join("\n\n")
  }

  /// The message's images.
  pub fn images(&self) -> impl Iterator<Item = (&str, &str, &str)> {
    self.blocks.iter().filter_map(|b| match b {
      Block::Image { name, media_type, data } => Some((name.as_str(), media_type.as_str(), data.as_str())),
      _ => None,
    })
  }

  /// A user message that only carries tool results (not typed by a person).
  pub fn is_tool_results(&self) -> bool {
    self.role == Role::User
      && !self.blocks.is_empty()
      && self.blocks.iter().all(|b| matches!(b, Block::ToolResult { .. }))
  }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatSummary {
  pub id: String,
  pub title: String,
  pub message_count: i64,
  pub created_at: Option<i64>,
  pub updated_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Chat {
  pub id: String,
  pub title: String,
  pub messages: Vec<Message>,
  pub created_at: Option<i64>,
  pub updated_at: Option<i64>,
}

/// A model a provider offers.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
  pub id: String,
  pub name: String,
}
