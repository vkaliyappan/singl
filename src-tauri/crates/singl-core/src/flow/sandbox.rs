//! The untrusted half of a Code node run (singl-web's `isolated-vm` isolate).
//!
//! Each call gets a fresh QuickJS runtime with a memory limit and an interrupt
//! deadline, and no host functions at all: the snippet sees `__inputJson` and
//! nothing else. The wrapper that turns a snippet into an envelope-returning
//! async IIFE lives on the trusted side, in `src/lib/twx-flow/engine/sandbox.ts`.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use rquickjs::context::EvalOptions;
use rquickjs::{CatchResultExt, CaughtError, Context, Error as JsError, Promise, Runtime};
use serde_json::json;

/// Matches `CODE_MEMORY_LIMIT_MB` in src/lib/twx-flow/code-node.ts.
pub const MEMORY_LIMIT_MB: usize = 128;

/// Why a run ended without the snippet's own envelope.
fn limit(kind: &str, error: &str) -> String {
  json!({ "ok": false, "error": error, "stack": "", "logs": [], "limit": kind }).to_string()
}

fn failure(error: &str, stack: &str) -> String {
  json!({ "ok": false, "error": error, "stack": stack, "logs": [] }).to_string()
}

/// Runs `source` (which must evaluate to a Promise of a string) and returns that
/// string, or an envelope describing why it did not finish. Blocking: call it
/// from `spawn_blocking`.
pub fn run(source: &str, input_json: &str, budget_ms: u64) -> String {
  run_with(source, input_json, budget_ms, MEMORY_LIMIT_MB)
}

/// [`run`] with its own memory limit.
pub fn run_with(source: &str, input_json: &str, budget_ms: u64, memory_mb: usize) -> String {
  let runtime = match Runtime::new() {
    Ok(rt) => rt,
    Err(e) => return failure(&format!("Could not start the sandbox: {e}"), ""),
  };
  runtime.set_memory_limit(memory_mb * 1024 * 1024);
  runtime.set_max_stack_size(1024 * 1024);

  let deadline = Instant::now() + Duration::from_millis(budget_ms);
  let expired = Arc::new(AtomicBool::new(false));
  let flag = expired.clone();
  runtime.set_interrupt_handler(Some(Box::new(move || {
    if Instant::now() >= deadline {
      flag.store(true, Ordering::Relaxed);
      true
    } else {
      false
    }
  })));

  let context = match Context::full(&runtime) {
    Ok(ctx) => ctx,
    Err(e) => return failure(&format!("Could not start the sandbox: {e}"), ""),
  };

  context.with(|ctx| {
    let outcome = (|| {
      ctx.globals().set("__inputJson", input_json)?;
      let mut options = EvalOptions::default();
      // Snippets ran as sloppy scripts in singl-web's isolate too.
      options.strict = false;
      options.filename = Some("code.js".into());
      let promise: Promise = ctx.eval_with_options(source, options)?;
      promise.finish::<String>()
    })()
    .catch(&ctx);

    match outcome {
      Ok(envelope) => envelope,
      Err(_) if expired.load(Ordering::Relaxed) => limit("timeout", "timed out"),
      Err(CaughtError::Error(JsError::WouldBlock)) => limit("stalled", "never settled"),
      Err(CaughtError::Exception(ex)) => {
        let message = ex.message().unwrap_or_default();
        if message.contains("out of memory") {
          limit("memory", &message)
        } else {
          failure(&message, &ex.stack().unwrap_or_default())
        }
      }
      Err(other) => {
        let message = other.to_string();
        if message.contains("out of memory") { limit("memory", &message) } else { failure(&message, "") }
      }
    }
  })
}

#[cfg(test)]
mod tests {
  use super::*;
  use serde_json::Value;

  fn wrap(body: &str) -> String {
    format!(
      "(async () => {{ const {{ $json }} = JSON.parse(__inputJson); \
       try {{ const v = await (async () => {{ {body} }})(); return JSON.stringify({{ ok: true, value: v }}); }} \
       catch (e) {{ return JSON.stringify({{ ok: false, error: String(e && e.message || e) }}); }} }})()"
    )
  }

  fn parse(raw: String) -> Value {
    serde_json::from_str(&raw).unwrap()
  }

  #[test]
  fn returns_the_snippet_envelope() {
    let out = parse(run(&wrap("return $json.a + 1;"), r#"{"$json":{"a":41}}"#, 1000));
    assert_eq!(out["ok"], true);
    assert_eq!(out["value"], 42);
  }

  #[test]
  fn reports_thrown_errors_through_the_wrapper() {
    let out = parse(run(&wrap("throw new Error('boom');"), r#"{"$json":null}"#, 1000));
    assert_eq!(out["error"], "boom");
  }

  #[test]
  fn interrupts_endless_loops() {
    let out = parse(run(&wrap("while (true) {}"), r#"{"$json":null}"#, 200));
    assert_eq!(out["limit"], "timeout");
  }

  #[test]
  fn detects_awaits_that_never_settle() {
    let out = parse(run(&wrap("await new Promise(() => {}); return 1;"), r#"{"$json":null}"#, 1000));
    assert_eq!(out["limit"], "stalled");
  }

  #[test]
  fn has_no_host_functions() {
    let out = parse(run(&wrap("return [typeof fetch, typeof setTimeout, typeof require].join();"), "{}", 1000));
    assert_eq!(out["value"], "undefined,undefined,undefined");
  }
}
