"use client";

import { useMemo } from "react";
import {
  IconAlertTriangle,
  IconArrowDownRight,
  IconArrowUpRight,
  IconBolt,
  IconBox,
  IconCash,
  IconChartBar,
  IconCheck,
  IconClock,
  IconDatabase,
  IconGitBranch,
  IconMinus,
  IconServer,
  IconUsers,
  type Icon,
} from "@tabler/icons-react";
import { cn } from "@/lib/utils";
import { isRecord, parseJson, Placeholder, SourceToggle } from "./shared";

type Tone = "default" | "good" | "bad" | "warn" | "info";
type Dir = "up" | "down" | "flat";

interface Item {
  label: string;
  value: string | number;
  unit?: string;
  delta?: string | number;
  trend?: Dir;
  good: "up" | "down";
  hint?: string;
  tone: Tone;
  progress?: number;
  spark?: number[];
  icon?: string;
}

const ICONS: Record<string, Icon> = {
  users: IconUsers,
  clock: IconClock,
  alert: IconAlertTriangle,
  check: IconCheck,
  bolt: IconBolt,
  database: IconDatabase,
  server: IconServer,
  chart: IconChartBar,
  cash: IconCash,
  box: IconBox,
  git: IconGitBranch,
};

const TONES: Record<Tone, string> = {
  default: "",
  good: "border-success/40 bg-success/5",
  bad: "border-destructive/40 bg-destructive/5",
  warn: "border-warning/40 bg-warning/5",
  info: "border-info/40 bg-info/5",
};

const str = (v: unknown) => (typeof v === "string" ? v : undefined);
const strNum = (v: unknown) =>
  typeof v === "string" || typeof v === "number" ? v : undefined;

function toItem(r: unknown): Item | null {
  if (!isRecord(r)) return null;
  const value = strNum(r.value);
  if (value === undefined || str(r.label) === undefined) return null;
  const delta = strNum(r.delta);
  let trend = ["up", "down", "flat"].includes(r.trend as string)
    ? (r.trend as Dir)
    : undefined;
  if (!trend && delta !== undefined) {
    const s = String(delta).trim();
    const n = parseFloat(s.replace(/^\+/, ""));
    trend = s.startsWith("-") || n < 0 ? "down" : n > 0 ? "up" : "flat";
  }
  const tone = (r.tone as Tone) in TONES ? (r.tone as Tone) : "default";
  return {
    label: r.label as string,
    value,
    unit: str(r.unit),
    delta,
    trend,
    good: r.good === "down" ? "down" : "up",
    hint: str(r.hint),
    tone,
    progress:
      typeof r.progress === "number"
        ? Math.min(100, Math.max(0, r.progress))
        : undefined,
    spark: Array.isArray(r.spark)
      ? r.spark.filter((n): n is number => typeof n === "number")
      : undefined,
    icon: str(r.icon),
  };
}

function Spark({ data }: { data: number[] }) {
  if (data.length < 2) return null;
  const min = Math.min(...data);
  const span = Math.max(...data) - min || 1;
  const pts = data
    .map((v, i) => `${(i / (data.length - 1)) * 100},${22 - ((v - min) / span) * 20}`)
    .join(" ");
  return (
    <svg viewBox="0 0 100 24" preserveAspectRatio="none" className="mt-1.5 h-6 w-full text-primary">
      <polyline points={pts} fill="none" stroke="currentColor" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function Tile({ it }: { it: Item }) {
  const Ico = it.icon ? ICONS[it.icon] : undefined;
  const TrendIcon =
    it.trend === "up" ? IconArrowUpRight : it.trend === "down" ? IconArrowDownRight : IconMinus;
  const deltaColor =
    !it.trend || it.trend === "flat"
      ? "text-muted-foreground"
      : it.trend === it.good
        ? "text-success"
        : "text-destructive";
  return (
    <div className={cn("min-w-0 rounded-md border bg-background/50 p-2.5", TONES[it.tone])}>
      <div className="flex items-center gap-1 text-[11px] text-muted-foreground">
        {Ico && <Ico className="size-3 shrink-0" />}
        <span className="truncate">{it.label}</span>
      </div>
      <div className="mt-0.5 flex flex-wrap items-baseline gap-x-1.5">
        <span className="text-lg font-semibold tabular-nums">
          {it.value}
          {it.unit && <span className="ml-0.5 text-xs font-normal text-muted-foreground">{it.unit}</span>}
        </span>
        {it.delta !== undefined && (
          <span className={cn("inline-flex items-center text-[11px] font-medium tabular-nums", deltaColor)}>
            <TrendIcon className="size-3" />
            {it.delta}
          </span>
        )}
      </div>
      {it.progress !== undefined && (
        <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-muted">
          <div className="h-full rounded-full bg-primary" style={{ width: `${it.progress}%` }} />
        </div>
      )}
      {it.spark && <Spark data={it.spark} />}
      {it.hint && <div className="mt-1 text-[10px] text-muted-foreground">{it.hint}</div>}
    </div>
  );
}

export function TilesBlock({ source }: { source: string }) {
  const parsed = useMemo(() => {
    const p = parseJson(source);
    if (!p.ok) return p;
    const raw = p.value;
    const list = Array.isArray(raw) ? raw : isRecord(raw) ? raw.items : undefined;
    if (!Array.isArray(list) || !list.length)
      return { ok: false, message: "expected an array of items", complete: true } as const;
    const items = list.map(toItem).filter((i): i is Item => i !== null);
    if (!items.length)
      return { ok: false, message: "items need a label and value", complete: true } as const;
    const c = isRecord(raw) && typeof raw.columns === "number" ? Math.round(raw.columns) : 0;
    return { ok: true, value: { items, columns: c >= 1 && c <= 6 ? c : 0 } } as const;
  }, [source]);

  if (!parsed.ok)
    return <Placeholder kind="Tiles" message={parsed.message} complete={parsed.complete} source={source} />;

  const { items, columns } = parsed.value;
  return (
    <div className="my-2 rounded-md border bg-card p-2.5 text-xs">
      <SourceToggle source={source}>
        <div
          className="grid gap-2"
          style={{
            gridTemplateColumns: columns
              ? `repeat(${columns}, minmax(0, 1fr))`
              : "repeat(auto-fit, minmax(140px, 1fr))",
          }}
        >
          {items.map((it, i) => (
            <Tile key={i} it={it} />
          ))}
        </div>
      </SourceToggle>
    </div>
  );
}
