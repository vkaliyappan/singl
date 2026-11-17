"use client";

import { useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import { isRecord, parseJson, Placeholder, SourceToggle } from "../shared";
import { CellValue, cellText, inferType } from "./infotable";
import { absTime, relTime } from "./run-times";

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
  if (u === "GOOD") return "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300";
  if (u === "BAD") return "bg-red-500/15 text-red-700 dark:text-red-300";
  return "bg-amber-500/15 text-amber-700 dark:text-amber-300";
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
  const [filter, setFilter] = useState("");
  const [now] = useState(() => Date.now());

  const shown = useMemo(() => {
    if (!rows) return [];
    const q = filter.trim().toLowerCase();
    return q ? rows.filter((r) => r.name.toLowerCase().includes(q) || cellText(r.value).toLowerCase().includes(q)) : rows;
  }, [rows, filter]);

  if (!rows) return null;
  const hasQuality = rows.some((r) => r.quality);
  const hasTime = rows.some((r) => r.time !== undefined);

  return (
    <div className="rounded-md border bg-card text-[11px]">
      <div className="flex items-center gap-2 border-b px-2 py-1">
        <span className="text-muted-foreground">
          {filter ? `${shown.length} of ${rows.length}` : rows.length} {rows.length === 1 ? "property" : "properties"}
        </span>
        {rows.length > 12 && (
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter…"
            aria-label="Filter properties"
            className="h-5 w-32 rounded border bg-background px-1.5 text-[10.5px] outline-none focus:border-ring"
          />
        )}
      </div>
      <div className="max-h-[22rem] overflow-auto">
        <table className="w-full table-fixed border-collapse">
          <thead className="sticky top-0 z-10 bg-muted text-left">
            <tr>
              <th className="w-[32%] px-2 py-1 font-medium">Name</th>
              <th className="px-2 py-1 font-medium">Value</th>
              <th className="w-24 px-2 py-1 font-medium">Type</th>
              {hasQuality && <th className="w-20 px-2 py-1 font-medium">Quality</th>}
              {hasTime && <th className="w-24 px-2 py-1 font-medium">Time</th>}
            </tr>
          </thead>
          <tbody>
            {shown.map((r, i) => {
              const ms = r.time === undefined ? NaN : typeof r.time === "number" ? r.time : Date.parse(r.time);
              const stale = !Number.isNaN(ms) && now - ms > STALE_MS;
              const bad = r.quality?.toUpperCase() === "BAD";
              return (
                <tr key={r.name + i} className={cn(bad ? "bg-red-500/5" : i % 2 && "bg-muted/30")}>
                  <td className="truncate px-2 py-0.5 font-mono" title={r.name}>
                    {r.name}
                  </td>
                  <td className="px-2 py-0.5">
                    <ValueCell value={r.value} />
                  </td>
                  <td className="truncate px-2 py-0.5 text-[10px] text-muted-foreground uppercase">
                    {r.baseType ?? inferType(r.value)}
                  </td>
                  {hasQuality && (
                    <td className="px-2 py-0.5">
                      {r.quality && (
                        <span className={cn("rounded px-1 text-[9.5px] leading-4", qualityClass(r.quality))}>
                          {r.quality}
                        </span>
                      )}
                    </td>
                  )}
                  {hasTime && (
                    <td
                      className={cn(
                        "px-2 py-0.5 whitespace-nowrap",
                        stale ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground"
                      )}
                      title={r.time !== undefined ? `${absTime(r.time)}${stale ? " (stale: older than 24h)" : ""}` : undefined}
                    >
                      {relTime(r.time)}
                    </td>
                  )}
                </tr>
              );
            })}
            {!shown.length && (
              <tr>
                <td colSpan={5} className="px-2 py-3 text-center text-muted-foreground">
                  No matches
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
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
