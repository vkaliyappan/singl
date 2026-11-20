//! Per-client tool profiles for the app's MCP server: which tool groups an
//! outside client may see and call, and the riskiest tool it may use. The
//! client is named by `initialize`'s `clientInfo.name`; `"*"` is the default
//! profile. With no profiles stored, everything is allowed.

use serde::{Deserialize, Serialize};

use crate::assistant::tools::Risk;

/// Every tool group, in the order the Settings page lists them.
pub const GROUPS: &[&str] = &[
  "app", "fs", "twx", "entities", "services", "flows", "repo", "compare", "deploy", "outputs", "deps", "automation", "apptests",
  "undo", "mcp", "other",
];

/// The group a tool belongs to, from its name. Tools of connected MCP servers
/// (`<server>__<tool>`) are `mcp`; names this map does not know are `other`.
pub fn group_of(tool: &str) -> &'static str {
  if tool.contains("__") {
    return "mcp";
  }
  match tool {
    "get_screen_context" | "get_selection" | "list_screens" | "navigate" | "run_ui_action" | "app_overview" => "app",
    "tool_output_query" => "outputs",
    "entity_dependencies" | "entity_service_callers" | "entity_unused" => "deps",
    "entity_undo_list" | "entity_undo" => "undo",
    _ => match tool.split('_').next().unwrap_or_default() {
      "assistant" => "app",
      "fs" => "fs",
      "twx" => "twx",
      "entity" => "entities",
      "service" => "services",
      "flow" => "flows",
      "repo" => "repo",
      "compare" => "compare",
      "deploy" => "deploy",
      "deps" => "deps",
      "automation" => "automation",
      "apptests" => "apptests",
      "undo" => "undo",
      _ => "other",
    },
  }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct McpProfile {
  /// `clientInfo.name` this applies to (case-insensitive), or `*`.
  pub client: String,
  pub groups: Vec<String>,
  pub max_risk: Risk,
}

impl Default for McpProfile {
  fn default() -> Self {
    Self { client: "*".into(), groups: GROUPS.iter().map(|g| g.to_string()).collect(), max_risk: Risk::Destructive }
  }
}

impl McpProfile {
  pub fn allows(&self, tool: &str, risk: Risk) -> bool {
    risk <= self.max_risk && self.groups.iter().any(|g| g == group_of(tool))
  }
}

/// Trims names and drops blank or repeated clients (the first wins).
pub fn normalize(profiles: Vec<McpProfile>) -> Vec<McpProfile> {
  let mut out: Vec<McpProfile> = Vec::new();
  for mut p in profiles {
    p.client = p.client.trim().to_string();
    if p.client.is_empty() || out.iter().any(|o| o.client.eq_ignore_ascii_case(&p.client)) {
      continue;
    }
    p.groups.retain(|g| GROUPS.contains(&g.as_str()));
    out.push(p);
  }
  out
}

/// The profile for `client`: an exact name, else one whose name the client's
/// contains (so `copilot` covers `copilot-chat`), else `*`, else `None` (everything).
pub fn resolve<'a>(profiles: &'a [McpProfile], client: Option<&str>) -> Option<&'a McpProfile> {
  if let Some(name) = client.map(|c| c.trim().to_lowercase()).filter(|c| !c.is_empty()) {
    let named = |p: &&McpProfile| p.client != "*";
    if let Some(p) = profiles.iter().filter(named).find(|p| p.client.to_lowercase() == name) {
      return Some(p);
    }
    if let Some(p) = profiles.iter().filter(named).find(|p| name.contains(&p.client.to_lowercase())) {
      return Some(p);
    }
  }
  profiles.iter().find(|p| p.client == "*")
}

#[cfg(test)]
mod tests {
  use super::*;

  fn profile(client: &str, groups: &[&str], max_risk: Risk) -> McpProfile {
    McpProfile { client: client.into(), groups: groups.iter().map(|g| g.to_string()).collect(), max_risk }
  }

  #[test]
  fn groups_follow_tool_names() {
    assert_eq!(group_of("get_screen_context"), "app");
    assert_eq!(group_of("assistant_ask"), "app");
    assert_eq!(group_of("entity_read"), "entities");
    assert_eq!(group_of("twx_invoke_service"), "twx");
    assert_eq!(group_of("tool_output_query"), "outputs");
    assert_eq!(group_of("github__create_issue"), "mcp");
    assert_eq!(group_of("brand_new_tool"), "other");
  }

  #[test]
  fn profile_filters_by_group_and_risk() {
    let p = profile("claude-code", &["entities", "flows"], Risk::Write);
    assert!(p.allows("entity_read", Risk::Read));
    assert!(p.allows("flow_save", Risk::Write));
    assert!(!p.allows("entity_delete", Risk::Destructive));
    assert!(!p.allows("twx_list_entities", Risk::Read));
  }

  #[test]
  fn resolves_exact_then_partial_then_default() {
    let list = vec![
      profile("*", &["app"], Risk::Read),
      profile("copilot", &["flows"], Risk::Write),
      profile("Claude-Code", &["twx"], Risk::Read),
    ];
    assert_eq!(resolve(&list, Some("claude-code")).unwrap().groups, ["twx"]);
    assert_eq!(resolve(&list, Some("copilot-chat")).unwrap().groups, ["flows"]);
    assert_eq!(resolve(&list, Some("codex")).unwrap().groups, ["app"]);
    assert_eq!(resolve(&list, None).unwrap().groups, ["app"]);
    assert!(resolve(&[], Some("codex")).is_none());
    assert!(resolve(&list[1..2], Some("codex")).is_none());
  }

  #[test]
  fn normalize_drops_blank_and_repeated_clients() {
    let out = normalize(vec![
      profile(" codex ", &["app", "bogus"], Risk::Read),
      profile("CODEX", &["fs"], Risk::Read),
      profile("  ", &["fs"], Risk::Read),
    ]);
    assert_eq!(out.len(), 1);
    assert_eq!(out[0].client, "codex");
    assert_eq!(out[0].groups, ["app"]);
  }
}
