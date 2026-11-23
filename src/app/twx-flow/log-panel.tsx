"use client";

import { CopyButton } from "./copy-button";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  IconAlertTriangle,
  IconCheck,
  IconChevronDown,
  IconChevronUp,
  IconEyeOff,
  IconTrash,
} from "@tabler/icons-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { nodeRef } from "@/lib/twx-flow/expression";
import { effectiveSchema } from "@/lib/twx-flow/schema";
import type { FlowGraph, FlowNode, NodeRunState } from "@/lib/twx-flow/types";
import { JsonView } from "./json-view";
import { AGENT_ICON, KIND_ICON } from "./node-icons";
import { ParamFields, type ParamEntry } from "./param-fields";
import { ResultTabs } from "./result-view";

const HEIGHT_KEY = "twx-flow:log-panel:height";
const HEIGHT_VAR = "--twx-log-h";
const HEADER_H = 34;
const MIN_H = 160;

/** Icon tile per node kind — the same vocabulary the cards on the board use. */
function KindIcon({ node, state }: { node: FlowNode; state?: NodeRunState }) {
  if (state?.status === "running") return <Spinner className="size-3.5" />;
  // A lookup, not a call: the lint rule reads a called component as one built
  // during render. A graph may name a provider this build has never heard of,
  // so the kind's own icon backs the lookup up rather than rendering undefined.
  const Icon =
    node.kind === "agent" ? (AGENT_ICON[node.provider] ?? KIND_ICON.agent) : KIND_ICON[node.kind];
  return <Icon className="size-3.5" />;
}

const STATUS_TEXT: Record<string, string> = {
  running: "text-primary",
  ok: "text-success",
  error: "text-destructive",
  skipped: "text-warning",
  disabled: "text-muted-foreground",
};

/** Right-hand column of a log row: how the node finished, and how long it took. */
function outcomeOf(node: FlowNode, state: NodeRunState | undefined): string {
  if (node.disabled) return "disabled";
  if (!state) return "queued";
  switch (state.status) {
    case "running":
      return "running…";
    case "ok":
      return `${state.rows !== undefined ? `${state.rows} rows · ` : ""}${state.ms}ms`;
    case "error":
      return "failed";
    default:
      // The reason can be a paragraph; the column has room for a word, so the
      // reason itself is left to the pane on the right.
      return state.status;
  }
}

/**
 * The bottom execution drawer, in the shape n8n uses: the run's nodes down the
 * left in execution order, whatever the selected one saw and produced on the
 * right. Collapses to its header bar, and the open height is remembered.
 */
export function LogPanel({
  graph,
  runStates,
  runOrder,
  runMs,
  running,
  open,
  selectedId,
  onOpenChange,
  onSelect,
  onOpenNode,
  onClear,
}: {
  graph: FlowGraph;
  runStates: Record<string, NodeRunState>;
  /** Node ids in the order the last run visited them. */
  runOrder: string[];
  /** Wall-clock of the whole run, once it has finished. */
  runMs: number | null;
  running: boolean;
  open: boolean;
  selectedId: string | null;
  onOpenChange: (open: boolean) => void;
  onSelect: (id: string) => void;
  /** Opens the full node editor — the drawer is for reading, not editing. */
  onOpenNode: (id: string) => void;
  onClear: () => void;
}) {
  const [pane, setPane] = useState<"input" | "output">("output");
  /**
   * How the sent parameters are drawn: one row each, or the whole payload as a
   * foldable JSON document — a parameter that carries an infotable is unreadable
   * as a single stringified line.
   */
  const [paramView, setParamView] = useState<"fields" | "json">("fields");
  /**
   * A newly selected node is read output-first — the input pane is a detour, not
   * a mode, so it must not follow you from node to node. Adjusted during render
   * rather than in an effect: the pane never paints wrong for a frame.
   */
  const [paneFor, setPaneFor] = useState(selectedId);
  if (paneFor !== selectedId) {
    setPaneFor(selectedId);
    setPane("output");
  }
  const panel = useRef<HTMLDivElement>(null);
  const drag = useRef<{ startY: number; startH: number } | null>(null);

  /**
   * The open height lives on the element as a custom property rather than in
   * state: dragging then costs no re-render, and restoring it after mount
   * cannot disagree with what the server rendered.
   */
  const setPanelHeight = useCallback((px: number) => {
    panel.current?.style.setProperty(HEIGHT_VAR, `${px}px`);
  }, []);

  useEffect(() => {
    const saved = Number(localStorage.getItem(HEIGHT_KEY));
    if (saved >= MIN_H) setPanelHeight(saved);
  }, [setPanelHeight]);

  const onGripMove = useCallback(
    (e: React.PointerEvent) => {
      const d = drag.current;
      if (!d) return;
      setPanelHeight(
        Math.min(
          Math.max(MIN_H, d.startH + (d.startY - e.clientY)),
          Math.round(window.innerHeight * 0.8)
        )
      );
    },
    [setPanelHeight]
  );

  const onGripUp = useCallback((e: React.PointerEvent) => {
    if (!drag.current) return;
    drag.current = null;
    e.currentTarget.releasePointerCapture(e.pointerId);
    const px = panel.current?.getBoundingClientRect().height;
    if (px) localStorage.setItem(HEIGHT_KEY, String(Math.round(px)));
  }, []);

  const nodesById = useMemo(() => new Map(graph.nodes.map((n) => [n.id, n])), [graph.nodes]);

  // A node deleted since the run has no row to draw.
  const rows = useMemo(
    () =>
      runOrder
        .map((id) => nodesById.get(id))
        .filter((n): n is FlowNode => !!n)
        .map((node) => ({ node, state: runStates[node.id] })),
    [nodesById, runOrder, runStates]
  );

  const failed = rows.some((r) => r.state?.status === "error");
  const ran = rows.length > 0;

  const selected = selectedId ? nodesById.get(selectedId) : undefined;
  const selectedState = selected ? runStates[selected.id] : undefined;

  /**
   * Every parameter of the call, declared type and sent value together.
   *
   * `inputs` only carries the parameters that had an expression to evaluate, so
   * on its own it hides the rest of the service's signature. Here every declared
   * parameter appears, in the order the service declares them, whether or not
   * anything was sent for it — which is what the call actually looked like. The
   * base type rides along so each value can be drawn as the control it is.
   */
  const paramEntries = useMemo<ParamEntry[]>(() => {
    const sent = selectedState?.inputs ?? {};
    const errors = selectedState?.inputErrors ?? {};
    const declared = new Set<string>();
    const list: ParamEntry[] = [];
    if (selected?.kind === "service") {
      for (const param of selected.params) {
        declared.add(param.name);
        list.push({
          name: param.name,
          baseType: param.baseType,
          required: param.aspects?.isRequired,
          sent: param.name in sent,
          value: sent[param.name] ?? null,
          error: errors[param.name],
        });
      }
    }
    // Non-service nodes record synthetic inputs (a condition, a merge summary)
    // that no parameter list covers — and a stale node keeps whatever it sent.
    for (const [name, value] of Object.entries(sent)) {
      if (!declared.has(name)) list.push({ name, sent: true, value, error: errors[name] });
    }
    return list;
  }, [selected, selectedState]);

  /** The same entries as one document, for the JSON view of the body. */
  const paramJson = useMemo(
    () =>
      Object.fromEntries(
        paramEntries.map((p) => [p.name, p.error ?? (p.sent ? p.value : null)])
      ),
    [paramEntries]
  );

  const hasParamBody = paramEntries.length > 0;

  const summary = running
    ? "Running…"
    : !ran
      ? "No execution yet"
      : failed
        ? `Error${runMs === null ? "" : ` in ${runMs}ms`}`
        : `Success${runMs === null ? "" : ` in ${runMs}ms`}`;

  return (
    <div
      ref={panel}
      className="relative flex shrink-0 flex-col border-t bg-background"
      style={{ height: open ? `var(${HEIGHT_VAR}, 280px)` : HEADER_H }}
    >
      {/* Resize grip — only meaningful while the drawer is open. */}
      {open && (
        <div
          role="separator"
          aria-orientation="horizontal"
          aria-label="Resize logs"
          className="absolute inset-x-0 -top-1 z-10 h-2 cursor-ns-resize"
          onPointerDown={(e) => {
            e.preventDefault();
            drag.current = {
              startY: e.clientY,
              startH: panel.current?.getBoundingClientRect().height ?? MIN_H,
            };
            e.currentTarget.setPointerCapture(e.pointerId);
          }}
          onPointerMove={onGripMove}
          onPointerUp={onGripUp}
          onPointerCancel={onGripUp}
        />
      )}

      {/* Header — the whole strip toggles, so the drawer is easy to flick open */}
      <div
        role="button"
        tabIndex={0}
        aria-expanded={open}
        className="flex h-[34px] shrink-0 cursor-pointer items-center gap-2 px-3 select-none hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring/30 focus-visible:outline-none focus-visible:ring-inset"
        onClick={() => onOpenChange(!open)}
        onKeyDown={(e) => {
          if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) {
            e.preventDefault();
            onOpenChange(!open);
          }
        }}
      >
        {open ? (
          <IconChevronDown className="size-3.5 text-muted-foreground" />
        ) : (
          <IconChevronUp className="size-3.5 text-muted-foreground" />
        )}
        <span className="text-xs font-semibold tracking-tight">Logs</span>

        {running ? (
          <Spinner className="size-3" />
        ) : ran ? (
          failed ? (
            <IconAlertTriangle className="size-3 text-destructive" />
          ) : (
            <IconCheck className="size-3 text-success" />
          )
        ) : null}
        <span
          className={cn(
            "text-xs tabular-nums",
            running
              ? "text-primary"
              : ran && failed
                ? "text-destructive"
                : "text-muted-foreground"
          )}
        >
          {summary}
        </span>

        {ran && (
          <Badge variant="outline" className="text-[9px]">
            {rows.length} node{rows.length === 1 ? "" : "s"}
          </Badge>
        )}

        <div className="ml-auto flex items-center gap-1">
          <Button
            size="xs"
            variant="ghost"
            disabled={!ran || running}
            onClick={(e) => {
              e.stopPropagation();
              onClear();
            }}
          >
            <IconTrash />
            Clear execution
          </Button>
        </div>
      </div>

      {open && (
        <div className="flex min-h-0 flex-1 border-t">
          {/* Executed nodes, in run order */}
          <div className="w-56 shrink-0 overflow-auto border-r">
            {rows.length === 0 ? (
              <p className="p-3 text-xs text-muted-foreground">
                Run the flow to see each node’s input and output here.
              </p>
            ) : (
              rows.map(({ node, state }) => (
                <button
                  key={node.id}
                  type="button"
                  onClick={() => onSelect(node.id)}
                  onDoubleClick={() => onOpenNode(node.id)}
                  title="Double-click to open the node"
                  className={cn(
                    "flex w-full items-center gap-2 px-2.5 py-1.5 text-left hover:bg-accent/60",
                    selectedId === node.id && "bg-accent"
                  )}
                >
                  <span className="flex size-5 shrink-0 items-center justify-center text-muted-foreground">
                    <KindIcon node={node} state={state} />
                  </span>
                  <span className="min-w-0 flex-1 truncate text-xs">{node.label}</span>
                  {node.disabled && <IconEyeOff className="size-3 shrink-0 text-muted-foreground" />}
                  <span
                    className={cn(
                      "shrink-0 font-mono text-[9px] tabular-nums",
                      STATUS_TEXT[state?.status ?? ""] ?? "text-muted-foreground"
                    )}
                  >
                    {outcomeOf(node, state)}
                  </span>
                </button>
              ))
            )}
          </div>

          {/* What the selected node saw, and what it produced */}
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            {!selected ? (
              <p className="p-3 text-xs text-muted-foreground">
                Select a node on the left.
              </p>
            ) : (
              <>
                <div className="flex shrink-0 items-center gap-2 border-b px-3 py-1.5">
                  <span className="text-muted-foreground">
                    <KindIcon node={selected} state={selectedState} />
                  </span>
                  <span className="truncate text-xs font-semibold">{selected.label}</span>
                  <span
                    className={cn(
                      "shrink-0 font-mono text-[10px]",
                      STATUS_TEXT[selectedState?.status ?? ""] ?? "text-muted-foreground"
                    )}
                  >
                    {outcomeOf(selected, selectedState)}
                  </span>

                  {/* How the sent parameters are drawn — only the input pane has any */}
                  {pane === "input" && hasParamBody && (
                    <div className="ml-auto flex items-center gap-0.5 rounded-md bg-muted p-0.5">
                      {(["fields", "json"] as const).map((name) => (
                        <button
                          key={name}
                          type="button"
                          onClick={() => setParamView(name)}
                          title={`Show the sent parameters as ${name}`}
                          className={cn(
                            "rounded-[5px] px-2 py-0.5 text-[10px] capitalize transition-colors",
                            paramView === name
                              ? "bg-background text-foreground shadow-sm"
                              : "text-muted-foreground hover:text-foreground"
                          )}
                        >
                          {name}
                        </button>
                      ))}
                    </div>
                  )}

                  <div
                    className={cn(
                      "flex items-center gap-0.5 rounded-md bg-muted p-0.5",
                      // The parameter toggle takes the spacer when it is there.
                      !(pane === "input" && hasParamBody) && "ml-auto"
                    )}
                  >
                    {(["input", "output"] as const).map((name) => (
                      <button
                        key={name}
                        type="button"
                        onClick={() => setPane(name)}
                        className={cn(
                          "rounded-[5px] px-2 py-0.5 text-[10px] capitalize transition-colors",
                          pane === name
                            ? "bg-background text-foreground shadow-sm"
                            : "text-muted-foreground hover:text-foreground"
                        )}
                      >
                        {name}
                      </button>
                    ))}
                  </div>
                  <Button size="xs" variant="outline" onClick={() => onOpenNode(selected.id)}>
                    Open
                  </Button>
                </div>

                <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2 overflow-hidden p-3">
                  {pane === "input" ? (
                    <>
                      {/* Values as they were actually sent — after expressions
                          were evaluated and coerced to their base types. */}
                      {hasParamBody && paramView === "json" && (
                        <div className="min-h-0 flex-1 overflow-auto">
                          <JsonView value={paramJson} />
                        </div>
                      )}

                      {hasParamBody && paramView === "fields" && (
                        <div className="min-h-0 flex-1 overflow-auto">
                          <ParamFields entries={paramEntries} />
                        </div>
                      )}

                      {!hasParamBody && (
                        <p className="text-xs text-muted-foreground">
                          Nothing was sent for this node.
                        </p>
                      )}
                    </>
                  ) : selectedState?.error ? (
                    // Skipped nodes carry a reason too — why a branch was not
                    // taken, or which circle of wiring left this one out.
                    <div
                      className={cn(
                        "relative rounded-md border",
                        selectedState.status === "error"
                          ? "border-destructive/40 bg-destructive/5 text-destructive"
                          : "border-warning/40 bg-warning/5 text-warning"
                      )}
                    >
                      <CopyButton text={selectedState.error} className="absolute top-1 right-1" />
                      <pre className="overflow-auto p-2 pr-8 font-mono text-[10px] whitespace-pre-wrap">
                        {selectedState.error}
                      </pre>
                    </div>
                  ) : selectedState?.result === undefined ? (
                    <p className="text-xs text-muted-foreground">
                      This node produced no output.
                    </p>
                  ) : (
                    <>
                      {!!selectedState.logs?.length && (
                        <pre className="max-h-24 shrink-0 overflow-auto rounded-md border bg-muted/40 p-2 font-mono text-[10px] whitespace-pre-wrap">
                          {selectedState.logs.join("\n")}
                        </pre>
                      )}
                      <ResultTabs
                        key={`out-${selected.id}`}
                        schemaValue={selectedState.result}
                        dataValue={selectedState.result}
                        root={nodeRef(selected.label)}
                        rootLabel={selected.label}
                        fields={effectiveSchema(selected, selectedState.result).fields}
                        initialTab="table"
                      />
                    </>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
