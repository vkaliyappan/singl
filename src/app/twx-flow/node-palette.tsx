"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  IconAlertTriangle,
  IconArrowLeft,
  IconBox,
  IconChevronRight,
  IconLayoutDashboard,
  IconSearch,
  IconServer,
  IconStack2,
  IconTable,
  IconX,
} from "@tabler/icons-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { getServiceDefinitions, searchEntities } from "@/lib/services";
import { errorMessage } from "@/lib/settings";
import { cn } from "@/lib/utils";
import { CATALOGUE_SECTIONS, NODE_CATALOGUE } from "@/lib/twx-flow/nodes";
import type { NodeKind, NodePatch } from "@/lib/twx-flow/types";
import type { EntitySearchResult, ServiceDef } from "@/lib/twx/types";
import { catalogueIcon } from "./node-icons";

export type ServicePick = {
  kind: "service";
  collection: string;
  entityName: string;
  service: ServiceDef;
};

export type NodePick =
  | ServicePick
  /** A catalogue row: its kind, plus the preset that tells two rows of the
      same kind apart (the four agent CLIs). */
  | { kind: Exclude<NodeKind, "service">; patch?: NodePatch; label?: string };

type NodeGroup = {
  key: string;
  icon: typeof IconBox;
  title: string;
  hint: string;
  /** Entity collections this group searches, first one is the default. */
  collections: string[];
};

/**
 * The entity collections are grouped by what the user is trying to do, so the
 * first screen is six choices instead of seven type chips plus 300 entities.
 */
const GROUPS: NodeGroup[] = [
  {
    key: "things",
    icon: IconBox,
    title: "Things",
    hint: "Call a service on a running Thing",
    collections: ["Things"],
  },
  {
    key: "model",
    icon: IconStack2,
    title: "Templates & Shapes",
    hint: "Services defined on a ThingTemplate or ThingShape",
    collections: ["ThingTemplates", "ThingShapes"],
  },
  {
    key: "platform",
    icon: IconServer,
    title: "Platform",
    hint: "Resource and Subsystem services",
    collections: ["Resources", "Subsystems"],
  },
  {
    key: "data",
    icon: IconTable,
    title: "Data shapes",
    hint: "Build or inspect rows from a DataShape",
    collections: ["DataShapes"],
  },
  {
    key: "mashups",
    icon: IconLayoutDashboard,
    title: "Mashups",
    hint: "Services exposed by a Mashup",
    collections: ["Mashups"],
  },
];

const WIDTH_KEY = "twx-flow.palette-width";
const MIN_WIDTH = 320;
const DEFAULT_WIDTH = 432;

/** Widest the panel may get, so the canvas never disappears behind it. */
function maxWidth() {
  return typeof window === "undefined" ? DEFAULT_WIDTH : Math.round(window.innerWidth * 0.8);
}

function storedWidth() {
  if (typeof window === "undefined") return DEFAULT_WIDTH;
  const raw = Number(window.localStorage.getItem(WIDTH_KEY));
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_WIDTH;
  return Math.min(Math.max(raw, MIN_WIDTH), maxWidth());
}

/** Two-letter monogram so long entity names stay scannable in the list. */
function monogram(name: string) {
  const parts = name.replace(/[^A-Za-z0-9]+/g, " ").trim().split(" ");
  const caps = name.match(/[A-Z]/g);
  if (parts.length > 1) return (parts[0][0] + parts[1][0]).toUpperCase();
  if (caps && caps.length > 1) return (caps[0] + caps[1]).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

/** Emphasises the part of a label the current query matched. */
function Highlight({ text, query }: { text: string; query: string }) {
  const q = query.trim();
  if (!q) return <>{text}</>;
  const at = text.toLowerCase().indexOf(q.toLowerCase());
  if (at < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, at)}
      <mark className="bg-primary/15 text-foreground rounded-[2px] px-0.5">
        {text.slice(at, at + q.length)}
      </mark>
      {text.slice(at + q.length)}
    </>
  );
}

function GroupLabel({ children, count }: { children: string; count?: number }) {
  return (
    <div className="bg-background/95 sticky top-0 z-10 flex items-center gap-2 px-2 py-1.5">
      <span className="text-muted-foreground text-[9px] font-medium tracking-wider uppercase">
        {children}
      </span>
      {count !== undefined && (
        <span className="text-muted-foreground/70 text-[9px] tabular-nums">{count}</span>
      )}
      <span className="bg-border ml-1 h-px flex-1" />
    </div>
  );
}

/** Icon-plus-two-lines row shared by the core nodes and the group list. */
function CategoryRow({
  icon: Icon,
  title,
  hint,
  query,
  activeRow,
  drills,
  ...rest
}: {
  icon: typeof IconBox;
  title: string;
  hint: string;
  query: string;
  activeRow: boolean;
  drills?: boolean;
} & React.ComponentProps<"button">) {
  return (
    <button
      type="button"
      className={cn(
        "flex w-full items-center gap-3 rounded-md px-2 py-2 text-left",
        activeRow && "bg-accent"
      )}
      {...rest}
    >
      <span
        className={cn(
          "flex size-8 shrink-0 items-center justify-center rounded-md",
          drills ? "bg-muted text-muted-foreground" : "bg-primary/10 text-primary"
        )}
      >
        <Icon className="size-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs font-medium">
          <Highlight text={title} query={query} />
        </span>
        <span className="text-muted-foreground block text-[10px] leading-snug">{hint}</span>
      </span>
      {drills && (
        <IconChevronRight
          className={cn(
            "text-muted-foreground size-3.5 shrink-0",
            activeRow ? "opacity-100" : "opacity-40"
          )}
        />
      )}
    </button>
  );
}

/**
 * Right-hand node picker: pick a category, then an entity, then one of its
 * services. Opening it from an output port wires the new node up automatically.
 */
export function NodePalette({
  open,
  env,
  connectFrom,
  onOpenChange,
  onPick,
}: {
  open: boolean;
  env: string;
  /** Label of the node the new one will be connected to, if any. */
  connectFrom?: string;
  onOpenChange: (open: boolean) => void;
  onPick: (pick: NodePick) => void;
}) {
  const [group, setGroup] = useState<NodeGroup | null>(null);
  const [collection, setCollection] = useState("Things");
  const [rootQuery, setRootQuery] = useState("");
  const [entityQuery, setEntityQuery] = useState("");
  const [entities, setEntities] = useState<EntitySearchResult[]>([]);
  const [entitiesLoading, setEntitiesLoading] = useState(false);
  const [entityError, setEntityError] = useState("");

  const [entityName, setEntityName] = useState("");
  const [services, setServices] = useState<ServiceDef[]>([]);
  const [servicesLoading, setServicesLoading] = useState(false);
  const [serviceError, setServiceError] = useState("");
  const [serviceQuery, setServiceQuery] = useState("");

  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  // Drag-to-resize from the left edge; the chosen width outlives the session.
  const [width, setWidth] = useState(storedWidth);
  const [resizing, setResizing] = useState(false);
  const drag = useRef({ x: 0, w: 0 });

  const startResize = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    drag.current = { x: e.clientX, w: width };
    setResizing(true);
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const moveResize = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!resizing) return;
    // The panel is right-anchored, so dragging left grows it.
    const next = drag.current.w + (drag.current.x - e.clientX);
    setWidth(Math.min(Math.max(next, MIN_WIDTH), maxWidth()));
  };

  const endResize = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!resizing) return;
    setResizing(false);
    e.currentTarget.releasePointerCapture(e.pointerId);
    window.localStorage.setItem(WIDTH_KEY, String(width));
  };

  // Keyboard resize for the handle, plus double-click to restore the default.
  const resizeKeys = (e: React.KeyboardEvent) => {
    const step = e.shiftKey ? 64 : 16;
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    e.stopPropagation();
    const next = width + (e.key === "ArrowLeft" ? step : -step);
    const clamped = Math.min(Math.max(next, MIN_WIDTH), maxWidth());
    setWidth(clamped);
    window.localStorage.setItem(WIDTH_KEY, String(clamped));
  };

  // Entity search is debounced and last-write-wins: a slow earlier response must
  // not overwrite the results of a newer query.
  const searchSeq = useRef(0);

  useEffect(() => {
    if (!open || !env || !group) return;
    const seq = ++searchSeq.current;
    const timer = setTimeout(async () => {
      setEntitiesLoading(true);
      setEntityError("");
      try {
        const results = await searchEntities(
          env,
          collection,
          entityQuery.trim() ? `*${entityQuery.trim()}*` : "*"
        );
        if (seq !== searchSeq.current) return;
        setEntities(results.slice(0, 300));
      } catch (e) {
        if (seq !== searchSeq.current) return;
        setEntityError(errorMessage(e));
        setEntities([]);
      } finally {
        if (seq === searchSeq.current) setEntitiesLoading(false);
      }
    }, 250);
    return () => clearTimeout(timer);
  }, [open, env, group, collection, entityQuery]);

  const loadServices = useCallback(
    async (name: string) => {
      setEntityName(name);
      setServices([]);
      setServiceQuery("");
      setServiceError("");
      setServicesLoading(true);
      try {
        setServices(await getServiceDefinitions(env, collection, name));
      } catch (e) {
        setServiceError(errorMessage(e));
      } finally {
        setServicesLoading(false);
      }
    },
    [collection, env]
  );

  const openGroup = useCallback((g: NodeGroup) => {
    setGroup(g);
    setCollection(g.collections[0]);
    setEntities([]);
    setEntityQuery("");
    setEntityError("");
    setEntityName("");
  }, []);

  const backToRoot = () => {
    setGroup(null);
    setEntities([]);
    setEntityQuery("");
    setEntityError("");
  };

  // The first screen searches only the labels it shows; no round trip needed.
  const rootQ = rootQuery.trim().toLowerCase();
  const coreMatches = useMemo(
    () =>
      rootQ
        ? NODE_CATALOGUE.filter(
            (c) => c.title.toLowerCase().includes(rootQ) || c.hint.toLowerCase().includes(rootQ)
          )
        : NODE_CATALOGUE,
    [rootQ]
  );

  /** The flow-control nodes, grouped the way n8n groups the same list. */
  const coreSections = useMemo(
    () =>
      CATALOGUE_SECTIONS.map((section) => ({
        section,
        // Row numbers are global: arrow keys walk the whole screen, not a group.
        items: coreMatches
          .map((entry, index) => ({ entry, index }))
          .filter(({ entry }) => entry.section === section),
      })).filter((group) => group.items.length > 0),
    [coreMatches]
  );
  const groupMatches = useMemo(
    () =>
      rootQ
        ? GROUPS.filter(
            (g) =>
              g.title.toLowerCase().includes(rootQ) ||
              g.hint.toLowerCase().includes(rootQ) ||
              g.collections.some((c) => c.toLowerCase().includes(rootQ))
          )
        : GROUPS,
    [rootQ]
  );

  const filteredServices = useMemo(() => {
    const q = serviceQuery.trim().toLowerCase();
    const list = q
      ? services.filter(
          (s) =>
            s.name.toLowerCase().includes(q) ||
            s.description.toLowerCase().includes(q) ||
            s.category.toLowerCase().includes(q)
        )
      : services;
    return [...list].sort((a, b) => a.name.localeCompare(b.name));
  }, [services, serviceQuery]);

  // One flat list of what arrow keys walk over, whichever level is showing.
  const rows = useMemo(() => {
    if (entityName)
      return filteredServices.map((s) => () => {
        onPick({ kind: "service", collection, entityName, service: s });
        onOpenChange(false);
      });
    if (group) return entities.map((e) => () => loadServices(e.name));
    return [
      ...coreMatches.map((c) => () => {
        onPick({ kind: c.kind, patch: c.patch, label: c.label });
        onOpenChange(false);
      }),
      ...groupMatches.map((g) => () => openGroup(g)),
    ];
  }, [
    collection,
    coreMatches,
    entities,
    entityName,
    filteredServices,
    group,
    groupMatches,
    loadServices,
    onOpenChange,
    onPick,
    openGroup,
  ]);

  // Any change of level, query or result set puts the highlight back on row 0.
  const rowsKey = `${group?.key}|${collection}|${entityName}|${rootQuery}|${entityQuery}|${serviceQuery}|${rows.length}`;
  const [lastRowsKey, setLastRowsKey] = useState(rowsKey);
  if (lastRowsKey !== rowsKey) {
    setLastRowsKey(rowsKey);
    setActive(0);
  }

  // Keep the highlighted row inside the viewport as the selection moves.
  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-idx="${active}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const back = useCallback(() => {
    if (entityName) setEntityName("");
    else if (group) backToRoot();
    else onOpenChange(false);
  }, [entityName, group, onOpenChange]);

  // Escape lives on the window so it still fires after a click on the backdrop
  // moves focus out of the panel.
  useEffect(() => {
    if (!open) return;
    const onEscape = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // An open dropdown owns Escape first.
      if (document.querySelector("[data-radix-popper-content-wrapper]")) return;
      back();
    };
    window.addEventListener("keydown", onEscape);
    return () => window.removeEventListener("keydown", onEscape);
  }, [open, back]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!rows.length) return;
      const step = e.key === "ArrowDown" ? 1 : -1;
      setActive((i) => (i + step + rows.length) % rows.length);
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      rows[active]?.();
      return;
    }
    // Backspace on an empty filter walks one level back up.
    const query = entityName ? serviceQuery : group ? entityQuery : rootQuery;
    if (e.key === "Backspace" && !query && (group || entityName)) back();
  };

  if (!open) return null;

  const level = entityName ? "services" : group ? "entities" : "root";
  const coreCount = level === "root" ? coreMatches.length : 0;
  const loading = level === "services" ? servicesLoading : level === "entities" && entitiesLoading;
  const error = level === "services" ? serviceError : level === "entities" ? entityError : "";
  const empty = !loading && !error && rows.length === 0;
  const query = level === "services" ? serviceQuery : level === "entities" ? entityQuery : rootQuery;
  const setQuery =
    level === "services" ? setServiceQuery : level === "entities" ? setEntityQuery : setRootQuery;

  return (
    <div className="fixed inset-0 z-40 flex justify-end">
      <div
        className="bg-background/50 flex-1"
        onClick={() => onOpenChange(false)}
        role="presentation"
      />

      <aside
        className={cn(
          "bg-background relative flex h-full min-w-0 flex-col border-l shadow-2xl",
          resizing && "select-none"
        )}
        style={{ width: Math.min(width, maxWidth()) }}
        onKeyDown={onKeyDown}
      >
        <div
          role="separator"
          aria-label="Resize panel"
          aria-orientation="vertical"
          aria-valuenow={width}
          aria-valuemin={MIN_WIDTH}
          tabIndex={0}
          onPointerDown={startResize}
          onPointerMove={moveResize}
          onPointerUp={endResize}
          onPointerCancel={endResize}
          onKeyDown={resizeKeys}
          onDoubleClick={() => {
            setWidth(DEFAULT_WIDTH);
            window.localStorage.setItem(WIDTH_KEY, String(DEFAULT_WIDTH));
          }}
          className={cn(
            "hover:bg-primary/40 focus-visible:bg-primary/60 absolute inset-y-0 -left-1 z-20 w-2 cursor-col-resize outline-none",
            resizing && "bg-primary/60"
          )}
        />

        <header className="flex items-start gap-2 px-3 pt-3 pb-2">
          {level !== "root" && (
            <Button variant="ghost" size="icon-sm" aria-label="Back" onClick={back}>
              <IconArrowLeft />
            </Button>
          )}
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold">
              {entityName || group?.title || "What happens next?"}
            </p>
            <p className="text-muted-foreground truncate text-xs">
              {level === "services"
                ? `${collection} · pick a service`
                : level === "entities"
                  ? group?.hint
                  : "Pick a category or search everything"}
            </p>
          </div>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => onOpenChange(false)}
            aria-label="Close"
          >
            <IconX />
          </Button>
        </header>

        {connectFrom && level === "root" && (
          <p className="text-muted-foreground mx-3 mb-2 truncate rounded-md border border-dashed px-2 py-1 text-[10px]">
            Connects after <span className="text-foreground font-medium">{connectFrom}</span>
          </p>
        )}

        {!env && level !== "root" && (
          <div className="border-destructive/40 bg-destructive/10 text-destructive mx-3 mb-2 flex items-center gap-2 rounded-md border px-3 py-2 text-xs">
            <IconAlertTriangle className="size-4 shrink-0" />
            Select an environment first.
          </div>
        )}

        {/* Search and the collection picker share one row; the picker only shows
            for groups that span more than one entity collection. */}
        <div className="flex items-center gap-1.5 px-3 pb-2">
          <div className="relative flex-1">
            <IconSearch className="text-muted-foreground absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2" />
            <Input
              autoFocus
              key={level + (group?.key ?? "") + entityName}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={
                level === "services"
                  ? "Filter services…"
                  : level === "entities"
                    ? `Search ${collection}…`
                    : "Search nodes…"
              }
              className="h-8 pl-8 text-xs"
            />
          </div>
          {level === "entities" && group && group.collections.length > 1 && (
            <Select value={collection} onValueChange={(v) => v && setCollection(v)}>
              <SelectTrigger className="h-8 w-[9rem] shrink-0" aria-label="Entity type">
                <SelectValue />
              </SelectTrigger>
              <SelectContent align="end">
                {group.collections.map((t) => (
                  <SelectItem key={t} value={t}>
                    {t}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>

        <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto border-t px-1.5 pb-2">
          {error && <p className="text-destructive px-2 py-3 text-xs break-words">{error}</p>}

          {level === "root" && (
            <>
              {/* Flow-control nodes need no environment and no entity, so they
                  lead — Popular first, exactly like the n8n panel. */}
              {coreSections.map((group) => (
                <div key={group.section}>
                  <GroupLabel>{group.section}</GroupLabel>
                  {group.items.map(({ entry, index }) => (
                    <CategoryRow
                      key={entry.key}
                      data-idx={index}
                      icon={catalogueIcon(entry)}
                      title={entry.title}
                      hint={entry.hint}
                      query={rootQuery}
                      activeRow={active === index}
                      onMouseMove={() => setActive(index)}
                      onClick={() => rows[index]?.()}
                    />
                  ))}
                </div>
              ))}

              {groupMatches.length > 0 && (
                <>
                  <GroupLabel>ThingWorx</GroupLabel>
                  {groupMatches.map((g, n) => {
                    const i = coreCount + n;
                    return (
                      <CategoryRow
                        key={g.key}
                        data-idx={i}
                        drills
                        icon={g.icon}
                        title={g.title}
                        hint={g.hint}
                        query={rootQuery}
                        activeRow={active === i}
                        onMouseMove={() => setActive(i)}
                        onClick={() => rows[i]?.()}
                      />
                    );
                  })}
                </>
              )}
            </>
          )}

          {level === "entities" && (
            <>
              {(entities.length > 0 || loading) && (
                <GroupLabel count={entities.length || undefined}>{collection}</GroupLabel>
              )}
              {loading &&
                entities.length === 0 &&
                Array.from({ length: 8 }).map((_, i) => (
                  <div key={i} className="flex items-center gap-2.5 px-2 py-1.5">
                    <Skeleton className="size-7 shrink-0 rounded-md" />
                    <Skeleton className="h-3 flex-1" style={{ maxWidth: `${70 - i * 4}%` }} />
                  </div>
                ))}
              {entities.map((e, i) => (
                <button
                  key={e.name}
                  type="button"
                  data-idx={i}
                  onMouseMove={() => setActive(i)}
                  onClick={() => rows[i]?.()}
                  className={cn(
                    "flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left",
                    active === i && "bg-accent"
                  )}
                >
                  <span className="bg-muted text-muted-foreground flex size-7 shrink-0 items-center justify-center rounded-md text-[10px] font-semibold">
                    {monogram(e.name)}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs font-medium">
                      <Highlight text={e.name} query={entityQuery} />
                    </span>
                    {e.description && (
                      <span className="text-muted-foreground block truncate text-[10px]">
                        {e.description}
                      </span>
                    )}
                  </span>
                  <IconChevronRight
                    className={cn(
                      "text-muted-foreground size-3.5 shrink-0 opacity-0",
                      active === i && "opacity-100"
                    )}
                  />
                </button>
              ))}
            </>
          )}

          {level === "services" && (
            <>
              {loading && (
                <div className="text-muted-foreground flex items-center gap-2 px-2 py-3 text-xs">
                  <Spinner className="size-3.5" /> Loading services…
                </div>
              )}
              {filteredServices.length > 0 && (
                <GroupLabel count={filteredServices.length}>Services</GroupLabel>
              )}
              {filteredServices.map((s, i) => {
                const shape = s.resultType.aspects?.dataShape;
                return (
                  <button
                    key={s.name}
                    type="button"
                    data-idx={i}
                    onMouseMove={() => setActive(i)}
                    onClick={() => rows[i]?.()}
                    className={cn(
                      "flex w-full flex-col gap-1 rounded-md px-2 py-1.5 text-left",
                      active === i && "bg-accent"
                    )}
                  >
                    <span className="flex items-center gap-2 text-xs font-medium">
                      <span className="truncate">
                        <Highlight text={s.name} query={serviceQuery} />
                      </span>
                      <Badge variant="outline" className="ml-auto shrink-0 text-[9px]">
                        {s.resultType.baseType}
                        {typeof shape === "string" && shape ? ` · ${shape}` : ""}
                      </Badge>
                    </span>
                    {s.description && (
                      <span className="text-muted-foreground line-clamp-2 text-xs">
                        {s.description}
                      </span>
                    )}
                    <span className="text-muted-foreground/80 text-[10px]">
                      {s.parameterDefinitions.length} parameter
                      {s.parameterDefinitions.length === 1 ? "" : "s"}
                      {s.category ? ` · ${s.category}` : ""}
                    </span>
                  </button>
                );
              })}
            </>
          )}

          {empty && (
            <p className="text-muted-foreground px-2 py-6 text-center text-xs">
              {level === "services"
                ? "No services match."
                : level === "entities"
                  ? "No entities found."
                  : "Nothing matches that search."}
            </p>
          )}
        </div>

        <footer className="text-muted-foreground flex items-center gap-3 border-t px-3 py-1.5 text-[10px]">
          <span className="flex items-center gap-1">
            <Kbd>↑</Kbd>
            <Kbd>↓</Kbd> navigate
          </span>
          <span className="flex items-center gap-1">
            <Kbd>↵</Kbd> {level === "services" ? "add" : "open"}
          </span>
          <span className="ml-auto flex items-center gap-1">
            <Kbd>esc</Kbd> {level === "root" ? "close" : "back"}
          </span>
        </footer>
      </aside>
    </div>
  );
}
