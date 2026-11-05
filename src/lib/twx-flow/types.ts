import type { ServiceParam, ServiceResultType } from "@/lib/twx/types";

/** One column of an infotable, taken from a DataShape or from a live result. */
export type FieldDef = {
  name: string;
  baseType: string;
  description?: string;
  ordinal?: number;
};

/**
 * What a node emits, known *before* it ever runs.
 *
 * For an INFOTABLE result the DataShape named by the service definition is
 * resolved once (when the node is dropped) so downstream nodes can map columns
 * without anybody pressing Run.
 */
export type OutputSchema = {
  baseType: string;
  /** DataShape name, when the result type declares one. */
  dataShape?: string;
  /** Columns in ordinal order. Empty when the shape could not be resolved. */
  fields: FieldDef[];
};

/**
 * What a node *does*. Boards saved before this existed hold service calls only,
 * so `parseGraph` stamps `"service"` on anything without a kind.
 */
export type NodeKind =
  | "service"
  | "code"
  | "agent"
  | "if"
  | "filter"
  | "switch"
  | "loop"
  | "merge"
  | "compare"
  | "subflow"
  | "stop"
  | "wait";

type NodeBase = {
  id: string;
  x: number;
  y: number;
  /** Node title, unique-ish: expressions address other nodes by this name. */
  label: string;
  notes?: string;
  /** A disabled node is skipped at run time and passes its input through. */
  disabled?: boolean;
  /** Raw parameter values. Anything containing `{{ … }}` is an expression. */
  inputs: Record<string, string>;
};

/**
 * A ThingWorx service call on the canvas.
 *
 * Wires carry execution order and the implicit `$json` reference only —
 * parameter values live on the node itself, as literals or `{{ }}` expressions.
 */
export type ServiceNode = NodeBase & {
  kind: "service";
  /** REST collection, e.g. "Things", "Resources". */
  collection: string;
  entityName: string;
  serviceName: string;
  params: ServiceParam[];
  resultType: ServiceResultType;
  outputSchema?: OutputSchema;
};

/**
 * Arbitrary JavaScript, run server-side in an `isolated-vm` isolate with no
 * network, no filesystem and no timers of its own. Whatever the snippet returns
 * becomes the node's output.
 */
export type CodeNode = NodeBase & {
  kind: "code";
  code: string;
  /** Wall-clock budget for the isolate, in milliseconds. */
  timeoutMs?: number;
};

/** Which coding-agent CLI an Agent node drives. One node kind, four faces. */
export type AgentProvider = "claude" | "codex" | "copilot" | "antigravity";

/**
 * Hands a prompt to a coding-agent CLI installed on the server and emits what
 * it printed.
 *
 * Unlike a Code node this is a real child process with real tools — it can read
 * and write the filesystem it runs in. The runner refuses to start one unless
 * the server opts in; see `agent-run.ts`.
 */
export type AgentNode = NodeBase & {
  kind: "agent";
  provider: AgentProvider;
  /** What the agent is asked to do. Expressions allowed. */
  prompt: string;
  /** Model name passed straight through to the CLI. Empty means its default. */
  model?: string;
  /** Directory the agent runs in. Relative paths resolve against the sandbox root. */
  cwd?: string;
  /** `json` parses the CLI's machine-readable output; `text` keeps it verbatim. */
  outputMode: "text" | "json";
  /** Let the agent run its own tools unattended. Off by default, for good reason. */
  autoApprove?: boolean;
  /** Extra argv appended to the command, split on spaces (quotes respected). */
  extraArgs?: string;
  /** Wall-clock budget for the process, in milliseconds. */
  timeoutMs?: number;
};

/**
 * A two-way branch. The node itself emits its input untouched; which of its two
 * output ports the run continues down is decided by `condition`.
 */
export type IfNode = NodeBase & {
  kind: "if";
  /** A `{{ … }}` expression; its truthiness picks the branch. */
  condition: string;
};

/** Tests a Filter condition can apply. See `OPERATORS` for what each means. */
export type FilterOperator =
  | "eq"
  | "neq"
  | "exists"
  | "notExists"
  | "isEmpty"
  | "isNotEmpty"
  | "contains"
  | "notContains"
  | "startsWith"
  | "endsWith"
  | "regex"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "after"
  | "before"
  | "isTrue"
  | "isFalse";

/**
 * One row of the condition builder.
 *
 * `left` is a column of the row being tested — an infotable field name — and
 * `right` the value it is compared with. Either side may hold `{{ … }}`
 * instead, which is evaluated with `$item` bound to that row.
 */
export type FilterCondition = {
  id: string;
  left: string;
  operator: FilterOperator;
  right: string;
};

/**
 * Keeps the rows of its input that pass its conditions, drops the rest.
 *
 * Two ways to say the same thing: `mode: "rules"` uses the builder, and
 * `mode: "expression"` a single `{{ … }}` condition evaluated per row with
 * `$item` bound. Boards saved before the builder existed are in expression mode.
 */
export type FilterNode = NodeBase & {
  kind: "filter";
  mode: "rules" | "expression";
  conditions: FilterCondition[];
  /** How the conditions are combined. */
  combinator: "and" | "or";
  /** Compare loosely — `"12"` counts as 12 — instead of demanding exact types. */
  convertTypes: boolean;
  /** The whole test, for `mode: "expression"`. */
  condition: string;
};

/** One output of a Switch, and the test that sends the run down it. */
export type SwitchRule = {
  id: string;
  /** Port label on the card. */
  name: string;
  condition: string;
};

/**
 * A branch with as many outputs as it has rules. The first rule whose condition
 * is truthy wins; when none match the run takes `fallback`, if that port exists.
 */
export type SwitchNode = NodeBase & {
  kind: "switch";
  rules: SwitchRule[];
  /** Adds an extra "fallback" port for input that matched no rule. */
  fallback: boolean;
};

/**
 * Split In Batches. Emits `batchSize` rows at a time on its `loop` port; wire
 * the end of the loop body back into it and the next batch goes round. Once the
 * input is exhausted everything the body sent back leaves by `done`.
 */
export type LoopNode = NodeBase & {
  kind: "loop";
  batchSize: number;
};

/** How a Merge node puts its two (or more) inputs together. */
export type MergeMode = "append" | "position" | "field" | "branch";

export type MergeNode = NodeBase & {
  kind: "merge";
  mode: MergeMode;
  /** Field to join on, for `mode: "field"`. Comma-separated for a compound key. */
  field: string;
};

/**
 * Compares two inputs row by row on a key and sorts the result into four
 * outputs: only in A, same, different, only in B.
 */
export type CompareNode = NodeBase & {
  kind: "compare";
  /** Key field(s) in input 1. Comma-separated for a compound key. */
  keyA: string;
  /** Key field(s) in input 2. Empty means "the same names as input 1". */
  keyB: string;
  /** Which side's version of a differing row leaves by the `different` port. */
  resolve: "a" | "b";
};

/** Runs another saved flow and emits whatever that flow's last node returned. */
export type SubflowNode = NodeBase & {
  kind: "subflow";
  flowId: string;
  /** Last known name of the target, so the card reads sensibly offline. */
  flowName?: string;
};

/** Aborts the whole run on purpose. */
export type StopNode = NodeBase & {
  kind: "stop";
  /** Error text, expressions allowed. */
  message: string;
};

export type WaitNode = NodeBase & {
  kind: "wait";
  mode: "interval" | "until";
  /** Pause length for `mode: "interval"`. */
  waitMs: number;
  /** A date or ISO timestamp to wait for, for `mode: "until"`. */
  until: string;
};

export type FlowNode =
  | ServiceNode
  | CodeNode
  | AgentNode
  | IfNode
  | FilterNode
  | SwitchNode
  | LoopNode
  | MergeNode
  | CompareNode
  | SubflowNode
  | StopNode
  | WaitNode;

type FieldNames<T> = T extends unknown ? keyof T : never;
type FieldType<T, K extends PropertyKey> = T extends unknown
  ? K extends keyof T
    ? T[K]
    : never
  : never;

/**
 * A patch for one node. Node kinds share an editor, so a patch is allowed to
 * name any kind's fields — `patchNode` merges it onto whichever node it
 * targets. Fields two kinds both declare (`mode`, say) accept either kind's
 * values here; the node types themselves stay exact.
 */
export type NodePatch = {
  [K in Exclude<FieldNames<FlowNode>, "kind">]?: FieldType<FlowNode, K>;
};

export const isServiceNode = (node: FlowNode): node is ServiceNode => node.kind === "service";
export const isCodeNode = (node: FlowNode): node is CodeNode => node.kind === "code";
export const isAgentNode = (node: FlowNode): node is AgentNode => node.kind === "agent";
export const isIfNode = (node: FlowNode): node is IfNode => node.kind === "if";

/**
 * Which output port of a branching node a wire leaves from.
 *
 * Port ids are per kind: `"true"` / `"false"` for If, `"loop"` / `"done"` for
 * Loop, a rule index or `"fallback"` for Switch, and the four dataset buckets
 * for Compare Datasets. Absent means "the one output there is".
 */
export type EdgePort = string;

/** A wire. Node-level, like n8n: it means "runs after, and feeds `$json`". */
export type FlowEdge = {
  id: string;
  source: string;
  target: string;
  /** Only meaningful when the source has more than one output port. */
  sourcePort?: EdgePort;
};

export type FlowGraph = {
  nodes: FlowNode[];
  edges: FlowEdge[];
};

export type NodeStatus = "running" | "ok" | "error" | "skipped" | "disabled";

export type NodeRunState = {
  status: NodeStatus;
  result?: unknown;
  /** Inputs actually sent, after expression evaluation and coercion. */
  inputs?: Record<string, unknown>;
  /** Per-parameter expression failures — the run continues without them. */
  inputErrors?: Record<string, string>;
  error?: string;
  ms: number;
  /** Row count when the result is an infotable. */
  rows?: number;
  /** Port a branching node sent the run down, so the canvas can dim the rest. */
  branch?: EdgePort;
  /**
   * Outputs that differ per port — a Compare's four buckets, a Loop's batch and
   * its collected rows. Sent back with the next run so re-running one node
   * downstream still sees what its own wire carries.
   */
  ports?: Record<EdgePort, unknown>;
  /** How many times a Loop node went round. */
  iterations?: number;
  /** Anything a code node passed to `console.log`. */
  logs?: string[];
};

/** Streamed over SSE so the canvas can light nodes up as they execute. */
export type RunEvent =
  | { type: "start"; order: string[]; cycle: string[] }
  | { type: "node-start"; id: string }
  | { type: "node-end"; id: string; state: NodeRunState }
  /** A line an Agent node's CLI printed while it was still running. */
  | { type: "node-log"; id: string; line: string }
  | { type: "done" }
  | { type: "error"; message: string };

export type FlowRunResult = {
  order: string[];
  nodes: Record<string, NodeRunState>;
  cycle: string[];
};
