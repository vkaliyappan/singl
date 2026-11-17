//! Assistant tools: flows. Service Flows, their folders, and running a flow.
//! Each tool calls the same singl-core function as `src-tauri/src/commands/flows.rs`.

use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, Mutex};

use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use super::{Args, Risk, Tool, schema, ser, tool, twx};
use crate::assistant::Assistant;
use crate::db::models::ServiceFlow;
use crate::db::{self, flows};
use crate::twx::api::{Client, ServiceDef};
use crate::twx::projects;
use crate::{CoreError, Result, agents, flow};

const GRAPH_DOC: &str = "A flow graph: {\"nodes\": [...], \"edges\": [...]}. Each node has id (unique string), kind, \
  label (unique, used by expressions), x, y, inputs (object of string values: literals or {{ expression }}). Kinds: \
  \"service\" (collection, entityName, serviceName; params and resultType are filled from the server on save), \"code\" (code: JS whose return value is the output), \
  \"if\" (condition), \"switch\" (rules), \"filter\" (mode, conditions), \"loop\" (batchSize), \"merge\" (mode), \
  \"compare\" (keyA, keyB), \"subflow\" (flowId), \"stop\" (message), \"wait\" (mode, waitMs or until), \"agent\" \
  (provider, prompt). Each edge: {id, source, target, sourcePort?} with node ids. flow_get shows a real example.";

/// The `graph` argument, parsed. Errors unless it has `nodes` and `edges` arrays.
fn graph_arg(args: &Value) -> Result<Option<Value>> {
  let graph = match args.get("graph") {
    None | Some(Value::Null) => return Ok(None),
    Some(Value::String(text)) => {
      serde_json::from_str(text).map_err(|e| CoreError::Invalid(format!("\"graph\" is not JSON: {e}")))?
    }
    Some(v) => v.clone(),
  };
  if !graph["nodes"].is_array() || !graph["edges"].is_array() {
    return Err(CoreError::Invalid("\"graph\" must have \"nodes\" and \"edges\" arrays.".into()));
  }
  Ok(Some(graph))
}

/// Fills each service node's `params` and `resultType` from the server, the way
/// the editor's palette does when a service is dropped on the canvas: the run
/// engine only sends inputs named in `params`, and the editor reads
/// `resultType`. Returns a note for each node it could not fill.
async fn fill_services(a: &Assistant, env: &str, graph: &mut Value) -> Vec<String> {
  let mut notes = Vec::new();
  let Some(nodes) = graph["nodes"].as_array_mut() else { return notes };
  let mut client: Option<Result<Client>> = None;
  let mut defs: HashMap<(String, String), std::result::Result<Vec<ServiceDef>, String>> = HashMap::new();
  for node in nodes.iter_mut() {
    if node["kind"].as_str().is_some_and(|k| k != "service") {
      continue;
    }
    let field = |k: &str| node[k].as_str().map(str::trim).filter(|v| !v.is_empty()).map(str::to_string);
    let label = field("label").or_else(|| field("id")).unwrap_or_default();
    let (Some(collection), Some(entity), Some(service)) = (field("collection"), field("entityName"), field("serviceName"))
    else {
      notes.push(format!("Node \"{label}\" needs collection, entityName and serviceName."));
      continue;
    };
    let key = (collection.clone(), entity.clone());
    if !defs.contains_key(&key) {
      if client.is_none() {
        client = Some(projects::connect(&a.pool().await, env).await);
      }
      let fetched = match client.as_ref() {
        Some(Ok(c)) => c.service_definitions(&collection, &entity).await.map_err(|e| e.to_string()),
        Some(Err(e)) => Err(e.to_string()),
        None => unreachable!(),
      };
      defs.insert(key.clone(), fetched);
    }
    match &defs[&key] {
      Ok(list) => match list.iter().find(|d| d.name == service) {
        Some(def) => {
          node["kind"] = json!("service");
          node["params"] = json!(def.parameter_definitions);
          node["resultType"] = json!(def.result_type);
        }
        None => notes.push(format!("Node \"{label}\": {entity} has no service {service} on {env}.")),
      },
      Err(e) => notes.push(format!("Node \"{label}\": could not read {entity}'s services on {env} ({e}).")),
    }
  }
  notes
}

/// "Saved." plus any nodes `fill_services` could not complete.
fn with_notes(done: Value, notes: Vec<String>) -> Result<String> {
  if notes.is_empty() {
    return match done {
      Value::String(text) => Ok(text),
      other => ser(&other),
    };
  }
  ser(&json!({ "result": done, "warnings": notes, "hint": "Those service nodes have no parameter list, so a run sends them no inputs. Fix the names and save again." }))
}

fn flow_json(f: &ServiceFlow) -> Value {
  let graph = serde_json::from_str::<Value>(&f.graph).unwrap_or_else(|_| Value::String(f.graph.clone()));
  json!({
    "id": f.id, "name": f.name, "environment": f.environment, "folderId": f.folder_id,
    "createdAt": f.created_at, "updatedAt": f.updated_at, "graph": graph,
  })
}

async fn existing(a: &Assistant, id: &str) -> Result<ServiceFlow> {
  flows::get(&a.pool().await, id).await?.ok_or_else(|| CoreError::NotFound(format!("No flow with id \"{id}\".")))
}

/// The last 100 run events, parsed when they are JSON.
fn tail_events(events: &[String]) -> Vec<Value> {
  events[events.len().saturating_sub(100)..]
    .iter()
    .map(|e| serde_json::from_str(e).unwrap_or_else(|_| Value::String(e.clone())))
    .collect()
}

pub fn tools() -> Vec<Tool> {
  let id = json!({ "type": "string", "description": "Flow id from flow_list." });
  let name = json!({ "type": "string", "description": "Name for the flow or folder." });
  let folder_id =
    json!({ "type": "string", "description": "Folder id from flow_folders_list. Blank or omitted for the top level." });
  let parent_id = json!({ "type": "string", "description": "Parent folder id from flow_folders_list. Blank or omitted for the top level." });
  let environment = json!({ "type": "string", "description": "ThingWorx environment name the flow calls." });
  let graph = json!({ "type": "object", "description": GRAPH_DOC });
  let env = json!({ "type": "string", "description": "ThingWorx environment name from Settings. Default: the one on screen, else the first enabled." });

  vec![
    tool(
      "flow_list",
      "Service Flows saved in singl, most recently changed first, without their graphs. Returns id, name, environment, \
       folderId and timestamps. Use flow_get to read one flow's graph.",
      schema(json!({}), &[]),
      Risk::Read,
      |a, _, _| async move {
        let rows = flows::list(&a.pool().await).await?;
        let summary: Vec<Value> = rows
          .iter()
          .map(|f| {
            json!({
              "id": f.id, "name": f.name, "environment": f.environment, "folderId": f.folder_id,
              "createdAt": f.created_at, "updatedAt": f.updated_at,
            })
          })
          .collect();
        ser(&summary)
      },
    ),
    tool(
      "flow_get",
      "One Service Flow with its full graph (nodes and edges). Read it before changing a flow with flow_save.",
      schema(json!({ "id": id }), &["id"]),
      Risk::Read,
      |a, args, _| async move {
        let id = Args(&args).need("id")?;
        match flows::get(&a.pool().await, id).await? {
          Some(f) => ser(&flow_json(&f)),
          None => Ok(format!("No flow with id \"{id}\".")),
        }
      },
    ),
    tool(
      "flow_create",
      "Create a Service Flow, optionally with a graph and in a folder. Returns the new flow's id. Use flow_save to \
       change its graph afterwards.",
      schema(json!({ "name": name, "environment": environment, "folderId": folder_id, "graph": graph }), &["name"]),
      Risk::Write,
      |a, args, _| async move {
        let x = Args(&args);
        let environment = x.str("environment").unwrap_or("");
        let mut graph = graph_arg(&args)?;
        let mut notes = Vec::new();
        if let Some(g) = graph.as_mut() {
          let env = match environment {
            "" => twx::resolve_env(&a, &json!({})).await?,
            e => e.to_string(),
          };
          notes = fill_services(&a, &env, g).await;
        }
        let graph = graph.map(|g| g.to_string());
        let id = flows::create(&a.pool().await, x.need("name")?, environment, x.str("folderId"), graph.as_deref()).await?;
        with_notes(json!({ "id": id }), notes)
      },
    ),
    tool(
      "flow_rename",
      "Rename a Service Flow.",
      schema(json!({ "id": id, "name": name }), &["id", "name"]),
      Risk::Write,
      |a, args, _| async move {
        let x = Args(&args);
        flows::rename(&a.pool().await, x.need("id")?, x.need("name")?).await?;
        Ok("Renamed.".into())
      },
    ),
    tool(
      "flow_delete",
      "Permanently delete a Service Flow and its graph. The user approves each call.",
      schema(json!({ "id": id }), &["id"]),
      Risk::Destructive,
      |a, args, _| async move {
        flows::delete(&a.pool().await, Args(&args).need("id")?).await?;
        Ok("Deleted.".into())
      },
    ),
    tool(
      "flow_duplicate",
      "Copy a Service Flow, including its graph. Returns the copy's id.",
      schema(json!({ "id": id }), &["id"]),
      Risk::Write,
      |a, args, _| async move {
        let copy = flows::duplicate(&a.pool().await, Args(&args).need("id")?).await?;
        ser(&json!({ "id": copy }))
      },
    ),
    tool(
      "flow_save",
      "Replace a Service Flow's whole graph. Pass the complete graph, not a diff: call flow_get, edit the graph, then \
       save it. Leave environment out to keep the flow's current one.",
      schema(json!({ "id": id, "graph": graph, "environment": environment }), &["id", "graph"]),
      Risk::Write,
      |a, args, _| async move {
        let x = Args(&args);
        let id = x.need("id")?;
        let current = existing(&a, id).await?;
        let mut graph =
          graph_arg(&args)?.ok_or_else(|| CoreError::Invalid("Missing required argument \"graph\".".into()))?;
        let environment = x.str("environment").map(str::to_string).unwrap_or(current.environment);
        let env = match environment.as_str() {
          "" => twx::resolve_env(&a, &json!({})).await?,
          e => e.to_string(),
        };
        let notes = fill_services(&a, &env, &mut graph).await;
        flows::save(&a.pool().await, id, &graph.to_string(), &environment).await?;
        with_notes(json!("Saved."), notes)
      },
    ),
    tool(
      "flow_move",
      "Move a Service Flow into a folder, or to the top level when folderId is blank.",
      schema(json!({ "id": id, "folderId": folder_id }), &["id"]),
      Risk::Write,
      |a, args, _| async move {
        let x = Args(&args);
        flows::move_flow(&a.pool().await, x.need("id")?, x.str("folderId")).await?;
        Ok("Moved.".into())
      },
    ),
    tool(
      "flow_folders_list",
      "Every Service Flow folder with its id, name and parent id.",
      schema(json!({}), &[]),
      Risk::Read,
      |a, _, _| async move { ser(&flows::folders(&a.pool().await).await?) },
    ),
    tool(
      "flow_folder_create",
      "Create a folder for Service Flows, inside parentId when given. Returns the new folder's id.",
      schema(json!({ "name": name, "parentId": parent_id }), &["name"]),
      Risk::Write,
      |a, args, _| async move {
        let x = Args(&args);
        let id = flows::create_folder(&a.pool().await, x.need("name")?, x.str("parentId")).await?;
        ser(&json!({ "id": id }))
      },
    ),
    tool(
      "flow_folder_rename",
      "Rename a Service Flow folder.",
      schema(json!({ "id": id, "name": name }), &["id", "name"]),
      Risk::Write,
      |a, args, _| async move {
        let x = Args(&args);
        flows::rename_folder(&a.pool().await, x.need("id")?, x.need("name")?).await?;
        Ok("Renamed.".into())
      },
    ),
    tool(
      "flow_folder_move",
      "Move a Service Flow folder under another folder, or to the top level when parentId is blank.",
      schema(json!({ "id": id, "parentId": parent_id }), &["id"]),
      Risk::Write,
      |a, args, _| async move {
        let x = Args(&args);
        flows::move_folder(&a.pool().await, x.need("id")?, x.str("parentId")).await?;
        Ok("Moved.".into())
      },
    ),
    tool(
      "flow_folder_delete",
      "Delete a Service Flow folder. Without recursive, its flows and subfolders move up a level; with recursive, \
       they are deleted too. The user approves each call.",
      schema(
        json!({
          "id": id,
          "recursive": { "type": "boolean", "description": "Also delete the folder's flows and subfolders. Default false." },
        }),
        &["id"],
      ),
      Risk::Destructive,
      |a, args, _| async move {
        let x = Args(&args);
        flows::delete_folder(&a.pool().await, x.need("id")?, x.bool("recursive").unwrap_or(false)).await?;
        Ok("Deleted.".into())
      },
    ),
    tool(
      "flow_datashape_fields",
      "Field definitions (name, baseType, description, ordinal) of several ThingWorx DataShapes, keyed by name. A \
       shape that cannot be read maps to an empty list. Use it to map columns when building a flow.",
      schema(
        json!({
          "env": env,
          "names": { "type": "array", "items": { "type": "string" }, "description": "DataShape names." },
        }),
        &["names"],
      ),
      Risk::Read,
      |a, args, _| async move {
        let mut wanted: Vec<String> =
          Args(&args).strings("names").into_iter().map(|n| n.trim().to_string()).filter(|n| !n.is_empty()).collect();
        wanted.sort();
        wanted.dedup();
        let mut shapes = BTreeMap::new();
        if !wanted.is_empty() {
          let client = twx::client(&a, &args).await?;
          for name in wanted {
            let fields = client.datashape_fields(&name).await.unwrap_or_default();
            shapes.insert(name, fields);
          }
        }
        ser(&shapes)
      },
    ),
    tool(
      "flow_run",
      "Run a saved Service Flow against a ThingWorx environment. Services the flow calls act on live server data, so \
       the user approves each run. Returns the event count and the last 100 run events (node results, errors). \
       Optional: seed (input for the start, keyed by port), target and only (node labels to run up to, or only).",
      schema(
        json!({
          "id": id,
          "env": env,
          "seed": { "type": "object", "description": "Input passed to the flow's start, keyed by port name." },
          "target": { "type": "array", "items": { "type": "string" }, "description": "Run up to these node labels." },
          "only": { "type": "array", "items": { "type": "string" }, "description": "Run only these node labels." },
        }),
        &["id"],
      ),
      Risk::Destructive,
      |a, args, _| async move {
        let x = Args(&args);
        let flow = existing(&a, x.need("id")?).await?;
        let graph: Value = serde_json::from_str(&flow.graph)
          .map_err(|e| CoreError::Invalid(format!("Flow \"{}\" has a damaged graph: {e}", flow.name)))?;
        let mut request = json!({ "graph": graph });
        if let Some(seed) = args.get("seed").filter(|v| v.is_object()) {
          request["seed"] = seed.clone();
        }
        for key in ["target", "only"] {
          let labels = x.strings(key);
          if !labels.is_empty() {
            request[key] = json!(labels);
          }
        }

        let pool = a.pool().await;
        let env = twx::resolve_env(&a, &args).await?;
        let client = projects::connect(&pool, &env).await?;
        let agent_env = flow::AgentEnv {
          registry: a.procs.clone(),
          root: agents::agent_root(a.workspace().root()),
          disabled: db::settings::disabled_agents(&pool).await?,
        };
        let events = Arc::new(Mutex::new(Vec::<String>::new()));
        let sink = events.clone();
        let emit: flow::Emit = Arc::new(move |event: String| {
          sink.lock().unwrap_or_else(|e| e.into_inner()).push(event);
        });
        flow::run(pool, client, request.to_string(), CancellationToken::new(), emit, agent_env).await?;

        let events = events.lock().unwrap_or_else(|e| e.into_inner()).clone();
        ser(&json!({ "eventCount": events.len(), "lastEvents": tail_events(&events) }))
      },
    ),
  ]
}
