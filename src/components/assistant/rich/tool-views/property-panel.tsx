"use client";

import { useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import { isRecord, parseJson, Placeholder, SourceToggle } from "../shared";
import { CellValue, inferType } from "./infotable";
import { absTime, relTime } from "./run-times";
import { DataGrid, type GridColumn } from "@/components/data-grid";

export type PropRow = {
  name: string;
  value: unknown;
  baseType?: string;
  quality?: string;
  time?: string | number;
};

const STALE_MS = 24 * 3600 * 1000;

function toRow(r: Record<string, unknown>): PropRow | null {
  if (typeof r.name !== "string" || !("value" in r)) return null;
  const time = typeof r.time === "string" || typeof r.time === "number" ? r.time : undefined;
  return {
    name: r.name,
    value: r.value,
    baseType: typeof r.baseType === "string" ? r.baseType : undefined,
    quality: typeof r.quality === "string" ? r.quality : undefined,
    time,
  };
}

/** Flat `{ name: value }` objects and name/value(/quality/time) tables. */
export function asProperties(value: unknown): PropRow[] | null {
  try {
    const table = isRecord(value) && Array.isArray(value.rows) ? value.rows : Array.isArray(value) ? value : null;
    if (table) {
      if (!table.length || !table.every(isRecord)) return null;
      const rows = table.map((r) => toRow(r as Record<string, unknown>));
      return rows.every((r): r is PropRow => r !== null) ? rows : null;
    }
    if (isRecord(value)) {
      const entries = Object.entries(value);
      if (!entries.length) return null;
      return entries
        .map(([name, v]) => ({ name, value: v }))
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
    }
    return null;
  } catch {
    return null;
  }
}

/** True when the rows look like VTQ output (carry quality or time). */
export function isVtq(rows: PropRow[]): boolean {
  return rows.some((r) => r.quality !== undefined || r.time !== undefined);
}

function qualityClass(q: string): string {
  const u = q.toUpperCase();
  if (u === "GOOD") return "bg-success/15 text-success";
  if (u === "BAD") return "bg-destructive/15 text-destructive";
  return "bg-warning/15 text-warning";
}

function ValueCell({ value }: { value: unknown }) {
  const [open, setOpen] = useState(false);
  if (typeof value === "string" && value.length > 80) {
    return (
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-label={open ? "Collapse value" : "Expand value"}
        className={cn("block max-w-full text-left", open ? "break-all whitespace-pre-wrap" : "truncate")}
        title={open ? undefined : "Click to expand"}
      >
        {open ? value : value.slice(0, 80) + "…"}
      </button>
    );
  }
  return (
    <div className="truncate">
      <CellValue value={value} />
    </div>
  );
}

export function PropertyPanel({ value }: { value: unknown }) {
  const rows = useMemo(() => (Array.isArray(value) && value.every(isPropRow) ? (value as PropRow[]) : asProperties(value)), [value]);
  const [now] = useState(() => Date.now());

  const columns = useMemo<GridColumn<PropRow>[]>(
    () => [
      { key: "name", label: "Name", kind: "text", width: 220, render: (r) => <span className="font-mono">{r.name}</span> },
      {
        key: "value",
        label: "Value",
        kind: "text",
        width: 320,
        value: (r) => r.value,
        render: (r) => <ValueCell value={r.value} />,
        truncate: false,
      },
      {
        key: "type",
        label: "Type",
        kind: "text",
        width: 100,
        value: (r) => r.baseType ?? inferType(r.value),
        render: (r) => (
          <span className="text-[10px] text-muted-foreground uppercase">{r.baseType ?? inferType(r.value)}</span>
        ),
      },
      {
        key: "quality",
        label: "Quality",
        kind: "text",
        width: 90,
        hidden: !rows?.some((r) => r.quality),
        render: (r) =>
          r.quality ? (
            <span className={cn("rounded px-1 text-[9.5px] leading-4", qualityClass(r.quality))}>{r.quality}</span>
          ) : null,
      },
      {
        key: "time",
        label: "Time",
        kind: "date",
        width: 110,
        hidden: !rows?.some((r) => r.time !== undefined),
        render: (r) => {
          const ms = r.time === undefined ? NaN : typeof r.time === "number" ? r.time : Date.parse(r.time);
          const stale = !Number.isNaN(ms) && now - ms > STALE_MS;
          return (
            <span
              className={cn("whitespace-nowrap", stale ? "text-warning" : "text-muted-foreground")}
              title={r.time !== undefined ? `${absTime(r.time)}${stale ? " (stale: older than 24h)" : ""}` : undefined}
            >
              {relTime(r.time)}
            </span>
          );
        },
      },
    ],
    [rows, now]
  );

  if (!rows) return null;
  return (
    <DataGrid
      id="property-panel"
      columns={columns}
      rows={rows}
      rowKey={(r, i) => `${r.name}|${i}`}
      searchable={rows.length > 8}
      pageSize={50}
      maxHeight={352}
      csvName="properties"
      rowClassName={(r) => (r.quality?.toUpperCase() === "BAD" ? "bg-destructive/5" : undefined)}
    />
  );
}

function isPropRow(v: unknown): v is PropRow {
  return isRecord(v) && typeof v.name === "string" && "value" in v;
}

/** ```props fenced block: JSON array of PropRow, or { items: PropRow[] }. Never throws. */
export function PropsBlock({ source }: { source: string }) {
  const parsed = useMemo(() => {
    const p = parseJson(source);
    if (!p.ok) return p;
    const raw = p.value;
    const list = Array.isArray(raw) ? raw : isRecord(raw) ? raw.items : undefined;
    if (!Array.isArray(list) || !list.length)
      return { ok: false, message: "expected an array of properties", complete: true } as const;
    const rows = list.map((r) => (isRecord(r) ? toRow(r) : null)).filter((r): r is PropRow => r !== null);
    if (!rows.length) return { ok: false, message: "items need a name and value", complete: true } as const;
    return { ok: true, value: rows } as const;
  }, [source]);

  if (!parsed.ok)
    return <Placeholder kind="Props" message={parsed.message} complete={parsed.complete} source={source} />;
  return (
    <div className="my-2">
      <SourceToggle source={source}>
        <PropertyPanel value={parsed.value} />
      </SourceToggle>
    </div>
  );
}
