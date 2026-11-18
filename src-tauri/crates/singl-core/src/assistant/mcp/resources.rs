//! MCP resources: exported entity XML, single services (code and parameters),
//! saved flows and the current screen. Entities are listed from folder names
//! only, never by reading their files.
//!
//! URIs: `singl://entity/{env}/{type}/{name}`,
//! `singl://service/{env}/{type}/{entity}/{service}`, `singl://flow/{id}`, `singl://screen`.

use std::path::{Path, PathBuf};

use serde_json::{Value, json};

use crate::assistant::Assistant;
use crate::assistant::tools::ser;
use crate::db::{environments, flows};
use crate::twx::entities as ents;
use crate::twx::run_times::safe_env;
use crate::twx::xml::{self, Element};
use crate::workspace::PathKind;
use crate::{CoreError, Result};

const PAGE_SIZE: usize = 100;
/// More than this and a client should search instead of listing.
const MAX_LISTED: usize = 5000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ResUri {
  Entity { env: String, kind: String, name: String },
  Service { env: String, kind: String, entity: String, service: String },
  Flow { id: String },
  Screen,
}

fn encode(s: &str) -> String {
  let mut out = String::new();
  for b in s.bytes() {
    if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
      out.push(b as char);
    } else {
      out.push_str(&format!("%{b:02X}"));
    }
  }
  out
}

fn decode(s: &str) -> Option<String> {
  let bytes = s.as_bytes();
  let mut out = Vec::with_capacity(bytes.len());
  let mut i = 0;
  while i < bytes.len() {
    if bytes[i] == b'%' {
      let hex = s.get(i + 1..i + 3)?;
      out.push(u8::from_str_radix(hex, 16).ok()?);
      i += 3;
    } else {
      out.push(bytes[i]);
      i += 1;
    }
  }
  String::from_utf8(out).ok()
}

impl ResUri {
  pub fn parse(uri: &str) -> Option<Self> {
    let rest = uri.strip_prefix("singl://")?;
    let parts: Vec<String> = rest.split('/').map(decode).collect::<Option<_>>()?;
    if parts.iter().skip(1).any(|p| p.is_empty() || ents::is_unsafe_name(p)) {
      return None;
    }
    let p = |i: usize| parts[i].clone();
    match (parts[0].as_str(), parts.len()) {
      ("screen", 1) => Some(Self::Screen),
      ("flow", 2) => Some(Self::Flow { id: p(1) }),
      ("entity", 4) => Some(Self::Entity { env: p(1), kind: p(2), name: p(3) }),
      ("service", 5) => Some(Self::Service { env: p(1), kind: p(2), entity: p(3), service: p(4) }),
      _ => None,
    }
  }

  pub fn to_uri(&self) -> String {
    match self {
      Self::Screen => "singl://screen".into(),
      Self::Flow { id } => format!("singl://flow/{}", encode(id)),
      Self::Entity { env, kind, name } => format!("singl://entity/{}/{}/{}", encode(env), encode(kind), encode(name)),
      Self::Service { env, kind, entity, service } => {
        format!("singl://service/{}/{}/{}/{}", encode(env), encode(kind), encode(entity), encode(service))
      }
    }
  }
}

pub fn templates() -> Value {
  json!({ "resourceTemplates": [
    { "uriTemplate": "singl://entity/{env}/{type}/{name}", "name": "entity",
      "description": "An exported ThingWorx entity's XML. `type` is the collection, e.g. Things, ThingTemplates.",
      "mimeType": "application/xml" },
    { "uriTemplate": "singl://service/{env}/{type}/{entity}/{service}", "name": "service",
      "description": "One service of an exported entity: its parameters and code.", "mimeType": "text/javascript" },
    { "uriTemplate": "singl://flow/{id}", "name": "flow",
      "description": "A saved service flow as JSON.", "mimeType": "application/json" },
  ] })
}

fn base(a: &Assistant) -> Result<PathBuf> {
  a.workspace()
    .resolve(PathKind::TwxEntities)
    .ok_or_else(|| CoreError::Invalid("No workspace folder is set. Choose one in Settings.".into()))
}

fn dirs(dir: &Path) -> Vec<String> {
  let mut names: Vec<String> = std::fs::read_dir(dir)
    .into_iter()
    .flatten()
    .flatten()
    .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
    .map(|e| e.file_name().to_string_lossy().into_owned())
    .collect();
  names.sort();
  names
}

/// Entity names exported for one environment folder: `(collection, name)`. Folder listings only.
fn exported(base: &Path, env_dir: &str) -> Vec<(String, String)> {
  let root = base.join(env_dir).join("WindchillClients").join("Thingworx");
  let mut out = Vec::new();
  for alias in dirs(&root) {
    for project in dirs(&root.join(&alias)).into_iter().filter(|p| p != "Code" && p != "node_modules") {
      let project_dir = root.join(&alias).join(&project);
      for collection in dirs(&project_dir) {
        let mut names: Vec<String> = std::fs::read_dir(project_dir.join(&collection))
          .into_iter()
          .flatten()
          .flatten()
          .filter_map(|e| e.file_name().to_string_lossy().strip_suffix(".xml").map(String::from))
          .collect();
        names.sort();
        out.extend(names.into_iter().map(|n| (collection.clone(), n)));
      }
    }
  }
  out
}

fn resource(uri: String, name: &str, description: &str, mime: &str) -> Value {
  json!({ "uri": uri, "name": name, "description": description, "mimeType": mime })
}

/// One page of resources; `cursor` is an offset. The screen, flows and entities are listed;
/// services are not (use the template).
pub async fn list(a: &Assistant, cursor: Option<&str>) -> Result<Value> {
  let offset: usize = cursor.and_then(|c| c.parse().ok()).unwrap_or(0);
  let mut all =
    vec![resource("singl://screen".into(), "screen", "What the user is looking at in singl.", "application/json")];
  let pool = a.pool().await;
  for f in flows::list(&pool).await? {
    let uri = ResUri::Flow { id: f.id }.to_uri();
    all.push(resource(uri, &format!("flow: {}", f.name), "A saved service flow.", "application/json"));
  }
  if let Ok(base) = base(a) {
    'envs: for env in environments::list(&pool).await? {
      for (kind, name) in exported(&base, &safe_env(&env.environment)) {
        if all.len() >= MAX_LISTED {
          break 'envs;
        }
        let uri = ResUri::Entity { env: env.environment.clone(), kind: kind.clone(), name: name.clone() }.to_uri();
        let title = format!("{name} ({kind}, {})", env.environment);
        all.push(resource(uri, &title, "Exported entity XML.", "application/xml"));
      }
    }
  }
  let page: Vec<Value> = all.iter().skip(offset).take(PAGE_SIZE).cloned().collect();
  let mut out = json!({ "resources": page });
  if offset + PAGE_SIZE < all.len() {
    out["nextCursor"] = json!((offset + PAGE_SIZE).to_string());
  }
  Ok(out)
}

fn find_named<'a>(el: &'a Element, tag: &str, name: &str) -> Option<&'a Element> {
  if el.name == tag && el.attr("name") == Some(name) {
    return Some(el);
  }
  el.children.iter().find_map(|c| find_named(c, tag, name))
}

/// The parameter list, result type and code of `service` in an entity's XML.
pub fn service_text(xml_text: &str, service: &str) -> Result<String> {
  let root = xml::parse(xml_text)?;
  let def = find_named(&root, "ServiceDefinition", service);
  let imp = find_named(&root, "ServiceImplementation", service);
  if def.is_none() && imp.is_none() {
    return Err(CoreError::NotFound(format!("The entity has no service \"{service}\".")));
  }
  let mut head = format!("// Service: {service}\n");
  if let Some(def) = def {
    if let Some(d) = def.attr("description").filter(|d| !d.is_empty()) {
      head += &format!("// {d}\n");
    }
    if let Some(params) = def.child("ParameterDefinitions") {
      for p in params.children_named("FieldDefinition") {
        head += &format!(
          "// param {}: {}{}\n",
          p.attr("name").unwrap_or_default(),
          p.attr("baseType").unwrap_or_default(),
          p.attr("description").filter(|d| !d.is_empty()).map(|d| format!(" - {d}")).unwrap_or_default()
        );
      }
    }
    if let Some(r) = def.child("ResultType") {
      head += &format!("// returns: {}\n", r.attr("baseType").unwrap_or_default());
    }
  }
  let code = imp
    .and_then(|i| i.child("ConfigurationTables"))
    .and_then(|t| t.children_named("ConfigurationTable").find_map(|ct| ct.path(&["Rows", "Row"])))
    .and_then(|row| row.child("code").or_else(|| row.child("sql")))
    .map(|c| crate::twx::extract_services::strip_indent(&c.text))
    .unwrap_or_default();
  Ok(format!("{head}\n{}\n", code.trim()))
}

/// The collection folder in an entity path (`<env>/WindchillClients/Thingworx/<alias>/<project>/<Collection>/..`).
pub fn collection_of(path: &str) -> Option<&str> {
  path.split('/').nth(5)
}

fn locate(a: &Assistant, env: &str, kind: Option<&str>, entity: &str) -> Result<(PathBuf, String)> {
  let base = base(a)?;
  let found = ents::locate(&base, &safe_env(env), entity, kind, None)?
    .and_then(|f| f.path)
    .ok_or_else(|| CoreError::NotFound(format!("{entity} has not been exported for {env} yet.")))?;
  Ok((base, found))
}

/// The entity's XML and the collection it was found in (`kind` optional: the first collection holding it).
pub fn read_entity(a: &Assistant, env: &str, kind: Option<&str>, entity: &str) -> Result<(String, String)> {
  let (base, path) = locate(a, env, kind, entity)?;
  Ok((collection_of(&path).unwrap_or_default().to_string(), ents::read(&base, &path)?))
}

/// The service's parameters and code, and the collection of its entity.
pub fn read_service(
  a: &Assistant,
  env: &str,
  kind: Option<&str>,
  entity: &str,
  service: &str,
) -> Result<(String, String)> {
  let (kind, xml_text) = read_entity(a, env, kind, entity)?;
  Ok((kind, service_text(&xml_text, service)?))
}

fn content(uri: &str, mime: &str, text: String) -> Value {
  json!({ "contents": [{ "uri": uri, "mimeType": mime, "text": text }] })
}

pub async fn read(a: &Assistant, uri: &str) -> Result<Value> {
  let parsed = ResUri::parse(uri).ok_or_else(|| CoreError::Invalid(format!("Unknown resource URI: {uri}")))?;
  match parsed {
    ResUri::Screen => Ok(content(uri, "application/json", ser(&a.context.get())?)),
    ResUri::Flow { id } => {
      let flow = flows::get(&a.pool().await, &id).await?.ok_or_else(|| CoreError::NotFound(format!("No flow {id}.")))?;
      Ok(content(uri, "application/json", ser(&flow)?))
    }
    ResUri::Entity { env, kind, name } => {
      let (_, text) = read_entity(a, &env, Some(&kind), &name)?;
      Ok(content(uri, "application/xml", text))
    }
    ResUri::Service { env, kind, entity, service } => {
      let (_, text) = read_service(a, &env, Some(&kind), &entity, &service)?;
      Ok(content(uri, "text/javascript", text))
    }
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn parses_each_uri_shape() {
    assert_eq!(ResUri::parse("singl://screen"), Some(ResUri::Screen));
    assert_eq!(ResUri::parse("singl://flow/abc-1"), Some(ResUri::Flow { id: "abc-1".into() }));
    assert_eq!(
      ResUri::parse("singl://entity/Prod%20EU/Things/My.Thing"),
      Some(ResUri::Entity { env: "Prod EU".into(), kind: "Things".into(), name: "My.Thing".into() })
    );
    assert_eq!(
      ResUri::parse("singl://service/dev/Things/T/Run"),
      Some(ResUri::Service { env: "dev".into(), kind: "Things".into(), entity: "T".into(), service: "Run".into() })
    );
  }

  #[test]
  fn rejects_bad_uris() {
    for bad in [
      "http://x",
      "singl://",
      "singl://nope/x",
      "singl://entity/dev/Things",
      "singl://entity/dev/Things/..%2Fx",
      "singl://entity/dev//T",
      "singl://entity/dev/Things/a/b",
      "singl://screen/x",
      "singl://flow/%zz",
    ] {
      assert_eq!(ResUri::parse(bad), None, "{bad}");
    }
  }

  #[test]
  fn uris_round_trip() {
    let u = ResUri::Service { env: "a b".into(), kind: "Things".into(), entity: "T-1".into(), service: "S".into() };
    assert_eq!(ResUri::parse(&u.to_uri()), Some(u));
  }

  #[test]
  fn extracts_service_params_and_code() {
    let xml = r#"<Entities><Things><Thing name="T"><ThingShape>
      <ServiceDefinitions><ServiceDefinition name="Run" description="Does it">
        <ParameterDefinitions><FieldDefinition name="id" baseType="STRING" description="The id"/></ParameterDefinitions>
        <ResultType baseType="NOTHING"/></ServiceDefinition></ServiceDefinitions>
      <ServiceImplementations><ServiceImplementation name="Run"><ConfigurationTables><ConfigurationTable name="Script">
        <Rows><Row><code>
          var x = 1;
        </code></Row></Rows></ConfigurationTable></ConfigurationTables></ServiceImplementation></ServiceImplementations>
      </ThingShape></Thing></Things></Entities>"#;
    let text = service_text(xml, "Run").unwrap();
    assert!(text.contains("// param id: STRING - The id"), "{text}");
    assert!(text.contains("// returns: NOTHING"));
    assert!(text.trim_end().ends_with("var x = 1;"));
    assert!(service_text(xml, "Nope").is_err());
  }

  #[test]
  fn finds_collection_in_path() {
    assert_eq!(collection_of("dev/WindchillClients/Thingworx/a/P/Things/T.xml"), Some("Things"));
  }
}
