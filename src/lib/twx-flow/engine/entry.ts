/**
 * Entry point of the flow engine bundle.
 *
 * scripts/build-flow-engine.mjs bundles this file (and the evaluator modules it
 * pulls in: graph, expression, conditions, schema, datasets) into one script,
 * src-tauri/crates/singl-core/src/flow/engine.js, which the Rust engine
 * evaluates in a trusted QuickJS context. The editor imports the very same
 * modules, so previews and runs share one implementation.
 *
 * Rust installs `__host` before this script runs; every value crossing that
 * boundary is a JSON string.
 */

import { parseGraph } from "../graph";
import { runFlow, type FlowHost } from "../execute";
import type { FlowGraph, RunEvent } from "../types";
import { runCode } from "./sandbox";

type Envelope<T> = ({ ok: true } & T) | { ok: false; error: string };

declare const __host: {
  executeService(collection: string, entity: string, service: string, inputsJson: string): Promise<string>;
  loadFlow(id: string): Promise<string>;
  runSandbox(source: string, inputJson: string, budgetMs: number): Promise<string>;
  sleep(ms: number): Promise<void>;
  emit(eventJson: string): void;
  aborted(): boolean;
  uuid(): string;
};

export type RunRequest = {
  graph: FlowGraph;
  seed?: Record<string, unknown>;
  seedPorts?: Record<string, unknown>;
  target?: string | string[];
  only?: string | string[];
};

function unwrap<T>(raw: string): T {
  const envelope = JSON.parse(raw) as Envelope<T>;
  if (!envelope.ok) throw new Error(envelope.error);
  return envelope;
}

const host: FlowHost = {
  async executeService(collection, entityName, serviceName, inputs) {
    const raw = await __host.executeService(collection, entityName, serviceName, JSON.stringify(inputs ?? {}));
    return unwrap<{ json: unknown }>(raw).json;
  },
  async loadFlow(id) {
    return unwrap<{ flow: { name: string; graph: string } | null }>(await __host.loadFlow(id)).flow;
  },
  runCode: (code, ctx, timeoutMs) => runCode(code, ctx, timeoutMs, __host.runSandbox),
  sleep: (ms) => __host.sleep(ms),
};

const signal = {
  get aborted() {
    return __host.aborted();
  },
};

const emit = (event: RunEvent) => {
  if (signal.aborted) return;
  __host.emit(JSON.stringify(event));
};

// `crypto.randomUUID` backs `$uuid()` in expressions; QuickJS has no crypto.
const g = globalThis as unknown as { crypto?: { randomUUID?: () => string } };
if (!g.crypto) g.crypto = {};
if (!g.crypto.randomUUID) g.crypto.randomUUID = () => __host.uuid();

/** Runs one flow, streaming RunEvents through `__host.emit`. Ends with `done` or `error`. */
async function run(requestJson: string): Promise<void> {
  try {
    const request = JSON.parse(requestJson) as RunRequest;
    if (!request?.graph || !Array.isArray(request.graph.nodes)) throw new Error("graph is required");
    // Round-trip through the parser so a graph from an older build still gets
    // its per-parameter wires migrated before anything executes.
    const graph = parseGraph(JSON.stringify(request.graph));
    await runFlow({
      graph,
      host,
      emit,
      seed: request.seed,
      seedPorts: request.seedPorts,
      target: request.target,
      only: request.only,
      signal,
    });
    emit({ type: "done" });
  } catch (e) {
    // A stopped run is not a failure to report.
    emit({ type: "error", message: e instanceof Error ? e.message : String(e) });
  }
}

(globalThis as unknown as { __flowRun: typeof run }).__flowRun = run;
