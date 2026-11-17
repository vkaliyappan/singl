"use client";

import { useState, useMemo, useEffect, useRef, useCallback } from "react";
import { addPins, usePinnables, type NewPin, type Pinnable } from "@/lib/assistant/pins";
import { setDragPins } from "@/lib/assistant/drag";
import { PIN_LIMIT, clipJson, clipText } from "@/lib/assistant/pin-utils";
import dynamic from "next/dynamic";
import { useTheme } from "@/components/providers";
import {
  IconBolt,
  IconAdjustmentsHorizontal,
  IconCode,
  IconFileCode,
  IconCopy,
  IconCheck,
  IconSearch,
  IconLayersLinked,
  IconDownload,
  IconRefresh,
  IconInfoCircle,
  IconDatabase,
  IconTag,
  IconHierarchy,
  IconMessagePlus,
} from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { save } from "@tauri-apps/plugin-dialog";
import { saveEntityAs } from "@/lib/entities";
import { errorMessage } from "@/lib/settings";
import {
  type ParsedTwxEntity,
  type ParsedService,
  getEntityTypeBadge,
} from "@/lib/twx/entity-xml-parser";

const MonacoEditor = dynamic(() => import("@monaco-editor/react"), {
  ssr: false,
  loading: () => (
    <div className="flex items-center justify-center h-36 text-muted-foreground text-xs font-mono">
      Loading code editor…
    </div>
  ),
});

interface EntityOverviewProps {
  entity: ParsedTwxEntity;
  filePath: string;
  /** Service to open on the Services tab, e.g. from a deep link. */
  initialService?: string;
  /** Opens the service's extracted script from the Code folder. */
  onOpenServiceCode?: (service: string) => void;
  onViewCodeClick?: () => void;
  /** Reports the service shown on the Services tab (for the assistant). */
  onServiceChange?: (service: string | null) => void;
  /** Exports this entity again from ThingWorx over its file. */
  onReexport?: () => Promise<void>;
}

export function EntityOverview({
  entity,
  filePath,
  initialService,
  onOpenServiceCode,
  onViewCodeClick,
  onServiceChange,
  onReexport,
}: EntityOverviewProps) {
  const [reexporting, setReexporting] = useState(false);
  const { resolvedTheme } = useTheme();
  const opensOnService = !!initialService && entity.services.some((s) => s.name === initialService);
  const [activeTab, setActiveTab] = useState<"overview" | "services" | "properties" | "subscriptions" | "config">(
    opensOnService ? "services" : "overview"
  );

  // Copy state
  const [copiedField, setCopiedField] = useState<string | null>(null);

  const handleCopy = (text: string, fieldName: string) => {
    navigator.clipboard.writeText(text);
    setCopiedField(fieldName);
    toast.success(`Copied ${fieldName}`);
    setTimeout(() => setCopiedField(null), 2000);
  };

  const handleDownloadXml = async () => {
    if (!entity.rawXml) return;
    try {
      const dest = await save({
        title: "Save entity XML",
        defaultPath: `${entity.name || "entity"}.xml`,
        filters: [{ name: "XML", extensions: ["xml"] }],
      });
      if (!dest) return; // cancelled
      await saveEntityAs(dest, entity.rawXml);
      toast.success(`Saved to ${dest}`);
    } catch (e) {
      toast.error(`Save failed: ${errorMessage(e)}`);
    }
  };

  // ── Filter State ──────────────────────────────────────────────────────────
  const [serviceSearch, setServiceSearch] = useState("");
  const [serviceCategory, setServiceCategory] = useState<string>("__all__");
  const [selectedServiceName, setSelectedServiceName] = useState<string | null>(
    opensOnService ? initialService : null
  );

  const [propertySearch, setPropertySearch] = useState("");
  const [propertyTypeFilter, setPropertyTypeFilter] = useState<string>("__all__");

  // Multi-selection for "Add to chat" (Ctrl/Shift click), plus the right-click menu.
  const [svcSel, setSvcSel] = useState<string[]>([]);
  const [propSel, setPropSel] = useState<string[]>([]);
  const svcAnchor = useRef<string | null>(null);
  const propAnchor = useRef<string | null>(null);
  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    kind: "service" | "property" | "entity";
    names: string[];
  } | null>(null);

  const selectedService: ParsedService | null = useMemo(() => {
    if (selectedServiceName) {
      const match = entity.services.find((s) => s.name === selectedServiceName);
      if (match) return match;
    }
    return entity.services.length > 0 ? entity.services[0] : null;
  }, [entity.services, selectedServiceName]);

  const reportedService = selectedService?.name ?? null;
  useEffect(() => {
    onServiceChange?.(reportedService);
  }, [reportedService, onServiceChange]);

  // Unique categories for services
  const serviceCategories = useMemo(() => {
    const cats = new Set<string>();
    entity.services.forEach((s) => {
      if (s.category) cats.add(s.category);
    });
    return Array.from(cats).sort();
  }, [entity.services]);

  // Unique baseTypes for properties
  const propertyTypes = useMemo(() => {
    const types = new Set<string>();
    entity.properties.forEach((p) => {
      if (p.baseType) types.add(p.baseType);
    });
    return Array.from(types).sort();
  }, [entity.properties]);

  // Filtered Services
  const filteredServices = useMemo(() => {
    return entity.services.filter((s) => {
      const matchesSearch =
        !serviceSearch.trim() ||
        s.name.toLowerCase().includes(serviceSearch.toLowerCase()) ||
        s.description.toLowerCase().includes(serviceSearch.toLowerCase()) ||
        (s.script && s.script.toLowerCase().includes(serviceSearch.toLowerCase()));
      const matchesCategory =
        serviceCategory === "__all__" || s.category === serviceCategory;
      return matchesSearch && matchesCategory;
    });
  }, [entity.services, serviceSearch, serviceCategory]);

  // Filtered Properties
  const filteredProperties = useMemo(() => {
    return entity.properties.filter((p) => {
      const matchesSearch =
        !propertySearch.trim() ||
        p.name.toLowerCase().includes(propertySearch.toLowerCase()) ||
        p.description.toLowerCase().includes(propertySearch.toLowerCase());
      const matchesType =
        propertyTypeFilter === "__all__" || p.baseType === propertyTypeFilter;
      return matchesSearch && matchesType;
    });
  }, [entity.properties, propertySearch, propertyTypeFilter]);

  const badgeInfo = getEntityTypeBadge(entity.entityType);

  // ── Add to chat ───────────────────────────────────────────────────────────
  const entityLabel = `${entity.entityType}:${entity.name}`;

  const entityPin = useCallback(
    (): NewPin => ({
      kind: "entity",
      label: entityLabel,
      screen: "twx-entities",
      detail: `${entity.services.length} services · ${entity.properties.length} properties`,
      content: clipJson({
        type: entity.entityType,
        name: entity.name,
        project: entity.projectName,
        description: entity.description,
        baseTemplate: entity.baseThingTemplate,
        implementedShapes: entity.implementedShapes,
        tags: entity.tags,
        file: filePath,
        services: entity.services.map((s) => s.name),
        properties: entity.properties.map((p) => `${p.name}: ${p.baseType}`),
        subscriptions: entity.subscriptions.map((s) => `${s.name} (${s.eventName})`),
      }),
    }),
    [entity, entityLabel, filePath]
  );

  const servicePins = useCallback(
    (names: string[]): NewPin[] =>
      names.flatMap((name) => {
        const s = entity.services.find((x) => x.name === name);
        if (!s) return [];
        return [
          {
            kind: "service",
            label: `${entity.name}.${s.name}`,
            screen: "twx-entities",
            detail: `${s.parameters.length} params → ${s.resultType.baseType}${s.script ? "" : " · no script"}`,
            content: clipJson(
              {
                entity: entityLabel,
                project: entity.projectName,
                name: s.name,
                description: s.description,
                category: s.category,
                parameters: s.parameters,
                resultType: s.resultType,
                handler: s.handlerName,
                isAsync: s.isAsync,
                code: s.script ? clipText(s.script, 30 * 1024) : undefined,
              },
              PIN_LIMIT
            ),
          },
        ];
      }),
    [entity, entityLabel]
  );

  const propertyPins = useCallback(
    (names: string[]): NewPin[] =>
      names.flatMap((name) => {
        const p = entity.properties.find((x) => x.name === name);
        if (!p) return [];
        return [
          {
            kind: "property",
            label: `${entity.name}.${p.name}`,
            screen: "twx-entities",
            detail: p.baseType,
            content: clipJson({
              entity: entityLabel,
              name: p.name,
              baseType: p.baseType,
              dataShape: p.dataShape,
              description: p.description,
              value: p.defaultValue,
              persistent: p.isPersistent,
              logged: p.isLogged,
              readOnly: p.isReadOnly,
              aspects: p.aspects,
            }),
          },
        ];
      }),
    [entity, entityLabel]
  );

  const pinServiceNames = svcSel.length > 0 ? svcSel : selectedService ? [selectedService.name] : [];
  const pinPropNames = propSel.length > 0 ? propSel : [];

  const pinnables: Pinnable[] = [
    { kind: "entity", label: entityLabel, detail: "entity summary", content: () => entityPin().content },
  ];
  for (const name of pinServiceNames.slice(0, 10)) {
    pinnables.push({
      kind: "service",
      label: `${entity.name}.${name}`,
      detail: "service definition and code",
      content: () => servicePins([name])[0]?.content ?? "",
    });
  }
  for (const name of pinPropNames.slice(0, 10)) {
    pinnables.push({
      kind: "property",
      label: `${entity.name}.${name}`,
      detail: "property",
      content: () => propertyPins([name])[0]?.content ?? "",
    });
  }
  usePinnables(pinnables);

  /** Ctrl toggles, Shift selects a range from the anchor, plain click selects one. */
  const pickRow = (
    e: React.MouseEvent,
    name: string,
    list: string[],
    sel: string[],
    setSel: (v: string[]) => void,
    anchor: React.MutableRefObject<string | null>,
    single: (n: string) => void
  ) => {
    if (e.shiftKey && anchor.current) {
      const a = list.indexOf(anchor.current);
      const b = list.indexOf(name);
      if (a >= 0 && b >= 0) {
        setSel(list.slice(Math.min(a, b), Math.max(a, b) + 1));
        return;
      }
    }
    if (e.ctrlKey || e.metaKey) {
      const base = sel.length > 0 ? sel : anchor.current ? [anchor.current] : [];
      const next = base.includes(name) ? base.filter((n) => n !== name) : [...base, name];
      anchor.current = name;
      setSel(next);
      return;
    }
    anchor.current = name;
    setSel([]);
    single(name);
  };

  // Right-click menu; closes on any click elsewhere, Escape or scroll.
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("click", close);
    window.addEventListener("keydown", onKey);
    window.addEventListener("scroll", close, true);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", close, true);
    };
  }, [menu]);

  const menuPins = (m: NonNullable<typeof menu>) =>
    m.kind === "service" ? servicePins(m.names) : m.kind === "property" ? propertyPins(m.names) : [entityPin()];

  const addToChatBtn = (onClick: () => void, label = "Add to chat", title = "Add to the assistant chat") => (
    <Button size="xs" variant="outline" onClick={onClick} className="h-7 text-xs gap-1" title={title}>
      <IconMessagePlus className="size-3" />
      {label}
    </Button>
  );

  return (
    <div className="flex flex-col h-full overflow-hidden bg-background">
      {/* ── Entity Header Banner ────────────────────────────────────────────── */}
      <div
        className="shrink-0 border-b bg-card/60 px-6 py-4"
        onContextMenu={(e) => {
          e.preventDefault();
          setMenu({ x: e.clientX, y: e.clientY, kind: "entity", names: [entity.name] });
        }}
      >
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div className="flex items-start gap-3.5 min-w-0">
            {/* Entity Badge Icon */}
            <div
              className={cn(
                "flex size-11 shrink-0 items-center justify-center rounded-xl font-bold text-sm tracking-wider border shadow-xs",
                badgeInfo.bg,
                badgeInfo.text,
                badgeInfo.border
              )}
            >
              {badgeInfo.label}
            </div>

            <div className="flex flex-col gap-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <h2 className="text-lg font-bold text-foreground font-mono tracking-tight truncate">
                  {entity.name}
                </h2>
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() => handleCopy(entity.name, "Entity Name")}
                  className="h-6 w-6 p-0 text-muted-foreground hover:text-foreground"
                  title="Copy Entity Name"
                >
                  {copiedField === "Entity Name" ? (
                    <IconCheck className="size-3 text-emerald-500" />
                  ) : (
                    <IconCopy className="size-3" />
                  )}
                </Button>

                <Badge variant="outline" className="text-xs font-mono font-medium">
                  {entity.entityType}
                </Badge>

                {entity.projectName && (
                  <Badge variant="secondary" className="text-[11px]">
                    Project: {entity.projectName}
                  </Badge>
                )}
              </div>

              {entity.description && (
                <p className="text-xs text-muted-foreground line-clamp-2 max-w-3xl">
                  {entity.description}
                </p>
              )}

              {/* Hierarchy pills */}
              <div className="flex items-center gap-2 flex-wrap text-[11px] text-muted-foreground pt-0.5">
                {entity.baseThingTemplate && (
                  <span className="flex items-center gap-1 bg-muted/60 px-2 py-0.5 rounded-md border text-foreground/80">
                    <span className="text-muted-foreground">Template:</span>
                    <span className="font-mono font-medium">{entity.baseThingTemplate}</span>
                  </span>
                )}
                {entity.implementedShapes.length > 0 && (
                  <span className="flex items-center gap-1 bg-muted/60 px-2 py-0.5 rounded-md border text-foreground/80">
                    <span className="text-muted-foreground">Shapes:</span>
                    <span className="font-mono">{entity.implementedShapes.length} implemented</span>
                  </span>
                )}
              </div>
            </div>
          </div>

          {/* Quick Action Buttons */}
          <div className="flex items-center gap-2 shrink-0">
            <Button
              size="sm"
              variant="outline"
              draggable
              onDragStart={(e) => setDragPins(e, [entityPin()])}
              onClick={() => addPins([entityPin()])}
              title="Add this entity to the assistant chat (or drag it onto the assistant)"
              className="h-8 gap-1.5 text-xs"
            >
              <IconMessagePlus className="size-3.5" />
              Add to chat
            </Button>
            {onViewCodeClick && (
              <Button
                size="sm"
                variant="outline"
                onClick={onViewCodeClick}
                className="h-8 gap-1.5 text-xs"
              >
                <IconCode className="size-3.5" />
                Raw XML
              </Button>
            )}

            {onReexport && (
              <Button
                size="sm"
                variant="outline"
                disabled={reexporting}
                onClick={async () => {
                  setReexporting(true);
                  try {
                    await onReexport();
                  } finally {
                    setReexporting(false);
                  }
                }}
                title="Export this entity again from ThingWorx, replacing this file"
                className="h-8 gap-1.5 text-xs"
              >
                <IconRefresh className={reexporting ? "size-3.5 animate-spin" : "size-3.5"} />
                {reexporting ? "Exporting…" : "Export from ThingWorx"}
              </Button>
            )}

            <Button
              size="sm"
              variant="outline"
              onClick={handleDownloadXml}
              className="h-8 gap-1.5 text-xs"
            >
              <IconDownload className="size-3.5" />
              Save as…
            </Button>
          </div>
        </div>
      </div>

      {/* ── Main Tabbed Content ─────────────────────────────────────────────── */}
      <Tabs
        value={activeTab}
        onValueChange={(v) => setActiveTab(v as "overview" | "services" | "properties" | "subscriptions" | "config")}
        className="flex-1 flex flex-col min-h-0 overflow-hidden"
      >
        <div className="shrink-0 px-6 border-b bg-muted/20">
          <TabsList className="h-10 bg-transparent p-0 gap-6">
            <TabsTrigger
              value="overview"
              className="h-10 rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none text-xs gap-1.5 px-1 font-medium"
            >
              <IconInfoCircle className="size-3.5" />
              Overview
            </TabsTrigger>
            <TabsTrigger
              value="services"
              className="h-10 rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none text-xs gap-1.5 px-1 font-medium"
            >
              <IconBolt className="size-3.5 text-amber-500" />
              Services
              <Badge variant="secondary" className="text-[10px] px-1.5 py-0 h-4">
                {entity.services.length}
              </Badge>
            </TabsTrigger>
            <TabsTrigger
              value="properties"
              className="h-10 rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none text-xs gap-1.5 px-1 font-medium"
            >
              <IconAdjustmentsHorizontal className="size-3.5 text-blue-500" />
              {entity.entityType.toLowerCase() === "datashape" ? "Fields" : "Properties"}
              <Badge variant="secondary" className="text-[10px] px-1.5 py-0 h-4">
                {entity.properties.length}
              </Badge>
            </TabsTrigger>
            {entity.subscriptions.length > 0 && (
              <TabsTrigger
                value="subscriptions"
                className="h-10 rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none text-xs gap-1.5 px-1 font-medium"
              >
                <IconLayersLinked className="size-3.5 text-purple-500" />
                Subscriptions
                <Badge variant="secondary" className="text-[10px] px-1.5 py-0 h-4">
                  {entity.subscriptions.length}
                </Badge>
              </TabsTrigger>
            )}
            {entity.configurationTables.length > 0 && (
              <TabsTrigger
                value="config"
                className="h-10 rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none text-xs gap-1.5 px-1 font-medium"
              >
                <IconDatabase className="size-3.5 text-emerald-500" />
                Configuration
                <Badge variant="secondary" className="text-[10px] px-1.5 py-0 h-4">
                  {entity.configurationTables.length}
                </Badge>
              </TabsTrigger>
            )}
          </TabsList>
        </div>

        {/* ── Overview Tab Content ──────────────────────────────────────────── */}
        <TabsContent value="overview" className="flex-1 overflow-y-auto p-6 m-0 space-y-6">
          {/* Quick Metrics Grid */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            <div
              onClick={() => setActiveTab("services")}
              className="flex items-center gap-3 p-4 rounded-xl border bg-card/60 hover:bg-accent/40 cursor-pointer transition-colors"
            >
              <div className="flex size-10 items-center justify-center rounded-lg bg-amber-500/10 text-amber-600 dark:text-amber-400">
                <IconBolt className="size-5" />
              </div>
              <div>
                <div className="text-2xl font-bold font-mono">{entity.services.length}</div>
                <div className="text-xs text-muted-foreground">Services Defined</div>
              </div>
            </div>

            <div
              onClick={() => setActiveTab("properties")}
              className="flex items-center gap-3 p-4 rounded-xl border bg-card/60 hover:bg-accent/40 cursor-pointer transition-colors"
            >
              <div className="flex size-10 items-center justify-center rounded-lg bg-blue-500/10 text-blue-600 dark:text-blue-400">
                <IconAdjustmentsHorizontal className="size-5" />
              </div>
              <div>
                <div className="text-2xl font-bold font-mono">{entity.properties.length}</div>
                <div className="text-xs text-muted-foreground">
                  {entity.entityType.toLowerCase() === "datashape" ? "DataShape Fields" : "Properties"}
                </div>
              </div>
            </div>

            <div className="flex items-center gap-3 p-4 rounded-xl border bg-card/60">
              <div className="flex size-10 items-center justify-center rounded-lg bg-purple-500/10 text-purple-600 dark:text-purple-400">
                <IconLayersLinked className="size-5" />
              </div>
              <div>
                <div className="text-2xl font-bold font-mono">{entity.implementedShapes.length}</div>
                <div className="text-xs text-muted-foreground">ThingShapes</div>
              </div>
            </div>

            <div className="flex items-center gap-3 p-4 rounded-xl border bg-card/60">
              <div className="flex size-10 items-center justify-center rounded-lg bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
                <IconDatabase className="size-5" />
              </div>
              <div>
                <div className="text-2xl font-bold font-mono">{entity.configurationTables.length}</div>
                <div className="text-xs text-muted-foreground">Config Tables</div>
              </div>
            </div>
          </div>

          {/* Details Section */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {/* Metadata Card */}
            <div className="p-5 rounded-xl border bg-card/40 space-y-4">
              <div className="flex items-center gap-2 border-b pb-2.5">
                <IconInfoCircle className="size-4 text-primary" />
                <h3 className="text-sm font-semibold text-foreground">Entity Metadata</h3>
              </div>

              <div className="space-y-3 text-xs">
                <div className="flex justify-between py-1 border-b border-border/40">
                  <span className="text-muted-foreground">File Path:</span>
                  <span className="font-mono text-foreground break-all text-right max-w-xs">{filePath}</span>
                </div>
                <div className="flex justify-between py-1 border-b border-border/40">
                  <span className="text-muted-foreground">Entity Type:</span>
                  <span className="font-mono font-medium text-foreground">{entity.entityType}</span>
                </div>
                {entity.projectName && (
                  <div className="flex justify-between py-1 border-b border-border/40">
                    <span className="text-muted-foreground">Project:</span>
                    <span className="font-medium text-foreground">{entity.projectName}</span>
                  </div>
                )}
                {entity.baseThingTemplate && (
                  <div className="flex justify-between py-1 border-b border-border/40">
                    <span className="text-muted-foreground">Base Template:</span>
                    <span className="font-mono text-cyan-600 dark:text-cyan-400 font-medium">
                      {entity.baseThingTemplate}
                    </span>
                  </div>
                )}
                {entity.tags.length > 0 && (
                  <div className="py-1">
                    <span className="text-muted-foreground block mb-1.5">Model Tags:</span>
                    <div className="flex flex-wrap gap-1.5">
                      {entity.tags.map((tag, tIdx) => (
                        <Badge key={`${tag}-${tIdx}`} variant="secondary" className="text-[11px] gap-1">
                          <IconTag className="size-3 opacity-60" />
                          {tag}
                        </Badge>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* Implemented Shapes Card */}
            <div className="p-5 rounded-xl border bg-card/40 space-y-4">
              <div className="flex items-center gap-2 border-b pb-2.5">
                <IconHierarchy className="size-4 text-purple-500" />
                <h3 className="text-sm font-semibold text-foreground">Implemented Shapes</h3>
              </div>

              {entity.implementedShapes.length > 0 ? (
                <div className="space-y-2">
                  {entity.implementedShapes.map((shape, sIdx) => (
                    <div
                      key={`${shape}-${sIdx}`}
                      className="flex items-center justify-between p-2.5 rounded-lg border bg-muted/30 text-xs font-mono"
                    >
                      <div className="flex items-center gap-2 truncate">
                        <Badge variant="outline" className="bg-purple-500/10 text-purple-600 dark:text-purple-400 border-purple-500/20 text-[10px]">
                          TS
                        </Badge>
                        <span className="font-medium truncate">{shape}</span>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-xs text-muted-foreground py-6 text-center">
                  No implemented ThingShapes defined directly on this entity.
                </div>
              )}
            </div>
          </div>
        </TabsContent>

        {/* ── Services Tab Content ─────────────────────────────────────────── */}
        <TabsContent value="services" className="flex-1 min-h-0 flex flex-col m-0 p-0 overflow-hidden">
          <div className="flex-1 flex flex-col md:flex-row overflow-hidden">
            {/* Service List Sidebar */}
            <div className="w-full md:w-80 shrink-0 border-r flex flex-col overflow-hidden bg-card/20">
              {/* Search & Category Filter */}
              <div className="p-3 border-b space-y-2">
                <div className="relative">
                  <IconSearch className="size-3.5 absolute left-2.5 top-2.5 text-muted-foreground" />
                  <Input
                    value={serviceSearch}
                    onChange={(e) => setServiceSearch(e.target.value)}
                    placeholder="Search services & code…"
                    className="h-8 pl-8 text-xs"
                  />
                </div>

                {serviceCategories.length > 0 && (
                  <Select
                    value={serviceCategory}
                    onValueChange={(v) => v && setServiceCategory(v)}
                  >
                    <SelectTrigger className="h-7 text-xs">
                      <SelectValue placeholder="All Categories" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__all__">All Categories</SelectItem>
                      {serviceCategories.map((c) => (
                        <SelectItem key={c} value={c}>
                          {c}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </div>

              {/* Service Items */}
              <ScrollArea className="flex-1 min-h-0">
                <div className="p-2 space-y-1">
                  {filteredServices.map((s) => {
                    const isSelected =
                      svcSel.length > 0 ? svcSel.includes(s.name) : selectedService?.name === s.name;
                    return (
                      <div
                        key={s.name}
                        onClick={(e) =>
                          pickRow(
                            e,
                            s.name,
                            filteredServices.map((x) => x.name),
                            svcSel.length > 0 ? svcSel : selectedService ? [selectedService.name] : [],
                            setSvcSel,
                            svcAnchor,
                            setSelectedServiceName
                          )
                        }
                        draggable
                        onDragStart={(e) =>
                          setDragPins(e, servicePins(svcSel.includes(s.name) ? svcSel : [s.name]))
                        }
                        onContextMenu={(e) => {
                          e.preventDefault();
                          setMenu({
                            x: e.clientX,
                            y: e.clientY,
                            kind: "service",
                            names: svcSel.includes(s.name) ? svcSel : [s.name],
                          });
                        }}
                        role="button"
                        tabIndex={0}
                        className={cn(
                          "w-full text-left p-2.5 rounded-lg text-xs transition-colors cursor-pointer flex flex-col gap-1 border",
                          isSelected
                            ? "bg-primary/10 border-primary/40 text-foreground shadow-2xs"
                            : "border-transparent hover:bg-accent/50 text-muted-foreground hover:text-foreground"
                        )}
                      >
                        <div className="flex items-center justify-between gap-1.5">
                          <span className="font-mono font-semibold truncate text-foreground text-[12px]">
                            {s.name}
                          </span>
                          {s.script && (
                            <Badge variant="outline" className="text-[9px] px-1 py-0 bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/20">
                              JS
                            </Badge>
                          )}
                        </div>

                        <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                          <span className="truncate">{s.category || "General"}</span>
                          <span>•</span>
                          <span className="font-mono">{s.parameters.length} params</span>
                          <span>→</span>
                          <span className="font-mono font-medium text-foreground/80 truncate">
                            {s.resultType.baseType}
                          </span>
                        </div>
                      </div>
                    );
                  })}

                  {filteredServices.length === 0 && (
                    <div className="p-6 text-center text-xs text-muted-foreground">
                      No services match filter.
                    </div>
                  )}
                </div>
              </ScrollArea>
            </div>

            {/* Service Detail / Code Viewer */}
            <div className="flex-1 flex flex-col min-w-0 overflow-hidden bg-background">
              {selectedService ? (
                <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
                  {/* Service Top Bar */}
                  <div className="shrink-0 p-4 border-b bg-card/40 flex items-center justify-between gap-3 flex-wrap">
                    <div className="flex flex-col gap-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-mono text-sm font-bold text-foreground">
                          {selectedService.name}
                        </span>
                        <Badge variant="secondary" className="text-[11px]">
                          {selectedService.category || "General"}
                        </Badge>
                        <Badge
                          variant="outline"
                          className="text-[11px] font-mono bg-muted/60 text-foreground"
                        >
                          Returns: {selectedService.resultType.baseType}
                          {selectedService.resultType.dataShape && ` (${selectedService.resultType.dataShape})`}
                        </Badge>
                      </div>

                      {selectedService.description && (
                        <p className="text-xs text-muted-foreground">
                          {selectedService.description}
                        </p>
                      )}
                    </div>

                    <div className="flex items-center gap-2 shrink-0">
                      {addToChatBtn(
                        () => addPins(servicePins(pinServiceNames)),
                        pinServiceNames.length > 1 ? `Add ${pinServiceNames.length} to chat` : "Add to chat",
                        "Add the service (definition and code) to the assistant chat. Ctrl/Shift-click services in the list to pick several."
                      )}
                      {selectedService.script && (
                        <Button
                          size="xs"
                          variant="outline"
                          onClick={() => handleCopy(selectedService.script!, `${selectedService.name} Code`)}
                          className="h-7 text-xs gap-1"
                        >
                          {copiedField === `${selectedService.name} Code` ? (
                            <IconCheck className="size-3 text-emerald-500" />
                          ) : (
                            <IconCopy className="size-3" />
                          )}
                          Copy JS Code
                        </Button>
                      )}

                      {onOpenServiceCode && (
                        <Button
                          size="xs"
                          variant="outline"
                          onClick={() => onOpenServiceCode(selectedService.name)}
                          className="h-7 text-xs gap-1"
                          title="Open the script extracted to the Code folder"
                        >
                          <IconFileCode className="size-3" />
                          Open JS File
                        </Button>
                      )}
                    </div>
                  </div>

                  {/* Parameters Table */}
                  {selectedService.parameters.length > 0 && (
                    <div className="shrink-0 border-b p-3 bg-muted/10">
                      <span className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider block mb-2">
                        Parameters ({selectedService.parameters.length})
                      </span>
                      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-2">
                        {selectedService.parameters.map((p, pIdx) => (
                          <div
                            key={`${p.name}-${pIdx}`}
                            className="p-2 rounded-md border bg-card/60 text-xs flex flex-col gap-0.5"
                          >
                            <div className="flex items-center justify-between gap-1">
                              <span className="font-mono font-medium text-foreground truncate">
                                {p.name}
                              </span>
                              {p.isRequired && (
                                <Badge variant="destructive" className="text-[9px] px-1 py-0 h-3.5">
                                  required
                                </Badge>
                              )}
                            </div>
                            <div className="text-[10px] text-muted-foreground font-mono">
                              Type: {p.baseType}
                              {p.dataShape && ` (${p.dataShape})`}
                            </div>
                            {p.defaultValue && (
                              <div className="text-[10px] text-muted-foreground">
                                Default: <code className="font-mono">{p.defaultValue}</code>
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Implementation Code */}
                  <div className="flex-1 flex flex-col min-h-0">
                    <div className="shrink-0 px-4 py-1.5 border-b bg-muted/20 flex items-center justify-between text-xs text-muted-foreground">
                      <span className="font-mono font-medium text-[11px]">
                        Implementation ({selectedService.handlerName || "Script"})
                      </span>
                    </div>

                    <div className="flex-1 min-h-0">
                      {selectedService.script ? (
                        <MonacoEditor
                          height="100%"
                          language="javascript"
                          value={selectedService.script}
                          theme={resolvedTheme === "dark" ? "vs-dark" : "vs"}
                          options={{
                            readOnly: true,
                            minimap: { enabled: false },
                            scrollBeyondLastLine: false,
                            wordWrap: "on",
                            fontSize: 13,
                            lineNumbers: "on",
                            folding: true,
                            automaticLayout: true,
                          }}
                        />
                      ) : (
                        <div className="flex items-center justify-center h-full text-xs text-muted-foreground">
                          Standard or inherited service implementation (no custom script body).
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              ) : (
                <div className="flex items-center justify-center h-full text-xs text-muted-foreground">
                  Select a service to view definition and implementation code.
                </div>
              )}
            </div>
          </div>
        </TabsContent>

        {/* ── Properties Tab Content ───────────────────────────────────────── */}
        <TabsContent value="properties" className="flex-1 min-h-0 flex flex-col m-0 p-0 overflow-hidden">
          {/* Properties Filter Toolbar */}
          <div className="shrink-0 p-4 border-b bg-card/40 flex items-center gap-3 flex-wrap">
            <div className="relative flex-1 max-w-sm">
              <IconSearch className="size-3.5 absolute left-2.5 top-2.5 text-muted-foreground" />
              <Input
                value={propertySearch}
                onChange={(e) => setPropertySearch(e.target.value)}
                placeholder="Search properties…"
                className="h-8 pl-8 text-xs"
              />
            </div>

            {propertyTypes.length > 0 && (
              <Select
                value={propertyTypeFilter}
                onValueChange={(v) => v && setPropertyTypeFilter(v)}
              >
                <SelectTrigger className="h-8 text-xs w-44">
                  <SelectValue placeholder="All Types" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__all__">All BaseTypes</SelectItem>
                  {propertyTypes.map((t) => (
                    <SelectItem key={t} value={t}>
                      {t}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}

            <span className="text-xs text-muted-foreground ml-auto">
              Showing {filteredProperties.length} of {entity.properties.length}
            </span>
            {addToChatBtn(
              () =>
                addPins(
                  propertyPins(
                    pinPropNames.length > 0
                      ? pinPropNames
                      : filteredProperties.slice(0, 50).map((p) => p.name)
                  )
                ),
              pinPropNames.length > 0 ? `Add ${pinPropNames.length} to chat` : "Add shown to chat",
              "Add the selected rows (Ctrl/Shift-click), or the first 50 shown, to the assistant chat"
            )}
          </div>

          {/* Properties Table */}
          <ScrollArea className="flex-1 min-h-0">
            <div className="p-4">
              <div className="rounded-xl border overflow-hidden">
                <table className="w-full text-xs text-left border-collapse">
                  <thead>
                    <tr className="bg-muted/50 border-b font-medium text-muted-foreground select-none">
                      <th className="py-2.5 px-4">Property Name</th>
                      <th className="py-2.5 px-4">Base Type</th>
                      <th className="py-2.5 px-4">Default Value</th>
                      <th className="py-2.5 px-4">Flags</th>
                      <th className="py-2.5 px-4">Description</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border/40">
                    {filteredProperties.map((p, idx) => (
                      <tr
                        key={`${p.name}-${idx}`}
                        draggable
                        onClick={(e) =>
                          pickRow(
                            e,
                            p.name,
                            filteredProperties.map((x) => x.name),
                            propSel,
                            setPropSel,
                            propAnchor,
                            (n) => setPropSel([n])
                          )
                        }
                        onDragStart={(e) =>
                          setDragPins(e, propertyPins(propSel.includes(p.name) ? propSel : [p.name]))
                        }
                        onContextMenu={(e) => {
                          e.preventDefault();
                          setMenu({
                            x: e.clientX,
                            y: e.clientY,
                            kind: "property",
                            names: propSel.includes(p.name) ? propSel : [p.name],
                          });
                        }}
                        className={cn(
                          "transition-colors cursor-pointer",
                          propSel.includes(p.name) ? "bg-primary/10" : "hover:bg-accent/30"
                        )}
                      >
                        <td className="py-2.5 px-4 font-mono font-semibold text-foreground">
                          {p.name}
                        </td>
                        <td className="py-2.5 px-4">
                          <Badge variant="outline" className="font-mono text-[11px]">
                            {p.baseType}
                            {p.dataShape && ` (${p.dataShape})`}
                          </Badge>
                        </td>
                        <td className="py-2.5 px-4 font-mono text-muted-foreground">
                          {p.defaultValue !== undefined ? p.defaultValue : "—"}
                        </td>
                        <td className="py-2.5 px-4">
                          <div className="flex items-center gap-1">
                            {p.isPersistent && (
                              <Badge variant="secondary" className="text-[10px] px-1 py-0">
                                Persistent
                              </Badge>
                            )}
                            {p.isLogged && (
                              <Badge variant="secondary" className="text-[10px] px-1 py-0">
                                Logged
                              </Badge>
                            )}
                            {p.isReadOnly && (
                              <Badge variant="secondary" className="text-[10px] px-1 py-0">
                                ReadOnly
                              </Badge>
                            )}
                            {!p.isPersistent && !p.isLogged && !p.isReadOnly && (
                              <span className="text-muted-foreground/60">—</span>
                            )}
                          </div>
                        </td>
                        <td className="py-2.5 px-4 text-muted-foreground max-w-xs truncate">
                          {p.description || "—"}
                        </td>
                      </tr>
                    ))}

                    {filteredProperties.length === 0 && (
                      <tr>
                        <td colSpan={5} className="py-8 text-center text-muted-foreground">
                          No properties found.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </ScrollArea>
        </TabsContent>

        {/* ── Subscriptions Tab Content ────────────────────────────────────── */}
        {entity.subscriptions.length > 0 && (
          <TabsContent value="subscriptions" className="flex-1 overflow-y-auto p-6 m-0 space-y-4">
            <div className="space-y-4">
              {entity.subscriptions.map((sub, subIdx) => (
                <div key={`${sub.name}-${subIdx}`} className="p-4 rounded-xl border bg-card/40 space-y-3">
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2 font-mono text-sm font-semibold">
                      <IconLayersLinked className="size-4 text-purple-500" />
                      <span>{sub.name}</span>
                    </div>
                    <Badge variant={sub.enabled ? "default" : "secondary"} className="text-[10px]">
                      {sub.enabled ? "Enabled" : "Disabled"}
                    </Badge>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-xs">
                    <div className="p-2 rounded bg-muted/40 border">
                      <span className="text-muted-foreground text-[10px] block">Event:</span>
                      <span className="font-mono font-medium">{sub.eventName}</span>
                    </div>
                    <div className="p-2 rounded bg-muted/40 border">
                      <span className="text-muted-foreground text-[10px] block">Source:</span>
                      <span className="font-mono font-medium">{sub.source || "me"}</span>
                    </div>
                    <div className="p-2 rounded bg-muted/40 border">
                      <span className="text-muted-foreground text-[10px] block">Handler:</span>
                      <span className="font-mono font-medium">{sub.handlerName}</span>
                    </div>
                  </div>

                  {sub.script && (
                    <div className="rounded-lg border overflow-hidden bg-black/40 p-3 font-mono text-xs text-foreground">
                      <pre className="overflow-x-auto whitespace-pre-wrap">{sub.script}</pre>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </TabsContent>
        )}

        {/* ── Configuration Tables Tab Content ─────────────────────────────── */}
        {entity.configurationTables.length > 0 && (
          <TabsContent value="config" className="flex-1 overflow-y-auto p-6 m-0 space-y-6">
            {entity.configurationTables.map((ct, ctIdx) => (
              <div key={`${ct.name}-${ctIdx}`} className="p-5 rounded-xl border bg-card/40 space-y-3">
                <div className="flex items-center justify-between">
                  <h4 className="text-sm font-bold font-mono text-foreground">{ct.name}</h4>
                  {ct.isMultiRow && (
                    <Badge variant="outline" className="text-[10px]">
                      Multi-Row
                    </Badge>
                  )}
                </div>
                {ct.description && (
                  <p className="text-xs text-muted-foreground">{ct.description}</p>
                )}

                {ct.rows.length > 0 ? (
                  <div className="rounded-lg border overflow-x-auto">
                    <table className="w-full text-xs text-left">
                      <thead>
                        <tr className="bg-muted/50 border-b">
                          {Object.keys(ct.rows[0] || {}).map((col) => (
                            <th key={col} className="py-2 px-3 font-medium text-muted-foreground">
                              {col}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border/40">
                        {ct.rows.map((row, idx) => (
                          <tr key={idx} className="hover:bg-accent/30 font-mono">
                            {Object.values(row).map((val, cIdx) => (
                              <td key={cIdx} className="py-2 px-3 text-foreground break-all">
                                {val || "—"}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground">Table is empty.</p>
                )}
              </div>
            ))}
          </TabsContent>
        )}
      </Tabs>

      {menu && (
        <div
          className="fixed z-50 min-w-40 rounded-lg border bg-popover p-1 text-popover-foreground shadow-md"
          style={{ left: menu.x, top: menu.y }}
        >
          <button
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-accent"
            onClick={() => {
              addPins(menuPins(menu));
              setMenu(null);
            }}
          >
            <IconMessagePlus className="size-3.5" />
            {menu.kind === "entity"
              ? "Add entity to chat"
              : `Add ${menu.names.length > 1 ? `${menu.names.length} ` : ""}${menu.kind}${menu.names.length > 1 ? "s" : ""} to chat`}
          </button>
        </div>
      )}
    </div>
  );
}
