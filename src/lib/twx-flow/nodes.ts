/**
 * What each node kind *is*, in data: its output ports, the defaults a fresh one
 * starts with, and the words the palette and the cards use for it.
 *
 * Deliberately free of React and of anything server-only, so the canvas, the
 * palette and the runner can all agree on the same catalogue.
 */

import { AGENT_DEFS, AGENT_PROVIDERS, DEFAULT_AGENT_TIMEOUT_MS, describeAgent } from "./agents";
import { describeCondition } from "./conditions";
import { newId } from "./ids";
import type {
  AgentProvider,
  FilterCondition,
  FlowNode,
  NodeKind,
  NodePatch,
  SwitchRule,
} from "./types";

/** One output on the right edge of a card. */
export type PortDef = {
  id: string;
  /** Drawn beside the port. Absent for nodes that have a single output. */
  label?: string;
  tone: "neutral" | "positive" | "negative" | "accent";
};

const MAIN: PortDef[] = [{ id: "main", tone: "neutral" }];

/**
 * The outputs of a node, in top-to-bottom order.
 *
 * A single-element list means "one unnamed port"; callers use `sourcePort`
 * only when there is more than one.
 */
export function outputPorts(node: FlowNode): PortDef[] {
  switch (node.kind) {
    case "if":
      return [
        { id: "true", label: "true", tone: "positive" },
        { id: "false", label: "false", tone: "negative" },
      ];
    case "switch": {
      const rules = node.rules ?? [];
      const ports: PortDef[] = rules.map((rule, index) => ({
        id: String(index),
        label: rule.name?.trim() || `rule ${index + 1}`,
        tone: "neutral",
      }));
      if (node.fallback) ports.push({ id: "fallback", label: "fallback", tone: "negative" });
      return ports.length ? ports : [{ id: "fallback", label: "fallback", tone: "negative" }];
    }
    case "loop":
      return [
        { id: "loop", label: "loop", tone: "accent" },
        { id: "done", label: "done", tone: "positive" },
      ];
    case "compare":
      return [
        { id: "inA", label: "in A only", tone: "neutral" },
        { id: "same", label: "same", tone: "positive" },
        { id: "different", label: "different", tone: "accent" },
        { id: "inB", label: "in B only", tone: "neutral" },
      ];
    // Nothing continues after a deliberate stop.
    case "stop":
      return [];
    default:
      return MAIN;
  }
}

/** How many wires a node expects to be fed. Wire order decides which is which. */
export function inputArity(kind: NodeKind): number {
  return kind === "merge" || kind === "compare" ? 2 : 1;
}

export const newRule = (index: number): SwitchRule => ({
  id: newId(),
  name: `rule ${index + 1}`,
  condition: "",
});

export const newCondition = (): FilterCondition => ({
  id: newId(),
  left: "",
  operator: "eq",
  right: "",
});

/** Everything but `id`, `x`, `y`, `label` and `inputs`, which the editor sets. */
export function defaultsFor(kind: Exclude<NodeKind, "service">): NodePatch {
  switch (kind) {
    case "code":
      return { code: "" };
    case "agent":
      return {
        provider: "claude",
        prompt: "",
        model: "",
        cwd: "",
        outputMode: "text",
        autoApprove: false,
        extraArgs: "",
        timeoutMs: DEFAULT_AGENT_TIMEOUT_MS,
      };
    case "if":
      return { condition: "" };
    case "filter":
      return {
        mode: "rules",
        conditions: [newCondition()],
        combinator: "and",
        convertTypes: false,
        condition: "",
      };
    case "switch":
      return { rules: [newRule(0), newRule(1)], fallback: true };
    case "loop":
      return { batchSize: 1 };
    case "merge":
      return { mode: "append", field: "" };
    case "compare":
      return { keyA: "", keyB: "", resolve: "b" };
    case "subflow":
      return { flowId: "" };
    case "stop":
      return { message: "Stopped by the flow." };
    case "wait":
      return { mode: "interval", waitMs: 1_000, until: "" };
  }
}

/**
 * Palette entry. `section` mirrors how n8n groups the same nodes.
 *
 * One kind may appear more than once: the four agent CLIs are all `agent`
 * nodes, told apart by the `patch` a fresh one is stamped with — so `key`, not
 * `kind`, is what identifies a row.
 */
export type NodeCatalogEntry = {
  key: string;
  kind: Exclude<NodeKind, "service">;
  title: string;
  hint: string;
  section: "Popular" | "Core" | "AI" | "Other";
  /** Defaults on top of the kind's own, for a preset entry. */
  patch?: NodePatch;
  /** Title a node dropped from this entry gets, when the kind's is too generic. */
  label?: string;
};

/** One palette row per agent CLI, all of them `agent` nodes underneath. */
const AGENT_ENTRIES: NodeCatalogEntry[] = AGENT_PROVIDERS.map((provider: AgentProvider) => ({
  key: `agent:${provider}`,
  kind: "agent" as const,
  title: AGENT_DEFS[provider].title,
  hint: AGENT_DEFS[provider].hint,
  section: "AI" as const,
  patch: { provider },
  label: AGENT_DEFS[provider].title.replace(/ CLI$/, ""),
}));

export const NODE_CATALOGUE: NodeCatalogEntry[] = [
  {
    key: "filter",
    kind: "filter",
    title: "Filter",
    hint: "Keep only rows matching a condition",
    section: "Popular",
  },
  {
    key: "if",
    kind: "if",
    title: "If",
    hint: "Route to different branches (true/false)",
    section: "Popular",
  },
  {
    key: "loop",
    kind: "loop",
    title: "Loop Over Items (Split in Batches)",
    hint: "Split data into batches and iterate over each batch",
    section: "Popular",
  },
  {
    key: "merge",
    kind: "merge",
    title: "Merge",
    hint: "Merges data of multiple streams once data from both is available",
    section: "Popular",
  },
  {
    key: "code",
    kind: "code",
    title: "Code",
    hint: "Reshape, filter or merge data with JavaScript",
    section: "Core",
  },
  {
    key: "compare",
    kind: "compare",
    title: "Compare Datasets",
    hint: "Compare two inputs for changes",
    section: "Other",
  },
  {
    key: "subflow",
    kind: "subflow",
    title: "Execute Sub-flow",
    hint: "Run another saved flow and use its result",
    section: "Other",
  },
  {
    key: "stop",
    kind: "stop",
    title: "Stop and Error",
    hint: "Throw an error in the flow",
    section: "Other",
  },
  {
    key: "switch",
    kind: "switch",
    title: "Switch",
    hint: "Route items depending on defined expression or rules",
    section: "Other",
  },
  {
    key: "wait",
    kind: "wait",
    title: "Wait",
    hint: "Wait before continue with execution",
    section: "Other",
  },
  ...AGENT_ENTRIES,
];

export const CATALOGUE_SECTIONS = ["Popular", "Core", "AI", "Other"] as const;

/** Title a freshly dropped node gets. Kept short — it is what expressions type. */
export const DEFAULT_LABEL: Record<Exclude<NodeKind, "service">, string> = {
  code: "Code",
  agent: "Agent",
  if: "If",
  filter: "Filter",
  switch: "Switch",
  loop: "Loop Over Items",
  merge: "Merge",
  compare: "Compare Datasets",
  subflow: "Execute Sub-flow",
  stop: "Stop and Error",
  wait: "Wait",
};

const MERGE_MODE_TEXT: Record<string, string> = {
  append: "append inputs",
  position: "combine by position",
  field: "combine by field",
  branch: "wait for both",
};

/** Second line of a node card: what this node will do, in a few words. */
export function describeNode(node: FlowNode): string {
  switch (node.kind) {
    case "code":
      return "JavaScript";
    case "agent":
      return describeAgent(node);
    case "if":
      return node.condition?.trim() ? "condition set" : "no condition";
    case "filter": {
      if (node.mode === "expression") {
        return node.condition?.trim() ? "condition set" : "no condition";
      }
      const set = (node.conditions ?? []).filter((c) => c.left?.trim());
      if (!set.length) return "no conditions";
      // One condition reads better spelled out than counted.
      return set.length === 1
        ? describeCondition(set[0])
        : `${set.length} conditions · ${(node.combinator ?? "and").toUpperCase()}`;
    }
    case "switch":
      return `${node.rules?.length ?? 0} rules${node.fallback ? " + fallback" : ""}`;
    case "loop":
      return `batches of ${node.batchSize || 1}`;
    case "merge":
      return MERGE_MODE_TEXT[node.mode] ?? node.mode;
    case "compare":
      return node.keyA?.trim() ? `key: ${node.keyA}` : "no key field";
    case "subflow":
      return node.flowName?.trim() || (node.flowId ? "sub-flow" : "no flow picked");
    case "stop":
      return "throws an error";
    case "wait":
      return node.mode === "until"
        ? node.until?.trim() || "no time set"
        : `${Math.round((node.waitMs || 0) / 100) / 10}s`;
    default:
      return node.entityName;
  }
}

/** Header line in the node panel. */
export function subtitleOf(node: FlowNode): string {
  switch (node.kind) {
    case "service":
      return `${node.collection}/${node.entityName}.${node.serviceName}`;
    case "code":
      return "Code · JavaScript, run in an isolate";
    case "agent":
      return `${AGENT_DEFS[node.provider]?.title ?? "Agent"} · runs on the server`;
    case "if":
      return "If · two branches";
    case "filter":
      return "Filter · keeps matching rows";
    case "switch":
      return "Switch · one output per rule";
    case "loop":
      return "Loop Over Items · split in batches";
    case "merge":
      return "Merge · combines its inputs";
    case "compare":
      return "Compare Datasets · four outputs";
    case "subflow":
      return "Execute Sub-flow · runs another flow";
    case "stop":
      return "Stop and Error · aborts the run";
    case "wait":
      return "Wait · pauses the run";
  }
}
