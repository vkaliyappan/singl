//! The ThingWorx REST calls the deployment pipeline makes, from singl-web's
//! `lib/twx/api.ts`. Failures become [`CoreError::Twx`] with the line
//! ThingWorx itself gave dug out of its JSON or HTML error body.

use std::sync::LazyLock;

use base64::Engine;
use regex::Regex;
use reqwest::{Method, RequestBuilder, Response};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::{CoreError, Result};

/// Long enough for a Java message and its cause, short enough to read.
const MAX_DETAIL: usize = 600;

/// Collection a Type's entities live under in REST paths.
pub fn collection_name(entity_type: &str) -> &str {
  match entity_type {
    "DataShape" => "DataShapes",
    "Group" => "Groups",
    "Mashup" => "Mashups",
    "MediaEntity" => "MediaEntities",
    "Organization" => "Organizations",
    "Project" => "Projects",
    "StateDefinition" => "StateDefinitions",
    "StyleDefinition" => "StyleDefinitions",
    "StyleTheme" => "StyleThemes",
    "Thing" => "Things",
    "ThingShape" => "ThingShapes",
    "ThingTemplate" => "ThingTemplates",
    "Transformer" => "Transformers",
    "Resource" => "Resources",
    "Subsystem" => "Subsystems",
    other => other,
  }
}

/// Type of the entities under a REST collection, for GetEntityList; the
/// inverse of [`collection_name`].
pub fn entity_type_of(collection: &str) -> &str {
  match collection {
    "DataShapes" => "DataShape",
    "Groups" => "Group",
    "Mashups" => "Mashup",
    "MediaEntities" => "MediaEntity",
    "Organizations" => "Organization",
    "Projects" => "Project",
    "StateDefinitions" => "StateDefinition",
    "StyleDefinitions" => "StyleDefinition",
    "StyleThemes" => "StyleTheme",
    "Things" => "Thing",
    "ThingShapes" => "ThingShape",
    "ThingTemplates" => "ThingTemplate",
    "Transformers" => "Transformer",
    "Resources" => "Resource",
    "Subsystems" => "Subsystem",
    other => other,
  }
}

/// `encodeURIComponent`.
fn encode(s: &str) -> String {
  let mut out = String::with_capacity(s.len());
  for b in s.bytes() {
    match b {
      b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')' => {
        out.push(b as char)
      }
      _ => out.push_str(&format!("%{b:02X}")),
    }
  }
  out
}

fn status_hint(status: u16) -> Option<&'static str> {
  Some(match status {
    400 => "ThingWorx rejected the request",
    401 => "the App Key was not accepted",
    403 => "the App Key is not permitted to do this",
    404 => "not found on this server",
    406 => "ThingWorx would not accept these parameters",
    500 => "ThingWorx threw while running this",
    502 => "the server is unreachable",
    503 => "the server is not accepting requests",
    504 => "the server took too long to answer",
    _ => return None,
  })
}

fn tidy(text: &str) -> String {
  let clean = text.split_whitespace().collect::<Vec<_>>().join(" ");
  match clean.char_indices().nth(MAX_DETAIL) {
    Some((cut, _)) => format!("{}…", &clean[..cut]),
    None => clean,
  }
}

static ANY_TAG: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"<\w+[\s>]").unwrap());
static PRE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?is)<pre[^>]*>(.*?)</pre>").unwrap());
static H1: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?is)<h1[^>]*>(.*?)</h1>").unwrap());
static TITLE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?is)<title[^>]*>(.*?)</title>").unwrap());
static STRIP_TAGS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"<[^>]+>").unwrap());

/// The one line that matters out of a ThingWorx error response: the
/// `errorMsg` of a JSON body, or the cause in an HTML error page.
fn twx_detail(body: &str) -> String {
  let raw = body.trim();
  if raw.is_empty() {
    return String::new();
  }
  if (raw.starts_with('{') || raw.starts_with('['))
    && let Ok(Value::Object(json)) = serde_json::from_str::<Value>(raw)
  {
    for key in ["errorMsg", "message", "error", "description"] {
      if let Some(Value::String(value)) = json.get(key)
        && !value.trim().is_empty()
      {
        return tidy(value);
      }
    }
  }
  if ANY_TAG.is_match(raw) {
    // Tomcat puts the cause in the first <pre>; ThingWorx's own pages use <h1>.
    let marked = [&PRE, &H1, &TITLE].iter().find_map(|re| re.captures(raw)).map(|c| c[1].to_string());
    let text = STRIP_TAGS.replace_all(marked.as_deref().unwrap_or(raw), " ");
    let text = [
      ("&quot;", "\""),
      ("&#34;", "\""),
      ("&apos;", "'"),
      ("&#39;", "'"),
      ("&amp;", "&"),
      ("&#38;", "&"),
      ("&lt;", "<"),
      ("&#60;", "<"),
      ("&gt;", ">"),
      ("&#62;", ">"),
      ("&nbsp;", " "),
    ]
    .iter()
    .fold(text.into_owned(), |t, (from, to)| t.replace(from, to));
    return tidy(&text);
  }
  tidy(raw)
}

/// An error that leads with the cause. `what` names the call; the status stays
/// on the end, since 401 and 500 send you to different places.
async fn failed(res: Response, what: &str) -> CoreError {
  let status = res.status();
  let body = res.text().await.unwrap_or_default();
  let detail = twx_detail(&body);
  let hint = status_hint(status.as_u16());
  let mut said = if !detail.is_empty() {
    detail
  } else {
    hint.or(status.canonical_reason()).unwrap_or("no reason given").to_string()
  };
  // "Unauthorized" alone does not say which credential the server means.
  if matches!(status.as_u16(), 401 | 403)
    && let Some(hint) = hint
    && !said.to_lowercase().contains("key")
  {
    said = format!("{said} — {hint}");
  }
  CoreError::Twx { status: status.as_u16(), message: format!("{what} failed — {said} (HTTP {})", status.as_u16()) }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct TwxEntity {
  pub name: String,
  #[serde(rename = "type")]
  pub entity_type: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct RepositoryDir {
  pub name: String,
  pub path: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct EntitySearchResult {
  pub name: String,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub description: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceParam {
  pub name: String,
  pub description: String,
  pub base_type: String,
  pub ordinal: f64,
  pub aspects: Value,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceResultType {
  pub name: String,
  pub description: String,
  pub base_type: String,
  pub aspects: Value,
}

/// One field of a DataShape, as the flow editor's schema view reads it.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DataShapeField {
  pub name: String,
  pub base_type: String,
  pub description: String,
  pub ordinal: f64,
}

/// `fieldDefinitions` (or `effectiveShape.fieldDefinitions`) of a DataShape, by ordinal.
pub fn datashape_fields(json: &Value) -> Vec<DataShapeField> {
  let defs = json
    .get("fieldDefinitions")
    .or_else(|| json.get("effectiveShape").and_then(|e| e.get("fieldDefinitions")))
    .and_then(Value::as_object);
  let text = |def: &Value, key: &str, fallback: &str| match def.get(key) {
    Some(Value::String(s)) => s.clone(),
    Some(Value::Null) | None => fallback.to_string(),
    Some(other) => other.to_string(),
  };
  let mut fields: Vec<DataShapeField> = defs
    .into_iter()
    .flatten()
    .map(|(key, def)| DataShapeField {
      name: text(def, "name", key),
      base_type: text(def, "baseType", "STRING"),
      description: text(def, "description", ""),
      ordinal: def.get("ordinal").and_then(Value::as_f64).unwrap_or(0.0),
    })
    .collect();
  fields.sort_by(|a, b| a.ordinal.total_cmp(&b.ordinal));
  fields
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceDef {
  pub name: String,
  pub description: String,
  pub category: String,
  pub parameter_definitions: Vec<ServiceParam>,
  pub result_type: ServiceResultType,
}

/// A JSON object's entries in document order. serde_json's `Map` sorts its
/// keys, and ThingWorx lists services and parameters in a meaningful order.
struct Entries(Vec<(String, Value)>);

impl<'de> Deserialize<'de> for Entries {
  fn deserialize<D: serde::Deserializer<'de>>(d: D) -> std::result::Result<Self, D::Error> {
    struct Visit;
    impl<'de> serde::de::Visitor<'de> for Visit {
      type Value = Entries;
      fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        f.write_str("an object")
      }
      fn visit_map<A: serde::de::MapAccess<'de>>(self, mut map: A) -> std::result::Result<Entries, A::Error> {
        let mut out = Vec::new();
        while let Some(entry) = map.next_entry::<String, Value>()? {
          out.push(entry);
        }
        Ok(Entries(out))
      }
      fn visit_unit<E>(self) -> std::result::Result<Entries, E> {
        Ok(Entries(Vec::new()))
      }
    }
    d.deserialize_any(Visit)
  }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PropertyDef {
  pub name: String,
  pub description: String,
  pub base_type: String,
  pub aspects: Value,
}

/// `String(v ?? fallback)` for a field of a JSON object.
fn text_or(v: Option<&Value>, fallback: &str) -> String {
  match v {
    None | Some(Value::Null) => fallback.to_string(),
    Some(Value::String(s)) => s.clone(),
    Some(other) => other.to_string(),
  }
}

/// An object field, or `{}`.
fn object_or_empty(v: Option<&Value>) -> Value {
  match v {
    Some(o @ Value::Object(_)) => o.clone(),
    _ => json!({}),
  }
}

/// singl-web's `getServiceDefinitions` mapping over a GetEntity reply.
/// Parsed from text, since a `Value` would lose the order of the entries.
fn service_defs(entity: &str, what: &str) -> Result<Vec<ServiceDef>> {
  #[derive(Deserialize)]
  #[serde(rename_all = "camelCase")]
  struct Shape {
    service_definitions: Option<Entries>,
  }
  #[derive(Deserialize)]
  #[serde(rename_all = "camelCase")]
  struct Entity {
    effective_shape: Option<Shape>,
  }
  let raw = entity.trim();
  let entity: Entity = serde_json::from_str(if raw.is_empty() { "{}" } else { raw })
    .map_err(|e| CoreError::Twx { status: 0, message: format!("{what} failed — unexpected response: {e}") })?;
  let defs = entity.effective_shape.and_then(|s| s.service_definitions).map(|e| e.0).unwrap_or_default();
  Ok(
    defs
      .into_iter()
      .map(|(name, def)| {
        let result = def.get("resultType");
        let field = |key: &str| result.and_then(|r| r.get(key));
        let mut params: Vec<ServiceParam> = match def.get("parameterDefinitions") {
          Some(Value::Object(map)) => map
            .values()
            .map(|p| ServiceParam {
              name: text_or(p.get("name"), ""),
              description: text_or(p.get("description"), ""),
              base_type: text_or(p.get("baseType"), "STRING"),
              ordinal: p.get("ordinal").and_then(Value::as_f64).unwrap_or(0.0),
              aspects: object_or_empty(p.get("aspects")),
            })
            .collect(),
          _ => Vec::new(),
        };
        // The map arrives with its keys sorted; ordinal is the order ThingWorx means.
        params.sort_by(|a, b| a.ordinal.total_cmp(&b.ordinal));
        ServiceDef {
          description: text_or(def.get("description"), ""),
          category: text_or(def.get("category"), ""),
          parameter_definitions: params,
          result_type: ServiceResultType {
            name: text_or(field("name"), "result"),
            description: text_or(field("description"), ""),
            base_type: text_or(field("baseType"), "NOTHING"),
            aspects: object_or_empty(field("aspects")),
          },
          name,
        }
      })
      .collect(),
  )
}

#[derive(Deserialize)]
struct Rows<T> {
  #[serde(default = "Vec::new")]
  rows: Vec<T>,
}

/// One ThingWorx server, authenticated by App Key.
#[derive(Clone)]
pub struct Client {
  base: String,
  app_key: String,
  http: reqwest::Client,
}

impl Client {
  pub fn new(base_url: &str, app_key: &str) -> Self {
    Self { base: base_url.trim_end_matches('/').to_string(), app_key: app_key.to_string(), http: reqwest::Client::new() }
  }

  fn request(&self, method: Method, url: &str, accept: &str) -> RequestBuilder {
    self.http.request(method, url).header("appKey", &self.app_key).header("Accept", accept)
  }

  async fn send(&self, req: RequestBuilder, what: &str) -> Result<Response> {
    let res = req
      .send()
      .await
      .map_err(|err| CoreError::Twx { status: 0, message: format!("{what} failed — {}", connect_error(&err)) })?;
    if res.status().is_success() { Ok(res) } else { Err(failed(res, what).await) }
  }

  async fn post_json(&self, path: &str, body: &Value, what: &str) -> Result<Response> {
    let req = self.request(Method::POST, &format!("{}{path}", self.base), "application/json").json(body);
    self.send(req, what).await
  }

  async fn read_json<T: serde::de::DeserializeOwned>(res: Response, what: &str) -> Result<T> {
    let text = res.text().await.map_err(|e| CoreError::Twx { status: 0, message: format!("{what} failed — {e}") })?;
    let text = if text.trim().is_empty() { "{}" } else { &text };
    serde_json::from_str(text)
      .map_err(|e| CoreError::Twx { status: 0, message: format!("{what} failed — unexpected response: {e}") })
  }

  /// Names of every project on the server.
  pub async fn all_projects(&self) -> Result<Vec<String>> {
    #[derive(Deserialize)]
    struct Named {
      #[serde(default)]
      name: String,
    }
    let what = "GetProjects";
    let res = self.send(self.request(Method::GET, &format!("{}/Projects", self.base), "application/json"), what).await?;
    let rows = Self::read_json::<Rows<Named>>(res, what).await?.rows;
    Ok(rows.into_iter().map(|r| r.name).filter(|n| !n.is_empty()).collect())
  }

  pub async fn project_entities(&self, project: &str) -> Result<Vec<TwxEntity>> {
    let what = format!("GetEntities {project}");
    let res = self.post_json(&format!("/Projects/{}/Services/GetEntities", encode(project)), &json!({}), &what).await?;
    Ok(Self::read_json::<Rows<TwxEntity>>(res, &what).await?.rows)
  }

  pub async fn export_entity(&self, entity_type: &str, name: &str) -> Result<String> {
    let collection = collection_name(entity_type);
    let url = format!("{}/Exporter/{collection}/{}", self.base, encode(name));
    let what = format!("Export {collection}/{name}");
    let res = self.send(self.request(Method::GET, &url, "text/xml"), &what).await?;
    res.text().await.map_err(|e| CoreError::Twx { status: 0, message: format!("{what} failed — {e}") })
  }

  /// POSTs a raw body (the import feature's hand-built multipart form) and
  /// resolves with the response text. `path` is under the Thingworx root.
  pub(crate) async fn post_raw(&self, path: &str, content_type: &str, body: Vec<u8>, what: &str) -> Result<String> {
    let req = self
      .request(Method::POST, &format!("{}{path}", self.base), "application/json, text/xml, */*")
      .header("X-XSRF-TOKEN", "TWX-XSRF-TOKEN-VALUE")
      .header("Content-Type", content_type)
      .body(body);
    let res = self.send(req, what).await?;
    res.text().await.map_err(|e| CoreError::Twx { status: 0, message: format!("{what} failed — {e}") })
  }

  /// Exports a project as `<file_name>` (".zip" optional) into SystemRepository/`remote_dir`.
  pub async fn export_project_to_zip(&self, project: &str, remote_dir: &str, file_name: &str) -> Result<()> {
    let name = file_name.strip_suffix(".zip").unwrap_or(file_name);
    let body = json!({ "repositoryName": "SystemRepository", "path": remote_dir, "name": name, "projectName": project });
    self
      .post_json(
        "/Resources/SourceControlFunctions/Services/ExportSourceControlledEntitiesToZipFile",
        &body,
        &format!("ExportToZip {project}"),
      )
      .await?;
    Ok(())
  }

  /// Writes a project's entities as source-control XML into a file repository folder.
  pub async fn export_project_to_source_control(&self, project: &str, repository: &str, remote_dir: &str) -> Result<()> {
    let body = json!({ "repositoryName": repository, "path": remote_dir, "projectName": project });
    self
      .post_json(
        "/Resources/SourceControlFunctions/Services/ExportSourceControlledEntities",
        &body,
        &format!("ExportSourceControlledEntities {project}"),
      )
      .await?;
    Ok(())
  }

  /// Downloads SystemRepository/`remote_dir`/`file_name` through its download link.
  pub async fn download_repository_file(&self, remote_dir: &str, file_name: &str) -> Result<Vec<u8>> {
    #[derive(Deserialize)]
    struct Entry {
      name: String,
      #[serde(rename = "downloadLink")]
      download_link: Option<String>,
    }
    let what = "GetFileListingWithLinks";
    let res = self
      .post_json("/Things/SystemRepository/Services/GetFileListingWithLinks", &json!({ "path": remote_dir }), what)
      .await?;
    let rows = Self::read_json::<Rows<Entry>>(res, what).await?.rows;
    let Some(entry) = rows.iter().find(|r| r.name == file_name) else {
      let names: Vec<_> = rows.iter().map(|r| r.name.as_str()).collect();
      return Err(CoreError::NotFound(format!(
        "File \"{file_name}\" not found in SystemRepository/{remote_dir} — found: [{}]",
        names.join(", ")
      )));
    };
    let link = entry
      .download_link
      .as_deref()
      .ok_or_else(|| CoreError::Invalid(format!("No downloadLink for \"{file_name}\"")))?;
    let origin = reqwest::Url::parse(&self.base)
      .map_err(|e| CoreError::Invalid(format!("Invalid ThingWorx URL {}: {e}", self.base)))?
      .origin()
      .ascii_serialization();
    let what = format!("Download {file_name}");
    let res = self.send(self.request(Method::GET, &format!("{origin}{link}"), "application/octet-stream"), &what).await?;
    Ok(res.bytes().await.map_err(|e| CoreError::Twx { status: 0, message: format!("{what} failed — {e}") })?.to_vec())
  }

  async fn repository_service(&self, repository: &str, service: &str, inputs: Value) -> Result<Vec<Value>> {
    let what = format!("{repository}.{service}");
    let res = self.post_json(&format!("/Things/{}/Services/{service}", encode(repository)), &inputs, &what).await?;
    Ok(Self::read_json::<Rows<Value>>(res, &what).await?.rows)
  }

  pub async fn list_repository_directories(&self, repository: &str, dir: &str) -> Result<Vec<RepositoryDir>> {
    let path = if dir.is_empty() { "/" } else { dir };
    let rows = self.repository_service(repository, "ListDirectories", json!({ "path": path })).await?;
    let text = |v: &Value, key: &str| v.get(key).and_then(Value::as_str).unwrap_or("").to_string();
    let mut dirs: Vec<_> = rows
      .iter()
      .map(|r| RepositoryDir { name: text(r, "name"), path: text(r, "path") })
      .filter(|d| !d.name.is_empty())
      .collect();
    dirs.sort_by(|a, b| locale_order(&a.name, &b.name));
    Ok(dirs)
  }

  /// Creates `dir` one segment at a time; CreateFolder fails on one that exists.
  pub async fn ensure_repository_folder(&self, repository: &str, dir: &str) -> Result<()> {
    let mut current = String::new();
    for segment in dir.split(['/', '\\']).filter(|s| !s.is_empty()) {
      let parent = if current.is_empty() { "/".to_string() } else { current.clone() };
      current = format!("{current}/{segment}");
      let listing = self.repository_service(repository, "ListDirectories", json!({ "path": parent })).await;
      if listing.is_ok_and(|rows| rows.iter().any(|r| r.get("name").and_then(Value::as_str) == Some(segment))) {
        continue;
      }
      self.repository_service(repository, "CreateFolder", json!({ "path": current })).await?;
    }
    Ok(())
  }

  pub async fn save_repository_file(&self, repository: &str, path: &str, content: &[u8]) -> Result<()> {
    let content = base64::engine::general_purpose::STANDARD.encode(content);
    self.repository_service(repository, "SaveBinary", json!({ "path": path, "content": content })).await?;
    Ok(())
  }

  /// Unzips `zip_path` into `dest`, which ThingWorx creates if needed.
  pub async fn extract_repository_zip(&self, repository: &str, zip_path: &str, dest: &str) -> Result<bool> {
    let rows = self
      .repository_service(repository, "ExtractZipArchive", json!({ "zipFileName": zip_path, "path": dest }))
      .await?;
    Ok(match rows.first().and_then(|r| r.get("result")) {
      None | Some(Value::Null) => true,
      Some(Value::Bool(b)) => *b,
      Some(Value::String(s)) => !s.is_empty(),
      Some(Value::Number(n)) => n.as_f64() != Some(0.0),
      Some(_) => true,
    })
  }

  /// Entities of a type (`Thing`, or its collection `Things`) whose names match `name_mask`.
  pub async fn search_entities(&self, entity_type: &str, name_mask: &str) -> Result<Vec<EntitySearchResult>> {
    #[derive(Deserialize)]
    struct Row {
      #[serde(default)]
      name: String,
      description: Option<String>,
    }
    let what = "GetEntityList";
    let mask = if name_mask.is_empty() { "*" } else { name_mask };
    let body = json!({ "type": entity_type_of(entity_type), "nameMask": mask });
    let res = self.post_json("/Resources/EntityServices/Services/GetEntityList", &body, what).await?;
    let rows = Self::read_json::<Rows<Row>>(res, what).await?.rows;
    Ok(rows.into_iter().map(|r| EntitySearchResult { name: r.name, description: r.description }).collect())
  }

  /// Every service an entity has, its own and inherited, in ThingWorx's order.
  pub async fn service_definitions(&self, collection: &str, entity: &str) -> Result<Vec<ServiceDef>> {
    let what = format!("GetEntity {collection}/{entity}");
    let url = format!("{}/{collection}/{}", self.base, encode(entity));
    let res = self.send(self.request(Method::GET, &url, "application/json"), &what).await?;
    let text = res.text().await.map_err(|e| CoreError::Twx { status: 0, message: format!("{what} failed — {e}") })?;
    service_defs(&text, &what)
  }

  /// Property definitions of an entity, its own and inherited: singl-web's
  /// `getPropertyDefinitions` mapping over a GetEntity reply.
  pub async fn property_definitions(&self, collection: &str, entity: &str) -> Result<Vec<PropertyDef>> {
    let what = format!("GetEntity {collection}/{entity}");
    let url = format!("{}/{collection}/{}", self.base, encode(entity));
    let res = self.send(self.request(Method::GET, &url, "application/json"), &what).await?;
    let json: Value = Self::read_json(res, &what).await?;
    let defs = json.pointer("/effectiveShape/propertyDefinitions").and_then(Value::as_object);
    Ok(
      defs
        .into_iter()
        .flatten()
        .map(|(name, def)| PropertyDef {
          name: name.clone(),
          description: text_or(def.get("description"), ""),
          base_type: text_or(def.get("baseType"), "STRING"),
          aspects: object_or_empty(def.get("aspects")),
        })
        .collect(),
    )
  }

  /// Current values of every property on a Thing, as one row.
  pub async fn property_values(&self, thing: &str) -> Result<Value> {
    let what = format!("GetProperties {thing}");
    let url = format!("{}/Things/{}/Properties", self.base, encode(thing));
    let res = self.send(self.request(Method::GET, &url, "application/json"), &what).await?;
    let mut rows = Self::read_json::<Rows<Value>>(res, &what).await?.rows;
    Ok(if rows.is_empty() { json!({}) } else { rows.swap_remove(0) })
  }

  /// Current value of one property on a Thing; `null` when absent.
  pub async fn property_value(&self, thing: &str, property: &str) -> Result<Value> {
    let what = format!("GetProperty {thing}/{property}");
    let url = format!("{}/Things/{}/Properties/{}", self.base, encode(thing), encode(property));
    let res = self.send(self.request(Method::GET, &url, "application/json"), &what).await?;
    let rows = Self::read_json::<Rows<Value>>(res, &what).await?.rows;
    Ok(rows.first().and_then(|r| r.get(property)).cloned().unwrap_or(Value::Null))
  }

  /// Field definitions of a DataShape: the declared structure of an infotable.
  pub async fn datashape_fields(&self, name: &str) -> Result<Vec<DataShapeField>> {
    let what = format!("GetDataShape {name}");
    let url = format!("{}/DataShapes/{}", self.base, encode(name));
    let res = self.send(self.request(Method::GET, &url, "application/json"), &what).await?;
    let json: Value = Self::read_json(res, &what).await?;
    Ok(datashape_fields(&json))
  }

  /// Runs a service and returns its JSON reply as text, keys in the order
  /// ThingWorx sent them (infotable columns read in that order).
  pub async fn execute_service(&self, collection: &str, entity: &str, service: &str, inputs: &Value) -> Result<String> {
    let what = format!("{entity}.{service}");
    let path = format!("/{collection}/{}/Services/{}", encode(entity), encode(service));
    let res = self.post_json(&path, inputs, &what).await?;
    let text = res.text().await.map_err(|e| CoreError::Twx { status: 0, message: format!("{what} failed — {e}") })?;
    if text.trim().is_empty() {
      return Ok("null".into());
    }
    serde_json::from_str::<serde::de::IgnoredAny>(&text)
      .map_err(|e| CoreError::Twx { status: 0, message: format!("{what} failed — unexpected response: {e}") })?;
    Ok(text)
  }

  /// `PUT /Things/<thing>/Properties/*`: writes several property values at once.
  pub async fn set_property_values(&self, thing: &str, values: &Value) -> Result<()> {
    let what = format!("SetProperties {thing}");
    let url = format!("{}/Things/{}/Properties/*", self.base, encode(thing));
    self.send(self.request(Method::PUT, &url, "application/json").json(values), &what).await?;
    Ok(())
  }

  pub async fn delete_repository_file(&self, repository: &str, path: &str) -> Result<()> {
    self.repository_service(repository, "DeleteFile", json!({ "path": path })).await?;
    Ok(())
  }
}

/// Close to JavaScript's `localeCompare` (ICU root collation), which
/// singl-web sorted folder listings with: punctuation in CLDR order before
/// digits before letters, letters case-blind first and lowercase first on a tie.
fn locale_order(a: &str, b: &str) -> std::cmp::Ordering {
  const PUNCT: &str = "_-,;:!?.'\"()[]{}@*/\\&#%`^+<=>|~$";
  let primary = |s: &str| -> Vec<(u8, u32)> {
    s.chars()
      .map(|c| match c {
        c if c.is_alphabetic() => (3, c.to_lowercase().next().unwrap_or(c) as u32),
        c if c.is_ascii_digit() => (2, c as u32),
        c => (1, PUNCT.find(c).map_or(1000 + c as u32, |i| i as u32)),
      })
      .collect()
  };
  let tertiary = |s: &str| -> Vec<bool> { s.chars().map(char::is_uppercase).collect() };
  primary(a).cmp(&primary(b)).then_with(|| tertiary(a).cmp(&tertiary(b)))
}

/// reqwest's own text is "error sending request for url (…)"; the cause is further down.
fn connect_error(err: &reqwest::Error) -> String {
  let mut source: Option<&dyn std::error::Error> = Some(err);
  let mut deepest = err.to_string();
  while let Some(e) = source {
    deepest = e.to_string();
    source = e.source();
  }
  if err.is_timeout() { "the server took too long to answer".into() } else { deepest }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn encodes_like_encode_uri_component() {
    assert_eq!(encode("ITCI.CHB Utils/x"), "ITCI.CHB%20Utils%2Fx");
    assert_eq!(encode("é"), "%C3%A9");
  }

  #[test]
  fn keeps_service_order_and_sorts_parameters() {
    let body = r#"{"effectiveShape":{"serviceDefinitions":{
      "Zeta":{"description":"z","category":"C","parameterDefinitions":{"a":{"name":"a","baseType":"NUMBER","ordinal":2},"b":{"name":"b","ordinal":1,"aspects":{"isRequired":true}}},"resultType":{"name":"result","baseType":"INFOTABLE","aspects":{"dataShape":"DS"}}},
      "Alpha":{}
    }}}"#;
    let defs = service_defs(body, "GetEntity").unwrap();
    assert_eq!(defs.iter().map(|d| d.name.as_str()).collect::<Vec<_>>(), ["Zeta", "Alpha"]);
    let zeta = &defs[0];
    assert_eq!(zeta.parameter_definitions[0].name, "b");
    assert_eq!(zeta.parameter_definitions[0].base_type, "STRING");
    assert_eq!(zeta.parameter_definitions[0].aspects, json!({ "isRequired": true }));
    assert_eq!(zeta.result_type.aspects, json!({ "dataShape": "DS" }));
    assert_eq!(defs[1].result_type.base_type, "NOTHING");
    assert_eq!(defs[1].result_type.name, "result");
    assert!(service_defs("{}", "GetEntity").unwrap().is_empty());
  }

  #[test]
  fn maps_collections_back_to_types() {
    assert_eq!(entity_type_of("Things"), "Thing");
    assert_eq!(entity_type_of("ThingTemplate"), "ThingTemplate");
  }

  #[test]
  fn digs_out_the_cause() {
    assert_eq!(twx_detail(r#"{"errorMsg":"  Thing  [X] not found "}"#), "Thing [X] not found");
    assert_eq!(
      twx_detail("<html><head><title>T</title></head><body><h1>HTTP 500</h1><pre>java.lang.Exception: bad &amp; worse</pre></body></html>"),
      "java.lang.Exception: bad & worse"
    );
    assert_eq!(twx_detail("plain\n text"), "plain text");
    assert!(twx_detail(&"x ".repeat(700)).ends_with('…'));
  }
}
