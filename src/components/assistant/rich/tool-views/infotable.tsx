"use client";

import { useMemo, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { IconCopy, IconTableExport } from "@tabler/icons-react";
import { cn } from "@/lib/utils";
import { openInJsonTable } from "@/lib/json-handoff";
import { DataGrid, columnsFromFields, type GridColumn } from "@/components/data-grid";
import { isRecord } from "../shared";

export type InfoField = { name: string; baseType?: string };
export type InfoTable = { fields: InfoField[]; rows: Record<string, unknown>[] };

const MAX_ROWS = 5000;
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
      <span className="text-success" aria-label="yes">
        ✓
      </span>
    ) : (
      <span className="text-destructive" aria-label="no">
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

export function InfoTableView({
  value,
  id,
  maxHeight = 360,
  pageSize = 25,
}: {
  value: unknown;
  id?: string;
  maxHeight?: number;
  pageSize?: number;
}) {
  const router = useRouter();
  const table = useMemo(() => asInfoTable(value), [value]);
  const [copied, setCopied] = useState(false);

  const columns = useMemo<GridColumn<Record<string, unknown>>[]>(() => {
    if (!table) return [];
    const base = columnsFromFields(table.fields, table.rows);
    return base.map((c, i) => {
      const f = table.fields[i];
      return {
        ...c,
        // Nested values are searchable as JSON; the type tag stays in the header.
        header: (
          <span className="flex items-center gap-1">
            {f.name}
            {f.baseType && <MiniBadge>{f.baseType}</MiniBadge>}
          </span>
        ),
        // Dates and booleans render by kind in the grid; the rest keep the typed cell.
        render:
          c.kind === "date"
            ? undefined
            : (row) => (
                <span className="block max-w-full truncate">
                  <CellValue value={row[f.name]} />
                </span>
              ),
        truncate: false,
      };
    });
  }, [table]);

  if (!table) return null;
  const { fields } = table;
  const shown = table.rows.slice(0, MAX_ROWS);
  // Layout is remembered per table shape, so two results with the same columns share it.
  const gridId = id ?? `infotable:${fields.map((f) => f.name).join("|").slice(0, 120)}`;

  const copyTsv = async () => {
    const clean = (v: unknown) => cellText(v).replace(/[\t\r\n]+/g, " ");
    const tsv = [
      fields.map((f) => f.name).join("\t"),
      ...shown.map((r) => fields.map((f) => clean(r[f.name])).join("\t")),
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
    <DataGrid
      id={gridId}
      columns={columns}
      rows={shown}
      pageSize={pageSize}
      maxHeight={maxHeight}
      csvName="table"
      searchPlaceholder="Search…"
      toolbarExtra={
        <span className="flex items-center gap-1">
          {table.rows.length > MAX_ROWS && (
            <span className="text-[10.5px] text-muted-foreground">first {MAX_ROWS} of {table.rows.length}</span>
          )}
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
      }
    />
  );
}
