//! ThingWorx logs and property writes.

use serde_json::json;

use super::twx::client;
use super::{Args, Risk, Tool, schema, ser, tool};
use crate::twx::logs::{self, LogQuery};

/// Longest message kept per row, so a stack-trace flood stays readable.
const MAX_MESSAGE: usize = 2000;

pub fn tools() -> Vec<Tool> {
  let env = json!({ "type": "string", "description": "Environment name from Settings. Default: the one on screen, else the first enabled." });
  let s = |d: &str| json!({ "type": "string", "description": d });

  vec![
    tool(
      "twx_query_logs",
      "Query a ThingWorx server's logs, newest first. Rows: timestamp (epoch ms), level, origin, thread, user, instance, message.",
      schema(
        json!({
          "env": env,
          "log": s("ApplicationLog (default), ScriptLog, ErrorLog, SecurityLog, CommunicationLog or ConfigurationLog."),
          "search": s("Text to find in the message (wildcards * allowed)."),
          "level": s("Minimum level: TRACE, DEBUG, INFO, WARN or ERROR."),
          "lastMinutes": { "type": "integer", "description": "Only entries from the last N minutes." },
          "since": { "type": "integer", "description": "Start, epoch milliseconds. Ignored when lastMinutes is set." },
          "until": { "type": "integer", "description": "End, epoch milliseconds." },
          "origin": s("Logger name, e.g. a class or Thing name."),
          "user": s("Only entries by this user."),
          "limit": { "type": "integer", "description": "Max rows. Default 200." }
        }),
        &[],
      ),
      Risk::Read,
      |a, args, _| async move {
        let c = client(&a, &args).await?;
        let x = Args(&args);
        let q = LogQuery {
          log: x.str("log").map(String::from),
          search: x.str("search").map(String::from),
          level: x.str("level").map(String::from),
          since: match x.i64("lastMinutes") {
            Some(m) => Some(logs::now_ms() - m.max(1) * 60_000),
            None => x.i64("since"),
          },
          until: x.i64("until"),
          origin: x.str("origin").map(String::from),
          user: x.str("user").map(String::from),
          limit: Some(x.i64("limit").unwrap_or(200).clamp(1, 5000) as u32),
          ..Default::default()
        };
        let mut rows = logs::query(&c, &q).await?;
        for r in &mut rows {
          if r.message.chars().count() > MAX_MESSAGE {
            r.message = r.message.chars().take(MAX_MESSAGE).collect::<String>() + "… (truncated)";
          }
        }
        ser(&rows)
      },
    ),
    tool(
      "twx_set_property_values",
      "Write property values on a ThingWorx Thing (changes the live server). values maps property name to new value.",
      schema(
        json!({
          "env": env,
          "thing": s("Thing name."),
          "values": { "type": "object", "description": "Property name to new value, e.g. {\"Setpoint\": 5, \"Name\": \"x\"}." }
        }),
        &["thing", "values"],
      ),
      Risk::Destructive,
      |a, args, _| async move {
        let c = client(&a, &args).await?;
        let thing = Args(&args).need("thing")?;
        let values = Args(&args).object("values")?;
        logs::set_property_values(&c, thing, &values).await?;
        let names: Vec<&String> = values.as_object().map(|o| o.keys().collect()).unwrap_or_default();
        ser(&json!({ "thing": thing, "written": names }))
      },
    ),
  ]
}
