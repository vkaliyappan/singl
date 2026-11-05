/**
 * The flow runner.
 *
 * Nodes are executed in topological order, except that a Loop node's return
 * wire is not part of that order: it is a jump. When the end of a loop body
 * sends its result back, the runner rewinds to the Loop node, which hands out
 * the next batch — and only once the batches run out does the run carry on past
 * it, down the `done` port.
 *
 * In singl this runs inside the trusted QuickJS context of the Rust engine
 * (src-tauri/crates/singl-core/src/flow), bundled by scripts/build-flow-engine.mjs.
 * Everything with a side effect — ThingWorx, the database (for sub-flows), the
 * Code-node sandbox, timers — comes in through {@link FlowHost}.
 */

import { describeAgent } from "./agents";
import { compareDatasets, mergeInputs } from "./datasets";
import {
  ancestorsOf,
  backEdgeIds,
  buildInputs,
  contextFor,
  cycleParts,
  decideBranch,
  decideSwitch,
  filterRows,
  inputValues,
  loopBody,
  loopReturnSources,
  parentsOf,
  parseGraph,
  portKey,
  portOf,
  topoSort,
  type EvalScope,
  type PortResults,
} from "./graph";
import { evaluateTemplate } from "./expression";
import { asInfotable, reshapeLike, toRows } from "./schema";
import type { AgentProvider, EdgePort, FlowGraph, NodeRunState, RunEvent } from "./types";

/** Deliberate abort, thrown by a Stop and Error node. Ends the whole run. */
export class FlowStopError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FlowStopError";
  }
}

/** Node executions per run. A loop that cannot finish trips this instead of
    holding the request open until the platform kills it. */
const MAX_STEPS = 5_000;
/** Longest a single Wait node may hold the run, well inside `maxDuration`. */
const MAX_WAIT_MS = 120_000;
/** How deep Execute Sub-flow may nest. */
const MAX_DEPTH = 5;

/** What the runner needs from outside its own context. */
export type FlowHost = {
  executeService(
    collection: string,
    entityName: string,
    serviceName: string,
    inputs: Record<string, unknown>
  ): Promise<unknown>;
  /** A saved flow by id, or null when it no longer exists. */
  loadFlow(id: string): Promise<{ name: string; graph: string } | null>;
  /** Runs a Code node's snippet in the sandbox. Throws with `logs` attached. */
  runCode(
    code: string,
    ctx: { $json: unknown; $node: Record<string, unknown>; now: Date },
    timeoutMs?: number
  ): Promise<{ value: unknown; logs: string[] }>;
  sleep(ms: number): Promise<void>;
  /** Runs an Agent node's CLI; see engine/agent.ts. */
  runAgent(options: {
    provider: AgentProvider;
    prompt: string;
    model?: string;
    cwd?: string;
    outputMode: "text" | "json";
    autoApprove?: boolean;
    extraArgs?: string;
    timeoutMs?: number;
    onLine?: (line: string) => void;
    signal?: { readonly aborted: boolean };
  }): Promise<{ value: unknown; command: string; cwd: string; logs: string[] }>;
};

export type RunFlowOptions = {
  graph: FlowGraph;
  host: FlowHost;
  /** Progress sink. Sub-flows run without one — their nodes are not on screen. */
  emit?: (event: RunEvent) => void;
  /** Results the client already holds, keyed by node id. */
  seed?: Record<string, unknown>;
  /** Per-port results it holds too, keyed `nodeId::port`. */
  seedPorts?: PortResults;
  /** Run these nodes and everything they depend on. */
  target?: string | string[];
  /** Run only these nodes, reusing `seed` for their upstream values. */
  only?: string | string[];
  /** `$json` for nodes with nothing wired in — how a sub-flow is fed. */
  rootInput?: unknown;
  /** Flow ids already on the stack, so a sub-flow cannot call itself. */
  stack?: string[];
  signal?: { readonly aborted: boolean };
};

export type RunFlowResult = {
  order: string[];
  cycle: string[];
  states: Record<string, NodeRunState>;
  results: Record<string, unknown>;
  /** What the flow "returned": the last node that nothing else consumes. */
  output: unknown;
};

const rowCount = (value: unknown): number | undefined => asInfotable(value)?.rows.length;

type Row = Record<string, unknown>;

type LoopState = {
  /** The container the batches came out of, so they go back into one like it. */
  original: unknown;
  items: Row[];
  /** How far through `items` the loop has handed out. */
  index: number;
  /** Rows the body sent back, one pass at a time. */
  collected: Row[];
  iterations: number;
};

export async function runFlow(options: RunFlowOptions): Promise<RunFlowResult> {
  const { graph, host, seed, target, only, rootInput, signal } = options;
  const emit = options.emit ?? (() => {});
  const stack = options.stack ?? [];

  const { order, cycle } = topoSort(graph);
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const back = backEdgeIds(graph);

  // Either selector takes one node or a whole selection of them.
  const asList = (value?: string | string[]) =>
    Array.isArray(value) ? value : value ? [value] : [];
  const onlyIds = asList(only);
  const targetIds = asList(target);
  const wanted = onlyIds.length
    ? new Set(onlyIds)
    : targetIds.length
      ? new Set(targetIds.flatMap((id) => [...ancestorsOf(graph, id)]))
      : null;
  const plan = order.filter((id) => !wanted || wanted.has(id));
  const planIndex = new Map(plan.map((id, index) => [id, index]));

  emit({ type: "start", order: plan, cycle });

  // One clock for the whole run so `$now` cannot drift between nodes.
  const now = new Date();
  const results: Record<string, unknown> = { ...(seed ?? {}) };
  const portResults: PortResults = { ...(options.seedPorts ?? {}) };
  const states: Record<string, NodeRunState> = {};
  const executed: string[] = [];

  /** Nodes this run reached a verdict on — seeded ones are not among them. */
  const settled = new Set<string>();
  /** Settled nodes that carry no data forward: failed, or on a dead branch. */
  const dead = new Set<string>();
  /** The port each branching node chose. Absent means "all of them". */
  const takenPort = new Map<string, EdgePort>();

  /* --------------------------------------------------------------- loops -- */

  const loops = new Map<string, LoopState>();
  const bodies = new Map<string, Set<string>>();
  /** Body node whose completion rewinds the run, and the Loop it rewinds to. */
  const returnsTo = new Map<string, string>();
  /** Body nodes of a loop that has run out — passed over, not re-run. */
  const finished = new Set<string>();

  for (const node of graph.nodes) {
    if (node.kind !== "loop") continue;
    bodies.set(node.id, loopBody(graph, node.id));
    for (const source of loopReturnSources(graph, node.id)) returnsTo.set(source, node.id);
  }

  /** Puts a loop body back to "not run yet" so the next batch can go through. */
  const restartBody = (loopId: string) => {
    for (const id of bodies.get(loopId) ?? []) {
      settled.delete(id);
      dead.delete(id);
      finished.delete(id);
      takenPort.delete(id);
      // A loop nested inside this one starts from its first batch again.
      if (byId.get(id)?.kind === "loop") loops.delete(id);
    }
  };

  /* ---------------------------------------------------------- reachability -- */

  /**
   * Whether any live wire actually arrives here. A node whose only feeds came
   * down the branch that was not taken, or from a node that failed, has nothing
   * to work with. Wires from nodes outside this run stand for results already
   * on the board, so they always count as live.
   */
  const reachable = (id: string) => {
    const incoming = graph.edges.filter(
      (e) => e.target === id && !back.has(e.id) && settled.has(e.source)
    );
    if (!incoming.length) return true;
    return incoming.some((e) => {
      if (dead.has(e.source)) return false;
      const port = portOf(e, byId.get(e.source));
      if (!port) return true;
      const taken = takenPort.get(e.source);
      return taken === undefined || taken === port;
    });
  };

  const scope = (): EvalScope => ({ graph, results, now, rootInput, portResults });

  /* ------------------------------------------------------------------ run -- */

  let steps = 0;
  let pc = 0;

  while (pc < plan.length) {
    if (signal?.aborted) break;
    if (++steps > MAX_STEPS) {
      throw new Error(`Stopped after ${MAX_STEPS} steps — a loop is not finishing.`);
    }

    const id = plan[pc];
    pc++;
    // A body whose loop is done keeps the state of its last pass.
    if (finished.has(id)) continue;

    const node = byId.get(id);
    if (!node) continue;
    settled.add(id);

    if (node.disabled) {
      // Disabled nodes pass their input straight through, like n8n.
      const [parent] = parentsOf(graph, id);
      results[id] = parent ? results[parent] : undefined;
      states[id] = { status: "disabled", ms: 0 };
      emit({ type: "node-end", id, state: states[id] });
      continue;
    }

    if (!reachable(id)) {
      const failedUpstream = graph.edges.some(
        (e) => e.target === id && states[e.source]?.status === "error"
      );
      dead.add(id);
      states[id] = {
        status: "skipped",
        error: failedUpstream ? "Upstream node did not succeed." : "Branch not taken.",
        ms: 0,
      };
      emit({ type: "node-end", id, state: states[id] });
      continue;
    }

    emit({ type: "node-start", id });
    const { inputs, errors } = buildInputs(node, scope());
    const inputErrors = Object.keys(errors).length ? errors : undefined;
    const startedAt = Date.now();
    /** The value on this node's primary input wire, which most kinds pass on. */
    const [incoming] = inputValues(graph, id, results, portResults);
    const passthrough = parentsOf(graph, id).length ? incoming : rootInput;

    try {
      switch (node.kind) {
        case "if": {
          // A branch is a signpost, not a transform: whatever arrived leaves
          // again unchanged, down one of the two ports.
          const decision = decideBranch(node, scope());
          if (decision.error) throw new Error(decision.error);
          takenPort.set(id, decision.branch ?? "false");
          results[id] = passthrough;
          states[id] = {
            status: "ok",
            result: passthrough,
            inputs: { condition: decision.value },
            inputErrors,
            branch: decision.branch,
            rows: rowCount(passthrough),
            ms: Date.now() - startedAt,
          };
          break;
        }

        case "switch": {
          const decision = decideSwitch(node, scope());
          if (decision.error) throw new Error(decision.error);
          // No rule matched and no fallback port: nothing downstream runs.
          takenPort.set(id, decision.branch ?? "");
          results[id] = passthrough;
          states[id] = {
            status: "ok",
            result: passthrough,
            inputs: { matched: decision.matched ?? "nothing", value: decision.value },
            inputErrors,
            branch: decision.branch,
            rows: rowCount(passthrough),
            ms: Date.now() - startedAt,
          };
          break;
        }

        case "filter": {
          const rows = toRows(passthrough);
          const { kept, error, warning } = filterRows(node, rows, scope());
          // A condition that will not evaluate is a failure; a filter with
          // nothing set up is only a warning — everything came through.
          if (error) throw new Error(error);
          const value = reshapeLike(passthrough, kept);
          results[id] = value;
          states[id] = {
            status: "ok",
            result: value,
            inputs: {
              kept: kept.length,
              dropped: rows.length - kept.length,
              ...(warning ? { note: warning } : {}),
            },
            inputErrors,
            rows: kept.length,
            ms: Date.now() - startedAt,
          };
          break;
        }

        case "loop": {
          let state = loops.get(id);
          if (!state) {
            state = {
              original: passthrough,
              items: toRows(passthrough),
              index: 0,
              collected: [],
              iterations: 0,
            };
            loops.set(id, state);
          }

          const size = Math.max(1, Math.floor(node.batchSize || 1));
          if (state.index < state.items.length) {
            const batch = state.items.slice(state.index, state.index + size);
            state.index += size;
            state.iterations++;
            const value = reshapeLike(state.original, batch);
            results[id] = value;
            portResults[portKey(id, "loop")] = value;
            takenPort.set(id, "loop");
            states[id] = {
              status: "ok",
              result: value,
              inputs: {
                batch: state.iterations,
                of: Math.ceil(state.items.length / size),
                items: state.items.length,
              },
              inputErrors,
              branch: "loop",
              ports: { loop: value },
              iterations: state.iterations,
              rows: batch.length,
              ms: Date.now() - startedAt,
            };
            break;
          }

          // Out of batches. Everything the body sent back leaves by `done` —
          // or, when nothing wires back, the input the loop was handed.
          const wired = loopReturnSources(graph, id).length > 0;
          const value = wired
            ? reshapeLike(state.original, state.collected)
            : state.original;
          results[id] = value;
          portResults[portKey(id, "done")] = value;
          takenPort.set(id, "done");
          for (const bodyId of bodies.get(id) ?? []) finished.add(bodyId);
          states[id] = {
            status: "ok",
            result: value,
            inputs: {
              batches: state.iterations,
              collected: state.collected.length,
              ...(wired ? {} : { note: "nothing wires back into this node" }),
            },
            inputErrors,
            branch: "done",
            ports: { done: value },
            iterations: state.iterations,
            rows: rowCount(value),
            ms: Date.now() - startedAt,
          };
          break;
        }

        case "merge": {
          const sources = inputValues(graph, id, results, portResults);
          const { value, summary } = mergeInputs(sources, node.mode, node.field ?? "");
          results[id] = value;
          states[id] = {
            status: "ok",
            result: value,
            inputs: summary,
            inputErrors,
            rows: rowCount(value),
            ms: Date.now() - startedAt,
          };
          break;
        }

        case "compare": {
          const [a, b] = inputValues(graph, id, results, portResults);
          const buckets = compareDatasets(a, b, node.keyA ?? "", node.keyB ?? "", node.resolve);
          const perPort: Record<string, unknown> = {};
          for (const [port, rows] of Object.entries(buckets)) {
            perPort[port] = reshapeLike(port === "inB" ? b : a, rows);
            portResults[portKey(id, port)] = perPort[port];
          }
          // The node's own result is the tally: each port carries its bucket.
          const summary = Object.fromEntries(
            Object.entries(buckets).map(([port, rows]) => [port, rows.length])
          );
          results[id] = summary;
          states[id] = {
            status: "ok",
            result: summary,
            inputs: { key: node.keyA || "whole row", resolve: node.resolve },
            inputErrors,
            ports: perPort,
            ms: Date.now() - startedAt,
          };
          break;
        }

        case "subflow": {
          const value = await runSubflow(node.flowId, passthrough, host, stack, signal);
          results[id] = value.output;
          states[id] = {
            status: "ok",
            result: value.output,
            inputs: { flow: value.name, nodes: value.ran },
            inputErrors,
            rows: rowCount(value.output),
            ms: Date.now() - startedAt,
          };
          break;
        }

        case "stop": {
          const { value, error } = evaluateTemplate(node.message ?? "", contextFor(node, scope()));
          if (error) throw new FlowStopError(node.message || "Stopped by the flow.");
          throw new FlowStopError(String(value ?? "").trim() || "Stopped by the flow.");
        }

        case "wait": {
          let ms = Math.max(0, Math.floor(node.waitMs || 0));
          let until: string | undefined;
          if (node.mode === "until") {
            const evaluated = evaluateTemplate(node.until ?? "", contextFor(node, scope()));
            if (evaluated.error) throw new Error(evaluated.error);
            const at = new Date(String(evaluated.value ?? ""));
            if (Number.isNaN(at.getTime())) {
              throw new Error(`"${String(evaluated.value ?? "")}" is not a date.`);
            }
            until = at.toISOString();
            ms = Math.max(0, at.getTime() - Date.now());
          }
          const capped = Math.min(ms, MAX_WAIT_MS);
          await host.sleep(capped);
          results[id] = passthrough;
          states[id] = {
            status: "ok",
            result: passthrough,
            inputs: {
              waited: `${capped}ms`,
              ...(until ? { until } : {}),
              ...(capped < ms ? { capped: `${MAX_WAIT_MS}ms is the limit` } : {}),
            },
            inputErrors,
            rows: rowCount(passthrough),
            ms: Date.now() - startedAt,
          };
          break;
        }

        case "agent": {
          const ctx = contextFor(node, scope());
          const prompt = evaluateTemplate(node.prompt ?? "", ctx);
          if (prompt.error) throw new Error(prompt.error);
          const run = await host.runAgent({
            provider: node.provider,
            prompt: String(prompt.value ?? ""),
            model: node.model,
            cwd: node.cwd,
            outputMode: node.outputMode === "json" ? "json" : "text",
            autoApprove: node.autoApprove,
            extraArgs: node.extraArgs,
            timeoutMs: node.timeoutMs,
            // Agents take minutes, so the canvas gets their output as it lands
            // rather than all at once when the node finishes.
            onLine: (line) => emit({ type: "node-log", id, line }),
            signal,
          });
          results[id] = run.value;
          states[id] = {
            status: "ok",
            result: run.value,
            inputs: {
              agent: describeAgent(node),
              command: run.command,
              cwd: run.cwd,
              prompt: String(prompt.value ?? ""),
            },
            inputErrors,
            logs: run.logs.length ? run.logs : undefined,
            rows: rowCount(run.value),
            ms: Date.now() - startedAt,
          };
          break;
        }

        case "code": {
          const ctx = contextFor(node, scope());
          const { value, logs } = await host.runCode(
            node.code ?? "",
            { $json: ctx.$json, $node: ctx.$node, now },
            node.timeoutMs
          );
          results[id] = value;
          states[id] = {
            status: "ok",
            result: value,
            inputErrors,
            logs: logs.length ? logs : undefined,
            rows: rowCount(value),
            ms: Date.now() - startedAt,
          };
          break;
        }

        default: {
          const result = await host.executeService(
            node.collection,
            node.entityName,
            node.serviceName,
            inputs
          );
          results[id] = result;
          states[id] = {
            status: "ok",
            result,
            inputs,
            inputErrors,
            rows: rowCount(result),
            ms: Date.now() - startedAt,
          };
        }
      }
      executed.push(id);
    } catch (e) {
      dead.add(id);
      states[id] = {
        status: "error",
        error: e instanceof Error ? e.message : String(e),
        inputs: node.kind === "service" ? inputs : undefined,
        inputErrors,
        logs: (e as { logs?: string[] })?.logs,
        ms: Date.now() - startedAt,
      };
      emit({ type: "node-end", id, state: states[id] });
      // A Stop and Error node — here or in a sub-flow — ends the run outright.
      if (e instanceof FlowStopError) throw e;
      continue;
    }

    emit({ type: "node-end", id, state: states[id] });

    // End of a loop body: hand what came back to the Loop node and rewind. The
    // batch index always advances, so this cannot spin for ever.
    const loopId = returnsTo.get(id);
    const loopAt = loopId === undefined ? undefined : planIndex.get(loopId);
    if (loopId !== undefined && loopAt !== undefined && loops.has(loopId)) {
      // Only the port that was actually taken sends anything back. A nested
      // Loop, for instance, returns to the outer one from `done` — while it is
      // still handing out its own batches the run carries on into its body.
      const returning = graph.edges.some((e) => {
        if (e.source !== id || e.target !== loopId || !back.has(e.id)) return false;
        const port = portOf(e, node);
        if (!port) return true;
        const taken = takenPort.get(id);
        return taken === undefined || taken === port;
      });
      if (returning) {
        const state = loops.get(loopId)!;
        if (!dead.has(id)) state.collected.push(...toRows(results[id]));
        restartBody(loopId);
        pc = loopAt;
      }
    }
  }

  // A circle in the wiring is a fault in the flow, not a node quietly sitting
  // out, so each node involved says which circle it is in and who else is in it.
  if (cycle.length) {
    const { loops, blocked } = cycleParts(graph, cycle);
    const labelOf = (id: string) => byId.get(id)?.label ?? id;
    const named = new Map<string, string>();

    for (const loop of loops) {
      const round = [...loop, loop[0]].map(labelOf).join(" → ");
      for (const id of loop) named.set(id, round);
      for (const id of loop) {
        states[id] = {
          status: "error",
          error: `This node is wired in a circle: ${round}. Nothing in the circle can run until one of those connections is removed — use a Loop node to repeat work.`,
          ms: 0,
        };
        emit({ type: "node-end", id, state: states[id] });
      }
    }

    const circles = [...new Set(named.values())];
    for (const id of blocked) {
      const which = circles.length === 1 ? ` (${circles[0]})` : "";
      states[id] = {
        status: "skipped",
        error: `Never reached: something upstream of this node is wired in a circle${which}.`,
        ms: 0,
      };
      emit({ type: "node-end", id, state: states[id] });
    }
  }

  // What the flow "returned": the last node nothing else reads from.
  const leaves = executed.filter(
    (id) => !graph.edges.some((e) => e.source === id && !back.has(e.id))
  );
  const outputId = leaves[leaves.length - 1] ?? executed[executed.length - 1];

  return {
    order: plan,
    cycle,
    states,
    results,
    output: outputId ? results[outputId] : undefined,
  };
}

/* ------------------------------------------------------------- sub-flows -- */

async function runSubflow(
  flowId: string,
  input: unknown,
  host: FlowHost,
  stack: string[],
  signal?: { readonly aborted: boolean }
): Promise<{ output: unknown; name: string; ran: number }> {
  if (!flowId) throw new Error("No sub-flow selected.");
  if (stack.includes(flowId)) throw new Error("That sub-flow is already running — no recursion.");
  if (stack.length >= MAX_DEPTH) throw new Error(`Sub-flows may not nest more than ${MAX_DEPTH} deep.`);

  const row = await host.loadFlow(flowId);
  if (!row) throw new Error("That sub-flow no longer exists.");

  const child = await runFlow({
    graph: parseGraph(row.graph),
    host,
    rootInput: input,
    stack: [...stack, flowId],
    signal,
  });

  // A failure inside the sub-flow is a failure of the node that called it.
  const failed = child.order
    .map((id) => child.states[id])
    .find((state) => state?.status === "error");
  if (failed) throw new Error(`${row.name}: ${failed.error}`);

  return { output: child.output, name: row.name, ran: child.order.length };
}
