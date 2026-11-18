//! Read-only server administration: health of a ThingWorx server (platform
//! stats, subsystems, extensions, counts) and queries over Streams and Value
//! Streams. Nothing here changes server state.

use std::collections::HashMap;
use std::future::Future;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde_json::{Value, json};

use super::api::Client;
use crate::{CoreError, Result};

/// One call may not hold the whole page up.
const CALL_TIMEOUT: Duration = Duration::from_secs(20);
const PING_TIMEOUT: Duration = Duration::from_secs(10);
const DEFAULT_ITEMS: u32 = 100;
const MAX_ITEMS: u32 = 5000;

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Platform {
  pub software_version: Option<String>,
  /// The part of the version after the dash, e.g. `b195`.
  pub build: Option<String>,
  pub schema_version: Option<String>,
  /// Epoch ms.
  pub start_time: Option<f64>,
  pub uptime_ms: Option<f64>,
  pub run_time: Option<String>,
  pub memory_used: Option<f64>,
  /// Memory the application server has allocated (the heap's current size).
  pub memory_total: Option<f64>,
  pub event_queue: Option<f64>,
  pub stream_queue: Option<f64>,
  pub value_stream_queue: Option<f64>,
  pub named_users: Option<f64>,
  pub license_evaluation: Option<bool>,
  /// Days until the license expires, when the server says.
  pub license_days_left: Option<f64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubsystemStatus {
  pub name: String,
  pub description: String,
  /// `RUNNING`, `STOPPED`, ..., or `UNKNOWN` when the state could not be read.
  pub state: String,
  pub running: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Extension {
  pub name: String,
  pub version: String,
  pub vendor: String,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Counts {
  pub things: Option<u64>,
  pub thing_templates: Option<u64>,
  pub thing_shapes: Option<u64>,
  pub projects: Option<u64>,
  pub mashups: Option<u64>,
  pub data_shapes: Option<u64>,
  pub extension_packages: Option<u64>,
  /// Remote things bound to a connector.
  pub bound_things: Option<u64>,
  pub connected_things: Option<u64>,
}

/// Every section is optional so one failing call does not blank the page;
/// `errors` says which sections are missing and why.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerHealth {
  pub platform: Option<Platform>,
  pub subsystems: Option<Vec<SubsystemStatus>>,
  pub extensions: Option<Vec<Extension>>,
  pub counts: Option<Counts>,
  pub errors: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Ping {
  pub ok: bool,
  pub latency_ms: u64,
  pub version: Option<String>,
  pub memory_used: Option<f64>,
  pub memory_total: Option<f64>,
  pub error: Option<String>,
}

async fn timed<T>(what: &str, limit: Duration, fut: impl Future<Output = Result<T>>) -> Result<T> {
  tokio::time::timeout(limit, fut)
    .await
    .unwrap_or_else(|_| Err(CoreError::Twx { status: 0, message: format!("{what} timed out after {}s", limit.as_secs()) }))
}

/// A service call whose reply is an infotable: its rows.
async fn call_rows(c: &Client, collection: &str, entity: &str, service: &str, inputs: Value) -> Result<Vec<Value>> {
  let text = timed(service, CALL_TIMEOUT, c.execute_service(collection, entity, service, &inputs)).await?;
  Ok(rows_of(&text))
}

/// `rows` of an infotable reply; a bare array or an empty reply reads as rows too.
fn rows_of(text: &str) -> Vec<Value> {
  match serde_json::from_str::<Value>(text) {
    Ok(Value::Object(mut o)) => match o.remove("rows") {
      Some(Value::Array(rows)) => rows,
      _ => Vec::new(),
    },
    Ok(Value::Array(rows)) => rows,
    _ => Vec::new(),
  }
}

fn num(v: &Value, key: &str) -> Option<f64> {
  v.get(key).and_then(Value::as_f64)
}

fn string(v: &Value, key: &str) -> Option<String> {
  v.get(key).and_then(Value::as_str).filter(|s| !s.is_empty()).map(String::from)
}

fn platform_from_stats(stats: &Value) -> Platform {
  let version = string(stats, "thingworxSoftwareVersion");
  let build = version.as_deref().and_then(|v| v.split_once('-')).map(|(_, b)| b.to_string());
  Platform {
    software_version: version.map(|v| v.split('-').next().unwrap_or(&v).to_string()),
    build,
    schema_version: string(stats, "thingworxSchemaVersion"),
    start_time: num(stats, "systemStartTime"),
    run_time: string(stats, "systemRunTime"),
    memory_used: num(stats, "memoryInUse"),
    memory_total: num(stats, "totalMemoryAllocated"),
    event_queue: num(stats, "eventQueueSize"),
    stream_queue: num(stats, "streamQueueSize"),
    value_stream_queue: num(stats, "valueStreamQueueSize"),
    named_users: num(stats, "namedUserCount"),
    ..Platform::default()
  }
}

/// One cheap call that tells whether the server answers, how fast, and its
/// version and memory. Never fails: a failure is the `ok: false` answer.
pub async fn ping(c: &Client) -> Ping {
  let started = Instant::now();
  let reply = call_rows_with(c, PING_TIMEOUT, "PlatformSubsystem", "GetPlatformStats").await;
  let latency_ms = started.elapsed().as_millis() as u64;
  match reply {
    Ok(rows) => {
      let p = rows.first().map(platform_from_stats).unwrap_or_default();
      Ping { ok: true, latency_ms, version: p.software_version, memory_used: p.memory_used, memory_total: p.memory_total, error: None }
    }
    Err(e) => Ping { ok: false, latency_ms, error: Some(e.to_string()), ..Ping::default() },
  }
}

async fn call_rows_with(c: &Client, limit: Duration, subsystem: &str, service: &str) -> Result<Vec<Value>> {
  let text = timed(service, limit, c.execute_service("Subsystems", subsystem, service, &json!({}))).await?;
  Ok(rows_of(&text))
}

async fn platform(c: &Client) -> Result<Platform> {
  let (stats, metrics, license) = tokio::join!(
    call_rows(c, "Subsystems", "PlatformSubsystem", "GetPlatformStats", json!({})),
    call_rows(c, "Subsystems", "PlatformSubsystem", "GetPerformanceMetrics", json!({})),
    call_rows(c, "Subsystems", "PlatformSubsystem", "GetLicenseState", json!({})),
  );
  let mut p = platform_from_stats(stats?.first().unwrap_or(&Value::Null));
  // The extras are nice to have; the stats are the section.
  for row in metrics.unwrap_or_default() {
    if row.get("name").and_then(Value::as_str) == Some("systemUpTime") {
      p.uptime_ms = num(&row, "value");
    }
  }
  if let Some(row) = license.unwrap_or_default().first() {
    p.license_evaluation = row.get("evaluation").and_then(Value::as_bool);
    p.license_days_left = num(row, "expiration").filter(|d| *d >= 0.0);
  }
  Ok(p)
}

async fn subsystems(c: &Client) -> Result<Vec<SubsystemStatus>> {
  let list = call_rows(c, "Resources", "EntityServices", "GetEntityList", json!({ "type": "Subsystem", "nameMask": "*" })).await?;
  let mut tasks = tokio::task::JoinSet::new();
  for row in list {
    let Some(name) = string(&row, "name") else { continue };
    let description = string(&row, "description").unwrap_or_default();
    let c = c.clone();
    tasks.spawn(async move {
      let state = call_rows(&c, "Subsystems", &name, "GetSubsystemState", json!({})).await;
      let state = state.ok().and_then(|r| r.first().and_then(|r| string(r, "result"))).unwrap_or_else(|| "UNKNOWN".into());
      SubsystemStatus { running: state == "RUNNING", state, name, description }
    });
  }
  let mut out = Vec::new();
  while let Some(done) = tasks.join_next().await {
    out.extend(done.ok());
  }
  out.sort_by(|a, b| a.name.cmp(&b.name));
  Ok(out)
}

async fn extensions(c: &Client) -> Result<Vec<Extension>> {
  let rows = call_rows(c, "Subsystems", "PlatformSubsystem", "GetExtensionPackageList", json!({})).await?;
  let mut out: Vec<Extension> = rows
    .iter()
    .map(|r| Extension {
      name: string(r, "name").unwrap_or_default(),
      version: string(r, "packageVersion").unwrap_or_default(),
      vendor: string(r, "vendor").unwrap_or_default(),
    })
    .collect();
  out.sort_by_key(|e| e.name.to_lowercase());
  Ok(out)
}

async fn counts(c: &Client) -> Result<Counts> {
  let (entities, bound) = tokio::join!(
    call_rows(c, "Subsystems", "PlatformSubsystem", "GetEntityCount", json!({})),
    call_rows(c, "Resources", "DeviceFunctions", "GetBoundRemoteThings", json!({})),
  );
  let by_name: HashMap<String, u64> = entities?
    .iter()
    .filter_map(|r| Some((string(r, "name")?, r.get("count")?.as_u64()?)))
    .collect();
  let get = |k: &str| by_name.get(k).copied();
  let mut out = Counts {
    things: get("Things"),
    thing_templates: get("ThingTemplates"),
    thing_shapes: get("ThingShapes"),
    projects: get("Projects"),
    mashups: get("Mashups"),
    data_shapes: get("DataShapes"),
    extension_packages: get("ExtensionPackages"),
    ..Counts::default()
  };
  // Not every server lets the key read bindings; the rest of the counts stand.
  if let Ok(bound) = bound {
    out.bound_things = Some(bound.len() as u64);
    out.connected_things = Some(bound.iter().filter(|r| r.get("isConnected").and_then(Value::as_bool) == Some(true)).count() as u64);
  }
  Ok(out)
}

fn keep<T>(section: &str, r: Result<T>, errors: &mut Vec<String>) -> Option<T> {
  r.map_err(|e| errors.push(format!("{section}: {e}"))).ok()
}

/// Health of the server, from several read-only calls made at once.
pub async fn health(c: &Client) -> ServerHealth {
  let (p, s, e, n) = tokio::join!(platform(c), subsystems(c), extensions(c), counts(c));
  let mut out = ServerHealth::default();
  out.platform = keep("Platform", p, &mut out.errors);
  out.subsystems = keep("Subsystems", s, &mut out.errors);
  out.extensions = keep("Extensions", e, &mut out.errors);
  out.counts = keep("Counts", n, &mut out.errors);
  out
}

// ---- Streams ------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamInfo {
  pub name: String,
  pub description: String,
  /// Shipped with the platform rather than built by someone.
  pub system: bool,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamList {
  pub streams: Vec<StreamInfo>,
  pub value_streams: Vec<StreamInfo>,
}

async fn implementing(c: &Client, template: &str) -> Result<Vec<StreamInfo>> {
  let rows = call_rows(c, "ThingTemplates", template, "GetImplementingThings", json!({})).await?;
  let mut out: Vec<StreamInfo> = rows
    .iter()
    .filter_map(|r| {
      Some(StreamInfo {
        name: string(r, "name")?,
        description: string(r, "description").unwrap_or_default(),
        system: r.get("isSystemObject").and_then(Value::as_bool).unwrap_or(false),
      })
    })
    .collect();
  out.sort_by_key(|s| (s.system, s.name.to_lowercase()));
  Ok(out)
}

/// The Streams and Value Streams on the server.
pub async fn list_streams(c: &Client) -> Result<StreamList> {
  let (streams, value_streams) = tokio::join!(implementing(c, "Stream"), implementing(c, "ValueStream"));
  Ok(StreamList { streams: streams?, value_streams: value_streams? })
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoggedProperty {
  pub name: String,
  pub base_type: String,
}

/// Properties of a Thing that are logged to a Value Stream.
pub async fn logged_properties(c: &Client, thing: &str) -> Result<Vec<LoggedProperty>> {
  let defs = c.property_definitions("Things", thing).await?;
  let mut out: Vec<LoggedProperty> = defs
    .into_iter()
    .filter(|d| d.aspects.get("isLogged").and_then(Value::as_bool) == Some(true))
    .map(|d| LoggedProperty { name: d.name, base_type: d.base_type })
    .collect();
  out.sort_by_key(|p| p.name.to_lowercase());
  Ok(out)
}

#[derive(Debug, Clone, Default, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct StreamQuery {
  /// A Stream: its entries are read.
  pub stream: Option<String>,
  /// A Thing and one of its logged properties: the Value Stream history is read.
  pub thing: Option<String>,
  pub property: Option<String>,
  /// ISO 8601, epoch ms, or relative like `24h`, `7d`, `30m` (back from now).
  pub since: Option<String>,
  pub until: Option<String>,
  pub max_items: Option<u32>,
  pub oldest_first: Option<bool>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Column {
  pub name: String,
  pub base_type: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryResult {
  /// What was read, e.g. `Stream MyStream` or `Thing.Property`.
  pub source: String,
  pub columns: Vec<Column>,
  pub rows: Vec<Value>,
  /// The server returned as many rows as asked for, so there may be more.
  pub maybe_more: bool,
}

/// A date for ThingWorx: relative (`24h`) becomes epoch ms, digits stay a
/// number, anything else (ISO 8601) is passed as the text it is.
fn time_arg(text: &str, now_ms: i64) -> Value {
  let t = text.trim();
  if let Ok(ms) = t.parse::<i64>() {
    return json!(ms);
  }
  if let Some(unit) = t.chars().last()
    && let Ok(n) = t[..t.len() - unit.len_utf8()].parse::<i64>()
  {
    let per = match unit {
      's' => 1_000,
      'm' => 60_000,
      'h' => 3_600_000,
      'd' => 86_400_000,
      'w' => 604_800_000,
      _ => 0,
    };
    if per > 0 {
      return json!(now_ms - n * per);
    }
  }
  json!(t)
}

fn now_ms() -> i64 {
  SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

/// Column definitions of an infotable reply, `timestamp` first.
fn columns_of(reply: &Value) -> Vec<Column> {
  let mut cols: Vec<Column> = reply
    .pointer("/dataShape/fieldDefinitions")
    .and_then(Value::as_object)
    .map(|defs| {
      defs
        .iter()
        .map(|(k, d)| Column {
          name: d.get("name").and_then(Value::as_str).unwrap_or(k).to_string(),
          base_type: d.get("baseType").and_then(Value::as_str).unwrap_or("STRING").to_string(),
        })
        .collect()
    })
    .unwrap_or_default();
  cols.sort_by_key(|c| !matches!(c.name.as_str(), "timestamp" | "time"));
  cols
}

/// A stream entry's `data` is a one-row infotable; its fields become columns of the entry.
fn flatten_entry_data(rows: &mut [Value], cols: &mut Vec<Column>) {
  let mut extra: Vec<Column> = Vec::new();
  for row in rows.iter_mut() {
    let Some(obj) = row.as_object_mut() else { continue };
    let Some(Value::Object(data)) = obj.remove("data") else { continue };
    for def in columns_of(&Value::Object(data.clone())) {
      if !cols.iter().chain(&extra).any(|c| c.name == def.name) {
        extra.push(def);
      }
    }
    if let Some(Value::Object(first)) = data.get("rows").and_then(Value::as_array).and_then(|r| r.first()).cloned() {
      for (k, v) in first {
        obj.entry(k).or_insert(v);
      }
    }
  }
  cols.retain(|c| c.name != "data");
  cols.extend(extra);
}

/// Stream entries, or the history of one logged property, between two times.
pub async fn query_stream(c: &Client, q: &StreamQuery) -> Result<QueryResult> {
  let clean = |s: &Option<String>| s.as_deref().map(str::trim).filter(|s| !s.is_empty()).map(String::from);
  let max = q.max_items.unwrap_or(DEFAULT_ITEMS).clamp(1, MAX_ITEMS);
  let now = now_ms();
  let mut inputs = json!({ "maxItems": max, "oldestFirst": q.oldest_first.unwrap_or(false) });
  if let Some(s) = clean(&q.since) {
    inputs["startDate"] = time_arg(&s, now);
  }
  if let Some(s) = clean(&q.until) {
    inputs["endDate"] = time_arg(&s, now);
  }
  let (entity, service, source, is_stream) = match (clean(&q.stream), clean(&q.thing)) {
    (Some(stream), _) => (stream.clone(), "QueryStreamEntriesWithData", format!("Stream {stream}"), true),
    (None, Some(thing)) => {
      let property = clean(&q.property)
        .ok_or_else(|| CoreError::Invalid("Choose a property: the history of a Thing is read one property at a time.".into()))?;
      inputs["propertyName"] = json!(property);
      let source = format!("{thing}.{property}");
      (thing, "QueryNamedPropertyHistory", source, false)
    }
    (None, None) => return Err(CoreError::Invalid("Choose a stream, or a thing and a property.".into())),
  };
  let text = timed(service, CALL_TIMEOUT, c.execute_service("Things", &entity, service, &inputs)).await?;
  let reply: Value =
    serde_json::from_str(&text).map_err(|e| CoreError::Twx { status: 0, message: format!("{service} failed — unexpected response: {e}") })?;
  let mut cols = columns_of(&reply);
  let mut rows = rows_of(&text);
  if is_stream {
    flatten_entry_data(&mut rows, &mut cols);
  }
  let maybe_more = rows.len() >= max as usize;
  Ok(QueryResult { source, columns: cols, rows, maybe_more })
}

// ---- Integration connectors -------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Setting {
  pub name: String,
  pub value: String,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectorInfo {
  pub name: String,
  pub description: String,
  /// The Thing Template the connector is built on.
  pub template: Option<String>,
  /// `OData`, `Swagger`, or the template name.
  pub kind: String,
  pub enabled: Option<bool>,
  /// Base URL and relative path of the back end, when configured.
  pub base_url: Option<String>,
  pub auth_type: Option<String>,
  /// Connection settings that are not credentials.
  pub settings: Vec<Setting>,
  /// Why part of this row is missing.
  pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectorTest {
  /// `ok`, `failed` or `unknown` (the server answered with a status that is not recognised).
  pub state: String,
  pub status: Option<String>,
  pub message: Option<String>,
  pub latency_ms: u64,
}

/// Names that hold a credential; never shown, never sent to the assistant.
fn is_secret(name: &str) -> bool {
  let n = name.to_lowercase();
  ["password", "secret", "key", "token", "credential"].iter().any(|s| n.contains(s))
}

fn connector_kind(template: &str) -> String {
  let t = template.to_lowercase();
  if t.contains("odata") {
    "OData".into()
  } else if t.contains("swagger") {
    "Swagger".into()
  } else {
    template.to_string()
  }
}

/// Non-secret, non-empty fields of a configuration table row, as text.
fn settings_of(row: &Value) -> Vec<Setting> {
  let Some(obj) = row.as_object() else { return Vec::new() };
  obj
    .iter()
    .filter(|(k, _)| !is_secret(k))
    .filter_map(|(k, v)| {
      let value = match v {
        Value::String(s) => s.clone(),
        Value::Null => return None,
        other => other.to_string(),
      };
      (!value.is_empty()).then(|| Setting { name: k.clone(), value })
    })
    .collect()
}

/// The BaseURL and RelativeUrl joined without doubling the slash.
fn join_url(base: &str, relative: &str) -> String {
  format!("{}/{}", base.trim_end_matches('/'), relative.trim_start_matches('/')).trim_end_matches('/').to_string()
}

async fn connector(c: &Client, name: String, description: String) -> ConnectorInfo {
  let call = |service: &'static str, inputs: Value| call_rows(c, "Things", &name, service, inputs);
  let table = |t: &str| call("GetConfigurationTable", json!({ "tableName": t }));
  let (enabled, template, generic, http) = tokio::join!(
    call("IsEnabled", json!({})),
    call("GetThingTemplate", json!({})),
    table("GenericConnectorConnectionSettings"),
    table("HTTPConnectorConnectionSettings"),
  );
  let mut out = ConnectorInfo { name: name.clone(), description, ..ConnectorInfo::default() };
  out.enabled = enabled.as_ref().ok().and_then(|r| r.first()?.get("enabled")?.as_bool());
  out.template = template.as_ref().ok().and_then(|r| string(r.first()?, "name"));
  out.kind = out.template.as_deref().map(connector_kind).unwrap_or_default();
  let generic = generic.ok().and_then(|r| r.into_iter().next());
  let http = http.ok().and_then(|r| r.into_iter().next());
  out.auth_type = generic.as_ref().and_then(|r| string(r, "AuthenticationType"));
  out.base_url = http.as_ref().and_then(|r| Some(join_url(&string(r, "BaseURL")?, &string(r, "RelativeUrl").unwrap_or_default())));
  out.settings = generic.iter().chain(&http).flat_map(settings_of).collect();
  if let Err(e) = enabled.and(template) {
    out.error = Some(e.to_string());
  }
  out
}

/// Integration connectors (Things built on the Generic Connector: OData,
/// Swagger/Windchill, SAP ...) with their configured endpoint. The platform
/// keeps no connected flag for these, so the state is not read here; see
/// [`test_connector`]. Read-only.
pub async fn list_connectors(c: &Client) -> Result<Vec<ConnectorInfo>> {
  let rows = call_rows(c, "ThingTemplates", "GenericConnector", "GetImplementingThings", json!({})).await?;
  let mut tasks = tokio::task::JoinSet::new();
  for row in rows {
    let Some(name) = string(&row, "name") else { continue };
    let description = string(&row, "description").unwrap_or_default();
    let c = c.clone();
    tasks.spawn(async move { connector(&c, name, description).await });
  }
  let mut out = Vec::new();
  while let Some(done) = tasks.join_next().await {
    out.extend(done.ok());
  }
  out.sort_by_key(|i| i.name.to_lowercase());
  Ok(out)
}

fn test_state(status: &str) -> &'static str {
  let s = status.to_lowercase();
  let has = |words: &[&str]| words.iter().any(|w| s.contains(w));
  if has(&["fail", "error", "down", "unreach", "invalid", "refus", "timeout", "denied", "disconnect", "not "]) {
    "failed"
  } else if has(&["ok", "success", "connect", "up", "valid", "active", "true"]) {
    "ok"
  } else {
    "unknown"
  }
}

/// Runs the connector's own `ValidateConnection` service. The platform does not
/// document whether it is free of side effects, so this runs only when asked.
pub async fn test_connector(c: &Client, thing: &str) -> ConnectorTest {
  let started = Instant::now();
  let reply = call_rows(c, "Things", thing, "ValidateConnection", json!({})).await;
  let latency_ms = started.elapsed().as_millis() as u64;
  match reply {
    Ok(rows) => {
      let row = rows.first().cloned().unwrap_or(Value::Null);
      let status = string(&row, "Status");
      let state = test_state(status.as_deref().unwrap_or("")).to_string();
      ConnectorTest { state, status, message: string(&row, "Message"), latency_ms }
    }
    Err(e) => ConnectorTest { state: "failed".into(), status: None, message: Some(e.to_string()), latency_ms },
  }
}

// ---- Data tables ------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DataTableInfo {
  pub data_shape: Option<String>,
  pub entry_count: Option<u64>,
  pub fields: Vec<Column>,
}

/// The DataTables on the server.
pub async fn list_datatables(c: &Client) -> Result<Vec<StreamInfo>> {
  implementing(c, "DataTable").await
}

/// Data shape, entry count and fields of one DataTable.
pub async fn datatable_info(c: &Client, table: &str) -> Result<DataTableInfo> {
  let (shape, count) = tokio::join!(
    call_rows(c, "Things", table, "GetDataShape", json!({})),
    call_rows(c, "Things", table, "GetDataTableEntryCount", json!({})),
  );
  let data_shape = shape?.first().and_then(|r| string(r, "result"));
  let entry_count = count.ok().and_then(|r| r.first()?.get("result")?.as_u64());
  let fields = match &data_shape {
    Some(name) => c.datashape_fields(name).await?.into_iter().map(|f| Column { name: f.name, base_type: f.base_type }).collect(),
    None => Vec::new(),
  };
  Ok(DataTableInfo { data_shape, entry_count, fields })
}

#[derive(Debug, Clone, Default, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct DataTableQuery {
  pub table: String,
  /// Text to look for in the entries. Plain words match as `*text*`; a ThingWorx
  /// search expression (wildcards, `field:value`, quotes) is passed as written.
  pub search: Option<String>,
  /// A ThingWorx query as JSON text, e.g. `{"filters":{"type":"EQ","fieldName":"a","value":1}}`.
  pub query: Option<String>,
  pub max_items: Option<u32>,
}

/// Plain text becomes a contains-search; an expression is left alone.
fn search_expression(text: &str) -> String {
  let t = text.trim();
  if t.chars().any(|c| matches!(c, '*' | '?' | ':' | '"' | '(' | ')')) { t.to_string() } else { format!("*{t}*") }
}

/// Entries of a DataTable: `SearchDataTableEntries` when there is search text,
/// else `QueryDataTableEntries`; both only read.
pub async fn query_datatable(c: &Client, q: &DataTableQuery) -> Result<QueryResult> {
  let table = q.table.trim();
  if table.is_empty() {
    return Err(CoreError::Invalid("Choose a data table.".into()));
  }
  let max = q.max_items.unwrap_or(DEFAULT_ITEMS).clamp(1, MAX_ITEMS);
  let mut inputs = json!({ "maxItems": max });
  if let Some(text) = q.query.as_deref().map(str::trim).filter(|t| !t.is_empty()) {
    inputs["query"] = serde_json::from_str(text).map_err(|e| CoreError::Invalid(format!("The query is not valid JSON: {e}")))?;
  }
  let service = match q.search.as_deref().map(str::trim).filter(|t| !t.is_empty()) {
    Some(text) => {
      inputs["searchExpression"] = json!(search_expression(text));
      "SearchDataTableEntries"
    }
    None => "QueryDataTableEntries",
  };
  let text = timed(service, CALL_TIMEOUT, c.execute_service("Things", table, service, &inputs)).await?;
  let reply: Value =
    serde_json::from_str(&text).map_err(|e| CoreError::Twx { status: 0, message: format!("{service} failed — unexpected response: {e}") })?;
  let columns = columns_of(&reply);
  let rows = rows_of(&text);
  let maybe_more = rows.len() >= max as usize;
  Ok(QueryResult { source: format!("DataTable {table}"), columns, rows, maybe_more })
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn relative_and_absolute_times() {
    assert_eq!(time_arg("24h", 100_000_000), json!(100_000_000 - 86_400_000));
    assert_eq!(time_arg("30m", 10_000_000), json!(10_000_000 - 1_800_000));
    assert_eq!(time_arg("1700000000000", 0), json!(1_700_000_000_000i64));
    assert_eq!(time_arg("2026-01-02T03:04:05Z", 0), json!("2026-01-02T03:04:05Z"));
    assert_eq!(time_arg("5x", 0), json!("5x"));
  }

  #[test]
  fn platform_splits_version_and_build() {
    let p = platform_from_stats(&json!({ "thingworxSoftwareVersion": "10.1.1-b195", "memoryInUse": 5.0 }));
    assert_eq!(p.software_version.as_deref(), Some("10.1.1"));
    assert_eq!(p.build.as_deref(), Some("b195"));
    assert_eq!(p.memory_used, Some(5.0));
  }

  #[test]
  fn entry_data_becomes_columns() {
    let mut rows = vec![json!({ "id": "a", "timestamp": 1, "data": { "dataShape": { "fieldDefinitions": { "temp": { "name": "temp", "baseType": "NUMBER" } } }, "rows": [{ "temp": 4.5 }] } })];
    let mut cols = vec![Column { name: "id".into(), base_type: "STRING".into() }, Column { name: "data".into(), base_type: "INFOTABLE".into() }];
    flatten_entry_data(&mut rows, &mut cols);
    assert_eq!(rows[0]["temp"], json!(4.5));
    assert!(rows[0].get("data").is_none());
    assert_eq!(cols.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(), ["id", "temp"]);
  }

  #[test]
  fn credentials_are_stripped() {
    let row = json!({ "BaseURL": "https://x", "AuthPassword": "pw", "ApiKey": "k", "clientSecret": "s", "AccessToken": "t", "Credentials": "c", "Empty": "", "Retries": 3 });
    let names: Vec<String> = settings_of(&row).into_iter().map(|s| s.name).collect();
    assert_eq!(names, ["BaseURL", "Retries"]);
  }

  #[test]
  fn urls_and_kinds() {
    assert_eq!(join_url("https://h/Windchill/oauth/", "/servlet/odata"), "https://h/Windchill/oauth/servlet/odata");
    assert_eq!(join_url("https://h", ""), "https://h");
    assert_eq!(connector_kind("PTC.WCODataConnectorThingTemplate"), "OData");
    assert_eq!(connector_kind("WindchillSwaggerConnector"), "Swagger");
    assert_eq!(connector_kind("GenericConnector"), "GenericConnector");
  }

  #[test]
  fn connection_test_states() {
    assert_eq!(test_state("OK"), "ok");
    assert_eq!(test_state("Connected"), "ok");
    assert_eq!(test_state("Disconnected"), "failed");
    assert_eq!(test_state("Failed"), "failed");
    assert_eq!(test_state("???"), "unknown");
  }

  #[test]
  fn search_text_becomes_a_contains_search() {
    assert_eq!(search_expression(" abc "), "*abc*");
    assert_eq!(search_expression("name:abc*"), "name:abc*");
  }
}
