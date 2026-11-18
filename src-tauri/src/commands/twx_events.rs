//! Thin wrappers over singl-core's twx::subscriptions, for the TWX Server
//! page's Subscriptions and Schedulers tabs. Entity search reuses
//! `service_search`.

use serde_json::Value;
use singl_core::CoreError;
use singl_core::twx::projects;
use singl_core::twx::subscriptions::{self, ScheduledThing, Subscription};
use tauri::State;

use crate::error::IpcResult;
use crate::state::AppState;

fn require(value: &str, name: &str) -> IpcResult<()> {
  if value.trim().is_empty() { Err(CoreError::Invalid(format!("{name} is required")).into()) } else { Ok(()) }
}

/// The subscriptions of a Thing, own and inherited.
#[tauri::command]
pub async fn twx_thing_subscriptions(state: State<'_, AppState>, env: String, thing: String) -> IpcResult<Vec<Subscription>> {
  require(&thing, "thing")?;
  let client = projects::connect(&state.db().await, &env).await?;
  Ok(subscriptions::thing_subscriptions(&client, &thing).await?)
}

/// Enables or disables one subscription on a Thing.
#[tauri::command]
pub async fn twx_set_subscription_enabled(
  state: State<'_, AppState>,
  env: String,
  thing: String,
  subscription: String,
  enabled: bool,
) -> IpcResult<()> {
  require(&thing, "thing")?;
  require(&subscription, "subscription")?;
  let client = projects::connect(&state.db().await, &env).await?;
  Ok(subscriptions::set_subscription_enabled(&client, &thing, &subscription, enabled).await?)
}

/// Fires an event on a Thing with `inputs` as its JSON body; resolves with the server's reply.
#[tauri::command]
pub async fn twx_fire_event(
  state: State<'_, AppState>,
  env: String,
  thing: String,
  event: String,
  inputs: Option<Value>,
) -> IpcResult<String> {
  require(&thing, "thing")?;
  require(&event, "event")?;
  let inputs = inputs.unwrap_or_else(|| serde_json::json!({}));
  let pool = state.db().await;
  Ok(subscriptions::fire_event(&pool, &env, &thing, &event, &inputs).await?)
}

/// Things from the Scheduler and Timer templates, with their schedules.
#[tauri::command]
pub async fn twx_scheduled_things(state: State<'_, AppState>, env: String) -> IpcResult<Vec<ScheduledThing>> {
  let client = projects::connect(&state.db().await, &env).await?;
  Ok(subscriptions::scheduled_things(&client).await?)
}

/// Enables or disables a Thing (EnableThing / DisableThing).
#[tauri::command]
pub async fn twx_set_thing_enabled(state: State<'_, AppState>, env: String, thing: String, enabled: bool) -> IpcResult<()> {
  require(&thing, "thing")?;
  let client = projects::connect(&state.db().await, &env).await?;
  Ok(subscriptions::set_thing_enabled(&client, &thing, enabled).await?)
}
