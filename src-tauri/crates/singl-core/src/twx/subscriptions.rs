//! ThingWorx subscriptions (what a Thing listens for), the Scheduler and
//! Timer templates (Things that fire an event on a schedule), and firing an
//! event by hand. Services go through `Client::execute_service`; firing an
//! event posts to `/Things/{thing}/Events/{event}`, which the Client does
//! not expose, so it has its own request.

use serde::Serialize;
use serde_json::{Value, json};
use sqlx::SqlitePool;

use super::api::Client;
use crate::{CoreError, Result};

/// The templates whose Things run on a schedule, and the event a run fires.
pub const SCHEDULED_TEMPLATES: [(&str, &str); 2] = [("Scheduler", "ScheduledEvent"), ("Timer", "Timer")];

/// One event a subscription listens to.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SubscriptionEvent {
  pub event_name: String,
  pub source: String,
  pub source_type: String,
}

/// A subscription on a Thing, as GetInstanceSubscriptions lists it.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Subscription {
  pub name: String,
  /// The entity that declares it, e.g. "Thing X:Thing" or a template.
  pub owner: String,
  pub enabled: bool,
  /// Declared by a template or shape rather than by the Thing itself.
  pub inherited: bool,
  pub events: Vec<SubscriptionEvent>,
}

/// A Thing from a scheduled template, with the settings that drive its runs.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ScheduledThing {
  pub name: String,
  pub template: String,
  pub enabled: Option<bool>,
  /// Quartz-style cron string (Scheduler Things).
  pub schedule: Option<String>,
  /// Milliseconds between runs (Timer Things).
  pub interval_ms: Option<f64>,
  /// The event a run fires.
  pub event: String,
}

fn text_of(v: &Value, key: &str) -> String {
  v.get(key).and_then(Value::as_str).unwrap_or("").to_string()
}

/// The rows of an infotable (`{dataShape, rows}`), or none.
fn rows_of(table: &Value) -> Vec<Value> {
  table.get("rows").and_then(Value::as_array).cloned().unwrap_or_default()
}

/// Rows of an infotable reply as text; a blank reply has none.
fn parse_rows(text: &str, what: &str) -> Result<Vec<Value>> {
  let json: Value = serde_json::from_str(if text.trim().is_empty() { "null" } else { text })
    .map_err(|e| CoreError::Twx { status: 0, message: format!("{what} failed — unexpected response: {e}") })?;
  Ok(rows_of(&json))
}

/// The subscriptions of `thing` from a GetInstanceSubscriptions reply. A
/// subscription is inherited when its owner is not "<thing>:Thing".
pub fn parse_subscriptions(thing: &str, text: &str) -> Result<Vec<Subscription>> {
  let own = format!("{thing}:Thing");
  Ok(
    parse_rows(text, &format!("GetInstanceSubscriptions {thing}"))?
      .iter()
      .map(|row| {
        let owner = text_of(row, "owner");
        let events = row.get("events").map(rows_of).unwrap_or_default();
        Subscription {
          name: text_of(row, "name"),
          inherited: owner != own,
          owner,
          enabled: row.get("enabled").and_then(Value::as_bool).unwrap_or(false),
          events: events
            .iter()
            .map(|e| SubscriptionEvent {
              event_name: text_of(e, "eventName"),
              source: text_of(e, "source"),
              source_type: text_of(e, "sourceType"),
            })
            .collect(),
        }
      })
      .collect(),
  )
}

/// Subscriptions of a Thing, own and inherited.
pub async fn thing_subscriptions(client: &Client, thing: &str) -> Result<Vec<Subscription>> {
  let text = client.execute_service("Things", thing, "GetInstanceSubscriptions", &json!({})).await?;
  parse_subscriptions(thing, &text)
}

pub async fn set_subscription_enabled(client: &Client, thing: &str, subscription: &str, enabled: bool) -> Result<()> {
  let service = if enabled { "EnableSubscription" } else { "DisableSubscription" };
  client.execute_service("Things", thing, service, &json!({ "subscriptionName": subscription })).await?;
  Ok(())
}

pub async fn set_thing_enabled(client: &Client, thing: &str, enabled: bool) -> Result<()> {
  let service = if enabled { "EnableThing" } else { "DisableThing" };
  client.execute_service("Things", thing, service, &json!({})).await?;
  Ok(())
}

/// Every Thing from the Scheduler and Timer templates, with its enabled flag
/// and its schedule from the Settings configuration table. No service reports
/// a last or next run time, so neither is returned.
pub async fn scheduled_things(client: &Client) -> Result<Vec<ScheduledThing>> {
  let mut out = Vec::new();
  for (template, event) in SCHEDULED_TEMPLATES {
    let what = format!("GetImplementingThings {template}");
    let text = client.execute_service("ThingTemplates", template, "GetImplementingThings", &json!({})).await?;
    for row in parse_rows(&text, &what)? {
      let name = text_of(&row, "name");
      if name.is_empty() {
        continue;
      }
      let enabled = client.property_value(&name, "Enabled").await?.as_bool();
      let settings = client
        .execute_service("Things", &name, "GetConfigurationTable", &json!({ "tableName": "Settings" }))
        .await?;
      let setting = parse_rows(&settings, &format!("GetConfigurationTable {name}"))?.into_iter().next().unwrap_or(Value::Null);
      out.push(ScheduledThing {
        enabled,
        schedule: setting.get("schedule").and_then(Value::as_str).map(String::from),
        interval_ms: setting.get("updateRate").and_then(Value::as_f64),
        template: template.into(),
        event: event.into(),
        name,
      });
    }
  }
  Ok(out)
}

/// Fires `event` on `thing` with `inputs` as its JSON body. Resolves with
/// the server's reply, or "null" when it sends none.
pub async fn fire_event(pool: &SqlitePool, env: &str, thing: &str, event: &str, inputs: &Value) -> Result<String> {
  let (base, app_key): (String, String) =
    sqlx::query_as("SELECT twxBaseUrl, twxAppKey FROM environment_settings WHERE environment = ?1 AND enabled = 1")
      .bind(env)
      .fetch_optional(pool)
      .await?
      .ok_or_else(|| CoreError::NotFound(format!("No enabled environment \"{env}\". Enable it in Settings.")))?;
  let mut url = reqwest::Url::parse(base.trim_end_matches('/'))
    .map_err(|e| CoreError::Invalid(format!("Invalid ThingWorx URL {base}: {e}")))?;
  url
    .path_segments_mut()
    .map_err(|_| CoreError::Invalid(format!("Invalid ThingWorx URL {base}")))?
    .pop_if_empty()
    .extend(["Things", thing, "Events", event]);
  let what = format!("FireEvent {thing}.{event}");
  let res = reqwest::Client::new()
    .post(url)
    .header("appKey", app_key)
    .header("Accept", "application/json")
    .json(inputs)
    .send()
    .await
    .map_err(|e| CoreError::Twx { status: 0, message: format!("{what} failed — {e}") })?;
  let status = res.status();
  let body = res.text().await.unwrap_or_default();
  if !status.is_success() {
    let said: String = body.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(300).collect();
    let said = if said.is_empty() { "no reason given".to_string() } else { said };
    return Err(CoreError::Twx { status: status.as_u16(), message: format!("{what} failed — {said} (HTTP {})", status.as_u16()) });
  }
  Ok(if body.trim().is_empty() { "null".into() } else { body })
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn reads_own_and_inherited_subscriptions() {
    let text = r#"{"dataShape":{},"rows":[
      {"name":"SyncSub","owner":"Scheduler.X:Thing","enabled":true,
       "aspects":{"rows":[]},
       "events":{"rows":[{"eventName":"ScheduledEvent","source":"Scheduler.X","sourceType":"Thing"}]}},
      {"name":"Inh","owner":"SchedulerTemplate:ThingTemplate","enabled":false,"events":{"rows":[]}}
    ]}"#;
    let subs = parse_subscriptions("Scheduler.X", text).unwrap();
    assert_eq!(subs.len(), 2);
    assert!(!subs[0].inherited);
    assert_eq!(subs[0].events[0].event_name, "ScheduledEvent");
    assert!(subs[1].inherited);
    assert!(!subs[1].enabled);
    assert!(subs[1].events.is_empty());
  }

  #[test]
  fn blank_reply_has_no_subscriptions() {
    assert!(parse_subscriptions("X", "null").unwrap().is_empty());
    assert!(parse_subscriptions("X", "").unwrap().is_empty());
  }
}
