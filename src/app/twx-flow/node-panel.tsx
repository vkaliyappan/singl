"use client";

import { useEffect, useMemo, useState } from "react";
import {
  IconAlertCircle,
  IconArrowRight,
  IconBolt,
  IconExternalLink,
  IconEyeOff,
  IconFileCode,
  IconMaximize,
  IconMinimize,
  IconPlayerPlay,
  IconRefresh,
  IconTrash,
  IconX,
} from "@tabler/icons-react";
import { useDefaultLayout } from "react-resizable-panels";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { twxEntityHref, twxServiceHref } from "@/lib/twx/links";
import { cn } from "@/lib/utils";
import {
  ancestorsOf,
  contextFor,
  decideBranch,
  decideSwitch,
  filterRows,
  parentsOf,
  portKey,
  type EvalScope,
} from "@/lib/twx-flow/graph";
import { isExpression } from "@/lib/twx-flow/expression";
import { subtitleOf } from "@/lib/twx-flow/nodes";
import {
  describeSchema,
  effectiveSchema,
  sampleFromSchema,
  schemaFromValue,
  toRows,
} from "@/lib/twx-flow/schema";
import type { FlowGraph, FlowNode, NodePatch, NodeRunState } from "@/lib/twx-flow/types";
import { CodeEditor } from "./code-editor";
import { ExpressionField } from "./expression-field";
import { JsonView } from "./json-view";
import { NodeSettings } from "./node-settings";
import { ResultTabs } from "./result-view";

const FULLSCREEN_KEY = "twx-flow:node-panel:fullscreen";
const LAYOUT_KEY = "twx-flow:node-panel:columns";

/** `useDefaultLayout` reaches for `localStorage` eagerly, which does not exist
    while rendering on the server. */
const LAYOUT_STORAGE =
  typeof window === "undefined"
    ? { getItem: () => null, setItem: () => {} }
    : window.localStorage;

/** Heading over the middle column, per kind. */
const BODY_HEADING: Record<string, string> = {
  code: "Code",
  agent: "Agent",
  if: "Condition",
  filter: "Condition",
  switch: "Rules",
  loop: "Batches",
  merge: "Merge",
  compare: "Comparison",
  subflow: "Sub-flow",
  stop: "Error",
  wait: "Wait",
};

/** What a node will emit, said in words before it has ever run. */
const OUTPUT_HINT: Record<string, string> = {
  code: "Shape is whatever the snippet returns — run it to see",
  agent: "What the CLI printed — text, or its parsed JSON",
  if: "Passes its input through unchanged",
  switch: "Passes its input through, down the matching output",
  wait: "Passes its input through, after the pause",
  filter: "The rows the condition kept",
  loop: "One batch per pass; the collected rows on “done”",
  merge: "The inputs put together",
  compare: "A tally here — each output carries its own dataset",
  subflow: "Whatever the sub-flow's last node returned",
  stop: "Nothing — reaching it fails the run",
};

/** The value a node's output stands for right now: real result, or a sample. */
function previewValue(node: FlowNode, state: NodeRunState | undefined): unknown {
  if (state?.result !== undefined) return state.result;
  return sampleFromSchema(effectiveSchema(node, undefined));
}

/**
 * The node detail view: incoming data on the left, parameters in the middle,
 * this node's output on the right. Fields are dragged from left to middle to
 * build expressions.
 */
export function NodePanel({
  node,
  env,
  graph,
  runStates,
  running,
  onChange,
  onRename,
  onMakePrimary,
  onRunNode,
  onRefreshSchema,
  onDelete,
  onClose,
}: {
  node: FlowNode;
  /** The flow's ThingWorx environment, for links into the explorers. */
  env: string;
  graph: FlowGraph;
  runStates: Record<string, NodeRunState>;
  running: boolean;
  onChange: (id: string, patch: NodePatch) => void;
  onRename: (id: string, label: string) => void;
  /** Promotes one of several incoming nodes to be `$json`. */
  onMakePrimary: (targetId: string, sourceId: string) => void;
  onRunNode: (id: string, mode: "step" | "upstream") => void;
  onRefreshSchema: (id: string) => void;
  onDelete: (id: string) => void;
  onClose: () => void;
}) {
  const state = runStates[node.id];
  const parents = useMemo(() => parentsOf(graph, node.id), [graph, node.id]);
  const upstream = useMemo(() => {
    const ancestors = ancestorsOf(graph, node.id);
    ancestors.delete(node.id);
    // Direct parents first, in wire order — the first of them is `$json`.
    const rank = (id: string) => {
      const index = parents.indexOf(id);
      return index === -1 ? parents.length : index;
    };
    return graph.nodes
      .filter((n) => ancestors.has(n.id))
      .sort((a, b) => rank(a.id) - rank(b.id));
  }, [graph, node.id, parents]);

  const [inputNodeId, setInputNodeId] = useState<string>(upstream[0]?.id ?? "");

  // A stale id — from a node opened earlier — must not win over this node's own
  // upstream list.
  const inputNode = upstream.find((n) => n.id === inputNodeId) ?? upstream[0];
  const inputState = inputNode ? runStates[inputNode.id] : undefined;
  const inputValue = inputNode ? previewValue(inputNode, inputState) : undefined;
  const inputSchema = inputNode ? effectiveSchema(inputNode, inputState?.result) : undefined;
  const inputIsSample = !!inputNode && inputState?.result === undefined;
  const isPrimaryParent = !!inputNode && parents[0] === inputNode.id;

  /** Real results where they exist, samples elsewhere. */
  const results = useMemo(() => {
    const out: Record<string, unknown> = {};
    for (const n of graph.nodes) {
      if (n.id === node.id) continue;
      out[n.id] = previewValue(n, runStates[n.id]);
    }
    return out;
  }, [graph, node.id, runStates]);

  /** What each individual output carried last run, for the nodes whose ports
      differ — so a preview here shows what this node's own wire brings. */
  const portResults = useMemo(
    () =>
      Object.fromEntries(
        Object.entries(runStates).flatMap(([id, s]) =>
          Object.entries(s.ports ?? {}).map(([port, value]) => [portKey(id, port), value])
        )
      ),
    [runStates]
  );

  const scope = useMemo<EvalScope>(
    () => ({ graph, results, portResults }),
    [graph, portResults, results]
  );
  const ctx = useMemo(() => contextFor(node, scope), [node, scope]);

  /** Which branch the condition picks right now, so the answer is not a mystery
      until the flow is run. */
  const preview = useMemo(
    () =>
      node.kind === "if"
        ? decideBranch(node, scope)
        : node.kind === "switch"
          ? decideSwitch(node, scope)
          : null,
    [node, scope]
  );

  /** Columns arriving on this node's own wire — what the Filter builder lists. */
  const incomingFields = useMemo(() => {
    const fromValue = ctx.$json === undefined ? null : schemaFromValue(ctx.$json);
    return fromValue?.fields ?? [];
  }, [ctx.$json]);

  /** How the Filter would sift the data on the board right now. */
  const filterPreview = useMemo(() => {
    if (node.kind !== "filter") return null;
    const rows = toRows(ctx.$json);
    const { kept, error, warning } = filterRows(node, rows, scope);
    return { kept: kept.length, total: rows.length, error, warning };
  }, [ctx.$json, node, scope]);

  const schema = effectiveSchema(node, state?.result);
  const output = previewValue(node, state);
  const outputIsSample = state?.result === undefined;

  // Full screen and the column widths belong to the workspace, not to the node,
  // so both outlive the panel being closed and reopened. The panel only ever
  // mounts after a click on the board, so reading storage during the first
  // render cannot disagree with a server-rendered tree.
  const [fullscreen, setFullscreen] = useState(
    () => typeof window !== "undefined" && localStorage.getItem(FULLSCREEN_KEY) === "1"
  );
  const toggleFullscreen = () => {
    const next = !fullscreen;
    setFullscreen(next);
    localStorage.setItem(FULLSCREEN_KEY, next ? "1" : "0");
  };

  // Escape backs out one step at a time: full screen first, then the panel —
  // but not while typing, where the editor and the fields claim the key first.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      const target = e.target as HTMLElement | null;
      if (target?.closest("input, textarea, [contenteditable='true'], .monaco-editor")) return;
      if (fullscreen) {
        setFullscreen(false);
        localStorage.setItem(FULLSCREEN_KEY, "0");
      } else {
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fullscreen, onClose]);

  const { defaultLayout, onLayoutChanged } = useDefaultLayout({
    id: LAYOUT_KEY,
    storage: LAYOUT_STORAGE,
  });

  const column = "flex min-h-0 min-w-0 flex-col gap-2 overflow-hidden p-3";
  const heading = "flex items-center gap-1.5 text-[11px] font-semibold tracking-tight";

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-background/80 backdrop-blur-sm">
      <div
        className="absolute inset-0"
        onClick={onClose}
        role="presentation"
        aria-hidden
      />

      {/* Wider on wider screens — the three columns each hold a tree or a grid,
          so extra width goes straight into readable rows. Full screen drops the
          cap entirely. */}
      <div
        className={cn(
          "relative m-auto flex flex-col overflow-hidden border bg-background shadow-2xl",
          fullscreen
            ? "h-full w-full rounded-none border-0"
            : "h-[88vh] w-[95vw] max-w-[1240px] rounded-xl xl:max-w-[1600px] 2xl:max-w-[1900px]"
        )}
      >
        {/* Header */}
        <div className="flex shrink-0 items-center gap-2 border-b px-3 py-2">
          <Input
            value={node.label}
            onChange={(e) => onRename(node.id, e.target.value)}
            className="h-7 w-64 text-xs font-medium"
          />
          <span className="truncate font-mono text-[11px] text-muted-foreground">
            {subtitleOf(node)}
          </span>
          {graph.nodes.some((n) => n.id !== node.id && n.label === node.label) && (
            <Badge variant="destructive" className="shrink-0 text-[10px]">
              duplicate title — expressions address nodes by title
            </Badge>
          )}

          <div className="ml-auto flex items-center gap-1">
            {node.kind === "service" && (
              <>
                <Button
                  size="sm"
                  variant="ghost"
                  nativeButton={false}
                  render={
                    <a
                      href={twxServiceHref({
                        env,
                        type: node.collection,
                        entity: node.entityName,
                        service: node.serviceName,
                        // Expressions only mean something inside a run.
                        inputs: Object.fromEntries(
                          Object.entries(node.inputs).filter(([, v]) => v !== "" && !isExpression(v))
                        ),
                      })}
                      target="_blank"
                      rel="noopener"
                    />
                  }
                  title="Open this service in TWX Services, with the literal inputs filled in"
                >
                  <IconBolt />
                  Service
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  nativeButton={false}
                  render={
                    <a
                      href={twxEntityHref({
                        env,
                        type: node.collection,
                        entity: node.entityName,
                        service: node.serviceName,
                      })}
                      target="_blank"
                      rel="noopener"
                    />
                  }
                  title="Open the exported entity in TWX Entities"
                >
                  <IconFileCode />
                  Entity
                </Button>
              </>
            )}
            <Button
              size="sm"
              variant="secondary"
              disabled={running}
              onClick={() => onRunNode(node.id, "step")}
              title="Run just this node, reusing the results already on the board"
            >
              {running ? <Spinner className="size-3.5" /> : <IconPlayerPlay />}
              Test step
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={running}
              onClick={() => onRunNode(node.id, "upstream")}
              title="Run every node this one depends on, then this one"
            >
              <IconArrowRight />
              Run to here
            </Button>
            <Button
              size="sm"
              variant={node.disabled ? "default" : "ghost"}
              onClick={() => onChange(node.id, { disabled: !node.disabled })}
              title="A disabled node is skipped and passes its input through"
            >
              <IconEyeOff />
              {node.disabled ? "Disabled" : "Disable"}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="text-destructive"
              onClick={() => onDelete(node.id)}
            >
              <IconTrash />
              Delete
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={toggleFullscreen}
              aria-label={fullscreen ? "Leave full screen" : "Full screen"}
              title={fullscreen ? "Leave full screen (Esc)" : "Full screen"}
            >
              {fullscreen ? <IconMinimize /> : <IconMaximize />}
            </Button>
            <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Close">
              <IconX />
            </Button>
          </div>
        </div>

        {/* Three columns: input · parameters · output. Drag the dividers to
            trade width between them; the split is remembered. */}
        <ResizablePanelGroup
          id={LAYOUT_KEY}
          className="min-h-0 flex-1"
          defaultLayout={defaultLayout}
          onLayoutChanged={onLayoutChanged}
        >
          {/* Input */}
          <ResizablePanel id="input" defaultSize="29%" minSize="12%" className={column}>
            <div className={heading}>
              Input
              {inputIsSample && inputNode && (
                <Badge variant="outline" className="text-[9px]">
                  declared schema
                </Badge>
              )}
            </div>

            {upstream.length === 0 ? (
              <p className="text-[11px] text-muted-foreground">
                Nothing is wired into this node. Connect one, or address any node directly with{" "}
                <code className="font-mono">{'$node["Label"]'}</code>.
              </p>
            ) : (
              <>
                {/* Every upstream node is available at once — pick whose fields
                    to browse; expressions can mix as many as you like. */}
                <div className="flex flex-wrap gap-1">
                  {upstream.map((n) => (
                    <Button
                      key={n.id}
                      size="xs"
                      variant={n.id === inputNode?.id ? "default" : "outline"}
                      onClick={() => setInputNodeId(n.id)}
                      title={
                        parents[0] === n.id
                          ? "Primary connection — this one is $json"
                          : parents.includes(n.id)
                            ? "Connected — address it as $node[…]"
                            : "Further upstream — address it as $node[…]"
                      }
                    >
                      {parents[0] === n.id && <span className="font-mono">$json</span>}
                      {n.label}
                    </Button>
                  ))}
                </div>

                {inputNode && (
                  <>
                    <p className="flex flex-wrap items-center gap-1 text-[10px] text-muted-foreground">
                      {isPrimaryParent ? (
                        <>
                          <code className="font-mono">$json</code> ·{" "}
                        </>
                      ) : null}
                      <code className="font-mono">{`$node["${inputNode.label}"]`}</code> ·{" "}
                      {inputSchema ? describeSchema(inputSchema) : ""}
                      {parents.includes(inputNode.id) && !isPrimaryParent && parents.length > 1 && (
                        <Button
                          size="xs"
                          variant="outline"
                          className="ml-auto"
                          title="Make this connection the one $json refers to"
                          onClick={() => onMakePrimary(node.id, inputNode.id)}
                        >
                          Make $json
                        </Button>
                      )}
                    </p>
                    <ResultTabs
                      key={inputNode.id}
                      schemaValue={inputValue}
                      dataValue={inputValue}
                      root={
                        isPrimaryParent ? "$json" : `$node[${JSON.stringify(inputNode.label)}]`
                      }
                      rootLabel={inputNode.label}
                      fields={inputSchema?.fields}
                      initialTab={inputIsSample ? "schema" : "table"}
                      selectable
                    />
                  </>
                )}
              </>
            )}
          </ResizablePanel>

          <ResizableHandle withHandle />

          {/* What the node does: parameters, a condition, or a snippet */}
          <ResizablePanel id="body" defaultSize="33%" minSize="12%" className={column}>
            <div className={heading}>
              {BODY_HEADING[node.kind] ?? "Parameters"}
              {node.kind === "service" && (
                <span className="text-[10px] font-normal text-muted-foreground">
                  {node.params.length} input{node.params.length === 1 ? "" : "s"}
                </span>
              )}
              {filterPreview && (
                <Badge
                  variant="outline"
                  className={cn(
                    "text-[9px]",
                    filterPreview.error
                      ? "border-destructive/50 text-destructive"
                      : filterPreview.warning
                        ? "border-amber-500/50 text-amber-600 dark:text-amber-400"
                        : "border-emerald-500/50 text-emerald-600 dark:text-emerald-400"
                  )}
                  title={filterPreview.error ?? filterPreview.warning}
                >
                  {filterPreview.error
                    ? "condition fails"
                    : `would keep ${filterPreview.kept} of ${filterPreview.total}`}
                </Badge>
              )}
              {preview && (
                <Badge
                  variant="outline"
                  className={cn(
                    "text-[9px]",
                    preview.error
                      ? "border-destructive/50 text-destructive"
                      : preview.branch === "true"
                        ? "border-emerald-500/50 text-emerald-600 dark:text-emerald-400"
                        : preview.branch === undefined || preview.branch === "false"
                          ? "border-rose-500/50 text-rose-600 dark:text-rose-400"
                          : "border-primary/50 text-primary"
                  )}
                >
                  {preview.error
                    ? "condition fails"
                    : preview.branch === undefined
                      ? "would match nothing"
                      : `would take ${"matched" in preview ? preview.matched : preview.branch}`}
                </Badge>
              )}
            </div>

            {node.kind === "code" ? (
              <>
                <CodeEditor
                  code={node.code ?? ""}
                  timeoutMs={node.timeoutMs}
                  onChange={(code) => onChange(node.id, { code })}
                  onTimeoutChange={(timeoutMs) => onChange(node.id, { timeoutMs })}
                />
                <Textarea
                  value={node.notes ?? ""}
                  onChange={(e) => onChange(node.id, { notes: e.target.value })}
                  placeholder="Notes — why this step exists…"
                  className="min-h-9 shrink-0 text-[11px]"
                />
              </>
            ) : (
              <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-auto pr-1">
                {node.kind !== "service" ? (
                  <div className="border-b pb-2.5">
                    <NodeSettings
                      node={node}
                      ctx={ctx}
                      state={state}
                      parents={parents.map(
                        (id) => graph.nodes.find((n) => n.id === id)?.label ?? ""
                      )}
                      fields={incomingFields}
                      onChange={(patch) => onChange(node.id, patch)}
                    />
                  </div>
                ) : (
                  <>
                    {node.params.length === 0 && (
                      <p className="text-[11px] text-muted-foreground">
                        This service takes no parameters.
                      </p>
                    )}
                    {node.params.map((param) => (
                      <div key={param.name} className="border-b pb-2.5 last:border-b-0">
                        <ExpressionField
                          param={param}
                          value={node.inputs?.[param.name] ?? ""}
                          ctx={ctx}
                          runError={state?.inputErrors?.[param.name]}
                          onChange={(value) =>
                            onChange(node.id, { inputs: { ...node.inputs, [param.name]: value } })
                          }
                        />
                      </div>
                    ))}
                  </>
                )}

                <div className="mt-1">
                  <p className="mb-1 text-[10px] text-muted-foreground">Notes</p>
                  <Textarea
                    value={node.notes ?? ""}
                    onChange={(e) => onChange(node.id, { notes: e.target.value })}
                    placeholder="Why this step exists…"
                    className="min-h-12 text-[11px]"
                  />
                </div>
              </div>
            )}
          </ResizablePanel>

          <ResizableHandle withHandle />

          {/* Output */}
          <ResizablePanel id="output" defaultSize="38%" minSize="12%" className={column}>
            <div className={heading}>
              Output
              {schema.dataShape ? (
                <Badge
                  variant="outline"
                  className="text-[10px] hover:border-primary/50 hover:text-primary"
                  render={
                    <a
                      href={twxEntityHref({
                        env,
                        type: "DataShapes",
                        entity: schema.dataShape,
                        focus: "code",
                      })}
                      target="_blank"
                      rel="noopener"
                    />
                  }
                  title={`Open ${schema.dataShape} in TWX Entities`}
                >
                  {describeSchema(schema)}
                  <IconExternalLink data-icon="inline-end" />
                </Badge>
              ) : (
                <Badge variant="outline" className="text-[10px]">
                  {describeSchema(schema)}
                </Badge>
              )}
              {outputIsSample ? (
                <Badge variant="outline" className="text-[9px]">
                  not run yet
                </Badge>
              ) : (
                <span
                  className={cn(
                    "text-[10px] font-normal",
                    state?.status === "ok" ? "text-emerald-600" : "text-destructive"
                  )}
                >
                  {state?.status} · {state?.ms}ms
                  {state?.rows !== undefined ? ` · ${state.rows} rows` : ""}
                  {state?.branch ? ` · took ${state.branch}` : ""}
                </span>
              )}
              {node.kind === "service" && (
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className="ml-auto"
                  aria-label="Reload the declared schema"
                  title="Reload the declared DataShape"
                  onClick={() => onRefreshSchema(node.id)}
                >
                  <IconRefresh />
                </Button>
              )}
            </div>

            {state?.status === "error" && (
              <p className="flex items-start gap-1.5 rounded-md border border-destructive/40 bg-destructive/10 p-2 text-[11px] text-destructive">
                <IconAlertCircle className="mt-0.5 size-3.5 shrink-0" />
                <span className="break-words">{state.error}</span>
              </p>
            )}

            <ResultTabs
              schemaValue={sampleFromSchema(schema)}
              dataValue={output}
              root={`$node[${JSON.stringify(node.label)}]`}
              rootLabel={node.label}
              fields={schema.fields}
              initialTab={outputIsSample ? "schema" : "table"}
              hint={
                node.kind !== "service" && outputIsSample ? (
                  <span className="ml-1 text-[10px] text-muted-foreground">
                    {OUTPUT_HINT[node.kind]}
                  </span>
                ) : schema.baseType === "INFOTABLE" && !schema.fields.length ? (
                  <span className="ml-1 text-[10px] text-muted-foreground">
                    {schema.dataShape
                      ? "DataShape not resolved — press refresh"
                      : "Shape declared dynamically"}
                  </span>
                ) : undefined
              }
            />

            {state?.logs?.length ? (
              <details className="shrink-0 rounded-md border p-1.5" open>
                <summary className="cursor-pointer text-[10px] text-muted-foreground">
                  console ({state.logs.length})
                </summary>
                <pre className="mt-1 max-h-32 overflow-auto font-mono text-[10px] whitespace-pre-wrap">
                  {state.logs.join("\n")}
                </pre>
              </details>
            ) : null}

            {state?.inputs && (
              <details className="shrink-0 rounded-md border p-1.5">
                <summary className="cursor-pointer text-[10px] text-muted-foreground">
                  {node.kind === "service" ? "Request body sent" : "What this node decided"}
                </summary>
                <JsonView value={state.inputs} className="mt-1 max-h-32 overflow-auto" />
              </details>
            )}
          </ResizablePanel>
        </ResizablePanelGroup>
      </div>
    </div>
  );
}
