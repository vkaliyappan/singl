"use client";

import {
  IconArrowsSplit,
  IconArrowsSplit2,
  IconBrandGithubCopilot,
  IconBrandOpenai,
  IconCode,
  IconFilter,
  IconGitCompare,
  IconGitMerge,
  IconHandStop,
  IconHourglass,
  IconRocket,
  IconRotateClockwise,
  IconSparkles,
  IconSubtask,
  IconTerminal2,
} from "@tabler/icons-react";

import type { NodeCatalogEntry } from "@/lib/twx-flow/nodes";
import type { AgentProvider, FlowNode, NodeKind } from "@/lib/twx-flow/types";

export type TablerIcon = typeof IconCode;

/** One icon per node kind, shared by the palette, the cards and the log. */
export const KIND_ICON: Record<NodeKind, TablerIcon> = {
  service: IconTerminal2,
  code: IconCode,
  agent: IconSparkles,
  if: IconArrowsSplit2,
  filter: IconFilter,
  switch: IconArrowsSplit,
  loop: IconRotateClockwise,
  merge: IconGitMerge,
  compare: IconGitCompare,
  subflow: IconSubtask,
  stop: IconHandStop,
  wait: IconHourglass,
};

/** Agent nodes are told apart by which CLI they drive, not by their kind. */
export const AGENT_ICON: Record<AgentProvider, TablerIcon> = {
  claude: IconSparkles,
  codex: IconBrandOpenai,
  copilot: IconBrandGithubCopilot,
  antigravity: IconRocket,
};

const AGENT_ACCENT: Record<AgentProvider, string> = {
  claude: "bg-orange-500/15 text-orange-600 dark:text-orange-400",
  codex: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  copilot: "bg-sky-500/15 text-sky-600 dark:text-sky-400",
  antigravity: "bg-blue-500/15 text-blue-600 dark:text-blue-400",
};

/** Tile colour behind that icon. Service calls get a per-entity accent instead. */
export const KIND_ACCENT: Record<Exclude<NodeKind, "service">, string> = {
  code: "bg-slate-500/15 text-slate-600 dark:text-slate-300",
  agent: "bg-fuchsia-500/15 text-fuchsia-600 dark:text-fuchsia-400",
  if: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  filter: "bg-orange-500/15 text-orange-600 dark:text-orange-400",
  switch: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  loop: "bg-indigo-500/15 text-indigo-600 dark:text-indigo-400",
  merge: "bg-teal-500/15 text-teal-600 dark:text-teal-400",
  compare: "bg-cyan-500/15 text-cyan-600 dark:text-cyan-400",
  subflow: "bg-violet-500/15 text-violet-600 dark:text-violet-400",
  stop: "bg-destructive/15 text-destructive",
  wait: "bg-slate-500/15 text-slate-600 dark:text-slate-300",
};

export const iconFor = (node: FlowNode): TablerIcon =>
  node.kind === "agent" ? (AGENT_ICON[node.provider] ?? KIND_ICON.agent) : KIND_ICON[node.kind];

/** Named for the node, not the entity — `node-card` has its own per-entity one. */
export const kindAccentFor = (node: FlowNode): string =>
  node.kind === "agent"
    ? (AGENT_ACCENT[node.provider] ?? KIND_ACCENT.agent)
    : KIND_ACCENT[node.kind as Exclude<NodeKind, "service">];

/** Icon for a palette row — per CLI for the agent rows, per kind for the rest. */
export function catalogueIcon(entry: NodeCatalogEntry): TablerIcon {
  const provider = entry.patch?.provider as AgentProvider | undefined;
  if (entry.kind === "agent" && provider) return AGENT_ICON[provider] ?? KIND_ICON.agent;
  return KIND_ICON[entry.kind];
}
