"use client";

import { useState, useMemo, useEffect } from "react";
import type { ServiceParam } from "@/lib/twx/types";
import type { ColumnDef } from "@tanstack/react-table";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import {
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
} from "@/components/ui/tabs";
import { DataTable } from "@/components/ui/data-table";
import { Checkbox } from "@/components/ui/checkbox";

// ── Infotable column helper (shared with InfoTableView) ───────────────────────

function renderCellByType(v: unknown, baseType: string | undefined) {
  if (v === null || v === undefined) return "";

  switch (baseType) {
    case "BOOLEAN": {
      const checked = v === true || v === "true";
      return (
        <div className="flex justify-center">
          <Checkbox checked={checked} disabled className="pointer-events-none" />
        </div>
      );
    }
    case "DATETIME": {
      const d = new Date(v as string | number);
      return isNaN(d.getTime()) ? String(v) : d.toLocaleString();
    }
    case "NUMBER":
    case "INTEGER":
    case "LONG": {
      const n = typeof v === "number" ? v : Number(v);
      return isNaN(n) ? String(v) : <span className="tabular-nums">{n.toLocaleString()}</span>;
    }
    default:
      return typeof v === "object" ? JSON.stringify(v) : String(v);
  }
}

export function infotableColumns(parsed: unknown): {
  columns: ColumnDef<Record<string, unknown>>[];
  rows: Record<string, unknown>[];
  dataShape: unknown;
  columnKeys: string[];
} {
  if (!parsed || typeof parsed !== "object") {
    return { columns: [], rows: [], dataShape: undefined, columnKeys: [] };
  }
  const obj = parsed as Record<string, unknown>;
  const rows = (obj.rows as Record<string, unknown>[]) ?? [];
  const dataShapeObj = obj.dataShape as Record<string, unknown> | undefined;
  const fieldDefs = dataShapeObj?.fieldDefinitions as
    | Record<string, { name: string; baseType?: string; ordinal?: number }>
    | undefined;

  const fieldList = fieldDefs
    ? Object.values(fieldDefs).sort((a, b) => (a.ordinal ?? 0) - (b.ordinal ?? 0))
    : rows.length > 0
    ? Object.keys(rows[0]).map((name) => ({ name, baseType: undefined }))
    : [];

  const columnKeys = fieldList.map((f) => f.name);

  const columns: ColumnDef<Record<string, unknown>>[] = fieldList.map(({ name: key, baseType }) => ({
    id: key,
    accessorKey: key,
    header: key,
    enableResizing: true,
    size: 150,
    cell: ({ getValue }) => renderCellByType(getValue(), baseType),
  }));

  return { columns, rows, dataShape: obj.dataShape, columnKeys };
}

// ── Types ─────────────────────────────────────────────────────────────────────

type PickerPreset = {
  id: number;
  name: string;
  entityName: string;
  serviceName: string;
  output: string;
  outputType: string;
  createdAt: number | null;
};

type OutputSource = {
  label: string;
  outputType: string;
  rawOutput: string;
  entityName?: string;
  serviceName?: string;
  createdAt?: number | null;
  isLive?: boolean;
};

const OBJECT_TYPES = new Set(["INFOTABLE", "JSON", "BLOB"]);

interface OutputValuePickerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  targetParam: ServiceParam;
  presets: PickerPreset[];
  liveOutput: { data: unknown; type: string } | null;
  onPick: (value: string) => void;
}

// ── Component ─────────────────────────────────────────────────────────────────

import { IconDatabase, IconFilter, IconArrowDown, IconSortAscending, IconSortDescending } from "@tabler/icons-react";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";

export function OutputValuePicker({
  open,
  onOpenChange,
  targetParam,
  presets,
  liveOutput,
  onPick,
}: OutputValuePickerProps) {
  const [filterThing, setFilterThing] = useState<string>("__all__");
  const [filterService, setFilterService] = useState<string>("__all__");
  const [sortOrder, setSortOrder] = useState<"newest" | "oldest">("newest");

  const allPresetSources: OutputSource[] = useMemo(() => {
    const sorted = [...presets].sort((a, b) => {
      const ta = a.createdAt ?? 0;
      const tb = b.createdAt ?? 0;
      return sortOrder === "newest" ? tb - ta : ta - tb;
    });
    return sorted
      .filter((p) => p.output)
      .filter((p) => filterThing === "__all__" || p.entityName === filterThing)
      .filter((p) => filterService === "__all__" || p.serviceName === filterService)
      .map((p) => ({
        label: p.name,
        outputType: p.outputType,
        rawOutput: p.output,
        entityName: p.entityName,
        serviceName: p.serviceName,
        createdAt: p.createdAt,
        isLive: false,
      }));
  }, [presets, filterThing, filterService, sortOrder]);

  const sources: OutputSource[] = useMemo(() => {
    const result: OutputSource[] = [];
    if (liveOutput !== null) {
      result.push({
        label: "Current Live Output",
        outputType: liveOutput.type,
        rawOutput: JSON.stringify(liveOutput.data),
        isLive: true,
      });
    }
    result.push(...allPresetSources);
    return result;
  }, [liveOutput, allPresetSources]);

  const distinctThings = useMemo(() =>
    [...new Set(presets.filter((p) => p.output).map((p) => p.entityName))].sort(),
    [presets]
  );
  const distinctServices = useMemo(() =>
    [...new Set(presets.filter((p) => p.output).map((p) => p.serviceName))].sort(),
    [presets]
  );

  const [selectedSourceIdx, setSelectedSourceIdx] = useState("0");
  const [selectedRows, setSelectedRows] = useState<Record<string, unknown>[]>([]);
  const [pickTab, setPickTab] = useState<"rows" | "column">("rows");

  useEffect(() => {
    if (open) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setSelectedSourceIdx("0");
      setSelectedRows([]);
      setPickTab("rows");
      setFilterThing("__all__");
      setFilterService("__all__");
      setSortOrder("newest");
    }
  }, [open]);

  // Reset selected source when filters change
  const filterKey = `${filterThing}|${filterService}|${sortOrder}`;
  const [prevFilterKey, setPrevFilterKey] = useState(filterKey);
  if (prevFilterKey !== filterKey) {
    setPrevFilterKey(filterKey);
    setSelectedSourceIdx("0");
    setSelectedRows([]);
  }

  const selectedSource = sources[parseInt(selectedSourceIdx)] ?? sources[0];

  const parsedOutput = useMemo(() => {
    if (!selectedSource?.rawOutput) return null;
    try {
      return JSON.parse(selectedSource.rawOutput);
    } catch {
      return selectedSource.rawOutput;
    }
  }, [selectedSource]);

  const isInfoTableSource = selectedSource?.outputType === "INFOTABLE";
  const isObjectTarget = OBJECT_TYPES.has(targetParam.baseType);

  const { columns, rows, dataShape, columnKeys } = useMemo(
    () =>
      isInfoTableSource
        ? infotableColumns(parsedOutput)
        : { columns: [], rows: [], dataShape: undefined, columnKeys: [] },
    [isInfoTableSource, parsedOutput]
  );

  function handleUseRows() {
    const result = { dataShape, rows: selectedRows };
    onPick(JSON.stringify(result));
    onOpenChange(false);
  }

  function handleCellClick(value: unknown) {
    onPick(value === null || value === undefined ? "" : String(value));
    onOpenChange(false);
  }

  function handleColumnPick(columnKey: string) {
    const values = rows.map((r) => r[columnKey] ?? null);
    onPick(JSON.stringify(values));
    onOpenChange(false);
  }

  function handleUseScalar() {
    const strVal =
      parsedOutput === null || parsedOutput === undefined
        ? ""
        : typeof parsedOutput === "object"
        ? JSON.stringify(parsedOutput)
        : String(parsedOutput);
    onPick(strVal);
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[92vw] max-w-5xl sm:max-w-5xl h-[82vh] flex flex-col gap-3 p-5 overflow-hidden">
        <DialogHeader className="shrink-0 pb-2 border-b">
          <DialogTitle className="flex items-center gap-2 flex-wrap text-base font-semibold">
            <IconArrowDown className="size-5 text-primary" />
            <span>Insert from Output into</span>
            <Badge variant="default" className="font-mono text-xs font-medium">
              {targetParam.name}
            </Badge>
            <Badge variant="outline" className="text-[11px] font-mono text-muted-foreground">
              {targetParam.baseType}
            </Badge>
          </DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-3 flex-1 min-h-0 overflow-hidden pt-1">
          {sources.length === 0 && liveOutput === null && allPresetSources.length === 0 && presets.filter(p => p.output).length === 0 ? (
            <Empty className="h-full border border-dashed rounded-lg bg-muted/10">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <IconDatabase className="size-5 text-muted-foreground" />
                </EmptyMedia>
                <EmptyTitle>No Output Available</EmptyTitle>
                <EmptyDescription>
                  Execute a service first or save a preset with recorded outputs to populate this parameter.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <>
              {/* Preset filters */}
              {distinctThings.length > 0 && (
                <div className="flex flex-wrap items-center gap-2 shrink-0 border rounded-lg p-2.5 bg-muted/20">
                  <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground mr-1">
                    <IconFilter className="size-3.5" />
                    <span>Filter Sources:</span>
                  </div>
                  <Select value={filterThing} onValueChange={(v) => { if (v !== null) setFilterThing(v); }}>
                    <SelectTrigger className="h-8 text-xs w-44">
                      <SelectValue placeholder="All Things" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__all__">All Entities</SelectItem>
                      {distinctThings.map((t) => (
                        <SelectItem key={t} value={t}>{t}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Select value={filterService} onValueChange={(v) => { if (v !== null) setFilterService(v); }}>
                    <SelectTrigger className="h-8 text-xs w-44">
                      <SelectValue placeholder="All Services" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__all__">All Services</SelectItem>
                      {distinctServices.map((s) => (
                        <SelectItem key={s} value={s}>{s}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-8 text-xs gap-1.5 px-3 ml-auto"
                    onClick={() => setSortOrder((o) => (o === "newest" ? "oldest" : "newest"))}
                  >
                    {sortOrder === "newest" ? (
                      <>
                        <IconSortDescending className="size-3.5" /> Newest First
                      </>
                    ) : (
                      <>
                        <IconSortAscending className="size-3.5" /> Oldest First
                      </>
                    )}
                  </Button>
                </div>
              )}

              {sources.length === 0 ? (
                <Empty className="h-full border border-dashed rounded-lg bg-muted/10">
                  <EmptyHeader>
                    <EmptyTitle>No matching sources</EmptyTitle>
                    <EmptyDescription>Try adjusting your entity or service filters.</EmptyDescription>
                  </EmptyHeader>
                </Empty>
              ) : (
                <>
                  {/* Source selector */}
                  <div className="flex items-center gap-2.5 shrink-0 px-1">
                    <Label className="text-xs font-semibold shrink-0 text-muted-foreground uppercase tracking-wide">
                      Select Source:
                    </Label>
                    <Select
                      value={selectedSourceIdx}
                      onValueChange={(v) => {
                        if (v !== null) setSelectedSourceIdx(v);
                        setSelectedRows([]);
                      }}
                    >
                      <SelectTrigger className="flex-1 h-9 text-xs">
                        <SelectValue>
                          {sources[parseInt(selectedSourceIdx)]?.label ?? ""}
                        </SelectValue>
                      </SelectTrigger>
                      <SelectContent className="max-h-72">
                        {sources.map((s, i) => (
                          <SelectItem key={i} value={String(i)}>
                            <div className="flex items-center justify-between w-full gap-4">
                              <div className="flex flex-col text-left">
                                <span className="font-medium text-xs">{s.label}</span>
                                {!s.isLive && (s.entityName || s.serviceName || s.createdAt) && (
                                  <span className="text-[10px] text-muted-foreground">
                                    {[s.entityName, s.serviceName].filter(Boolean).join(" / ")}
                                    {s.createdAt ? ` · ${new Date(s.createdAt).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" })}` : ""}
                                  </span>
                                )}
                              </div>
                              {s.outputType && (
                                <Badge variant="secondary" className="text-[10px] shrink-0 font-mono">
                                  {s.outputType}
                                </Badge>
                              )}
                            </div>
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  {/* Content area */}
                  <div className="flex-1 min-h-0 overflow-hidden flex flex-col border rounded-lg p-3 bg-muted/10">
                    {!isInfoTableSource ? (
                      // Scalar / JSON source
                      <div className="flex flex-col gap-3 h-full justify-between">
                        <pre className="text-xs font-mono bg-background border rounded-lg p-3 flex-1 overflow-auto whitespace-pre-wrap leading-relaxed">
                          {typeof parsedOutput === "object"
                            ? JSON.stringify(parsedOutput, null, 2)
                            : String(parsedOutput ?? "")}
                        </pre>
                        <Button onClick={handleUseScalar} className="self-end shadow-sm">
                          Use This Value
                        </Button>
                      </div>
                    ) : !isObjectTarget ? (
                      // Infotable source → scalar target: cell click mode
                      <div className="flex flex-col gap-2 flex-1 min-h-0 overflow-hidden">
                        <div className="flex items-center justify-between shrink-0">
                          <p className="text-xs text-muted-foreground">
                            Click any cell in the table below to insert its value into{" "}
                            <strong className="text-foreground">{targetParam.name}</strong>.
                          </p>
                          <Badge variant="outline" className="text-[11px]">
                            {rows.length} rows
                          </Badge>
                        </div>
                        <div className="flex-1 min-h-0 overflow-hidden bg-background border rounded-lg">
                          <DataTable
                            columns={columns}
                            data={rows}
                            filterPlaceholder="Search rows…"
                            onCellClick={(value) => handleCellClick(value)}
                          />
                        </div>
                      </div>
                    ) : (
                      // Infotable source → object target: row select / column pick
                      <Tabs
                        value={pickTab}
                        onValueChange={(v) => setPickTab(v as "rows" | "column")}
                        className="flex flex-col flex-1 min-h-0 overflow-hidden"
                      >
                        <TabsList className="shrink-0 self-start bg-background border mb-2">
                          <TabsTrigger value="rows" className="text-xs">Select Rows ({selectedRows.length})</TabsTrigger>
                          <TabsTrigger value="column" className="text-xs">Pick Single Column</TabsTrigger>
                        </TabsList>

                        <TabsContent
                          value="rows"
                          className="flex-1 min-h-0 overflow-hidden flex flex-col m-0 p-0"
                        >
                          <div className="flex-1 min-h-0 overflow-hidden bg-background border rounded-lg">
                            <DataTable
                              columns={columns}
                              data={rows}
                              filterPlaceholder="Search rows…"
                              enableRowSelection
                              onSelectedRowsChange={setSelectedRows}
                            />
                          </div>
                          <div className="pt-3 shrink-0 flex items-center justify-between">
                            <span className="text-xs text-muted-foreground">
                              {selectedRows.length} row
                              {selectedRows.length !== 1 ? "s" : ""} selected
                            </span>
                            <Button
                              onClick={handleUseRows}
                              disabled={selectedRows.length === 0}
                              className="shadow-sm"
                            >
                              Insert {selectedRows.length > 0 ? selectedRows.length : ""}{" "}
                              Row{selectedRows.length !== 1 ? "s" : ""} as InfoTable
                            </Button>
                          </div>
                        </TabsContent>

                        <TabsContent
                          value="column"
                          className="flex-1 overflow-auto m-0 p-3 bg-background border rounded-lg"
                        >
                          <p className="text-xs text-muted-foreground mb-4">
                            Click a column to extract all its values into a JSON array:
                          </p>
                          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2">
                            {columnKeys.map((key) => (
                              <Button
                                key={key}
                                variant="outline"
                                size="sm"
                                className="h-9 justify-start text-xs font-mono truncate"
                                onClick={() => handleColumnPick(key)}
                              >
                                {key}
                              </Button>
                            ))}
                            {columnKeys.length === 0 && (
                              <p className="text-xs text-muted-foreground col-span-full">
                                No columns found in this data shape.
                              </p>
                            )}
                          </div>
                        </TabsContent>
                      </Tabs>
                    )}
                  </div>
                </>
              )}
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
