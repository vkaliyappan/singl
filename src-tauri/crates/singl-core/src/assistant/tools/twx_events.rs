//! ThingWorx subscriptions, events, and the Scheduler and Timer Things.
//! Enabling, disabling and firing change the live server, so they are
//! Destructive and always ask.

use serde_json::{Value, json};

use super::twx::{client, resolve_env};
use super::{Args, Risk, Tool, schema, ser, tool};
use crate::CoreError;
use crate::twx::subscriptions;

fn flag(args: &Value) -> crate::Result<bool> {
  Args(args).bool("enabled").ok_or_else(|| CoreError::Invalid("\"enabled\" must be true or false.".into()))
}

fn word(enabled: bool) -> &'static str {
  if enabled { "Enabled" } else { "Disabled" }
}

pub fn tools() -> Vec<Tool> {
  let env = json!({ "type": "string", "description": "Environment name from Settings. Default: the one on screen, else the first enabled." });
  let thing = json!({ "type": "string", "description": "Thing name, e.g. \"Scheduler.CHBU.OptionCostingReportScheduler\"." });
  let s = json!({ "type": "string" });
  let enabled = json!({ "type": "boolean", "description": "true to enable, false to disable." });

  vec![
    tool(
      "twx_list_subscriptions",
      "Subscriptions of a ThingWorx Thing: name, owner, enabled, inherited (declared by a template), and the events it listens to (source, event).",
      schema(json!({ "env": env, "thingName": thing }), &["thingName"]),
      Risk::Read,
      |a, args, _| async move {
        let c = client(&a, &args).await?;
        ser(&subscriptions::thing_subscriptions(&c, Args(&args).need("thingName")?).await?)
      },
    ),
    tool(
      "twx_set_subscription_enabled",
      "Enable or disable one subscription on a ThingWorx Thing. Changes the live server.",
      schema(
        json!({ "env": env, "thingName": thing, "subscriptionName": s, "enabled": enabled }),
        &["thingName", "subscriptionName", "enabled"],
      ),
      Risk::Destructive,
      |a, args, _| async move {
        let x = Args(&args);
        let (name, sub) = (x.need("thingName")?, x.need("subscriptionName")?);
        let on = flag(&args)?;
        let c = client(&a, &args).await?;
        subscriptions::set_subscription_enabled(&c, name, sub, on).await?;
        Ok(format!("{} subscription {sub} on {name}.", word(on)))
      },
    ),
    tool(
      "twx_fire_event",
      "Fire an event on a ThingWorx Thing with a JSON body as its input. Runs the event's subscribers on the live server.",
      schema(
        json!({
          "env": env, "thingName": thing, "eventName": s,
          "inputs": { "type": "object", "additionalProperties": {}, "description": "Event inputs by name. Default {}." },
        }),
        &["thingName", "eventName"],
      ),
      Risk::Destructive,
      |a, args, _| async move {
        let x = Args(&args);
        let inputs = x.object("inputs")?;
        let env = resolve_env(&a, &args).await?;
        let pool = a.pool().await;
        subscriptions::fire_event(&pool, &env, x.need("thingName")?, x.need("eventName")?, &inputs).await
      },
    ),
    tool(
      "twx_list_schedulers",
      "Things from the Scheduler and Timer templates: name, template, enabled, schedule (cron string for Schedulers, interval in ms for Timers), and the event a run fires.",
      schema(json!({ "env": env }), &[]),
      Risk::Read,
      |a, args, _| async move { ser(&subscriptions::scheduled_things(&client(&a, &args).await?).await?) },
    ),
    tool(
      "twx_set_thing_enabled",
      "Enable or disable a ThingWorx Thing (EnableThing / DisableThing). For a Scheduler or Timer, this stops or starts its runs. Changes the live server.",
      schema(json!({ "env": env, "thingName": thing, "enabled": enabled }), &["thingName", "enabled"]),
      Risk::Destructive,
      |a, args, _| async move {
        let name = Args(&args).need("thingName")?;
        let on = flag(&args)?;
        let c = client(&a, &args).await?;
        subscriptions::set_thing_enabled(&c, name, on).await?;
        Ok(format!("{} Thing {name}.", word(on)))
      },
    ),
  ]
}
