"use client";

import {
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type ColumnFiltersState,
  type ColumnOrderState,
  type FilterFn,
  type Row,
  type SortingState,
  type VisibilityState,
} from "@tanstack/react-table";
import {
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  MouseSensor,
  PointerSensor,
  TouchSensor,
  closestCenter,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  horizontalListSortingStrategy,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { restrictToHorizontalAxis, restrictToVerticalAxis } from "@dnd-kit/modifiers";
import { CSS } from "@dnd-kit/utilities";
import { useState, useCallback, useMemo, useRef, useEffect } from "react";
import {
  IconChevronUp,
  IconChevronDown,
  IconSelector,
  IconFilter,
  IconColumns,
  IconChevronLeft,
  IconChevronRight,
  IconGripVertical,
  IconRestore,
} from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";

// Custom filter fn: column value must be in the selected array
const arrayIncludesFilterFn: FilterFn<Record<string, unknown>> = (row, columnId, filterValue: string[]) => {
  if (!filterValue || filterValue.length === 0) return true;
  const cell = row.getValue(columnId);
  return filterValue.includes(cell == null ? "" : String(cell));
};
arrayIncludesFilterFn.autoRemove = (val: unknown) => !val || (val as string[]).length === 0;

// ── Draggable header cell ─────────────────────────────────────────────────────

function DraggableHeader({
  header,
  allRows,
}: {
  header: import("@tanstack/react-table").Header<Record<string, unknown>, unknown>;
  allRows: Row<Record<string, unknown>>[];
}) {
  // Sort and filter state are read off `header`, which TanStack keeps as the
  // same object when they change; memoized, this header would go stale.
  "use no memo";
  const { attributes, isDragging, listeners, setNodeRef, transform } =
    useSortable({ id: header.column.id });

  const colFilterValue = (header.column.getFilterValue() as string[] | undefined) ?? [];
  const isFiltered = colFilterValue.length > 0;
  const [filterOpen, setFilterOpen] = useState(false);
  const [search, setSearch] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);

  // Compute unique values from all rows (unfiltered) for this column
  const uniqueValues = useMemo(() => {
    const vals = allRows.map((row) => {
      const v = row.getValue(header.column.id);
      return v == null ? "" : String(v);
    });
    return Array.from(new Set(vals)).sort((a, b) =>
      a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" })
    );
  }, [allRows, header.column.id]);

  const visibleValues = useMemo(() => {
    if (!search.trim()) return uniqueValues;
    const q = search.toLowerCase();
    return uniqueValues.filter((v) => v.toLowerCase().includes(q));
  }, [uniqueValues, search]);

  const allVisibleSelected =
    visibleValues.length > 0 && visibleValues.every((v) => colFilterValue.includes(v));
  const someVisibleSelected = visibleValues.some((v) => colFilterValue.includes(v));

  const toggleValue = (value: string) => {
    const next = colFilterValue.includes(value)
      ? colFilterValue.filter((v) => v !== value)
      : [...colFilterValue, value];
    header.column.setFilterValue(next.length ? next : undefined);
  };

  const toggleAll = () => {
    if (allVisibleSelected) {
      const next = colFilterValue.filter((v) => !visibleValues.includes(v));
      header.column.setFilterValue(next.length ? next : undefined);
    } else {
      const next = Array.from(new Set([...colFilterValue, ...visibleValues]));
      header.column.setFilterValue(next.length ? next : undefined);
    }
  };

  // Plain columns — the tick box, a row number — carry no drag/sort/filter
  // chrome. Every hook above has already run, so the early return is safe.
  const isSelect = header.column.id === "__select__";
  const isPlain =
    isSelect || (header.column.columnDef.meta as { plain?: boolean } | undefined)?.plain === true;
  if (isPlain) {
    return (
      <TableHead
        style={{ width: header.getSize() }}
        className="text-xs sticky top-0 bg-background z-10 p-0"
      >
        <div className={cn("flex items-center px-2 py-2", isSelect ? "justify-center" : "")}>
          {flexRender(header.column.columnDef.header, header.getContext())}
        </div>
      </TableHead>
    );
  }

  return (
    <TableHead
      style={{ width: header.getSize(), position: "relative", whiteSpace: "nowrap" }}
      className="text-xs sticky top-0 bg-background z-10 select-none overflow-visible p-0"
    >
      <div
        ref={setNodeRef}
        style={{
          transform: CSS.Translate.toString(transform),
          transition: isDragging ? undefined : "transform 0.2s",
          opacity: isDragging ? 0.8 : 1,
        }}
        className="flex items-center gap-1 px-3 py-2"
      >
        {/* drag grip */}
        <span
          {...attributes}
          {...listeners}
          className="cursor-grab active:cursor-grabbing text-muted-foreground hover:text-foreground shrink-0"
          title="Drag to reorder"
        >
          <IconGripVertical className="size-3" />
        </span>

        {/* column name */}
        <span className="truncate flex-1 min-w-0">
          {flexRender(header.column.columnDef.header, header.getContext())}
        </span>

        {/* sort button */}
        {header.column.getCanSort() && (
          <button
            onClick={header.column.getToggleSortingHandler()}
            className="shrink-0 text-muted-foreground hover:text-foreground"
            title="Sort"
          >
            {header.column.getIsSorted() === "asc" ? (
              <IconChevronUp className="size-3" />
            ) : header.column.getIsSorted() === "desc" ? (
              <IconChevronDown className="size-3" />
            ) : (
              <IconSelector className="size-3 opacity-40" />
            )}
          </button>
        )}

        {/* Excel-style filter popover */}
        {header.column.getCanFilter() && (
          <Popover open={filterOpen} onOpenChange={(open) => { setFilterOpen(open); if (!open) setSearch(""); }}>
            <PopoverTrigger
              render={
                <button
                  className={cn(
                    "shrink-0 hover:text-foreground",
                    isFiltered ? "text-primary" : "text-muted-foreground"
                  )}
                  title="Filter this column"
                />
              }
            >
              <IconFilter className="size-3" />
            </PopoverTrigger>
            <PopoverContent
              className="w-56 p-0 flex flex-col"
              align="start"
              style={{ maxHeight: "320px" }}
            >
              {/* Search box */}
              <div className="p-2 border-b">
                <Input
                  ref={searchRef}
                  autoFocus
                  placeholder="Search…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="h-7 text-xs"
                />
              </div>

              {/* Select All row */}
              <div className="px-2 py-1 border-b">
                <label className="flex items-center gap-2 cursor-pointer text-xs text-muted-foreground hover:text-foreground select-none">
                  <Checkbox
                    checked={allVisibleSelected}
                    data-indeterminate={someVisibleSelected && !allVisibleSelected ? "" : undefined}
                    onCheckedChange={toggleAll}
                    className="size-3.5"
                  />
                  <span>(Select All)</span>
                  <span className="ml-auto text-[10px] opacity-50">{visibleValues.length}</span>
                </label>
              </div>

              {/* Unique values list */}
              <div className="overflow-y-auto" style={{ maxHeight: "200px" }}>
                {visibleValues.length === 0 ? (
                  <p className="px-3 py-2 text-xs text-muted-foreground">No matches</p>
                ) : (
                  visibleValues.map((val) => (
                    <label
                      key={val}
                      className="flex items-center gap-2 px-2 py-1 cursor-pointer text-xs hover:bg-accent select-none"
                    >
                      <Checkbox
                        checked={colFilterValue.includes(val)}
                        onCheckedChange={() => toggleValue(val)}
                        className="size-3.5"
                      />
                      <span className="truncate">{val === "" ? <em className="opacity-50">(blank)</em> : val}</span>
                    </label>
                  ))
                )}
              </div>

              {/* Footer */}
              {isFiltered && (
                <div className="p-2 border-t">
                  <button
                    onClick={() => header.column.setFilterValue(undefined)}
                    className="text-xs text-muted-foreground hover:text-foreground w-full text-left"
                  >
                    Clear filter ({colFilterValue.length} selected)
                  </button>
                </div>
              )}
            </PopoverContent>
          </Popover>
        )}
      </div>

      {/* resize handle */}
      {header.column.getCanResize() && (
        <div
          onMouseDown={header.getResizeHandler()}
          onTouchStart={header.getResizeHandler()}
          className={cn(
            "absolute right-0 top-0 h-full w-1.5 cursor-col-resize select-none touch-none",
            "hover:bg-primary/40",
            header.column.getIsResizing() && "bg-primary"
          )}
        />
      )}
    </TableHead>
  );
}

// ── Columns menu: reorder + visibility ───────────────────────────────────────

type AnyColumn = import("@tanstack/react-table").Column<Record<string, unknown>, unknown>;

function columnLabel(col: AnyColumn) {
  // A rendered header can be any element — only a plain string is usable as a
  // label here, so fall back to the id.
  return typeof col.columnDef.header === "string" ? col.columnDef.header : col.id;
}

function SortableColumnItem({
  col,
  index,
  visible,
  dragDisabled,
}: {
  col: AnyColumn;
  index: number;
  /**
   * Passed in rather than read from `col.getIsVisible()` here: TanStack keeps
   * the same `col` object when visibility changes, so the React Compiler
   * would memoize this row and the checkbox would never update.
   */
  visible: boolean;
  dragDisabled: boolean;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: col.id, disabled: dragDisabled });

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn(
        "group flex items-center gap-1.5 pl-1 pr-2 h-7 rounded-md text-xs select-none",
        "hover:bg-accent hover:text-accent-foreground",
        isDragging && "relative z-10 bg-accent shadow-md ring-1 ring-border"
      )}
    >
      <span
        {...attributes}
        {...listeners}
        className={cn(
          "shrink-0 p-0.5 rounded text-muted-foreground",
          dragDisabled
            ? "opacity-30 cursor-not-allowed"
            : "cursor-grab active:cursor-grabbing hover:text-foreground"
        )}
        title={dragDisabled ? "Clear the search to reorder" : "Drag to reorder"}
      >
        <IconGripVertical className="size-3.5" />
      </span>
      <label className="flex items-center gap-2 flex-1 min-w-0 cursor-pointer">
        <Checkbox
          checked={visible}
          onCheckedChange={(v) => col.toggleVisibility(!!v)}
          className="size-3.5 shrink-0"
        />
        <span className={cn("truncate", !visible && "text-muted-foreground line-through")}>
          {columnLabel(col)}
        </span>
      </label>
      <span className="shrink-0 w-5 text-right text-[10px] tabular-nums text-muted-foreground/60">
        {index + 1}
      </span>
    </div>
  );
}

function ColumnsMenu({
  columns,
  onReorder,
  onReset,
}: {
  /** Hideable columns, already in current display order. */
  columns: AnyColumn[];
  onReorder: (activeId: string, overId: string) => void;
  onReset: () => void;
}) {
  const [search, setSearch] = useState("");
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const q = search.trim().toLowerCase();
  const shown = q
    ? columns.filter((c) => columnLabel(c).toLowerCase().includes(q))
    : columns;
  const visibleCount = columns.filter((c) => c.getIsVisible()).length;

  const handleDragEnd = (e: DragEndEvent) => {
    if (e.over && e.active.id !== e.over.id) {
      onReorder(String(e.active.id), String(e.over.id));
    }
  };

  return (
    <Popover onOpenChange={(open) => { if (!open) setSearch(""); }}>
      <PopoverTrigger render={<Button variant="outline" size="xs" className="h-7 text-xs gap-1" />}>
        <IconColumns className="size-3.5" />
        Columns
        {visibleCount < columns.length && (
          <span className="ml-0.5 text-[10px] tabular-nums text-muted-foreground">
            {visibleCount}/{columns.length}
          </span>
        )}
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 p-0 gap-0 flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-3 pt-2.5 pb-1.5">
          <span className="text-xs font-medium">Columns</span>
          <span className="text-[10px] tabular-nums text-muted-foreground">
            {visibleCount} of {columns.length} shown
          </span>
        </div>
        <div className="px-2 pb-2 border-b">
          <Input
            autoFocus
            placeholder="Search columns…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-7 text-xs"
          />
        </div>

        {/* Sortable list */}
        <div className="overflow-y-auto p-1" style={{ maxHeight: 300 }}>
          {shown.length === 0 ? (
            <p className="px-3 py-2 text-xs text-muted-foreground">No matches</p>
          ) : (
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              modifiers={[restrictToVerticalAxis]}
              onDragEnd={handleDragEnd}
            >
              <SortableContext items={shown.map((c) => c.id)} strategy={verticalListSortingStrategy}>
                {shown.map((col) => (
                  <SortableColumnItem
                    key={col.id}
                    col={col}
                    index={columns.indexOf(col)}
                    visible={col.getIsVisible()}
                    dragDisabled={!!q}
                  />
                ))}
              </SortableContext>
            </DndContext>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center gap-1 p-1.5 border-t">
          <Button
            variant="ghost"
            size="xs"
            className="h-6 text-xs"
            disabled={visibleCount === columns.length}
            onClick={() => columns.forEach((c) => c.toggleVisibility(true))}
          >
            Show all
          </Button>
          <Button
            variant="ghost"
            size="xs"
            className="h-6 text-xs"
            disabled={visibleCount <= 1}
            onClick={() => columns.forEach((c, i) => c.toggleVisibility(i === 0))}
          >
            Hide all
          </Button>
          <Button
            variant="ghost"
            size="xs"
            className="h-6 text-xs ml-auto gap-1"
            onClick={onReset}
            title="Restore original order and show all columns"
          >
            <IconRestore className="size-3" />
            Reset
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

// ── Main DataTable ────────────────────────────────────────────────────────────

interface DataTableProps<TData, TValue> {
  columns: ColumnDef<TData, TValue>[];
  data: TData[];
  filterPlaceholder?: string;
  enablePagination?: boolean;
  pageSizeOptions?: number[];
  className?: string;
  enableRowSelection?: boolean;
  onSelectedRowsChange?: (rows: TData[]) => void;
  onCellClick?: (value: unknown, columnId: string, row: TData) => void;
  /**
   * Controlled row selection, keyed by row id — the row's index in `data` unless
   * a custom id is set. Pass it with `onRowSelectionChange` when the ticked rows
   * also have to be readable, or clearable, from outside the table.
   */
  rowSelection?: Record<string, boolean>;
  onRowSelectionChange?: (next: Record<string, boolean>) => void;
}

const DEFAULT_PAGE_SIZE_OPTIONS = [25, 50, 100, 250];

export function DataTable<TData, TValue>({
  columns,
  data,
  filterPlaceholder = "Filter…",
  enablePagination: initialEnablePagination = true,
  pageSizeOptions = DEFAULT_PAGE_SIZE_OPTIONS,
  className,
  enableRowSelection,
  onSelectedRowsChange,
  onCellClick,
  rowSelection: controlledRowSelection,
  onRowSelectionChange,
}: DataTableProps<TData, TValue>) {
  const selectionColumn = useMemo<ColumnDef<Record<string, unknown>>>(() => ({
    id: "__select__",
    header: ({ table }) => (
      <Checkbox
        checked={table.getIsAllPageRowsSelected()}
        data-indeterminate={
          table.getIsSomePageRowsSelected() && !table.getIsAllPageRowsSelected() ? "" : undefined
        }
        onCheckedChange={(v) => table.toggleAllPageRowsSelected(!!v)}
        className="size-3.5"
      />
    ),
    cell: ({ row }) => (
      <Checkbox
        checked={row.getIsSelected()}
        onCheckedChange={(v) => row.toggleSelected(!!v)}
        className="size-3.5"
      />
    ),
    enableSorting: false,
    enableResizing: false,
    enableHiding: false,
    size: 36,
  }), []);

  const effectiveColumns = useMemo(
    () => enableRowSelection
      ? [selectionColumn, ...(columns as unknown as ColumnDef<Record<string, unknown>>[]) ]
      : columns as unknown as ColumnDef<Record<string, unknown>>[],
    [enableRowSelection, columns, selectionColumn]
  );

  const [ownRowSelection, setOwnRowSelection] = useState<Record<string, boolean>>({});
  const rowSelection = controlledRowSelection ?? ownRowSelection;
  const setRowSelection = useCallback(
    (updater: Record<string, boolean> | ((old: Record<string, boolean>) => Record<string, boolean>)) => {
      const next = typeof updater === "function" ? updater(rowSelection) : updater;
      if (onRowSelectionChange) onRowSelectionChange(next);
      if (!controlledRowSelection) setOwnRowSelection(next);
    },
    [controlledRowSelection, onRowSelectionChange, rowSelection]
  );
  const [sorting, setSorting] = useState<SortingState>([]);
  const [globalFilter, setGlobalFilter] = useState("");
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([]);
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>({});
  const [columnOrder, setColumnOrder] = useState<ColumnOrderState>(
    () => effectiveColumns.map((c) => (c as { id?: string; accessorKey?: string }).id ?? (c as { accessorKey?: string }).accessorKey ?? "")
  );
  const [paginationEnabled, setPaginationEnabled] = useState(initialEnablePagination);
  const [pagination, setPagination] = useState({ pageIndex: 0, pageSize: pageSizeOptions[1] ?? 50 });

  // eslint-disable-next-line react-hooks/incompatible-library
  const table = useReactTable({
    data: data as Record<string, unknown>[],
    columns: effectiveColumns,
    state: {
      sorting,
      globalFilter,
      columnFilters,
      columnVisibility,
      columnOrder,
      rowSelection,
      pagination: paginationEnabled ? pagination : { pageIndex: 0, pageSize: Math.max(data.length, 1) },
    },
    onSortingChange: setSorting,
    onGlobalFilterChange: setGlobalFilter,
    onColumnFiltersChange: setColumnFilters,
    onColumnVisibilityChange: setColumnVisibility,
    onColumnOrderChange: setColumnOrder,
    onPaginationChange: setPagination,
    onRowSelectionChange: setRowSelection,
    enableRowSelection: !!enableRowSelection,
    defaultColumn: { filterFn: arrayIncludesFilterFn },
    getColumnCanGlobalFilter: (column) =>
      column.id !== "__select__" && (column.columnDef.enableGlobalFilter ?? true),
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    enableColumnResizing: true,
    columnResizeMode: "onChange",
  } as Parameters<typeof useReactTable>[0]);

  useEffect(() => {
    if (!onSelectedRowsChange) return;
    const selected = table.getSelectedRowModel().rows.map((r) => r.original as TData);
    onSelectedRowsChange(selected);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rowSelection]);

  const sensors = useSensors(
    useSensor(MouseSensor, {}),
    useSensor(TouchSensor, {}),
    useSensor(KeyboardSensor, {})
  );

  const defaultOrder = useMemo(
    () => effectiveColumns.map((c) => (c as { id?: string; accessorKey?: string }).id ?? (c as { accessorKey?: string }).accessorKey ?? ""),
    [effectiveColumns]
  );

  // Move one column to another's slot. The stored order may predate columns
  // added later (dynamic data), so normalise it against the live ids first.
  const moveColumn = useCallback((activeId: string, overId: string) => {
    setColumnOrder((prev) => {
      const live = new Set(defaultOrder);
      const full = [
        ...prev.filter((id) => live.has(id)),
        ...defaultOrder.filter((id) => !prev.includes(id)),
      ];
      const oldIdx = full.indexOf(activeId);
      const newIdx = full.indexOf(overId);
      if (oldIdx < 0 || newIdx < 0) return prev;
      return arrayMove(full, oldIdx, newIdx);
    });
  }, [defaultOrder]);

  const resetColumns = useCallback(() => {
    setColumnOrder(defaultOrder);
    setColumnVisibility({});
  }, [defaultOrder]);

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    const { active, over } = event;
    if (active && over && active.id !== over.id) {
      moveColumn(String(active.id), String(over.id));
    }
  }, [moveColumn]);

  const visibleColumnIds = useMemo(
    () => table.getVisibleLeafColumns().map((c) => c.id),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [table.getState().columnVisibility, table.getState().columnOrder]
  );

  // Hideable columns in current display order (unknown ids sort last).
  const rank = (id: string) => {
    const i = columnOrder.indexOf(id);
    return i < 0 ? Number.MAX_SAFE_INTEGER : i;
  };
  const menuColumns = (table.getAllLeafColumns() as unknown as AnyColumn[])
    .filter((col) => col.getCanHide())
    .sort((a, b) => rank(a.id) - rank(b.id));

  const filteredCount = table.getFilteredRowModel().rows.length;
  const pageCount = table.getPageCount();

  return (
    <div className={cn("flex flex-col h-full min-w-0 w-full gap-1.5", className)}>
      {/* ── Toolbar ── */}
      <div className="px-2 pt-2 flex items-center gap-2 flex-wrap shrink-0">
        <Input
          placeholder={filterPlaceholder}
          value={globalFilter}
          onChange={(e) => setGlobalFilter(e.target.value)}
          className="h-7 text-xs w-48"
        />

        {/* Column order + visibility */}
        <ColumnsMenu
          columns={menuColumns}
          onReorder={moveColumn}
          onReset={resetColumns}
        />

        {/* Pagination toggle */}
        <Button
          variant={paginationEnabled ? "outline" : "secondary"}
          size="xs"
          className="h-7 text-xs"
          onClick={() => {
            setPaginationEnabled((v) => !v);
            setPagination((p) => ({ ...p, pageIndex: 0 }));
          }}
        >
          {paginationEnabled ? "All rows" : "Paginated"}
        </Button>
      </div>

      {/* ── Table ── */}
      <div className="flex-1 min-h-0 min-w-0 overflow-auto">
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          modifiers={[restrictToHorizontalAxis]}
          onDragEnd={handleDragEnd}
        >
          <table className="w-max min-w-full caption-bottom text-xs border-separate border-spacing-0">
            <TableHeader>
              {table.getHeaderGroups().map((hg) => (
                <SortableContext
                  key={hg.id}
                  items={visibleColumnIds}
                  strategy={horizontalListSortingStrategy}
                >
                  <TableRow>
                    {hg.headers.map((header) => (
                      <DraggableHeader key={header.id} header={header as import("@tanstack/react-table").Header<Record<string, unknown>, unknown>} allRows={table.getCoreRowModel().rows as Row<Record<string, unknown>>[]} />
                    ))}
                  </TableRow>
                </SortableContext>
              ))}
            </TableHeader>
            <TableBody>
              {table.getRowModel().rows.length > 0 ? (
                table.getRowModel().rows.map((row) => (
                  <TableRow key={row.id}>
                    {row.getVisibleCells().map((cell) => {
                      const isSelectCell = cell.column.id === "__select__";
                      return (
                        <TableCell
                          key={cell.id}
                          style={{ width: cell.column.getSize() }}
                          className={cn(
                            "text-xs font-mono whitespace-nowrap",
                            onCellClick && !isSelectCell && "cursor-pointer hover:bg-primary/10"
                          )}
                          onClick={
                            onCellClick && !isSelectCell
                              ? () => onCellClick(cell.getValue(), cell.column.id, row.original as TData)
                              : undefined
                          }
                        >
                          {flexRender(cell.column.columnDef.cell, cell.getContext())}
                        </TableCell>
                      );
                    })}
                  </TableRow>
                ))
              ) : (
                <TableRow>
                  <TableCell
                    colSpan={effectiveColumns.length}
                    className="text-center text-muted-foreground"
                  >
                    No results.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </table>
        </DndContext>
      </div>

      {/* ── Footer ── */}
      <div className="px-2 pb-2 flex items-center justify-between gap-x-4 gap-y-1.5 flex-wrap shrink-0 text-xs text-muted-foreground">
        <span>
          {filteredCount !== data.length
            ? `${filteredCount} of ${data.length} row(s)`
            : `${data.length} row(s)`}
        </span>

        {paginationEnabled && (
          <div className="flex items-center gap-2 flex-wrap">
            <span className="shrink-0">Rows per page</span>
            <Select
              value={String(pagination.pageSize)}
              onValueChange={(v) => {
                setPagination({ pageIndex: 0, pageSize: Number(v) });
              }}
            >
              <SelectTrigger size="sm" className="h-7 w-20 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {pageSizeOptions.map((n) => (
                  <SelectItem key={n} value={String(n)} className="text-xs">
                    {n}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <span className="shrink-0">
              Page {pagination.pageIndex + 1} of {pageCount || 1}
            </span>

            <Button
              variant="outline"
              size="icon-xs"
              className="size-7"
              disabled={!table.getCanPreviousPage()}
              onClick={() => table.previousPage()}
            >
              <IconChevronLeft className="size-3.5" />
            </Button>
            <Button
              variant="outline"
              size="icon-xs"
              className="size-7"
              disabled={!table.getCanNextPage()}
              onClick={() => table.nextPage()}
            >
              <IconChevronRight className="size-3.5" />
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
