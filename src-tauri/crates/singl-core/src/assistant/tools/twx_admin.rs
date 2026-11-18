//! Server administration tools: health, connectors, and Stream / Value Stream / DataTable queries.
//! All read-only.

use serde_json::json;

use super::twx::client;
use super::{Args, Risk, Tool, schema, ser, tool};
use crate::twx::admin::{self, DataTableQuery, StreamQuery};

/// Rows the assistant gets back at most; the full query is on the Streams tab.
const MAX_ROWS: i64 = 500;

pub fn tools() -> Vec<Tool> {
  let env = json!({ "type": "string", "description": "Environment name from Settings. Default: the one on screen, else the first enabled." });
  let s = |d: &str| json!({ "type": "string", "description": d });

  vec![
    tool(
      "twx_server_health",
      "Health of a ThingWorx server: version and build, uptime, memory in use, queue sizes, license, entity counts (things, connected things), \
       the state of every subsystem, installed extensions, and the latency of a ping. Sections that failed are named in `errors`.",
      schema(json!({ "env": env }), &[]),
      Risk::Read,
      |a, args, _| async move {
        let c = client(&a, &args).await?;
        let (ping, health) = tokio::join!(admin::ping(&c), admin::health(&c));
        ser(&json!({ "ping": ping, "health": health }))
      },
    ),
    tool(
      "twx_list_streams",
      "The Streams and Value Streams on a ThingWorx server (name, description, whether shipped with the platform).",
      schema(json!({ "env": env }), &[]),
      Risk::Read,
      |a, args, _| async move { ser(&admin::list_streams(&client(&a, &args).await?).await?) },
    ),
    tool(
      "twx_query_stream",
      "Read entries of a Stream (`stream`), or the history of one logged property of a Thing in a Value Stream (`thing` + `property`), \
       between `since` and `until`. Times are ISO 8601, epoch ms, or relative like 24h, 7d, 30m. Newest first unless oldestFirst.",
      schema(
        json!({
          "env": env,
          "stream": s("Stream name; its entries are read."),
          "thing": s("Thing whose logged property history is read (with property)."),
          "property": s("Logged property of the thing."),
          "since": s("Start time. ISO 8601, epoch ms, or relative (24h, 7d)."),
          "until": s("End time, same forms. Default: now."),
          "limit": { "type": "integer", "description": "Rows to return. Default 50, at most 500." },
          "oldestFirst": { "type": "boolean" },
        }),
        &[],
      ),
      Risk::Read,
      |a, args, _| async move {
        let c = client(&a, &args).await?;
        let x = Args(&args);
        let q = StreamQuery {
          stream: x.str("stream").map(String::from),
          thing: x.str("thing").map(String::from),
          property: x.str("property").map(String::from),
          since: x.str("since").map(String::from),
          until: x.str("until").map(String::from),
          max_items: Some(x.i64("limit").unwrap_or(50).clamp(1, MAX_ROWS) as u32),
          oldest_first: x.bool("oldestFirst"),
        };
        ser(&admin::query_stream(&c, &q).await?)
      },
    ),
    tool(
      "twx_list_connectors",
      "Integration connectors on a ThingWorx server (OData, Swagger/Windchill, SAP ...): name, template, kind, enabled, configured base URL,        authentication type and non-secret connection settings (credentials are never returned). The platform keeps no connected flag;        the Health tab has a per-connector Test button, not available here.",
      schema(json!({ "env": env }), &[]),
      Risk::Read,
      |a, args, _| async move { ser(&admin::list_connectors(&client(&a, &args).await?).await?) },
    ),
    tool(
      "twx_list_datatables",
      "The DataTables on a ThingWorx server (name, description, whether shipped with the platform).",
      schema(json!({ "env": env }), &[]),
      Risk::Read,
      |a, args, _| async move { ser(&admin::list_datatables(&client(&a, &args).await?).await?) },
    ),
    tool(
      "twx_query_datatable",
      "Read entries of a DataTable (it also returns column names and types). `search` is plain text (matched as *text*) or a ThingWorx        search expression; `query` is a ThingWorx query as JSON text, e.g. {\"filters\":{\"type\":\"EQ\",\"fieldName\":\"Name\",\"value\":\"x\"}}.        Find table names with twx_list_datatables.",
      schema(
        json!({
          "env": env,
          "datatable": s("DataTable name."),
          "search": s("Text or search expression to look for in the entries."),
          "query": s("ThingWorx query filter as JSON text (advanced)."),
          "limit": { "type": "integer", "description": "Rows to return. Default 50, at most 500." },
        }),
        &["datatable"],
      ),
      Risk::Read,
      |a, args, _| async move {
        let c = client(&a, &args).await?;
        let x = Args(&args);
        let q = DataTableQuery {
          table: x.str("datatable").unwrap_or_default().to_string(),
          search: x.str("search").map(String::from),
          query: x.str("query").map(String::from),
          max_items: Some(x.i64("limit").unwrap_or(50).clamp(1, MAX_ROWS) as u32),
        };
        ser(&admin::query_datatable(&c, &q).await?)
      },
    ),
  ]
}
