"use client";

import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { asInfotable } from "@/lib/twx-flow/schema";
import { JsonView } from "./json-view";

/** One parameter of a call, as it was declared and as it was actually sent. */
export type ParamEntry = {
  name: string;
  /** From the service signature. Absent for the synthetic inputs other kinds record. */
  baseType?: string;
  required?: boolean;
  /** Whether anything was sent for it at all — `null` sent is not the same as omitted. */
  sent: boolean;
  value: unknown;
  /** Why the parameter's expression could not be evaluated, when it could not. */
  error?: string;
};

const NUMERIC = new Set(["NUMBER", "INTEGER", "LONG"]);
/** Base types whose value is a document, whatever it happens to hold right now. */
const DOCUMENT = new Set(["INFOTABLE", "JSON", "XML", "LOCATION", "VEC2", "VEC3", "VEC4"]);
/** A string longer than this is a paragraph, not a field — give it a box. */
const TEXTAREA_AT = 80;

type Widget = "boolean" | "number" | "text" | "textarea" | "json";

/**
 * Which control stands for a value: the declared base type decides, and the
 * value itself fills in for the nodes that declare nothing. A value that turned
 * out to be an object always wins — a `STRING` parameter fed an infotable is
 * still an infotable, and reading it as one line helps nobody.
 */
function widgetFor(entry: ParamEntry): Widget {
  if (entry.value !== null && typeof entry.value === "object") return "json";
  const type = (entry.baseType ?? "").toUpperCase();
  if (DOCUMENT.has(type)) return "json";
  if (type === "BOOLEAN" || typeof entry.value === "boolean") return "boolean";
  if (NUMERIC.has(type) || typeof entry.value === "number") return "number";
  const text = entry.value === null || entry.value === undefined ? "" : String(entry.value);
  return text.includes("\n") || text.length > TEXTAREA_AT ? "textarea" : "text";
}

/** The badge beside a name: the declared type, and how much a document holds. */
function typeLabel(entry: ParamEntry): string {
  const table = asInfotable(entry.value);
  const declared = entry.baseType ?? (table ? "INFOTABLE" : undefined);
  if (table) return `${declared ?? "INFOTABLE"} · ${table.rows.length}`;
  if (declared) return declared;
  if (Array.isArray(entry.value)) return `ARRAY · ${entry.value.length}`;
  if (entry.value !== null && typeof entry.value === "object") return "JSON";
  return typeof entry.value === "boolean"
    ? "BOOLEAN"
    : typeof entry.value === "number"
      ? "NUMBER"
      : "STRING";
}

const control = "h-6 rounded-sm px-1.5 py-0 font-mono text-[10px] shadow-none";

/**
 * The value of one parameter, drawn as the control its type calls for. Every
 * control is read-only: this is a record of a call that already happened, and a
 * field that looks editable would be lying about that.
 */
function ParamValue({ entry }: { entry: ParamEntry }) {
  if (entry.error) {
    return (
      <p className="rounded-sm border border-destructive/40 bg-destructive/5 px-1.5 py-1 font-mono text-[10px] break-all text-destructive">
        {entry.error}
      </p>
    );
  }

  if (!entry.sent) {
    return (
      <p className="px-1.5 py-1 font-mono text-[10px] text-muted-foreground/70 italic">
        not sent
      </p>
    );
  }

  switch (widgetFor(entry)) {
    case "boolean":
      return (
        <div className="flex h-6 items-center gap-1.5">
          <Checkbox checked={entry.value === true} disabled aria-readonly className="size-3.5" />
          <span className="font-mono text-[10px] text-muted-foreground">
            {String(entry.value)}
          </span>
        </div>
      );

    case "number":
      return (
        <Input
          readOnly
          value={entry.value === null ? "" : String(entry.value)}
          placeholder="null"
          className={cn(control, "tabular-nums")}
        />
      );

    case "textarea": {
      const text = String(entry.value);
      return (
        <Textarea
          readOnly
          value={text}
          rows={Math.min(6, text.split("\n").length + 1)}
          className="resize-y rounded-sm px-1.5 py-1 font-mono text-[10px] shadow-none"
        />
      );
    }

    case "json":
      // `null` for a document type has no tree to draw — say so as a value
      // rather than rendering an empty document.
      return entry.value === null ? (
        <Input readOnly value="" placeholder="null" className={control} />
      ) : (
        <JsonView value={entry.value} className="max-h-56 overflow-auto" />
      );

    default:
      return (
        <Input
          readOnly
          value={entry.value === null ? "" : String(entry.value)}
          placeholder="null"
          className={control}
        />
      );
  }
}

/**
 * The request body as a form: one labelled control per parameter, in the order
 * the service declares them. The same information the JSON view carries, laid
 * out so a single value can be read without unfolding a document to find it.
 */
export function ParamFields({ entries }: { entries: ParamEntry[] }) {
  return (
    <div className="rounded-md border">
      {entries.map((entry) => (
        <div
          key={entry.name}
          className="grid grid-cols-[10rem_1fr] items-start gap-2 border-b px-2 py-1.5 last:border-b-0"
        >
          <div className="flex min-w-0 items-center gap-1 pt-1">
            <span
              title={entry.name}
              className="truncate font-mono text-[10px] text-muted-foreground"
            >
              {entry.name}
            </span>
            {entry.required && (
              <span title="Required" className="shrink-0 text-[10px] text-destructive">
                *
              </span>
            )}
            <Badge variant="outline" className="ml-auto shrink-0 px-1 text-[8px] font-normal">
              {typeLabel(entry)}
            </Badge>
          </div>
          <div className="min-w-0">
            <ParamValue entry={entry} />
          </div>
        </div>
      ))}
    </div>
  );
}
