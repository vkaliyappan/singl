"use client";

import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import { useAssistantAction, useAssistantContext } from "@/lib/assistant/context";
import { addPins, usePinnables, type NewPin, type Pinnable } from "@/lib/assistant/pins";
import { setDragPins } from "@/lib/assistant/drag";
import dynamic from "next/dynamic";
import { useTheme } from "@/components/providers";
import {
  IconX,
  IconPlayerPlay,
  IconDeviceFloppy,
  IconTrash,
  IconChevronDown,
  IconDownload,
  IconArrowDown,
  IconWand,
  IconLayoutSidebarLeftCollapse,
  IconLayoutSidebarLeftExpand,
  IconCode,
  IconCopy,
  IconSearch,
  IconHistory,
  IconBookmark,
  IconFileSpreadsheet,
  IconColumns,
  IconLayoutRows,
  IconListDetails,
  IconClock,
  IconSparkles,
  IconServer,
  IconMessagePlus,
} from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Combobox,
  ComboboxInput,
  ComboboxContent,
  ComboboxList,
  ComboboxItem,
  ComboboxEmpty,
} from "@/components/ui/combobox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import {
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
} from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Checkbox } from "@/components/ui/checkbox";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { DataTable } from "@/components/ui/data-table";
import { Badge } from "@/components/ui/badge";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import {
  cancelServiceExecution,
  deleteServicePreset,
  executeService,
  getServiceDefinitions,
  listServicePresets,
  saveServicePreset,
  searchEntities,
  type ServicePreset,
} from "@/lib/services";
import { errorMessage } from "@/lib/settings";
import type { ServiceDef, ServiceParam, EntitySearchResult } from "@/lib/twx/types";
import type { TwxServiceLink } from "@/lib/twx/links";
import { OutputValuePicker, infotableColumns } from "./output-value-picker";
import { CodeSnippetDialog } from "./code-snippet-dialog";
import { clipText, PIN_LIMIT } from "@/lib/assistant/pin-utils";
import { onAssistantChange } from "@/lib/assistant/changes";

const MonacoEditor = dynamic(() => import("@monaco-editor/react"), {
  ssr: false,
  loading: () => (
    <div className="flex items-center justify-center h-full text-muted-foreground text-xs font-mono">
      Loading Monaco editor…
    </div>
  ),
});

const ENTITY_TYPES = [
  { label: "Things", value: "Things" },
  { label: "ThingTemplates", value: "ThingTemplates" },
  { label: "ThingShapes", value: "ThingShapes" },
  { label: "Resources", value: "Resources" },
  { label: "Subsystems", value: "Subsystems" },
  { label: "Mashups", value: "Mashups" },
  { label: "DataShapes", value: "DataShapes" },
];

export type Env = {
  environment: string;
  twxBaseUrl: string;
  hasAppKey: boolean;
};

export type Preset = {
  id: number;
  name: string;
  environment: string;
  entityType: string;
  entityName: string;
  serviceName: string;
  inputs: string;
  output: string;
  outputType: string;
  createdAt: number | null;
};

export function toPreset(p: ServicePreset): Preset {
  return {
    id: p.id,
    name: p.name,
    environment: p.environment,
    entityType: p.entityType,
    entityName: p.entityName,
    serviceName: p.serviceName,
    inputs: p.inputs,
    output: p.output,
    outputType: p.outputType,
    createdAt: p.createdAt ? p.createdAt * 1000 : null,
  };
}

type WorkingSetItem = {
  entityType: string;
  entityName: string;
};

type HistoryEntry = {
  id: string;
  timestamp: number;
  environment: string;
  entityType: string;
  entityName: string;
  serviceName: string;
  inputs: Record<string, string>;
  output: unknown;
  outputType: string;
  durationMs: number;
  isError: boolean;
  errorMessage?: string;
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function parsePresetInputs(inputsJson: string): Record<string, string> {
  const parsed: Record<string, string> = {};
  try {
    const obj = JSON.parse(inputsJson) as Record<string, unknown>;
    Object.entries(obj).forEach(([k, v]) => {
      parsed[k] = typeof v === "object" && v !== null ? JSON.stringify(v) : String(v);
    });
  } catch { /* ignore */ }
  return parsed;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const totalSeconds = ms / 1000;
  if (totalSeconds < 60) return `${totalSeconds.toFixed(2)}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.round(totalSeconds % 60);
  return `${minutes}m ${seconds}s`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

// ── "Add to chat" helpers ────────────────────────────────────────────────────



function servicePinContent(def: ServiceDef, entity: { entityType: string; entityName: string } | null, env: string): string {
  return JSON.stringify(
    {
      environment: env,
      entityType: entity?.entityType,
      entityName: entity?.entityName,
      name: def.name,
      description: def.description,
      category: def.category,
      parameters: [...(def.parameterDefinitions ?? [])]
        .sort((a, b) => a.ordinal - b.ordinal)
        .map((p) => ({
          name: p.name,
          baseType: p.baseType,
          description: p.description || undefined,
          required: p.aspects?.isRequired || undefined,
          defaultValue: p.aspects?.defaultValue || undefined,
          dataShape: p.aspects?.dataShape || undefined,
        })),
      result: def.resultType
        ? { baseType: def.resultType.baseType, dataShape: def.resultType.aspects?.dataShape || undefined, description: def.resultType.description || undefined }
        : undefined,
    },
    null,
    2
  );
}

/** Result as pin text: infotables become columns + rows (selected, else first 200), trimmed to ~40 KB. */
function resultPin(
  result: unknown,
  outputType: string,
  selectedRows: Record<string, unknown>[]
): { content: string; detail: string } {
  if (outputType === "INFOTABLE" && result && typeof result === "object") {
    const { rows, columnKeys, dataShape } = infotableColumns(result);
    const defs = (dataShape as { fieldDefinitions?: Record<string, { name: string; baseType?: string }> } | undefined)?.fieldDefinitions;
    const columns = columnKeys.map((name) => ({ name, baseType: defs?.[name]?.baseType }));
    const chosen = selectedRows.length > 0 ? selectedRows : rows.slice(0, 200);
    const kept: Record<string, unknown>[] = [];
    let size = JSON.stringify(columns).length;
    for (const r of chosen) {
      const n = JSON.stringify(r).length + 2;
      if (size + n > PIN_LIMIT) break;
      size += n;
      kept.push(r);
    }
    const scope = selectedRows.length > 0 ? `${selectedRows.length} selected rows` : `first ${chosen.length} rows`;
    const out: Record<string, unknown> = { columns, rowCount: rows.length, rowsIncluded: scope, rows: kept };
    const notIncluded = (selectedRows.length > 0 ? selectedRows.length : rows.length) - kept.length;
    if (notIncluded > 0) out.note = `${notIncluded} more rows not included`;
    return {
      content: JSON.stringify(out),
      detail: `${columnKeys.length} cols · ${selectedRows.length > 0 ? `${selectedRows.length} of ${rows.length}` : rows.length} rows`,
    };
  }
  const text = typeof result === "string" ? result : (JSON.stringify(result, null, 2) ?? "");
  return { content: clipText(text, PIN_LIMIT), detail: formatBytes(text.length) };
}

/** Compact result for the assistant's screen context: columns + first 5 rows, ~3000 chars. */
function resultSummary(result: unknown, outputType: string): string {
  if (result == null) return "";
  if (outputType === "INFOTABLE" && typeof result === "object") {
    const { rows, columnKeys } = infotableColumns(result);
    return clipText(JSON.stringify({ columns: columnKeys, rowCount: rows.length, firstRows: rows.slice(0, 5) }), 3000);
  }
  return clipText(typeof result === "string" ? result : JSON.stringify(result), 3000);
}

function coerceInput(value: string, baseType: string): unknown {
  if (value === "") return undefined;
  switch (baseType) {
    case "NUMBER":
    case "LONG":
    case "INTEGER":
      return Number(value);
    case "BOOLEAN":
      return value === "true";
    case "DATETIME":
      return value ? new Date(value).getTime() : undefined;
    case "JSON":
    case "INFOTABLE":
      try { return JSON.parse(value); } catch { return value; }
    default:
      return value;
  }
}

function getBaseTypeBadgeColor(baseType: string): string {
  switch (baseType) {
    case "BOOLEAN":
      return "bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20";
    case "NUMBER":
    case "INTEGER":
    case "LONG":
      return "bg-purple-500/10 text-purple-600 dark:text-purple-400 border-purple-500/20";
    case "INFOTABLE":
      return "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20";
    case "JSON":
    case "BLOB":
      return "bg-cyan-500/10 text-cyan-600 dark:text-cyan-400 border-cyan-500/20";
    case "DATETIME":
      return "bg-rose-500/10 text-rose-600 dark:text-rose-400 border-rose-500/20";
    default:
      return "bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/20";
  }
}

function exportInfotableToCsv(data: unknown, filename: string) {
  if (!data || typeof data !== "object") return;
  const { rows, columnKeys } = infotableColumns(data);
  if (rows.length === 0 || columnKeys.length === 0) {
    toast.error("No table rows to export");
    return;
  }
  const escapeCsv = (val: unknown) => {
    if (val === null || val === undefined) return '""';
    const str = typeof val === "object" ? JSON.stringify(val) : String(val);
    return `"${str.replace(/"/g, '""')}"`;
  };
  const header = columnKeys.map(escapeCsv).join(",");
  const body = rows.map((r) => columnKeys.map((k) => escapeCsv(r[k])).join(",")).join("\r\n");
  const csv = `${header}\r\n${body}`;
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename.endsWith(".csv") ? filename : `${filename}.csv`;
  a.click();
  URL.revokeObjectURL(url);
  toast.success(`Exported ${rows.length} rows to CSV`);
}

// ── Parameter Input Field Component ──────────────────────────────────────────

function ServiceInputField({
  param,
  value,
  onChange,
  onClear,
  onOpenPicker,
}: {
  param: ServiceParam;
  value: string;
  onChange: (v: string) => void;
  onClear?: () => void;
  onOpenPicker?: () => void;
}) {
  const { baseType, name, description, aspects } = param;
  const isRequired = aspects.isRequired === true;
  const dataShapeName = typeof aspects.dataShape === "string" ? aspects.dataShape : undefined;
  const { resolvedTheme } = useTheme();
  const [collapsed, setCollapsed] = useState(false);

  const pickerBtn = onOpenPicker ? (
    <Tooltip>
      <TooltipTrigger
        type="button"
        className="inline-flex size-6 items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
        onClick={onOpenPicker}
      >
        <IconArrowDown className="size-3.5 text-primary" />
      </TooltipTrigger>
      <TooltipContent side="top">
        <span className="text-xs">Insert from previous run or preset</span>
      </TooltipContent>
    </Tooltip>
  ) : null;

  const clearBtn = onClear ? (
    <Tooltip>
      <TooltipTrigger
        type="button"
        className="inline-flex size-6 items-center justify-center rounded-md text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
        onClick={onClear}
      >
        <IconX className="size-3.5" />
      </TooltipTrigger>
      <TooltipContent side="top">
        <span className="text-xs">Reset parameter</span>
      </TooltipContent>
    </Tooltip>
  ) : null;

  if (baseType === "BOOLEAN") {
    return (
      <div className="flex items-center justify-between p-3 rounded-lg border bg-card/60 hover:bg-card transition-colors">
        <div className="flex items-center gap-3">
          <Switch
            id={`param-${name}`}
            checked={value === "true"}
            onCheckedChange={(c) => onChange(c ? "true" : "false")}
          />
          <div className="flex flex-col">
            <div className="flex items-center gap-1.5">
              <Label htmlFor={`param-${name}`} className="font-mono text-xs font-semibold cursor-pointer">
                {name}
              </Label>
              {isRequired && <span className="text-destructive font-bold text-xs">*</span>}
              <Badge variant="outline" className={cn("text-[10px] font-mono px-1 py-0 uppercase", getBaseTypeBadgeColor(baseType))}>
                BOOLEAN
              </Badge>
            </div>
            {description && <span className="text-muted-foreground text-[11px] mt-0.5">{description}</span>}
          </div>
        </div>
        <div className="flex items-center gap-1">
          {pickerBtn}
          {clearBtn}
        </div>
      </div>
    );
  }

  if (baseType === "INFOTABLE" || baseType === "JSON" || baseType === "BLOB") {
    const prettyValue = (() => {
      try { return JSON.stringify(JSON.parse(value), null, 2); } catch { return value; }
    })();

    const itData = (() => {
      if (baseType !== "INFOTABLE" || !value) return null;
      try {
        const p = JSON.parse(value);
        if (p && typeof p === "object" && Array.isArray(p.rows)) return infotableColumns(p);
        return null;
      } catch { return null; }
    })();

    const monacoNode = (
      <MonacoEditor
        className="min-w-0"
        height="100%"
        language="json"
        value={prettyValue}
        onChange={(v) => onChange(v ?? "")}
        theme={resolvedTheme === "dark" ? "vs-dark" : "light"}
        options={{
          minimap: { enabled: false },
          fontSize: 12,
          wordWrap: "on",
          scrollBeyondLastLine: false,
          lineNumbers: "off",
          folding: true,
        }}
      />
    );

    return (
      <div className="flex flex-col gap-1.5 p-3 rounded-lg border bg-card/60">
        <div className="flex items-center justify-between gap-2">
          <button
            type="button"
            className="flex items-center gap-1.5 min-w-0 text-left cursor-pointer group"
            onClick={() => setCollapsed((c) => !c)}
          >
            <IconChevronDown className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", collapsed && "-rotate-90")} />
            <span className="font-mono text-xs font-semibold group-hover:text-primary transition-colors">
              {name}
            </span>
            {isRequired && <span className="text-destructive font-bold text-xs">*</span>}
            <Badge variant="outline" className={cn("text-[10px] font-mono px-1 py-0 uppercase", getBaseTypeBadgeColor(baseType))}>
              {baseType}
            </Badge>
            {dataShapeName && (
              <Badge variant="secondary" className="text-[10px] font-mono max-w-40 truncate">
                {dataShapeName}
              </Badge>
            )}
          </button>
          <div className="flex items-center gap-1">
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="size-6 text-muted-foreground hover:text-foreground"
              title="Format JSON"
              onClick={() => {
                try {
                  const parsed = JSON.parse(value);
                  onChange(JSON.stringify(parsed, null, 2));
                  toast.success("JSON formatted");
                } catch {
                  toast.error("Invalid JSON format");
                }
              }}
            >
              <IconSparkles className="size-3.5" />
            </Button>
            {pickerBtn}
            {clearBtn}
          </div>
        </div>

        {description && !collapsed && (
          <p className="text-[11px] text-muted-foreground">{description}</p>
        )}

        {!collapsed && (itData && itData.rows.length > 0 ? (
          <Tabs defaultValue="json" className="flex flex-col mt-1" style={{ height: 260 }}>
            <TabsList className="shrink-0 self-start h-7 bg-muted/60 p-0.5">
              <TabsTrigger value="json" className="text-xs px-2.5 h-6">JSON</TabsTrigger>
              <TabsTrigger value="table" className="text-xs px-2.5 h-6">
                Table View ({itData.rows.length})
              </TabsTrigger>
            </TabsList>
            <TabsContent value="json" className="flex-1 min-h-0 m-0 p-0 overflow-hidden border rounded-md mt-1 bg-background">
              {monacoNode}
            </TabsContent>
            <TabsContent value="table" className="flex-1 min-h-0 m-0 p-0 overflow-hidden border rounded-md mt-1 bg-background">
              <DataTable columns={itData.columns} data={itData.rows} filterPlaceholder="Filter parameter rows…" />
            </TabsContent>
          </Tabs>
        ) : (
          <div className="border rounded-md overflow-hidden mt-1 bg-background" style={{ height: 200 }}>
            {monacoNode}
          </div>
        ))}
      </div>
    );
  }

  if (baseType === "DATETIME") {
    return (
      <div className="flex flex-col gap-1.5 p-3 rounded-lg border bg-card/60">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5">
            <Label htmlFor={`param-${name}`} className="font-mono text-xs font-semibold">
              {name}
            </Label>
            {isRequired && <span className="text-destructive font-bold text-xs">*</span>}
            <Badge variant="outline" className={cn("text-[10px] font-mono px-1 py-0 uppercase", getBaseTypeBadgeColor(baseType))}>
              DATETIME
            </Badge>
          </div>
          <div className="flex items-center gap-1">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-6 text-[11px] px-2 text-muted-foreground hover:text-foreground"
              onClick={() => onChange(new Date().toISOString().slice(0, 16))}
            >
              Set to Now
            </Button>
            {pickerBtn}
            {clearBtn}
          </div>
        </div>
        {description && <p className="text-[11px] text-muted-foreground">{description}</p>}
        <Input
          id={`param-${name}`}
          type="datetime-local"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="h-8 text-xs font-mono"
        />
      </div>
    );
  }

  const inputType =
    baseType === "NUMBER" || baseType === "LONG" || baseType === "INTEGER"
      ? "number"
      : "text";

  return (
    <div className="flex flex-col gap-1.5 p-3 rounded-lg border bg-card/60">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <Label htmlFor={`param-${name}`} className="font-mono text-xs font-semibold">
            {name}
          </Label>
          {isRequired && <span className="text-destructive font-bold text-xs">*</span>}
          <Badge variant="outline" className={cn("text-[10px] font-mono px-1 py-0 uppercase", getBaseTypeBadgeColor(baseType))}>
            {baseType}
          </Badge>
        </div>
        <div className="flex items-center gap-1">
          {pickerBtn}
          {clearBtn}
        </div>
      </div>
      {description && <p className="text-[11px] text-muted-foreground">{description}</p>}
      <Input
        id={`param-${name}`}
        type={inputType}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={aspects.defaultValue ? `Default: ${String(aspects.defaultValue)}` : `Enter ${baseType.toLowerCase()}…`}
        className="h-8 text-xs font-mono"
      />
    </div>
  );
}

// ── Output InfoTable Inspector View ──────────────────────────────────────────

function InfoTableView({ data, onSelectedRows }: { data: unknown; onSelectedRows?: (rows: Record<string, unknown>[]) => void }) {
  const parsed =
    typeof data === "string"
      ? (() => { try { return JSON.parse(data); } catch { return null; } })()
      : data;

  if (!parsed || typeof parsed !== "object") {
    return <pre className="text-xs font-mono whitespace-pre-wrap p-4">{JSON.stringify(data, null, 2)}</pre>;
  }

  const { columns, rows } = infotableColumns(parsed);

  if (rows.length === 0) {
    return (
      <Empty className="h-full border border-dashed rounded-lg bg-muted/10 m-3">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <IconListDetails className="size-5 text-muted-foreground" />
          </EmptyMedia>
          <EmptyTitle>Empty InfoTable</EmptyTitle>
          <EmptyDescription>The service completed successfully but returned 0 rows.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <div className="h-full flex flex-col min-h-0 overflow-hidden">
      <DataTable columns={columns} data={rows} filterPlaceholder="Search returned records…" enableRowSelection={!!onSelectedRows} onSelectedRowsChange={onSelectedRows} />
    </div>
  );
}

// ── Main TWX Services Explorer ───────────────────────────────────────────────

export function TwxServicesExplorer({
  initialEnvs,
  initialPresets,
  link = null,
}: {
  initialEnvs: Env[];
  initialPresets: Preset[];
  /** Deep link from another module; wins over whatever was open last time. */
  link?: TwxServiceLink | null;
}) {
  const { resolvedTheme } = useTheme();

  const [restoredState] = useState<{ service: string | null; active: string | null; inputs: string | null }>(() => {
    if (typeof window === "undefined") return { service: null, active: null, inputs: null };
    return {
      service: localStorage.getItem("singl:twx-services:selectedService"),
      active: localStorage.getItem("singl:twx-services:activeItem"),
      inputs: localStorage.getItem("singl:twx-services:inputValues"),
    };
  });

  // ── Environments
  const linkEnv = link && initialEnvs.some((e) => e.environment === link.env) ? link.env : "";
  const [selectedEnv, setSelectedEnv] = useState<string>(linkEnv || (initialEnvs[0]?.environment ?? ""));

  useEffect(() => {
    if (linkEnv) return;
    const stored = localStorage.getItem("singl:twx-services:env");
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (stored && initialEnvs.some((e) => e.environment === stored)) setSelectedEnv(stored);
  }, [initialEnvs, linkEnv]);

  useEffect(() => {
    if (selectedEnv) localStorage.setItem("singl:twx-services:env", selectedEnv);
  }, [selectedEnv]);

  const activeEnvRecord = useMemo(() => initialEnvs.find((e) => e.environment === selectedEnv), [initialEnvs, selectedEnv]);

  // ── Entity Search
  const [searchType, setSearchType] = useState(link?.type ?? "Things");

  useEffect(() => {
    if (link) return;
    const stored = localStorage.getItem("singl:twx-services:searchType");
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (stored) setSearchType(stored);
  }, [link]);

  useEffect(() => {
    localStorage.setItem("singl:twx-services:searchType", searchType);
  }, [searchType]);

  const [entityList, setEntityList] = useState<EntitySearchResult[]>([]);
  const [entityLoading, setEntityLoading] = useState(false);
  const [entityError, setEntityError] = useState<string | null>(null);
  const [comboInput, setComboInput] = useState<string>("");

  const fetchEntities = useCallback(async (env: string, type: string) => {
    setEntityLoading(true);
    setEntityError(null);
    setEntityList([]);
    try {
      setEntityList(await searchEntities(env, type, "*"));
    } catch (e) {
      setEntityError(errorMessage(e));
    } finally {
      setEntityLoading(false);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (selectedEnv) fetchEntities(selectedEnv, searchType);
  }, [selectedEnv, searchType, fetchEntities]);

  // ── Working Set
  const [workingSet, setWorkingSet] = useState<WorkingSetItem[]>([]);

  useEffect(() => {
    try {
      const s = localStorage.getItem("singl:twx-services:workingSet");
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (s) setWorkingSet(JSON.parse(s) as WorkingSetItem[]);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    localStorage.setItem("singl:twx-services:workingSet", JSON.stringify(workingSet));
  }, [workingSet]);

  const [activeItem, setActiveItem] = useState<WorkingSetItem | null>(null);

  useEffect(() => {
    if (activeItem) {
      localStorage.setItem("singl:twx-services:activeItem", JSON.stringify(activeItem));
    } else {
      localStorage.removeItem("singl:twx-services:activeItem");
    }
  }, [activeItem]);

  const addToWorkingSet = useCallback((item: WorkingSetItem) => {
    setWorkingSet((prev) => {
      const exists = prev.some((i) => i.entityName === item.entityName && i.entityType === item.entityType);
      return exists ? prev : [...prev, item];
    });
  }, []);

  const removeFromWorkingSet = useCallback((item: WorkingSetItem) => {
    setWorkingSet((prev) => prev.filter((i) => !(i.entityName === item.entityName && i.entityType === item.entityType)));
    setActiveItem((cur) => (cur?.entityName === item.entityName && cur.entityType === item.entityType ? null : cur));
  }, []);

  // ── Service Definitions
  const [serviceDefs, setServiceDefs] = useState<ServiceDef[]>([]);
  const [defsLoading, setDefsLoading] = useState(false);
  const [defsError, setDefsError] = useState<string | null>(null);
  const [selectedService, setSelectedService] = useState<string>("");
  const [serviceCategoryFilter, setServiceCategoryFilter] = useState("");

  useEffect(() => {
    if (selectedService) {
      localStorage.setItem("singl:twx-services:selectedService", selectedService);
    } else {
      localStorage.removeItem("singl:twx-services:selectedService");
    }
  }, [selectedService]);

  const pendingServiceRef = useRef<string | null>(null);
  const pendingInputsRef = useRef<Record<string, string> | null>(null);
  const pendingOutputRef = useRef<{ output: string; outputType: string } | null>(null);

  const loadDefinitions = useCallback(
    async (item: WorkingSetItem, env?: string) => {
      setDefsLoading(true);
      setDefsError(null);
      setServiceDefs([]);
      setSelectedService("");
      setServiceCategoryFilter("");
      try {
        setServiceDefs(await getServiceDefinitions(env ?? selectedEnv, item.entityType, item.entityName));
        if (pendingServiceRef.current) {
          setSelectedService(pendingServiceRef.current);
          pendingServiceRef.current = null;
        }
      } catch (e) {
        pendingServiceRef.current = null;
        pendingInputsRef.current = null;
        pendingOutputRef.current = null;
        setDefsError(errorMessage(e));
      } finally {
        setDefsLoading(false);
      }
    },
    [selectedEnv]
  );

  const activateItem = useCallback(
    (item: WorkingSetItem, env?: string) => {
      setActiveItem(item);
      loadDefinitions(item, env);
    },
    [loadDefinitions]
  );

  // Restore on mount — a deep link takes the place of the last session
  useEffect(() => {
    if (link) {
      const item = { entityType: link.type, entityName: link.entity };
      // eslint-disable-next-line react-hooks/set-state-in-effect
      addToWorkingSet(item);
      pendingServiceRef.current = link.service ?? null;
      pendingInputsRef.current = link.inputs ?? null;
      activateItem(item, linkEnv || undefined);
      if (link.env && !linkEnv) toast.warning(`Environment "${link.env}" is not configured — using ${selectedEnv || "the default"}`);
      return;
    }
    try {
      if (!restoredState.active) return;
      const item = JSON.parse(restoredState.active) as WorkingSetItem;
      if (restoredState.service) pendingServiceRef.current = restoredState.service;
      if (restoredState.inputs) {
        try {
          pendingInputsRef.current = JSON.parse(restoredState.inputs) as Record<string, string>;
        } catch { /* ignore */ }
      }
      activateItem(item);
    } catch { /* ignore */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const currentServiceDef = useMemo(
    () => serviceDefs.find((d) => d.name === selectedService),
    [serviceDefs, selectedService]
  );

  const sortedParams = useMemo(
    () => (currentServiceDef ? [...currentServiceDef.parameterDefinitions].sort((a, b) => a.ordinal - b.ordinal) : []),
    [currentServiceDef]
  );

  // ── Service Filtering
  const [serviceFilter, setServiceFilter] = useState("");

  useEffect(() => {
    const stored = localStorage.getItem("singl:twx-services:serviceFilter");
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (stored) setServiceFilter(stored);
  }, []);

  useEffect(() => {
    localStorage.setItem("singl:twx-services:serviceFilter", serviceFilter);
  }, [serviceFilter]);

  const serviceCategories = useMemo(
    () => Array.from(new Set(serviceDefs.map((d) => d.category || "Uncategorized"))).sort(),
    [serviceDefs]
  );

  // Multi-select in the service list (Ctrl/Shift click); empty = just selectedService.
  const [multiSel, setMultiSel] = useState<string[]>([]);
  const anchorRef = useRef<string | null>(null);
  const [svcMenu, setSvcMenu] = useState<{ x: number; y: number; names: string[] } | null>(null);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMultiSel([]);
  }, [serviceDefs]);

  const visibleServices = useMemo(
    () =>
      serviceDefs
        .filter((d) => !serviceFilter || d.name.toLowerCase().includes(serviceFilter.toLowerCase()))
        .filter((d) => !serviceCategoryFilter || (d.category || "Uncategorized") === serviceCategoryFilter)
        .sort((a, b) => a.name.localeCompare(b.name)),
    [serviceDefs, serviceFilter, serviceCategoryFilter]
  );

  // ── Input State & Form vs Raw JSON Mode
  const [inputValues, setInputValues] = useState<Record<string, string>>({});
  const [inputMode, setInputMode] = useState<"form" | "raw">("form");

  // ── Execute Service State
  const [execLoading, setExecLoading] = useState(false);
  const [execError, setExecError] = useState<string | null>(null);
  const [execResult, setExecResult] = useState<unknown>(null);
  const [resultRows, setResultRows] = useState<Record<string, unknown>[]>([]);
  const [execOutputType, setExecOutputType] = useState("");

  const resultSummaryText = useMemo(() => resultSummary(execResult, execOutputType), [execResult, execOutputType]);
  useAssistantContext({
    screen: "twx-services",
    title: "Services",
    summary: activeItem
      ? `${activeItem.entityType}:${activeItem.entityName}${selectedService ? ` › ${selectedService}` : ""} on ${selectedEnv}`
      : `Service runner on ${selectedEnv || "no environment"}`,
    data: {
      env: selectedEnv,
      searchType,
      workingSet: workingSet.slice(0, 20),
      inputMode,
      inputs: JSON.stringify(inputValues).slice(0, 2000),
      running: execLoading,
      error: execError,
      hasResult: execResult != null,
      result: resultSummaryText,
    },
    selection: {
      entity: activeItem ? [`${activeItem.entityType}:${activeItem.entityName}`] : [],
      service: selectedService ? [selectedService] : [],
    },
  });
  const [execElapsedMs, setExecElapsedMs] = useState<number | null>(null);
  const [execLiveElapsedMs, setExecLiveElapsedMs] = useState(0);
  // The running call: its id (to cancel it in the backend) and whether Stop was pressed.
  const execAbortRef = useRef<{ id: string; aborted: boolean } | null>(null);

  // ── In-Session History
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [sidebarTab, setSidebarTab] = useState<"services" | "presets" | "history">("services");

  useEffect(() => {
    if (Object.keys(inputValues).length > 0) {
      localStorage.setItem("singl:twx-services:inputValues", JSON.stringify(inputValues));
    }
  }, [inputValues]);

  // Synchronize parameter defaults when service changes
  useEffect(() => {
    if (currentServiceDef) {
      const defaults: Record<string, string> = {};
      currentServiceDef.parameterDefinitions.forEach((p) => {
        defaults[p.name] = p.aspects.defaultValue ? String(p.aspects.defaultValue) : "";
      });
      // Pending values (a preset, a deep link) may name only some parameters.
      setInputValues({ ...defaults, ...pendingInputsRef.current });
      pendingInputsRef.current = null;
      if (pendingOutputRef.current) {
        const { output, outputType } = pendingOutputRef.current;
        pendingOutputRef.current = null;
        if (output) {
          try {
            setExecResult(JSON.parse(output));
          } catch {
            setExecResult(output);
          }
          setExecOutputType(outputType);
        }
      }
    } else {
      setInputValues({});
    }
  }, [currentServiceDef]);

  useEffect(() => {
    if (!execLoading) return;
    const start = Date.now();
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setExecLiveElapsedMs(0);
    const interval = setInterval(() => setExecLiveElapsedMs(Date.now() - start), 50);
    return () => clearInterval(interval);
  }, [execLoading]);

  const handleClearAll = useCallback(() => {
    const cleared: Record<string, string> = {};
    sortedParams.forEach((p) => {
      cleared[p.name] = p.baseType === "BOOLEAN" ? "false" : "";
    });
    setInputValues(cleared);
    toast.info("All parameters reset");
  }, [sortedParams]);

  const handleRun = async (): Promise<{ ok: boolean; summary: string }> => {
    if (!activeItem || !selectedService || !selectedEnv) {
      toast.error("Please select an entity and service first");
      return { ok: false, summary: "Select an entity and a service first." };
    }
    setResultRows([]);
    const controller = { id: crypto.randomUUID(), aborted: false };
    execAbortRef.current = controller;
    setExecLoading(true);
    setExecError(null);
    setExecResult(null);
    setExecElapsedMs(null);
    const startedAt = Date.now();

    const inputs: Record<string, unknown> = {};
    sortedParams.forEach((p) => {
      const raw = inputValues[p.name] ?? "";
      const coerced = coerceInput(raw, p.baseType);
      if (coerced !== undefined) inputs[p.name] = coerced;
    });

    try {
      const result = await executeService({
        env: selectedEnv,
        collection: activeItem.entityType,
        entityName: activeItem.entityName,
        serviceName: selectedService,
        inputs,
        requestId: controller.id,
      });
      if (controller.aborted) return { ok: false, summary: "Cancelled." };

      setExecResult(result);
      const outputBaseType = currentServiceDef?.resultType?.baseType ?? "";
      setExecOutputType(outputBaseType);

      const duration = Date.now() - startedAt;
      setExecElapsedMs(duration);

      // Add to session history
      setHistory((prev) => [
        {
          id: Math.random().toString(36).substring(2, 9),
          timestamp: Date.now(),
          environment: selectedEnv,
          entityType: activeItem.entityType,
          entityName: activeItem.entityName,
          serviceName: selectedService,
          inputs: { ...inputValues },
          output: result,
          outputType: outputBaseType,
          durationMs: duration,
          isError: false,
        },
        ...prev.slice(0, 19),
      ]);
      toast.success(`Executed in ${formatDuration(duration)}`);
      return { ok: true, summary: resultSummary(result, outputBaseType) || "Completed with no result." };
    } catch (e) {
      if (!controller.aborted) {
        const errorMsg = errorMessage(e);
        setExecError(errorMsg);
        const duration = Date.now() - startedAt;
        setExecElapsedMs(duration);

        setHistory((prev) => [
          {
            id: Math.random().toString(36).substring(2, 9),
            timestamp: Date.now(),
            environment: selectedEnv,
            entityType: activeItem.entityType,
            entityName: activeItem.entityName,
            serviceName: selectedService,
            inputs: { ...inputValues },
            output: null,
            outputType: "",
            durationMs: duration,
            isError: true,
            errorMessage: errorMsg,
          },
          ...prev.slice(0, 19),
        ]);
        toast.error("Execution failed");
        return { ok: false, summary: errorMsg };
      }
      return { ok: false, summary: "Cancelled." };
    } finally {
      if (execAbortRef.current === controller) {
        execAbortRef.current = null;
        setExecLoading(false);
      }
    }
  };

  const abortExecution = useCallback(() => {
    const running = execAbortRef.current;
    if (!running) return;
    running.aborted = true;
    cancelServiceExecution(running.id).catch(() => {});
  }, []);

  const handleStop = useCallback(() => {
    abortExecution();
    setExecLoading(false);
    toast.info("Execution cancelled");
  }, [abortExecution]);

  useEffect(() => () => abortExecution(), [abortExecution]);

  // Global keyboard shortcut: Ctrl+Enter / Cmd+Enter to run, Ctrl+S to save preset
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
        if (!activeItem || !selectedService || !selectedEnv || execLoading) return;
        e.preventDefault();
        handleRun();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  // ── Layout Mode State (Split Horizontal vs Split Vertical vs Max Output)
  const [layoutMode, setLayoutMode] = useState<"horizontal" | "vertical" | "output-focus">("horizontal");

  // ── Modals & Dialogs State
  const [pickerParam, setPickerParam] = useState<ServiceParam | null>(null);
  const [codeDialogOpen, setCodeDialogOpen] = useState(false);

  // ── Presets State & Actions
  const [presets, setPresets] = useState<Preset[]>(initialPresets);
  const [saveDialogOpen, setSaveDialogOpen] = useState(false);
  const [savePresetName, setSavePresetName] = useState("");
  const [editingPresetId, setEditingPresetId] = useState<number | null>(null);
  const [saveIncludeInputs, setSaveIncludeInputs] = useState(true);
  const [saveIncludeOutput, setSaveIncludeOutput] = useState(true);
  const [saveMode, setSaveMode] = useState<"input" | "output" | "both">("both");

  const [saveError, setSaveError] = useState<string | null>(null);
  const [savePending, setSavePending] = useState(false);

  const reloadPresets = useCallback(async () => {
    try {
      setPresets((await listServicePresets()).map(toPreset));
    } catch (e) {
      toast.error(`Could not reload presets: ${errorMessage(e)}`);
    }
  }, []);

  useEffect(() => onAssistantChange("presets", () => void reloadPresets()), [reloadPresets]);

  const savePreset = async (preset: Parameters<typeof saveServicePreset>[0]) => {
    setSavePending(true);
    setSaveError(null);
    try {
      await saveServicePreset(preset);
      setSaveDialogOpen(false);
      setSavePresetName("");
      setEditingPresetId(null);
      toast.success("Preset saved successfully");
      await reloadPresets();
    } catch (e) {
      setSaveError(errorMessage(e));
    } finally {
      setSavePending(false);
    }
  };

  const removePreset = async (id: number) => {
    try {
      await deleteServicePreset(id);
      toast.success("Preset deleted");
      await reloadPresets();
    } catch (e) {
      toast.error(`Failed to delete preset: ${errorMessage(e)}`);
    }
  };

  const handleSavePreset = useCallback(
    (mode: "input" | "output" | "both" = "both") => {
      if (!activeItem || !selectedService) return;
      setSavePresetName(`${activeItem.entityName}_${selectedService}`);
      setEditingPresetId(null);
      setSaveMode(mode);
      setSaveIncludeInputs(mode !== "output");
      setSaveIncludeOutput(mode !== "input");
      setSaveDialogOpen(true);
    },
    [activeItem, selectedService]
  );

  const loadPreset = useCallback(
    (preset: Preset) => {
      setSelectedEnv(preset.environment);
      const item = { entityType: preset.entityType, entityName: preset.entityName };
      addToWorkingSet(item);

      pendingServiceRef.current = preset.serviceName;
      pendingInputsRef.current = parsePresetInputs(preset.inputs);
      if (preset.output) {
        pendingOutputRef.current = { output: preset.output, outputType: preset.outputType };
      }

      activateItem(item, preset.environment);
      toast.success(`Loaded preset "${preset.name}"`);
    },
    [addToWorkingSet, activateItem]
  );

  const applyPresetInputsToCurrent = useCallback(
    (preset: Preset) => {
      if (!currentServiceDef) return;
      const parsed = parsePresetInputs(preset.inputs);
      const paramNames = new Set(sortedParams.map((p) => p.name));
      setInputValues((prev) => {
        const next = { ...prev };
        Object.entries(parsed).forEach(([k, v]) => {
          if (paramNames.has(k)) next[k] = v;
        });
        return next;
      });
      toast.success("Mapped preset inputs into current service");
    },
    [currentServiceDef, sortedParams]
  );

  const envPresets = useMemo(
    () => presets.filter((p) => !selectedEnv || p.environment === selectedEnv),
    [presets, selectedEnv]
  );

  const [presetScope, setPresetScope] = useState<"service" | "all">("service");

  const visiblePresets = useMemo(() => {
    if (presetScope === "all" || !activeItem || !selectedService) return envPresets;
    return envPresets.filter(
      (p) => p.entityName === activeItem.entityName && p.serviceName === selectedService
    );
  }, [presetScope, envPresets, activeItem, selectedService]);

  // ── Services list auto scroll
  const servicesListRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!selectedService || !servicesListRef.current) return;
    const el = servicesListRef.current.querySelector<HTMLElement>(
      `[data-service="${CSS.escape(selectedService)}"]`
    );
    el?.scrollIntoView({ block: "nearest" });
  }, [selectedService]);

  // ── Left sidebar width and drag
  const [leftWidth, setLeftWidth] = useState(300);
  const leftWidthRef = useRef(300);
  useEffect(() => {
    leftWidthRef.current = leftWidth;
  }, [leftWidth]);

  const [leftCollapsed, setLeftCollapsed] = useState(false);

  useEffect(() => {
    const stored = localStorage.getItem("singl:twx-services:leftCollapsed");
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (stored) setLeftCollapsed(stored === "true");
  }, []);

  useEffect(() => {
    localStorage.setItem("singl:twx-services:leftCollapsed", String(leftCollapsed));
  }, [leftCollapsed]);

  const [inputWidth, setInputWidth] = useState(380);
  const inputWidthRef = useRef(380);
  useEffect(() => {
    inputWidthRef.current = inputWidth;
  }, [inputWidth]);

  const handleLeftDragStart = useCallback((e: React.MouseEvent) => {
    const startX = e.clientX;
    const startWidth = leftWidthRef.current;
    const onMove = (ev: MouseEvent) => {
      setLeftWidth(Math.max(220, Math.min(540, startWidth + ev.clientX - startX)));
    };
    const onUp = () => {
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    e.preventDefault();
  }, []);

  const handleInputDragStart = useCallback((e: React.MouseEvent) => {
    const startX = e.clientX;
    const startWidth = inputWidthRef.current;
    const onMove = (ev: MouseEvent) => {
      setInputWidth(Math.max(260, Math.min(700, startWidth + ev.clientX - startX)));
    };
    const onUp = () => {
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    e.preventDefault();
  }, []);

  const filteredEntities = useMemo(
    () =>
      comboInput
        ? entityList.filter((e) => e.name.toLowerCase().includes(comboInput.toLowerCase()))
        : entityList,
    [comboInput, entityList]
  );

  const isInfoTable = execOutputType === "INFOTABLE";
  const rawOutput = execResult !== null ? JSON.stringify(execResult, null, 2) : "";
  const outputByteSize = useMemo(() => new Blob([rawOutput]).size, [rawOutput]);

  const infoTableMeta = useMemo(() => {
    if (!isInfoTable || !execResult) return null;
    const { rows, columnKeys } = infotableColumns(execResult);
    return { rowCount: rows.length, colCount: columnKeys.length };
  }, [isInfoTable, execResult]);

  // Payload object for Raw JSON editing mode and Code Snippet dialog
  const currentPayloadObj = useMemo(() => {
    const res: Record<string, unknown> = {};
    sortedParams.forEach((p) => {
      const raw = inputValues[p.name] ?? "";
      const coerced = coerceInput(raw, p.baseType);
      if (coerced !== undefined) res[p.name] = coerced;
    });
    return res;
  }, [sortedParams, inputValues]);

  // ── Add to chat: pins, pinnables (@ menu) and assistant actions
  const pinTargetNames = multiSel.length > 0 ? multiSel : selectedService ? [selectedService] : [];

  const servicePins = useCallback(
    (names: string[]): NewPin[] =>
      names.map((name) => {
        const def = serviceDefs.find((d) => d.name === name);
        const entityLabel = activeItem?.entityName ?? "";
        return {
          kind: "service",
          label: entityLabel ? `${entityLabel}.${name}` : name,
          screen: "twx-services",
          detail: def ? `${def.parameterDefinitions?.length ?? 0} params → ${def.resultType?.baseType ?? "VOID"}` : undefined,
          content: def
            ? servicePinContent(def, activeItem, selectedEnv)
            : JSON.stringify({ environment: selectedEnv, entityType: activeItem?.entityType, entityName: activeItem?.entityName, name }),
        };
      }),
    [serviceDefs, activeItem, selectedEnv]
  );

  const inputsPin = useCallback(
    (): NewPin => ({
      kind: "inputs",
      label: `Inputs · ${selectedService}`,
      screen: "twx-services",
      detail: `${Object.keys(currentPayloadObj).length} values`,
      content: JSON.stringify(
        { environment: selectedEnv, entity: activeItem ? `${activeItem.entityType}:${activeItem.entityName}` : undefined, service: selectedService, inputs: currentPayloadObj },
        null,
        2
      ),
    }),
    [selectedService, currentPayloadObj, selectedEnv, activeItem]
  );

  const resultPins = useCallback((): NewPin | null => {
    if (execError) {
      return { kind: "error", label: `Error · ${selectedService}`, screen: "twx-services", content: clipText(execError, PIN_LIMIT) };
    }
    if (execResult === null) return null;
    const { content, detail } = resultPin(execResult, execOutputType, resultRows);
    return { kind: "result", label: `Result · ${selectedService}`, screen: "twx-services", detail, content };
  }, [execError, execResult, execOutputType, resultRows, selectedService]);

  const pinInputs = () => addPins([inputsPin()]);
  const pinResult = () => {
    const p = resultPins();
    if (p) addPins([p]);
  };

  const pinnables: Pinnable[] = [];
  for (const name of pinTargetNames.slice(0, 10)) {
    pinnables.push({
      kind: "service",
      label: activeItem ? `${activeItem.entityName}.${name}` : name,
      detail: "service definition",
      content: () => servicePins([name])[0].content,
    });
  }
  if (selectedService) {
    pinnables.push({ kind: "inputs", label: `Inputs · ${selectedService}`, detail: "current input values", content: () => inputsPin().content });
    if (execError || execResult !== null) {
      pinnables.push({
        kind: execError ? "error" : "result",
        label: `${execError ? "Error" : "Result"} · ${selectedService}`,
        detail: execError ? "last run failed" : "last result",
        content: () => resultPins()?.content ?? "",
      });
    }
  }
  usePinnables(pinnables);

  useAssistantAction(
    "select_service",
    {
      description: "Select a service in the Services screen's list for the active entity (open the entity first with add_to_working_set).",
      inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
    },
    async (args) => {
      const name = String((args as { name?: string }).name ?? "");
      if (!serviceDefs.some((d) => d.name === name)) throw new Error(`The active entity has no service "${name}".`);
      anchorRef.current = name;
      setMultiSel([]);
      setSelectedService(name);
      await new Promise((r) => setTimeout(r, 150)); // let the default inputs settle
      return { selected: name };
    }
  );
  useAssistantAction(
    "set_inputs",
    {
      description: "Merge values into the current service's inputs. Values are strings, or objects/arrays for JSON and INFOTABLE parameters.",
      inputSchema: { type: "object", properties: { values: { type: "object" } }, required: ["values"] },
    },
    async (args) => {
      const values = (args as { values?: Record<string, unknown> }).values;
      if (!values || typeof values !== "object") throw new Error("values must be an object");
      const strMap: Record<string, string> = {};
      for (const [k, v] of Object.entries(values)) strMap[k] = typeof v === "object" && v !== null ? JSON.stringify(v) : String(v);
      setInputValues((prev) => ({ ...prev, ...strMap }));
      return { set: Object.keys(strMap) };
    }
  );
  useAssistantAction(
    "run_service",
    {
      description: "Run the currently selected service with the current inputs on the selected environment. Returns a short result summary.",
      risk: "destructive",
    },
    async () => {
      const r = await handleRun();
      if (!r.ok) throw new Error(r.summary);
      return { result: r.summary };
    }
  );
  useAssistantAction(
    "add_to_working_set",
    {
      description: "Add an entity to the working set and open it so its services load.",
      inputSchema: {
        type: "object",
        properties: { entity: { type: "string" }, type: { type: "string", description: "Collection, e.g. Things (default Things)" } },
        required: ["entity"],
      },
    },
    async (args) => {
      const a = args as { entity?: string; type?: string };
      if (!a.entity) throw new Error("entity is required");
      const item = { entityType: a.type || "Things", entityName: a.entity };
      addToWorkingSet(item);
      activateItem(item);
      await new Promise((r) => setTimeout(r, 300));
      return { opened: `${item.entityType}:${item.entityName}` };
    }
  );

  const onServiceClick = (e: React.MouseEvent, name: string) => {
    if (e.ctrlKey || e.metaKey) {
      setMultiSel((cur) => {
        const base = cur.length ? cur : selectedService ? [selectedService] : [];
        return base.includes(name) ? base.filter((x) => x !== name) : [...base, name];
      });
      anchorRef.current = name;
      return;
    }
    if (e.shiftKey) {
      const names = visibleServices.map((d) => d.name);
      const a = names.indexOf(anchorRef.current ?? selectedService);
      const b = names.indexOf(name);
      if (a >= 0 && b >= 0) {
        setMultiSel(names.slice(Math.min(a, b), Math.max(a, b) + 1));
        return;
      }
    }
    anchorRef.current = name;
    setMultiSel([]);
    setSelectedService(name);
  };

  useEffect(() => {
    if (!svcMenu) return;
    const close = (e: Event) => {
      if (e.target instanceof Element && e.target.closest("[data-svc-menu]")) return;
      setSvcMenu(null);
    };
    const key = (e: KeyboardEvent) => e.key === "Escape" && setSvcMenu(null);
    window.addEventListener("pointerdown", close, true);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("pointerdown", close, true);
      window.removeEventListener("keydown", key);
    };
  }, [svcMenu]);

  return (
    <div className="h-full flex flex-col overflow-hidden bg-background text-foreground">
      {/* ── Top Workbench Bar ────────────────────────────────────────────── */}
      <div className="h-12 border-b bg-card/60 px-4 flex items-center justify-between gap-3 shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <div className="flex items-center gap-1.5 shrink-0">
            <span
              className={cn(
                "size-2 rounded-full",
                activeEnvRecord?.hasAppKey ? "bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.5)]" : "bg-amber-500"
              )}
            />
            <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              {selectedEnv || "No Env"}
            </span>
          </div>

          <span className="text-muted-foreground/50 text-xs">/</span>

          {activeItem ? (
            <div className="flex items-center gap-1.5 min-w-0">
              <Badge variant="outline" className="text-[10px] font-mono shrink-0 px-1.5 py-0">
                {activeItem.entityType}
              </Badge>
              <span className="font-semibold text-xs truncate max-w-44">{activeItem.entityName}</span>
              {selectedService && (
                <>
                  <span className="text-muted-foreground/50 text-xs shrink-0">/</span>
                  <span className="font-bold text-xs text-primary truncate max-w-52">
                    {selectedService}
                  </span>
                  {currentServiceDef?.resultType?.baseType && (
                    <Badge
                      variant="outline"
                      className={cn(
                        "text-[10px] font-mono shrink-0 px-1.5 py-0 uppercase",
                        getBaseTypeBadgeColor(currentServiceDef.resultType.baseType)
                      )}
                    >
                      {currentServiceDef.resultType.baseType}
                    </Badge>
                  )}
                  {sortedParams.length > 0 && (
                    <Badge variant="secondary" className="text-[10px] shrink-0 font-mono">
                      {sortedParams.length} param{sortedParams.length !== 1 ? "s" : ""}
                    </Badge>
                  )}
                </>
              )}
            </div>
          ) : (
            <span className="text-xs text-muted-foreground">Select an entity to get started</span>
          )}
        </div>

        {/* Action controls */}
        <div className="flex items-center gap-2 shrink-0">
          {/* Layout switcher */}
          <div className="hidden md:flex items-center rounded-lg border bg-muted/40 p-0.5">
            <Tooltip>
              <TooltipTrigger
                type="button"
                className={cn(
                  "p-1 rounded text-muted-foreground hover:text-foreground transition-colors",
                  layoutMode === "horizontal" && "bg-background text-foreground shadow-sm"
                )}
                onClick={() => setLayoutMode("horizontal")}
              >
                <IconColumns className="size-3.5" />
              </TooltipTrigger>
              <TooltipContent side="bottom">Side-by-side view</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger
                type="button"
                className={cn(
                  "p-1 rounded text-muted-foreground hover:text-foreground transition-colors",
                  layoutMode === "vertical" && "bg-background text-foreground shadow-sm"
                )}
                onClick={() => setLayoutMode("vertical")}
              >
                <IconLayoutRows className="size-3.5" />
              </TooltipTrigger>
              <TooltipContent side="bottom">Stacked view</TooltipContent>
            </Tooltip>
          </div>

          {/* Snippet generator */}
          <Button
            size="sm"
            variant="outline"
            disabled={!selectedService}
            onClick={() => setCodeDialogOpen(true)}
            className="h-8 gap-1.5 text-xs"
          >
            <IconCode className="size-3.5" />
            <span className="hidden sm:inline">Snippets</span>
          </Button>

          {/* Save preset */}
          <Button
            size="sm"
            variant="outline"
            disabled={!selectedService}
            onClick={() => handleSavePreset("both")}
            className="h-8 gap-1.5 text-xs"
          >
            <IconDeviceFloppy className="size-3.5" />
            <span className="hidden sm:inline">Save</span>
          </Button>

          {/* Run button */}
          {execLoading ? (
            <Button
              size="sm"
              variant="destructive"
              onClick={handleStop}
              className="h-8 gap-2 px-3.5 text-xs shadow-sm font-medium"
            >
              <Spinner className="size-3.5" />
              <span>Cancel ({formatDuration(execLiveElapsedMs)})</span>
            </Button>
          ) : (
            <Button
              size="sm"
              disabled={!activeItem || !selectedService || !selectedEnv}
              onClick={handleRun}
              className="h-8 gap-1.5 px-4 text-xs shadow-sm font-medium bg-primary text-primary-foreground hover:bg-primary/90"
            >
              <IconPlayerPlay className="size-3.5 fill-current" />
              <span>Run</span>
              <kbd className="hidden lg:inline-block ml-1 px-1 py-0.2 rounded bg-primary-foreground/20 text-[10px] font-mono">
                ⌘↵
              </kbd>
            </Button>
          )}
        </div>
      </div>

      {/* ── Main Workspace Body ─────────────────────────────────────────── */}
      <div className="flex-1 flex min-h-0 overflow-hidden">
        {/* ── Left Sidebar (Navigator, Working Set, Services, Presets & History) ── */}
        <div
          className="border-r shrink-0 overflow-hidden relative transition-[width] duration-200 ease-in-out bg-card/40 flex flex-col"
          style={{ width: leftCollapsed ? 44 : leftWidth }}
        >
          {/* Collapsed view */}
          <div
            className={cn(
              "flex flex-col items-center pt-3 gap-3 transition-opacity duration-150 absolute inset-0 bg-card/60",
              leftCollapsed ? "opacity-100" : "opacity-0 pointer-events-none"
            )}
          >
            <Button
              size="icon"
              variant="ghost"
              className="size-8 text-muted-foreground hover:text-foreground"
              title="Expand sidebar"
              onClick={() => setLeftCollapsed(false)}
            >
              <IconLayoutSidebarLeftExpand className="size-4" />
            </Button>
            <div className="w-6 h-px bg-border my-1" />
            <Tooltip>
              <TooltipTrigger
                type="button"
                className="size-8 flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-muted"
                onClick={() => {
                  setLeftCollapsed(false);
                  setSidebarTab("services");
                }}
              >
                <IconServer className="size-4" />
              </TooltipTrigger>
              <TooltipContent side="right">Services</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger
                type="button"
                className="size-8 flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-muted"
                onClick={() => {
                  setLeftCollapsed(false);
                  setSidebarTab("presets");
                }}
              >
                <IconBookmark className="size-4" />
              </TooltipTrigger>
              <TooltipContent side="right">Presets</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger
                type="button"
                className="size-8 flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-muted"
                onClick={() => {
                  setLeftCollapsed(false);
                  setSidebarTab("history");
                }}
              >
                <IconHistory className="size-4" />
              </TooltipTrigger>
              <TooltipContent side="right">Session History</TooltipContent>
            </Tooltip>
          </div>

          {/* Expanded Sidebar Content */}
          <div
            className={cn(
              "flex flex-col h-full overflow-hidden transition-opacity duration-150",
              leftCollapsed ? "opacity-0 pointer-events-none" : "opacity-100"
            )}
            style={{ width: leftWidth }}
          >
            {/* Environment & Header */}
            <div className="p-3 border-b flex flex-col gap-2 shrink-0 bg-card/60">
              <div className="flex items-center justify-between">
                <Label className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">
                  Target Environment
                </Label>
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-6 text-muted-foreground hover:text-foreground"
                  title="Collapse sidebar"
                  onClick={() => setLeftCollapsed(true)}
                >
                  <IconLayoutSidebarLeftCollapse className="size-3.5" />
                </Button>
              </div>
              <Select value={selectedEnv} onValueChange={(v) => { if (v) setSelectedEnv(v); }}>
                <SelectTrigger className="w-full h-8 text-xs font-medium">
                  <SelectValue placeholder="Select environment…" />
                </SelectTrigger>
                <SelectContent>
                  {initialEnvs.map((e) => (
                    <SelectItem key={e.environment} value={e.environment}>
                      <div className="flex items-center justify-between w-full gap-2">
                        <span>{e.environment}</span>
                        {!e.hasAppKey && (
                          <Badge variant="destructive" className="text-[10px] px-1 py-0">no key</Badge>
                        )}
                      </div>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Entity Search & Add */}
            <div className="p-3 border-b flex flex-col gap-2 shrink-0">
              <div className="flex items-center justify-between">
                <Label className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">
                  Browse Entities
                </Label>
                <Badge variant="secondary" className="text-[10px] font-mono">
                  {entityList.length} available
                </Badge>
              </div>
              <div className="flex gap-1.5">
                <Select value={searchType} onValueChange={(v) => { if (v) setSearchType(v); }}>
                  <SelectTrigger className="w-28 h-8 text-xs font-mono shrink-0">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {ENTITY_TYPES.map((t) => (
                      <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <div className="flex-1 min-w-0">
                  <Combobox
                    inputValue={comboInput}
                    onInputValueChange={(v) => setComboInput(v)}
                    onValueChange={(v) => {
                      if (v) {
                        addToWorkingSet({ entityType: searchType, entityName: String(v) });
                        activateItem({ entityType: searchType, entityName: String(v) });
                        setComboInput("");
                      }
                    }}
                  >
                    <ComboboxInput
                      placeholder={entityLoading ? "Loading…" : `Search ${searchType}…`}
                      showClear
                      disabled={!selectedEnv}
                      className="w-full h-8 text-xs font-mono"
                    />
                    <ComboboxContent>
                      <ComboboxList>
                        {filteredEntities.map((e) => (
                          <ComboboxItem key={e.name} value={e.name} className="text-xs font-mono">
                            {e.name}
                          </ComboboxItem>
                        ))}
                        <ComboboxEmpty>
                          {entityLoading ? "Loading…" : entityError ? entityError : "No entities found."}
                        </ComboboxEmpty>
                      </ComboboxList>
                    </ComboboxContent>
                  </Combobox>
                </div>
              </div>
            </div>

            {/* Working Set Pills */}
            {workingSet.length > 0 && (
              <div className="p-2.5 border-b flex flex-col gap-1.5 shrink-0 bg-muted/20">
                <div className="flex items-center justify-between">
                  <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
                    Working Set ({workingSet.length})
                  </span>
                  <button
                    onClick={() => {
                      setWorkingSet([]);
                      setActiveItem(null);
                      setServiceDefs([]);
                    }}
                    className="text-[10px] text-muted-foreground hover:text-destructive transition-colors"
                  >
                    Clear all
                  </button>
                </div>
                <div className="flex flex-col gap-1 max-h-36 overflow-y-auto">
                  {workingSet.map((item) => {
                    const isActive = activeItem?.entityName === item.entityName && activeItem.entityType === item.entityType;
                    return (
                      <div
                        key={`${item.entityType}/${item.entityName}`}
                        className={cn(
                          "flex items-center justify-between px-2 py-1 rounded-md text-xs font-mono cursor-pointer group transition-colors",
                          isActive
                            ? "bg-primary text-primary-foreground font-semibold shadow-xs"
                            : "bg-background border hover:border-primary/40 text-foreground"
                        )}
                        onClick={() => activateItem(item)}
                      >
                        <div className="flex items-center gap-1.5 truncate">
                          <span className="truncate">{item.entityName}</span>
                          <span className={cn("text-[10px] shrink-0", isActive ? "text-primary-foreground/80" : "text-muted-foreground")}>
                            ({item.entityType})
                          </span>
                        </div>
                        <Button
                          size="icon"
                          variant="ghost"
                          className={cn(
                            "size-4 opacity-0 group-hover:opacity-100 p-0 hover:bg-transparent",
                            isActive ? "text-primary-foreground hover:text-white" : "text-muted-foreground hover:text-destructive"
                          )}
                          onClick={(e) => {
                            e.stopPropagation();
                            removeFromWorkingSet(item);
                          }}
                        >
                          <IconX className="size-3" />
                        </Button>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Sidebar Sub-Tabs: Services / Presets / History */}
            <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
              <div className="px-3 pt-2 pb-1 border-b flex items-center justify-between shrink-0 bg-card/40">
                <Tabs value={sidebarTab} onValueChange={(v) => setSidebarTab(v as typeof sidebarTab)} className="w-full">
                  <TabsList className="w-full grid grid-cols-3 h-7 bg-muted/60 p-0.5">
                    <TabsTrigger value="services" className="text-[11px] h-6 px-1">
                      Services
                    </TabsTrigger>
                    <TabsTrigger value="presets" className="text-[11px] h-6 px-1">
                      Presets
                    </TabsTrigger>
                    <TabsTrigger value="history" className="text-[11px] h-6 px-1">
                      History ({history.length})
                    </TabsTrigger>
                  </TabsList>
                </Tabs>
              </div>

              {/* ── Services Tab ── */}
              {sidebarTab === "services" && (
                <div className="flex-1 flex flex-col min-h-0 p-3 gap-2 overflow-hidden">
                  {!activeItem ? (
                    <div className="flex flex-col items-center justify-center h-full text-center p-4 text-muted-foreground">
                      <IconServer className="size-8 mb-2 opacity-40" />
                      <p className="text-xs">Select or add an entity above to browse its services.</p>
                    </div>
                  ) : defsLoading ? (
                    <div className="flex flex-col items-center justify-center h-full gap-2 text-xs text-muted-foreground">
                      <Spinner className="size-5" />
                      <span>Fetching services…</span>
                    </div>
                  ) : defsError ? (
                    <div className="p-3 rounded-lg border border-destructive/30 bg-destructive/5 text-destructive text-xs">
                      {defsError}
                    </div>
                  ) : (
                    <>
                      {/* Search & Category Filter */}
                      <div className="flex items-center gap-1.5 shrink-0">
                        <div className="relative flex-1 min-w-0">
                          <IconSearch className="size-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
                          <Input
                            placeholder="Filter services…"
                            value={serviceFilter}
                            onChange={(e) => setServiceFilter(e.target.value)}
                            className="h-8 text-xs pl-8 pr-7 w-full"
                          />
                          {serviceFilter && (
                            <button
                              onClick={() => setServiceFilter("")}
                              className="size-4 absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                            >
                              <IconX className="size-3" />
                            </button>
                          )}
                        </div>

                        {serviceCategories.length > 1 && (
                          <Select
                            value={serviceCategoryFilter || "__all__"}
                            onValueChange={(v) => { if (v) setServiceCategoryFilter(v === "__all__" ? "" : v); }}
                          >
                            <SelectTrigger className="w-32 h-8 text-xs shrink-0">
                              <SelectValue placeholder="All Categories" />
                            </SelectTrigger>
                            <SelectContent className="max-h-60">
                              <SelectItem value="__all__">All Categories</SelectItem>
                              {serviceCategories.map((c) => (
                                <SelectItem key={c} value={c}>{c}</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        )}
                      </div>

                      {/* Services List */}
                      <div ref={servicesListRef} className="flex-1 overflow-y-auto flex flex-col gap-1 pr-1">
                        {visibleServices
                          .map((d) => {
                            const isSelected = multiSel.length > 0 ? multiSel.includes(d.name) : selectedService === d.name;
                            const returnType = d.resultType?.baseType ?? "VOID";
                            const paramCount = d.parameterDefinitions?.length ?? 0;
                            return (
                              <button
                                key={d.name}
                                data-service={d.name}
                                onClick={(e) => onServiceClick(e, d.name)}
                                draggable
                                onDragStart={(e) => {
                                  const names = multiSel.includes(d.name) ? multiSel : [d.name];
                                  setDragPins(e, servicePins(names));
                                }}
                                onContextMenu={(e) => {
                                  e.preventDefault();
                                  setSvcMenu({ x: e.clientX, y: e.clientY, names: multiSel.includes(d.name) ? multiSel : [d.name] });
                                }}
                                className={cn(
                                  "flex flex-col items-start px-2.5 py-2 rounded-lg text-left cursor-pointer border transition-all group",
                                  isSelected
                                    ? "bg-primary/10 border-primary/40 text-primary shadow-2xs font-medium"
                                    : "bg-card/60 border-transparent hover:bg-muted/60 hover:border-border text-foreground"
                                )}
                              >
                                <div className="flex items-center justify-between w-full gap-2">
                                  <span className="font-mono text-xs truncate font-semibold">{d.name}</span>
                                  <Badge
                                    variant="outline"
                                    className={cn("text-[9px] font-mono px-1 py-0 shrink-0", getBaseTypeBadgeColor(returnType))}
                                  >
                                    {returnType}
                                  </Badge>
                                </div>
                                <div className="flex items-center gap-2 mt-1 text-[10px] text-muted-foreground">
                                  <span>{paramCount} param{paramCount !== 1 ? "s" : ""}</span>
                                  {d.category && (
                                    <>
                                      <span>•</span>
                                      <span className="truncate max-w-28">{d.category}</span>
                                    </>
                                  )}
                                </div>
                              </button>
                            );
                          })}
                        {serviceDefs.length === 0 && (
                          <p className="text-xs text-muted-foreground text-center py-6">No services available.</p>
                        )}
                        {svcMenu && (
                          <div
                            data-svc-menu
                            className="fixed z-50 min-w-40 rounded-lg border bg-popover p-1 text-popover-foreground shadow-md"
                            style={{ left: svcMenu.x, top: svcMenu.y }}
                          >
                            <button
                              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-accent"
                              onClick={() => {
                                addPins(servicePins(svcMenu.names));
                                setSvcMenu(null);
                              }}
                            >
                              <IconMessagePlus className="size-3.5" />
                              Add {svcMenu.names.length > 1 ? `${svcMenu.names.length} services` : "service"} to chat
                            </button>
                          </div>
                        )}
                      </div>
                    </>
                  )}
                </div>
              )}

              {/* ── Presets Tab ── */}
              {sidebarTab === "presets" && (
                <div className="flex-1 flex flex-col min-h-0 p-3 gap-2 overflow-hidden">
                  <div className="flex items-center justify-between shrink-0">
                    <span className="text-xs font-semibold text-muted-foreground">Scope:</span>
                    <div className="flex rounded-md border bg-muted/40 p-0.5">
                      <button
                        className={cn(
                          "px-2 py-0.5 text-[10px] font-medium rounded transition-colors",
                          presetScope === "service" ? "bg-background text-foreground shadow-2xs" : "text-muted-foreground hover:text-foreground"
                        )}
                        onClick={() => setPresetScope("service")}
                      >
                        This Service
                      </button>
                      <button
                        className={cn(
                          "px-2 py-0.5 text-[10px] font-medium rounded transition-colors",
                          presetScope === "all" ? "bg-background text-foreground shadow-2xs" : "text-muted-foreground hover:text-foreground"
                        )}
                        onClick={() => setPresetScope("all")}
                      >
                        All ({envPresets.length})
                      </button>
                    </div>
                  </div>

                  <div className="flex-1 overflow-y-auto flex flex-col gap-1.5 pr-1">
                    {visiblePresets.length === 0 && (
                      <div className="flex flex-col items-center justify-center h-full text-center p-4 text-muted-foreground">
                        <IconBookmark className="size-8 mb-2 opacity-40" />
                        <p className="text-xs">No presets found.</p>
                      </div>
                    )}
                    {visiblePresets.map((preset) => (
                      <div
                        key={preset.id}
                        className="p-2.5 rounded-lg border bg-card/60 hover:bg-muted/60 transition-colors flex flex-col gap-1.5 group"
                      >
                        <div className="flex items-start justify-between gap-2">
                          <button
                            className="text-left font-semibold text-xs truncate flex-1 hover:text-primary transition-colors"
                            onClick={() => loadPreset(preset)}
                          >
                            {preset.name}
                          </button>
                          <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                            {currentServiceDef && (
                              <Tooltip>
                                <TooltipTrigger
                                  type="button"
                                  className="size-5 flex items-center justify-center text-muted-foreground hover:text-foreground"
                                  onClick={() => applyPresetInputsToCurrent(preset)}
                                >
                                  <IconWand className="size-3.5 text-primary" />
                                </TooltipTrigger>
                                <TooltipContent side="top">Map inputs to current service</TooltipContent>
                              </Tooltip>
                            )}
                            <AlertDialog>
                              <AlertDialogTrigger
                                render={
                                  <Button
                                    size="icon"
                                    variant="ghost"
                                    className="size-5 text-muted-foreground hover:text-destructive p-0"
                                  />
                                }
                              >
                                <IconTrash className="size-3.5" />
                              </AlertDialogTrigger>
                              <AlertDialogContent>
                                <AlertDialogHeader>
                                  <AlertDialogTitle>Delete preset &ldquo;{preset.name}&rdquo;?</AlertDialogTitle>
                                  <AlertDialogDescription>This action cannot be undone.</AlertDialogDescription>
                                </AlertDialogHeader>
                                <AlertDialogFooter>
                                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                                  <AlertDialogAction onClick={() => removePreset(preset.id)}>Delete</AlertDialogAction>
                                </AlertDialogFooter>
                              </AlertDialogContent>
                            </AlertDialog>
                          </div>
                        </div>
                        <div className="flex items-center justify-between text-[10px] text-muted-foreground">
                          <span className="truncate max-w-40 font-mono">
                            {preset.entityName} / {preset.serviceName}
                          </span>
                          {preset.outputType && (
                            <Badge variant="outline" className="text-[9px] font-mono px-1 py-0">
                              {preset.outputType}
                            </Badge>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* ── History Tab ── */}
              {sidebarTab === "history" && (
                <div className="flex-1 flex flex-col min-h-0 p-3 gap-2 overflow-hidden">
                  <div className="flex items-center justify-between shrink-0">
                    <span className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">
                      Recent Runs
                    </span>
                    {history.length > 0 && (
                      <button
                        onClick={() => setHistory([])}
                        className="text-[10px] text-muted-foreground hover:text-destructive transition-colors"
                      >
                        Clear history
                      </button>
                    )}
                  </div>

                  <div className="flex-1 overflow-y-auto flex flex-col gap-1.5 pr-1">
                    {history.length === 0 && (
                      <div className="flex flex-col items-center justify-center h-full text-center p-4 text-muted-foreground">
                        <IconClock className="size-8 mb-2 opacity-40" />
                        <p className="text-xs">No runs recorded in this session yet.</p>
                      </div>
                    )}
                    {history.map((item) => (
                      <div
                        key={item.id}
                        onClick={() => {
                          const wsItem = { entityType: item.entityType, entityName: item.entityName };
                          addToWorkingSet(wsItem);
                          activateItem(wsItem, item.environment);
                          pendingServiceRef.current = item.serviceName;
                          pendingInputsRef.current = item.inputs;
                          if (item.output) {
                            setExecResult(item.output);
                            setExecOutputType(item.outputType);
                          }
                          toast.info(`Restored run of ${item.serviceName}`);
                        }}
                        className="p-2.5 rounded-lg border bg-card/60 hover:bg-muted/60 transition-colors cursor-pointer flex flex-col gap-1"
                      >
                        <div className="flex items-center justify-between gap-1.5">
                          <span className="font-mono text-xs font-semibold truncate">{item.serviceName}</span>
                          <Badge
                            variant={item.isError ? "destructive" : "default"}
                            className="text-[9px] px-1 py-0 font-mono"
                          >
                            {item.isError ? "Error" : formatDuration(item.durationMs)}
                          </Badge>
                        </div>
                        <div className="flex items-center justify-between text-[10px] text-muted-foreground">
                          <span className="truncate font-mono">{item.entityName}</span>
                          <span>{new Date(item.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Left resize handle */}
        {!leftCollapsed && (
          <div
            className="w-1 shrink-0 bg-border hover:bg-primary/50 cursor-col-resize transition-colors"
            onMouseDown={handleLeftDragStart}
          />
        )}

        {/* ── Center & Right Panels (Request Form / Raw JSON + Output Inspector) ── */}
        <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
          {!activeItem || !selectedService ? (
            <div className="flex flex-1 items-center justify-center p-8">
              <Empty className="max-w-md border border-dashed rounded-xl p-8 bg-card/40">
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <IconServer className="size-6 text-primary" />
                  </EmptyMedia>
                  <EmptyTitle className="text-base font-semibold">ThingWorx Services Workbench</EmptyTitle>
                  <EmptyDescription className="text-xs">
                    Select an entity and a service from the left sidebar to start inspecting parameters, generating payloads, and testing live responses.
                  </EmptyDescription>
                </EmptyHeader>
                <EmptyContent>
                  <div className="grid grid-cols-2 gap-2 text-left w-full mt-2">
                    <div className="p-2.5 rounded-lg border bg-background text-[11px] flex flex-col gap-0.5">
                      <span className="font-semibold">⚡ Fast Execution</span>
                      <span className="text-muted-foreground">Run with <kbd className="font-mono text-[10px] px-1 py-0.5 bg-muted rounded">⌘↵</kbd></span>
                    </div>
                    <div className="p-2.5 rounded-lg border bg-background text-[11px] flex flex-col gap-0.5">
                      <span className="font-semibold">📥 Insert Outputs</span>
                      <span className="text-muted-foreground">Pipe data across services</span>
                    </div>
                  </div>
                </EmptyContent>
              </Empty>
            </div>
          ) : (
            <div
              className={cn(
                "flex-1 flex min-h-0 overflow-hidden",
                layoutMode === "vertical" ? "flex-col" : "flex-row"
              )}
            >
              {/* ── Request Parameters Panel ── */}
              <div
                className={cn(
                  "border-r flex flex-col min-h-0 overflow-hidden bg-card/20 shrink-0",
                  layoutMode === "vertical" ? "border-r-0 border-b w-full h-1/2" : ""
                )}
                style={layoutMode === "horizontal" ? { width: inputWidth } : undefined}
              >
                {/* Parameters Header */}
                <div className="px-3.5 py-2.5 border-b bg-card/60 flex items-center justify-between gap-2 shrink-0">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                      Input Parameters
                    </span>
                    {sortedParams.length > 0 && (
                      <Badge variant="secondary" className="text-[10px] font-mono">
                        {sortedParams.length}
                      </Badge>
                    )}
                  </div>

                  <div className="flex items-center gap-1.5">
                    {/* Form vs Raw JSON toggle */}
                    <div className="flex rounded-md border bg-muted/40 p-0.5">
                      <button
                        className={cn(
                          "px-2 py-0.5 text-[10px] font-medium rounded transition-colors",
                          inputMode === "form" ? "bg-background text-foreground shadow-2xs" : "text-muted-foreground hover:text-foreground"
                        )}
                        onClick={() => setInputMode("form")}
                      >
                        Form
                      </button>
                      <button
                        className={cn(
                          "px-2 py-0.5 text-[10px] font-medium rounded transition-colors",
                          inputMode === "raw" ? "bg-background text-foreground shadow-2xs" : "text-muted-foreground hover:text-foreground"
                        )}
                        onClick={() => setInputMode("raw")}
                      >
                        JSON
                      </button>
                    </div>

                    <Button
                      size="icon"
                      variant="ghost"
                      className="size-7 text-muted-foreground hover:text-foreground"
                      title="Add inputs to chat"
                      aria-label="Add inputs to chat"
                      onClick={pinInputs}
                    >
                      <IconMessagePlus className="size-3.5" />
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 text-xs px-2 text-muted-foreground hover:text-foreground"
                      title="Reset all inputs"
                      onClick={handleClearAll}
                    >
                      Reset
                    </Button>
                  </div>
                </div>

                {/* Parameters Body */}
                <div className="flex-1 overflow-y-auto p-3.5 flex flex-col gap-3 min-h-0">
                  {currentServiceDef?.description && (
                    <div className="p-2.5 rounded-lg border bg-muted/30 text-xs text-muted-foreground leading-relaxed">
                      {currentServiceDef.description}
                    </div>
                  )}

                  {inputMode === "raw" ? (
                    <div className="flex-1 flex flex-col min-h-0 border rounded-lg overflow-hidden bg-background">
                      <MonacoEditor
                        className="min-w-0"
                        height="100%"
                        language="json"
                        value={JSON.stringify(currentPayloadObj, null, 2)}
                        onChange={(val) => {
                          try {
                            const parsed = JSON.parse(val || "{}") as Record<string, unknown>;
                            const strMap: Record<string, string> = {};
                            Object.entries(parsed).forEach(([k, v]) => {
                              strMap[k] = typeof v === "object" && v !== null ? JSON.stringify(v) : String(v);
                            });
                            setInputValues(strMap);
                          } catch { /* wait for valid json */ }
                        }}
                        theme={resolvedTheme === "dark" ? "vs-dark" : "light"}
                        options={{
                          minimap: { enabled: false },
                          fontSize: 12,
                          wordWrap: "on",
                          scrollBeyondLastLine: false,
                          lineNumbers: "on",
                        }}
                      />
                    </div>
                  ) : sortedParams.length === 0 ? (
                    <div className="flex flex-col items-center justify-center h-48 border border-dashed rounded-lg text-center p-4 text-muted-foreground">
                      <p className="text-xs">This service requires no input parameters.</p>
                    </div>
                  ) : (
                    sortedParams.map((param) => (
                      <ServiceInputField
                        key={param.name}
                        param={param}
                        value={inputValues[param.name] ?? ""}
                        onChange={(v) => setInputValues((prev) => ({ ...prev, [param.name]: v }))}
                        onClear={() =>
                          setInputValues((prev) => ({
                            ...prev,
                            [param.name]: param.baseType === "BOOLEAN" ? "false" : "",
                          }))
                        }
                        onOpenPicker={() => setPickerParam(param)}
                      />
                    ))
                  )}

                  {execError && (
                    <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive flex flex-col gap-1">
                      <span className="font-semibold">Execution Error:</span>
                      <pre className="font-mono text-[11px] whitespace-pre-wrap">{execError}</pre>
                    </div>
                  )}
                </div>
              </div>

              {/* Input resize handle */}
              {layoutMode === "horizontal" && (
                <div
                  className="w-1 shrink-0 bg-border hover:bg-primary/50 cursor-col-resize transition-colors"
                  onMouseDown={handleInputDragStart}
                />
              )}

              {/* ── Output / Response Inspector Panel ── */}
              <div className="flex-1 flex flex-col min-w-0 overflow-hidden bg-card/10">
                {/* Response Status Bar */}
                <div className="px-4 py-2 border-b bg-card/60 flex items-center justify-between gap-3 shrink-0 flex-wrap">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                      Response
                    </span>

                    {execResult !== null && (
                      <Badge variant="default" className="bg-emerald-600 text-white font-mono text-[10px] px-1.5 py-0">
                        200 OK
                      </Badge>
                    )}

                    {execOutputType && (
                      <Badge variant="outline" className={cn("font-mono text-[10px] uppercase", getBaseTypeBadgeColor(execOutputType))}>
                        {execOutputType}
                      </Badge>
                    )}

                    {execElapsedMs !== null && (
                      <Badge variant="secondary" className="font-mono text-[10px] gap-1">
                        <IconClock className="size-3" />
                        {formatDuration(execElapsedMs)}
                      </Badge>
                    )}

                    {rawOutput && (
                      <Badge variant="outline" className="font-mono text-[10px] text-muted-foreground">
                        {formatBytes(outputByteSize)}
                      </Badge>
                    )}

                    {infoTableMeta && (
                      <Badge variant="secondary" className="font-mono text-[10px]">
                        {infoTableMeta.rowCount} rows × {infoTableMeta.colCount} cols
                      </Badge>
                    )}
                  </div>

                  {/* Response Actions */}
                  {(execResult !== null || execError) && (
                    <div className="flex items-center gap-1.5">
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 text-xs gap-1.5 px-2.5"
                        title={execError ? "Add error to chat" : "Add result to chat (selected rows if any)"}
                        onClick={pinResult}
                      >
                        <IconMessagePlus className="size-3.5" />
                        <span className="hidden sm:inline">Add to chat</span>
                      </Button>
                      {execResult !== null && (<>
                      {isInfoTable && (
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 text-xs gap-1.5 px-2.5"
                          onClick={() =>
                            exportInfotableToCsv(
                              execResult,
                              `${activeItem?.entityName ?? "entity"}_${selectedService ?? "service"}.csv`
                            )
                          }
                        >
                          <IconFileSpreadsheet className="size-3.5 text-emerald-600 dark:text-emerald-400" />
                          <span className="hidden sm:inline">Export CSV</span>
                        </Button>
                      )}

                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 text-xs gap-1.5 px-2.5"
                        onClick={async () => {
                          try {
                            await navigator.clipboard.writeText(rawOutput);
                            toast.success("Response copied to clipboard");
                          } catch {
                            toast.error("Failed to copy");
                          }
                        }}
                      >
                        <IconCopy className="size-3.5" />
                        <span className="hidden sm:inline">Copy</span>
                      </Button>

                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 text-xs gap-1.5 px-2.5"
                        onClick={() => {
                          const blob = new Blob([rawOutput], { type: "application/json" });
                          const url = URL.createObjectURL(blob);
                          const a = document.createElement("a");
                          a.href = url;
                          a.download = `${activeItem?.entityName ?? "output"}_${selectedService ?? "result"}.json`;
                          a.click();
                          URL.revokeObjectURL(url);
                          toast.success("Downloaded JSON result");
                        }}
                      >
                        <IconDownload className="size-3.5" />
                        <span className="hidden sm:inline">Download</span>
                      </Button>
                      </>)}
                    </div>
                  )}
                </div>

                {/* Response Content */}
                <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
                  {execResult === null && !execLoading ? (
                    <div className="flex flex-1 items-center justify-center p-8">
                      <Empty className="max-w-xs border border-dashed rounded-xl p-6 bg-card/20">
                        <EmptyHeader>
                          <EmptyMedia variant="icon">
                            <IconPlayerPlay className="size-5 text-muted-foreground" />
                          </EmptyMedia>
                          <EmptyTitle>No Response Yet</EmptyTitle>
                          <EmptyDescription>
                            Click <strong className="text-foreground">Run</strong> or press <kbd className="font-mono text-[10px] px-1 py-0.5 bg-muted rounded">⌘↵</kbd> to execute this service.
                          </EmptyDescription>
                        </EmptyHeader>
                      </Empty>
                    </div>
                  ) : execLoading ? (
                    <div className="flex flex-1 flex-col items-center justify-center gap-3">
                      <Spinner className="size-8 text-primary" />
                      <div className="flex flex-col items-center gap-1">
                        <span className="text-sm font-semibold">Executing Service…</span>
                        <span className="text-xs font-mono text-primary">{formatDuration(execLiveElapsedMs)}</span>
                      </div>
                    </div>
                  ) : (
                    <Tabs defaultValue={isInfoTable ? "table" : "json"} className="flex flex-col h-full overflow-hidden">
                      <div className="px-3 border-b bg-card/40 flex items-center justify-between shrink-0">
                        <TabsList className="h-8 bg-transparent p-0 gap-2">
                          {isInfoTable && (
                            <TabsTrigger
                              value="table"
                              className="text-xs font-medium data-[state=active]:bg-background data-[state=active]:shadow-2xs rounded-md h-7 px-3"
                            >
                              Table View
                            </TabsTrigger>
                          )}
                          <TabsTrigger
                            value="json"
                            className="text-xs font-medium data-[state=active]:bg-background data-[state=active]:shadow-2xs rounded-md h-7 px-3"
                          >
                            Raw JSON
                          </TabsTrigger>
                        </TabsList>
                      </div>

                      {isInfoTable && (
                        <TabsContent value="table" className="flex-1 min-h-0 m-0 p-0 overflow-hidden bg-background">
                          <InfoTableView data={execResult} onSelectedRows={setResultRows} />
                        </TabsContent>
                      )}

                      <TabsContent value="json" className="flex-1 min-h-0 m-0 p-0 overflow-hidden bg-background">
                        <MonacoEditor
                          className="min-w-0"
                          height="100%"
                          language="json"
                          value={rawOutput}
                          theme={resolvedTheme === "dark" ? "vs-dark" : "light"}
                          options={{
                            readOnly: true,
                            minimap: { enabled: true },
                            fontSize: 12,
                            wordWrap: "on",
                            scrollBeyondLastLine: false,
                            lineNumbers: "on",
                          }}
                        />
                      </TabsContent>
                    </Tabs>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ── Save Preset Dialog ── */}
      <Dialog open={saveDialogOpen} onOpenChange={setSaveDialogOpen}>
        <DialogContent className="max-w-md p-5">
          <DialogHeader>
            <DialogTitle className="text-base font-semibold">Save Service Preset</DialogTitle>
          </DialogHeader>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const inputsObj: Record<string, unknown> = {};
              if (saveIncludeInputs) {
                sortedParams.forEach((p) => {
                  const raw = inputValues[p.name] ?? "";
                  const v = coerceInput(raw, p.baseType);
                  if (v !== undefined) inputsObj[p.name] = v;
                });
              }
              savePreset({
                id: editingPresetId,
                name: savePresetName,
                environment: selectedEnv,
                entityType: activeItem?.entityType ?? "",
                entityName: activeItem?.entityName ?? "",
                serviceName: selectedService,
                inputs: JSON.stringify(inputsObj),
                output: saveIncludeOutput ? rawOutput : "",
                outputType: saveIncludeOutput ? execOutputType : "",
              });
            }}
            className="flex flex-col gap-4 mt-2"
          >
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="preset-name" className="text-xs font-semibold">
                Preset Name
              </Label>
              <Input
                id="preset-name"
                value={savePresetName}
                onChange={(e) => setSavePresetName(e.target.value)}
                placeholder="e.g. Standard BOM Query"
                autoFocus
                className="h-8 text-xs font-mono"
              />
            </div>
            {saveMode === "both" && (
              <div className="flex flex-col gap-2 p-3 rounded-lg border bg-muted/20">
                <label className="flex items-center gap-2 text-xs font-medium cursor-pointer">
                  <Checkbox
                    checked={saveIncludeInputs}
                    onCheckedChange={(v) => setSaveIncludeInputs(!!v)}
                  />
                  <span>Save active parameter inputs</span>
                </label>
                <label className="flex items-center gap-2 text-xs font-medium cursor-pointer">
                  <Checkbox
                    checked={saveIncludeOutput}
                    onCheckedChange={(v) => setSaveIncludeOutput(!!v)}
                    disabled={!execResult}
                  />
                  <span>Save response output {!execResult && <span className="text-muted-foreground">(run service first)</span>}</span>
                </label>
              </div>
            )}
            {saveError && <p className="text-xs text-destructive font-medium">{saveError}</p>}
            <DialogFooter className="gap-2">
              <Button type="button" variant="outline" size="sm" onClick={() => setSaveDialogOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" size="sm" disabled={savePending || !savePresetName.trim()}>
                {savePending ? <Spinner className="size-3.5 mr-1.5" /> : <IconDeviceFloppy className="size-3.5 mr-1.5" />}
                Save Preset
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* ── Output → Input Picker Modal ── */}
      {pickerParam !== null && (
        <OutputValuePicker
          open
          onOpenChange={(o) => { if (!o) setPickerParam(null); }}
          targetParam={pickerParam}
          presets={envPresets.filter((p) => !!p.output)}
          liveOutput={execResult !== null ? { data: execResult, type: execOutputType } : null}
          onPick={(v) => {
            setInputValues((prev) => ({ ...prev, [pickerParam.name]: v }));
            setPickerParam(null);
            toast.success(`Inserted value into "${pickerParam.name}"`);
          }}
        />
      )}

      {/* ── Code Snippet Generator Dialog ── */}
      {codeDialogOpen && activeItem && selectedService && (
        <CodeSnippetDialog
          open={codeDialogOpen}
          onOpenChange={setCodeDialogOpen}
          env={selectedEnv}
          twxBaseUrl={activeEnvRecord?.twxBaseUrl}
          entityType={activeItem.entityType}
          entityName={activeItem.entityName}
          serviceName={selectedService}
          inputs={currentPayloadObj}
        />
      )}
    </div>
  );
}
