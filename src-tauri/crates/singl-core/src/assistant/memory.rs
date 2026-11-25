//! Long-term memory: short facts the assistant chose to keep across chats
//! (see [`super::tools::memory`]). Kept in `assistant_memories`; all of them
//! join every turn's system prompt, so every provider sees the same list.

use serde::Serialize;
use sqlx::{FromRow, SqlitePool};

use crate::db::now;
use crate::{CoreError, Result};

/// Longest single memory, in characters.
pub const MAX_TEXT: usize = 1000;
/// Most memories kept; saving past this asks the model to merge or delete some.
pub const MAX_COUNT: i64 = 200;

#[derive(Debug, Clone, FromRow, Serialize)]
#[sqlx(rename_all = "camelCase")]
#[serde(rename_all = "camelCase")]
pub struct Memory {
  pub id: String,
  pub text: String,
  /// Unix seconds.
  pub created_at: i64,
  pub updated_at: i64,
}

fn clean(text: &str) -> Result<String> {
  let text = text.trim();
  if text.is_empty() {
    return Err(CoreError::Invalid("A memory needs text.".into()));
  }
  if text.chars().count() > MAX_TEXT {
    return Err(CoreError::Invalid(format!("A memory is at most {MAX_TEXT} characters; keep it to one short fact.")));
  }
  Ok(text.to_string())
}

/// Every memory, oldest first.
pub async fn list(pool: &SqlitePool) -> Result<Vec<Memory>> {
  Ok(sqlx::query_as("SELECT * FROM assistant_memories ORDER BY createdAt, id").fetch_all(pool).await?)
}

pub async fn add(pool: &SqlitePool, text: &str) -> Result<Memory> {
  let text = clean(text)?;
  let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM assistant_memories").fetch_one(pool).await?;
  if count >= MAX_COUNT {
    return Err(CoreError::Invalid(format!(
      "Memory is full ({MAX_COUNT} items). Merge related ones with memory_update or remove stale ones with memory_delete first."
    )));
  }
  let m = Memory { id: uuid::Uuid::new_v4().to_string(), text, created_at: now(), updated_at: now() };
  sqlx::query("INSERT INTO assistant_memories (id, text, createdAt, updatedAt) VALUES (?1, ?2, ?3, ?4)")
    .bind(&m.id)
    .bind(&m.text)
    .bind(m.created_at)
    .bind(m.updated_at)
    .execute(pool)
    .await?;
  Ok(m)
}

pub async fn update(pool: &SqlitePool, id: &str, text: &str) -> Result<Memory> {
  let text = clean(text)?;
  let done = sqlx::query("UPDATE assistant_memories SET text = ?1, updatedAt = ?2 WHERE id = ?3")
    .bind(&text)
    .bind(now())
    .bind(id)
    .execute(pool)
    .await?;
  if done.rows_affected() == 0 {
    return Err(not_found(id));
  }
  Ok(sqlx::query_as("SELECT * FROM assistant_memories WHERE id = ?1").bind(id).fetch_one(pool).await?)
}

pub async fn delete(pool: &SqlitePool, id: &str) -> Result<()> {
  let done = sqlx::query("DELETE FROM assistant_memories WHERE id = ?1").bind(id).execute(pool).await?;
  if done.rows_affected() == 0 {
    return Err(not_found(id));
  }
  Ok(())
}

fn not_found(id: &str) -> CoreError {
  CoreError::Invalid(format!("No memory with id \"{id}\". The ids are listed in the system prompt under \"Memory\"."))
}

/// The system-prompt section: how to use memory, then every memory with its id.
pub fn prompt_section(memories: &[Memory]) -> String {
  let mut out = String::from(
    "\n\n## Memory\n\
     Facts you saved in earlier chats with memory_save. Use them, but a live tool result wins over a memory; \
     when one turns out wrong or stale, fix it with memory_update or remove it with memory_delete.\n\
     Save (without asking) when you learn something durable that a later chat could not easily find again: \
     the user's corrections and preferences, how they want work done, facts about their servers, projects and \
     entities that took effort to discover, and quirks or pitfalls. One short self-contained fact per memory; \
     update an existing one instead of adding a near-duplicate. Do not save what a tool can look up directly, \
     anything only this chat needs, or secrets (passwords, keys, tokens).\n",
  );
  if memories.is_empty() {
    out.push_str("(none yet)");
  }
  for m in memories {
    // One line per memory, so a stored newline cannot fake another entry.
    out.push_str(&format!("- [{}] {}\n", m.id, m.text.split_whitespace().collect::<Vec<_>>().join(" ")));
  }
  out
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn prompt_lists_memories_on_one_line_each() {
    let m = Memory { id: "a".into(), text: "line one\n- [x] fake".into(), created_at: 0, updated_at: 0 };
    let s = prompt_section(&[m]);
    assert!(s.contains("- [a] line one - [x] fake\n"));
    assert!(prompt_section(&[]).contains("(none yet)"));
  }

  #[test]
  fn clean_rejects_empty_and_long() {
    assert!(clean("  ").is_err());
    assert!(clean(&"x".repeat(MAX_TEXT + 1)).is_err());
    assert_eq!(clean("  ok ").unwrap(), "ok");
  }
}
