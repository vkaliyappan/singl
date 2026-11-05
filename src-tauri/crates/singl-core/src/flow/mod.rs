//! Flow runs: singl-web's `/api/twx-flow/run` and `lib/twx-flow/execute.ts`.
//!
//! The run loop and every evaluator (expressions, conditions, schema reshaping,
//! dataset merge/compare) are the TypeScript modules under `src/lib/twx-flow`,
//! bundled into [`ENGINE_JS`] and run in a trusted QuickJS context, so they can
//! never drift from what the editor previews. Rust owns everything else: the
//! JS thread, ThingWorx calls, sub-flow lookups, the Code-node [`sandbox`],
//! timers and cancellation.
//!
//! Events leave as JSON strings (the `RunEvent` union of `types.ts`) rather
//! than `serde_json::Value`s, so infotable columns keep the order ThingWorx
//! sent them in.

pub mod sandbox;

use std::sync::Arc;
use std::time::Duration;

use rquickjs::function::Async;
use rquickjs::{AsyncContext, AsyncRuntime, CatchResultExt, Function, Promise};
use serde_json::{Value, json};
use sqlx::SqlitePool;
use tokio::runtime::Handle;
use tokio_util::sync::CancellationToken;

use crate::db::flows;
use crate::jobs::until_cancelled;
use crate::twx::api::Client;
use crate::{CoreError, Result};

/// The bundled runner; regenerate with `pnpm flow:engine`.
pub const ENGINE_JS: &str = include_str!("engine.js");

/// Heap for the trusted context. Infotables from ThingWorx can be large.
const ENGINE_MEMORY_LIMIT: usize = 1024 * 1024 * 1024;

pub type Emit = Arc<dyn Fn(String) + Send + Sync>;

/// Side effects the runner reaches through `__host`. Cheap to clone.
#[derive(Clone)]
struct Host {
  pool: SqlitePool,
  client: Client,
  token: CancellationToken,
  /// The app's runtime: network, database and blocking work run there, so the
  /// JS thread only ever waits on join handles.
  handle: Handle,
  emit: Emit,
}

fn ok_or_error(result: std::result::Result<String, String>) -> String {
  result.unwrap_or_else(|error| json!({ "ok": false, "error": error }).to_string())
}

fn join_error(e: tokio::task::JoinError) -> String {
  format!("internal error: {e}")
}

impl Host {
  async fn execute_service(&self, collection: String, entity: String, service: String, inputs: String) -> String {
    let host = self.clone();
    let work = async move {
      let inputs: Value = serde_json::from_str(&inputs).map_err(|e| e.to_string())?;
      let inputs = if inputs.is_null() { json!({}) } else { inputs };
      let text = until_cancelled(&host.token, host.client.execute_service(&collection, &entity, &service, &inputs))
        .await
        .map_err(|e| e.to_string())?;
      // `text` was checked to be JSON; splice it in to keep its key order.
      Ok(format!(r#"{{"ok":true,"json":{text}}}"#))
    };
    ok_or_error(self.handle.spawn(work).await.map_err(join_error).and_then(|r| r))
  }

  async fn load_flow(&self, id: String) -> String {
    let pool = self.pool.clone();
    let work = async move {
      let flow = flows::get(&pool, &id).await.map_err(|e| e.to_string())?;
      let flow = flow.map(|f| json!({ "name": f.name, "graph": f.graph }));
      Ok(json!({ "ok": true, "flow": flow }).to_string())
    };
    ok_or_error(self.handle.spawn(work).await.map_err(join_error).and_then(|r| r))
  }

  async fn run_sandbox(&self, source: String, input: String, budget_ms: f64) -> String {
    let budget = budget_ms.clamp(1.0, 600_000.0) as u64;
    let work = move || sandbox::run(&source, &input, budget);
    match self.handle.spawn_blocking(work).await {
      Ok(envelope) => envelope,
      Err(e) => json!({ "ok": false, "error": join_error(e), "stack": "", "logs": [] }).to_string(),
    }
  }

  async fn sleep(&self, ms: f64) {
    let token = self.token.clone();
    let wait = Duration::from_millis(ms.max(0.0) as u64);
    let _ = self
      .handle
      .spawn(async move {
        tokio::select! {
          () = tokio::time::sleep(wait) => {},
          () = token.cancelled() => {},
        }
      })
      .await;
  }
}

/// Runs one flow. `request_json` is `{ graph, seed?, seedPorts?, target?, only? }`.
/// Progress goes to `emit`, ending with a `done` or `error` event unless the
/// run was cancelled. Returns once the run has finished or stopped.
pub async fn run(
  pool: SqlitePool,
  client: Client,
  request_json: String,
  token: CancellationToken,
  emit: Emit,
) -> Result<()> {
  let host = Host { pool, client, token, handle: Handle::current(), emit };
  let (tx, rx) = tokio::sync::oneshot::channel();

  // QuickJS values are not Send, so the context lives on a thread of its own
  // with a single-threaded runtime driving its promises.
  std::thread::Builder::new()
    .name("flow-run".into())
    .spawn(move || {
      let outcome = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|e| e.to_string())
        .and_then(|rt| rt.block_on(run_in_js(host, request_json)));
      let _ = tx.send(outcome);
    })?;

  match rx.await {
    Ok(Ok(())) => Ok(()),
    Ok(Err(message)) => Err(CoreError::Invalid(format!("Flow engine failed: {message}"))),
    Err(_) => Err(CoreError::Invalid("Flow engine stopped unexpectedly.".into())),
  }
}

async fn run_in_js(host: Host, request_json: String) -> std::result::Result<(), String> {
  let runtime = AsyncRuntime::new().map_err(|e| e.to_string())?;
  runtime.set_memory_limit(ENGINE_MEMORY_LIMIT).await;
  runtime.set_max_stack_size(8 * 1024 * 1024).await;
  let context = AsyncContext::full(&runtime).await.map_err(|e| e.to_string())?;

  let outcome = context
    .async_with(async move |ctx| {
      let result = async {
        let api = rquickjs::Object::new(ctx.clone())?;

        let h = host.clone();
        api.set(
          "executeService",
          Function::new(
            ctx.clone(),
            Async(move |collection: String, entity: String, service: String, inputs: String| {
              let h = h.clone();
              async move { h.execute_service(collection, entity, service, inputs).await }
            }),
          )?,
        )?;

        let h = host.clone();
        api.set(
          "loadFlow",
          Function::new(
            ctx.clone(),
            Async(move |id: String| {
              let h = h.clone();
              async move { h.load_flow(id).await }
            }),
          )?,
        )?;

        let h = host.clone();
        api.set(
          "runSandbox",
          Function::new(
            ctx.clone(),
            Async(move |source: String, input: String, budget: f64| {
              let h = h.clone();
              async move { h.run_sandbox(source, input, budget).await }
            }),
          )?,
        )?;

        let h = host.clone();
        api.set(
          "sleep",
          Function::new(
            ctx.clone(),
            Async(move |ms: f64| {
              let h = h.clone();
              async move { h.sleep(ms).await }
            }),
          )?,
        )?;

        let emit = host.emit.clone();
        api.set("emit", Function::new(ctx.clone(), move |event: String| emit(event))?)?;
        let token = host.token.clone();
        api.set("aborted", Function::new(ctx.clone(), move || token.is_cancelled())?)?;
        api.set("uuid", Function::new(ctx.clone(), || uuid::Uuid::new_v4().to_string())?)?;
        ctx.globals().set("__host", api)?;

        ctx.eval::<(), _>(ENGINE_JS)?;
        let run: Function = ctx.globals().get("__flowRun")?;
        let promise: Promise = run.call((request_json,))?;
        promise.into_future::<()>().await
      }
      .await;
      result.catch(&ctx).map_err(|e| e.to_string())
    })
    .await;

  runtime.idle().await;
  outcome
}

#[cfg(test)]
mod tests {
  use std::sync::Mutex;

  use super::*;
  use crate::db::open;

  async fn run_graph(graph: Value) -> Vec<Value> {
    let dir = tempfile::tempdir().unwrap();
    let pool = open(&dir.path().join("t.db")).await.unwrap();
    let events = Arc::new(Mutex::new(Vec::new()));
    let sink = events.clone();
    let emit: Emit = Arc::new(move |e: String| sink.lock().unwrap().push(serde_json::from_str::<Value>(&e).unwrap()));
    let request = json!({ "graph": graph }).to_string();
    run(pool, Client::new("http://127.0.0.1:9", "x"), request, CancellationToken::new(), emit).await.unwrap();
    let out = events.lock().unwrap().clone();
    out
  }

  fn end_state<'a>(events: &'a [Value], id: &str) -> &'a Value {
    events
      .iter()
      .find(|e| e["type"] == "node-end" && e["id"] == id)
      .map(|e| &e["state"])
      .unwrap_or_else(|| panic!("no node-end for {id}: {events:?}"))
  }

  #[tokio::test(flavor = "multi_thread")]
  async fn runs_code_and_wait_nodes_end_to_end() {
    let graph = json!({
      "nodes": [
        { "id": "a", "kind": "code", "label": "Make", "position": { "x": 0, "y": 0 },
          "code": "console.log('hi'); return { rows: [{ n: 1 }, { n: 2 }] };" },
        { "id": "b", "kind": "wait", "label": "Pause", "position": { "x": 1, "y": 0 }, "mode": "time", "waitMs": 10 },
        { "id": "c", "kind": "code", "label": "Count", "position": { "x": 2, "y": 0 },
          "code": "return $json.rows.length + $node['Make'].rows[1].n;" }
      ],
      "edges": [
        { "id": "e1", "source": "a", "target": "b" },
        { "id": "e2", "source": "b", "target": "c" }
      ]
    });
    let events = run_graph(graph).await;
    assert_eq!(events.first().unwrap()["type"], "start");
    assert_eq!(events.last().unwrap()["type"], "done", "{events:?}");
    let a = end_state(&events, "a");
    assert_eq!(a["status"], "ok");
    assert_eq!(a["logs"][0], "hi");
    assert_eq!(end_state(&events, "c")["result"], 4);
  }

  #[tokio::test(flavor = "multi_thread")]
  async fn reports_service_failures_on_the_node() {
    let graph = json!({
      "nodes": [{ "id": "s", "kind": "service", "label": "Call", "position": { "x": 0, "y": 0 },
        "collection": "Things", "entityName": "T", "serviceName": "S", "params": [] }],
      "edges": []
    });
    let events = run_graph(graph).await;
    assert_eq!(end_state(&events, "s")["status"], "error");
    assert_eq!(events.last().unwrap()["type"], "done");
  }
}
