"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type CSSProperties,
  type ReactNode,
} from "react";
import { DataTable, shadcnClassNames, type ColumnDef } from "@adapttable/shadcn";
import {
  columnMenu,
  exportCsv,
  headerFilters,
  multiSort,
  resizableColumns,
} from "@adapttable/shadcn/features";
import { useColumnLayoutStorageState, type LayoutStorage, type UrlStateAdapter } from "@adapttable/core";
import { cn } from "@/lib/utils";

/**
 * One table component for the whole app: multi-column sort, Excel-style header
 * filters, global search, show/hide, drag-to-reorder, pin, resize and CSV
 * export. Hidden columns, order, pins, widths and sort are remembered per
 * `id` in localStorage; search, filters and the page are not.
 */

export type GridKind = "text" | "number" | "date" | "boolean" | "none";

export type GridColumn<T> = {
  key: string;
  /** Header content; defaults to `label`, then `key`. */
  header?: ReactNode;
  /** Plain-text name used in menus and CSV; defaults to `key`. */
  label?: string;
  /** Drives alignment, sort and filter. "none" = no sort/filter (action columns). */
  kind?: GridKind;
  /** The raw cell value (sorted, filtered, searched, exported). Defaults to `row[key]`. */
  value?: (row: T) => unknown;
  /** Custom cell. Without it the value is rendered by kind. */
  render?: (row: T) => ReactNode;
  width?: number;
  minWidth?: number;
  align?: "start" | "center" | "end";
  /** Start hidden (the user can show it from the Columns menu). */
  hidden?: boolean;
  /** Cannot be hidden or moved. */
  locked?: boolean;
  /** Truncate long text in the cell (default true for text, pass false to wrap). */
  truncate?: boolean;
  /** Cap on the cell's width in rem when truncating. */
  maxWidthRem?: number;
};

export type DataGridProps<T> = {
  /** Unique per table; keys the saved layout. */
  id: string;
  columns: GridColumn<T>[];
  rows: readonly T[];
  /** Stable row identity. Defaults to the row's position in `rows`. */
  rowKey?: (row: T, index: number) => string;
  toolbarExtra?: ReactNode;
  renderRowDetail?: (row: T) => ReactNode;
  onRowClick?: (row: T) => void;
  /** Fixed scroll box height in px; header stays pinned inside it. */
  maxHeight?: number;
  /** Page size when rows overflow (default 50). */
  pageSize?: number;
  initialSort?: { key: string; dir?: "asc" | "desc" };
  emptyText?: string;
  searchPlaceholder?: string;
  csvName?: string;
  /** Hide the search box, e.g. for a handful of rows. */
  searchable?: boolean;
  rowClassName?: (row: T, index: number) => string | undefined;
  className?: string;
  style?: CSSProperties;
};

// ── Value helpers ───────────────────────────────────────────────────────────

export function fieldKind(baseType?: string): GridKind {
  const t = (baseType ?? "").toUpperCase();
  if (/^(INTEGER|NUMBER|LONG)$/.test(t)) return "number";
  if (/^(DATETIME|TIMESTAMP)$/.test(t)) return "date";
  if (t === "BOOLEAN") return "boolean";
  return "text";
}

/** Infer a kind from the values themselves, for arrays of records without a schema. */
export function inferKind(values: unknown[]): GridKind {
  const hit = values.find((v) => v !== null && v !== undefined && v !== "");
  if (typeof hit === "number") return "number";
  if (typeof hit === "boolean") return "boolean";
  return "text";
}

export function toMs(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  if (v instanceof Date) return v.getTime();
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") {
    const ms = Date.parse(v);
    return Number.isNaN(ms) ? null : ms;
  }
  return null;
}

export function gridText(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "object") {
    try {
      return JSON.stringify(v);
    } catch {
      return String(v);
    }
  }
  return String(v);
}

function dateText(v: unknown): string {
  const ms = toMs(v);
  return ms === null ? gridText(v) : new Date(ms).toLocaleString();
}

function DefaultCell({ value, kind, truncate }: { value: unknown; kind: GridKind; truncate: boolean }) {
  if (value === null || value === undefined || value === "")
    return <span className="text-muted-foreground/60">—</span>;
  if (kind === "boolean" || typeof value === "boolean") {
    const on = value === true || value === "true";
    return on ? (
      <span className="text-emerald-600 dark:text-emerald-400" aria-label="yes">
        ✓
      </span>
    ) : (
      <span className="text-red-600 dark:text-red-400" aria-label="no">
        ✗
      </span>
    );
  }
  const text = kind === "date" ? dateText(value) : gridText(value);
  const mono = typeof value === "object";
  return (
    <span
      title={truncate ? text : undefined}
      className={cn(
        kind === "number" && "tabular-nums",
        mono && "font-mono text-[10.5px]",
        truncate && "block max-w-full truncate"
      )}
    >
      {text}
    </span>
  );
}

// ── Persistence ─────────────────────────────────────────────────────────────

// The table keeps all its state in a query string. This adapter is a private
// one per grid: it keeps everything in memory but writes only the sort to
// localStorage — search, filters and the page start fresh on every visit.
// (Hidden columns, order, pins and widths go through the column-layout hook.)
const PERSISTED = new Set(["sort"]);
const STORE_PREFIX = "singl.grid.";
const LAYOUT_PREFIX = "singl.grid.layout.";

// localStorage can throw (blocked, full, private window); the layout then just
// doesn't survive a reload.
const safeStorage: LayoutStorage = {
  getItem(k) {
    try {
      return window.localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  setItem(k, v) {
    try {
      window.localStorage.setItem(k, v);
    } catch {
      /* ignore */
    }
  },
  removeItem(k) {
    try {
      window.localStorage.removeItem(k);
    } catch {
      /* ignore */
    }
  },
};

function layoutAdapter(id: string, initial: string): UrlStateAdapter {
  const key = STORE_PREFIX + id;
  const subs = new Set<() => void>();
  let search = initial;
  try {
    // A saved layout replaces the default sort wholesale.
    search = window.localStorage.getItem(key) ?? initial;
  } catch {
    /* storage blocked — the layout just won't survive a reload */
  }
  return {
    getSearch: () => search,
    setSearch(raw) {
      // The table writes a single-column sort as sortBy/sortDir but a chain as
      // `sort`, and drops the first level when a chain grows out of a single
      // sort. Keeping one spelling (`sort`) avoids that.
      const params = new URLSearchParams(raw);
      const by = params.get("sortBy");
      if (by) {
        params.set("sort", `${by}:${params.get("sortDir") ?? "asc"}`);
        params.delete("sortBy");
        params.delete("sortDir");
      }
      const next = params.toString();
      if (next === search) return;
      search = next;
      try {
        const keep = new URLSearchParams();
        new URLSearchParams(next).forEach((v, k) => {
          if (PERSISTED.has(k)) keep.set(k, v);
        });
        const out = keep.toString();
        if (out) window.localStorage.setItem(key, out);
        else window.localStorage.removeItem(key);
      } catch {
        /* storage blocked or full */
      }
      subs.forEach((fn) => fn());
    },
    subscribe(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
  };
}

// ── Styling ─────────────────────────────────────────────────────────────────

// The preset is sized for a page-level table; every surface here runs a notch
// smaller. Each entry appends to the preset (the map merges per key).
const CLASS_NAMES = {
  root: cn(shadcnClassNames.root, "text-xs shadow-none"),
  toolbar: cn(shadcnClassNames.toolbar, "gap-1.5 p-1.5"),
  searchField: cn(shadcnClassNames.searchField, "h-7 px-2"),
  search: cn(shadcnClassNames.search, "text-xs"),
  filtersButton: cn(shadcnClassNames.filtersButton, "h-7 px-2 text-xs"),
  columnMenuButton: cn(shadcnClassNames.columnMenuButton, "h-7 px-2 text-xs"),
  exportCsvButton: cn(shadcnClassNames.exportCsvButton, "h-7 px-2 text-xs"),
  table: cn(shadcnClassNames.table, "text-xs"),
  footer: cn(shadcnClassNames.footer, "p-1.5 text-xs"),
  pageNumber: cn(shadcnClassNames.pageNumber, "h-6 min-w-6 text-xs"),
  rowsPerPage: cn(shadcnClassNames.rowsPerPage, "h-7 text-xs"),
  empty: cn(shadcnClassNames.empty, "py-6 text-xs"),
  filterHeaderMenu: cn(shadcnClassNames.filterHeaderMenu, "text-xs"),
  filterChecklistSearch: cn(shadcnClassNames.filterChecklistSearch, "h-7 text-xs"),
  filterCheckbox: cn(shadcnClassNames.filterCheckbox, "px-2 py-0.5 text-[11px]"),
  columnMenuPanel: cn(shadcnClassNames.columnMenuPanel, "text-xs"),
  columnMenuLabel: cn(shadcnClassNames.columnMenuLabel, "text-xs"),
  columnMenuSearch: cn(shadcnClassNames.columnMenuSearch, "h-7 text-xs"),
};

const noopSubscribe = () => () => {};

// ── Component ───────────────────────────────────────────────────────────────

const MAX_CHECKLIST = 50;

const ROW = Symbol("row");
/** What the library sees per row; see the `data` memo in GridInner. */
type Wrapped<T> = { readonly id: string; readonly [ROW]: T; search: string };

export function DataGrid<T>({
  id,
  columns,
  rows,
  rowKey,
  toolbarExtra,
  renderRowDetail,
  onRowClick,
  maxHeight,
  pageSize = 50,
  initialSort,
  emptyText = "No rows",
  searchPlaceholder = "Search…",
  csvName,
  searchable = true,
  rowClassName,
  className,
  style,
}: DataGridProps<T>) {
  // Saved layouts live in localStorage, which the static prerender cannot read,
  // so the table mounts on the client only — no hydration mismatch.
  const mounted = useSyncExternalStore(noopSubscribe, () => true, () => false);
  if (!mounted) return <div className={cn("h-24 rounded-md border bg-card", className)} style={style} />;
  return (
    <GridInner
      id={id}
      columns={columns}
      rows={rows}
      rowKey={rowKey}
      toolbarExtra={toolbarExtra}
      renderRowDetail={renderRowDetail}
      onRowClick={onRowClick}
      maxHeight={maxHeight}
      pageSize={pageSize}
      initialSort={initialSort}
      emptyText={emptyText}
      searchPlaceholder={searchPlaceholder}
      csvName={csvName}
      searchable={searchable}
      rowClassName={rowClassName}
      className={className}
      style={style}
    />
  );
}

function GridInner<T>({
  id,
  columns,
  rows,
  rowKey,
  toolbarExtra,
  renderRowDetail,
  onRowClick,
  maxHeight,
  pageSize,
  initialSort,
  emptyText,
  searchPlaceholder,
  csvName,
  searchable,
  rowClassName,
  className,
  style,
}: Required<Pick<DataGridProps<T>, "id" | "columns" | "rows" | "pageSize" | "emptyText" | "searchPlaceholder" | "searchable">> &
  Omit<DataGridProps<T>, "pageSize" | "emptyText" | "searchPlaceholder" | "searchable">) {
  const initialSortKey = initialSort ? `${initialSort.key}:${initialSort.dir ?? "asc"}` : "";
  const adapter = useMemo(
    () => layoutAdapter(id, initialSortKey ? new URLSearchParams({ sort: initialSortKey }).toString() : ""),
    [id, initialSortKey]
  );

  // The library caches each row's search text under `row.id` (it never sees
  // our rowKey), so rows without a unique `id` all shared the first row's
  // text and search missed nearly everything. Each row goes in wrapped: a
  // hidden unique `id`, the original under a symbol, and one enumerable
  // `search` string — the row's own values plus every column's text (so
  // hidden and computed columns are searchable too).
  const data = useMemo<Wrapped<T>[]>(() => {
    const texts = columns
      .filter((c) => c.kind !== "none")
      .map((c) => {
        const read = c.value ?? ((row: T) => (row as Record<string, unknown>)[c.key]);
        return (row: T) => (c.kind === "date" ? dateText(read(row)) : gridText(read(row)));
      });
    return rows.map((row, i) => {
      const own = row && typeof row === "object" ? Object.values(row).map(gridText) : [gridText(row)];
      const w = { search: [...own, ...texts.map((t) => t(row))].join(" ") } as Wrapped<T>;
      Object.defineProperty(w, "id", { value: rowKey ? rowKey(row, i) : String(i), enumerable: false });
      Object.defineProperty(w, ROW, { value: row, enumerable: false });
      return w;
    });
  }, [rows, rowKey, columns]);

  const defs = useMemo<ColumnDef<Wrapped<T>>[]>(() => {
    return columns.map((col) => {
      const kind = col.kind ?? "text";
      const readRaw = col.value ?? ((row: T) => (row as Record<string, unknown>)[col.key]);
      const read = (w: Wrapped<T>) => readRaw(w[ROW]);
      const label = col.label ?? col.key;
      const interactive = kind !== "none";
      const truncate = col.truncate ?? kind === "text";

      let sortValue: ((row: Wrapped<T>) => string | number | boolean | null) | undefined;
      let filter: ColumnDef<Wrapped<T>>["filter"];
      if (interactive) {
        if (kind === "number") {
          sortValue = (row) => {
            const v = read(row);
            const n = typeof v === "number" ? v : v === null || v === undefined || v === "" ? NaN : Number(v);
            return Number.isFinite(n) ? n : null;
          };
          filter = { type: "numberRange", getValue: sortValue };
        } else if (kind === "date") {
          sortValue = (row) => toMs(read(row));
          filter = { type: "dateRange", getValue: (row) => toMs(read(row)) };
        } else if (kind === "boolean") {
          sortValue = (row) => {
            const v = read(row);
            return v === null || v === undefined ? null : v === true || v === "true" ? 1 : 0;
          };
          filter = { type: "boolean", getValue: (row) => read(row) === true || read(row) === "true" };
        } else {
          sortValue = (row) => gridText(read(row)).toLowerCase();
          const distinct = new Set<string>();
          for (const row of rows) {
            distinct.add(gridText(readRaw(row)));
            if (distinct.size > MAX_CHECKLIST) break;
          }
          filter =
            distinct.size <= MAX_CHECKLIST
              ? { type: "checklist", options: "auto", getValue: (row) => gridText(read(row)) }
              : { type: "text", getValue: (row) => gridText(read(row)) };
        }
      }

      const text = (row: Wrapped<T>) => (kind === "date" ? dateText(read(row)) : gridText(read(row)));
      const def: ColumnDef<Wrapped<T>> = {
        key: col.key,
        header: col.header ?? label,
        accessor: (row) =>
          col.render ? col.render(row[ROW]) : <DefaultCell value={read(row)} kind={kind} truncate={truncate} />,
        formatValue: text,
        exportValue: (row) => (kind === "date" ? dateText(read(row)) : read(row)),
        sortable: interactive,
        sortValue,
        filter,
        width: col.width,
        minWidth: col.minWidth ?? (interactive ? 72 : 32),
        align: col.align ?? (kind === "number" ? "end" : undefined),
        lockPosition: col.locked,
        lockVisibility: col.locked,
      };
      if (truncate) def.maxWidth = (col.maxWidthRem ?? 24) * 16;
      return def;
    });
    // `rows` only feeds the checklist-vs-text cardinality guess.
  }, [columns, rows]);

  const defaultColumnLayout = useMemo(() => {
    const hidden = columns.filter((c) => c.hidden).map((c) => c.key);
    return hidden.length ? { hidden } : undefined;
  }, [columns]);
  const { layout, onLayoutChange } = useColumnLayoutStorageState({
    storageKey: LAYOUT_PREFIX + id,
    storage: safeStorage,
    defaultColumnLayout,
  });

  // Stateless factories — a fresh array per render would rebuild the feature host.
  const features = useMemo(
    () => [
      headerFilters<Wrapped<T>>(),
      columnMenu<Wrapped<T>>(),
      resizableColumns<Wrapped<T>>(),
      multiSort<Wrapped<T>>(),
      exportCsv<Wrapped<T>>({ filename: `${csvName ?? id}.csv`, scope: "all", columns: "visible" }),
    ],
    [csvName, id]
  );

  const defaults = useMemo(() => ({ limit: pageSize }), [pageSize]);

  // The header filter popups are <details> elements the library leaves open on
  // an outside click. Close them here on outside pointerdown or Escape; setting
  // `open` fires `toggle`, which keeps the library's state in step.
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const openPopups = () =>
      Array.from(rootRef.current?.querySelectorAll<HTMLDetailsElement>("details[open]") ?? []);
    const onDown = (e: PointerEvent) => {
      for (const d of openPopups()) if (!d.contains(e.target as Node)) d.open = false;
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") for (const d of openPopups()) d.open = false;
    };
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("keydown", onKey);
    };
  }, []);

  return (
    <div ref={rootRef} className={cn("min-w-0", className)} style={style}>
      <DataTable
        columns={defs}
        data={data}
        rowKey={(row) => row.id}
        urlAdapter={adapter}
        urlSync
        defaults={defaults}
        columnLayout={layout}
        onColumnLayoutChange={onLayoutChange}
        filtersMode="header"
        features={features}
        density="compact"
        classNames={CLASS_NAMES}
        searchable={searchable}
        searchPlaceholder={searchPlaceholder}
        toolbar={toolbarExtra}
        renderRowDetail={renderRowDetail && ((row) => renderRowDetail(row[ROW]))}
        onRowClick={onRowClick && ((row) => onRowClick(row[ROW]))}
        rowClassName={rowClassName && ((row, i) => rowClassName(row[ROW], i))}
        maxHeight={maxHeight}
        stickyHeader
        stickyToolbar={false}
        forceMobile={false}
        labels={{ noData: emptyText, noResults: "No rows match" }}
      />
    </div>
  );
}

// ── Column builders ─────────────────────────────────────────────────────────

export type FieldLike = { name: string; baseType?: string };

/** Columns from an InfoTable-style field list (baseType picks the kind). */
export function columnsFromFields<T extends Record<string, unknown>>(
  fields: readonly FieldLike[],
  rows?: readonly T[]
): GridColumn<T>[] {
  return fields.map((f) => {
    let kind = fieldKind(f.baseType);
    if (!f.baseType && rows) kind = inferKind(rows.slice(0, 50).map((r) => r[f.name]));
    return { key: f.name, label: f.name, kind, value: (row: T) => row[f.name] };
  });
}

/** Columns from an array of plain records: keys in first-seen order, kinds inferred. */
export function columnsFromRecords<T extends Record<string, unknown>>(rows: readonly T[]): GridColumn<T>[] {
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const row of rows.slice(0, 200)) {
    for (const k of Object.keys(row)) {
      if (!seen.has(k)) {
        seen.add(k);
        keys.push(k);
      }
    }
  }
  return columnsFromFields(
    keys.map((name) => ({ name })),
    rows
  );
}
