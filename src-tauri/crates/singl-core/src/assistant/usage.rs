//! Token and cost metering: what each model call used and (when known) cost.
//!
//! Providers report usage in their own shapes; each parser folds it into
//! [`Usage`] with Anthropic's convention: `input` excludes cached tokens.
//! Cost is the provider's own figure when it gives one (OpenRouter, Claude
//! Code), else computed from [`PRICES`]; unknown models stay unpriced (`None`).

use serde::Serialize;
use serde_json::Value;
use sqlx::{FromRow, SqlitePool};

use crate::Result;
use crate::db::now;

#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
  pub input: u64,
  pub output: u64,
  pub cache_read: u64,
  pub cache_write: u64,
  /// Provider-reported cost; `None` = work it out from the price table.
  pub cost_usd: Option<f64>,
}

impl Usage {
  pub fn is_empty(&self) -> bool {
    self.input + self.output + self.cache_read + self.cache_write == 0 && self.cost_usd.is_none()
  }

  /// Adds another call's usage. The cost stays known only if both sides' are
  /// (an empty side counts as zero).
  pub fn add(&mut self, o: &Usage) {
    let cost = match (self.cost_usd, o.cost_usd) {
      (Some(a), Some(b)) => Some(a + b),
      (None, Some(b)) if self.is_empty() => Some(b),
      (Some(a), None) if o.is_empty() => Some(a),
      _ => None,
    };
    self.input += o.input;
    self.output += o.output;
    self.cache_read += o.cache_read;
    self.cache_write += o.cache_write;
    self.cost_usd = cost;
  }

  /// Anthropic `usage` object (message_start, message_delta, Claude Code `result`):
  /// sets each field that is present (later events carry running totals).
  pub fn merge_anthropic(&mut self, u: &Value) {
    let set = |slot: &mut u64, key: &str| {
      if let Some(n) = u[key].as_u64() {
        *slot = n;
      }
    };
    set(&mut self.input, "input_tokens");
    set(&mut self.output, "output_tokens");
    set(&mut self.cache_read, "cache_read_input_tokens");
    set(&mut self.cache_write, "cache_creation_input_tokens");
  }

  /// OpenAI-style `usage` (OpenRouter): `prompt_tokens` includes cached ones.
  pub fn from_openai(u: &Value) -> Usage {
    let details = &u["prompt_tokens_details"];
    let cache_read = details["cached_tokens"].as_u64().unwrap_or(0);
    let cache_write = details["cache_write_tokens"].as_u64().unwrap_or(0);
    Usage {
      input: u["prompt_tokens"].as_u64().unwrap_or(0).saturating_sub(cache_read + cache_write),
      output: u["completion_tokens"].as_u64().unwrap_or(0),
      cache_read,
      cache_write,
      cost_usd: u["cost"].as_f64(),
    }
  }

  /// Codex `turn.completed` usage: `input_tokens` includes the cached part.
  pub fn from_codex(u: &Value) -> Usage {
    let cache_read = u["cached_input_tokens"].as_u64().unwrap_or(0);
    Usage {
      input: u["input_tokens"].as_u64().unwrap_or(0).saturating_sub(cache_read),
      output: u["output_tokens"].as_u64().unwrap_or(0),
      cache_read,
      cache_write: 0,
      cost_usd: None,
    }
  }
}

/// USD per million tokens: (id, input, output, cache read). Cache writes cost 1.25x input.
/// From the Anthropic price list (2026-11). Cache reads are the published figure
/// where known, else 0.1x input (Fable 5/5.1, Opus 5/4.x, Sonnet 5/4.6, Haiku 5.5/4.5 are
/// that estimate).
const PRICES: &[(&str, f64, f64, f64)] = &[
  ("claude-fable-5-2", 8.0, 40.0, 0.20),
  ("claude-fable-5-1", 10.0, 50.0, 1.0),
  ("claude-fable-5", 10.0, 50.0, 1.0),
  ("claude-opus-5-5", 4.0, 20.0, 0.20),
  ("claude-opus-5", 5.0, 25.0, 0.50),
  ("claude-opus-4-8", 5.0, 25.0, 0.50),
  ("claude-opus-4-7", 5.0, 25.0, 0.50),
  ("claude-opus-4-6", 5.0, 25.0, 0.50),
  ("claude-sonnet-5-5", 2.0, 10.0, 0.10),
  ("claude-sonnet-5", 2.0, 10.0, 0.20),
  ("claude-sonnet-4-6", 3.0, 15.0, 0.30),
  ("claude-haiku-5-5", 0.10, 0.50, 0.01),
  ("claude-haiku-4-5", 1.0, 5.0, 0.10),
];

/// The price row for a model id (longest matching id prefix, so dated ids work).
fn price(model: &str) -> Option<(f64, f64, f64)> {
  let m = model.trim().to_lowercase();
  let m = m.strip_prefix("anthropic/").unwrap_or(&m);
  PRICES.iter().filter(|(id, ..)| m.starts_with(id)).max_by_key(|(id, ..)| id.len()).map(|&(_, i, o, r)| (i, o, r))
}

/// Cost in USD: the reported figure, else computed for Anthropic models, else `None`.
pub fn cost(provider: &str, model: &str, u: &Usage) -> Option<f64> {
  if u.cost_usd.is_some() {
    return u.cost_usd;
  }
  if !matches!(provider, "anthropic" | "claude") {
    return None;
  }
  let (i, o, r) = price(model)?;
  Some((u.input as f64 * i + u.output as f64 * o + u.cache_read as f64 * r + u.cache_write as f64 * i * 1.25) / 1e6)
}

/// Stores one call's usage; empty usage is skipped. Returns whether a row was added.
pub async fn record(pool: &SqlitePool, chat_id: &str, message_id: &str, provider: &str, model: &str, u: &Usage) -> Result<bool> {
  if u.is_empty() {
    return Ok(false);
  }
  sqlx::query(
    "INSERT INTO assistant_usage (chatId, messageId, provider, model, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, costUsd, createdAt)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
  )
  .bind(chat_id)
  .bind(message_id)
  .bind(provider)
  .bind(model)
  .bind(u.input as i64)
  .bind(u.output as i64)
  .bind(u.cache_read as i64)
  .bind(u.cache_write as i64)
  .bind(cost(provider, model, u))
  .bind(now())
  .execute(pool)
  .await?;
  Ok(true)
}

/// Totals over a set of calls.
#[derive(Debug, Clone, Default, FromRow, Serialize)]
#[sqlx(rename_all = "camelCase")]
#[serde(rename_all = "camelCase")]
pub struct Totals {
  pub calls: i64,
  pub input: i64,
  pub output: i64,
  pub cache_read: i64,
  pub cache_write: i64,
  /// Sum of the calls that have a cost.
  pub cost_usd: f64,
  /// Calls with no cost (unknown model, or a provider that reports none).
  pub unpriced_calls: i64,
}

const TOTALS: &str = "COUNT(*) AS calls, COALESCE(SUM(inputTokens),0) AS input, COALESCE(SUM(outputTokens),0) AS output,
  COALESCE(SUM(cacheReadTokens),0) AS cacheRead, COALESCE(SUM(cacheWriteTokens),0) AS cacheWrite,
  COALESCE(SUM(costUsd),0.0) AS costUsd, COALESCE(SUM(costUsd IS NULL),0) AS unpricedCalls";

pub async fn for_chat(pool: &SqlitePool, chat_id: &str) -> Result<Totals> {
  Ok(sqlx::query_as(&format!("SELECT {TOTALS} FROM assistant_usage WHERE chatId = ?1")).bind(chat_id).fetch_one(pool).await?)
}

#[derive(Debug, Clone, FromRow, Serialize)]
#[sqlx(rename_all = "camelCase")]
#[serde(rename_all = "camelCase")]
pub struct ModelUsage {
  pub provider: String,
  pub model: String,
  #[sqlx(flatten)]
  #[serde(flatten)]
  pub totals: Totals,
}

#[derive(Debug, Clone, FromRow, Serialize)]
#[sqlx(rename_all = "camelCase")]
#[serde(rename_all = "camelCase")]
pub struct DayUsage {
  /// Local date, `YYYY-MM-DD`.
  pub day: String,
  #[sqlx(flatten)]
  #[serde(flatten)]
  pub totals: Totals,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageSummary {
  pub total: Totals,
  pub by_model: Vec<ModelUsage>,
  /// Oldest first; days with no calls are left out.
  pub by_day: Vec<DayUsage>,
}

/// Totals for the last `days` days, overall, by provider/model and by day.
pub async fn summary(pool: &SqlitePool, days: i64) -> Result<UsageSummary> {
  let since = now() - days.max(1) * 86_400;
  let total = sqlx::query_as(&format!("SELECT {TOTALS} FROM assistant_usage WHERE createdAt >= ?1")).bind(since).fetch_one(pool).await?;
  let by_model = sqlx::query_as(&format!(
    "SELECT provider, model, {TOTALS} FROM assistant_usage WHERE createdAt >= ?1 GROUP BY provider, model ORDER BY costUsd DESC, input + output DESC"
  ))
  .bind(since)
  .fetch_all(pool)
  .await?;
  let by_day = sqlx::query_as(&format!(
    "SELECT date(createdAt, 'unixepoch', 'localtime') AS day, {TOTALS} FROM assistant_usage WHERE createdAt >= ?1 GROUP BY day ORDER BY day"
  ))
  .bind(since)
  .fetch_all(pool)
  .await?;
  Ok(UsageSummary { total, by_model, by_day })
}

#[cfg(test)]
mod tests {
  use super::*;
  use serde_json::json;

  #[test]
  fn prices_by_longest_prefix() {
    assert_eq!(price("claude-opus-5-5").unwrap().0, 4.0);
    assert_eq!(price("claude-opus-5").unwrap().0, 5.0);
    assert_eq!(price("claude-sonnet-4-6-20260101").unwrap().0, 3.0);
    assert!(price("opus").is_none());
  }

  #[test]
  fn cost_computed_or_reported() {
    let u = Usage { input: 1_000_000, output: 100_000, cache_read: 1_000_000, cache_write: 0, cost_usd: None };
    // 4 + 2 + 0.2
    assert!((cost("anthropic", "claude-opus-5-5", &u).unwrap() - 6.2).abs() < 1e-9);
    assert!(cost("anthropic", "mystery", &u).is_none());
    assert!(cost("openrouter", "claude-opus-5-5", &u).is_none());
    assert_eq!(cost("openrouter", "x", &Usage { cost_usd: Some(0.5), ..u }), Some(0.5));
  }

  #[test]
  fn parsers_follow_anthropic_convention() {
    let mut u = Usage::default();
    u.merge_anthropic(&json!({"input_tokens": 10, "output_tokens": 1, "cache_read_input_tokens": 5}));
    u.merge_anthropic(&json!({"output_tokens": 40}));
    assert_eq!((u.input, u.output, u.cache_read), (10, 40, 5));
    let o = Usage::from_openai(&json!({"prompt_tokens": 100, "completion_tokens": 7, "cost": 0.01, "prompt_tokens_details": {"cached_tokens": 60}}));
    assert_eq!((o.input, o.cache_read, o.cost_usd), (40, 60, Some(0.01)));
    let c = Usage::from_codex(&json!({"input_tokens": 50, "cached_input_tokens": 20, "output_tokens": 3}));
    assert_eq!((c.input, c.cache_read), (30, 20));
  }

  #[tokio::test]
  async fn records_and_summarises() {
    let dir = tempfile::tempdir().unwrap();
    let pool = crate::db::open(&dir.path().join("singl.db")).await.unwrap();
    let u = Usage { input: 100, output: 10, ..Default::default() };
    assert!(record(&pool, "c1", "m1", "anthropic", "claude-haiku-5-5", &u).await.unwrap());
    assert!(record(&pool, "c1", "m2", "codex", "gpt", &u).await.unwrap());
    assert!(!record(&pool, "c1", "m3", "codex", "gpt", &Usage::default()).await.unwrap());
    let chat = for_chat(&pool, "c1").await.unwrap();
    assert_eq!((chat.calls, chat.input, chat.unpriced_calls), (2, 200, 1));
    let s = summary(&pool, 30).await.unwrap();
    assert_eq!(s.by_model.len(), 2);
    assert_eq!(s.by_day.len(), 1);
    assert!(s.total.cost_usd > 0.0);
  }
}
