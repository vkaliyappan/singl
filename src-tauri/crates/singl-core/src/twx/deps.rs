//! Entity dependency graph built from the exported entity XML under
//! `<twx-entities>/<env>` (no server calls).
//!
//! Nodes are entities (and anything they point at that is not exported, such
//! as `PTC.*` templates or `Resources`). Edges, by `kind`:
//!   `template`            thingTemplate / baseThingTemplate
//!   `shape`               implemented thing shapes
//!   `datashape`           dataShape on properties, parameters, results, tables
//!   `calls`               `Things["X"]`, `Things.X`, `Resources[...]`, ... in
//!                         service code, with the member called when it shows
//!   `mashup`              mashup data bindings (entity + service/property),
//!                         nested mashups and datashapes
//!   `project`             membership, and project dependsOn
//!   `valueStream`, `persistenceProvider`
//!
//! References are found with regexes over the text, so dynamic ones
//! (`Things[name]`) are invisible: treat results as a close approximation.
//! Parsing is cached per file by mtime and size, so a re-query only re-reads
//! what changed.

use std::collections::{HashMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::SystemTime;

use regex::Regex;
use serde::Serialize;
use serde_json::Value;
use walkdir::WalkDir;

use crate::{CoreError, Result};

pub const KINDS: &[&str] =
  &["template", "shape", "datashape", "calls", "mashup", "project", "valueStream", "persistenceProvider"];

/// A node of the graph.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Node {
  /// `Type:lowercase name`, unique per node.
  pub key: String,
  #[serde(rename = "type")]
  pub ty: String,
  pub name: String,
  /// The XML file relative to the entities folder; `None` when not exported.
  pub file: Option<String>,
  pub external: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase")]
pub struct Edge {
  pub from: String,
  pub to: String,
  pub kind: String,
  /// The member of `to` that is used (service called, bound property...).
  pub member: Option<String>,
  /// The service or subscription of `from` the reference sits in.
  pub from_member: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Graph {
  pub center: String,
  /// Breadth-first from the centre, so a prefix is the nearest part.
  pub nodes: Vec<Node>,
  pub edges: Vec<Edge>,
  /// More nodes were reachable than `limit` allowed.
  pub truncated: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Caller {
  pub caller: Node,
  /// The service or subscription of the caller, when known.
  pub from_member: Option<String>,
  pub kind: String,
  /// The entity the call targets, when it is not the one asked about but one
  /// that inherits from it.
  pub via: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Callers {
  pub entity: Node,
  pub service: String,
  pub callers: Vec<Caller>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Unused {
  pub nodes: Vec<Node>,
  pub total: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
  pub entities: usize,
  pub edges: usize,
  pub types: Vec<TypeCount>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TypeCount {
  #[serde(rename = "type")]
  pub ty: String,
  pub count: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Direction {
  In,
  Out,
  Both,
}

impl Direction {
  pub fn parse(s: &str) -> Result<Self> {
    match s.trim().to_ascii_lowercase().as_str() {
      "in" | "incoming" => Ok(Self::In),
      "out" | "outgoing" => Ok(Self::Out),
      "" | "both" => Ok(Self::Both),
      other => Err(CoreError::Invalid(format!("direction must be in, out or both, not \"{other}\""))),
    }
  }
}

// ---------------------------------------------------------------- parsing

/// A reference found in one file.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Ref {
  ty: String,
  name: String,
  kind: &'static str,
  member: Option<String>,
  from_member: Option<String>,
}

#[derive(Debug, Default)]
struct ParsedFile {
  /// The entity's type and name, `None` for a file that is not an entity.
  entity: Option<(String, String)>,
  file: String,
  refs: Vec<Ref>,
}

static TAG: LazyLock<Regex> =
  LazyLock::new(|| Regex::new(r#"<([A-Za-z][\w.]*)((?:\s+[\w.:]+="[^"]*")*)\s*/?>"#).unwrap());
static ATTR: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"([\w.:]+)="([^"]*)""#).unwrap());
static PERSISTENCE: LazyLock<Regex> =
  LazyLock::new(|| Regex::new(r"<persistenceProvider>\s*(?:<!\[CDATA\[)?\s*([^<\]\s]+)").unwrap());
static MASHUP_STR: LazyLock<Regex> =
  LazyLock::new(|| Regex::new(r#""(Mashup|DataShape)"\s*:\s*"([^"]+)""#).unwrap());
static CODE_REF: LazyLock<Regex> = LazyLock::new(|| {
  Regex::new(
    r#"\b(Things|ThingTemplates|ThingShapes|DataShapes|Resources|Mashups|Users|Groups|Organizations)\s*(?:\[\s*["']([^"'\\\]]+)["']\s*\]|\.\s*([A-Za-z_$][\w$]*))"#,
  )
  .unwrap()
});
static MEMBER: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\s*\.\s*([A-Za-z_$][\w$]*)").unwrap());
static ALIAS_PRE: LazyLock<Regex> =
  LazyLock::new(|| Regex::new(r"(?:var|let|const)?\s*([A-Za-z_$][\w$]*)\s*=\s*$").unwrap());
static ALIAS_CALL: LazyLock<Regex> =
  LazyLock::new(|| Regex::new(r"\b([A-Za-z_$][\w$]*)\s*\.\s*([A-Za-z_$][\w$]*)\s*\(").unwrap());

fn unescape(s: &str) -> String {
  s.replace("&quot;", "\"").replace("&lt;", "<").replace("&gt;", ">").replace("&apos;", "'").replace("&amp;", "&")
}

fn attrs(raw: &str) -> HashMap<String, String> {
  ATTR.captures_iter(raw).map(|c| (c[1].to_string(), unescape(&c[2]))).collect()
}

/// The entity type a code collection or mashup `EntityType` stands for.
fn collection_type(collection: &str) -> Option<&'static str> {
  Some(match collection {
    "Things" => "Thing",
    "ThingTemplates" => "ThingTemplate",
    "ThingShapes" => "ThingShape",
    "DataShapes" => "DataShape",
    "Resources" => "Resource",
    "Mashups" => "Mashup",
    "Users" => "User",
    "Groups" => "Group",
    "Organizations" => "Organization",
    _ => return None,
  })
}

/// `code` without comments, so a commented-out call is not a dependency.
/// Strings are kept (a `//` inside one is not a comment) and end at a newline.
fn strip_comments(code: &str) -> String {
  let mut out = String::with_capacity(code.len());
  let mut chars = code.chars().peekable();
  let mut quote: Option<char> = None;
  while let Some(c) = chars.next() {
    if let Some(q) = quote {
      out.push(c);
      if c == '\\' {
        if let Some(n) = chars.next() {
          out.push(n);
        }
      } else if c == q || c == '\n' {
        quote = None;
      }
      continue;
    }
    match (c, chars.peek()) {
      ('/', Some('/')) => {
        while chars.next_if(|&n| n != '\n').is_some() {}
      }
      ('/', Some('*')) => {
        chars.next();
        let mut prev = ' ';
        for n in chars.by_ref() {
          if prev == '*' && n == '/' {
            break;
          }
          if n == '\n' {
            out.push('\n');
          }
          prev = n;
        }
      }
      ('"' | '\'', _) => {
        quote = Some(c);
        out.push(c);
      }
      _ => out.push(c),
    }
  }
  out
}

/// `(type, name, member)` for each entity a script reaches by collection
/// (`Things["X"].Foo()`), also through a variable holding it (`var t =
/// Things["X"]; t.Foo()`). A reference without a member is dropped when the
/// same entity shows up with members.
fn code_refs(code: &str) -> Vec<(&'static str, String, Option<String>)> {
  if !["Things", "ThingTemplates", "ThingShapes", "DataShapes", "Resources", "Mashups", "Users", "Groups", "Organizations"]
    .iter()
    .any(|c| code.contains(c))
  {
    return Vec::new();
  }
  let code = strip_comments(code);
  let mut out: Vec<(&'static str, String, Option<String>)> = Vec::new();
  let mut aliases: HashMap<String, (&'static str, String)> = HashMap::new();
  for c in CODE_REF.captures_iter(&code) {
    let whole = c.get(0).unwrap();
    let Some(ty) = collection_type(&c[1]) else { continue };
    let rest = &code[whole.end()..];
    let (name, bracket) = match (c.get(2), c.get(3)) {
      (Some(n), _) => (n.as_str().to_string(), true),
      (_, Some(n)) => (n.as_str().to_string(), false),
      _ => continue,
    };
    // `Things.GetThing(...)` is a method of the collection, not an entity.
    if !bracket && rest.trim_start().starts_with('(') {
      continue;
    }
    let member = MEMBER.captures(rest).map(|m| m[1].to_string());
    if member.is_none() {
      let mut start = whole.start().saturating_sub(80);
      while !code.is_char_boundary(start) {
        start += 1;
      }
      if let Some(a) = ALIAS_PRE.captures(&code[start..whole.start()]) {
        aliases.insert(a[1].to_string(), (ty, name.clone()));
      }
    }
    out.push((ty, name, member));
  }
  if !aliases.is_empty() {
    for c in ALIAS_CALL.captures_iter(&code) {
      if let Some((ty, name)) = aliases.get(&c[1]) {
        out.push((ty, name.clone(), Some(c[2].to_string())));
      }
    }
  }
  let with_member: HashSet<(&str, String)> =
    out.iter().filter(|r| r.2.is_some()).map(|r| (r.0, r.1.to_lowercase())).collect();
  out.retain(|r| r.2.is_some() || !with_member.contains(&(r.0, r.1.to_lowercase())));
  out
}

/// References in a mashup's JSON: data bindings with the services and
/// properties bound, plus nested mashups and datashapes anywhere in it.
fn mashup_refs(json: &str) -> Vec<(String, String, Option<String>, &'static str)> {
  let mut out = Vec::new();
  if let Ok(root) = serde_json::from_str::<Value>(json)
    && let Some(data) = root.get("Data").and_then(Value::as_object)
  {
    for entry in data.values() {
      let name = entry.get("EntityName").and_then(Value::as_str).unwrap_or("");
      let Some(ty) = entry.get("EntityType").and_then(Value::as_str).and_then(collection_type) else { continue };
      if name.is_empty() {
        continue;
      }
      let mut members = HashSet::new();
      for list in ["Services", "Properties"] {
        for item in entry.get(list).and_then(Value::as_array).into_iter().flatten() {
          let m = ["Target", "Name"].iter().find_map(|k| item.get(k).and_then(Value::as_str)).unwrap_or("");
          if !m.is_empty() && members.insert(m.to_string()) {
            out.push((ty.to_string(), name.to_string(), Some(m.to_string()), "mashup"));
          }
        }
      }
      if members.is_empty() {
        out.push((ty.to_string(), name.to_string(), None, "mashup"));
      }
    }
  }
  for c in MASHUP_STR.captures_iter(json) {
    let ty = if &c[1] == "Mashup" { "Mashup" } else { "DataShape" };
    out.push((ty.to_string(), c[2].to_string(), None, if ty == "Mashup" { "mashup" } else { "datashape" }));
  }
  out
}

/// Parses one entity file. Pure, so tests feed it inline XML.
fn parse_xml(file: &str, text: &str) -> ParsedFile {
  // CDATA spans masked with spaces (same byte offsets) so tag matching never
  // looks inside script code.
  let mut masked = text.to_string();
  let mut cdata: Vec<(usize, usize)> = Vec::new(); // inner content ranges
  let mut at = 0;
  while let Some(s) = text[at..].find("<![CDATA[") {
    let start = at + s;
    let inner = start + 9;
    let end = text[inner..].find("]]>").map_or(text.len(), |e| inner + e);
    cdata.push((inner, end));
    let blank = " ".repeat((end + 3).min(text.len()) - start);
    masked.replace_range(start..(end + 3).min(text.len()), &blank);
    at = (end + 3).min(text.len());
    if at >= text.len() {
      break;
    }
  }

  let mut parsed = ParsedFile { file: file.to_string(), ..Default::default() };
  let mut entity_seen = 0;
  let mut entity_key = String::new();
  let mut members: Vec<(usize, String)> = Vec::new(); // service / subscription starts
  let add = |parsed: &mut ParsedFile, ty: &str, name: &str, kind: &'static str, member: Option<String>| {
    let name = name.trim();
    if !name.is_empty() {
      parsed.refs.push(Ref { ty: ty.into(), name: name.into(), kind, member, from_member: None });
    }
  };

  for m in TAG.captures_iter(&masked) {
    let tag = &m[1];
    if tag == "Entities" {
      continue;
    }
    let a = attrs(&m[2]);
    let get = |k: &str| a.get(k).map(String::as_str).unwrap_or("");
    entity_seen += 1;
    if entity_seen == 1 {
      continue; // the collection element, e.g. <Things>
    }
    if entity_seen == 2 {
      // The entity element.
      if get("name").is_empty() {
        return parsed;
      }
      parsed.entity = Some((tag.to_string(), get("name").to_string()));
      entity_key = format!("{tag}:{}", get("name").to_lowercase());
      match tag {
        "Thing" => {
          add(&mut parsed, "ThingTemplate", get("thingTemplate"), "template", None);
          add(&mut parsed, "Thing", get("valueStream"), "valueStream", None);
        }
        "ThingTemplate" => {
          add(&mut parsed, "ThingTemplate", get("baseThingTemplate"), "template", None);
          add(&mut parsed, "Thing", get("valueStream"), "valueStream", None);
        }
        "Project" => {
          if let Ok(Value::Object(dep)) = serde_json::from_str::<Value>(get("dependsOn"))
            && let Some(Value::String(list)) = dep.get("projects")
          {
            for p in list.split(',') {
              add(&mut parsed, "Project", p.split(':').next().unwrap_or(""), "project", Some("dependsOn".into()));
            }
          }
        }
        _ => {}
      }
      if tag != "Project" {
        add(&mut parsed, "Project", get("projectName"), "project", None);
      }
    }
    match tag {
      "ImplementedShape" => add(&mut parsed, "ThingShape", get("name"), "shape", None),
      "ServiceImplementation" | "Subscription" | "SubscriptionImplementation" => {
        members.push((m.get(0).unwrap().start(), get("name").to_string()));
      }
      _ => {}
    }
    let member = Some(get("name")).filter(|n| !n.is_empty() && entity_seen > 2).map(String::from);
    for key in ["aspect.dataShape", "dataShape", "dataShapeName"] {
      add(&mut parsed, "DataShape", get(key), "datashape", member.clone());
    }
  }
  if parsed.entity.is_none() {
    return parsed;
  }

  for c in PERSISTENCE.captures_iter(text) {
    add(&mut parsed, "Thing", &c[1], "persistenceProvider", None);
  }

  for (start, end) in cdata {
    let inner = &text[start..end];
    let before = text[..start.saturating_sub(9)].trim_end();
    if before.ends_with("<mashupContent>") {
      for (ty, name, member, kind) in mashup_refs(inner) {
        add(&mut parsed, &ty, &name, kind, member);
      }
      continue;
    }
    let from_member = members.iter().rev().find(|(p, _)| *p < start).map(|(_, n)| n.clone());
    for (ty, name, member) in code_refs(inner) {
      parsed.refs.push(Ref { ty: ty.into(), name, kind: "calls", member, from_member: from_member.clone() });
    }
  }
  parsed.refs.retain(|r| format!("{}:{}", r.ty, r.name.to_lowercase()) != entity_key);
  parsed
}

// ------------------------------------------------------------------ index

#[derive(Debug, Default)]
pub struct Index {
  nodes: HashMap<String, Node>,
  edges: Vec<Edge>,
  out: HashMap<String, Vec<usize>>,
  inn: HashMap<String, Vec<usize>>,
}

fn key_of(ty: &str, name: &str) -> String {
  format!("{ty}:{}", name.to_lowercase())
}

impl Index {
  fn build(files: &[Arc<ParsedFile>]) -> Self {
    let mut ix = Index::default();
    for f in files {
      if let Some((ty, name)) = &f.entity {
        let key = key_of(ty, name);
        ix.nodes.insert(
          key.clone(),
          Node { key, ty: ty.clone(), name: name.clone(), file: Some(f.file.clone()), external: false },
        );
      }
    }
    let mut seen: HashSet<Edge> = HashSet::new();
    for f in files {
      let Some((ty, name)) = &f.entity else { continue };
      let from = key_of(ty, name);
      for r in &f.refs {
        let to = key_of(&r.ty, &r.name);
        // Entities exported under another type name (a Thing named like a
        // template) still resolve by exact type; unknown targets are external.
        ix.nodes.entry(to.clone()).or_insert_with(|| Node {
          key: to.clone(),
          ty: r.ty.clone(),
          name: r.name.clone(),
          file: None,
          external: true,
        });
        let edge = Edge {
          from: from.clone(),
          to,
          kind: r.kind.to_string(),
          member: r.member.clone(),
          from_member: r.from_member.clone(),
        };
        if seen.insert(edge.clone()) {
          ix.edges.push(edge);
        }
      }
    }
    // A bare reference is redundant next to members of the same kind.
    let with_member: HashSet<(String, String, String)> = ix
      .edges
      .iter()
      .filter(|e| e.member.is_some())
      .map(|e| (e.from.clone(), e.to.clone(), e.kind.clone()))
      .collect();
    ix.edges.retain(|e| e.member.is_some() || !with_member.contains(&(e.from.clone(), e.to.clone(), e.kind.clone())));
    for (i, e) in ix.edges.iter().enumerate() {
      ix.out.entry(e.from.clone()).or_default().push(i);
      ix.inn.entry(e.to.clone()).or_default().push(i);
    }
    ix
  }

  /// The entity named `name` (of `ty` when given, else the best match).
  pub fn resolve(&self, name: &str, ty: Option<&str>) -> Result<&Node> {
    let name = name.trim();
    let lower = name.to_lowercase();
    let mut found: Vec<&Node> = self
      .nodes
      .values()
      .filter(|n| n.name.to_lowercase() == lower && ty.is_none_or(|t| t.is_empty() || n.ty.eq_ignore_ascii_case(t)))
      .collect();
    found.sort_by_key(|n| (n.external, type_rank(&n.ty), n.ty.clone()));
    found.first().copied().ok_or_else(|| {
      CoreError::NotFound(format!(
        "\"{name}\" is not in the exported entities. Check the spelling, or export it from TWX Entities first."
      ))
    })
  }

  pub fn search(&self, query: &str, limit: usize) -> Vec<Node> {
    let q = query.trim().to_lowercase();
    let mut hits: Vec<(u8, &Node)> = self
      .nodes
      .values()
      .filter(|n| !n.external)
      .filter_map(|n| {
        let name = n.name.to_lowercase();
        let rank = if q.is_empty() || name == q {
          0
        } else if name.starts_with(&q) {
          1
        } else if name.contains(&q) {
          2
        } else {
          return None;
        };
        Some((rank, n))
      })
      .collect();
    hits.sort_by(|a, b| (a.0, type_rank(&a.1.ty), &a.1.name).cmp(&(b.0, type_rank(&b.1.ty), &b.1.name)));
    hits.into_iter().take(limit).map(|(_, n)| n.clone()).collect()
  }

  pub fn summary(&self) -> Summary {
    let mut counts: HashMap<&str, usize> = HashMap::new();
    for n in self.nodes.values().filter(|n| !n.external) {
      *counts.entry(&n.ty).or_default() += 1;
    }
    let mut types: Vec<TypeCount> = counts.into_iter().map(|(t, c)| TypeCount { ty: t.into(), count: c }).collect();
    types.sort_by(|a, b| b.count.cmp(&a.count).then_with(|| a.ty.cmp(&b.ty)));
    Summary { entities: types.iter().map(|t| t.count).sum(), edges: self.edges.len(), types }
  }

  /// What `entity` depends on (`Out`), what depends on it (`In`), or both,
  /// up to `depth` hops and `limit` nodes. `kinds` empty means every kind.
  pub fn dependencies(
    &self,
    entity: &str,
    ty: Option<&str>,
    direction: Direction,
    depth: usize,
    kinds: &[String],
    limit: usize,
  ) -> Result<Graph> {
    let center = self.resolve(entity, ty)?;
    let depth = depth.clamp(1, 5);
    let limit = limit.max(1);
    let kind_ok = |e: &Edge| kinds.is_empty() || kinds.iter().any(|k| k.eq_ignore_ascii_case(&e.kind));
    let mut nodes = vec![center.clone()];
    let mut included: HashSet<&str> = HashSet::from([center.key.as_str()]);
    let mut edge_ids: Vec<usize> = Vec::new();
    let mut edge_seen: HashSet<usize> = HashSet::new();
    let mut truncated = false;
    let mut queue: VecDeque<(&str, usize)> = VecDeque::from([(center.key.as_str(), 0)]);
    while let Some((key, d)) = queue.pop_front() {
      if d >= depth {
        continue;
      }
      let mut next: Vec<(usize, &str)> = Vec::new();
      if direction != Direction::In {
        next.extend(self.out.get(key).into_iter().flatten().map(|&i| (i, self.edges[i].to.as_str())));
      }
      if direction != Direction::Out {
        next.extend(self.inn.get(key).into_iter().flatten().map(|&i| (i, self.edges[i].from.as_str())));
      }
      for (i, other) in next {
        if !kind_ok(&self.edges[i]) {
          continue;
        }
        if !included.contains(other) {
          if nodes.len() >= limit {
            truncated = true;
            continue;
          }
          included.insert(other);
          nodes.push(self.nodes[other].clone());
          queue.push_back((other, d + 1));
        }
        if edge_seen.insert(i) {
          edge_ids.push(i);
        }
      }
    }
    Ok(Graph {
      center: center.key.clone(),
      nodes,
      edges: edge_ids.into_iter().map(|i| self.edges[i].clone()).collect(),
      truncated,
    })
  }

  /// Who calls `service` of `entity`: scripts and mashups that name the entity
  /// with that member, and the same for entities inheriting from it (so a
  /// template's or thing shape's service counts its things' callers).
  pub fn service_callers(&self, entity: &str, ty: Option<&str>, service: &str) -> Result<Callers> {
    let center = self.resolve(entity, ty)?;
    let mut targets: Vec<&str> = vec![center.key.as_str()];
    let mut i = 0;
    while i < targets.len() {
      for &e in self.inn.get(targets[i]).into_iter().flatten() {
        let edge = &self.edges[e];
        if matches!(edge.kind.as_str(), "template" | "shape") && !targets.contains(&edge.from.as_str()) {
          targets.push(edge.from.as_str());
        }
      }
      i += 1;
    }
    let mut callers = Vec::new();
    for t in &targets {
      for &e in self.inn.get(*t).into_iter().flatten() {
        let edge = &self.edges[e];
        if matches!(edge.kind.as_str(), "calls" | "mashup") && edge.member.as_deref().is_some_and(|m| m.eq_ignore_ascii_case(service.trim())) {
          callers.push(Caller {
            caller: self.nodes[&edge.from].clone(),
            from_member: edge.from_member.clone(),
            kind: edge.kind.clone(),
            via: (*t != center.key).then(|| self.nodes[*t].name.clone()),
          });
        }
      }
    }
    callers.sort_by(|a, b| (&a.caller.name, &a.from_member).cmp(&(&b.caller.name, &b.from_member)));
    Ok(Callers { entity: center.clone(), service: service.trim().to_string(), callers })
  }

  /// Exported entities (of `ty` when given) that nothing references. A
  /// heuristic: dynamic lookups, REST calls and entry points are not seen.
  pub fn unused(&self, ty: Option<&str>) -> Unused {
    let mut nodes: Vec<Node> = self
      .nodes
      .values()
      .filter(|n| !n.external && ty.is_none_or(|t| t.is_empty() || n.ty.eq_ignore_ascii_case(t)))
      .filter(|n| self.inn.get(&n.key).is_none_or(Vec::is_empty))
      .cloned()
      .collect();
    nodes.sort_by(|a, b| (type_rank(&a.ty), &a.ty, &a.name).cmp(&(type_rank(&b.ty), &b.ty, &b.name)));
    Unused { total: nodes.len(), nodes }
  }
}

fn type_rank(ty: &str) -> u8 {
  match ty {
    "Thing" => 0,
    "ThingTemplate" => 1,
    "ThingShape" => 2,
    "DataShape" => 3,
    "Mashup" => 4,
    _ => 5,
  }
}

// ------------------------------------------------------------------ cache

struct CachedFile {
  modified: Option<SystemTime>,
  len: u64,
  parsed: Arc<ParsedFile>,
}

#[derive(Default)]
struct EnvCache {
  files: HashMap<PathBuf, CachedFile>,
  index: Option<Arc<Index>>,
}

static CACHE: LazyLock<Mutex<HashMap<PathBuf, EnvCache>>> = LazyLock::new(Default::default);

/// The index for `<base>/<env_dir>`, re-reading only files that changed since
/// the last call.
pub fn index(base: &Path, env_dir: &str) -> Result<Arc<Index>> {
  if env_dir.is_empty() || env_dir.contains(['/', '\\']) || env_dir == "." || env_dir == ".." {
    return Err(CoreError::Invalid("Invalid environment".into()));
  }
  let root = base.join(env_dir);
  if !root.is_dir() {
    return Err(CoreError::NotFound(format!(
      "No exported entities for \"{env_dir}\". Export them from TWX Entities first."
    )));
  }
  let mut files: Vec<(PathBuf, Option<SystemTime>, u64)> = WalkDir::new(&root)
    .into_iter()
    .filter_map(|e| e.ok())
    .filter(|e| e.file_type().is_file() && e.path().extension().is_some_and(|x| x.eq_ignore_ascii_case("xml")))
    .map(|e| {
      let meta = e.metadata().ok();
      (e.into_path(), meta.as_ref().and_then(|m| m.modified().ok()), meta.map_or(0, |m| m.len()))
    })
    .collect();
  files.sort_by(|a, b| a.0.cmp(&b.0));

  let mut cache = {
    let mut all = CACHE.lock().unwrap_or_else(|e| e.into_inner());
    std::mem::take(all.entry(root.clone()).or_default())
  };
  let mut kept: HashMap<PathBuf, CachedFile> = HashMap::new();
  let mut stale: Vec<(PathBuf, Option<SystemTime>, u64)> = Vec::new();
  for (path, modified, len) in files.iter().cloned() {
    match cache.files.remove(&path) {
      Some(c) if c.modified == modified && c.len == len => {
        kept.insert(path, c);
      }
      _ => stale.push((path, modified, len)),
    }
  }
  let changed = !stale.is_empty() || !cache.files.is_empty() || cache.index.is_none();

  let threads = std::thread::available_parallelism().map_or(4, |n| n.get()).min(8);
  let chunk = stale.len().div_ceil(threads).max(1);
  let parsed: Vec<(PathBuf, Option<SystemTime>, u64, Arc<ParsedFile>)> = std::thread::scope(|s| {
    let handles: Vec<_> = stale
      .chunks(chunk)
      .map(|part| {
        s.spawn(move || {
          part
            .iter()
            .map(|(path, modified, len)| {
              let rel = path.strip_prefix(base).unwrap_or(path).to_string_lossy().replace('\\', "/");
              let text = std::fs::read(path).map(|b| String::from_utf8_lossy(&b).into_owned()).unwrap_or_default();
              (path.clone(), *modified, *len, Arc::new(parse_xml(&rel, &text)))
            })
            .collect::<Vec<_>>()
        })
      })
      .collect();
    handles.into_iter().flat_map(|h| h.join().unwrap_or_default()).collect()
  });
  for (path, modified, len, parsed) in parsed {
    kept.insert(path, CachedFile { modified, len, parsed });
  }

  let index = match (changed, cache.index.take()) {
    (false, Some(ix)) => ix,
    _ => {
      let parsed: Vec<Arc<ParsedFile>> = files.iter().filter_map(|(p, ..)| kept.get(p)).map(|c| c.parsed.clone()).collect();
      Arc::new(Index::build(&parsed))
    }
  };
  cache.files = kept;
  cache.index = Some(index.clone());
  CACHE.lock().unwrap_or_else(|e| e.into_inner()).insert(root, cache);
  Ok(index)
}

#[cfg(test)]
mod tests {
  use super::*;

  fn thing(name: &str, template: &str, body: &str) -> String {
    format!(
      r#"<?xml version="1.0" encoding="UTF-8"?>
<Entities majorVersion="10">
    <Things>
        <Thing
         name="{name}"
         projectName="Proj.A"
         thingTemplate="{template}"
         valueStream="VS.One">
            <ImplementedShapes>
                <ImplementedShape
                 name="Shape.One"
                 type="ThingShape"></ImplementedShape>
            </ImplementedShapes>
            <ServiceDefinition
             name="Svc">
                <ResultType
                 aspect.dataShape="DS.Result"
                 baseType="INFOTABLE"
                 name="result"></ResultType>
            </ServiceDefinition>
            <ServiceImplementations>
                <ServiceImplementation
                 handlerName="Script"
                 name="Svc">
                    <code><![CDATA[{body}]]></code>
                </ServiceImplementation>
            </ServiceImplementations>
        </Thing>
    </Things>
</Entities>"#
    )
  }

  fn has(p: &ParsedFile, ty: &str, name: &str, kind: &str, member: Option<&str>) -> bool {
    p.refs.iter().any(|r| r.ty == ty && r.name == name && r.kind == kind && r.member.as_deref() == member)
  }

  #[test]
  fn parses_structure_refs() {
    let p = parse_xml("env/a.xml", &thing("T.A", "TT.Base", ""));
    assert_eq!(p.entity, Some(("Thing".into(), "T.A".into())));
    assert!(has(&p, "ThingTemplate", "TT.Base", "template", None));
    assert!(has(&p, "ThingShape", "Shape.One", "shape", None));
    assert!(has(&p, "DataShape", "DS.Result", "datashape", Some("result")));
    assert!(has(&p, "Project", "Proj.A", "project", None));
    assert!(has(&p, "Thing", "VS.One", "valueStream", None));
  }

  #[test]
  fn parses_code_calls_with_members_and_aliases() {
    let code = r#"
      var x = Things["T.B"].DoIt({a: 1});
      var t = Things['T.C'];
      t.Other();
      Resources.InfoTableFunctions.Sort();
      var all = Things.GetThingsByName();
      // Things["T.Commented"].Nope();
      /* ThingTemplates["TT.Block"] */
      var s = "Things[\"T.InString\"]";
      DataShapes["DS.X"];
    "#;
    let p = parse_xml("env/a.xml", &thing("T.A", "TT.Base", code));
    assert!(has(&p, "Thing", "T.B", "calls", Some("DoIt")));
    assert!(has(&p, "Thing", "T.C", "calls", Some("Other")));
    assert!(has(&p, "Resource", "InfoTableFunctions", "calls", Some("Sort")));
    assert!(has(&p, "DataShape", "DS.X", "calls", None));
    assert!(!p.refs.iter().any(|r| r.name.contains("Commented") || r.name.contains("Block") || r.name == "GetThingsByName"));
    let call = p.refs.iter().find(|r| r.name == "T.B").unwrap();
    assert_eq!(call.from_member.as_deref(), Some("Svc"));
  }

  #[test]
  fn parses_mashup_bindings() {
    let json = r#"{"Data":{"a":{"EntityName":"T.B","EntityType":"Things","Services":[{"Target":"Get"},{"Target":"Get"}]},
      "s":{"EntityName":"","EntityType":"Session"}},
      "Widgets":[{"Mashup":"Mashup.Inner","DataShape":"DS.W"}]}"#;
    let xml = format!(
      "<Entities><Mashups><Mashup name=\"M.A\" projectName=\"P\"><mashupContent><![CDATA[{json}]]></mashupContent></Mashup></Mashups></Entities>"
    );
    let p = parse_xml("env/m.xml", &xml);
    assert_eq!(p.entity, Some(("Mashup".into(), "M.A".into())));
    assert!(has(&p, "Thing", "T.B", "mashup", Some("Get")));
    assert!(has(&p, "Mashup", "Mashup.Inner", "mashup", None));
    assert!(has(&p, "DataShape", "DS.W", "datashape", None));
    assert_eq!(p.refs.iter().filter(|r| r.name == "T.B").count(), 1);
  }

  fn sample_index() -> Index {
    let a = parse_xml("e/a.xml", &thing("T.A", "TT.Base", r#"Things["T.B"].Run(); ThingTemplates["TT.Base"].Do();"#));
    let b = parse_xml("e/b.xml", &thing("T.B", "TT.Base", ""));
    let tt = parse_xml(
      "e/tt.xml",
      "<Entities><ThingTemplates><ThingTemplate name=\"TT.Base\" baseThingTemplate=\"GenericThing\"></ThingTemplate></ThingTemplates></Entities>",
    );
    let c = parse_xml("e/c.xml", &thing("T.C", "TT.Child", r#"Things["T.A"].Run();"#));
    Index::build(&[Arc::new(a), Arc::new(b), Arc::new(tt), Arc::new(c)])
  }

  #[test]
  fn queries_dependencies_callers_and_unused() {
    let ix = sample_index();
    let g = ix.dependencies("t.a", None, Direction::Out, 1, &["calls".into()], 50).unwrap();
    assert!(g.nodes.iter().any(|n| n.name == "T.B") && g.nodes.iter().any(|n| n.name == "TT.Base"));
    assert!(!g.truncated && g.edges.iter().all(|e| e.kind == "calls"));
    let tiny = ix.dependencies("T.A", None, Direction::Both, 2, &[], 2).unwrap();
    assert!(tiny.truncated && tiny.nodes.len() == 2);

    let callers = ix.service_callers("T.B", None, "run").unwrap();
    assert_eq!(callers.callers.len(), 1);
    assert_eq!(callers.callers[0].caller.name, "T.A");
    assert_eq!(callers.callers[0].from_member.as_deref(), Some("Svc"));

    // A template's service is reached through the things based on it.
    let tpl = ix.service_callers("TT.Base", None, "Do").unwrap();
    assert_eq!(tpl.callers.len(), 1);

    let unused: Vec<_> = ix.unused(Some("Thing")).nodes.into_iter().map(|n| n.name).collect();
    assert_eq!(unused, vec!["T.C".to_string()]);
    assert!(ix.resolve("Nope", None).is_err());
  }

  #[test]
  fn indexes_a_folder_and_notices_changes() {
    let dir = tempfile::tempdir().unwrap();
    let env = dir.path().join("dev/p/Things");
    std::fs::create_dir_all(&env).unwrap();
    std::fs::write(env.join("T.A.xml"), thing("T.A", "TT.Base", r#"Things["T.B"].Run();"#)).unwrap();
    let first = index(dir.path(), "dev").unwrap();
    assert_eq!(first.summary().entities, 1);
    assert!(Arc::ptr_eq(&first, &index(dir.path(), "dev").unwrap()), "unchanged folder reuses the index");
    std::fs::write(env.join("T.B.xml"), thing("T.B", "TT.Base", "")).unwrap();
    let second = index(dir.path(), "dev").unwrap();
    assert_eq!(second.summary().entities, 2);
    assert_eq!(second.nodes["Thing:t.a"].file.as_deref(), Some("dev/p/Things/T.A.xml"));
  }
}
