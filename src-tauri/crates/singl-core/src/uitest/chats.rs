//! The chats App Tests runs leave behind (scope `uitest` in `assistant_chats`),
//! each tied back to its suite, case and run so the App Tests page can list and
//! filter them. They stay out of the assistant's own chat list.

use std::collections::HashMap;

use serde::Serialize;
use serde_json::Value;
use sqlx::{Row, SqlitePool};

use crate::Result;
use crate::assistant::store::{self, TEST_SCOPE};

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UiTestChat {
  pub chat_id: String,
  pub title: String,
  pub message_count: i64,
  pub created_at: Option<i64>,
  pub updated_at: Option<i64>,
  /// Empty when no run or case points at the chat any more.
  pub suite_id: String,
  pub suite_name: String,
  pub case_id: String,
  pub case_title: String,
  /// The `automation_runs` row the chat's case result is in; empty for a run still going.
  pub run_id: String,
  pub run_started_at: Option<i64>,
  pub status: String,
  pub reason: String,
  pub duration_ms: Option<i64>,
}

/// Every App Tests chat, newest first; `suite_id` keeps only that suite's.
pub async fn list(pool: &SqlitePool, suite_id: Option<&str>) -> Result<Vec<UiTestChat>> {
  let suites: HashMap<String, String> = sqlx::query("SELECT id, name FROM ui_test_suites")
    .fetch_all(pool)
    .await?
    .iter()
    .map(|r| (r.get("id"), r.get("name")))
    .collect();

  // chat id → what it was for. Run results first, newest last so it wins
  // (a chat belongs to one case of one run, but be safe).
  let mut info: HashMap<String, UiTestChat> = HashMap::new();
  let runs = sqlx::query("SELECT id, refId, startedAt, result FROM automation_runs WHERE kind = 'uitest' ORDER BY startedAt")
    .fetch_all(pool)
    .await?;
  for r in &runs {
    let result: Value = serde_json::from_str(r.get::<&str, _>("result")).unwrap_or(Value::Null);
    let Some(cases) = result.get("cases").and_then(Value::as_array) else { continue };
    let ref_id: String = r.get("refId");
    for c in cases {
      let chat = str_of(c, "chatId");
      if chat.is_empty() {
        continue;
      }
      info.insert(
        chat.clone(),
        UiTestChat {
          chat_id: chat,
          suite_id: ref_id.clone(),
          case_id: str_of(c, "caseId"),
          case_title: str_of(c, "title"),
          run_id: r.get("id"),
          run_started_at: Some(r.get("startedAt")),
          status: str_of(c, "status"),
          reason: str_of(c, "reason"),
          duration_ms: c.get("durationMs").and_then(Value::as_i64),
          ..Default::default()
        },
      );
    }
  }
  // Cases whose run is still going (not in the history yet).
  for r in sqlx::query("SELECT id, suiteId, title, status, reason, chatId FROM ui_test_cases WHERE chatId <> ''").fetch_all(pool).await? {
    let chat: String = r.get("chatId");
    info.entry(chat.clone()).or_insert_with(|| UiTestChat {
      chat_id: chat,
      suite_id: r.get("suiteId"),
      case_id: r.get("id"),
      case_title: r.get("title"),
      status: r.get("status"),
      reason: r.get("reason"),
      ..Default::default()
    });
  }

  let rows = sqlx::query(
    "SELECT id, title, messageCount, createdAt, updatedAt FROM assistant_chats WHERE scope = ?1
     ORDER BY COALESCE(updatedAt, createdAt, 0) DESC",
  )
  .bind(TEST_SCOPE)
  .fetch_all(pool)
  .await?;
  let mut out = Vec::with_capacity(rows.len());
  for r in rows {
    let id: String = r.get("id");
    let mut c = info.remove(&id).unwrap_or_default();
    if suite_id.is_some_and(|s| s != c.suite_id) {
      continue;
    }
    c.chat_id = id;
    c.title = r.get("title");
    c.message_count = r.get("messageCount");
    c.created_at = r.get("createdAt");
    c.updated_at = r.get("updatedAt");
    c.suite_name = suites.get(&c.suite_id).cloned().unwrap_or_default();
    out.push(c);
  }
  Ok(out)
}

/// Deletes App Tests chats (and their CLI session links); other chats are left alone.
pub async fn delete(pool: &SqlitePool, chat_ids: &[String]) -> Result<usize> {
  let mut n = 0;
  for id in chat_ids {
    let scope: Option<String> = sqlx::query_scalar("SELECT scope FROM assistant_chats WHERE id = ?1").bind(id).fetch_optional(pool).await?;
    if scope.as_deref() == Some(TEST_SCOPE) {
      store::delete(pool, id).await?;
      n += 1;
    }
  }
  Ok(n)
}

fn str_of(v: &Value, key: &str) -> String {
  v.get(key).and_then(Value::as_str).unwrap_or_default().to_string()
}

#[cfg(test)]
mod tests {
  use super::*;

  #[tokio::test]
  async fn lists_test_chats_with_their_case_and_hides_them_from_the_assistant() {
    let dir = tempfile::tempdir().unwrap();
    let pool = crate::db::open(&dir.path().join("singl.db")).await.unwrap();
    let mine = store::create(&pool).await.unwrap();
    let test = store::create_in(&pool, TEST_SCOPE).await.unwrap();
    sqlx::query("INSERT INTO ui_test_suites (id, name, createdAt, updatedAt) VALUES ('s1', 'Suite one', 0, 0)").execute(&pool).await.unwrap();
    let result = serde_json::json!({ "cases": [{ "caseId": "c1", "title": "Login", "status": "failed", "reason": "no", "chatId": test.id, "durationMs": 7 }] });
    sqlx::query("INSERT INTO automation_runs (id, kind, refId, name, status, result, startedAt) VALUES ('r1', 'uitest', 's1', 'x', 'failed', ?1, 5)")
      .bind(result.to_string())
      .execute(&pool)
      .await
      .unwrap();

    let listed: Vec<String> = store::list(&pool, 50).await.unwrap().into_iter().map(|c| c.id).collect();
    assert_eq!(listed, vec![mine.id.clone()]);
    assert!(store::get(&pool, &test.id).await.is_ok());

    let chats = list(&pool, Some("s1")).await.unwrap();
    assert_eq!(chats.len(), 1);
    assert_eq!((chats[0].suite_name.as_str(), chats[0].case_title.as_str(), chats[0].status.as_str()), ("Suite one", "Login", "failed"));
    assert_eq!(chats[0].run_id, "r1");
    assert!(list(&pool, Some("other")).await.unwrap().is_empty());

    assert_eq!(delete(&pool, &[test.id.clone(), mine.id.clone()]).await.unwrap(), 1);
    assert!(list(&pool, None).await.unwrap().is_empty());
    assert!(store::get(&pool, &mine.id).await.is_ok());
  }
}
