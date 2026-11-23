"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAssistantContext } from "@/lib/assistant/context";
import dynamic from "next/dynamic";
import { toast } from "sonner";
import {
  IconTable,
  IconUpload,
  IconClipboard,
  IconTrash,
  IconBraces,
  IconDownload,
  IconAlertTriangle,
  IconCheck,
  IconMessagePlus,
  IconArrowRight,
} from "@tabler/icons-react";

import { useTheme } from "@/components/providers";
import { addPins, usePinnables, type NewPin } from "@/lib/assistant/pins";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { DataTable, shadcnClassNames, type ColumnDef } from "@adapttable/shadcn";
import {
  columnMenu,
  headerFilters,
  multiSort,
  resizableColumns,
} from "@adapttable/shadcn/features";
import { cn } from "@/lib/utils";
import {
  cellText,
  collectTableSources,
  columnsFromRows,
  flattenRow,
  toCsv,
  type TableSource,
} from "@/lib/json-table";
import { clipText, PIN_LIMIT } from "@/lib/assistant/pin-utils";
import { takePendingJson } from "@/lib/json-handoff";

const MonacoEditor = dynamic(() => import("@monaco-editor/react"), {
  ssr: false,
  loading: () => (
    <div className="flex h-full items-center justify-center gap-2 text-xs text-muted-foreground">
      <Spinner className="size-3.5" /> Loading editor…
    </div>
  ),
});

// The adapter's preset is sized for a page-level table — text-sm type and h-9
// controls — while every surface in this app runs a notch smaller. Each entry
// appends to the preset rather than replacing it (the adapter merges this map
// key by key, so a bare string would drop the part's styling wholesale), and
// tailwind-merge keeps only the last utility in each conflicting group.
const CLASS_NAMES = {
  root: cn(
    shadcnClassNames.root,
    // The resizable panel already draws the frame around this.
    "flex h-full min-h-0 flex-col rounded-none border-0 shadow-none"
  ),
  toolbar: cn(shadcnClassNames.toolbar, "gap-1.5 p-2"),
  searchField: cn(shadcnClassNames.searchField, "h-8 px-2"),
  search: cn(shadcnClassNames.search, "text-xs"),
  filtersButton: cn(shadcnClassNames.filtersButton, "h-8 px-2 text-xs"),
  columnMenuButton: cn(shadcnClassNames.columnMenuButton, "h-8 px-2 text-xs"),
  table: cn(shadcnClassNames.table, "text-xs"),
  footer: cn(shadcnClassNames.footer, "p-2 text-xs"),
  pageNumber: cn(shadcnClassNames.pageNumber, "h-7 min-w-7 text-xs"),
  rowsPerPage: cn(shadcnClassNames.rowsPerPage, "h-7 text-xs"),
  empty: cn(shadcnClassNames.empty, "py-8 text-xs"),
  filterHeaderMenu: cn(shadcnClassNames.filterHeaderMenu, "text-xs"),
  filterChecklistSearch: cn(shadcnClassNames.filterChecklistSearch, "h-7 text-xs"),
  filterCheckbox: cn(shadcnClassNames.filterCheckbox, "px-2 py-0.5 text-[11px]"),
  columnMenuPanel: cn(shadcnClassNames.columnMenuPanel, "text-xs"),
  columnMenuLabel: cn(shadcnClassNames.columnMenuLabel, "text-xs"),
  columnMenuSearch: cn(shadcnClassNames.columnMenuSearch, "h-7 text-xs"),
};

// Stateless factories, so one module-level array — a fresh one per render
// would rebuild the table's feature host on every keystroke.
const TABLE_FEATURES = [
  headerFilters<GridRow>(),
  columnMenu<GridRow>(),
  resizableColumns<GridRow>(),
  multiSort<GridRow>(),
];

// The table caches each row's search text under `row.id` and never sees our
// rowKey, so parsed rows (no id, or duplicate ids) all shared one row's text
// and search missed. Each row goes in wrapped: a hidden unique `id`, the
// original under a symbol, and one enumerable `search` string.
const ROW = Symbol("row");
type GridRow = { readonly id: string; readonly [ROW]: Record<string, unknown>; search: string };

const SAMPLE = JSON.stringify(
  {
    dataShape: {
      fieldDefinitions: {
        name: { name: "name", baseType: "STRING", ordinal: 0 },
        thingTemplate: { name: "thingTemplate", baseType: "STRING", ordinal: 1 },
        enabled: { name: "enabled", baseType: "BOOLEAN", ordinal: 2 },
      },
    },
    rows: [
      { name: "Line1.Press", thingTemplate: "PressTemplate", enabled: true },
      { name: "Line1.Oven", thingTemplate: "OvenTemplate", enabled: false },
      { name: "Line2.Press", thingTemplate: "PressTemplate", enabled: true },
    ],
  },
  null,
  2
);

// ── "Add to chat" helpers ────────────────────────────────────────────────────

const PIN_ROWS = 200;


type ParseState =
  | { ok: true; value: unknown }
  | { ok: false; error: string }
  | { ok: null };

export function JsonTableExplorer() {
  const { resolvedTheme } = useTheme();
  const [text, setText] = useState("");
  // JSON handed over from the assistant; read after mount to keep hydration stable.
  useEffect(() => {
    const pending = takePendingJson();
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (pending) setText(pending);
  }, []);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [flatten, setFlatten] = useState(true);
  const fileInput = useRef<HTMLInputElement>(null);

  useAssistantContext({
    screen: "json-table",
    title: "JSON Table",
    summary: text.trim() ? `${text.length} characters of JSON loaded${selectedPath ? `, ${selectedPath} selected` : ""}` : "No JSON loaded",
    data: { chars: text.length, flatten, jsonStart: text.slice(0, 2000) },
    selection: { path: selectedPath ? [selectedPath] : [] },
  });

  const parsed = useMemo<ParseState>(() => {
    const trimmed = text.trim();
    if (!trimmed) return { ok: null };
    try {
      return { ok: true, value: JSON.parse(trimmed) };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }, [text]);

  const sources = useMemo<TableSource[]>(
    () => (parsed.ok === true ? collectTableSources(parsed.value) : []),
    [parsed]
  );

  // The chosen table, falling back to the first candidate whenever the picked
  // path is gone — editing the JSON must never leave the grid pointing nowhere.
  const source = useMemo(
    () => sources.find((s) => s.path === selectedPath) ?? sources[0] ?? null,
    [sources, selectedPath]
  );

  const rows = useMemo(() => {
    if (!source) return [];
    return flatten ? source.rows.map((r) => flattenRow(r)) : source.rows;
  }, [source, flatten]);

  // Flattening renames columns, so the declared infotable order only survives
  // while the rows are left whole.
  const tableColumns = useMemo(
    () => (flatten ? columnsFromRows(rows) : source?.columns ?? []),
    [flatten, rows, source]
  );

  // Parsed JSON carries no ids, so a row's position is its identity. Flattening
  // rebuilds every row object, which makes identity a safe map key and gives
  // the "#" column a number that survives sorting.
  const gridRows = useMemo(
    () =>
      rows.map((row, index) => {
        const w = { search: Object.values(row).map(cellText).join(" ") } as GridRow;
        Object.defineProperty(w, "id", { value: String(index + 1), enumerable: false });
        Object.defineProperty(w, ROW, { value: row, enumerable: false });
        return w;
      }),
    [rows]
  );

  const columns = useMemo<ColumnDef<GridRow>[]>(
    () => [
      {
        key: "__index__",
        header: "#",
        accessor: (row) => <span className="text-muted-foreground">{row.id}</span>,
        formatValue: (row) => row.id,
        width: 52,
        align: "end",
        lockPosition: true,
        lockVisibility: true,
      },
      ...tableColumns.map<ColumnDef<GridRow>>((col) => ({
        key: col.name,
        header: (
          <span className="flex items-center gap-1.5">
            {col.name}
            <span className="text-[9px] font-normal uppercase text-muted-foreground/60">
              {col.baseType}
            </span>
          </span>
        ),
        // Sorted, filtered and searched as rendered text, so nested values are
        // reachable from the search box too. Flattening puts dots in column
        // names, which the table would otherwise read as a path into the row —
        // every reader here goes through the flat key instead.
        accessor: (row) => {
          const value = cellText(row[ROW][col.name]);
          return (
            <span title={value} className="block max-w-96 truncate">
              {value}
            </span>
          );
        },
        formatValue: (row) => cellText(row[ROW][col.name]),
        sortValue: (row) => cellText(row[ROW][col.name]),
        sortable: true,
        filter: { type: "checklist", options: "auto", getValue: (row) => cellText(row[ROW][col.name]) },
        minWidth: 96,
      })),
    ],
    [tableColumns]
  );

  const format = useCallback(() => {
    if (parsed.ok !== true) return;
    setText(JSON.stringify(parsed.value, null, 2));
  }, [parsed]);

  const readFile = useCallback((file: File) => {
    file
      .text()
      .then(setText)
      .catch((e) => toast.error(`Could not read ${file.name}`, { description: String(e) }));
  }, []);

  const pasteFromClipboard = useCallback(async () => {
    try {
      const clip = await navigator.clipboard.readText();
      if (!clip.trim()) {
        toast.error("Clipboard is empty");
        return;
      }
      setText(clip);
    } catch {
      toast.error("Clipboard read was blocked — paste into the editor instead");
    }
  }, []);

  const downloadCsv = useCallback(() => {
    if (!source || !rows.length) return;
    const csv = toCsv(
      tableColumns.map((c) => c.name),
      rows
    );
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "json-table.csv";
    link.click();
    URL.revokeObjectURL(url);
  }, [source, rows, tableColumns]);

  // ── Add to chat: the table (first rows, trimmed) and the JSON source ───────
  // The grid has no row selection, so the table pin is always the first rows.
  const tableLabel = source ? `Table · ${source.path}` : "";

  const tablePin = useCallback((): NewPin | null => {
    if (!source || !rows.length) return null;
    const columns = tableColumns.map((c) => ({ name: c.name, baseType: c.baseType }));
    const kept: Record<string, unknown>[] = [];
    // Budget starts past the columns and a little wrapper overhead.
    let size = JSON.stringify(columns).length + 256;
    for (const r of rows.slice(0, PIN_ROWS)) {
      const n = JSON.stringify(r).length + 2;
      if (size + n > PIN_LIMIT) break;
      size += n;
      kept.push(r);
    }
    const out: Record<string, unknown> = {
      source: source.path,
      columns,
      rowCount: rows.length,
      rowsIncluded: kept.length,
      rows: kept,
    };
    if (rows.length > kept.length) out.note = `${rows.length - kept.length} more rows not included`;
    return {
      kind: "table",
      label: tableLabel,
      screen: "json-table",
      detail: `${tableColumns.length} cols · ${rows.length} rows`,
      content: JSON.stringify(out),
    };
  }, [source, rows, tableColumns, tableLabel]);

  const jsonPin = useCallback((): NewPin | null => {
    if (!text.trim()) return null;
    return {
      kind: "json",
      label: "JSON source",
      screen: "json-table",
      detail: `${text.length.toLocaleString()} chars`,
      content: clipText(text, PIN_LIMIT),
    };
  }, [text]);

  const pinTable = () => {
    const p = tablePin();
    if (p) addPins([p]);
  };
  const pinJson = () => {
    const p = jsonPin();
    if (p) addPins([p]);
  };

  usePinnables([
    ...(source && rows.length
      ? [{ kind: "table", label: tableLabel, detail: `${tableColumns.length} cols · ${rows.length} rows`, content: () => tablePin()?.content ?? "" }]
      : []),
    ...(text.trim()
      ? [{ kind: "json", label: "JSON source", detail: `${text.length.toLocaleString()} chars`, content: () => jsonPin()?.content ?? "" }]
      : []),
  ]);

  return (
    <div className="flex flex-col h-full overflow-hidden bg-background">
      {/* ── Command bar ─────────────────────────────────────────────────────── */}
      <header className="flex items-center justify-between gap-3 px-3 py-2 border-b bg-card shrink-0 flex-wrap">
        <div className="flex items-center gap-2 flex-wrap">
          <div className="flex items-center gap-1.5">
            <IconTable className="size-4 text-primary shrink-0" />
            <span className="inline-flex items-center gap-1 font-semibold text-xs tracking-tight">JSON <IconArrowRight className="size-3" /> Table</span>
          </div>

          <Select
            value={source?.path ?? ""}
            onValueChange={(v) => v && setSelectedPath(v)}
            disabled={sources.length === 0}
          >
            <SelectTrigger className="h-8 w-64 bg-background text-xs font-medium">
              <SelectValue placeholder="No table found…" />
            </SelectTrigger>
            <SelectContent>
              {sources.map((s) => (
                <SelectItem key={s.path} value={s.path}>
                  <span className="flex items-center gap-2">
                    <span className="font-mono text-[11px]">{s.path}</span>
                    <span className="text-[10px] text-muted-foreground">
                      {s.kind === "infotable" ? "InfoTable" : s.kind} · {s.rows.length}
                    </span>
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <div className="flex items-center gap-1.5">
            <Switch id="flatten" checked={flatten} onCheckedChange={(v) => setFlatten(v === true)} />
            <Label htmlFor="flatten" className="text-xs text-muted-foreground">
              Flatten nested
            </Label>
          </div>
        </div>

        <div className="flex items-center gap-1.5 flex-wrap">
          {source && (
            <>
              <Badge variant="secondary" className="h-6 rounded-full px-2 text-[10px] font-medium">
                {source.kind === "infotable" ? "InfoTable" : source.kind}
              </Badge>
              <Badge variant="outline" className="h-6 rounded-full px-2 text-[10px] font-medium">
                {rows.length} rows · {tableColumns.length} cols
              </Badge>
            </>
          )}
          <Button
            variant="outline"
            size="xs"
            className="h-7 gap-1 text-xs"
            onClick={downloadCsv}
            disabled={!rows.length}
          >
            <IconDownload className="size-3.5" />
            CSV
          </Button>
          <Button
            variant="outline"
            size="xs"
            className="h-7 w-7 p-0"
            onClick={pinTable}
            disabled={!rows.length}
            title="Add to chat"
            aria-label="Add table to chat"
          >
            <IconMessagePlus className="size-3.5" />
          </Button>
        </div>
      </header>

      {/* ── Source | Table ──────────────────────────────────────────────────── */}
      <ResizablePanelGroup id="json-table" className="flex-1 min-h-0">
        <ResizablePanel id="source" defaultSize="32%" minSize="18%" className="flex flex-col min-w-0">
          <div className="flex items-center gap-1.5 border-b bg-muted/20 px-2 py-1.5 shrink-0 flex-wrap">
            <span className="text-[11px] font-semibold text-muted-foreground mr-auto">
              JSON source
            </span>
            <input
              ref={fileInput}
              type="file"
              accept=".json,application/json,text/plain"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) readFile(file);
                e.target.value = "";
              }}
            />
            <Button
              variant="ghost"
              size="xs"
              className="h-6 gap-1 text-[11px]"
              onClick={() => fileInput.current?.click()}
            >
              <IconUpload className="size-3.5" />
              File
            </Button>
            <Button
              variant="ghost"
              size="xs"
              className="h-6 gap-1 text-[11px]"
              onClick={pasteFromClipboard}
            >
              <IconClipboard className="size-3.5" />
              Paste
            </Button>
            <Button
              variant="ghost"
              size="xs"
              className="h-6 gap-1 text-[11px]"
              onClick={format}
              disabled={parsed.ok !== true}
            >
              <IconBraces className="size-3.5" />
              Format
            </Button>
            <Button
              variant="ghost"
              size="xs"
              className="h-6 gap-1 text-[11px]"
              onClick={() => setText("")}
              disabled={!text}
            >
              <IconTrash className="size-3.5" />
              Clear
            </Button>
            <Button
              variant="ghost"
              size="xs"
              className="h-6 w-6 p-0"
              onClick={pinJson}
              disabled={!text.trim()}
              title="Add to chat"
              aria-label="Add JSON source to chat"
            >
              <IconMessagePlus className="size-3.5" />
            </Button>
          </div>

          <div
            className="relative flex-1 min-h-0"
            // A dropped file is the fastest way in, and the editor is the
            // obvious place to aim it at. Monaco only claims text drops, so a
            // file still reaches this handler.
            onDragOver={(e) => {
              if (e.dataTransfer.types.includes("Files")) e.preventDefault();
            }}
            onDrop={(e) => {
              const file = e.dataTransfer.files?.[0];
              if (!file) return;
              e.preventDefault();
              readFile(file);
            }}
          >
            <MonacoEditor
              className="min-w-0"
              height="100%"
              language="json"
              value={text}
              theme={resolvedTheme === "dark" ? "vs-dark" : "vs"}
              onChange={(next) => setText(next ?? "")}
              options={{
                minimap: { enabled: false },
                scrollBeyondLastLine: false,
                wordWrap: "on",
                fontSize: 12,
                lineNumbers: "on",
                folding: true,
                tabSize: 2,
                automaticLayout: true,
                renderLineHighlight: "line",
                scrollbar: { verticalScrollbarSize: 8, horizontalScrollbarSize: 8 },
              }}
            />
          </div>

          <div
            className={cn(
              "flex items-start gap-1.5 border-t px-2 py-1.5 text-[11px] shrink-0",
              parsed.ok === false
                ? "bg-destructive/10 text-destructive"
                : "bg-muted/20 text-muted-foreground"
            )}
          >
            {parsed.ok === false ? (
              <>
                <IconAlertTriangle className="size-3.5 shrink-0 mt-px" />
                <span className="break-all">{parsed.error}</span>
              </>
            ) : parsed.ok === true ? (
              <>
                <IconCheck className="size-3.5 shrink-0 mt-px text-success" />
                <span>
                  Valid JSON · {sources.length} table{sources.length === 1 ? "" : "s"} found
                </span>
              </>
            ) : (
              <>
                <span className="mr-auto">Waiting for JSON…</span>
                <button
                  type="button"
                  className="rounded-sm underline underline-offset-2 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/30 focus-visible:outline-none"
                  onClick={() => setText(SAMPLE)}
                >
                  Load sample
                </button>
              </>
            )}
          </div>
        </ResizablePanel>

        <ResizableHandle withHandle />

        <ResizablePanel id="table" defaultSize="68%" minSize="30%" className="flex flex-col min-w-0">
          {source && rows.length ? (
            <DataTable
              // Column order, widths and filters belong to one table shape — a
              // new source or a flatten toggle starts the grid over.
              key={`${source.path}:${flatten}`}
              columns={columns}
              data={gridRows}
              rowKey={(row) => row.id}
              searchPlaceholder="Search all columns…"
              defaults={{ limit: 100 }}
              // The grid is scratch space for whatever was just pasted in, so
              // its state has no business outliving the paste in the address bar.
              urlSync={false}
              filtersMode="header"
              features={TABLE_FEATURES}
              density="compact"
              classNames={CLASS_NAMES}
            />
          ) : (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 text-muted-foreground">
              <IconTable className="size-8 opacity-30" />
              <span className="text-xs">
                {parsed.ok === true
                  ? "No array or InfoTable found in this document"
                  : "Paste JSON on the left to build a table"}
              </span>
            </div>
          )}
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  );
}
