//! System prompt, per-screen profiles and suggested prompts.
//!
//! A screen profile says what a page is for and how to work on it; the
//! runner puts the current one, plus the live screen context, in every
//! system prompt. Suggestions are plain rules over the screen context, no
//! model call.

use serde::Serialize;
use serde_json::Value;

use super::context::{ScreenContext, is_empty};

pub struct ScreenProfile {
  pub id: &'static str,
  pub title: &'static str,
  /// What the screen is for and how to help on it.
  pub guide: &'static str,
}

pub const SCREENS: &[ScreenProfile] = &[
  ScreenProfile {
    id: "home",
    title: "Home",
    guide: "Landing page. Help the user find the right screen; use navigate to take them there.",
  },
  ScreenProfile {
    id: "repo",
    title: "TWX Repository",
    guide: "Git working copy of the ThingWorx sources. Status, diffs, branches, pull and file search. \
            When files or hunks are selected, explain or review exactly those.",
  },
  ScreenProfile {
    id: "repo2",
    title: "Windchill Repository",
    guide: "Git working copy of the Windchill sources. Same tools as the TWX repository.",
  },
  ScreenProfile {
    id: "twx-entities",
    title: "Entities",
    guide: "Local ThingWorx entity files (twx-entities/) next to a live server. The open entity and its \
            selected services are in the context. Explain, review or edit service code; compare with the \
            server; export or re-export. Service code edits go to the .js service files, never entity XML.",
  },
  ScreenProfile {
    id: "twx-services",
    title: "Services",
    guide: "Search and run ThingWorx services with saved input presets. Help build inputs, run the selected \
            service (twx_invoke_service asks first) and explain its result.",
  },
  ScreenProfile {
    id: "twx-flow",
    title: "Flows",
    guide: "Visual service flows: nodes call ThingWorx services, code, conditions and agents. Selected nodes \
            and edges are in the context. Explain, debug or change the flow; run it when asked.",
  },
  ScreenProfile {
    id: "twx-migrate",
    title: "Migrate",
    guide: "Moves entities between ThingWorx environments. Check what will change before anything is written.",
  },
  ScreenProfile {
    id: "json-table",
    title: "JSON to Table",
    guide: "Turns JSON (often infotables) into a table. Explain the data, find rows, summarise columns.",
  },
  ScreenProfile {
    id: "compare",
    title: "Compare",
    guide: "Compares two folders or files (e.g. repo vs exported entities). Explain the selected differences.",
  },
  ScreenProfile {
    id: "deploy",
    title: "Deploy",
    guide: "Exports, bundles and uploads deployment files to ThingWorx. Every upload is destructive: list \
            what will go where, and let the approval prompt confirm it.",
  },
  ScreenProfile {
    id: "assistant",
    title: "AI Assistant",
    guide: "Full-page assistant with chat history. Nothing on screen to act on besides the conversation itself; use navigate to take the user to the screen a task needs.",
  },
  ScreenProfile {
    id: "settings",
    title: "Settings",
    guide: "Environments, credentials, paths and assistant settings. Never reveal secrets.",
  },
];

pub fn profile(screen: &str) -> Option<&'static ScreenProfile> {
  SCREENS.iter().find(|s| s.id == screen)
}

/// The screen id for a route: `/twx-entities/x` → `twx-entities`, `/` → `home`.
pub fn screen_for_route(route: &str) -> String {
  let first = route.trim_start_matches('/').split(['/', '?', '#']).next().unwrap_or_default();
  if first.is_empty() { "home".into() } else { first.into() }
}

const BASE: &str = "You are the assistant built into singl, a desktop app for ThingWorx and Windchill \
development. You can operate the whole app through your tools: read and change ThingWorx entities and \
services, run flows, work with the git repositories, compare, deploy, change settings, and drive the UI \
(navigate, run page actions).

How to work:
- The user's current screen and selection are below. \"This\", \"it\", \"the selected…\" refer to them. \
Call get_screen_context or get_selection for full details instead of guessing.
- Items the user pinned to a message (\"Add to chat\") arrive as <pinned kind=… label=…> blocks before \
their text; when they say \"these\" or \"this\", they usually mean the pinned items. A pinned item may be \
trimmed; fetch the rest with tools when you need it.
- Prefer doing over describing: use tools to look things up before answering.
- Tools that change things may ask the user for approval; if they decline, do not retry the same call.
- Be concise. Use Markdown. Put code in fenced blocks with a language.
- Never print secrets (API keys, app keys, tokens).";

/// The system prompt for one turn.
pub fn system_prompt(ctx_block: &str, ctx: &ScreenContext) -> String {
  let screen = if ctx.screen.is_empty() { screen_for_route(&ctx.route) } else { ctx.screen.clone() };
  let mut out = String::from(BASE);
  if let Some(p) = profile(&screen) {
    out.push_str(&format!("\n\n## Current screen: {}\n{}", p.title, p.guide));
  }
  out.push_str("\n\n## Screen context\n");
  out.push_str(ctx_block);
  out
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Suggestion {
  pub label: String,
  pub prompt: String,
}

fn s(label: &str, prompt: &str) -> Suggestion {
  Suggestion { label: label.into(), prompt: prompt.into() }
}

fn count(v: &Value) -> usize {
  match v {
    Value::Array(a) => a.len(),
    Value::Null => 0,
    _ => 1,
  }
}

/// Prompts worth offering for what is on screen and selected.
pub fn suggestions(ctx: &ScreenContext) -> Vec<Suggestion> {
  let screen = if ctx.screen.is_empty() { screen_for_route(&ctx.route) } else { ctx.screen.clone() };
  let sel = &ctx.selection;
  let has_sel = !is_empty(sel);
  let has_code = sel.get("code").and_then(|c| c.get("text")).and_then(Value::as_str).is_some_and(|t| !t.trim().is_empty());
  let mut out = Vec::new();

  if has_code {
    out.push(s("Explain selected code", "Explain the selected code."));
    out.push(s("Find bugs", "Review the selected code for bugs and edge cases."));
    out.push(s("Improve it", "Suggest a cleaner version of the selected code."));
  }
  match screen.as_str() {
    "twx-entities" => {
      let services = sel.get("services").map(count).unwrap_or(0);
      if services > 0 {
        out.push(s("Explain service", "Explain what the selected service does, its inputs and output."));
        out.push(s("Write test inputs", "Write example inputs to test the selected service."));
        out.push(s("Compare with server", "Compare the selected service with the version on the server."));
      } else if ctx.data.get("entity").is_some() {
        out.push(s("Summarise entity", "Summarise the open entity: its services, properties and what it is for."));
        out.push(s("Find usages", "Find where the open entity is used."));
      } else {
        out.push(s("Find an entity", "Help me find an entity: "));
      }
    }
    "twx-services" => {
      out.push(s("Build inputs", "Build inputs for the selected service."));
      out.push(s("Explain last result", "Explain the last result of the selected service."));
    }
    "twx-flow" => {
      if has_sel {
        out.push(s("Explain selected nodes", "Explain what the selected nodes do."));
        out.push(s("Debug this", "Help me debug the selected part of the flow."));
      } else {
        out.push(s("Explain flow", "Explain this flow step by step."));
      }
    }
    "repo" | "repo2" => {
      out.push(s("Summarise changes", "Summarise my uncommitted changes."));
      if has_sel {
        out.push(s("Review selection", "Review the selected changes."));
      }
    }
    "compare" => out.push(s("Explain differences", "Explain the selected differences.")),
    "deploy" => out.push(s("What will deploy?", "List what would be deployed and where, without deploying.")),
    "json-table" => out.push(s("Summarise data", "Summarise this data: columns, row count, notable values.")),
    _ => {}
  }
  if out.is_empty() {
    out.push(s("What can you do here?", "What can you help me with on this screen?"));
  }
  out.truncate(4);
  out
}

#[cfg(test)]
mod tests {
  use super::*;
  use serde_json::json;

  #[test]
  fn routes_map_to_screens() {
    assert_eq!(screen_for_route("/"), "home");
    assert_eq!(screen_for_route("/twx-entities/x?y"), "twx-entities");
  }

  #[test]
  fn selection_changes_suggestions() {
    let mut ctx = ScreenContext { route: "/twx-entities".into(), ..Default::default() };
    assert_eq!(suggestions(&ctx)[0].label, "Find an entity");
    ctx.selection = json!({ "services": ["GetData"] });
    assert_eq!(suggestions(&ctx)[0].label, "Explain service");
    ctx.selection = json!({ "code": { "text": "var x = 1;" } });
    assert_eq!(suggestions(&ctx)[0].label, "Explain selected code");
  }
}
