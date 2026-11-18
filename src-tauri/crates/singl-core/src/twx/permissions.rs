//! Read-only permission inspection: the run-time, design-time and visibility
//! rules an entity carries, and "can this user do that?" worked out from them.
//!
//! The rules come from the entity's exported XML (the only shape that carries
//! member-level overrides). Group membership comes from the principal groups'
//! own exports, followed through nested groups. Nothing is written.

use std::collections::{HashMap, HashSet};

use serde::Serialize;

use super::api::Client;
use super::xml::{self, Element};
use crate::{CoreError, Result};

pub const RUNTIME_ACTIONS: [&str; 5] = ["ServiceInvoke", "PropertyRead", "PropertyWrite", "EventInvoke", "EventSubscribe"];

/// One principal on one rule.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Rule {
  /// `"*"` for the whole entity, else the service/property/event the rule overrides.
  /// Empty for design-time and visibility rules.
  pub resource: String,
  /// `ServiceInvoke`, `Read`, `Visibility`, ...
  pub action: String,
  pub principal: String,
  /// `User`, `Group` or `Organization`.
  pub kind: String,
  pub permitted: bool,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EntityPermissions {
  pub entity_type: String,
  pub name: String,
  pub run_time: Vec<Rule>,
  pub design_time: Vec<Rule>,
  pub visibility: Vec<Rule>,
}

fn descendant<'a>(el: &'a Element, name: &str) -> Option<&'a Element> {
  if el.name == name {
    return Some(el);
  }
  el.children.iter().find_map(|c| descendant(c, name))
}

fn collect<'a>(el: &'a Element, name: &str, out: &mut Vec<&'a Element>) {
  if el.name == name {
    out.push(el);
  }
  for c in &el.children {
    collect(c, name, out);
  }
}

fn principals(action_el: &Element, resource: &str) -> Vec<Rule> {
  action_el
    .children_named("Principal")
    .map(|p| Rule {
      resource: resource.to_string(),
      action: action_el.name.clone(),
      principal: p.attr("name").unwrap_or_default().to_string(),
      kind: p.attr("type").unwrap_or_default().to_string(),
      permitted: p.attr("isPermitted") != Some("false"),
    })
    .collect()
}

/// The three permission blocks of an exported entity.
pub fn parse_permissions(xml_text: &str, entity_type: &str, name: &str) -> Result<EntityPermissions> {
  let root = xml::parse(xml_text)?;
  let mut out = EntityPermissions { entity_type: entity_type.into(), name: name.into(), ..Default::default() };
  if let Some(rt) = descendant(&root, "RunTimePermissions") {
    for perms in rt.children_named("Permissions") {
      let resource = perms.attr("resourceName").unwrap_or("*");
      for action in &perms.children {
        out.run_time.extend(principals(action, resource));
      }
    }
  }
  if let Some(dt) = descendant(&root, "DesignTimePermissions") {
    for action in &dt.children {
      out.design_time.extend(principals(action, ""));
    }
  }
  if let Some(v) = descendant(&root, "VisibilityPermissions") {
    for action in &v.children {
      out.visibility.extend(principals(action, ""));
    }
  }
  Ok(out)
}

pub async fn entity_permissions(client: &Client, entity_type: &str, name: &str) -> Result<EntityPermissions> {
  let xml_text = client.export_entity(entity_type, name).await?;
  parse_permissions(&xml_text, entity_type, name)
}

/// Direct members of a group: `(name, type)`.
fn parse_members(xml_text: &str) -> Result<Vec<(String, String)>> {
  let root = xml::parse(xml_text)?;
  let mut members = Vec::new();
  collect(&root, "Member", &mut members);
  Ok(
    members
      .into_iter()
      .map(|m| (m.attr("name").unwrap_or_default().to_string(), m.attr("type").unwrap_or_default().to_string()))
      .collect(),
  )
}

/// The `candidates` groups the user belongs to, directly or through nested groups.
async fn groups_of_user(client: &Client, user: &str, candidates: &[String], notes: &mut Vec<String>) -> HashSet<String> {
  let mut cache: HashMap<String, Vec<(String, String)>> = HashMap::new();
  let mut found = HashSet::new();
  for group in candidates {
    let mut seen = HashSet::new();
    let mut queue = vec![group.clone()];
    while let Some(g) = queue.pop() {
      if !seen.insert(g.clone()) || seen.len() > 100 {
        continue;
      }
      if !cache.contains_key(&g) {
        let members = match client.export_entity("Group", &g).await.and_then(|x| parse_members(&x)) {
          Ok(m) => m,
          Err(e) => {
            notes.push(format!("Could not read members of group {g}: {e}"));
            Vec::new()
          }
        };
        cache.insert(g.clone(), members);
      }
      for (name, kind) in &cache[&g] {
        if kind == "User" && name == user {
          found.insert(group.clone());
        } else if kind == "Group" {
          queue.push(name.clone());
        }
      }
      if found.contains(group) {
        break;
      }
    }
  }
  found
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Decision {
  pub allowed: bool,
  pub user: String,
  pub action: String,
  pub member: Option<String>,
  /// The rule that decided it, if any.
  pub rule: Option<Rule>,
  /// `member` (override on that service/property/event), `entity` (the `*` rule) or `none`.
  pub level: String,
  /// One plain sentence.
  pub explanation: String,
  /// Groups from the entity's rules that the user belongs to.
  pub user_groups: Vec<String>,
  pub notes: Vec<String>,
}

/// Decides from the rules and the user's groups. Order: a member-level
/// override first, then the entity-wide `*` rules; within a level the user's
/// own rule beats group rules, and a group deny beats a group allow.
pub fn decide(
  rules: &[Rule],
  user: &str,
  user_groups: &HashSet<String>,
  action: &str,
  member: Option<&str>,
) -> (bool, Option<Rule>, &'static str) {
  let mut levels: Vec<(&'static str, &str)> = Vec::new();
  if let Some(m) = member.filter(|m| *m != "*") {
    levels.push(("member", m));
  }
  levels.push(("entity", "*"));
  for (level, resource) in levels {
    let at: Vec<&Rule> = rules.iter().filter(|r| r.resource == resource && r.action == action).collect();
    if let Some(r) = at.iter().find(|r| r.kind == "User" && r.principal == user) {
      return (r.permitted, Some((*r).clone()), level);
    }
    let groups: Vec<&Rule> =
      at.iter().copied().filter(|r| r.kind == "Group" && user_groups.contains(&r.principal)).collect();
    if let Some(r) = groups.iter().find(|r| !r.permitted).or(groups.first()) {
      return (r.permitted, Some((*r).clone()), level);
    }
  }
  (false, None, "none")
}

pub async fn check_permission(
  client: &Client,
  entity_type: &str,
  name: &str,
  user: &str,
  action: &str,
  member: Option<&str>,
) -> Result<Decision> {
  if !RUNTIME_ACTIONS.contains(&action) {
    return Err(CoreError::Invalid(format!("Unknown action \"{action}\". Use one of: {}.", RUNTIME_ACTIONS.join(", "))));
  }
  let perms = entity_permissions(client, entity_type, name).await?;
  let mut candidates: Vec<String> =
    perms.run_time.iter().filter(|r| r.kind == "Group").map(|r| r.principal.clone()).collect();
  candidates.sort();
  candidates.dedup();
  let mut notes =
    vec!["Collection-level permissions and the Administrators group's implicit access are not evaluated.".to_string()];
  let groups = groups_of_user(client, user, &candidates, &mut notes).await;
  let (allowed, rule, level) = decide(&perms.run_time, user, &groups, action, member);
  let target = member.map(|m| format!(" on {m}")).unwrap_or_default();
  let explanation = match &rule {
    Some(r) => {
      let via = if r.kind == "User" { "a rule for the user".to_string() } else { format!("group {}", r.principal) };
      let from =
        if level == "member" { format!("the override for {}", r.resource) } else { "the entity-wide (*) rules".into() };
      format!(
        "{user} is {} {action}{target}: {} by {via}, from {from}.",
        if allowed { "allowed" } else { "denied" },
        if allowed { "granted" } else { "explicitly denied" },
      )
    }
    None => format!("{user} is denied {action}{target}: no rule on {name} grants it to the user or any of their groups."),
  };
  let mut user_groups: Vec<String> = groups.into_iter().collect();
  user_groups.sort();
  Ok(Decision {
    allowed,
    user: user.into(),
    action: action.into(),
    member: member.map(String::from),
    rule,
    level: level.into(),
    explanation,
    user_groups,
    notes,
  })
}

/// A mashup as the entity list reports it.
#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct MashupInfo {
  pub name: String,
  pub description: String,
  pub project: String,
  /// Whatever the server sent (epoch milliseconds or a date string), or null.
  pub last_modified: serde_json::Value,
}

/// Mashups whose names match `mask`, with the info GetEntityList carries.
pub async fn list_mashups(client: &Client, mask: &str) -> Result<Vec<MashupInfo>> {
  let mask = if mask.trim().is_empty() { "*" } else { mask.trim() };
  let body = serde_json::json!({ "type": "Mashup", "nameMask": mask });
  let text = client.execute_service("Resources", "EntityServices", "GetEntityList", &body).await?;
  let json: serde_json::Value = serde_json::from_str(&text).map_err(|e| CoreError::Invalid(e.to_string()))?;
  let rows = json.get("rows").and_then(|r| r.as_array()).cloned().unwrap_or_default();
  let text_of = |row: &serde_json::Value, key: &str| row.get(key).and_then(|v| v.as_str()).unwrap_or_default().to_string();
  let mut out: Vec<MashupInfo> = rows
    .iter()
    .map(|r| MashupInfo {
      name: text_of(r, "name"),
      description: text_of(r, "description"),
      project: text_of(r, "projectName"),
      last_modified: r.get("lastModifiedDate").cloned().unwrap_or_default(),
    })
    .collect();
  out.sort_by_key(|m| m.name.to_lowercase());
  Ok(out)
}

#[cfg(test)]
mod tests {
  use super::*;

  const XML: &str = r#"<Entities><Things><Thing name="T">
    <DesignTimePermissions><Create></Create><Read><Principal isPermitted="true" name="Devs" type="Group"></Principal></Read></DesignTimePermissions>
    <RunTimePermissions>
      <Permissions resourceName="*"><ServiceInvoke><Principal isPermitted="true" name="Staff" type="Group"></Principal></ServiceInvoke></Permissions>
      <Permissions resourceName="Secret"><ServiceInvoke><Principal isPermitted="false" name="Interns" type="Group"></Principal><Principal isPermitted="true" name="bob" type="User"></Principal></ServiceInvoke></Permissions>
    </RunTimePermissions>
    <VisibilityPermissions><Visibility><Principal isPermitted="true" name="Org" type="Organization"></Principal></Visibility></VisibilityPermissions>
  </Thing></Things></Entities>"#;

  fn groups(names: &[&str]) -> HashSet<String> {
    names.iter().map(|s| s.to_string()).collect()
  }

  #[test]
  fn parses_three_blocks() {
    let p = parse_permissions(XML, "Thing", "T").unwrap();
    assert_eq!(p.run_time.len(), 3);
    assert_eq!(p.design_time.len(), 1);
    assert_eq!(p.visibility[0].kind, "Organization");
    assert!(!p.run_time[1].permitted);
  }

  #[test]
  fn member_override_beats_entity_rule() {
    let p = parse_permissions(XML, "Thing", "T").unwrap();
    let g = groups(&["Staff", "Interns"]);
    let (ok, rule, level) = decide(&p.run_time, "alice", &g, "ServiceInvoke", Some("Secret"));
    assert!(!ok && level == "member" && rule.unwrap().principal == "Interns");
    let (ok, _, level) = decide(&p.run_time, "alice", &g, "ServiceInvoke", Some("Other"));
    assert!(ok && level == "entity");
  }

  #[test]
  fn user_rule_beats_group_deny_and_default_is_deny() {
    let p = parse_permissions(XML, "Thing", "T").unwrap();
    let (ok, _, _) = decide(&p.run_time, "bob", &groups(&["Interns"]), "ServiceInvoke", Some("Secret"));
    assert!(ok);
    let (ok, rule, level) = decide(&p.run_time, "eve", &groups(&[]), "PropertyRead", None);
    assert!(!ok && rule.is_none() && level == "none");
  }

  #[test]
  fn reads_nested_group_members() {
    let x = r#"<Entities><Groups><Group name="G"><Members><Members><Member name="u" type="User"></Member><Member name="H" type="Group"></Member></Members></Members></Group></Groups></Entities>"#;
    assert_eq!(parse_members(x).unwrap().len(), 2);
  }
}
