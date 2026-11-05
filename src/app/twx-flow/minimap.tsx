"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import { IconMap, IconMinus } from "@tabler/icons-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { NODE_W, nodeHeight } from "@/lib/twx-flow/layout";
import type { FlowGraph } from "@/lib/twx-flow/types";

const MAP_WIDTH = 200;
const MAP_HEIGHT = 140;
const PADDING = 120;

const NODE_COLORS: Record<string, string> = {
  service: "#0284c7", // sky-600
  code: "#d97706", // amber-600
  agent: "#c026d3", // fuchsia-600
  if: "#7c3aed", // violet-600
  filter: "#9333ea", // purple-600
  switch: "#6366f1", // indigo-500
  loop: "#059669", // emerald-600
  merge: "#0d9488", // teal-600
  compare: "#ea580c", // orange-600
  subflow: "#2563eb", // blue-600
  stop: "#e11d48", // rose-600
  wait: "#64748b", // slate-500
};

export function Minimap({
  graph,
  camera,
  canvasRect,
  onPanTo,
  className,
}: {
  graph: FlowGraph;
  camera: { x: number; y: number; z: number };
  canvasRect: { width: number; height: number } | null;
  onPanTo: (targetWorldX: number, targetWorldY: number) => void;
  className?: string;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const isDragging = useRef(false);
  const svgRef = useRef<SVGSVGElement>(null);

  // Compute world bounding box
  const bounds = useMemo(() => {
    if (graph.nodes.length === 0) {
      return { minX: -200, minY: -200, maxX: 800, maxY: 600, width: 1000, height: 800 };
    }
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    for (const node of graph.nodes) {
      minX = Math.min(minX, node.x);
      minY = Math.min(minY, node.y);
      maxX = Math.max(maxX, node.x + NODE_W);
      maxY = Math.max(maxY, node.y + nodeHeight(node));
    }

    minX -= PADDING;
    minY -= PADDING;
    maxX += PADDING;
    maxY += PADDING;

    const width = Math.max(maxX - minX, 400);
    const height = Math.max(maxY - minY, 300);

    return { minX, minY, maxX, maxY, width, height };
  }, [graph.nodes]);

  // Viewport in world coords:
  // screen (0,0) -> world (-camera.x / camera.z, -camera.y / camera.z)
  // screen (W,H) -> world ((W - camera.x) / camera.z, (H - camera.y) / camera.z)
  const viewport = useMemo(() => {
    const cw = canvasRect?.width ?? 800;
    const ch = canvasRect?.height ?? 600;
    const vx = -camera.x / camera.z;
    const vy = -camera.y / camera.z;
    const vw = cw / camera.z;
    const vh = ch / camera.z;
    return { x: vx, y: vy, width: vw, height: vh };
  }, [camera, canvasRect]);

  const handleMapPointer = useCallback(
    (e: React.PointerEvent<SVGSVGElement>) => {
      const rect = svgRef.current?.getBoundingClientRect();
      if (!rect) return;
      const fracX = (e.clientX - rect.left) / rect.width;
      const fracY = (e.clientY - rect.top) / rect.height;

      const worldX = bounds.minX + fracX * bounds.width;
      const worldY = bounds.minY + fracY * bounds.height;

      onPanTo(worldX, worldY);
    },
    [bounds, onPanTo]
  );

  return (
    <div
      data-canvas-ui
      onPointerDown={(e) => e.stopPropagation()}
      className={cn(
        "absolute right-4 bottom-4 z-20 flex flex-col overflow-hidden rounded-lg border bg-background/95 shadow-lg backdrop-blur-md transition-all duration-200",
        collapsed ? "h-8 w-8 items-center justify-center p-0" : "p-1.5",
        className
      )}
    >
      <div className={cn("flex items-center justify-between", !collapsed && "px-1 pb-1")}>
        {!collapsed && (
          <div className="flex items-center gap-1 text-[11px] font-semibold text-muted-foreground">
            <IconMap className="size-3.5" />
            <span>Navigator</span>
          </div>
        )}
        <Button
          variant="ghost"
          size="icon"
          className={cn(
            collapsed ? "size-8 rounded-lg" : "size-6",
            "text-muted-foreground hover:text-foreground"
          )}
          onClick={(e) => {
            e.stopPropagation();
            setCollapsed((c) => !c);
          }}
          title={collapsed ? "Expand Minimap" : "Collapse Minimap"}
        >
          {collapsed ? <IconMap className="size-4" /> : <IconMinus className="size-3.5" />}
        </Button>
      </div>

      {!collapsed && (
        <div
          className="relative cursor-pointer overflow-hidden rounded border bg-muted/40"
          style={{ width: MAP_WIDTH, height: MAP_HEIGHT }}
        >
          <svg
            ref={svgRef}
            viewBox={`${bounds.minX} ${bounds.minY} ${bounds.width} ${bounds.height}`}
            className="h-full w-full select-none"
            onPointerDown={(e) => {
              isDragging.current = true;
              e.currentTarget.setPointerCapture(e.pointerId);
              handleMapPointer(e);
            }}
            onPointerMove={(e) => {
              if (isDragging.current) handleMapPointer(e);
            }}
            onPointerUp={(e) => {
              isDragging.current = false;
              e.currentTarget.releasePointerCapture(e.pointerId);
            }}
          >
            {/* Wires */}
            {graph.edges.map((edge) => {
              const src = graph.nodes.find((n) => n.id === edge.source);
              const tgt = graph.nodes.find((n) => n.id === edge.target);
              if (!src || !tgt) return null;
              return (
                <line
                  key={edge.id}
                  x1={src.x + NODE_W}
                  y1={src.y + nodeHeight(src) / 2}
                  x2={tgt.x}
                  y2={tgt.y + nodeHeight(tgt) / 2}
                  stroke="currentColor"
                  strokeOpacity={0.25}
                  strokeWidth={bounds.width / 150}
                />
              );
            })}

            {/* Nodes */}
            {graph.nodes.map((node) => {
              const color = NODE_COLORS[node.kind] ?? "#64748b";
              return (
                <rect
                  key={node.id}
                  x={node.x}
                  y={node.y}
                  width={NODE_W}
                  height={nodeHeight(node)}
                  rx={10}
                  fill={color}
                  fillOpacity={node.disabled ? 0.3 : 0.85}
                  stroke={color}
                  strokeWidth={bounds.width / 200}
                />
              );
            })}

            {/* Viewport Frame */}
            <rect
              x={viewport.x}
              y={viewport.y}
              width={viewport.width}
              height={viewport.height}
              fill="rgba(59, 130, 246, 0.12)"
              stroke="rgb(59, 130, 246)"
              strokeWidth={Math.max(1.5, bounds.width / 120)}
              rx={6}
              className="pointer-events-none transition-all duration-75"
            />
          </svg>
        </div>
      )}
    </div>
  );
}

