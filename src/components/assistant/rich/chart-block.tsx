"use client";

import { useMemo } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  PolarAngleAxis,
  PolarGrid,
  Radar,
  RadarChart,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  Treemap,
  XAxis,
  YAxis,
} from "recharts";
import {
  compact,
  isRecord,
  parseJson,
  Placeholder,
  SourceToggle,
} from "./shared";

const TYPES = [
  "bar",
  "line",
  "area",
  "pie",
  "donut",
  "scatter",
  "radar",
  "waterfall",
  "treemap",
] as const;
type ChartType = (typeof TYPES)[number];
type Row = Record<string, string | number>;

interface Spec {
  type: ChartType;
  title?: string;
  description?: string;
  data: Row[];
  tree?: TreeNode[];
  x: string;
  ys: string[];
  stacked: boolean;
  horizontal: boolean;
  unit: string;
  height: number;
}

const COLORS = [
  "#3b82f6",
  "#f59e0b",
  "#10b981",
  "#ef4444",
  "#8b5cf6",
  "#06b6d4",
  "#ec4899",
  "#84cc16",
];

type TreeNode = {
  [key: string]: unknown;
  name: string;
  value?: number;
  fill?: string;
  children?: TreeNode[];
};

function toNode(r: unknown, nk: string, vk: string): TreeNode | null {
  if (!isRecord(r)) return null;
  const name = String(r[nk] ?? "");
  const kids = Array.isArray(r.children)
    ? r.children.map((c) => toNode(c, nk, vk)).filter((n): n is TreeNode => n !== null)
    : [];
  if (kids.length) return { name, children: kids };
  const value = Number(r[vk]);
  return name && value > 0 ? { name, value } : null;
}

function paint(n: TreeNode, fill: string): TreeNode {
  return { ...n, fill, children: n.children?.map((c) => paint(c, fill)) };
}

function buildSpec(raw: unknown): Spec | string {
  if (!isRecord(raw)) return "spec must be a JSON object";
  const type = raw.type as ChartType;
  if (!TYPES.includes(type)) return `unknown chart type "${String(raw.type)}"`;
  if (!Array.isArray(raw.data) || !raw.data.length || !raw.data.every(isRecord))
    return "data must be a non-empty array of objects";
  const data = raw.data as Row[];
  if (type === "treemap") {
    const nk = typeof raw.x === "string" ? raw.x : "name";
    const vk = (Array.isArray(raw.y) ? raw.y[0] : raw.y) ?? "value";
    if (typeof vk !== "string") return "y must be a value key";
    const nodes = data.map((r) => toNode(r, nk, vk)).filter((n): n is TreeNode => n !== null);
    if (!nodes.length) return "treemap needs rows with a name and a positive value";
    return {
      type,
      title: typeof raw.title === "string" ? raw.title : undefined,
      description: typeof raw.description === "string" ? raw.description : undefined,
      data: [],
      tree: nodes.map((n, i) => paint(n, COLORS[i % 8])),
      x: nk,
      ys: [vk],
      stacked: false,
      horizontal: false,
      unit: typeof raw.unit === "string" ? raw.unit : "",
      height: Math.min(600, Math.max(120, typeof raw.height === "number" ? raw.height : 240)),
    };
  }
  const keys = Object.keys(data[0]);
  const isNum = (k: string) => data.every((r) => typeof r[k] === "number");
  const x =
    typeof raw.x === "string"
      ? raw.x
      : type === "scatter"
        ? (keys.find(isNum) ?? keys[0])
        : (keys.find((k) => typeof data[0][k] === "string") ?? keys[0]);
  let ys = (
    Array.isArray(raw.y) ? raw.y : typeof raw.y === "string" ? [raw.y] : []
  ).filter((k): k is string => typeof k === "string");
  if (!ys.length) ys = keys.filter((k) => k !== x && isNum(k));
  if (type === "pie" || type === "donut" || type === "waterfall") ys = ys.slice(0, 1);
  if (!ys.length) return "no numeric series found";
  const h = typeof raw.height === "number" ? raw.height : 240;
  return {
    type,
    title: typeof raw.title === "string" ? raw.title : undefined,
    description:
      typeof raw.description === "string" ? raw.description : undefined,
    data,
    x,
    ys,
    stacked: raw.stacked === true,
    horizontal: raw.horizontal === true,
    unit: typeof raw.unit === "string" ? raw.unit : "",
    height: Math.min(600, Math.max(120, h)),
  };
}

const tick = { fontSize: 10, fill: "var(--muted-foreground)" };
const tooltipStyle = {
  contentStyle: {
    background: "var(--popover)",
    color: "var(--foreground)",
    border: "1px solid var(--border)",
    borderRadius: 6,
    fontSize: 11,
    padding: "4px 8px",
  },
  itemStyle: { color: "var(--foreground)", padding: 0 },
  labelStyle: { color: "var(--muted-foreground)", marginBottom: 2 },
};

function waterfallRows(data: Row[], x: string, y: string) {
  return data.reduce<
    { label: string; range: [number, number]; delta: number; total: number; kind: string }[]
  >((acc, r) => {
    const label = String(r[x]);
    const raw: unknown = r;
    const isTotal =
      (isRecord(raw) && raw.total === true) || /^(total|sum|net)$/i.test(label.trim());
    const prev = acc.length ? acc[acc.length - 1].total : 0;
    const delta = isTotal ? prev : Number(r[y]) || 0;
    const total = isTotal ? prev : prev + delta;
    // A total bar stands on the axis; a delta floats from the previous total.
    const from = isTotal ? 0 : prev;
    acc.push({
      label,
      range: [Math.min(from, total), Math.max(from, total)],
      delta,
      total,
      kind: isTotal ? "total" : delta < 0 ? "down" : "up",
    });
    return acc;
  }, []);
}

function TreeCell(p: {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  name?: string;
  value?: number;
  fill?: string;
  depth?: number;
  fmt: (v: unknown) => string;
}) {
  const { x = 0, y = 0, width = 0, height = 0, name, value, fill, depth = 0 } = p;
  if (depth === 0) return <g />;
  const room = width > 46 && height > 26;
  return (
    <g>
      <rect
        x={x}
        y={y}
        width={width}
        height={height}
        fill={fill ?? COLORS[0]}
        fillOpacity={depth > 1 ? 0.75 : 0.9}
        stroke="var(--card)"
        strokeWidth={2}
      />
      {room && (
        <text x={x + 5} y={y + 14} fontSize={11} fill="#fff" style={{ pointerEvents: "none" }}>
          {name}
          <tspan x={x + 5} dy={13} fontSize={10} fillOpacity={0.85}>
            {value !== undefined ? p.fmt(value) : ""}
          </tspan>
        </text>
      )}
    </g>
  );
}

function Plot({ s }: { s: Spec }) {
  const fmt = (v: unknown) => (typeof v === "number" ? compact(v) : String(v)) + s.unit;
  const axisFmt = (v: unknown) => fmt(v);
  const grid = <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" />;
  const tip = <Tooltip formatter={fmt} {...tooltipStyle} />;
  const legend = s.ys.length > 1 && (
    <Legend wrapperStyle={{ fontSize: 11 }} iconSize={8} />
  );
  const stack = s.stacked ? "a" : undefined;
  const margin = { top: 4, right: 8, bottom: 0, left: 0 };
  const xAxis = <XAxis dataKey={s.x} tick={tick} stroke="var(--border)" />;
  const yAxis = (
    <YAxis tick={tick} stroke="var(--border)" tickFormatter={axisFmt} width={44} />
  );

  switch (s.type) {
    case "bar":
      return (
        <BarChart
          data={s.data}
          margin={margin}
          layout={s.horizontal ? "vertical" : "horizontal"}
        >
          {grid}
          {s.horizontal ? (
            <>
              <XAxis type="number" tick={tick} stroke="var(--border)" tickFormatter={axisFmt} />
              <YAxis type="category" dataKey={s.x} tick={tick} stroke="var(--border)" width={72} />
            </>
          ) : (
            <>
              {xAxis}
              {yAxis}
            </>
          )}
          {tip}
          {legend}
          {s.ys.map((k, i) => (
            <Bar key={k} dataKey={k} stackId={stack} fill={COLORS[i % 8]} radius={s.stacked ? 0 : 2} />
          ))}
        </BarChart>
      );
    case "line":
      return (
        <LineChart data={s.data} margin={margin}>
          {grid}
          {xAxis}
          {yAxis}
          {tip}
          {legend}
          {s.ys.map((k, i) => (
            <Line key={k} dataKey={k} stroke={COLORS[i % 8]} strokeWidth={2} dot={s.data.length < 25} type="monotone" />
          ))}
        </LineChart>
      );
    case "area":
      return (
        <AreaChart data={s.data} margin={margin}>
          {grid}
          {xAxis}
          {yAxis}
          {tip}
          {legend}
          {s.ys.map((k, i) => (
            <Area key={k} dataKey={k} stackId={stack} stroke={COLORS[i % 8]} fill={COLORS[i % 8]} fillOpacity={0.25} type="monotone" />
          ))}
        </AreaChart>
      );
    case "scatter":
      return (
        <ScatterChart margin={margin}>
          {grid}
          <XAxis dataKey={s.x} type="number" name={s.x} tick={tick} stroke="var(--border)" tickFormatter={axisFmt} />
          <YAxis type="number" tick={tick} stroke="var(--border)" tickFormatter={axisFmt} width={44} />
          <Tooltip formatter={fmt} cursor={{ strokeDasharray: "3 3" }} {...tooltipStyle} />
          {legend}
          {s.ys.map((k, i) => (
            <Scatter key={k} name={k} data={s.data.map((r) => ({ [s.x]: r[s.x], y: r[k] }))} dataKey="y" fill={COLORS[i % 8]} />
          ))}
        </ScatterChart>
      );
    case "radar":
      return (
        <RadarChart data={s.data} outerRadius="75%">
          <PolarGrid stroke="var(--border)" />
          <PolarAngleAxis dataKey={s.x} tick={tick} />
          {tip}
          {legend}
          {s.ys.map((k, i) => (
            <Radar key={k} dataKey={k} stroke={COLORS[i % 8]} fill={COLORS[i % 8]} fillOpacity={0.25} />
          ))}
        </RadarChart>
      );
    case "waterfall": {
      const y = s.ys[0];
      const rows = waterfallRows(s.data, s.x, y);
      const fills = { up: "#10b981", down: "#ef4444", total: "var(--primary)" };
      return (
        <BarChart data={rows} margin={margin}>
          {grid}
          <XAxis dataKey="label" tick={tick} stroke="var(--border)" />
          {yAxis}
          <Tooltip
            {...tooltipStyle}
            cursor={{ fill: "var(--muted)", opacity: 0.4 }}
            content={({ active, payload }) => {
              const d = active ? payload?.[0]?.payload : undefined;
              if (!d) return null;
              return (
                <div style={tooltipStyle.contentStyle}>
                  <div style={tooltipStyle.labelStyle}>{d.label}</div>
                  {d.kind !== "total" && (
                    <div>
                      Change: {d.delta > 0 ? "+" : ""}
                      {fmt(d.delta)}
                    </div>
                  )}
                  <div>Total: {fmt(d.total)}</div>
                </div>
              );
            }}
          />
          <Bar dataKey="range" radius={2} isAnimationActive={false}>
            {rows.map((r, i) => (
              <Cell key={i} fill={fills[r.kind as keyof typeof fills]} />
            ))}
          </Bar>
        </BarChart>
      );
    }
    case "treemap":
      return (
        <Treemap
          data={s.tree}
          dataKey="value"
          nameKey="name"
          stroke="var(--card)"
          isAnimationActive={false}
          content={<TreeCell fmt={fmt} />}
        >
          <Tooltip
            {...tooltipStyle}
            formatter={(v) => fmt(v)}
          />
        </Treemap>
      );
    default:
      return (
        <PieChart>
          {tip}
          <Legend wrapperStyle={{ fontSize: 11 }} iconSize={8} />
          <Pie
            data={s.data.map((r) => ({ name: String(r[s.x]), value: Number(r[s.ys[0]]) || 0 }))}
            dataKey="value"
            nameKey="name"
            innerRadius={s.type === "donut" ? "55%" : 0}
            outerRadius="80%"
            stroke="var(--card)"
            isAnimationActive={false}
          >
            {s.data.map((_, i) => (
              <Cell key={i} fill={COLORS[i % 8]} />
            ))}
          </Pie>
        </PieChart>
      );
  }
}

export function ChartBlock({ source }: { source: string }) {
  const parsed = useMemo(() => {
    const p = parseJson(source);
    if (!p.ok) return p;
    const spec = buildSpec(p.value);
    return typeof spec === "string"
      ? ({ ok: false, message: spec, complete: true } as const)
      : ({ ok: true, value: spec } as const);
  }, [source]);

  if (!parsed.ok)
    return <Placeholder kind="Chart" message={parsed.message} complete={parsed.complete} source={source} />;

  const s = parsed.value;
  return (
    <div className="my-2 rounded-md border bg-card p-2.5 text-xs text-foreground">
      {(s.title || s.description) && (
        <div className="mb-2">
          {s.title && <div className="text-[13px] font-medium">{s.title}</div>}
          {s.description && (
            <div className="text-[11px] text-muted-foreground">{s.description}</div>
          )}
        </div>
      )}
      <SourceToggle source={source}>
        <div style={{ height: s.height }}>
          <ResponsiveContainer width="100%" height="100%">
            {Plot({ s })}
          </ResponsiveContainer>
        </div>
      </SourceToggle>
    </div>
  );
}
