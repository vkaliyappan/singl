//! `twx-mcp`: a Model Context Protocol server over stdio exposing read and
//! invoke tools for ThingWorx. Replaces singl-web's TypeScript `mcp.ts` /
//! `lib/twx/mcp-tools.ts`, on top of singl-core's [`Client`].
//!
//! Connections:
//! - no `env` argument: `TWX_BASE_URL` / `TWX_APP_KEY` from the process
//!   environment, else from `.env.local` / `.env` in the working directory
//!   or, failing that, the nearest ancestor of the executable;
//! - `env: "<name>"`: that environment from the singl app database, opened
//!   read-only. The database is `--db <path>`, else `SINGL_DB`, else the
//!   installed app's `%APPDATA%\com.singl.app\singl.db`.
//!
//! Transport is newline-delimited JSON-RPC 2.0 on stdin/stdout; logs go to stderr.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use serde_json::{Value, json};
use singl_core::twx::api::{Client, collection_name};
use singl_core::twx::projects;
use singl_core::{CoreError, Result};
use sqlx::SqlitePool;
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::{OnceCell, mpsc};

const SERVER_NAME: &str = "twx";
const LATEST_PROTOCOL: &str = "2025-06-18";
const SUPPORTED_PROTOCOLS: &[&str] = &["2025-06-18", "2025-03-26", "2024-11-05"];

struct Server {
  dotenv: HashMap<String, String>,
  db_path: PathBuf,
  pool: OnceCell<SqlitePool>,
}

#[tokio::main]
async fn main() {
  let server = Arc::new(Server { dotenv: load_dotenv(), db_path: db_path(), pool: OnceCell::new() });

  let (tx, mut rx) = mpsc::unbounded_channel::<Value>();
  let writer = tokio::spawn(async move {
    let mut out = tokio::io::stdout();
    while let Some(msg) = rx.recv().await {
      let mut line = msg.to_string();
      line.push('\n');
      if out.write_all(line.as_bytes()).await.is_err() || out.flush().await.is_err() {
        break;
      }
    }
  });

  let mut lines = BufReader::new(tokio::io::stdin()).lines();
  while let Ok(Some(line)) = lines.next_line().await {
    if line.trim().is_empty() {
      continue;
    }
    let msg: Value = match serde_json::from_str(&line) {
      Ok(v) => v,
      Err(e) => {
        let _ = tx.send(error_response(Value::Null, -32700, &format!("Parse error: {e}")));
        continue;
      }
    };
    // Batches were dropped from the spec in 2025-06-18 but cost little to accept.
    let messages = match msg {
      Value::Array(items) => items,
      one => vec![one],
    };
    for msg in messages {
      let (server, tx) = (server.clone(), tx.clone());
      tokio::spawn(async move {
        if let Some(reply) = server.handle(msg).await {
          let _ = tx.send(reply);
        }
      });
    }
  }
  drop(tx);
  // Let in-flight calls finish answering before exit.
  let _ = tokio::time::timeout(Duration::from_secs(30), writer).await;
}

impl Server {
  /// One JSON-RPC message in, at most one reply out (notifications get none).
  async fn handle(&self, msg: Value) -> Option<Value> {
    let id = msg.get("id").cloned();
    let method = msg.get("method").and_then(Value::as_str).unwrap_or_default();
    let params = msg.get("params").cloned().unwrap_or(Value::Null);

    // A reply to something we never send, or a notification: nothing to say.
    let id = match id {
      Some(id) if !method.is_empty() => id,
      _ => return None,
    };

    let result = match method {
      "initialize" => {
        let asked = params.get("protocolVersion").and_then(Value::as_str).unwrap_or(LATEST_PROTOCOL);
        let version = if SUPPORTED_PROTOCOLS.contains(&asked) { asked } else { LATEST_PROTOCOL };
        json!({
          "protocolVersion": version,
          "capabilities": { "tools": {} },
          "serverInfo": { "name": SERVER_NAME, "version": env!("CARGO_PKG_VERSION") },
        })
      }
      "ping" => json!({}),
      "tools/list" => json!({ "tools": tool_list() }),
      "tools/call" => {
        let name = params.get("name").and_then(Value::as_str).unwrap_or_default();
        let args = params.get("arguments").cloned().unwrap_or_else(|| json!({}));
        if !tool_list().iter().any(|t| t["name"] == name) {
          return Some(error_response(id, -32602, &format!("Unknown tool: {name}")));
        }
        match self.call(name, &args).await {
          Ok(text) => json!({ "content": [{ "type": "text", "text": text }] }),
          Err(e) => json!({ "content": [{ "type": "text", "text": e.to_string() }], "isError": true }),
        }
      }
      other => return Some(error_response(id, -32601, &format!("Method not found: {other}"))),
    };
    Some(json!({ "jsonrpc": "2.0", "id": id, "result": result }))
  }

  async fn call(&self, name: &str, args: &Value) -> Result<String> {
    let s = |key: &str| args.get(key).and_then(Value::as_str).filter(|v| !v.is_empty());
    let need = |key: &str| s(key).ok_or_else(|| CoreError::Invalid(format!("Missing required argument \"{key}\".")));
    let pretty = |v: &Value| serde_json::to_string_pretty(v).unwrap_or_default();

    if name == "twx_list_environments" {
      return Ok(pretty(&self.list_environments().await?));
    }

    let client = self.client(s("env")).await?;
    match name {
      "twx_list_entities" => ser(&client.search_entities(need("type")?, s("nameMask").unwrap_or("*")).await?),
      "twx_list_things" => ser(&client.search_entities("Things", s("nameMask").unwrap_or("*")).await?),
      "twx_list_projects" => ser(&client.all_projects().await?),
      "twx_list_project_entities" => ser(&client.project_entities(need("projectName")?).await?),
      "twx_list_services" => {
        ser(&client.service_definitions(collection_name(need("type")?), need("entityName")?).await?)
      }
      "twx_list_properties" => {
        ser(&client.property_definitions(collection_name(need("type")?), need("entityName")?).await?)
      }
      "twx_get_property_value" => {
        Ok(pretty(&client.property_value(need("entityName")?, need("propertyName")?).await?))
      }
      "twx_get_all_property_values" => Ok(pretty(&client.property_values(need("entityName")?).await?)),
      "twx_invoke_service" => {
        let inputs = match args.get("inputs") {
          None | Some(Value::Null) => json!({}),
          Some(v @ Value::Object(_)) => v.clone(),
          Some(_) => return Err(CoreError::Invalid("\"inputs\" must be an object.".into())),
        };
        // Raw text keeps the key order ThingWorx sent (infotable columns).
        client.execute_service(collection_name(need("type")?), need("entityName")?, need("serviceName")?, &inputs).await
      }
      "twx_export_entity" => client.export_entity(need("type")?, need("entityName")?).await,
      other => Err(CoreError::Invalid(format!("Unknown tool: {other}"))),
    }
  }

  fn var(&self, key: &str) -> Option<String> {
    std::env::var(key).ok().or_else(|| self.dotenv.get(key).cloned()).filter(|v| !v.trim().is_empty())
  }

  async fn client(&self, env: Option<&str>) -> Result<Client> {
    match env {
      Some(env) => projects::connect(self.pool().await?, env).await,
      None => match (self.var("TWX_BASE_URL"), self.var("TWX_APP_KEY")) {
        (Some(base), Some(key)) => Ok(Client::new(&base, &key)),
        _ => Err(CoreError::Invalid(
          "TWX_BASE_URL or TWX_APP_KEY is not set. Pass env to use an environment from the singl app database, \
           or set the vars in .env.local"
            .into(),
        )),
      },
    }
  }

  /// The singl database, read-only: this server never migrates or writes it.
  async fn pool(&self) -> Result<&SqlitePool> {
    self
      .pool
      .get_or_try_init(|| async {
        if !self.db_path.exists() {
          return Err(CoreError::NotFound(format!(
            "singl database not found at {}. Pass --db or set SINGL_DB.",
            self.db_path.display()
          )));
        }
        let options = SqliteConnectOptions::new()
          .filename(&self.db_path)
          .read_only(true)
          .busy_timeout(Duration::from_secs(5));
        Ok(SqlitePoolOptions::new().max_connections(2).connect_with(options).await?)
      })
      .await
  }

  async fn list_environments(&self) -> Result<Value> {
    let mut out = Vec::new();
    if let Some(base) = self.var("TWX_BASE_URL") {
      out.push(json!({ "environment": null, "source": ".env.local (omit env)", "twxBaseUrl": base }));
    }
    match self.pool().await {
      Ok(pool) => {
        let rows: Vec<(String, String)> = sqlx::query_as(
          "SELECT environment, twxBaseUrl FROM environment_settings WHERE enabled = 1 ORDER BY id",
        )
        .fetch_all(pool)
        .await?;
        out.extend(rows.into_iter().map(|(env, base)| json!({ "environment": env, "source": "singl database", "twxBaseUrl": base })));
      }
      Err(e) if out.is_empty() => return Err(e),
      Err(e) => eprintln!("twx-mcp: {e}"),
    }
    Ok(Value::Array(out))
  }
}

/// Pretty JSON for any serializable result.
fn ser<T: serde::Serialize>(v: &T) -> Result<String> {
  serde_json::to_string_pretty(v).map_err(|e| CoreError::Invalid(e.to_string()))
}

fn error_response(id: Value, code: i64, message: &str) -> Value {
  json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

fn tool_list() -> Vec<Value> {
  let env = json!({ "type": "string", "description": "Environment name from the singl app Settings page. Omit to use TWX_BASE_URL/TWX_APP_KEY from .env.local." });
  let ty = json!({ "type": "string", "description": "ThingWorx entity type or collection name, e.g. \"Thing\", \"ThingTemplate\", \"Things\"." });
  let mask = json!({ "type": "string", "description": "Name filter, supports * wildcard. Defaults to \"*\"." });
  let s = json!({ "type": "string" });
  let schema = |props: Value, required: &[&str]| json!({ "type": "object", "properties": props, "required": required });
  let tool = |name: &str, description: &str, input: Value| json!({ "name": name, "description": description, "inputSchema": input });

  vec![
    tool(
      "twx_list_environments",
      "List ThingWorx connections: the .env.local one (used when env is omitted) and the enabled environments in the singl app database.",
      schema(json!({}), &[]),
    ),
    tool(
      "twx_list_entities",
      "Search ThingWorx entities of a given type by name mask (e.g. Things, ThingTemplates, DataShapes).",
      schema(json!({ "env": env, "type": ty, "nameMask": mask }), &["type"]),
    ),
    tool(
      "twx_list_things",
      "List ThingWorx Things by name mask. Convenience wrapper over twx_list_entities for type=Things.",
      schema(json!({ "env": env, "nameMask": mask }), &[]),
    ),
    tool("twx_list_projects", "List all ThingWorx projects.", schema(json!({ "env": env }), &[])),
    tool(
      "twx_list_project_entities",
      "List all entities belonging to a ThingWorx project.",
      schema(json!({ "env": env, "projectName": s }), &["projectName"]),
    ),
    tool(
      "twx_list_services",
      "List service definitions (name, parameters, result type) for a ThingWorx entity, e.g. a Thing or ThingTemplate.",
      schema(json!({ "env": env, "type": ty, "entityName": s }), &["type", "entityName"]),
    ),
    tool(
      "twx_list_properties",
      "List property definitions (name, baseType, aspects) for a ThingWorx entity, e.g. a Thing or ThingTemplate.",
      schema(json!({ "env": env, "type": ty, "entityName": s }), &["type", "entityName"]),
    ),
    tool(
      "twx_get_property_value",
      "Get the current value of a single property on a ThingWorx Thing.",
      schema(json!({ "env": env, "entityName": s, "propertyName": s }), &["entityName", "propertyName"]),
    ),
    tool(
      "twx_get_all_property_values",
      "Get current values of all properties on a ThingWorx Thing.",
      schema(json!({ "env": env, "entityName": s }), &["entityName"]),
    ),
    tool(
      "twx_invoke_service",
      "Invoke a service on a ThingWorx entity with the given inputs. May have side effects depending on the service.",
      schema(
        json!({
          "env": env, "type": ty, "entityName": s, "serviceName": s,
          "inputs": { "type": "object", "additionalProperties": {}, "description": "Service input parameters as key/value pairs." },
        }),
        &["type", "entityName", "serviceName"],
      ),
    ),
    tool(
      "twx_export_entity",
      "Export a ThingWorx entity definition as XML.",
      schema(json!({ "env": env, "type": ty, "entityName": s }), &["type", "entityName"]),
    ),
  ]
}

/// `--db <path>`, else `SINGL_DB`, else the installed app's database.
fn db_path() -> PathBuf {
  let mut args = std::env::args().skip(1);
  while let Some(arg) = args.next() {
    if arg == "--db" {
      if let Some(path) = args.next() {
        return PathBuf::from(path);
      }
    } else if let Some(path) = arg.strip_prefix("--db=") {
      return PathBuf::from(path);
    }
  }
  if let Ok(path) = std::env::var("SINGL_DB") {
    if !path.trim().is_empty() {
      return PathBuf::from(path);
    }
  }
  let base = std::env::var("APPDATA").map(PathBuf::from).unwrap_or_else(|_| std::env::temp_dir());
  base.join("com.singl.app").join("singl.db")
}

/// The folder holding `.env.local`: the working directory, else the nearest
/// ancestor of this executable (it builds to `<repo>/src-tauri/target/debug`),
/// so clients that launch it from elsewhere still find the repo's settings.
fn dotenv_dir() -> PathBuf {
  let cwd = std::env::current_dir().unwrap_or_default();
  if cwd.join(".env.local").exists() || cwd.join(".env").exists() {
    return cwd;
  }
  std::env::current_exe()
    .ok()
    .and_then(|exe| exe.ancestors().skip(1).find(|d| d.join(".env.local").exists()).map(Path::to_path_buf))
    .unwrap_or(cwd)
}

/// `.env.local` then `.env` (see [`dotenv_dir`]); the first file to set a key wins.
fn load_dotenv() -> HashMap<String, String> {
  let mut vars = HashMap::new();
  let dir = dotenv_dir();
  for file in [".env.local", ".env"] {
    let Ok(text) = std::fs::read_to_string(dir.join(file)) else { continue };
    for line in text.lines() {
      let line = line.trim();
      if line.is_empty() || line.starts_with('#') {
        continue;
      }
      let line = line.strip_prefix("export ").unwrap_or(line);
      let Some((key, value)) = line.split_once('=') else { continue };
      let value = value.trim();
      let value = match value.as_bytes() {
        [q @ (b'"' | b'\''), .., last] if last == q && value.len() >= 2 => &value[1..value.len() - 1],
        _ => value.split(" #").next().unwrap_or(value).trim(),
      };
      vars.entry(key.trim().to_string()).or_insert_with(|| value.to_string());
    }
  }
  vars
}
