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

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use rquickjs::function::Async;
use rquickjs::{AsyncContext, AsyncRuntime, CatchResultExt, Function, Promise};
use serde_json::{Value, json};
use sqlx::SqlitePool;
use tokio::runtime::Handle;
use tokio_util::sync::CancellationToken;

use crate::agents::process::{ProcEvent, ProcRegistry, SpawnSpec};
use crate::db::flows;
use crate::jobs::until_cancelled;
use crate::twx::api::Client;
use crate::{CoreError, Result};

/// The bundled runner; regenerate with `pnpm flow:engine`.
pub const ENGINE_JS: &str = include_str!("engine.js");

/// Heap for the trusted context. Infotables from ThingWorx can be large.
const ENGINE_MEMORY_LIMIT: usize = 1024 * 1024 * 1024;

pub type Emit = Arc<dyn Fn(String) + Send + Sync>;

/// What Agent nodes need: where processes are kept, where they may run, and
/// which providers the Settings page switched off.
#[derive(Clone, Default)]
pub struct AgentEnv {
  pub registry: ProcRegistry,
  pub root: PathBuf,
  pub disabled: Vec<String>,
}

/// Events of one agent process waiting to be read by the runner.
#[derive(Default)]
struct Mailbox {
  events: Vec<ProcEvent>,
  notify: Arc<tokio::sync::Notify>,
}

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
  agents: AgentEnv,
  /// Per agent process started by this run, the events not read yet.
  mailboxes: Arc<Mutex<HashMap<String, Mailbox>>>,
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

  /// Resolves an Agent node's working directory and checks the provider may
  /// run: `{ ok, cwd, root, mcpConfig }`.
  fn agent_prepare(&self, provider: &str, cwd: &str) -> String {
    let check = || -> Result<Value> {
      if self.agents.disabled.iter().any(|p| p == provider) {
        return Err(CoreError::Invalid("switched off".into()));
      }
      crate::agents::resolve_command(provider)?;
      let dir = crate::agents::resolve_cwd(&self.agents.root, Some(cwd))?;
      let mcp = crate::agents::project_mcp_config(&dir).map(|p| p.to_string_lossy().into_owned());
      Ok(json!({ "ok": true, "cwd": dir.to_string_lossy(), "root": self.agents.root.to_string_lossy(), "mcpConfig": mcp }))
    };
    match check() {
      Ok(v) => v.to_string(),
      Err(e) if e.to_string() == "switched off" => json!({ "ok": false, "disabled": true, "error": "switched off" }).to_string(),
      Err(e) => json!({ "ok": false, "error": e.to_string() }).to_string(),
    }
  }

  /// Starts an agent CLI; `{ ok, id }`. It is killed if the run is stopped.
  async fn agent_spawn(&self, spec_json: String, cwd: String) -> String {
    let host = self.clone();
    let work = async move {
      let spec: SpawnSpec = serde_json::from_str(&spec_json).map_err(|e| e.to_string())?;
      let dir = crate::agents::resolve_cwd(&host.agents.root, Some(&cwd)).map_err(|e| e.to_string())?;
      let key = Arc::new(Mutex::new(String::new()));
      let boxes = host.mailboxes.clone();
      let sink_key = key.clone();
      let sink = Arc::new(move |event: ProcEvent| {
        let id = sink_key.lock().unwrap_or_else(|e| e.into_inner()).clone();
        let mut boxes = boxes.lock().unwrap_or_else(|e| e.into_inner());
        let mailbox = boxes.entry(id).or_default();
        mailbox.events.push(event);
        mailbox.notify.notify_one();
      });
      // Events can arrive before the id is known; they wait under "" until then.
      let id = {
        let mut boxes = host.mailboxes.lock().unwrap_or_else(|e| e.into_inner());
        let id = host.agents.registry.spawn(spec, &dir, sink).map_err(|e| e.to_string())?;
        *key.lock().unwrap_or_else(|e| e.into_inner()) = id.clone();
        if let Some(early) = boxes.remove("") {
          boxes.insert(id.clone(), early);
        } else {
          boxes.entry(id.clone()).or_default();
        }
        id
      };
      let (registry, token, proc_id) = (host.agents.registry.clone(), host.token.clone(), id.clone());
      tokio::spawn(async move {
        token.cancelled().await;
        registry.kill(&proc_id);
      });
      Ok(json!({ "ok": true, "id": id }).to_string())
    };
    ok_or_error(self.handle.spawn(work).await.map_err(join_error).and_then(|r| r))
  }

  /// The next events of an agent process, waiting until there is at least one.
  async fn agent_next(&self, id: String) -> String {
    let boxes = self.mailboxes.clone();
    let work = async move {
      loop {
        let notify = {
          let mut guard = boxes.lock().unwrap_or_else(|e| e.into_inner());
          let Some(mailbox) = guard.get_mut(&id) else { return "[]".to_string() };
          if !mailbox.events.is_empty() {
            let events = std::mem::take(&mut mailbox.events);
            if events.iter().any(|e| matches!(e, ProcEvent::Exit { .. })) {
              guard.remove(&id);
            }
            return serde_json::to_string(&events).unwrap_or_else(|_| "[]".into());
          }
          mailbox.notify.clone()
        };
        notify.notified().await;
      }
    };
    self.handle.spawn(work).await.unwrap_or_else(|_| "[]".into())
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
  agents: AgentEnv,
) -> Result<()> {
  let host = Host {
    pool,
    client,
    token,
    handle: Handle::current(),
    emit,
    agents,
    mailboxes: Arc::new(Mutex::new(HashMap::new())),
  };
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

        let h = host.clone();
        api.set(
          "agentPrepare",
          Function::new(ctx.clone(), move |provider: String, cwd: String| h.agent_prepare(&provider, &cwd))?,
        )?;

        let h = host.clone();
        api.set(
          "agentSpawn",
          Function::new(
            ctx.clone(),
            Async(move |spec: String, cwd: String| {
              let h = h.clone();
              async move { h.agent_spawn(spec, cwd).await }
            }),
          )?,
        )?;

        let h = host.clone();
        api.set(
          "agentNext",
          Function::new(
            ctx.clone(),
            Async(move |id: String| {
              let h = h.clone();
              async move { h.agent_next(id).await }
            }),
          )?,
        )?;

        let registry = host.agents.registry.clone();
        api.set("agentKill", Function::new(ctx.clone(), move |id: String| registry.kill(&id))?)?;

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
    let agents = AgentEnv { root: dir.path().to_path_buf(), ..Default::default() };
    run(pool, Client::new("http://127.0.0.1:9", "x"), request, CancellationToken::new(), emit, agents).await.unwrap();
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

  /// A stand-in `claude`: a `.cmd` shim around a script that echoes stdin.
  #[cfg(windows)]
  #[tokio::test(flavor = "multi_thread")]
  async fn runs_agent_nodes_through_a_cli() {
    let bin = tempfile::tempdir().unwrap();
    std::fs::write(
      bin.path().join("fake.js"),
      "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{console.error('working');console.log('echo: '+s.trim())});",
    )
    .unwrap();
    let shim = bin.path().join("claude.cmd");
    std::fs::write(&shim, r#"@"node" "%~dp0\fake.js" %*"#).unwrap();
    // SAFETY: the only test that reads this variable.
    unsafe { std::env::set_var("TWX_FLOW_AGENT_CLAUDE_BIN", &shim) };

    let graph = json!({
      "nodes": [{ "id": "g", "kind": "agent", "label": "Ask", "x": 0, "y": 0,
        "provider": "claude", "prompt": "hi {{ 1 + 1 }}", "outputMode": "text" }],
      "edges": []
    });
    let events = run_graph(graph).await;
    let state = end_state(&events, "g");
    assert_eq!(state["status"], "ok", "{events:?}");
    assert_eq!(state["result"], "echo: hi 2");
    assert!(events.iter().any(|e| e["type"] == "node-log" && e["line"] == "working"), "{events:?}");
  }

  /// Stop has to reach a CLI that would otherwise never finish.
  #[cfg(windows)]
  #[tokio::test(flavor = "multi_thread")]
  async fn stopping_a_run_kills_its_agent() {
    let bin = tempfile::tempdir().unwrap();
    std::fs::write(bin.path().join("hang.js"), "setInterval(() => {}, 1000);").unwrap();
    let shim = bin.path().join("codex.cmd");
    std::fs::write(&shim, r#"@"node" "%~dp0\hang.js" %*"#).unwrap();
    // SAFETY: the only test that reads this variable.
    unsafe { std::env::set_var("TWX_FLOW_AGENT_CODEX_BIN", &shim) };

    let dir = tempfile::tempdir().unwrap();
    let pool = open(&dir.path().join("t.db")).await.unwrap();
    let registry = ProcRegistry::default();
    let agents = AgentEnv { registry: registry.clone(), root: dir.path().to_path_buf(), disabled: vec![] };
    let graph = json!({
      "nodes": [{ "id": "g", "kind": "agent", "label": "Hang", "x": 0, "y": 0,
        "provider": "codex", "prompt": "wait", "outputMode": "text" }],
      "edges": []
    });
    let token = CancellationToken::new();
    let stopper = token.clone();
    tokio::spawn(async move {
      tokio::time::sleep(Duration::from_millis(1500)).await;
      stopper.cancel();
    });
    let emit: Emit = Arc::new(|_| {});
    let request = json!({ "graph": graph }).to_string();
    let started = std::time::Instant::now();
    run(pool, Client::new("http://127.0.0.1:9", "x"), request, token, emit, agents).await.unwrap();
    assert!(started.elapsed() < Duration::from_secs(15), "run did not stop: {:?}", started.elapsed());
  }

  #[test]
  fn disabled_providers_are_refused_before_spawning() {
    let rt = tokio::runtime::Runtime::new().unwrap();
    rt.block_on(async {
      let dir = tempfile::tempdir().unwrap();
      let pool = open(&dir.path().join("t.db")).await.unwrap();
      let host = Host {
        pool,
        client: Client::new("http://127.0.0.1:9", "x"),
        token: CancellationToken::new(),
        handle: Handle::current(),
        emit: Arc::new(|_| {}),
        agents: AgentEnv { root: dir.path().to_path_buf(), disabled: vec!["claude".into()], ..Default::default() },
        mailboxes: Default::default(),
      };
      let out: Value = serde_json::from_str(&host.agent_prepare("claude", "")).unwrap();
      assert_eq!(out["disabled"], true);
      let out: Value = serde_json::from_str(&host.agent_prepare("bash", "")).unwrap();
      assert_eq!(out["ok"], false);
    });
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
