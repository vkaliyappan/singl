"use client";

import { CopyButton } from "./copy-button";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useAssistantAction, useAssistantContext } from "@/lib/assistant/context";
import { addPins, usePinnables, type NewPin, type Pinnable } from "@/lib/assistant/pins";
import { setDragPins } from "@/lib/assistant/drag";
import { clipJson } from "@/lib/assistant/pin-utils";
import { Channel, invoke } from "@tauri-apps/api/core";
import {
  IconAlertTriangle,
  IconArrowBackUp,
  IconArrowForwardUp,
  IconArrowLeft,
  IconBrush,
  IconFocusCentered,
  IconLayoutAlignLeft,
  IconMessagePlus,
  IconLayoutAlignTop,
  IconPlayerPlay,
  IconPlayerStop,
  IconPlus,
  IconRefresh,
  IconTrash,
  IconZoomIn,
  IconZoomOut,
  IconZoomReset,
} from "@tabler/icons-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Spinner } from "@/components/ui/spinner";
import { forgetJob, getShared, runJob, sharedRef, useSharedState } from "@/lib/background-jobs";
import { cn } from "@/lib/utils";
import {
  newId,
  parseGraph,
  portKey,
  portOf,
  renameReferences,
  uniqueLabel,
} from "@/lib/twx-flow/graph";
import {
  NODE_H,
  NODE_W,
  autoLayout,
  inputPortPoint,
  nodeHeight,
  outputPortPoint,
  routeWire,
  wirePath,
} from "@/lib/twx-flow/layout";
import { DEFAULT_LABEL, defaultsFor } from "@/lib/twx-flow/nodes";
import { schemaFromResultType } from "@/lib/twx-flow/schema";
import type {
  EdgePort,
  FieldDef,
  FlowEdge,
  FlowGraph,
  FlowNode,
  NodePatch,
  NodeRunState,
  RunEvent,
  ServiceNode,
} from "@/lib/twx-flow/types";
import type { ServiceDef } from "@/lib/twx/types";
import { LogPanel } from "./log-panel";
import { Minimap } from "./minimap";
import { NodeCard } from "./node-card";
import { NodePalette, type NodePick } from "./node-palette";
import { NodePanel } from "./node-panel";
import { useFlowHistory } from "./use-flow-history";
import { WireBadge } from "./wire-badge";
import { renameFlow, saveFlow } from "./actions";
import { getServiceDefinitions } from "@/lib/services";

type Env = { environment: string; twxBaseUrl: string; hasAppKey: boolean };

type Camera = { x: number; y: number; z: number };

type Interaction =
  | { kind: "pan"; originX: number; originY: number; camera: Camera }
  | {
      kind: "drag-node";
      originX: number;
      originY: number;
      starts: Record<string, { x: number; y: number }>;
    }
  | { kind: "marquee"; x0: number; y0: number; base: string[] }
  | null;

type Selection = { kind: "node"; ids: string[] } | { kind: "edge"; id: string } | null;

type Marquee = { x0: number; y0: number; x1: number; y1: number } | null;

type Connecting = { source: string; port?: EdgePort; x: number; y: number } | null;

type Progress = { total: number; done: number; currentId?: string } | null;

/** What a finished run leaves behind, for whoever started it. */
type RunSummary = {
  order: string[];
  states: Record<string, NodeRunState>;
  error?: string;
  stopped?: boolean;
};

type RunOptions = {
  target?: string | string[];
  only?: string | string[];
  /** Run this graph instead of the rendered one — edits made a moment ago. */
  graph?: FlowGraph;
};

const MIN_Z = 0.25;
const MAX_Z = 2;

export function FlowEditor({
  flowId,
  flowName,
  initialGraph,
  initialEnv,
  envs,
}: {
  flowId: string;
  flowName: string;
  initialGraph: string;
  initialEnv: string;
  envs: Env[];
}) {
  const {
    graph,
    setGraph,
    undo,
    redo,
    canUndo,
    canRedo,
  } = useFlowHistory(parseGraph(initialGraph));

  const [name, setName] = useState(flowName);
  const [env, setEnv] = useState(initialEnv || envs[0]?.environment || "");
  const [camera, setCamera] = useState<Camera>({ x: 80, y: 80, z: 1 });
  const [canvasRect, setCanvasRect] = useState<{ width: number; height: number } | null>(null);
  const [selected, setSelected] = useState<Selection>(null);
  const [marquee, setMarquee] = useState<Marquee>(null);
  const [panMode, setPanMode] = useState(false);
  const [openNodeId, setOpenNodeId] = useState<string | null>(null);
  const [connecting, setConnecting] = useState<Connecting>(null);
  const [hoverEdge, setHoverEdge] = useState<string | null>(null);
  const [breakpoints, setBreakpoints] = useState<Set<string>>(new Set());
  const [palette, setPalette] = useState<{
    open: boolean;
    connectFrom?: string;
    connectPort?: EdgePort;
    at?: { x: number; y: number };
  }>({ open: false });
  // Run state lives outside this component (@/lib/background-jobs), keyed by
  // flow, so a run keeps going and showing after the user leaves and returns.
  const runKey = `flow:${flowId}`;
  const [runStates, setRunStates] = useSharedState<Record<string, NodeRunState>>(`${runKey}:states`, {});
  const [progress, setProgress] = useSharedState<Progress>(`${runKey}:progress`, null);
  const [running, setRunning] = useSharedState(`${runKey}:running`, false);
  const [runError, setRunError] = useSharedState(`${runKey}:error`, "");
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [runOrder, setRunOrder] = useSharedState<string[]>(`${runKey}:order`, []);
  const [runMs, setRunMs] = useSharedState<number | null>(`${runKey}:ms`, null);
  const [logOpen, setLogOpen] = useState(() => getShared(`${runKey}:running`, false));
  const [logNodeId, setLogNodeId] = useState<string | null>(null);

  const canvasRef = useRef<HTMLDivElement>(null);
  const interaction = useRef<Interaction>(null);
  const clipboard = useRef<{ nodes: FlowNode[]; edges: FlowEdge[] } | null>(null);
  const dirty = useRef(false);
  /** Id of the run in flight, which `job_cancel` stops. */
  const abortRef = sharedRef<string | null>(`${runKey}:abort`, null);
  /** Runs the user stopped; their late events are dropped. */
  const stoppedRunsRef = sharedRef(`${runKey}:stopped`, new Set<string>());
  const startedAtRef = sharedRef(`${runKey}:startedAt`, 0);

  const nodesById = useMemo(() => new Map(graph.nodes.map((n) => [n.id, n])), [graph.nodes]);

  const selectedNodeIds = useMemo(
    () => (selected?.kind === "node" ? selected.ids : []),
    [selected]
  );
  const selectedNodes = useMemo(() => new Set(selectedNodeIds), [selectedNodeIds]);

  // ── Assistant: the open flow and what is selected ─────────────────────────
  useAssistantContext({
    screen: "twx-flow",
    title: "Service Flow",
    summary: `Flow "${name}" open (${graph.nodes.length} nodes, ${graph.edges.length} edges)${
      selectedNodeIds.length ? `, ${selectedNodeIds.length} selected` : ""
    }`,
    data: {
      flowId,
      flowName: name,
      env,
      nodeCount: graph.nodes.length,
      nodes: graph.nodes.slice(0, 60).map((n) => ({ id: n.id, kind: n.kind, label: n.label })),
      openNodeId,
    },
    selection: {
      nodes: selectedNodeIds.map((id) => {
        const n = nodesById.get(id);
        return n ? { id, kind: n.kind, label: n.label, inputs: n.inputs } : { id };
      }),
      edges: selected?.kind === "edge" ? [graph.edges.find((e) => e.id === selected.id) ?? { id: selected.id }] : [],
    },
  });
  useAssistantAction(
    "select_nodes",
    {
      description: "Select nodes in the open flow by id or label.",
      inputSchema: { type: "object", properties: { nodes: { type: "array", items: { type: "string" } } }, required: ["nodes"] },
    },
    (args) => {
      const wanted = ((args as { nodes?: string[] }).nodes ?? []).map(String);
      const ids = graph.nodes.filter((n) => wanted.includes(n.id) || wanted.includes(n.label)).map((n) => n.id);
      setSelected(ids.length ? { kind: "node", ids } : null);
      return { selected: ids };
    }
  );

  // ── Add to chat: nodes, the whole flow, and the last run ──────────────────
  const nodePin = useCallback(
    (id: string): NewPin | null => {
      const n = nodesById.get(id);
      if (!n) return null;
      const { x: _x, y: _y, ...config } = n;
      void _x;
      void _y;
      const label = (nid: string) => nodesById.get(nid)?.label ?? nid;
      return {
        kind: "node",
        label: `${name} · ${n.label}`,
        screen: "twx-flow",
        detail: n.kind,
        content: clipJson({
          flow: name,
          environment: env,
          type: n.kind,
          config,
          inputs: n.inputs,
          outputs: graph.edges
            .filter((e) => e.source === id)
            .map((e) => ({ to: label(e.target), port: e.sourcePort })),
          receivesFrom: graph.edges.filter((e) => e.target === id).map((e) => label(e.source)),
        }),
      };
    },
    [nodesById, graph.edges, name, env]
  );

  const flowPin = useCallback(
    (): NewPin => ({
      kind: "flow",
      label: name,
      screen: "twx-flow",
      detail: `${graph.nodes.length} nodes · ${graph.edges.length} wires`,
      content: clipJson({ name, environment: env, ...graph }),
    }),
    [name, env, graph]
  );

  /** Last run of one node (id given) or of the whole flow. */
  const resultPin = useCallback(
    (id?: string): NewPin | null => {
      const labelOf = (nid: string) => nodesById.get(nid)?.label ?? nid;
      const stateOf = (nid: string) => {
        const s = runStates[nid];
        if (!s) return null;
        return {
          node: labelOf(nid),
          status: s.status,
          ms: s.ms,
          error: s.error,
          inputErrors: s.inputErrors,
          rows: s.rows,
          iterations: s.iterations,
          inputs: s.inputs,
          result: s.result,
          logs: s.logs?.slice(-100),
        };
      };
      if (id) {
        const st = stateOf(id);
        if (!st) return null;
        return {
          kind: "result",
          label: `Result · ${name} · ${labelOf(id)}`,
          screen: "twx-flow",
          detail: st.error ? "failed" : st.status,
          content: clipJson(st),
        };
      }
      const ids = (runOrder.length ? runOrder : Object.keys(runStates)).filter((nid) => runStates[nid]);
      if (!ids.length && !runError) return null;
      // Share the size budget: results are the bulky part, so each node gets an even slice.
      const per = Math.max(2000, Math.floor(30000 / Math.max(1, ids.length)));
      const nodes = ids.map((nid) => {
        const st = stateOf(nid)!;
        const resultText = clipJson(st.result, per);
        return { ...st, result: undefined, resultPreview: resultText };
      });
      return {
        kind: "result",
        label: `Last run · ${name}`,
        screen: "twx-flow",
        detail: `${ids.length} nodes${runMs != null ? ` · ${runMs} ms` : ""}${runError ? " · failed" : ""}`,
        content: clipJson({ flow: name, environment: env, totalMs: runMs, error: runError || undefined, nodes }),
      };
    },
    [nodesById, runStates, runOrder, runError, runMs, name, env]
  );

  const pinSelection = useCallback(() => {
    const pins = selectedNodeIds.flatMap((id) => nodePin(id) ?? []);
    if (pins.length) addPins(pins);
  }, [selectedNodeIds, nodePin]);

  const pinnables: Pinnable[] = [
    { kind: "flow", label: name, detail: "whole flow definition", content: () => flowPin().content },
  ];
  for (const id of selectedNodeIds.slice(0, 10)) {
    const n = nodesById.get(id);
    if (!n) continue;
    pinnables.push({ kind: "node", label: `${name} · ${n.label}`, detail: n.kind, content: () => nodePin(id)?.content ?? "" });
    if (runStates[id]) {
      pinnables.push({ kind: "result", label: `Result · ${name} · ${n.label}`, detail: runStates[id].status, content: () => resultPin(id)?.content ?? "" });
    }
  }
  if (Object.keys(runStates).length > 0 || runError) {
    pinnables.push({ kind: "result", label: `Last run · ${name}`, detail: "all node results and logs", content: () => resultPin()?.content ?? "" });
  }
  usePinnables(pinnables);

  const routes = useMemo(() => {
    const byId = new Map(graph.nodes.map((n) => [n.id, n]));
    const out = new Map<string, { d: string; mid: { x: number; y: number } }>();
    for (const edge of graph.edges) {
      const from = byId.get(edge.source);
      const to = byId.get(edge.target);
      if (!from || !to) continue;
      const obstacles = graph.nodes
        .filter((n) => n.id !== edge.source && n.id !== edge.target)
        .map((n) => ({ x: n.x, y: n.y, w: NODE_W, h: nodeHeight(n) }));
      out.set(
        edge.id,
        routeWire(outputPortPoint(from, portOf(edge, from)), inputPortPoint(to), obstacles)
      );
    }
    return out;
  }, [graph.nodes, graph.edges]);
  const openNode = openNodeId ? (nodesById.get(openNodeId) ?? null) : null;

  /* ------------------------------------------------------------- geometry -- */

  const toWorld = useCallback(
    (clientX: number, clientY: number) => {
      const rect = canvasRef.current?.getBoundingClientRect();
      const sx = clientX - (rect?.left ?? 0);
      const sy = clientY - (rect?.top ?? 0);
      return { x: (sx - camera.x) / camera.z, y: (sy - camera.y) / camera.z };
    },
    [camera]
  );

  const viewportCentre = useCallback(() => {
    const rect = canvasRef.current?.getBoundingClientRect();
    const w = rect?.width ?? 800;
    const h = rect?.height ?? 600;
    return {
      x: (w / 2 - camera.x) / camera.z - NODE_W / 2,
      y: (h / 2 - camera.y) / camera.z - NODE_H / 2,
    };
  }, [camera]);

  /* ---------------------------------------------------------- persistence -- */

  useEffect(() => {
    if (!dirty.current) return;
    setSaveState("saving");
    const timer = setTimeout(async () => {
      const res = await saveFlow(flowId, JSON.stringify(graph), env);
      setSaveState(res.error ? "error" : "saved");
    }, 700);
    return () => clearTimeout(timer);
  }, [graph, env, flowId]);

  const mutate = useCallback(
    (updater: (g: FlowGraph) => FlowGraph) => {
      dirty.current = true;
      setGraph(updater);
    },
    [setGraph]
  );

  /* --------------------------------------------------------------- schema -- */

  const resolveSchemas = useCallback(
    async (nodes: FlowNode[]) => {
      const names = [
        ...new Set(
          nodes
            .map((n) => (n.kind === "service" ? n.outputSchema?.dataShape : undefined))
            .filter((n): n is string => !!n)
        ),
      ];
      if (!env || !names.length) return;
      try {
        const shapes = await invoke<Record<string, FieldDef[]>>("flow_datashape_fields", { env, names });
        const ids = new Set(nodes.map((n) => n.id));
        mutate((g) => ({
          ...g,
          nodes: g.nodes.map((n) => {
            if (n.kind !== "service") return n;
            const shape = n.outputSchema?.dataShape;
            if (!ids.has(n.id) || !shape || !shapes[shape]?.length) return n;
            return { ...n, outputSchema: { ...n.outputSchema!, fields: shapes[shape] } };
          }),
        }));
      } catch {
        // Ignore unresolvable schemas
      }
    },
    [env, mutate]
  );

  useEffect(() => {
    void resolveSchemas(graph.nodes);
  }, [env, resolveSchemas]); // eslint-disable-line react-hooks/exhaustive-deps

  // Service nodes the palette never touched (written by the assistant or by
  // hand) have no parameter list, so a run would send them no inputs. Fill
  // params, resultType and the declared output from the server, once per env.
  useEffect(() => {
    const bare = graph.nodes.filter(
      (n): n is ServiceNode => n.kind === "service" && !n.outputSchema
    );
    if (!env || !bare.length) return;
    let cancelled = false;
    void (async () => {
      const keys = [...new Set(bare.map((n) => `${n.collection} ${n.entityName}`))];
      const found = new Map<string, ServiceDef>();
      await Promise.all(
        keys.map(async (key) => {
          const [collection, entity] = key.split(" ");
          try {
            for (const def of await getServiceDefinitions(env, collection, entity)) {
              found.set(`${key} ${def.name}`, def);
            }
          } catch {
            // Unknown entity or offline: leave the node as it is.
          }
        })
      );
      if (cancelled) return;
      const filled = new Map<string, ServiceNode>();
      for (const n of bare) {
        const def = found.get(`${n.collection} ${n.entityName} ${n.serviceName}`);
        if (!def) continue;
        filled.set(n.id, {
          ...n,
          params: def.parameterDefinitions,
          resultType: def.resultType,
          outputSchema: schemaFromResultType(def.resultType),
        });
      }
      if (!filled.size) return;
      mutate((g) => ({
        ...g,
        nodes: g.nodes.map((n) => {
          const next = filled.get(n.id);
          // Keep edits made while the definitions loaded; add only what was missing.
          return next && n.kind === "service" && !n.outputSchema
            ? { ...n, params: next.params, resultType: next.resultType, outputSchema: next.outputSchema }
            : n;
        }),
      }));
      void resolveSchemas([...filled.values()]);
    })();
    return () => {
      cancelled = true;
    };
  }, [env]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ------------------------------------------------------------ mutations -- */

  const addNode = useCallback(
    (pick: NodePick) => {
      const id = newId();
      let node: FlowNode;
      const pos = palette.at ?? viewportCentre();

      if (pick.kind === "service") {
        const shape = pick.service.resultType.aspects?.dataShape;
        const schema = schemaFromResultType(pick.service.resultType);
        const defaultInputs: Record<string, string> = {};
        for (const p of pick.service.parameterDefinitions ?? []) {
          if (p.aspects?.defaultValue != null) {
            defaultInputs[p.name] = String(p.aspects.defaultValue);
          }
        }
        node = {
          id,
          x: Math.round(pos.x),
          y: Math.round(pos.y),
          label: uniqueLabel(graph.nodes, pick.service.name),
          kind: "service",
          collection: pick.collection,
          entityName: pick.entityName,
          serviceName: pick.service.name,
          params: pick.service.parameterDefinitions,
          resultType: pick.service.resultType,
          outputSchema:
            schema ??
            (shape ? { baseType: "INFOTABLE", dataShape: shape, fields: [] } : undefined),
          inputs: defaultInputs,
        };
      } else {
        const defaults = defaultsFor(pick.kind);
        node = {
          id,
          x: Math.round(pos.x),
          y: Math.round(pos.y),
          kind: pick.kind,
          label: uniqueLabel(graph.nodes, pick.label ?? DEFAULT_LABEL[pick.kind]),
          inputs: {},
          ...defaults,
          // A preset row (an agent CLI) narrows the kind's defaults further.
          ...(pick.patch ?? {}),
        } as FlowNode;
      }

      mutate((g) => {
        const nextEdges = palette.connectFrom
          ? [
              ...g.edges,
              {
                id: newId(),
                source: palette.connectFrom,
                target: id,
                sourcePort: palette.connectPort,
              },
            ]
          : g.edges;
        return { nodes: [...g.nodes, node], edges: nextEdges };
      });

      setSelected({ kind: "node", ids: [id] });
      setPalette({ open: false });
      if (node.kind === "service") void resolveSchemas([node]);
    },
    [graph.nodes, mutate, palette.at, palette.connectFrom, palette.connectPort, resolveSchemas, viewportCentre]
  );

  const patchNode = useCallback(
    (id: string, patch: NodePatch) => {
      mutate((g) => ({
        ...g,
        nodes: g.nodes.map((n) => (n.id === id ? ({ ...n, ...patch } as FlowNode) : n)),
      }));
    },
    [mutate]
  );

  const renameNode = useCallback(
    (id: string, nextLabel: string) => {
      const old = nodesById.get(id);
      if (!old || old.label === nextLabel) return;
      // References follow the node's title, so they are rewritten along with it.
      mutate((g) => {
        const renamed = renameReferences(g, old.label, nextLabel);
        return {
          ...renamed,
          nodes: renamed.nodes.map((n) => (n.id === id ? { ...n, label: nextLabel } : n)),
        };
      });
    },
    [mutate, nodesById]
  );

  const removeNode = useCallback(
    (id: string) => {
      mutate((g) => ({
        nodes: g.nodes.filter((n) => n.id !== id),
        edges: g.edges.filter((e) => e.source !== id && e.target !== id),
      }));
      setSelected(null);
      if (openNodeId === id) setOpenNodeId(null);
    },
    [mutate, openNodeId]
  );

  const removeNodes = useCallback(
    (ids: string[]) => {
      const drop = new Set(ids);
      mutate((g) => ({
        nodes: g.nodes.filter((n) => !drop.has(n.id)),
        edges: g.edges.filter((e) => !drop.has(e.source) && !drop.has(e.target)),
      }));
      setSelected(null);
      if (openNodeId && drop.has(openNodeId)) setOpenNodeId(null);
    },
    [mutate, openNodeId]
  );

  const removeEdge = useCallback(
    (id: string) => {
      mutate((g) => ({ ...g, edges: g.edges.filter((e) => e.id !== id) }));
      setSelected(null);
    },
    [mutate]
  );

  const connect = useCallback(
    (source: string, target: string, sourcePort?: EdgePort) => {
      if (source === target) return;
      const exists = graph.edges.some(
        (e) => e.source === source && e.target === target && e.sourcePort === sourcePort
      );
      if (exists) return;
      mutate((g) => ({
        ...g,
        edges: [...g.edges, { id: newId(), source, target, sourcePort }],
      }));
    },
    [graph.edges, mutate]
  );

  const makePrimary = useCallback(
    (targetNodeId: string, edgeId: string) => {
      mutate((g) => {
        const edge = g.edges.find((e) => e.id === edgeId);
        if (!edge) return g;
        const others = g.edges.filter((e) => e.id !== edgeId);
        return { ...g, edges: [edge, ...others] };
      });
    },
    [mutate]
  );

  const duplicateNodes = useCallback(
    (ids: string[]) => {
      const drop = new Set(ids);
      const originalNodes = graph.nodes.filter((n) => drop.has(n.id));
      if (!originalNodes.length) return;

      const idMap = new Map<string, string>();
      const clonedNodes: FlowNode[] = [];

      const workingNodes = [...graph.nodes];
      for (const n of originalNodes) {
        const freshId = newId();
        idMap.set(n.id, freshId);
        const freshLabel = uniqueLabel(workingNodes, n.label);
        const clone: FlowNode = {
          ...n,
          id: freshId,
          label: freshLabel,
          x: n.x + 40,
          y: n.y + 40,
        };
        clonedNodes.push(clone);
        workingNodes.push(clone);
      }

      const internalEdges = graph.edges
        .filter((e) => drop.has(e.source) && drop.has(e.target))
        .map((e) => ({
          id: newId(),
          source: idMap.get(e.source)!,
          target: idMap.get(e.target)!,
          sourcePort: e.sourcePort,
        }));

      mutate((g) => ({
        nodes: [...g.nodes, ...clonedNodes],
        edges: [...g.edges, ...internalEdges],
      }));

      setSelected({ kind: "node", ids: clonedNodes.map((n) => n.id) });
    },
    [graph.edges, graph.nodes, mutate]
  );

  /* ------------------------------------------------------------- gestures -- */

  const onCanvasPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if ((e.target as HTMLElement).closest("[data-canvas-ui]")) return;
      const isMiddle = e.button === 1;
      const isLeft = e.button === 0;
      if (!isMiddle && !isLeft) return;

      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);

      if (isMiddle || panMode || e.altKey) {
        interaction.current = {
          kind: "pan",
          originX: e.clientX,
          originY: e.clientY,
          camera: { ...camera },
        };
        return;
      }

      if (isLeft) {
        const world = toWorld(e.clientX, e.clientY);
        const base = e.shiftKey || e.ctrlKey || e.metaKey ? selectedNodeIds : [];
        interaction.current = { kind: "marquee", x0: world.x, y0: world.y, base };
        setMarquee({ x0: world.x, y0: world.y, x1: world.x, y1: world.y });
        if (!base.length) setSelected(null);
      }
    },
    [camera, panMode, selectedNodeIds, toWorld]
  );

  const onCanvasPointerMove = useCallback(
    (e: React.PointerEvent) => {
      const it = interaction.current;
      if (connecting) {
        const world = toWorld(e.clientX, e.clientY);
        setConnecting((c) => (c ? { ...c, x: world.x, y: world.y } : c));
      }
      if (!it) return;
      if (it.kind === "pan") {
        setCamera({
          x: it.camera.x + (e.clientX - it.originX),
          y: it.camera.y + (e.clientY - it.originY),
          z: it.camera.z,
        });
      } else if (it.kind === "marquee") {
        const world = toWorld(e.clientX, e.clientY);
        setMarquee({ x0: it.x0, y0: it.y0, x1: world.x, y1: world.y });
        const minX = Math.min(it.x0, world.x);
        const maxX = Math.max(it.x0, world.x);
        const minY = Math.min(it.y0, world.y);
        const maxY = Math.max(it.y0, world.y);
        const hit = graph.nodes
          .filter(
            (n) => n.x < maxX && n.x + NODE_W > minX && n.y < maxY && n.y + nodeHeight(n) > minY
          )
          .map((n) => n.id);
        const ids = [...new Set([...it.base, ...hit])];
        setSelected(ids.length ? { kind: "node", ids } : null);
      } else {
        const world = toWorld(e.clientX, e.clientY);
        const dx = world.x - it.originX;
        const dy = world.y - it.originY;
        mutate((g) => ({
          ...g,
          nodes: g.nodes.map((n) => {
            const start = it.starts[n.id];
            return start
              ? { ...n, x: Math.round(start.x + dx), y: Math.round(start.y + dy) }
              : n;
          }),
        }));
      }
    },
    [connecting, graph.nodes, mutate, toWorld]
  );

  const endInteraction = useCallback((e: React.PointerEvent) => {
    interaction.current = null;
    setMarquee(null);
    const el = e.currentTarget as HTMLElement;
    if (el.hasPointerCapture?.(e.pointerId)) el.releasePointerCapture(e.pointerId);
  }, []);

  const onCanvasPointerUp = useCallback(
    (e: React.PointerEvent) => {
      endInteraction(e);
      if (!connecting) return;
      const port = (e.target as HTMLElement).closest<HTMLElement>("[data-input-port]");
      const nodeId = port?.dataset.nodeId;
      if (nodeId) {
        connect(connecting.source, nodeId, connecting.port);
      } else {
        const world = toWorld(e.clientX, e.clientY);
        setPalette({
          open: true,
          connectFrom: connecting.source,
          connectPort: connecting.port,
          at: { x: world.x, y: world.y - NODE_H / 2 },
        });
      }
      setConnecting(null);
    },
    [connect, connecting, endInteraction, toWorld]
  );

  useEffect(() => {
    if (!connecting) return;
    const cancel = () => setConnecting(null);
    window.addEventListener("pointerup", cancel);
    return () => window.removeEventListener("pointerup", cancel);
  }, [connecting]);

  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;

    const handleWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;

      if (e.ctrlKey || e.metaKey) {
        // Zooming via Ctrl+Wheel or Trackpad pinch
        const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
        setCamera((cam) => {
          const nextZ = Math.min(MAX_Z, Math.max(MIN_Z, cam.z * factor));
          const k = nextZ / cam.z;
          return {
            x: sx - (sx - cam.x) * k,
            y: sy - (sy - cam.y) * k,
            z: nextZ,
          };
        });
      } else {
        // Panning canvas
        setCamera((cam) => ({
          ...cam,
          x: cam.x - e.deltaX,
          y: cam.y - e.deltaY,
        }));
      }
    };

    el.addEventListener("wheel", handleWheel, { passive: false });
    return () => el.removeEventListener("wheel", handleWheel);
  }, []);

  const zoomBy = useCallback((factor: number) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    const sx = (rect?.width ?? 800) / 2;
    const sy = (rect?.height ?? 600) / 2;
    setCamera((cam) => {
      const next = Math.min(MAX_Z, Math.max(MIN_Z, cam.z * factor));
      const k = next / cam.z;
      return { x: sx - (sx - cam.x) * k, y: sy - (sy - cam.y) * k, z: next };
    });
  }, []);

  const fitTo = useCallback((nodes: FlowNode[]) => {
    if (!nodes.length) return;
    const rect = canvasRef.current?.getBoundingClientRect();
    const vw = rect?.width ?? 800;
    const vh = rect?.height ?? 600;
    const minX = Math.min(...nodes.map((n) => n.x));
    const minY = Math.min(...nodes.map((n) => n.y));
    const maxX = Math.max(...nodes.map((n) => n.x + NODE_W));
    const maxY = Math.max(...nodes.map((n) => n.y + nodeHeight(n)));
    const pad = 80;
    const z = Math.min(
      MAX_Z,
      Math.max(
        MIN_Z,
        Math.min((vw - pad * 2) / (maxX - minX || 1), (vh - pad * 2) / (maxY - minY || 1))
      )
    );
    setCamera({
      x: vw / 2 - ((minX + maxX) / 2) * z,
      y: vh / 2 - ((minY + maxY) / 2) * z,
      z,
    });
  }, []);

  const fitToNodes = useCallback(() => fitTo(graph.nodes), [fitTo, graph.nodes]);

  const resetZoom = useCallback(() => {
    const rect = canvasRef.current?.getBoundingClientRect();
    const sx = (rect?.width ?? 800) / 2;
    const sy = (rect?.height ?? 600) / 2;
    setCamera((cam) => {
      const k = 1 / cam.z;
      return { x: sx - (sx - cam.x) * k, y: sy - (sy - cam.y) * k, z: 1 };
    });
  }, []);

  const tidy = useCallback(() => {
    const laid = autoLayout(graph);
    mutate((g) => ({ ...g, nodes: laid }));
    fitTo(laid);
  }, [fitTo, graph, mutate]);

  const panTo = useCallback((worldX: number, worldY: number) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    const vw = rect?.width ?? 800;
    const vh = rect?.height ?? 600;
    setCamera((cam) => ({
      x: vw / 2 - worldX * cam.z,
      y: vh / 2 - worldY * cam.z,
      z: cam.z,
    }));
  }, []);

  const toggleBreakpoint = useCallback((id: string) => {
    setBreakpoints((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const copySelection = useCallback(() => {
    if (selectedNodeIds.length === 0) return;
    const selSet = new Set(selectedNodeIds);
    const nodesToCopy = graph.nodes.filter((n) => selSet.has(n.id));
    const edgesToCopy = graph.edges.filter(
      (e) => selSet.has(e.source) && selSet.has(e.target)
    );
    clipboard.current = { nodes: nodesToCopy, edges: edgesToCopy };
  }, [graph.edges, graph.nodes, selectedNodeIds]);

  const pasteSelection = useCallback(() => {
    if (!clipboard.current || clipboard.current.nodes.length === 0) return;
    const idMap = new Map<string, string>();
    const workingNodes = [...graph.nodes];
    const newNodes: FlowNode[] = [];

    for (const n of clipboard.current.nodes) {
      const freshId = newId();
      idMap.set(n.id, freshId);
      const freshLabel = uniqueLabel(workingNodes, n.label);
      const clone: FlowNode = {
        ...n,
        id: freshId,
        label: freshLabel,
        x: n.x + 40,
        y: n.y + 40,
      };
      newNodes.push(clone);
      workingNodes.push(clone);
    }

    const newEdges: FlowEdge[] = clipboard.current.edges.map((e) => ({
      ...e,
      id: newId(),
      source: idMap.get(e.source)!,
      target: idMap.get(e.target)!,
    }));
    mutate((g) => ({
      nodes: [...g.nodes, ...newNodes],
      edges: [...g.edges, ...newEdges],
    }));
    setSelected({ kind: "node", ids: newNodes.map((n) => n.id) });
  }, [graph.nodes, mutate]);

  const alignLeft = useCallback(() => {
    if (selectedNodeIds.length < 2) return;
    const minX = Math.min(
      ...graph.nodes.filter((n) => selectedNodes.has(n.id)).map((n) => n.x)
    );
    mutate((g) => ({
      ...g,
      nodes: g.nodes.map((n) => (selectedNodes.has(n.id) ? { ...n, x: minX } : n)),
    }));
  }, [graph.nodes, mutate, selectedNodeIds.length, selectedNodes]);

  const alignTop = useCallback(() => {
    if (selectedNodeIds.length < 2) return;
    const minY = Math.min(
      ...graph.nodes.filter((n) => selectedNodes.has(n.id)).map((n) => n.y)
    );
    mutate((g) => ({
      ...g,
      nodes: g.nodes.map((n) => (selectedNodes.has(n.id) ? { ...n, y: minY } : n)),
    }));
  }, [graph.nodes, mutate, selectedNodeIds.length, selectedNodes]);

  const distributeHorizontally = useCallback(() => {
    if (selectedNodeIds.length < 3) return;
    const nodes = graph.nodes
      .filter((n) => selectedNodes.has(n.id))
      .sort((a, b) => a.x - b.x);
    const minX = nodes[0].x;
    const maxX = nodes[nodes.length - 1].x;
    const step = (maxX - minX) / (nodes.length - 1);
    const posMap = new Map(nodes.map((n, i) => [n.id, Math.round(minX + i * step)]));
    mutate((g) => ({
      ...g,
      nodes: g.nodes.map((n) => (posMap.has(n.id) ? { ...n, x: posMap.get(n.id)! } : n)),
    }));
  }, [graph.nodes, mutate, selectedNodeIds.length, selectedNodes]);

  const distributeVertically = useCallback(() => {
    if (selectedNodeIds.length < 3) return;
    const nodes = graph.nodes
      .filter((n) => selectedNodes.has(n.id))
      .sort((a, b) => a.y - b.y);
    const minY = nodes[0].y;
    const maxY = nodes[nodes.length - 1].y;
    const step = (maxY - minY) / (nodes.length - 1);
    const posMap = new Map(nodes.map((n, i) => [n.id, Math.round(minY + i * step)]));
    mutate((g) => ({
      ...g,
      nodes: g.nodes.map((n) => (posMap.has(n.id) ? { ...n, y: posMap.get(n.id)! } : n)),
    }));
  }, [graph.nodes, mutate, selectedNodeIds.length, selectedNodes]);

  useEffect(() => {
    if (!canvasRef.current) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) {
        setCanvasRect({ width: entry.contentRect.width, height: entry.contentRect.height });
      }
    });
    observer.observe(canvasRef.current);
    return () => observer.disconnect();
  }, []);

  /* ------------------------------------------------------------------ run -- */

  const applyEvent = useCallback((event: RunEvent) => {
    switch (event.type) {
      case "start":
        setProgress({ total: event.order.length, done: 0 });
        setRunStates((prev) => {
          const next = { ...prev };
          for (const id of [...event.order, ...event.cycle]) delete next[id];
          return next;
        });
        startedAtRef.current = performance.now();
        setRunMs(null);
        setRunOrder([...event.order, ...event.cycle]);
        setLogOpen(true);
        if (event.cycle.length) {
          setRunError(
            `${event.cycle.length} node${event.cycle.length === 1 ? " is" : "s are"} wired in a circle and could not run — see the logs below.`
          );
        }
        break;
      case "node-start":
        setProgress((p) => (p ? { ...p, currentId: event.id } : p));
        setRunStates((prev) => ({ ...prev, [event.id]: { status: "running", ms: 0 } }));
        setLogNodeId(event.id);
        break;
      // Agent nodes print for minutes before they finish; their output lands
      // line by line so the log is not blank until then.
      case "node-log":
        setRunStates((prev) => {
          const current = prev[event.id] ?? { status: "running" as const, ms: 0 };
          const logs = [...(current.logs ?? []), event.line].slice(-400);
          return { ...prev, [event.id]: { ...current, logs } };
        });
        break;
      case "node-end":
        setProgress((p) => (p ? { ...p, done: p.done + 1 } : p));
        setRunStates((prev) => ({
          ...prev,
          [event.id]: event.state,
        }));
        break;
      case "error":
        setRunError(event.message);
        break;
      case "done":
        setRunMs(Math.round(performance.now() - startedAtRef.current));
        setProgress(null);
        setRunning(false);
        break;
    }
  }, [setProgress, setRunError, setRunMs, setRunOrder, setRunStates, setRunning, startedAtRef]);

  const run = useCallback(
    async (options?: RunOptions): Promise<RunSummary | null> => {
      if (running) return null;
      setRunning(true);
      setRunError("");
      const runId = newId();
      abortRef.current = runId;

      const seed: Record<string, unknown> = {};
      const seedPorts: Record<string, unknown> = {};
      for (const [id, s] of Object.entries(runStates)) {
        if (s.result !== undefined) seed[id] = s.result;
        if (s.branch !== undefined) seedPorts[portKey(id, s.branch)] = s.result;
      }
      const summary: RunSummary = { order: [], states: {} };

      // Events arrive as JSON text so infotable columns keep ThingWorx's order.
      const onEvent = new Channel<string>();
      onEvent.onmessage = (raw) => {
        // A stopped run's stragglers must not repaint the board. Finished runs
        // still take theirs: Tauri fetches large channel messages on its own,
        // so a big node-end can land after `flow_run` has already resolved.
        if (stoppedRunsRef.current.has(runId)) return;
        let event: RunEvent;
        try {
          event = JSON.parse(raw) as RunEvent;
        } catch {
          return;
        }
        applyEvent(event);
        if (event.type === "start") summary.order = [...event.order, ...event.cycle];
        else if (event.type === "node-end") summary.states[event.id] = event.state;
        else if (event.type === "error") summary.error = event.message;
      };

      // As a background job so the sidebar shows it running from any page.
      const outcome = await runJob(`${runKey}:${runId}`, () =>
        invoke("flow_run", {
          env,
          runId,
          request: JSON.stringify({
            graph: options?.graph ?? graph,
            target: options?.target,
            only: options?.only,
            seed,
            seedPorts,
          }),
          onEvent,
        })
      );
      forgetJob(`${runKey}:${runId}`);
      if (outcome?.ok) {
        if (stoppedRunsRef.current.has(runId)) summary.stopped = true;
      } else if (outcome) {
        summary.error = outcome.error;
        setRunError(summary.error);
      }
      if (abortRef.current === runId) abortRef.current = null;
      setRunning(false);
      setProgress(null);
      return summary;
    },
    [applyEvent, env, graph, runStates, running, abortRef, runKey, setProgress, setRunError, setRunning, stoppedRunsRef]
  );

  const stop = useCallback(() => {
    const runId = abortRef.current;
    abortRef.current = null;
    if (runId) {
      stoppedRunsRef.current.add(runId);
      void invoke("job_cancel", { id: runId });
    }
    setRunning(false);
    setProgress(null);
    // Events from a stopped run are ignored, so the node that was
    // mid-flight never gets its `node-end` and would sit at "running…" for the
    // rest of the session. It is settled here instead.
    setRunStates((prev) => {
      const next = { ...prev };
      let stopped = false;
      for (const [id, state] of Object.entries(prev)) {
        if (state.status !== "running") continue;
        next[id] = { ...state, status: "error", error: "Stopped" };
        stopped = true;
      }
      return stopped ? next : prev;
    });
  }, [abortRef, setProgress, setRunStates, setRunning, stoppedRunsRef]);

  const runSelection = useCallback(
    (includeAncestors: boolean) => {
      if (!selectedNodeIds.length) return;
      void run(includeAncestors ? { target: selectedNodeIds } : { only: selectedNodeIds });
    },
    [run, selectedNodeIds]
  );

  const clearRun = useCallback(() => {
    setRunStates({});
    setRunOrder([]);
    setRunMs(null);
    setRunError("");
    setLogNodeId(null);
  }, [setRunError, setRunMs, setRunOrder, setRunStates]);

  /* -------------------------------------------------------------- keyboard -- */

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.code === "Space") {
        e.preventDefault();
        setPanMode(true);
        return;
      }
      if (openNodeId) return;
      if (e.key === "Tab") {
        e.preventDefault();
        setPalette({ open: true });
        return;
      }
      if (e.shiftKey && e.altKey && e.key.toLowerCase() === "t") {
        e.preventDefault();
        tidy();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") {
        e.preventDefault();
        setSelected(
          graph.nodes.length ? { kind: "node", ids: graph.nodes.map((n) => n.id) } : null
        );
        return;
      }
      if (e.key === "Escape") {
        setSelected(null);
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
        if (!selectedNodeIds.length) return;
        e.preventDefault();
        runSelection(e.shiftKey);
        return;
      }
      if (e.key === "Enter" && selectedNodeIds.length === 1) {
        e.preventDefault();
        setOpenNodeId(selectedNodeIds[0]);
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") {
        e.preventDefault();
        redo();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "c") {
        e.preventDefault();
        copySelection();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "v") {
        e.preventDefault();
        pasteSelection();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "d") {
        if (!selectedNodeIds.length) return;
        e.preventDefault();
        duplicateNodes(selectedNodeIds);
        return;
      }
      if (e.key !== "Delete" && e.key !== "Backspace") return;
      if (!selected) return;
      e.preventDefault();
      if (selected.kind === "node") removeNodes(selected.ids);
      else removeEdge(selected.id);
    },
    [
      copySelection,
      duplicateNodes,
      graph.nodes,
      openNodeId,
      pasteSelection,
      redo,
      removeEdge,
      removeNodes,
      runSelection,
      selected,
      selectedNodeIds,
      tidy,
      undo,
    ]
  );

  const onKeyUp = useCallback((e: React.KeyboardEvent) => {
    if (e.code === "Space") setPanMode(false);
  }, []);

  /* --------------------------------------------------------------- render -- */

  const dotSize = 22 * camera.z;
  const runningId = progress?.currentId;
  const pct = progress?.total ? Math.round((progress.done / progress.total) * 100) : 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Toolbar */}
      <div className="relative flex shrink-0 flex-wrap items-center gap-2 border-b px-3 py-2">
        <Button
          variant="ghost"
          size="icon"
          nativeButton={false}
          render={<Link href="/twx-flow" />}
          aria-label="Back"
        >
          <IconArrowLeft />
        </Button>
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => renameFlow(flowId, name)}
          className="h-7 w-52 text-xs font-medium"
        />
        <NativeSelect
          className="h-7 w-36"
          value={env}
          onChange={(e) => {
            dirty.current = true;
            setEnv(e.target.value);
          }}
        >
          {envs.length === 0 && <option value="">No environments</option>}
          {envs.map((e) => (
            <option key={e.environment} value={e.environment}>
              {e.environment}
              {e.hasAppKey ? "" : " (no key)"}
            </option>
          ))}
        </NativeSelect>

        <div className="flex items-center gap-0.5 border-l pl-2">
          <Button
            variant="ghost"
            size="icon-sm"
            disabled={!canUndo}
            onClick={undo}
            aria-label="Undo"
            title="Undo (Ctrl+Z)"
          >
            <IconArrowBackUp className="size-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            disabled={!canRedo}
            onClick={redo}
            aria-label="Redo"
            title="Redo (Ctrl+Y)"
          >
            <IconArrowForwardUp className="size-4" />
          </Button>
        </div>

        <Button size="sm" variant="outline" onClick={() => setPalette({ open: true })}>
          <IconPlus />
          Add node
          <kbd className="ml-1 rounded border px-1 text-[9px] text-muted-foreground">Tab</kbd>
        </Button>

        {running ? (
          <Button size="sm" variant="destructive" onClick={stop}>
            <IconPlayerStop />
            Stop
          </Button>
        ) : (
          <Button size="sm" onClick={() => run()} disabled={graph.nodes.length === 0}>
            <IconPlayerPlay />
            Run flow
          </Button>
        )}

        {!running && selectedNodeIds.length > 0 && (
          <Button
            size="sm"
            variant="outline"
            onClick={(e) => runSelection(e.shiftKey)}
            title="Run only the selected nodes, reusing results already on the board. Shift-click (or Ctrl+Shift+Enter) to run their upstream nodes too."
          >
            <IconPlayerPlay />
            Run selected ({selectedNodeIds.length})
            <kbd className="ml-1 rounded border px-1 text-[9px] text-muted-foreground">
              Ctrl+↵
            </kbd>
          </Button>
        )}

        {!running && selectedNodeIds.length > 1 && (
          <div className="flex items-center gap-1 rounded-md border bg-muted/40 p-0.5">
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={alignLeft}
              aria-label="Align Left"
              title="Align Left"
            >
              <IconLayoutAlignLeft className="size-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={alignTop}
              aria-label="Align Top"
              title="Align Top"
            >
              <IconLayoutAlignTop className="size-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="xs"
              onClick={distributeHorizontally}
              className="text-[10px] px-1.5 h-6"
              title="Distribute Horizontally"
            >
              Distribute X
            </Button>
            <Button
              variant="ghost"
              size="xs"
              onClick={distributeVertically}
              className="text-[10px] px-1.5 h-6"
              title="Distribute Vertically"
            >
              Distribute Y
            </Button>
          </div>
        )}

        <div className="flex items-center gap-1 border-l pl-2">
          {selectedNodeIds.length > 0 && (
            <Button
              size="sm"
              variant="outline"
              onClick={pinSelection}
              title="Add the selected nodes (config, inputs, wires) to the assistant chat"
            >
              <IconMessagePlus />
              Add selection to chat ({selectedNodeIds.length})
            </Button>
          )}
          <Button
            size="sm"
            variant="outline"
            draggable
            onDragStart={(e) => setDragPins(e, [flowPin()])}
            onClick={() => addPins([flowPin()])}
            title="Add the whole flow definition to the assistant chat (or drag it onto the assistant)"
          >
            <IconMessagePlus />
            Add flow to chat
          </Button>
          {!running && (Object.keys(runStates).length > 0 || runError) && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                const sel = selectedNodeIds.length === 1 ? resultPin(selectedNodeIds[0]) : null;
                const p = sel ?? resultPin();
                if (p) addPins([p]);
              }}
              title="Add the last run to the assistant chat: the selected node's result, or every node's result and logs"
            >
              <IconMessagePlus />
              Add run to chat
            </Button>
          )}
        </div>

        {progress && (
          <div className="flex min-w-40 items-center gap-2">
            <Spinner className="size-3.5" />
            <div className="h-1 w-24 overflow-hidden rounded-full bg-muted">
              <div
                className="h-full bg-primary transition-[width] duration-200"
                style={{ width: `${pct}%` }}
              />
            </div>
            <span className="text-[11px] tabular-nums text-muted-foreground">
              {progress.done}/{progress.total}
              {runningId && nodesById.get(runningId)
                ? ` · ${nodesById.get(runningId)!.label}`
                : ""}
            </span>
          </div>
        )}

        <div className="ml-auto flex items-center gap-1">
          <span className="mr-2 text-[11px] text-muted-foreground">
            {saveState === "saving"
              ? "Saving…"
              : saveState === "error"
                ? "Save failed"
                : saveState === "saved"
                  ? "Saved"
                  : ""}
          </span>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => void resolveSchemas(graph.nodes)}
            aria-label="Refresh output schemas"
            title="Refresh output schemas"
          >
            <IconRefresh />
          </Button>
        </div>

        {progress && (
          <div
            className="absolute inset-x-0 bottom-0 h-0.5 bg-primary transition-[width] duration-200"
            style={{ width: `${pct}%` }}
          />
        )}
      </div>

      {runError && (
        <div
          role="alert"
          className="flex shrink-0 items-start gap-2 border-b border-destructive/40 bg-destructive/10 px-3 py-2"
        >
          <IconAlertTriangle className="mt-px size-4 shrink-0 text-destructive" />
          <p className="min-w-0 flex-1 text-xs break-words whitespace-pre-wrap text-destructive">
            {runError}
          </p>
          <CopyButton text={runError} className="text-destructive" />
          <Button
            size="xs"
            variant="ghost"
            className="shrink-0 text-destructive hover:text-destructive"
            onClick={() => setRunError("")}
          >
            Dismiss
          </Button>
        </div>
      )}

      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          {/* Canvas */}
          <div
            ref={canvasRef}
            tabIndex={0}
            onPointerDown={onCanvasPointerDown}
            onPointerMove={onCanvasPointerMove}
            onPointerUp={onCanvasPointerUp}
            onPointerCancel={endInteraction}
            onKeyDown={onKeyDown}
            onKeyUp={onKeyUp}
            onBlur={() => setPanMode(false)}
            className={cn(
              "relative min-h-0 min-w-0 flex-1 touch-none overflow-hidden outline-none select-none",
              panMode && "cursor-grab"
            )}
            style={{
              backgroundImage:
                "radial-gradient(circle, color-mix(in oklab, var(--color-muted-foreground) 30%, transparent) 1px, transparent 1px)",
              backgroundSize: `${dotSize}px ${dotSize}px`,
              backgroundPosition: `${camera.x}px ${camera.y}px`,
            }}
          >
            <div
              className="absolute top-0 left-0"
              style={{
                transform: `translate(${camera.x}px, ${camera.y}px) scale(${camera.z})`,
                transformOrigin: "0 0",
              }}
            >
              {/* Wires */}
              <svg className="pointer-events-none absolute top-0 left-0 overflow-visible" width={1} height={1}>
                {graph.edges.map((edge) => {
                  const route = routes.get(edge.id);
                  if (!route) return null;
                  const isSelected = selected?.kind === "edge" && selected.id === edge.id;
                  const sourceState = runStates[edge.source];
                  const port = portOf(edge, nodesById.get(edge.source));
                  const live = !port || !sourceState?.branch || sourceState.branch === port;
                  const active =
                    live && sourceState?.status === "ok" && runStates[edge.target]?.status === "running";
                  const carried = live && sourceState?.status === "ok";
                  const dropped = !!port && !!sourceState?.branch && !live;
                  return (
                    <g key={edge.id}>
                      <path
                        d={route.d}
                        fill="none"
                        stroke="transparent"
                        strokeWidth={16}
                        style={{ pointerEvents: "stroke" }}
                        className="cursor-pointer"
                        onPointerDown={(e) => {
                          e.stopPropagation();
                          setSelected({ kind: "edge", id: edge.id });
                        }}
                        onPointerEnter={() => setHoverEdge(edge.id)}
                        onPointerLeave={() => setHoverEdge((h) => (h === edge.id ? null : h))}
                      />
                      <path
                        d={route.d}
                        fill="none"
                        strokeWidth={isSelected ? 3 : 2}
                        strokeDasharray={active ? "6 6" : dropped ? "2 5" : undefined}
                        className={cn(
                          active && "animate-[twx-dash_0.6s_linear_infinite] stroke-primary",
                          !active && isSelected && "stroke-primary",
                          !active && !isSelected && carried && "stroke-success/70",
                          !active && !isSelected && !carried && dropped && "stroke-muted-foreground/25",
                          !active && !isSelected && !carried && !dropped && "stroke-muted-foreground/50"
                        )}
                        markerEnd="url(#twx-arrow)"
                      />
                    </g>
                  );
                })}

                {connecting &&
                  (() => {
                    const from = nodesById.get(connecting.source);
                    if (!from) return null;
                    return (
                      <path
                        d={wirePath(outputPortPoint(from, connecting.port), {
                          x: connecting.x,
                          y: connecting.y,
                        })}
                        fill="none"
                        strokeWidth={2}
                        strokeDasharray="4 4"
                        className="stroke-primary"
                      />
                    );
                  })()}

                <defs>
                  <marker
                    id="twx-arrow"
                    viewBox="0 0 10 10"
                    refX="9"
                    refY="5"
                    markerWidth="5"
                    markerHeight="5"
                    orient="auto-start-reverse"
                  >
                    <path d="M 0 0 L 10 5 L 0 10 z" className="fill-muted-foreground/50" />
                  </marker>
                </defs>

                {/* Wire data badges for executed wires */}
                {graph.edges.map((edge) => {
                  const route = routes.get(edge.id);
                  if (!route) return null;
                  const sourceNode = nodesById.get(edge.source);
                  const targetNode = nodesById.get(edge.target);
                  const sourceState = runStates[edge.source];
                  if (!sourceNode || !targetNode || sourceState?.result === undefined) return null;
                  return (
                    <WireBadge
                      key={`badge-${edge.id}`}
                      mid={route.mid}
                      sourceLabel={sourceNode.label}
                      targetLabel={targetNode.label}
                      data={sourceState.result}
                    />
                  );
                })}
              </svg>

              {/* Wire controls */}
              {graph.edges.map((edge) => {
                const route = routes.get(edge.id);
                if (!route) return null;
                const visible = hoverEdge === edge.id || (selected?.kind === "edge" && selected.id === edge.id);
                if (!visible) return null;
                const point = route.mid;
                return (
                  <button
                    key={`ctl-${edge.id}`}
                    type="button"
                    aria-label="Delete connection"
                    title="Delete connection"
                    className="absolute flex size-5 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border bg-background text-muted-foreground shadow-sm hover:border-destructive hover:text-destructive"
                    style={{ left: point.x, top: point.y }}
                    onPointerDown={(e) => e.stopPropagation()}
                    onPointerEnter={() => setHoverEdge(edge.id)}
                    onPointerLeave={() => setHoverEdge((h) => (h === edge.id ? null : h))}
                    onClick={() => removeEdge(edge.id)}
                  >
                    <IconTrash className="size-3" />
                  </button>
                );
              })}

              {/* Rubber band */}
              {marquee && (
                <div
                  className="pointer-events-none absolute rounded-sm border border-primary bg-primary/10"
                  style={{
                    left: Math.min(marquee.x0, marquee.x1),
                    top: Math.min(marquee.y0, marquee.y1),
                    width: Math.abs(marquee.x1 - marquee.x0),
                    height: Math.abs(marquee.y1 - marquee.y0),
                  }}
                />
              )}

              {/* Nodes */}
              {graph.nodes.map((node) => (
                <NodeCard
                  key={node.id}
                  node={node}
                  state={runStates[node.id]}
                  selected={selectedNodes.has(node.id)}
                  isBreakpoint={breakpoints.has(node.id)}
                  onToggleBreakpoint={() => toggleBreakpoint(node.id)}
                  onRunSingle={() => run({ only: node.id })}
                  onSelect={(additive) =>
                    setSelected((s) => {
                      const ids = s?.kind === "node" ? s.ids : [];
                      if (additive) {
                        const next = ids.includes(node.id)
                          ? ids.filter((id) => id !== node.id)
                          : [...ids, node.id];
                        return next.length ? { kind: "node", ids: next } : null;
                      }
                      return ids.includes(node.id)
                        ? { kind: "node", ids }
                        : { kind: "node", ids: [node.id] };
                    })
                  }
                  onOpen={() => setOpenNodeId(node.id)}
                  onDelete={() => removeNode(node.id)}
                  onDragStart={(e) => {
                    const world = toWorld(e.clientX, e.clientY);
                    const ids = selectedNodes.has(node.id) ? [...selectedNodes] : [node.id];
                    const starts: Record<string, { x: number; y: number }> = {};
                    for (const id of ids) {
                      const n = nodesById.get(id);
                      if (n) starts[id] = { x: n.x, y: n.y };
                    }
                    interaction.current = {
                      kind: "drag-node",
                      originX: world.x,
                      originY: world.y,
                      starts,
                    };
                  }}
                  onStartConnect={(e, port) => {
                    const world = toWorld(e.clientX, e.clientY);
                    setConnecting({ source: node.id, port, x: world.x, y: world.y });
                  }}
                  onQuickAdd={(port) =>
                    setPalette({ open: true, connectFrom: node.id, connectPort: port })
                  }
                />
              ))}
            </div>

            {graph.nodes.length === 0 && (
              <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 text-muted-foreground">
                <p className="text-sm">Empty canvas.</p>
                <p className="text-xs">
                  Press <kbd className="rounded border px-1">Tab</kbd> or “Add node” to drop your first
                  ThingWorx service.
                </p>
              </div>
            )}

            {/* Canvas controls, bottom-left like n8n */}
            <div
              data-canvas-ui
              className="absolute bottom-3 left-3 flex items-center gap-0.5 rounded-lg border bg-background/95 p-1 shadow-sm"
            >
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => zoomBy(1 / 1.2)}
                aria-label="Zoom out"
                title="Zoom out"
              >
                <IconZoomOut />
              </Button>
              <button
                type="button"
                onClick={resetZoom}
                title="Reset zoom to 100%"
                className="w-11 rounded px-1 text-center text-[11px] tabular-nums text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/30 focus-visible:outline-none"
              >
                {Math.round(camera.z * 100)}%
              </button>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => zoomBy(1.2)}
                aria-label="Zoom in"
                title="Zoom in"
              >
                <IconZoomIn />
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={resetZoom}
                aria-label="Reset zoom"
                title="Reset zoom"
              >
                <IconZoomReset />
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={fitToNodes}
                aria-label="Fit to view"
                title="Fit to view"
              >
                <IconFocusCentered />
              </Button>
              <span className="mx-0.5 h-4 w-px bg-border" />
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={tidy}
                aria-label="Tidy up"
                title="Tidy up (Shift+Alt+T)"
              >
                <IconBrush />
              </Button>
            </div>

            {/* Interactive Minimap */}
            <Minimap
              graph={graph}
              camera={camera}
              canvasRect={canvasRect}
              onPanTo={panTo}
            />

            {/* Legend */}
            <div className="pointer-events-none absolute right-4 bottom-3 flex items-center gap-3 rounded-md border bg-background/95 px-2 py-1 text-[10px] text-muted-foreground">
              <span>Drag to select · Space/middle-drag to pan</span>
              <Badge variant="outline" className="text-[9px]">
                {graph.nodes.length} nodes · {graph.edges.length} wires
                {selectedNodeIds.length > 1 ? ` · ${selectedNodeIds.length} selected` : ""}
              </Badge>
            </div>
          </div>

          {/* Execution drawer */}
          <LogPanel
            graph={graph}
            runStates={runStates}
            runOrder={runOrder}
            runMs={runMs}
            running={running}
            open={logOpen}
            selectedId={logNodeId}
            onOpenChange={setLogOpen}
            onSelect={(id) => {
              setLogNodeId(id);
              setSelected({ kind: "node", ids: [id] });
            }}
            onOpenNode={setOpenNodeId}
            onClear={clearRun}
          />
      </div>

      {openNode && (
        <NodePanel
          key={openNode.id}
          node={openNode}
          env={env}
          graph={graph}
          runStates={runStates}
          running={running}
          onChange={patchNode}
          onRename={renameNode}
          onMakePrimary={makePrimary}
          onRunNode={(id, mode) => run(mode === "step" ? { only: id } : { target: id })}
          onRefreshSchema={(id) => {
            const node = nodesById.get(id);
            if (node) void resolveSchemas([node]);
          }}
          onDelete={removeNode}
          onClose={() => setOpenNodeId(null)}
        />
      )}

      <NodePalette
        open={palette.open}
        env={env}
        connectFrom={
          palette.connectFrom
            ? [
                nodesById.get(palette.connectFrom)?.label,
                palette.connectPort ? `(${palette.connectPort})` : "",
              ]
                .filter(Boolean)
                .join(" ")
            : undefined
        }
        onOpenChange={(open) => setPalette(open ? { ...palette, open } : { open: false })}
        onPick={addNode}
      />
    </div>
  );
}
