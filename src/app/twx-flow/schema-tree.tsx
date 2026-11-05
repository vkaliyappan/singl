"use client";

import { useMemo, useState } from "react";
import {
  IconChevronDown,
  IconChevronRight,
  IconCopy,
  IconGripVertical,
  IconSearch,
  IconX,
} from "@tabler/icons-react";

import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";
import { joinPath, pickExpression } from "@/lib/twx-flow/expression";
import type { FieldDef } from "@/lib/twx-flow/types";

/** Depth at which branches start collapsed, so big infotables stay readable. */
const AUTO_OPEN_DEPTH = 2;
/** Rows drawn per array before the rest are held back behind "show more". */
const ARRAY_PAGE = 25;

export const EXPRESSION_MIME = "application/x-twx-expression";

/**
 * Everything needed to drag one expression into a parameter field. Shared so a
 * key in the JSON view or a column in the grid drags exactly like a tree row:
 * the expression on the private MIME type, `{{ … }}` for anything else.
 */
export function expressionDragProps(expression: string) {
  return {
    draggable: true,
    title: `Drag into a parameter — ${expression}`,
    onDragStart: (e: React.DragEvent) => {
      e.dataTransfer.setData(EXPRESSION_MIME, expression);
      e.dataTransfer.setData("text/plain", `{{ ${expression} }}`);
      e.dataTransfer.effectAllowed = "copy";
    },
  };
}

function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (value === undefined) return "—";
  return typeof value;
}

function preview(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "";
  if (Array.isArray(value)) return `${value.length} item${value.length === 1 ? "" : "s"}`;
  if (typeof value === "object") return `${Object.keys(value as object).length} keys`;
  if (typeof value === "string") return value.length > 48 ? `${value.slice(0, 48)}…` : value;
  return String(value);
}

/** Ticking rows of one array — the infotable's `rows` — inside the tree. */
export type RowSelection = {
  /** Expression the selectable array sits at, e.g. `$json.rows`. */
  path: string;
  selected: number[];
  onChange: (next: number[]) => void;
};

/** The row index `expression` addresses within `path`, or null if it is elsewhere. */
function rowIndexOf(path: string, expression: string): number | null {
  if (!expression.startsWith(path)) return null;
  const match = expression.slice(path.length).match(/^\[(\d+)\]$/);
  return match ? Number(match[1]) : null;
}

export const toggleIndex = (selected: number[], index: number): number[] =>
  selected.includes(index)
    ? selected.filter((i) => i !== index)
    : [...selected, index].sort((a, b) => a - b);

/** How deep a filter looks for a match before giving up on a branch. */
const FILTER_DEPTH = 6;

/** True when this row, or anything under it, contains every search word. */
function subtreeMatches(label: string, value: unknown, words: string[], depth = 0): boolean {
  const text = `${label} ${preview(value)}`.toLowerCase();
  const missing = words.filter((word) => !text.includes(word));
  if (!missing.length) return true;
  if (depth >= FILTER_DEPTH || value === null || typeof value !== "object") return false;

  const children: [string, unknown][] = Array.isArray(value)
    ? value.map((v, i) => [String(i), v])
    : Object.entries(value as Record<string, unknown>);
  // A word matched here counts for the descendants too, so `rows part` finds a
  // `part…` field inside `rows`.
  return children.some(([key, child]) => subtreeMatches(key, child, missing, depth + 1));
}

type RowProps = {
  label: string;
  value: unknown;
  /** Full expression that yields this value, e.g. `$json.rows[0].name`. */
  expression: string;
  depth: number;
  fieldTypes: Map<string, string>;
  selection?: RowSelection;
  /** Search words, already lower-cased. Empty means no filtering. */
  words: string[];
  onInsert?: (expression: string) => void;
};

function TreeRow({
  label,
  value,
  expression,
  depth,
  fieldTypes,
  selection,
  words,
  onInsert,
}: RowProps) {
  const isBranch = value !== null && typeof value === "object";
  const [open, setOpen] = useState(depth < AUTO_OPEN_DEPTH);
  const [shown, setShown] = useState(ARRAY_PAGE);

  const all = useMemo(
    () =>
      !isBranch
        ? []
        : Array.isArray(value)
          ? value.map((v, i) => ({ key: String(i), value: v, isIndex: true }))
          : Object.entries(value as Record<string, unknown>).map(([k, v]) => ({
              key: k,
              value: v,
              isIndex: false,
            })),
    [isBranch, value]
  );

  // Filtering keeps a child only when the search words appear somewhere beneath
  // it, so the path down to a match stays visible.
  const kept = useMemo(
    () => (words.length ? all.filter((e) => subtreeMatches(e.key, e.value, words)) : all),
    [all, words]
  );

  const entries = kept.slice(0, shown);
  const hidden = Math.max(0, kept.length - shown);

  const declaredType = fieldTypes.get(label);

  // Selectable rows: each element of the array `selection.path` points at, plus
  // a select-all on the array itself.
  const rowIndex = selection ? rowIndexOf(selection.path, expression) : null;
  const isRowsArray = !!selection && expression === selection.path && Array.isArray(value);
  const rowCount = isRowsArray ? (value as unknown[]).length : 0;
  const allSelected = isRowsArray && rowCount > 0 && selection!.selected.length === rowCount;

  // Dragging a ticked row carries the whole tick — as an infotable, DataShape
  // and all. Everything else drags as the plain path it shows.
  const inSelection = rowIndex !== null && selection!.selected.includes(rowIndex);
  const dragged =
    inSelection || (isRowsArray && selection!.selected.length > 0)
      ? pickExpression(selection!.path, selection!.selected)
      : expression;

  // While filtering, branches open themselves — a match three levels down is no
  // use behind a closed chevron.
  const expanded = isBranch && (open || words.length > 0);

  return (
    <div>
      <div
        className={cn(
          "group/row flex items-center gap-1 rounded px-1 py-[3px] text-[11px] hover:bg-accent",
          rowIndex !== null && selection!.selected.includes(rowIndex) && "bg-primary/10"
        )}
        style={{ paddingLeft: depth * 12 + 4 }}
      >
        {rowIndex !== null && (
          <Checkbox
            className="size-3.5 shrink-0"
            checked={selection!.selected.includes(rowIndex)}
            onCheckedChange={() => selection!.onChange(toggleIndex(selection!.selected, rowIndex))}
            aria-label={`Select row ${rowIndex}`}
          />
        )}
        {isRowsArray && (
          <Checkbox
            className="size-3.5 shrink-0"
            checked={allSelected}
            indeterminate={selection!.selected.length > 0 && !allSelected}
            onCheckedChange={(checked) =>
              selection!.onChange(
                checked ? Array.from({ length: rowCount }, (_, i) => i) : []
              )
            }
            aria-label={allSelected ? "Clear row selection" : "Select every row"}
          />
        )}
        {isBranch ? (
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            className="text-muted-foreground"
            aria-label={expanded ? "Collapse" : "Expand"}
          >
            {expanded ? (
              <IconChevronDown className="size-3" />
            ) : (
              <IconChevronRight className="size-3" />
            )}
          </button>
        ) : (
          <span className="w-3" />
        )}

        <div
          {...expressionDragProps(dragged)}
          onClick={() => onInsert?.(dragged)}
          className="flex min-w-0 flex-1 cursor-grab items-baseline gap-2 active:cursor-grabbing"
        >
          <IconGripVertical className="size-3 shrink-0 self-center text-muted-foreground/0 transition-colors group-hover/row:text-muted-foreground/70" />
          <span className="shrink-0 font-mono text-foreground">{label}</span>
          <span className="shrink-0 font-mono text-[9px] text-muted-foreground/70 uppercase">
            {declaredType ?? typeOf(value)}
          </span>
          <span className="truncate font-mono text-muted-foreground">{preview(value)}</span>
        </div>

        <button
          type="button"
          aria-label={`Copy {{ ${dragged} }}`}
          title={`Copy {{ ${dragged} }}`}
          onClick={(e) => {
            e.stopPropagation();
            navigator.clipboard?.writeText(`{{ ${dragged} }}`);
          }}
          className="shrink-0 rounded p-0.5 text-muted-foreground opacity-0 transition-opacity group-hover/row:opacity-100 hover:text-foreground"
        >
          <IconCopy className="size-3" />
        </button>
      </div>

      {expanded && (
        <div>
          {entries.map((e) => (
            <TreeRow
              key={e.key}
              label={e.isIndex ? `[${e.key}]` : e.key}
              value={e.value}
              expression={joinPath(expression, e.key, e.isIndex)}
              depth={depth + 1}
              fieldTypes={fieldTypes}
              selection={selection}
              words={words}
              onInsert={onInsert}
            />
          ))}
          {words.length > 0 && kept.length === 0 && (
            <p
              className="px-1 py-0.5 text-[10px] text-muted-foreground"
              style={{ paddingLeft: (depth + 1) * 12 + 4 }}
            >
              nothing matches
            </p>
          )}
          {hidden > 0 && (
            <div
              className="flex items-center gap-2 px-1 py-0.5 text-[10px] text-muted-foreground"
              style={{ paddingLeft: (depth + 1) * 12 + 4 }}
            >
              <button
                type="button"
                onClick={() => setShown((n) => n + ARRAY_PAGE)}
                className="rounded border px-1.5 py-0.5 hover:bg-accent hover:text-foreground"
              >
                Show {Math.min(ARRAY_PAGE, hidden)} more
              </button>
              <button
                type="button"
                onClick={() => setShown(kept.length)}
                className="rounded border px-1.5 py-0.5 hover:bg-accent hover:text-foreground"
              >
                Show all {kept.length}
              </button>
              <span>{hidden} hidden</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * The structure of one node's output, as a tree whose every row can be dragged
 * into a parameter field. `value` is the real result after a run, or a sample
 * built from the DataShape before one.
 */
export function SchemaTree({
  value,
  root,
  rootLabel = "result",
  fields = [],
  selection,
  filterable = true,
  onInsert,
  className,
}: {
  value: unknown;
  /** Expression the root row stands for, e.g. `$json` or `$node["Fetch"]`. */
  root: string;
  rootLabel?: string;
  /** Declared columns, used to show ThingWorx base types instead of JS ones. */
  fields?: FieldDef[];
  /** Enables tick boxes on the rows of the array it names. */
  selection?: RowSelection;
  /** Hides the filter box, for trees small enough not to need one. */
  filterable?: boolean;
  onInsert?: (expression: string) => void;
  className?: string;
}) {
  const [filter, setFilter] = useState("");
  const fieldTypes = useMemo(
    () => new Map(fields.map((f) => [f.name, f.baseType])),
    [fields]
  );
  const words = useMemo(
    () => filter.trim().toLowerCase().split(/\s+/).filter(Boolean),
    [filter]
  );

  return (
    <div className={cn("flex min-h-0 flex-col gap-1", className)}>
      {filterable && (
        // Sticky: the tree scrolls inside its parent, and a filter box that
        // scrolls away is worse than none.
        <div className="sticky top-0 z-10 shrink-0 bg-background pb-1">
          <div className="relative">
            <IconSearch className="pointer-events-none absolute top-1/2 left-1.5 size-3 -translate-y-1/2 text-muted-foreground" />
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter fields and values"
              className="h-6 w-full rounded-md border border-input bg-input/20 pr-5 pl-6 font-mono text-[10px] outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30 dark:bg-input/30"
            />
            {filter !== "" && (
              <button
                type="button"
                onClick={() => setFilter("")}
                aria-label="Clear filter"
                className="absolute top-1/2 right-1.5 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                <IconX className="size-3" />
              </button>
            )}
          </div>
        </div>
      )}

      <div className="min-h-0 flex-1 rounded-md border p-1">
        <TreeRow
          label={rootLabel}
          value={value}
          expression={root}
          depth={0}
          fieldTypes={fieldTypes}
          selection={selection}
          words={words}
          onInsert={onInsert}
        />
      </div>
    </div>
  );
}
