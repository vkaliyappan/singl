//! Tools offered on demand. Every tool definition is sent with every model
//! call, so a turn is only offered the `core` tools and the groups its screen
//! lists (see [`crate::assistant::prompt::SCREENS`]); everything else, MCP
//! servers' tools included, is found with `tools_find` and run with
//! `tools_call`. The approval, risk and tool-selection rules are the same as
//! for a tool called directly: [`crate::assistant::Assistant::call_tool`]
//! unwraps `tools_call` before anything else.

use std::collections::HashSet;

use serde_json::{Value, json};

use super::{Args, Risk, Tool, ToolSpec, schema, tool};
use crate::{CoreError, Result};

/// Always offered.
pub const CORE: &str = "core";
pub const FIND: &str = "tools_find";
pub const CALL: &str = "tools_call";

/// The groups besides `core`, with what they cover.
pub const GROUPS: &[(&str, &str)] = &[
  ("twx", "ThingWorx entities, services and properties: list, export, invoke"),
  ("server", "ThingWorx server admin: logs, health, streams, data tables, subscriptions, schedulers, permissions, import"),
  ("entities", "local entity files (read, edit, create), dependencies, undo"),
  ("services", "service search, run, input presets"),
  ("flows", "visual service flows"),
  ("repo", "git repositories"),
  ("files", "local files and folder/file compare"),
  ("deploy", "export, bundle and upload deployment files"),
  ("automation", "service test suites, drift reports, schedules"),
  ("apptests", "App Tests: write, import/export and run AI browser test cases for ThingWorx mashups"),
];

/// Groups offered when the screen has no profile.
pub const DEFAULT_GROUPS: &[&str] = &["twx", "entities", "services"];

/// The group of an MCP server's tool (`server__tool`), or `None` for a built-in.
pub fn mcp_group(name: &str) -> Option<&str> {
  name.split_once("__").map(|(server, _)| server)
}

/// `tools_find`'s description: what it can reach that is not offered now.
pub fn find_description(hidden: &[&ToolSpec], groups_of: impl Fn(&str) -> String) -> String {
  let mut groups: Vec<String> = Vec::new();
  for t in hidden {
    let g = groups_of(&t.name);
    if !groups.contains(&g) {
      groups.push(g);
    }
  }
  let builtin: Vec<String> = GROUPS
    .iter()
    .filter(|(g, _)| groups.iter().any(|x| x == g))
    .map(|(g, what)| format!("{g} ({what})"))
    .collect();
  let servers: Vec<&String> = groups.iter().filter(|g| !GROUPS.iter().any(|(b, _)| b == g)).collect();
  let mut out = String::from(
    "Find a tool that is not in your tool list. Only this screen's tools are loaded; more are available: ",
  );
  out.push_str(&builtin.join("; "));
  if !servers.is_empty() {
    out.push_str(&format!(
      "; MCP servers: {}",
      servers.iter().map(|s| s.as_str()).collect::<Vec<_>>().join(", ")
    ));
  }
  out.push_str(
    ". Give keywords or a group name; you get matching tools with their input schemas. \
     Then run one with tools_call.",
  );
  out
}

fn words(s: &str) -> Vec<String> {
  s.to_lowercase()
    .split(|c: char| !c.is_alphanumeric())
    .filter(|w| w.len() > 1)
    .map(String::from)
    .collect()
}

/// Best matches for `query` among `hidden`: name hits count more than description hits.
pub fn search<'a>(hidden: &[&'a ToolSpec], query: &str, group_of: impl Fn(&str) -> String, limit: usize) -> Vec<&'a ToolSpec> {
  let q = words(query);
  let mut scored: Vec<(usize, &ToolSpec)> = hidden
    .iter()
    .map(|t| {
      let name = t.name.to_lowercase();
      let desc = t.description.to_lowercase();
      let group = group_of(&t.name).to_lowercase();
      let score = q
        .iter()
        .map(|w| if *w == group { 4 } else if name.contains(w.as_str()) { 3 } else if desc.contains(w.as_str()) { 1 } else { 0 })
        .sum();
      (score, *t)
    })
    .filter(|(s, _)| *s > 0)
    .collect();
  scored.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.name.cmp(&b.1.name)));
  scored.into_iter().take(limit).map(|(_, t)| t).collect()
}

const FIND_LIMIT: usize = 12;

pub fn tools() -> Vec<Tool> {
  vec![
    tool(
      FIND,
      "Find a tool that is not in your tool list (the description is filled in per turn).",
      schema(json!({ "query": { "type": "string", "description": "Keywords or a group name, e.g. \"git diff\", \"logs\", \"playwright\"." } }), &["query"]),
      Risk::Read,
      |a, args, meta| async move {
        let query = Args(&args).need("query")?.to_string();
        let (hidden, all) = match meta.chat_id.as_deref() {
          Some(chat) => {
            let (offered, all) = a.offered_specs(chat).await;
            let offered: HashSet<String> = offered.into_iter().map(|t| t.name).collect();
            (offered, all)
          }
          None => (HashSet::new(), a.tool_specs(true).await),
        };
        let hidden: Vec<&ToolSpec> = all.iter().filter(|t| !hidden.contains(&t.name) && t.name != FIND && t.name != CALL).collect();
        let found = search(&hidden, &query, |n| a.tool_group(n), FIND_LIMIT);
        if found.is_empty() {
          return Ok(format!("No tool matches \"{query}\". {}", find_description(&hidden, |n| a.tool_group(n))));
        }
        let rows: Vec<Value> = found
          .iter()
          .map(|t| json!({ "name": t.name, "description": t.description, "input_schema": t.input_schema }))
          .collect();
        super::ser(&json!({ "tools": rows, "next": "Run one with tools_call {\"name\": …, \"arguments\": {…}}." }))
      },
    ),
    tool(
      CALL,
      "Run a tool found with tools_find. Same approvals as calling it directly.",
      schema(
        json!({
          "name": { "type": "string", "description": "The tool's name, as tools_find gave it." },
          "arguments": { "type": "object", "description": "Its input, matching its input_schema." }
        }),
        &["name"],
      ),
      Risk::Read,
      // `call_tool` unwraps this call before it runs; reaching here means it was not.
      |_, _, _| async move { Err(CoreError::Invalid(format!("{CALL} could not be unwrapped."))) },
    ),
  ]
}

/// The tool and input a `tools_call` stands for.
pub fn unwrap(args: &Value) -> Result<(String, Value)> {
  let name = Args(args).need("name")?.to_string();
  if name == CALL || name == FIND {
    return Err(CoreError::Invalid(format!("Call {name} directly.")));
  }
  let input = Args(args).object("arguments")?;
  Ok((name, input))
}

#[cfg(test)]
mod tests {
  use super::*;

  fn spec(name: &str, description: &str) -> ToolSpec {
    ToolSpec { name: name.into(), description: description.into(), input_schema: json!({"type": "object"}), risk: Risk::Read, external_only: false }
  }

  #[test]
  fn search_ranks_names_over_descriptions() {
    let (a, b, c) = (spec("repo_diff", "Diff of the working copy"), spec("compare_tree", "Compare two folders, show the diff"), spec("flow_run", "Run a flow"));
    let hidden = vec![&a, &b, &c];
    let group = |n: &str| n.split('_').next().unwrap().to_string();
    let found = search(&hidden, "diff", group, 5);
    assert_eq!(found.iter().map(|t| t.name.as_str()).collect::<Vec<_>>(), ["repo_diff", "compare_tree"]);
    assert_eq!(search(&hidden, "flow", group, 5)[0].name, "flow_run");
    assert!(search(&hidden, "zzz", group, 5).is_empty());
  }

  #[test]
  fn description_lists_hidden_groups_and_servers() {
    let (a, b) = (spec("repo_diff", ""), spec("playwright__browser_click", ""));
    let d = find_description(&[&a, &b], |n| mcp_group(n).map(String::from).unwrap_or_else(|| "repo".into()));
    assert!(d.contains("repo (git repositories)") && d.contains("MCP servers: playwright"));
  }

  #[test]
  fn unwrap_takes_name_and_arguments() {
    let (n, i) = unwrap(&json!({"name": "repo_diff", "arguments": {"path": "a"}})).unwrap();
    assert_eq!((n.as_str(), i["path"].as_str()), ("repo_diff", Some("a")));
    assert_eq!(unwrap(&json!({"name": "repo_status"})).unwrap().1, json!({}));
    assert!(unwrap(&json!({"name": CALL})).is_err());
  }
}
