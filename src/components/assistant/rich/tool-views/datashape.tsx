"use client";

import { cn } from "@/lib/utils";
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
  if (/INTEGER|LONG|NUMBER/.test(u)) return "bg-sky-500/15 text-sky-700 dark:text-sky-300";
  if (u === "BOOLEAN") return "bg-violet-500/15 text-violet-700 dark:text-violet-300";
  if (u === "DATETIME" || u === "TIMESPAN") return "bg-amber-500/15 text-amber-700 dark:text-amber-300";
  if (u === "INFOTABLE" || u === "JSON" || u === "TAGS") return "bg-rose-500/15 text-rose-700 dark:text-rose-300";
  if (/STRING|TEXT|HTML|XML|PASSWORD|LOCATION|IMAGE|GUID|NAME/.test(u))
    return "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300";
  return "bg-muted text-muted-foreground";
}

export function TypeBadge({ type }: { type: string }) {
  if (!type) return null;
  return <span className={cn("rounded px-1 font-mono text-[10px] leading-4", family(type))}>{type}</span>;
}

export function FieldsTable({ fields }: { fields: ShapeField[] }) {
  return (
    <div className="max-h-[22rem] overflow-auto">
      <table className="w-full border-collapse text-[11px]">
        <thead className="sticky top-0 bg-muted text-left">
          <tr>
            <th className="w-8 px-2 py-1 font-medium">#</th>
            <th className="px-2 py-1 font-medium">Name</th>
            <th className="px-2 py-1 font-medium">Type</th>
            <th className="px-2 py-1 font-medium">Description</th>
          </tr>
        </thead>
        <tbody>
          {fields.map((f, i) => (
            <tr key={f.name + i} className={i % 2 ? "bg-muted/30" : undefined}>
              <td className="px-2 py-0.5 text-muted-foreground tabular-nums">{f.ordinal ?? i + 1}</td>
              <td className="px-2 py-0.5 font-mono">
                {f.name}
                {f.primaryKey && (
                  <span
                    title="Primary key"
                    className="ml-1 rounded bg-amber-500/15 px-1 font-sans text-[9px] text-amber-700 dark:text-amber-300"
                  >
                    PK
                  </span>
                )}
              </td>
              <td className="px-2 py-0.5">
                <TypeBadge type={f.baseType} />
              </td>
              <td className="px-2 py-0.5 text-muted-foreground">{f.description}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
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
