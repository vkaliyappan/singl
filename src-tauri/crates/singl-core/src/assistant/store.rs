//! Chat history in `assistant_chats` (scope `app`, plus `uitest` for App Tests
//! case chats, which stay out of the assistant's chat list) and CLI session links
//! in `assistant_sessions`. Rows from singl-web's older per-page assistants use
//! other scopes and are left alone.

use sqlx::SqlitePool;

use super::types::{Chat, ChatSummary, Message, Role};
use crate::db::models::{AssistantChat, AssistantSession};
use crate::db::now;
use crate::{CoreError, Result};

const SCOPE: &str = "app";
/// Chats App Tests runs and reports create. Readable and writable like app chats,
/// but listed only on the App Tests page.
pub const TEST_SCOPE: &str = "uitest";
/// Scopes `get`, `rename` and `delete` act on.
const OWN_SCOPES: &str = "scope IN ('app', 'uitest')";
const NEW_TITLE: &str = "New chat";

pub async fn list(pool: &SqlitePool, limit: i64) -> Result<Vec<ChatSummary>> {
  let rows: Vec<AssistantChat> = sqlx::query_as(
    "SELECT * FROM assistant_chats WHERE scope = ?1 ORDER BY COALESCE(updatedAt, createdAt, 0) DESC LIMIT ?2",
  )
  .bind(SCOPE)
  .bind(limit)
  .fetch_all(pool)
  .await?;
  Ok(rows.into_iter().map(summary).collect())
}

/// Chats whose title or messages contain `query` (case-insensitive for ASCII), newest first.
pub async fn search(pool: &SqlitePool, query: &str, limit: i64) -> Result<Vec<ChatSummary>> {
  let query = query.trim();
  if query.is_empty() {
    return list(pool, limit).await;
  }
  // `!` escapes LIKE wildcards, so `100%` matches literally.
  let escaped = query.replace('!', "!!").replace('%', "!%").replace('_', "!_");
  let pattern = format!("%{escaped}%");
  let rows: Vec<AssistantChat> = sqlx::query_as(
    "SELECT * FROM assistant_chats WHERE scope = ?1 AND (title LIKE ?2 ESCAPE '!' OR messages LIKE ?2 ESCAPE '!')
     ORDER BY COALESCE(updatedAt, createdAt, 0) DESC LIMIT ?3",
  )
  .bind(SCOPE)
  .bind(pattern)
  .bind(limit)
  .fetch_all(pool)
  .await?;
  Ok(rows.into_iter().map(summary).collect())
}

fn summary(row: AssistantChat) -> ChatSummary {
  ChatSummary {
    id: row.id,
    title: row.title,
    message_count: row.message_count,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

pub async fn get(pool: &SqlitePool, id: &str) -> Result<Chat> {
  let row: Option<AssistantChat> = sqlx::query_as(&format!("SELECT * FROM assistant_chats WHERE id = ?1 AND {OWN_SCOPES}"))
    .bind(id)
    .fetch_optional(pool)
    .await?;
  let row = row.ok_or_else(|| CoreError::NotFound(format!("No chat \"{id}\".")))?;
  let messages: Vec<Message> = serde_json::from_str(&row.messages).unwrap_or_default();
  Ok(Chat { id: row.id, title: row.title, messages, created_at: row.created_at, updated_at: row.updated_at })
}

pub async fn create(pool: &SqlitePool) -> Result<Chat> {
  create_in(pool, SCOPE).await
}

/// A new chat in `scope` (`app` or [`TEST_SCOPE`]).
pub async fn create_in(pool: &SqlitePool, scope: &str) -> Result<Chat> {
  let id = uuid::Uuid::new_v4().to_string();
  let at = now();
  sqlx::query(
    "INSERT INTO assistant_chats (id, scope, domain, title, messages, messageCount, createdAt, updatedAt)
     VALUES (?1, ?2, 'general', ?3, '[]', 0, ?4, ?4)",
  )
  .bind(&id)
  .bind(scope)
  .bind(NEW_TITLE)
  .bind(at)
  .execute(pool)
  .await?;
  Ok(Chat { id, title: NEW_TITLE.into(), messages: Vec::new(), created_at: Some(at), updated_at: Some(at) })
}

/// Writes every message; a chat still called "New chat" takes its title from the first prompt.
pub async fn save(pool: &SqlitePool, chat: &mut Chat) -> Result<()> {
  if chat.title == NEW_TITLE {
    if let Some(first) = chat.messages.iter().find(|m| m.role == Role::User && !m.is_tool_results()) {
      chat.title = title_from(&first.text());
    }
  }
  let at = now();
  chat.updated_at = Some(at);
  sqlx::query("UPDATE assistant_chats SET title = ?2, messages = ?3, messageCount = ?4, updatedAt = ?5 WHERE id = ?1")
    .bind(&chat.id)
    .bind(&chat.title)
    .bind(serde_json::to_string(&chat.messages).map_err(|e| CoreError::Invalid(e.to_string()))?)
    .bind(chat.messages.len() as i64)
    .bind(at)
    .execute(pool)
    .await?;
  Ok(())
}

fn title_from(text: &str) -> String {
  let line = text.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or(NEW_TITLE);
  let mut title: String = line.chars().take(60).collect();
  if line.chars().count() > 60 {
    title.push('…');
  }
  title
}

pub async fn rename(pool: &SqlitePool, id: &str, title: &str) -> Result<()> {
  let title = title.trim();
  let title = if title.is_empty() { NEW_TITLE } else { title };
  sqlx::query(&format!("UPDATE assistant_chats SET title = ?2, updatedAt = ?3 WHERE id = ?1 AND {OWN_SCOPES}"))
    .bind(id)
    .bind(title)
    .bind(now())
    .execute(pool)
    .await?;
  Ok(())
}

pub async fn delete(pool: &SqlitePool, id: &str) -> Result<()> {
  sqlx::query(&format!("DELETE FROM assistant_chats WHERE id = ?1 AND {OWN_SCOPES}")).bind(id).execute(pool).await?;
  sqlx::query("DELETE FROM assistant_sessions WHERE chatId = ?1").bind(id).execute(pool).await?;
  Ok(())
}

/// The CLI session a chat last used.
pub async fn session(pool: &SqlitePool, chat_id: &str) -> Result<Option<AssistantSession>> {
  Ok(sqlx::query_as("SELECT * FROM assistant_sessions WHERE chatId = ?1").bind(chat_id).fetch_optional(pool).await?)
}

/// Forgets a chat's CLI session, so its next turn starts a new one.
pub async fn clear_session(pool: &SqlitePool, chat_id: &str) -> Result<()> {
  sqlx::query("DELETE FROM assistant_sessions WHERE chatId = ?1").bind(chat_id).execute(pool).await?;
  Ok(())
}

/// Remembers a CLI session. `turn_count` is the number of chat messages it has seen.
pub async fn save_session(
  pool: &SqlitePool,
  chat_id: &str,
  provider: &str,
  model: &str,
  session_id: &str,
  turn_count: i64,
) -> Result<()> {
  sqlx::query(
    "INSERT INTO assistant_sessions (chatId, provider, model, sessionId, turnCount, turnsHash, size, updatedAt)
     VALUES (?1, ?2, ?3, ?4, ?5, '', 0, ?6)
     ON CONFLICT(chatId) DO UPDATE SET provider = excluded.provider, model = excluded.model,
       sessionId = excluded.sessionId, turnCount = excluded.turnCount, updatedAt = excluded.updatedAt",
  )
  .bind(chat_id)
  .bind(provider)
  .bind(model)
  .bind(session_id)
  .bind(turn_count)
  .bind(now())
  .execute(pool)
  .await?;
  Ok(())
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::assistant::types::Block;

  #[tokio::test]
  async fn chats_round_trip() {
    let dir = tempfile::tempdir().unwrap();
    let pool = crate::db::open(&dir.path().join("singl.db")).await.unwrap();
    let mut chat = create(&pool).await.unwrap();
    chat.messages.push(Message::new(Role::User, vec![Block::Text { text: "Explain GetData\nplease".into() }]));
    save(&pool, &mut chat).await.unwrap();
    let back = get(&pool, &chat.id).await.unwrap();
    assert_eq!(back.title, "Explain GetData");
    assert_eq!(back.messages.len(), 1);
    assert_eq!(list(&pool, 10).await.unwrap().len(), 1);
    assert_eq!(search(&pool, "please", 10).await.unwrap().len(), 1);
    assert_eq!(search(&pool, "nothing_like_this", 10).await.unwrap().len(), 0);
    assert_eq!(search(&pool, "100%", 10).await.unwrap().len(), 0);
    save_session(&pool, &chat.id, "claude", "", "s1", 1).await.unwrap();
    assert_eq!(session(&pool, &chat.id).await.unwrap().unwrap().session_id, "s1");
    delete(&pool, &chat.id).await.unwrap();
    assert!(get(&pool, &chat.id).await.is_err());
    assert!(session(&pool, &chat.id).await.unwrap().is_none());
  }
}
