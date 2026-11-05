import { testConditions } from "./conditions";
import { evaluateTemplate, isExpression, referencedNodes, type ExprContext } from "./expression";
import { newId } from "./ids";
import { defaultsFor, newCondition, outputPorts } from "./nodes";
import type {
  EdgePort,
  FilterCondition,
  FilterNode,
  FlowEdge,
  FlowGraph,
  FlowNode,
  ServiceNode,
  SwitchRule,
} from "./types";

export const emptyGraph = (): FlowGraph => ({ nodes: [], edges: [] });

export { newId };

/* ------------------------------------------------------------ persistence -- */

/** The pre-expression wire shape: one edge per bound parameter. */
type LegacyEdge = FlowEdge & {
  targetParam?: string;
  path?: string;
  mapping?:
    | { mode: "all" }
    | { mode: "rows"; rows: number[]; fields: string[] }
    | { mode: "cell"; row: number; field: string }
    | { mode: "path"; path: string };
};

const ref = (label: string) => `$node[${JSON.stringify(label)}]`;

const joinPath = (base: string, path: string) =>
  !path ? base : path.startsWith("[") ? `${base}${path}` : `${base}.${path}`;

/** Rewrites one legacy wire as the expression that now replaces it. */
function legacyExpression(sourceLabel: string, edge: LegacyEdge): string {
  const base = ref(sourceLabel);
  const mapping = edge.mapping ?? (edge.path ? { mode: "path" as const, path: edge.path } : { mode: "all" as const });

  switch (mapping.mode) {
    case "all":
      return `{{ ${base} }}`;
    case "path":
      return `{{ ${joinPath(base, mapping.path)} }}`;
    case "cell":
      return `{{ ${base}.rows[${mapping.row}].${mapping.field} }}`;
    case "rows": {
      if (!mapping.rows.length) return `{{ ${base} }}`;
      const row = (index: number) =>
        mapping.fields.length
          ? `{ ${mapping.fields.map((f) => `${f}: ${base}.rows[${index}].${f}`).join(", ")} }`
          : `${base}.rows[${index}]`;
      return `{{ { dataShape: ${base}.dataShape, rows: [${mapping.rows.map(row).join(", ")}] } }}`;
    }
  }
}

/**
 * Every node in a board saved before Code and If nodes existed is a service,
 * and every flow-control node saved before a field was added has to survive
 * meeting a build that expects it — so each kind is filled in from its defaults.
 */
function normalizeNode(raw: FlowNode): FlowNode {
  const node = { ...raw, inputs: raw.inputs ?? {} };
  switch (node.kind) {
    case "filter": {
      // Read as "whatever was saved": older boards have no builder fields at all.
      const saved = node as Partial<FilterNode>;
      const filled = { ...defaultsFor("filter"), ...node } as FilterNode;
      const conditions: FilterCondition[] = (
        Array.isArray(saved.conditions) ? saved.conditions : filled.conditions
      ).map((c) => ({ ...newCondition(), ...c }));
      return {
        ...filled,
        conditions,
        // A board saved before the builder existed holds an expression, and
        // switching it to the builder silently would drop that expression.
        mode: saved.mode ?? (saved.condition?.trim() ? "expression" : "rules"),
      };
    }
    case "code":
    case "agent":
    case "if":
    case "loop":
    case "merge":
    case "compare":
    case "subflow":
    case "stop":
    case "wait":
      return { ...defaultsFor(node.kind), ...node } as FlowNode;
    case "switch": {
      const rules: SwitchRule[] = (Array.isArray(node.rules) ? node.rules : []).map(
        (rule, index) => ({
          id: rule?.id ?? newId(),
          name: rule?.name ?? `rule ${index + 1}`,
          condition: rule?.condition ?? "",
        })
      );
      return { ...defaultsFor("switch"), ...node, rules } as FlowNode;
    }
    default: {
      const service = node as ServiceNode;
      return {
        ...service,
        kind: "service",
        params: Array.isArray(service.params) ? service.params : [],
      };
    }
  }
}

/**
 * Tolerant read of the persisted `graph` column — never throws.
 *
 * Boards saved by the per-parameter-wire editor are migrated in place: each old
 * wire becomes a node-level connection plus an expression on the parameter it
 * used to feed.
 */
export function parseGraph(json: string): FlowGraph {
  let parsed: Partial<FlowGraph>;
  try {
    parsed = JSON.parse(json) as Partial<FlowGraph>;
  } catch {
    return emptyGraph();
  }

  const nodes: FlowNode[] = (Array.isArray(parsed.nodes) ? parsed.nodes : []).map(normalizeNode);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const rawEdges = (Array.isArray(parsed.edges) ? parsed.edges : []) as LegacyEdge[];

  const edges: FlowEdge[] = [];
  const connected = new Set<string>();

  for (const edge of rawEdges) {
    const source = byId.get(edge.source);
    const target = byId.get(edge.target);
    // Drop wires whose endpoints no longer exist rather than rendering ghosts.
    if (!source || !target || source.id === target.id) continue;

    if (edge.targetParam) {
      const existing = target.inputs[edge.targetParam];
      if (!existing || !isExpression(existing)) {
        target.inputs[edge.targetParam] = legacyExpression(source.label, edge);
      }
    }

    // A branch node can legitimately reach the same target down two ports, so
    // the port is part of a wire's identity.
    const port = portOf(edge, source);
    const key = `${edge.source}:${port ?? ""}->${edge.target}`;
    if (connected.has(key)) continue;
    connected.add(key);
    edges.push({
      id: edge.id ?? newId(),
      source: edge.source,
      target: edge.target,
      ...(port ? { sourcePort: port } : {}),
    });
  }

  return { nodes, edges };
}

/* ----------------------------------------------------------------- labels -- */

/** Expressions address nodes by title, so titles have to stay unique. */
export function uniqueLabel(nodes: FlowNode[], desired: string, ignoreId?: string): string {
  const taken = new Set(nodes.filter((n) => n.id !== ignoreId).map((n) => n.label));
  if (!taken.has(desired)) return desired;
  for (let i = 1; ; i++) {
    const candidate = `${desired} ${i}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * Every piece of user-authored text on a node that may name another node:
 * parameter values, a branch condition, a code snippet.
 */
export function expressionSources(node: FlowNode): string[] {
  const out = Object.values(node.inputs ?? {});
  switch (node.kind) {
    case "if":
      out.push(node.condition ?? "");
      break;
    case "filter":
      out.push(node.condition ?? "");
      for (const c of node.conditions ?? []) out.push(c.left ?? "", c.right ?? "");
      break;
    case "code":
      out.push(node.code ?? "");
      break;
    case "switch":
      for (const rule of node.rules ?? []) out.push(rule.condition ?? "");
      break;
    case "stop":
      out.push(node.message ?? "");
      break;
    case "wait":
      out.push(node.until ?? "");
      break;
  }
  return out;
}

/** Keeps `$node["old"]` / `$("old")` references pointing at a renamed node. */
export function renameReferences(graph: FlowGraph, from: string, to: string): FlowGraph {
  if (from === to) return graph;
  const newRef = JSON.stringify(to);
  const rewrite = (raw: string) =>
    (raw ?? "")
      .replace(
        /(\$node\s*\[\s*)(["'`])([^"'`]+)\2(\s*\])/g,
        (m, open, _q, name, close) => (name === from ? `${open}${newRef}${close}` : m)
      )
      .replace(
        /(\$\s*\(\s*)(["'`])([^"'`]+)\2(\s*\))/g,
        (m, open, _q, name, close) => (name === from ? `${open}${newRef}${close}` : m)
      );

  return {
    ...graph,
    nodes: graph.nodes.map((n) => {
      const inputs = Object.fromEntries(
        Object.entries(n.inputs ?? {}).map(([key, value]) => [key, rewrite(value)])
      );
      switch (n.kind) {
        case "if":
          return { ...n, inputs, condition: rewrite(n.condition) };
        case "filter":
          return {
            ...n,
            inputs,
            condition: rewrite(n.condition),
            conditions: (n.conditions ?? []).map((c) => ({
              ...c,
              left: rewrite(c.left),
              right: rewrite(c.right),
            })),
          };
        case "code":
          return { ...n, inputs, code: rewrite(n.code) };
        case "switch":
          return {
            ...n,
            inputs,
            rules: (n.rules ?? []).map((rule) => ({
              ...rule,
              condition: rewrite(rule.condition),
            })),
          };
        case "stop":
          return { ...n, inputs, message: rewrite(n.message) };
        case "wait":
          return { ...n, inputs, until: rewrite(n.until) };
        default:
          return { ...n, inputs };
      }
    }),
  };
}

/* ------------------------------------------------------------------ order -- */

/**
 * Connections plus the dependencies implied by expressions: writing
 * `$node["Fetch"]` in a parameter makes this node run after "Fetch", wire or no
 * wire.
 */
export function effectiveEdges(graph: FlowGraph): FlowEdge[] {
  const byLabel = new Map(graph.nodes.map((n) => [n.label, n.id]));
  // A loop's return wire is an ordering *back* edge; counting it would put the
  // whole body on a cycle.
  const back = backEdgeIds(graph);
  const forward = graph.edges.filter((e) => !back.has(e.id));
  const seen = new Set(forward.map((e) => `${e.source}->${e.target}`));
  const out = [...forward];

  for (const node of graph.nodes) {
    for (const raw of expressionSources(node)) {
      for (const label of referencedNodes(raw)) {
        const source = byLabel.get(label);
        if (!source || source === node.id) continue;
        const key = `${source}->${node.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ id: `implicit:${key}`, source, target: node.id });
      }
    }
  }
  return out;
}

/** Topmost first, then leftmost, then by id so the order is never arbitrary. */
function canvasOrder(nodes: FlowNode[]): (a: string, b: string) => number {
  const placed = new Map(nodes.map((n) => [n.id, n]));
  return (a, b) => {
    const one = placed.get(a);
    const two = placed.get(b);
    if (!one || !two) return 0;
    return (one.y ?? 0) - (two.y ?? 0) || (one.x ?? 0) - (two.x ?? 0) || a.localeCompare(b);
  };
}

/**
 * The order nodes run in: one branch at a time, all the way down, before the
 * next branch starts — the same rule n8n settled on in 1.0.
 *
 * It is still a topological order — a node runs only once everything feeding it
 * has — but of the nodes that are ready at any moment the run picks up where it
 * just left off, so a branch is followed to its end rather than every branch
 * being advanced a step at a time. Which branch goes first is not something the
 * wiring says, so the canvas decides: topmost, then leftmost.
 *
 * Nodes on a cycle are reported separately instead of being silently dropped,
 * so the UI can point at them.
 */
export function topoSort(graph: FlowGraph): { order: string[]; cycle: string[] } {
  const edges = effectiveEdges(graph);
  const indegree = new Map<string, number>();
  const outgoing = new Map<string, string[]>();
  for (const n of graph.nodes) {
    indegree.set(n.id, 0);
    outgoing.set(n.id, []);
  }
  for (const e of edges) {
    if (!indegree.has(e.source) || !indegree.has(e.target)) continue;
    outgoing.get(e.source)!.push(e.target);
    indegree.set(e.target, (indegree.get(e.target) ?? 0) + 1);
  }

  const before = canvasOrder(graph.nodes);
  // A stack, so the branch just entered is the one carried on with. Each fresh
  // set of ready nodes is pushed worst-first, leaving the topmost on top.
  const stack = graph.nodes.filter((n) => indegree.get(n.id) === 0).map((n) => n.id);
  stack.sort(before).reverse();

  const order: string[] = [];
  while (stack.length) {
    const id = stack.pop()!;
    order.push(id);
    const freed: string[] = [];
    for (const next of outgoing.get(id) ?? []) {
      const left = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, left);
      // A node fed from several branches waits for the last of them, which is
      // what makes a Merge sit at the point the branches come back together.
      if (left === 0) freed.push(next);
    }
    if (freed.length) stack.push(...freed.sort(before).reverse());
  }

  const ordered = new Set(order);
  return { order, cycle: graph.nodes.filter((n) => !ordered.has(n.id)).map((n) => n.id) };
}

/**
 * Splits the nodes `topoSort` could not place into the circles they actually
 * form and the ones merely stuck behind such a circle. Telling a node it is in
 * a loop when it only feeds off one sends people looking at the wrong wires,
 * so the two are kept apart — the loops are the strongly connected components,
 * everything else is downstream of one.
 *
 * Each loop is returned in walking order, so it reads as the round trip it is.
 */
export function cycleParts(
  graph: FlowGraph,
  cycle: string[]
): { loops: string[][]; blocked: string[] } {
  const inCycle = new Set(cycle);
  const next = new Map<string, string[]>(cycle.map((id) => [id, []]));
  for (const e of effectiveEdges(graph)) {
    if (inCycle.has(e.source) && inCycle.has(e.target)) next.get(e.source)!.push(e.target);
  }

  // Tarjan, iterated rather than recursed so a wide graph cannot blow the stack.
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const path: string[] = [];
  const groups: string[][] = [];
  let counter = 0;

  for (const root of cycle) {
    if (index.has(root)) continue;
    const work: Array<{ id: string; edge: number }> = [{ id: root, edge: 0 }];
    index.set(root, counter);
    low.set(root, counter++);
    path.push(root);
    onStack.add(root);

    while (work.length) {
      const frame = work[work.length - 1];
      const edges = next.get(frame.id)!;
      if (frame.edge < edges.length) {
        const child = edges[frame.edge++];
        if (!index.has(child)) {
          index.set(child, counter);
          low.set(child, counter++);
          path.push(child);
          onStack.add(child);
          work.push({ id: child, edge: 0 });
        } else if (onStack.has(child)) {
          low.set(frame.id, Math.min(low.get(frame.id)!, index.get(child)!));
        }
        continue;
      }

      work.pop();
      const parent = work[work.length - 1];
      if (parent) low.set(parent.id, Math.min(low.get(parent.id)!, low.get(frame.id)!));
      if (low.get(frame.id) === index.get(frame.id)) {
        const group: string[] = [];
        for (;;) {
          const id = path.pop()!;
          onStack.delete(id);
          group.push(id);
          if (id === frame.id) break;
        }
        groups.push(group);
      }
    }
  }

  const loops: string[][] = [];
  const looping = new Set<string>();
  for (const group of groups) {
    // A lone node is only a loop if it is wired to itself.
    const isLoop = group.length > 1 || next.get(group[0])!.includes(group[0]);
    if (!isLoop) continue;
    loops.push(walkOrder(group, next));
    for (const id of group) looping.add(id);
  }

  return { loops, blocked: cycle.filter((id) => !looping.has(id)) };
}

/** Follows the wires around a circle so its nodes list in the order they run. */
function walkOrder(group: string[], next: Map<string, string[]>): string[] {
  const members = new Set(group);
  const out: string[] = [];
  let id = group[group.length - 1];
  while (id && !out.includes(id)) {
    out.push(id);
    members.delete(id);
    id = (next.get(id) ?? []).find((n) => members.has(n))!;
  }
  // A component whose walk hit a dead end still owes the rest of its nodes.
  return [...out, ...group.filter((n) => !out.includes(n))];
}

/** Node ids that `target` transitively depends on, plus `target` itself. */
export function ancestorsOf(graph: FlowGraph, target: string): Set<string> {
  const edges = effectiveEdges(graph);
  const keep = new Set<string>([target]);
  const stack = [target];
  while (stack.length) {
    const id = stack.pop()!;
    for (const e of edges) {
      if (e.target === id && !keep.has(e.source)) {
        keep.add(e.source);
        stack.push(e.source);
      }
    }
  }
  return keep;
}

/**
 * Direct upstream nodes, in wire order. The first one feeds `$json`.
 *
 * A loop's return wire is not an input in this sense — what comes back round is
 * collected by the Loop node itself, not offered as `$json`.
 */
export function parentsOf(graph: FlowGraph, nodeId: string): string[] {
  const back = backEdgeIds(graph);
  return graph.edges
    .filter((e) => e.target === nodeId && !back.has(e.id))
    .map((e) => e.source);
}

/** Nodes whose result comes back round into a Loop node at the end of a pass. */
export function loopReturnSources(graph: FlowGraph, loopId: string): string[] {
  const body = loopBody(graph, loopId);
  return graph.edges
    .filter((e) => e.target === loopId && body.has(e.source))
    .map((e) => e.source);
}

/* --------------------------------------------------------------- branches -- */

/**
 * Which port a wire leaves from. A node with a single output has none, and a
 * stray port on such a node is ignored; on a branching node an unknown port
 * falls back to the first one, so a rule being deleted cannot orphan a wire.
 */
export function portOf(edge: FlowEdge, source: FlowNode | undefined): EdgePort | undefined {
  if (!source) return undefined;
  const ports = outputPorts(source);
  if (ports.length <= 1) return undefined;
  return ports.some((p) => p.id === edge.sourcePort) ? edge.sourcePort : ports[0].id;
}

/** Vertical offset of one output port, as a fraction of the card's height. */
export function portFraction(index: number, count: number): number {
  return count <= 1 ? 0.5 : (index + 1) / (count + 1);
}

/* -------------------------------------------------------------------- loop -- */

/**
 * Wires that close a loop: they run from inside a Loop node's body back into
 * the Loop node itself. Those are what make the next batch go round, and they
 * have to be left out of the topological order — otherwise every node in the
 * body sits on a cycle and nothing is runnable.
 */
export function backEdgeIds(graph: FlowGraph): Set<string> {
  const out = new Set<string>();
  for (const node of graph.nodes) {
    if (node.kind !== "loop") continue;
    const body = loopBody(graph, node.id);
    for (const edge of graph.edges) {
      if (edge.target === node.id && body.has(edge.source)) out.add(edge.id);
    }
  }
  return out;
}

/**
 * Every node between a Loop node's `loop` port and the wires that come back to
 * it — i.e. the nodes that re-run once per batch.
 */
export function loopBody(graph: FlowGraph, loopId: string): Set<string> {
  const body = new Set<string>();
  const stack = graph.edges
    .filter((e) => e.source === loopId && e.sourcePort !== "done")
    .map((e) => e.target);

  while (stack.length) {
    const id = stack.pop()!;
    // Reaching the Loop node again closes the circle rather than widening it.
    if (id === loopId || body.has(id)) continue;
    body.add(id);
    for (const edge of graph.edges) {
      if (edge.source === id && edge.target !== loopId) stack.push(edge.target);
    }
  }
  return body;
}

/* ------------------------------------------------------------------ inputs -- */

const NUMERIC_TYPES = new Set(["NUMBER", "INTEGER", "LONG"]);
const OBJECT_TYPES = new Set(["INFOTABLE", "JSON", "TAGS", "LOCATION", "VEC2", "VEC3", "VEC4"]);

export const isObjectType = (baseType: string) => OBJECT_TYPES.has(baseType);

/** Turns a value into the shape the REST API expects for `baseType`. */
export function coerceValue(value: unknown, baseType: string): unknown {
  if (value === undefined || value === null) return undefined;

  if (typeof value !== "string") {
    // An expression already produced a typed value; only numbers need nudging.
    if (NUMERIC_TYPES.has(baseType) && typeof value === "boolean") return Number(value);
    return value;
  }
  if (value === "") return undefined;
  if (NUMERIC_TYPES.has(baseType)) {
    const n = Number(value);
    return Number.isNaN(n) ? value : n;
  }
  if (baseType === "BOOLEAN") return value === "true" || value === "1";
  if (OBJECT_TYPES.has(baseType)) {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
  return value;
}

/**
 * Results keyed by `nodeId::port`, for the nodes whose outputs differ per port
 * — a Loop's batch and its collected result, or the four buckets of a Compare.
 * Everything else is read straight from `results`.
 */
export type PortResults = Record<string, unknown>;

export const portKey = (nodeId: string, port: EdgePort) => `${nodeId}::${port}`;

/** What arrives down one wire: the source's output on the port the wire uses. */
export function valueOnEdge(
  graph: FlowGraph,
  edge: FlowEdge,
  results: Record<string, unknown>,
  portResults?: PortResults
): unknown {
  const source = graph.nodes.find((n) => n.id === edge.source);
  const port = portOf(edge, source);
  const keyed = port ? portResults?.[portKey(edge.source, port)] : undefined;
  return keyed !== undefined ? keyed : results[edge.source];
}

/** Everything wired into a node, in wire order. Merge and Compare read both. */
export function inputValues(
  graph: FlowGraph,
  nodeId: string,
  results: Record<string, unknown>,
  portResults?: PortResults
): unknown[] {
  const back = backEdgeIds(graph);
  return graph.edges
    .filter((e) => e.target === nodeId && !back.has(e.id))
    .map((e) => valueOnEdge(graph, e, results, portResults));
}

/**
 * What the run knows when a node's expressions are evaluated. The editor builds
 * one of these from sample data to preview a field; the runner builds one from
 * the real results.
 */
export type EvalScope = {
  graph: FlowGraph;
  results: Record<string, unknown>;
  /** Stable clock for the whole run. */
  now?: Date;
  /** `$json` for nodes with nothing wired in — a sub-flow's incoming data. */
  rootInput?: unknown;
  portResults?: PortResults;
};

/** Everything an expression on `node` can see. */
export function contextFor(node: FlowNode, scope: EvalScope): ExprContext {
  const { graph, results, now, rootInput, portResults } = scope;
  const [primary] = inputValues(graph, node.id, results, portResults);
  const $node: Record<string, unknown> = {};
  for (const n of graph.nodes) {
    if (n.id !== node.id && results[n.id] !== undefined) $node[n.label] = results[n.id];
  }
  return {
    $json: parentsOf(graph, node.id).length ? primary : rootInput,
    $node,
    now,
  };
}

export type BuiltInputs = {
  inputs: Record<string, unknown>;
  errors: Record<string, string>;
};

/** Evaluates every parameter of one node into the request body. */
export function buildInputs(node: FlowNode, scope: EvalScope): BuiltInputs {
  const ctx = contextFor(node, scope);
  const inputs: Record<string, unknown> = {};
  const errors: Record<string, string> = {};
  if (node.kind !== "service") return { inputs, errors };

  for (const param of node.params) {
    const raw = node.inputs?.[param.name] ?? "";
    if (raw === "") continue;
    const { value, error } = evaluateTemplate(raw, ctx);
    if (error) errors[param.name] = error;
    const coerced = coerceValue(value, param.baseType);
    if (coerced !== undefined) inputs[param.name] = coerced;
  }
  return { inputs, errors };
}

/**
 * Truthiness of an `if` node's condition.
 *
 * The same rules JavaScript uses, plus two the canvas needs: an empty array or
 * an infotable with no rows is false, because "did that lookup find anything"
 * is the question these branches are almost always asking.
 */
export function isTruthy(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (value && typeof value === "object") {
    const rows = (value as { rows?: unknown }).rows;
    if (Array.isArray(rows)) return rows.length > 0;
  }
  if (typeof value === "string") {
    const text = value.trim().toLowerCase();
    // A condition left in Fixed mode is plain text, and "false" means false.
    return text !== "" && text !== "false" && text !== "0";
  }
  return !!value;
}

/**
 * Nothing to evaluate: an empty field, or the empty `{{ }}` a field starts out
 * as when it is switched into expression mode.
 */
export const isBlankCondition = (raw: string) =>
  !(raw ?? "").replace(/\{\{|\}\}/g, "").trim();

export type BranchDecision = {
  branch?: EdgePort;
  value: unknown;
  error?: string;
};

/** Evaluates one `if` node's condition against the results so far. */
export function decideBranch(node: FlowNode, scope: EvalScope): BranchDecision {
  const raw = node.kind === "if" ? (node.condition ?? "") : "";
  if (isBlankCondition(raw)) return { branch: "false", value: undefined, error: "No condition set." };

  const { value, error } = evaluateTemplate(raw, contextFor(node, scope));
  // A condition that will not evaluate is not quietly treated as false.
  if (error) return { branch: "false", value, error };
  return { branch: isTruthy(value) ? "true" : "false", value };
}

/**
 * Which output of a Switch the run leaves by: the first rule that is truthy,
 * otherwise the fallback port — or no port at all when there is no fallback,
 * which leaves everything downstream unreached.
 */
export function decideSwitch(
  node: FlowNode,
  scope: EvalScope
): BranchDecision & { matched?: string } {
  if (node.kind !== "switch") return { branch: undefined, value: undefined };
  const ctx = contextFor(node, scope);

  for (const [index, rule] of (node.rules ?? []).entries()) {
    const raw = rule.condition ?? "";
    if (isBlankCondition(raw)) continue;
    const { value, error } = evaluateTemplate(raw, ctx);
    // A rule that will not evaluate stops the node rather than falling through
    // to a port the author did not choose.
    if (error) return { branch: undefined, value, error: `${rule.name || `rule ${index + 1}`}: ${error}` };
    if (isTruthy(value)) {
      return { branch: String(index), value, matched: rule.name || `rule ${index + 1}` };
    }
  }
  return node.fallback
    ? { branch: "fallback", value: undefined, matched: "fallback" }
    : { branch: undefined, value: undefined };
}

/**
 * Runs a Filter over rows, either way it can be written: the condition builder
 * row by row, or a single `{{ … }}` expression with `$item` bound to the row.
 */
export function filterRows(
  node: FlowNode,
  rows: Record<string, unknown>[],
  scope: EvalScope
): { kept: Record<string, unknown>[]; error?: string; warning?: string } {
  if (node.kind !== "filter") return { kept: rows };
  const base = contextFor(node, scope);
  const kept: Record<string, unknown>[] = [];
  let error: string | undefined;

  // A node that never went through `parseGraph` has no mode; a condition on it
  // is still a condition, and must not be quietly ignored.
  const saved = node as Partial<FilterNode>;
  const mode = saved.mode ?? (saved.condition?.trim() ? "expression" : "rules");

  if (mode === "expression") {
    const raw = node.condition ?? "";
    if (isBlankCondition(raw)) {
      return { kept: rows, warning: "No condition set — every row was kept." };
    }

    rows.forEach((row, index) => {
      const { value, error: failed } = evaluateTemplate(raw, {
        ...base,
        $item: row,
        $index: index,
      });
      if (failed) {
        // One broken row must not silently shrink the table: report the first
        // failure and keep nothing on its account.
        error ??= `Row ${index}: ${failed}`;
        return;
      }
      if (isTruthy(value)) kept.push(row);
    });
    return { kept, error };
  }

  const conditions = (node.conditions ?? []).filter((c) => (c.left ?? "").trim());
  if (!conditions.length) {
    return { kept: rows, warning: "No conditions set — every row was kept." };
  }

  rows.forEach((row, index) => {
    const outcome = testConditions(
      conditions,
      node.combinator ?? "and",
      !!node.convertTypes,
      row,
      { ...base, $item: row, $index: index }
    );
    if (outcome.error) error ??= `Row ${index}: ${outcome.error}`;
    if (outcome.pass) kept.push(row);
  });

  return { kept, error };
}

/** Short, human-readable summary of a parameter value for the node card. */
export function describeValue(raw: string): string {
  const text = (raw ?? "").trim();
  if (!text) return "";
  if (!isExpression(text)) return text.length > 28 ? `${text.slice(0, 28)}…` : text;
  const inner = text.replace(/\{\{|\}\}/g, "").trim();
  return inner.length > 28 ? `${inner.slice(0, 28)}…` : inner;
}
