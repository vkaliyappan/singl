"use client";

import {
  IconAlertTriangle,
  IconCircleDot,
  IconEyeOff,
  IconPencil,
  IconPlayerPlay,
  IconPlus,
  IconTrash,
} from "@tabler/icons-react";

import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { portFraction } from "@/lib/twx-flow/graph";
import { NODE_W, nodeHeight } from "@/lib/twx-flow/layout";
import { describeNode, outputPorts, type PortDef } from "@/lib/twx-flow/nodes";
import { describeSchema, effectiveSchema } from "@/lib/twx-flow/schema";
import type { EdgePort, FlowNode, NodeRunState } from "@/lib/twx-flow/types";
import { iconFor, kindAccentFor } from "./node-icons";

/** Stable per-entity accent, so the same Thing always looks the same. */
const ACCENTS = [
  "bg-sky-500/15 text-sky-600 dark:text-sky-400",
  "bg-violet-500/15 text-violet-600 dark:text-violet-400",
  "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  "bg-rose-500/15 text-rose-600 dark:text-rose-400",
  "bg-cyan-500/15 text-cyan-600 dark:text-cyan-400",
];

function accentFor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) | 0;
  return ACCENTS[Math.abs(hash) % ACCENTS.length];
}

const initials = (name: string) =>
  (name.match(/[A-Z]/g) ?? [name[0] ?? "?"]).slice(0, 2).join("").toUpperCase();

const STATUS_RING: Record<string, string> = {
  running: "border-primary ring-2 ring-primary/40",
  ok: "border-emerald-500/70",
  error: "border-destructive",
  skipped: "border-amber-500/70",
  disabled: "border-dashed border-muted-foreground/50",
};

/** Icon tile, subtitle and tooltip differ per kind; everything else does not. */
function chromeFor(node: FlowNode) {
  if (node.kind === "service") {
    return {
      accent: accentFor(node.entityName),
      subtitle: node.entityName,
      title: `${node.collection}/${node.entityName}.${node.serviceName}`,
      Icon: null,
    };
  }
  const subtitle = describeNode(node);
  return {
    accent: kindAccentFor(node),
    subtitle,
    title: `${node.kind} node — ${subtitle}`,
    Icon: iconFor(node),
  };
}

const PORT_TONE: Record<PortDef["tone"], string> = {
  neutral: "bg-primary",
  positive: "bg-emerald-500",
  negative: "bg-rose-500",
  accent: "bg-indigo-500",
};

/** What the footer says when the node has not run. */
function readiness(node: FlowNode): string {
  switch (node.kind) {
    case "if":
      return node.condition?.trim() ? "ready" : "set condition";
    case "filter":
      return node.mode === "expression"
        ? node.condition?.trim()
          ? "ready"
          : "set condition"
        : (node.conditions ?? []).some((c) => c.left?.trim())
          ? "ready"
          : "set conditions";
    case "code":
      return node.code?.trim() ? `${node.code.trim().split("\n").length} lines` : "empty";
    case "agent":
      return node.prompt?.trim() ? "ready" : "write a prompt";
    case "switch":
      return (node.rules ?? []).some((r) => r.condition.trim()) ? "ready" : "set rules";
    case "compare":
      return node.keyA?.trim() ? "ready" : "set key field";
    case "subflow":
      return node.flowId ? "ready" : "pick a flow";
    case "loop":
    case "merge":
    case "stop":
    case "wait":
      return "ready";
    default: {
      const set = Object.values(node.inputs ?? {}).filter((v) => v !== "").length;
      return set ? `${set} set` : "no inputs";
    }
  }
}

/** One line about what leaves this node, shown bottom-left. */
function outputLine(node: FlowNode): string {
  switch (node.kind) {
    case "if":
    case "switch":
    case "wait":
      return "passes input through";
    case "filter":
      return "matching rows";
    case "loop":
      return "one batch per pass";
    case "compare":
      return "four datasets";
    case "stop":
      return "ends the run";
    case "agent":
      return node.outputMode === "json" ? "the CLI's JSON" : "what the CLI printed";
    default:
      return describeSchema(effectiveSchema(node, undefined));
  }
}

export function NodeCard({
  node,
  state,
  selected,
  isBreakpoint,
  onSelect,
  onOpen,
  onDelete,
  onDragStart,
  onStartConnect,
  onQuickAdd,
  onRunSingle,
  onToggleBreakpoint,
}: {
  node: FlowNode;
  state?: NodeRunState;
  selected: boolean;
  isBreakpoint?: boolean;
  /** `additive` is a shift/ctrl press: toggle this node in the selection. */
  onSelect: (additive: boolean) => void;
  onOpen: () => void;
  onDelete: () => void;
  onDragStart: (e: React.PointerEvent) => void;
  /** `port` is set only on nodes with more than one output. */
  onStartConnect: (e: React.PointerEvent, port?: EdgePort) => void;
  /** The “+” stub on the output port: add and connect a node in one gesture. */
  onQuickAdd: (port?: EdgePort) => void;
  onRunSingle?: () => void;
  onToggleBreakpoint?: () => void;
}) {
  const status = node.disabled ? "disabled" : state?.status;
  const schema = effectiveSchema(node, state?.result);
  const chrome = chromeFor(node);
  const ports = outputPorts(node);
  const height = nodeHeight(node);
  const named = ports.length > 1;

  return (
    <div
      className={cn(
        "group absolute flex cursor-move flex-col rounded-xl border-2 bg-card shadow-sm transition-shadow select-none",
        selected ? "border-primary ring-2 ring-primary/40" : (STATUS_RING[status ?? ""] ?? "border-border"),
        node.disabled && "opacity-60",
        "hover:shadow-md"
      )}
      style={{ left: node.x, top: node.y, width: NODE_W, height }}
      onPointerDown={(e) => {
        // Ports handle their own press and stop propagation before this runs.
        e.stopPropagation();
        // Capture on the card itself, not the canvas: capturing higher up
        // retargets the pointerup, and with it click and dblclick, away from
        // this node. Events still bubble to the canvas' drag handlers.
        e.currentTarget.setPointerCapture(e.pointerId);
        onSelect(e.shiftKey || e.ctrlKey || e.metaKey);
        onDragStart(e);
      }}
      onDoubleClick={(e) => {
        e.stopPropagation();
        onOpen();
      }}
      title={chrome.title}
    >
      {/* Input port */}
      <span
        data-input-port
        data-node-id={node.id}
        className="absolute top-1/2 left-0 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-background bg-muted-foreground/60"
      />
      {/* Generous invisible drop zone around it, so wires are easy to land. */}
      <span
        data-input-port
        data-node-id={node.id}
        className="absolute top-1/2 left-0 size-8 -translate-x-1/2 -translate-y-1/2 rounded-full"
      />

      <div className="flex min-h-0 flex-1 items-center gap-1.5 px-2">
        <span
          className={cn(
            "flex size-7 shrink-0 items-center justify-center rounded-lg font-mono text-[10px] font-semibold",
            chrome.accent
          )}
        >
          {status === "running" ? (
            <Spinner className="size-3.5" />
          ) : chrome.Icon ? (
            <chrome.Icon className="size-3.5" />
          ) : (
            initials((node as { serviceName: string }).serviceName)
          )}
        </span>

        <div className="min-w-0 flex-1">
          <p className="truncate text-xs leading-tight font-semibold">{node.label}</p>
          <p className="truncate font-mono text-[10px] leading-tight text-muted-foreground">
            {chrome.subtitle}
          </p>
        </div>

        {isBreakpoint && (
          <span
            className="size-2 rounded-full bg-rose-500 ring-2 ring-rose-500/30 shrink-0"
            title="Breakpoint set"
          />
        )}
        {node.disabled && <IconEyeOff className="size-3.5 shrink-0 text-muted-foreground" />}
        {status === "error" && <IconAlertTriangle className="size-3.5 shrink-0 text-destructive" />}

        {/* Action buttons on card hover */}
        {onRunSingle && (
          <button
            type="button"
            aria-label="Run only this node"
            title="Run only this node"
            className="shrink-0 rounded p-0.5 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 hover:text-emerald-500"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              onRunSingle();
            }}
          >
            <IconPlayerPlay className="size-3.5" />
          </button>
        )}

        {onToggleBreakpoint && (
          <button
            type="button"
            aria-label="Toggle breakpoint"
            title={isBreakpoint ? "Remove breakpoint" : "Add breakpoint"}
            className={cn(
              "shrink-0 rounded p-0.5 opacity-0 transition-opacity group-hover:opacity-100",
              isBreakpoint ? "opacity-100 text-rose-500" : "text-muted-foreground hover:text-rose-500"
            )}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              onToggleBreakpoint();
            }}
          >
            <IconCircleDot className="size-3.5" />
          </button>
        )}

        <button
          type="button"
          aria-label="Edit node"
          title="Edit node"
          className="shrink-0 rounded p-0.5 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 hover:text-foreground"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            onOpen();
          }}
        >
          <IconPencil className="size-3.5" />
        </button>

        <button
          type="button"
          aria-label="Delete node"
          title="Delete node"
          className="shrink-0 rounded p-0.5 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 hover:text-destructive"
          onPointerDown={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
        >
          <IconTrash className="size-3.5" />
        </button>
      </div>

      {/* Footer strip: declared output on the left, run outcome on the right */}
      <div className="flex items-center gap-1.5 rounded-b-[9px] border-t bg-muted/40 px-2.5 py-1">
        <span className="truncate font-mono text-[9px] text-muted-foreground" title={describeSchema(schema)}>
          {outputLine(node)}
        </span>
        <span className="ml-auto shrink-0 font-mono text-[9px]">
          {status === "running" ? (
            <span className="text-primary">running…</span>
          ) : state?.status === "ok" ? (
            <span className="text-emerald-600 dark:text-emerald-400">
              {state.branch ? `${state.branch} · ` : ""}
              {state.iterations ? `×${state.iterations} · ` : ""}
              {state.rows !== undefined ? `${state.rows} rows · ` : ""}
              {state.ms}ms
            </span>
          ) : state?.status === "error" ? (
            <span className="text-destructive">failed</span>
          ) : state?.status === "skipped" ? (
            <span className="text-amber-600 dark:text-amber-400">skipped</span>
          ) : (
            <span className="text-muted-foreground">{readiness(node)}</span>
          )}
        </span>
      </div>

      {/* Output ports + quick-add stubs — one row per port */}
      {ports.map((port, index) => {
        const top = height * portFraction(index, ports.length);
        const taken = state?.branch;
        return (
          <span key={port.id}>
            <button
              type="button"
              aria-label={named ? `Drag from the ${port.label} output` : "Drag to another node to connect"}
              title={named ? `${port.label} output` : "Drag to another node to connect"}
              className="absolute right-0 flex size-6 translate-x-1/2 -translate-y-1/2 cursor-crosshair items-center justify-center"
              style={{ top }}
              onPointerDown={(e) => {
                e.stopPropagation();
                onStartConnect(e, named ? port.id : undefined);
              }}
            >
              <span
                className={cn(
                  "size-3 rounded-full border-2 border-background",
                  PORT_TONE[port.tone],
                  // After a run, the ports that were not taken fade out.
                  named && taken !== undefined && taken !== port.id && "opacity-30"
                )}
              />
            </button>
            {named && (
              <span
                className="pointer-events-none absolute right-0 max-w-24 -translate-y-1/2 translate-x-[calc(100%+10px)] truncate font-mono text-[9px] text-muted-foreground"
                style={{ top }}
              >
                {port.label}
              </span>
            )}
            <button
              type="button"
              aria-label={named ? `Add a node on the ${port.label} output` : "Add a node after this one"}
              title={named ? `Add a node on the ${port.label} output` : "Add a node after this one"}
              className={cn(
                "absolute left-full flex size-5 -translate-y-1/2 items-center justify-center rounded-md border border-dashed bg-background text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 hover:border-primary hover:text-primary",
                // The port labels occupy the space the single-port stub uses.
                named ? "ml-24" : "ml-4"
              )}
              style={{ top }}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                onQuickAdd(named ? port.id : undefined);
              }}
            >
              <IconPlus className="size-3" />
            </button>
          </span>
        );
      })}
    </div>
  );
}
