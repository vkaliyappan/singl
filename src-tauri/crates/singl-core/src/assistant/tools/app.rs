//! App-level tools: screen context, UI control, chats, MCP servers.

use serde_json::{Value, json};

use super::{Args, Risk, Tool, schema, ser, tool};
use crate::CoreError;
use crate::assistant::context::is_empty;
use crate::assistant::prompt::SCREENS;
use crate::assistant::runner::SendRequest;
use crate::assistant::store;

pub fn tools() -> Vec<Tool> {
  let screen_ids: Vec<&str> = SCREENS.iter().map(|s| s.id).collect();
  vec![
    tool(
      "get_screen_context",
      "What the user is looking at in singl right now: screen, page state, selection, and the page actions \
       run_ui_action can do. Call this first whenever the request refers to \"this\", \"it\" or \"selected\".",
      schema(json!({}), &[]),
      Risk::Read,
      |a, _, _| async move {
        let ctx = a.context.get();
        if ctx.route.is_empty() && ctx.screen.is_empty() {
          return Ok("The app window has not reported a screen.".into());
        }
        ser(&ctx)
      },
    ),
    tool(
      "get_selection",
      "Only what the user has selected on the current screen (rows, nodes, files, services, code range and text).",
      schema(json!({}), &[]),
      Risk::Read,
      |a, _, _| async move {
        let ctx = a.context.get();
        if is_empty(&ctx.selection) {
          return Ok("Nothing is selected.".into());
        }
        ser(&ctx.selection)
      },
    ),
    tool(
      "list_screens",
      "Every screen in singl with what it is for. Use with navigate.",
      schema(json!({}), &[]),
      Risk::Read,
      |_, _, _| async move {
        let list: Vec<Value> = SCREENS
          .iter()
          .map(|s| json!({ "screen": s.id, "route": route_of(s.id), "title": s.title, "about": s.guide }))
          .collect();
        ser(&list)
      },
    ),
    tool(
      "navigate",
      "Open a screen in the singl window. Optional query parameters are passed in the URL.",
      schema(
        json!({
          "screen": { "type": "string", "enum": screen_ids, "description": "Screen id from list_screens." },
          "query": { "type": "object", "additionalProperties": { "type": "string" }, "description": "URL query parameters." },
        }),
        &["screen"],
      ),
      Risk::Read,
      |a, args, _| async move {
        let args = Args(&args);
        let screen = args.need("screen")?;
        if !SCREENS.iter().any(|s| s.id == screen) {
          return Err(CoreError::Invalid(format!("Unknown screen \"{screen}\". See list_screens.")));
        }
        let mut route = route_of(screen);
        if let Some(q) = args.0.get("query").and_then(Value::as_object) {
          let pairs: Vec<String> = q
            .iter()
            .filter_map(|(k, v)| v.as_str().map(|v| format!("{}={}", encode(k), encode(v))))
            .collect();
          if !pairs.is_empty() {
            route = format!("{route}?{}", pairs.join("&"));
          }
        }
        a.ui_request("navigate", json!({ "route": route })).await?;
        Ok(format!("Opened {route}."))
      },
    ),
    tool(
      "run_ui_action",
      "Run one of the current page's actions (listed by get_screen_context under `actions`), e.g. open an entity, \
       select rows, fill a field. Actions that change data ask the user first.",
      schema(
        json!({
          "action": { "type": "string", "description": "Action name from get_screen_context." },
          "args": { "type": "object", "description": "Arguments matching the action's inputSchema." },
        }),
        &["action"],
      ),
      // The real risk is the page's own (see Assistant::risk_of).
      Risk::Write,
      |a, args, _| async move {
        let a2 = Args(&args);
        let action = a2.need("action")?.to_string();
        let ctx = a.context.get();
        if !ctx.actions.iter().any(|x| x.name == action) {
          let names: Vec<&str> = ctx.actions.iter().map(|x| x.name.as_str()).collect();
          return Err(CoreError::Invalid(format!(
            "The current screen has no action \"{action}\". Available: {}",
            if names.is_empty() { "none".into() } else { names.join(", ") }
          )));
        }
        let result = a.ui_request("action", json!({ "action": action, "args": a2.object("args")? })).await?;
        Ok(if result.is_null() { "Done.".into() } else { ser(&result)? })
      },
    ),
    tool(
      "app_overview",
      "singl's setup: workspace folder, ThingWorx environments (no secrets) and connected MCP servers.",
      schema(json!({}), &[]),
      Risk::Read,
      |a, _, _| async move {
        let pool = a.pool().await;
        let envs: Vec<(String, String, i64)> =
          sqlx::query_as("SELECT environment, twxBaseUrl, enabled FROM environment_settings ORDER BY id")
            .fetch_all(&pool)
            .await?;
        let servers = a.mcp_clients.status(&a.mcp_servers().await?).await;
        ser(&json!({
          "workspaceRoot": a.workspace_root(),
          "environments": envs.into_iter().map(|(e, u, en)| json!({ "environment": e, "twxBaseUrl": u, "enabled": en != 0 })).collect::<Vec<_>>(),
          "mcpServers": servers,
        }))
      },
    ),
    tool(
      "assistant_list_chats",
      "Recent chats with singl's assistant.",
      schema(json!({ "limit": { "type": "integer", "description": "Default 30." } }), &[]),
      Risk::Read,
      |a, args, _| async move {
        let limit = Args(&args).i64("limit").unwrap_or(30).clamp(1, 200);
        ser(&store::list(&a.pool().await, limit).await?)
      },
    ),
    tool(
      "assistant_get_chat",
      "One chat with singl's assistant, every message.",
      schema(json!({ "chatId": { "type": "string" } }), &["chatId"]),
      Risk::Read,
      |a, args, _| async move { ser(&store::get(&a.pool().await, Args(&args).need("chatId")?).await?) },
    ),
    tool(
      "assistant_ask",
      "Ask singl's own assistant to do something, with any provider and model it supports, and wait for its answer. \
       The turn shows in the app's assistant panel and history.",
      schema(
        json!({
          "prompt": { "type": "string" },
          "provider": { "type": "string", "enum": crate::assistant::providers::ALL_PROVIDERS, "description": "Default: the app's default provider." },
          "model": { "type": "string" },
          "effort": { "type": "string", "enum": ["low", "medium", "high", "xhigh", "max"], "description": "Reasoning effort. Default: the provider's." },
          "chatId": { "type": "string", "description": "Continue this chat; omit for a new one." },
        }),
        &["prompt"],
      ),
      Risk::Write,
      |a, args, _| async move {
        let args = Args(&args);
        let settings = a.settings().await?;
        let provider = args.str("provider").map(String::from).unwrap_or(settings.default_provider.clone());
        let model = args.str("model").map(String::from).unwrap_or_else(|| {
          if provider == settings.default_provider { settings.default_model.clone() } else { String::new() }
        });
        let (chat_id, text) = a
          .ask(SendRequest {
            chat_id: args.str("chatId").map(String::from),
            provider,
            model,
            effort: args.str("effort").unwrap_or_default().to_string(),
            text: args.need("prompt")?.into(),
            attachments: Vec::new(),
            tools: None,
            skills: Vec::new(),
            approval: Default::default(),
            server_approval: None,
            inline_attachments: Vec::new(),
            references: Vec::new(),
            images: Vec::new(),
            sub_agents: None,
          })
          .await?;
        ser(&json!({ "chatId": chat_id, "answer": text }))
      },
    )
    .external_only(),
  ]
}

fn route_of(screen: &str) -> String {
  if screen == "home" { "/".into() } else { format!("/{screen}") }
}

fn encode(s: &str) -> String {
  s.bytes()
    .map(|b| match b {
      b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (b as char).to_string(),
      _ => format!("%{b:02X}"),
    })
    .collect()
}
