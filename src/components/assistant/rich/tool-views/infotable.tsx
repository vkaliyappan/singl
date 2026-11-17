"use client";

import { useMemo, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { IconArrowDown, IconArrowUp, IconCopy, IconTableExport } from "@tabler/icons-react";
import { cn } from "@/lib/utils";
import { openInJsonTable } from "@/lib/json-handoff";
import { isRecord } from "../shared";

export type InfoField = { name: string; baseType?: string };
export type InfoTable = { fields: InfoField[]; rows: Record<string, unknown>[] };

const MAX_ROWS = 500;
const SAMPLE = 50;

export function isInfoTableLike(v: unknown): v is { rows: unknown[] } {
  return isRecord(v) && Array.isArray(v.rows) && ("dataShape" in v || Object.keys(v).length <= 2);
}

export function inferType(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "boolean") return "BOOLEAN";
  if (typeof v === "number") return Number.isInteger(v) ? "INTEGER" : "NUMBER";
  if (typeof v === "string") return "STRING";
  if (Array.isArray(v)) return "JSON";
  return isInfoTableLike(v) ? "INFOTABLE" : "JSON";
}

export function asInfoTable(value: unknown): InfoTable | null {
  try {
    let rawRows: unknown;
    let declared: InfoField[] = [];
    if (Array.isArray(value)) rawRows = value;
    else if (isRecord(value) && Array.isArray(value.rows)) {
      rawRows = value.rows;
      const defs = isRecord(value.dataShape) ? value.dataShape.fieldDefinitions : undefined;
      if (isRecord(defs)) {
        declared = Object.entries(defs)
          .map(([k, d], i) => ({
            name: isRecord(d) && typeof d.name === "string" ? d.name : k,
            baseType: isRecord(d) && typeof d.baseType === "string" ? d.baseType : undefined,
            ord: isRecord(d) && typeof d.ordinal === "number" ? d.ordinal : i,
          }))
          .sort((a, b) => a.ord - b.ord)
          .map(({ name, baseType }) => ({ name, baseType }));
      }
    } else return null;
    const rows = rawRows as unknown[];
    if (!rows.every(isRecord)) return null;
    // A bare array must have content to be worth showing as a table.
    if (Array.isArray(value) && !rows.length) return null;
    const recs = rows as Record<string, unknown>[];
    const fields: InfoField[] = [...declared];
    const seen = new Set(fields.map((f) => f.name));
    for (const r of recs.slice(0, SAMPLE)) {
      for (const k of Object.keys(r)) {
        if (!seen.has(k)) {
          seen.add(k);
          fields.push({ name: k });
        }
      }
    }
    if (!fields.length) return null;
    for (const f of fields) {
      if (f.baseType) continue;
      const hit = recs.slice(0, SAMPLE).find((r) => r[f.name] != null);
      const t = hit ? inferType(hit[f.name]) : "";
      if (t) f.baseType = t;
    }
    return { fields, rows: recs };
  } catch {
    return null;
  }
}

const cmp = (a: unknown, b: unknown): number => {
  if (a == null) return b == null ? 0 : 1;
  if (b == null) return -1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "boolean" && typeof b === "boolean") return Number(a) - Number(b);
  const sa = typeof a === "object" ? JSON.stringify(a) : String(a);
  const sb = typeof b === "object" ? JSON.stringify(b) : String(b);
  return sa.localeCompare(sb, undefined, { numeric: true, sensitivity: "base" });
};

export const cellText = (v: unknown): string => {
  if (v == null) return "";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
};

export function CellValue({ value }: { value: unknown }) {
  if (value === null || value === undefined)
    return <span className="text-muted-foreground/70 italic">null</span>;
  if (typeof value === "boolean")
    return value ? (
      <span className="text-emerald-600 dark:text-emerald-400" aria-label="yes">
        ✓
      </span>
    ) : (
      <span className="text-red-600 dark:text-red-400" aria-label="no">
        ✗
      </span>
    );
  if (typeof value === "number") return <span className="tabular-nums">{String(value)}</span>;
  if (isInfoTableLike(value))
    return <span className="text-muted-foreground">InfoTable ({value.rows.length} rows)</span>;
  if (typeof value === "object") {
    const s = JSON.stringify(value);
    return (
      <span className="font-mono text-[10.5px]" title={s}>
        {s.length > 60 ? s.slice(0, 60) + "…" : s}
      </span>
    );
  }
  return <>{String(value)}</>;
}

export function MiniBadge({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        "rounded bg-background/60 px-1 text-[9px] leading-4 font-normal tracking-wide text-muted-foreground uppercase",
        className
      )}
    >
      {children}
    </span>
  );
}

export function InfoTableView({ value }: { value: unknown }) {
  const router = useRouter();
  const table = useMemo(() => asInfoTable(value), [value]);
  const [sort, setSort] = useState<{ key: string; dir: 1 | -1 } | null>(null);
  const [filter, setFilter] = useState("");
  const [copied, setCopied] = useState(false);

  const rows = useMemo(() => {
    if (!table) return [];
    let r = table.rows;
    const q = filter.trim().toLowerCase();
    if (q) r = r.filter((row) => table.fields.some((f) => cellText(row[f.name]).toLowerCase().includes(q)));
    if (sort) {
      const { key, dir } = sort;
      // Empty cells stay at the bottom in both directions.
      const empty = (v: unknown) => v === null || v === undefined || v === "";
      r = [...r].sort((a, b) =>
        empty(a[key]) !== empty(b[key])
          ? empty(a[key]) ? 1 : -1
          : cmp(a[key], b[key]) * dir,
      );
    }
    return r;
  }, [table, filter, sort]);

  if (!table) return null;
  const { fields } = table;
  const total = table.rows.length;
  const shown = rows.slice(0, MAX_ROWS);

  const cycle = (key: string) =>
    setSort((s) => (!s || s.key !== key ? { key, dir: 1 } : s.dir === 1 ? { key, dir: -1 } : null));

  const copyTsv = async () => {
    const clean = (v: unknown) => cellText(v).replace(/[\t\r\n]+/g, " ");
    const tsv = [
      fields.map((f) => f.name).join("\t"),
      ...rows.map((r) => fields.map((f) => clean(r[f.name])).join("\t")),
    ].join("\n");
    try {
      await navigator.clipboard.writeText(tsv);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked */
    }
  };

  const btn =
    "inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10.5px] text-muted-foreground hover:bg-muted hover:text-foreground";

  return (
    <div className="rounded-md border bg-card text-[11px]">
      <div className="flex flex-wrap items-center gap-2 border-b px-2 py-1">
        <span className="text-muted-foreground">
          {filter && rows.length !== total ? `${rows.length} of ${total} rows` : `${total} rows`}
          {rows.length > MAX_ROWS && ` · showing first ${MAX_ROWS}`}
        </span>
        {total > 8 && (
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter…"
            aria-label="Filter rows"
            className="h-5 w-28 rounded border bg-background px-1.5 text-[10.5px] outline-none focus:border-ring"
          />
        )}
        <span className="ml-auto flex items-center gap-1">
          <button type="button" className={btn} onClick={copyTsv} aria-label="Copy table as TSV">
            <IconCopy className="size-3" />
            {copied ? "Copied" : "Copy TSV"}
          </button>
          <button
            type="button"
            className={btn}
            aria-label="Open in JSON to Table"
            onClick={() => {
              openInJsonTable(value);
              router.push("/json-table");
            }}
          >
            <IconTableExport className="size-3" />
            Open in JSON to Table
          </button>
        </span>
      </div>
      <div className="max-h-[22rem] overflow-auto">
        <table className="w-full border-collapse">
          <thead className="sticky top-0 z-10 bg-muted">
            <tr>
              {fields.map((f) => {
                const active = sort?.key === f.name;
                const numeric = /INTEGER|NUMBER|LONG/.test(f.baseType ?? "");
                return (
                  <th
                    key={f.name}
                    scope="col"
                    aria-sort={active ? (sort!.dir === 1 ? "ascending" : "descending") : "none"}
                    className="border-b p-0 text-left font-medium whitespace-nowrap"
                  >
                    <button
                      type="button"
                      onClick={() => cycle(f.name)}
                      aria-label={`Sort by ${f.name}`}
                      className={cn("flex w-full items-center gap-1 px-2 py-1 hover:bg-accent", numeric && "justify-end")}
                    >
                      {f.name}
                      {f.baseType && <MiniBadge>{f.baseType}</MiniBadge>}
                      {active &&
                        (sort!.dir === 1 ? <IconArrowUp className="size-3" /> : <IconArrowDown className="size-3" />)}
                    </button>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {shown.map((row, i) => (
              <tr key={i} className={i % 2 ? "bg-muted/30" : undefined}>
                {fields.map((f) => {
                  const v = row[f.name];
                  return (
                    <td
                      key={f.name}
                      className={cn(
                        "max-w-[22rem] truncate border-b border-border/40 px-2 py-0.5",
                        typeof v === "number" && "text-right tabular-nums"
                      )}
                    >
                      <CellValue value={v} />
                    </td>
                  );
                })}
              </tr>
            ))}
            {!shown.length && (
              <tr>
                <td colSpan={fields.length} className="px-2 py-3 text-center text-muted-foreground">
                  No rows
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
