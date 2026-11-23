"use client";

import { useMemo } from "react";
import { cn } from "@/lib/utils";
import { DataGrid, type GridColumn } from "@/components/data-grid";
import { isRecord } from "../shared";

export type ShapeField = {
  name: string;
  baseType: string;
  description?: string;
  ordinal?: number;
  primaryKey?: boolean;
};

const str = (v: unknown) => (typeof v === "string" ? v : undefined);

function toField(v: unknown): ShapeField | null {
  if (!isRecord(v)) return null;
  const name = str(v.name) ?? str(v.fieldName);
  if (!name) return null;
  const aspects = isRecord(v.aspects) ? v.aspects : undefined;
  return {
    name,
    baseType: str(v.baseType) ?? str(v.type) ?? "",
    description: str(v.description) || undefined,
    ordinal: typeof v.ordinal === "number" ? v.ordinal : undefined,
    primaryKey: aspects?.isPrimaryKey === true || v.isPrimaryKey === true || v.primaryKey === true,
  };
}

export function asDataShapeFields(value: unknown): ShapeField[] | null {
  try {
    if (!Array.isArray(value) || !value.length) return null;
    const out = value.map(toField);
    return out.every((f): f is ShapeField => f !== null) ? out : null;
  } catch {
    return null;
  }
}

/** flow_datashape_fields output: `{ ShapeName: fields[] }`. */
export function asDataShapeMap(value: unknown): Record<string, ShapeField[]> | null {
  try {
    if (!isRecord(value)) return null;
    const entries = Object.entries(value);
    if (!entries.length || !entries.every(([, v]) => Array.isArray(v))) return null;
    const out: Record<string, ShapeField[]> = {};
    for (const [k, v] of entries) {
      const f = (v as unknown[]).length ? asDataShapeFields(v) : [];
      if (!f) return null;
      out[k] = f;
    }
    return out;
  } catch {
    return null;
  }
}

function family(t: string): string {
  const u = t.toUpperCase();
  if (/INTEGER|LONG|NUMBER/.test(u)) return "bg-info/15 text-info";
  if (u === "BOOLEAN") return "bg-violet-500/15 text-violet-700 dark:text-violet-300";
  if (u === "DATETIME" || u === "TIMESPAN") return "bg-warning/15 text-warning";
  if (u === "INFOTABLE" || u === "JSON" || u === "TAGS") return "bg-rose-500/15 text-rose-700 dark:text-rose-300";
  if (/STRING|TEXT|HTML|XML|PASSWORD|LOCATION|IMAGE|GUID|NAME/.test(u))
    return "bg-success/15 text-success";
  return "bg-muted text-muted-foreground";
}

export function TypeBadge({ type }: { type: string }) {
  if (!type) return null;
  return <span className={cn("rounded px-1 font-mono text-[10px] leading-4", family(type))}>{type}</span>;
}

const FIELD_COLUMNS: GridColumn<ShapeField & { n: number }>[] = [
  { key: "n", label: "#", kind: "number", width: 56 },
  {
    key: "name",
    label: "Name",
    kind: "text",
    width: 200,
    render: (f) => (
      <span className="font-mono">
        {f.name}
        {f.primaryKey && (
          <span
            title="Primary key"
            className="ml-1 rounded bg-warning/15 px-1 font-sans text-[9px] text-warning"
          >
            PK
          </span>
        )}
      </span>
    ),
  },
  { key: "baseType", label: "Type", kind: "text", width: 120, render: (f) => <TypeBadge type={f.baseType} /> },
  { key: "description", label: "Description", kind: "text", width: 320, truncate: false },
];

export function FieldsTable({ fields }: { fields: ShapeField[] }) {
  const rows = useMemo(() => fields.map((f, i) => ({ ...f, n: f.ordinal ?? i + 1 })), [fields]);
  return (
    <DataGrid
      id="datashape-fields"
      columns={FIELD_COLUMNS}
      rows={rows}
      rowKey={(f, i) => `${f.name}|${i}`}
      searchable={rows.length > 8}
      pageSize={50}
      maxHeight={352}
      csvName="fields"
    />
  );
}

export function DataShapeView({ value }: { value: unknown }) {
  const fields = asDataShapeFields(value);
  if (fields)
    return (
      <div className="rounded-md border bg-card">
        <div className="border-b px-2 py-1 text-[10.5px] text-muted-foreground">{fields.length} fields</div>
        <FieldsTable fields={fields} />
      </div>
    );
  const map = asDataShapeMap(value);
  if (!map) return null;
  return (
    <div className="space-y-2">
      {Object.entries(map).map(([name, f]) => (
        <div key={name} className="rounded-md border bg-card">
          <div className="border-b px-2 py-1 text-[10.5px]">
            <span className="font-mono font-medium">{name}</span>{" "}
            <span className="text-muted-foreground">{f.length ? `${f.length} fields` : "no fields (not readable)"}</span>
          </div>
          {f.length > 0 && <FieldsTable fields={f} />}
        </div>
      ))}
    </div>
  );
}
