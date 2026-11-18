"use client";

// Ported from singl-web's TWX Entities explorer. Files come from the entity
// commands (src/lib/entities.ts) instead of /api/twx-entities. The assistant
// panel is left out until the agent backend is ported.

import { useState, useCallback, useEffect, useRef, useMemo, useDeferredValue } from "react";
import { useRouter } from "next/navigation";
import { useAssistantAction, useAssistantContext } from "@/lib/assistant/context";
import { addPins, usePinnables, type NewPin, type Pinnable } from "@/lib/assistant/pins";
import { setDragPins } from "@/lib/assistant/drag";
import { clipText } from "@/lib/assistant/pin-utils";
import dynamic from "next/dynamic";
import { useTheme } from "@/components/providers";
import {
  IconFile,
  IconX,
  IconSettings,
  IconDownload,
  IconPackageImport,
  IconInfoCircle,
  IconRefresh,
  IconCode,
  IconLayoutColumns,
  IconCopy,
  IconFolder,
  IconEye,
  IconDeviceDesktopAnalytics,
  IconDeviceFloppy,
  IconFilePlus,
  IconFolderPlus,
  IconPencil,
  IconTrash,
  IconClipboard,
  IconListCheck,
  IconChevronDown,
  IconMessagePlus,
} from "@tabler/icons-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import {
  createEntityEntry,
  deleteEntityEntry,
  getRunTimes,
  listEntityFiles,
  locateEntity as locateEntityFiles,
  readEntityFile,
  renameEntityEntry,
  reexportEntity,
  searchEntities,
  writeEntityFile,
  type LocatedEntity,
  type RemoteEntity,
} from "@/lib/entities";
import {
  ENTITY_EXPORT,
  ENTITY_EXTRACT,
  clearEntityJobs,
  startExport,
  startExtract,
  type EntityExportResult,
  type EntityExtractResult,
  type EntityJobMeta,
} from "@/lib/entity-jobs";
import { useJob, useJobFinished, type Job, type JobStatus } from "@/lib/background-jobs";
import { errorMessage, type EnvSetting, type ProjectConfig } from "@/lib/settings";
import { FileIcon, FileTreePanel, OpenEditorsPanel, getLanguage } from "@/components/file-tree";
import {
  AppFileTree,
  AppFileTreeHeader,
  AppFileTreeMenu,
  AppFileTreeMenuItem,
  AppFileTreeMenuSeparator,
  folderPaths,
  getTreeFolder,
  useAppFileTree,
} from "@/components/pierre-file-tree";
import { SearchPanel, type SearchOptions, type SearchFileResult } from "@/components/search-panel";
import { toast } from "sonner";
import { parseTwxEntityXml, type ParsedTwxEntity } from "@/lib/twx/entity-xml-parser";
import { safeEnvDir, type TwxEntityLink } from "@/lib/twx/links";
import { onAssistantChange } from "@/lib/assistant/changes";
import { EntityOverview } from "./components/entity-overview";
import { OutputDrawer } from "./components/output-drawer";
import { ExportPicker } from "./components/export-picker";

const MonacoEditor = dynamic(() => import("@monaco-editor/react"), {
  ssr: false,
  loading: () => (
    <div className="flex items-center justify-center h-full text-muted-foreground text-xs font-mono">
      Loading editor…
    </div>
  ),
});

interface TabState {
  content: string | null;
  /** What is on disk; the tab is dirty while `content` differs from it. */
  saved: string | null;
  error: string | null;
  loading: boolean;
  saving?: boolean;
}

const isDirty = (tab: TabState | undefined) => !!tab && tab.content !== tab.saved;

type TreeTarget = { path: string; type: "file" | "dir" };

type TreeDecoration = { text: string; title?: string; parts?: { text: string; color?: string }[] };

type NameDialogState =
  | { mode: "file" | "dir"; parent: string }
  | { mode: "rename"; target: TreeTarget };

function parentOf(p: string) {
  const i = p.lastIndexOf("/");
  return i < 0 ? "" : p.slice(0, i);
}

/** Maps `p` to its new location when `from` (or a folder above it) moved to `to`. */
function remapPath(p: string, from: string, to: string) {
  if (p === from) return to;
  return p.startsWith(`${from}/`) ? to + p.slice(from.length) : p;
}

type ViewMode = "overview" | "code" | "split";

/** Badge text colors, as CSS colors for the tree's row decorations. */
const BADGE_COLOR: Record<string, string> = {
  T: "var(--color-blue-500)",
  TT: "var(--color-cyan-500)",
  TS: "var(--color-purple-500)",
  M: "var(--color-emerald-500)",
  DS: "var(--color-amber-500)",
};

/** Folder names the entity filter chips match, by chip id. */
const ENTITY_FILTER_DIR: Record<string, string> = {
  Things: "/things/",
  ThingTemplates: "/thingtemplates/",
  ThingShapes: "/thingshapes/",
  Mashups: "/mashups/",
  DataShapes: "/datashapes/",
};

function getEntryBadge(name: string, path: string) {
  if (!name.endsWith(".xml")) return null;
  const p = path.toLowerCase();
  if (p.includes("/things/")) return { label: "T", title: "Thing", color: "text-blue-500 bg-blue-500/10 border-blue-500/20" };
  if (p.includes("/thingtemplates/")) return { label: "TT", title: "Thing Template", color: "text-cyan-500 bg-cyan-500/10 border-cyan-500/20" };
  if (p.includes("/thingshapes/")) return { label: "TS", title: "Thing Shape", color: "text-purple-500 bg-purple-500/10 border-purple-500/20" };
  if (p.includes("/mashups/")) return { label: "M", title: "Mashup", color: "text-emerald-500 bg-emerald-500/10 border-emerald-500/20" };
  if (p.includes("/datashapes/")) return { label: "DS", title: "Data Shape", color: "text-amber-500 bg-amber-500/10 border-amber-500/20" };
  return null;
}

// ── Entity lookup ──────────────────────────────────────────────────────────

/** Where an entity's files live, relative to the entities base; `error` when it was not found. */
async function locateEntity(query: {
  env: string;
  entity: string;
  type?: string;
  service?: string;
}): Promise<LocatedEntity & { error?: string }> {
  try {
    return await locateEntityFiles({ ...query, collection: query.type });
  } catch (err) {
    return { error: errorMessage(err) };
  }
}

function fmtTimestamp(iso: string | null): string {
  if (!iso) return "Never";
  const d = new Date(iso);
  const diffMs = Date.now() - d.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  if (diffMins < 1) return "just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHrs = Math.floor(diffMins / 60);
  if (diffHrs < 24) return `${diffHrs}h ago`;
  const diffDays = Math.floor(diffHrs / 24);
  if (diffDays < 7) return `${diffDays}d ago`;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** Relative age ("3h ago") for the last week; null beyond, where it would only repeat the date. */
function fmtAgo(iso: string | null): string | undefined {
  if (!iso || Date.now() - new Date(iso).getTime() >= 7 * 24 * 3600_000) return undefined;
  return fmtTimestamp(iso);
}

/** Full local date and time, e.g. "Sep 29, 2026, 10:42 AM". */
function fmtDateTime(iso: string | null): string {
  if (!iso) return "Never";
  return new Date(iso).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

// ── Main component ─────────────────────────────────────────────────────────

interface TwxExplorerProps {
  initialEnvs: EnvSetting[];
  /** Deep link from another module; wins over whatever was open last time. */
  link?: TwxEntityLink | null;
  /** A file to open, relative to the exports: `<env folder>/…`. */
  fileLink?: string | null;
}

export function TwxExplorer({
  initialEnvs,
  link = null,
  fileLink = null,
}: TwxExplorerProps) {
  const router = useRouter();
  const { resolvedTheme } = useTheme();

  // ── Env management ────────────────────────────────────────────────────────
  const [envs, setEnvs] = useState<EnvSetting[]>(initialEnvs);

  useEffect(() => {
    setEnvs(initialEnvs);
    if (!initialEnvs.find((e) => e.environment === selectedEnv)) {
      setSelectedEnv(initialEnvs[0]?.environment ?? "");
      setSelectedProject("__all__");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialEnvs]);

  // ── Export / Extract toolbar state ────────────────────────────────────────
  const linkEnv =
    link && initialEnvs.some((e) => e.environment === link.env)
      ? link.env
      : fileLink
        ? (initialEnvs.find((e) => safeEnvDir(e.environment) === fileLink.split("/")[0])?.environment ?? "")
        : "";
  const [selectedEnv, setSelectedEnv] = useState(linkEnv || (initialEnvs[0]?.environment ?? ""));
  const [selectedProject, setSelectedProject] = useState("__all__");
  const [customProject, setCustomProject] = useState("");
  const [lastExportDir, setLastExportDir] = useState<string | null>(null);

  // Export / Extract runs live in @/lib/entity-jobs so they outlive this page.
  const exportJob = useJob<EntityJobMeta, EntityExportResult>(ENTITY_EXPORT);
  const extractJob = useJob<EntityJobMeta, EntityExtractResult>(ENTITY_EXTRACT);
  const asStatus = <R extends string>(s: JobStatus, running: R) => (s === "running" ? running : s);
  const exportStatus = asStatus(exportJob.status, "exporting");
  const extractStatus = asStatus(extractJob.status, "extracting");
  const jobBusy = exportJob.status === "running" || extractJob.status === "running";
  const exportMessages = useMemo(() => exportJob.log.map((l) => l.text), [exportJob.log]);
  const extractMessages = useMemo(() => extractJob.log.map((l) => l.text), [extractJob.log]);

  // Log drawer state
  const [isOutputOpen, setIsOutputOpen] = useState(true);

  // ── Timestamps ────────────────────────────────────────────────────────────
  const [lastExported, setLastExported] = useState<string | null>(null);
  const [lastExtracted, setLastExtracted] = useState<string | null>(null);
  // Exported since the last extract: the extracted scripts are out of date.
  const extractStale = !!lastExported && (!lastExtracted || lastExtracted < lastExported);
  const staleHint = "Exported after the last extract — run Extract";

  // ── View mode (Overview | Code | Split) ───────────────────────────────────
  const [viewMode, setViewMode] = useState<ViewMode>("overview");

  // ── File tree ─────────────────────────────────────────────────────────────
  // Every file of the export, relative to its folder (folders end in "/").
  const [treePaths, setTreePaths] = useState<string[]>([]);
  const [treeRoot, setTreeRoot] = useState<string | null>(null);
  const [treeLoading, setTreeLoading] = useState(false);

  // Entity Type Filter for tree
  const [entityFilter, setEntityFilter] = useState<string>("all");

  // ── Multi-tab editor state ────────────────────────────────────────────────
  const [openTabs, setOpenTabs] = useState<Map<string, TabState>>(new Map());
  const [activeTab, setActiveTab] = useState<string | null>(null);
  const openTabsRef = useRef(openTabs);
  openTabsRef.current = openTabs;
  const activeTabRef = useRef(activeTab);
  activeTabRef.current = activeTab;

  // ── Tree (@pierre/trees) ──────────────────────────────────────────────────
  // Tree paths are relative to the export folder, `treeRoot`.
  const visiblePaths = useMemo(() => {
    const dir = ENTITY_FILTER_DIR[entityFilter];
    if (!dir) return treePaths;
    return treePaths.filter((p) => p.endsWith("/") || `/${p}`.toLowerCase().includes(dir));
  }, [treePaths, entityFilter]);

  const toFull = (rel: string) => `${treeRoot}/${rel.replace(/\/$/, "")}`;
  const toRel = (full: string | null) =>
    full && treeRoot && full.startsWith(`${treeRoot}/`) ? full.slice(treeRoot.length + 1) : null;

  // The tree reads its callbacks once; these are filled in further down.
  const treeActions = useRef({
    open: (rel: string) => void rel,
    decorate: (rel: string): TreeDecoration | null => (void rel, null),
  });

  const {
    model: treeModel,
    expandAll: expandAllTree,
    collapseAll: collapseAllTree,
    refreshDecorations,
  } = useAppFileTree({
    paths: visiblePaths,
    activePath: toRel(activeTab),
    onFileOpen: (rel) => treeActions.current.open(rel),
    // Moving files inside the tree is not supported.
    dragAndDrop: { canDrop: () => false },
    // Relative to the workspace folder.
    dragItems: (rels) => rels.map((rel) => ({ path: `twx-entities/${toFull(rel)}`, isDir: rel.endsWith("/") })),
    renderRowDecoration: ({ item }) => treeActions.current.decorate(item.path),
  });

  // Folders to open once the next listing is in: a renamed folder under its
  // new name, the folder a change happened in.
  const reopenRef = useRef<string[]>([]);
  useEffect(() => {
    const dirs = reopenRef.current;
    reopenRef.current = [];
    for (const d of dirs) getTreeFolder(treeModel, d)?.expand();
  }, [treeModel, visiblePaths]);

  // ── Search panel state ────────────────────────────────────────────────────
  const [searchActive, setSearchActive] = useState(false);
  const editorRef = useRef<{ revealLineInCenter: (n: number) => void; setPosition: (p: { lineNumber: number; column: number }) => void; focus: () => void } | null>(null);
  const pendingJumpRef = useRef<{ line: number; col: number } | null>(null);

  // ── Resize panel ──────────────────────────────────────────────────────────
  const [treeWidth, setTreeWidth] = useState(290);
  const treeWidthRef = useRef(290);
  treeWidthRef.current = treeWidth;

  const handleDragStart = useCallback((e: React.MouseEvent) => {
    const startX = e.clientX;
    const startWidth = treeWidthRef.current;
    const onMove = (ev: MouseEvent) => {
      setTreeWidth(Math.max(180, Math.min(600, startWidth + ev.clientX - startX)));
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

  // ── Persistence ───────────────────────────────────────────────────────────
  const hasMountedRef = useRef(false);
  const pendingRestorePathRef = useRef<string | null>(null);
  const pendingFileLinkRef = useRef<string | null>(null);

  useEffect(() => {
    try {
      const raw = localStorage.getItem("singl:twx");
      if (!raw) return;
      const s = JSON.parse(raw) as {
        selectedEnv?: string;
        selectedProject?: string;
        customProject?: string;
        treeWidth?: number;
        activeTab?: string | null;
        selectedFile?: string | null;
        viewMode?: ViewMode;
      };
      if (!link && !fileLink && s.selectedEnv && initialEnvs.find((e) => e.environment === s.selectedEnv)) {
        setSelectedEnv(s.selectedEnv);
      }
      if (s.selectedProject) setSelectedProject(s.selectedProject);
      if (typeof s.customProject === "string") setCustomProject(s.customProject);
      if (typeof s.treeWidth === "number") {
        setTreeWidth(s.treeWidth);
        treeWidthRef.current = s.treeWidth;
      }
      // A deep link opens its own entity, in the view that shows its services.
      if (link) return;
      if (fileLink) {
        pendingFileLinkRef.current = fileLink;
        return;
      }
      if (s.viewMode && ["overview", "code", "split"].includes(s.viewMode)) {
        setViewMode(s.viewMode);
      }
      const fileToRestore = s.activeTab ?? s.selectedFile ?? null;
      if (fileToRestore) pendingRestorePathRef.current = fileToRestore;
    } catch {}
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-fetch file content once the tree has loaded after restore
  const treeLoadedRef = useRef(false);
  useEffect(() => {
    treeLoadedRef.current = treePaths.length > 0;
  });
  useEffect(() => {
    if (treePaths.length === 0) return;
    const linked = pendingLinkRef.current;
    if (linked) {
      pendingLinkRef.current = null;
      revealEntity(linked, link?.focus === "code");
      return;
    }
    const fileToOpen = pendingFileLinkRef.current;
    if (fileToOpen) {
      pendingFileLinkRef.current = null;
      setViewMode("code");
      revealPath(fileToOpen);
      return;
    }
    const path = pendingRestorePathRef.current;
    if (!path) return;
    pendingRestorePathRef.current = null;
    handleFileClick(path);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [treePaths]);

  useEffect(() => {
    if (!hasMountedRef.current) {
      hasMountedRef.current = true;
      return;
    }
    try {
      localStorage.setItem(
        "singl:twx",
        JSON.stringify({ selectedEnv, selectedProject, customProject, treeWidth, activeTab, viewMode })
      );
    } catch {}
  }, [selectedEnv, selectedProject, customProject, treeWidth, activeTab, viewMode]);

  // Last export / extract times are recorded per environment by the backend.
  useEffect(() => {
    setLastExported(null);
    setLastExtracted(null);
    if (!selectedEnv) return;
    let cancelled = false;
    getRunTimes(selectedEnv)
      .then((t) => {
        if (cancelled) return;
        setLastExported(t.lastExported ?? null);
        setLastExtracted(t.lastExtracted ?? null);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [selectedEnv]);

  // ── Helpers ───────────────────────────────────────────────────────────────
  const resetFileTree = useCallback(() => {
    setTreePaths([]);
    setTreeRoot(null);
    setOpenTabs(new Map());
    setActiveTab(null);
  }, []);

  const confirmDiscard = useCallback((paths: string[]) => {
    const dirty = paths.filter((p) => isDirty(openTabsRef.current.get(p)));
    if (dirty.length === 0) return true;
    const names = dirty.map((p) => p.split("/").pop()).join(", ");
    return window.confirm(`Discard unsaved changes to ${names}?`);
  }, []);

  const handleCloseTab = useCallback((path: string) => {
    if (!confirmDiscard([path])) return;
    const tabs = Array.from(openTabsRef.current.keys());
    const idx = tabs.indexOf(path);
    setOpenTabs((prev) => {
      const next = new Map(prev);
      next.delete(path);
      return next;
    });
    setActiveTab((prev) => {
      if (prev !== path) return prev;
      return tabs[idx + 1] ?? tabs[idx - 1] ?? null;
    });
  }, [confirmDiscard]);

  const handleCloseOthers = useCallback((keepPath: string) => {
    if (!confirmDiscard(Array.from(openTabsRef.current.keys()).filter((p) => p !== keepPath))) return;
    setOpenTabs((prev) => {
      const next = new Map();
      const current = prev.get(keepPath);
      if (current) next.set(keepPath, current);
      return next;
    });
    setActiveTab(keepPath);
  }, [confirmDiscard]);

  const handleCloseAllTabs = useCallback(() => {
    if (!confirmDiscard(Array.from(openTabsRef.current.keys()))) return;
    setOpenTabs(new Map());
    setActiveTab(null);
  }, [confirmDiscard]);

  // ── Editing & saving ──────────────────────────────────────────────────────
  const handleEditorChange = useCallback((path: string, value: string | undefined) => {
    setOpenTabs((prev) => {
      const tab = prev.get(path);
      if (!tab || tab.content === (value ?? "")) return prev;
      return new Map(prev).set(path, { ...tab, content: value ?? "" });
    });
  }, []);

  const saveTab = useCallback(async (path: string) => {
    const tab = openTabsRef.current.get(path);
    if (!tab || tab.saving || tab.content === null || !isDirty(tab)) return;
    const content = tab.content;
    const patch = (fields: Partial<TabState>) =>
      setOpenTabs((prev) => {
        const current = prev.get(path);
        return current ? new Map(prev).set(path, { ...current, ...fields }) : prev;
      });
    patch({ saving: true });
    try {
      await writeEntityFile(path, content);
      // Edits made while the request was out stay dirty.
      patch({ saved: content, saving: false });
      toast.success(`Saved ${path.split("/").pop()}`);
    } catch (err) {
      patch({ saving: false });
      toast.error(errorMessage(err));
    }
  }, []);

  /** Replaces the open file `path` with a fresh export of its entity. */
  const reexportTab = useCallback(
    async (path: string) => {
      if (isDirty(openTabsRef.current.get(path))) {
        toast.error("Save or undo your changes to this file first");
        return;
      }
      try {
        const xml = await reexportEntity(selectedEnv, path);
        setOpenTabs((prev) => {
          const current = prev.get(path);
          return current ? new Map(prev).set(path, { ...current, content: xml, saved: xml }) : prev;
        });
        toast.success(`Exported ${path.split("/").pop()} from ThingWorx`);
      } catch (err) {
        toast.error(errorMessage(err));
      }
    },
    [selectedEnv]
  );

  const saveActiveRef = useRef(() => {});
  saveActiveRef.current = () => {
    if (activeTabRef.current) void saveTab(activeTabRef.current);
  };

  const hasDirtyTabs = Array.from(openTabs.values()).some(isDirty);
  useEffect(() => {
    if (!hasDirtyTabs) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [hasDirtyTabs]);

  // Keyboard shortcuts: Ctrl+S saves, Escape closes active tab, Ctrl+Shift+F toggles search
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "s") {
        e.preventDefault();
        saveActiveRef.current();
        return;
      }
      // Escape inside the editor, a dialog or a menu belongs to them.
      const target = e.target as HTMLElement | null;
      const inWidget = target?.closest?.(".monaco-editor, [role=dialog], [role=menu], input, textarea");
      if (e.key === "Escape" && activeTabRef.current && !inWidget) {
        handleCloseTab(activeTabRef.current);
      }
      if (e.ctrlKey && e.shiftKey && (e.key === "F" || e.key === "f")) {
        e.preventDefault();
        setSearchActive((v) => !v);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [handleCloseTab]);

  // ── Auto-load persisted exports on env change ─────────────────────────────
  const exportStatusRef = useRef(exportStatus);
  exportStatusRef.current = exportStatus;

  const loadLocalDirectory = useCallback(async (envName: string) => {
    if (!envName) return;
    const safeEnv = envName.replace(/[^a-zA-Z0-9_\-]/g, "_");
    resetFileTree();
    setLastExportDir(null);
    setTreeLoading(true);

    try {
      const paths = await listEntityFiles(safeEnv);
      if (paths.length > 0) {
        setTreeRoot(safeEnv);
        setTreePaths(paths);
        setLastExportDir(safeEnv);
      }
    } catch {
      // silently ignore
    } finally {
      setTreeLoading(false);
    }
  }, [resetFileTree]);

  useEffect(() => {
    if (!selectedEnv || exportStatusRef.current === "exporting") return;
    let cancelled = false;

    (async () => {
      if (!cancelled) await loadLocalDirectory(selectedEnv);
    })();

    return () => {
      cancelled = true;
    };
  }, [selectedEnv, loadLocalDirectory]);

  /** Lists the whole export folder `root` into the tree. */
  const loadTree = useCallback(async (root: string, quiet = false) => {
    if (!quiet) setTreeLoading(true);
    try {
      const paths = await listEntityFiles(root);
      setTreeRoot(root);
      setTreePaths(paths);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      if (!quiet) setTreeLoading(false);
    }
  }, []);

  const handleFileClick = useCallback(async (filePath: string) => {
    if (openTabsRef.current.has(filePath)) {
      setActiveTab(filePath);
      return;
    }
    setOpenTabs((prev) => new Map(prev).set(filePath, { content: null, saved: null, error: null, loading: true }));
    setActiveTab(filePath);
    try {
      const content = await readEntityFile(filePath);
      setOpenTabs((prev) => {
        const next = new Map(prev);
        next.set(filePath, { content, saved: content, error: null, loading: false });
        return next;
      });
    } catch (err) {
      setOpenTabs((prev) => {
        const next = new Map(prev);
        next.set(filePath, { content: null, saved: null, error: errorMessage(err), loading: false });
        return next;
      });
    }
  }, []);

  /** Expands the tree down to a path, and opens it when it is a file. */
  const revealPath = useCallback(
    (target: string, open = true) => {
      const parts = target.split("/");
      // parts[0] is the environment folder, which the tree shows as its root.
      const dirs = parts
        .slice(0, open ? -1 : undefined)
        .map((_, i) => parts.slice(0, i + 1).join("/"))
        .slice(1);
      for (const dir of dirs) {
        getTreeFolder(treeModel, `${dir.slice(parts[0].length + 1)}/`)?.expand();
      }
      if (open) void handleFileClick(target);
    },
    [treeModel, handleFileClick]
  );

  /**
   * Shows an entity's XML and, beside it, its script (or at least the folder of
   * scripts). Whichever is opened last is the tab left in front: the XML,
   * unless `codeFirst`.
   */
  const revealEntity = useCallback(
    (found: LocatedEntity, codeFirst = false) => {
      if (codeFirst && found.path) revealPath(found.path);
      if (found.code) revealPath(found.code);
      else if (found.codeDir) revealPath(found.codeDir, false);
      if (!codeFirst && found.path) revealPath(found.path);
    },
    [revealPath]
  );

  // ── Deep link: find the linked entity among the exports and open it ───────
  const [linkedPath, setLinkedPath] = useState<string | null>(null);
  const pendingLinkRef = useRef<LocatedEntity | null>(null);
  useEffect(() => {
    if (!link) return;
    let cancelled = false;
    (async () => {
      const env = linkEnv || selectedEnv;
      try {
        if (link.env && !linkEnv) {
          toast.warning(`Environment "${link.env}" is not configured — looking in ${env || "the default"}`);
        }
        const query = { env, entity: link.entity, service: link.service };
        let found = await locateEntity({ ...query, type: link.type });
        // Entities can live in a folder other than the REST collection name.
        if (!found.path && !found.code && link.type) found = await locateEntity(query);
        if (!found.path && !found.code) throw new Error(found.error ?? `${link.entity} was not found`);
        if (cancelled) return;
        setLinkedPath(found.path ?? null);
        setViewMode("overview");
        if ((link.service || link.focus === "code") && !found.code) {
          toast.info(`No extracted script for ${link.service ?? link.entity} — run Extract to get one`);
        }
        if (treeLoadedRef.current) revealEntity(found, link.focus === "code");
        else pendingLinkRef.current = found;
      } catch (err) {
        if (!cancelled) toast.error(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
    // Runs once: the page remounts this component for a new link.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Opens the script extracted for one service of the entity in `entityPath`. */
  const openServiceCode = useCallback(
    async (entityPath: string, service: string) => {
      // …/<alias>/<project>/<Collection>/<Name>.xml
      const parts = entityPath.split("/");
      const entity = parts.at(-1)?.replace(/\.xml$/i, "") ?? "";
      try {
        const data = await locateEntity({ env: selectedEnv, type: parts.at(-2), entity, service });
        if (!data.code) {
          toast.error(data.error ?? `No extracted script for ${service} — run Extract to get one`);
          return;
        }
        revealPath(data.code);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err));
      }
    },
    [selectedEnv, revealPath]
  );

  // ── Search handlers ───────────────────────────────────────────────────────
  const handleSearch = useCallback(async (query: string, opts: SearchOptions): Promise<SearchFileResult[]> => {
    if (!lastExportDir) return [];
    try {
      return await searchEntities(lastExportDir, query, opts);
    } catch (err) {
      throw new Error(errorMessage(err));
    }
  }, [lastExportDir]);

  const handleSearchResultClick = useCallback(async (filePath: string, lineNumber: number, col: number) => {
    const fullPath = lastExportDir ? `${lastExportDir}/${filePath}` : filePath;
    pendingJumpRef.current = { line: lineNumber, col };
    if (openTabsRef.current.has(fullPath)) {
      setActiveTab(fullPath);
      requestAnimationFrame(() => {
        const ed = editorRef.current;
        const jump = pendingJumpRef.current;
        if (ed && jump) {
          pendingJumpRef.current = null;
          ed.revealLineInCenter(jump.line);
          ed.setPosition({ lineNumber: jump.line, column: jump.col });
          ed.focus();
        }
      });
    } else {
      await handleFileClick(fullPath);
    }
  }, [lastExportDir, handleFileClick]);

  // ── File tree context menu: new file / folder, rename ─────────────────────
  const [nameDialog, setNameDialog] = useState<NameDialogState | null>(null);
  const [nameValue, setNameValue] = useState("");
  const [nameError, setNameError] = useState<string | null>(null);
  const [nameBusy, setNameBusy] = useState(false);

  // The assistant edits, creates and exports these files too: re-list the
  // tree and reload open tabs without unsaved edits, so the screen shows disk.
  useEffect(() => {
    return onAssistantChange("entities", () => {
      if (treeRoot) void loadTree(treeRoot, true);
      for (const [path, tab] of openTabsRef.current) {
        if (tab.loading || tab.saving || isDirty(tab)) continue;
        readEntityFile(path)
          .then((content) => {
            setOpenTabs((prev) => {
              const now = prev.get(path);
              // Typed into while reading, or already current: leave it.
              if (!now || isDirty(now) || now.saved === content) return prev;
              return new Map(prev).set(path, { ...now, content, saved: content, error: null });
            });
          })
          .catch(() => {});
      }
    });
  }, [treeRoot, loadTree]);

  const openNameDialog = (state: NameDialogState) => {
    setNameDialog(state);
    setNameValue(state.mode === "rename" ? state.target.path.split("/").pop() ?? "" : "");
    setNameError(null);
  };

  /** Re-lists a folder so the tree shows what changed on disk. */
  const refreshDir = useCallback(
    async (dir: string) => {
      const root = lastExportDir ?? dir.split("/")[0];
      // Show where the change happened.
      if (dir !== root) reopenRef.current.push(`${dir.slice(root.length + 1)}/`);
      await loadTree(root, true);
    },
    [lastExportDir, loadTree]
  );

  const submitNameDialog = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!nameDialog || nameBusy) return;
    const name = nameValue.trim();
    if (!name) return;
    setNameBusy(true);
    setNameError(null);
    try {
      if (nameDialog.mode === "rename") {
        const { target } = nameDialog;
        const newPath = await renameEntityEntry(target.path, name);
        if (newPath !== target.path) applyRename(target.path, newPath);
        await refreshDir(parentOf(target.path));
      } else {
        const { parent, mode } = nameDialog;
        const created = await createEntityEntry(parent, name, mode);
        await refreshDir(parent);
        if (mode === "file") void handleFileClick(created);
      }
      setNameDialog(null);
    } catch (err) {
      setNameError(errorMessage(err));
    } finally {
      setNameBusy(false);
    }
  };

  /** Moves open tabs and expanded folders along with a renamed entry. */
  const applyRename = (from: string, to: string) => {
    const remap = (p: string) => remapPath(p, from, to);
    const isUnder = (p: string) => p === from || p.startsWith(`${from}/`);
    setOpenTabs((prev) => new Map(Array.from(prev, ([k, v]) => [remap(k), v])));
    setActiveTab((prev) => (prev ? remap(prev) : prev));
    setLinkedPath((prev) => (prev ? remap(prev) : prev));
    // Folders open under the old name stay open under the new one.
    for (const d of folderPaths(visiblePaths)) {
      const full = toFull(d);
      if (isUnder(full) && getTreeFolder(treeModel, d)?.isExpanded()) {
        reopenRef.current.push(`${toRel(remap(full))}/`);
      }
    }
  };

  const [deleteTarget, setDeleteTarget] = useState<TreeTarget | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);

  const confirmDelete = async () => {
    if (!deleteTarget || deleteBusy) return;
    const { path: target } = deleteTarget;
    setDeleteBusy(true);
    try {
      await deleteEntityEntry(target);
      applyDelete(target);
      await refreshDir(parentOf(target));
      toast.success(`Deleted ${target.split("/").pop()}`);
      setDeleteTarget(null);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setDeleteBusy(false);
    }
  };

  /** Drops tabs and tree state for a deleted entry and everything under it. */
  const applyDelete = (removed: string) => {
    const isUnder = (p: string) => p === removed || p.startsWith(`${removed}/`);
    const tabs = Array.from(openTabsRef.current.keys());
    const remaining = tabs.filter((p) => !isUnder(p));
    setOpenTabs((prev) => new Map(Array.from(prev).filter(([k]) => !isUnder(k))));
    setActiveTab((prev) => {
      if (!prev || !isUnder(prev)) return prev;
      // Fall back to the nearest surviving tab, as closing one does.
      const idx = tabs.indexOf(prev);
      return remaining.find((p) => tabs.indexOf(p) > idx) ?? remaining.at(-1) ?? null;
    });
  };

  useEffect(() => {
    const fullOf = (rel: string) => `${treeRoot}/${rel.replace(/\/$/, "")}`;
    treeActions.current = {
      open: (rel) => void handleFileClick(fullOf(rel)),
      decorate: (rel) => {
        const badge = rel.endsWith("/") ? null : getEntryBadge(rel.split("/").pop() ?? "", fullOf(rel));
        if (!badge) return null;
        return {
          text: badge.label,
          parts: [{ text: badge.label, color: BADGE_COLOR[badge.label] }],
          title: badge.title,
        };
      },
    };
    // Row decorations are drawn from `treeActions`; redraw them.
    refreshDecorations();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refreshDecorations only reads the stable model
  }, [treeModel, treeRoot, handleFileClick]);

  // ── Export handler ────────────────────────────────────────────────────────
  const [pickerOpen, setPickerOpen] = useState(false);

  /** Exports the toolbar's project(s), or just `only` of them; with `thenExtract`, runs Extract after a successful export. */
  const handleExport = (only?: RemoteEntity[], thenExtract = false) => {
    const envRecord = envs.find((e) => e.environment === selectedEnv);
    if (!envRecord?.hasAppKey || jobBusy) return;
    setPickerOpen(false);
    setIsOutputOpen(true);
    resetFileTree();
    setLastExportDir(null);
    void startExport(selectedEnv, resolvedProjectName, only, thenExtract);
  };

  // ── Extract handler ───────────────────────────────────────────────────────
  const handleExtract = () => {
    if (jobBusy) return;
    setIsOutputOpen(true);
    void startExtract(selectedEnv);
  };

  // A run finished while this page is open: show its result. (One that
  // finished while it was closed is picked up by the mount-time loads.)
  const onEntityJobFinished = useCallback(
    (job: Job<EntityJobMeta, EntityExportResult | EntityExtractResult>, kind: "export" | "extract") => {
      if (job.status !== "done" || job.meta?.env !== selectedEnv) return;
      const now = new Date().toISOString();
      let dir = safeEnvDir(selectedEnv);
      if (kind === "export") {
        const r = job.result as EntityExportResult;
        setLastExported(r.exportedAt ?? now);
        dir = r.outputDir || dir;
      } else {
        setLastExtracted((job.result as EntityExtractResult).extractedAt ?? now);
      }
      setLastExportDir(dir);
      void loadTree(dir);
    },
    [selectedEnv, loadTree]
  );
  useJobFinished<EntityJobMeta, EntityExportResult>(
    ENTITY_EXPORT,
    useCallback((job) => onEntityJobFinished(job, "export"), [onEntityJobFinished])
  );
  useJobFinished<EntityJobMeta, EntityExtractResult>(
    ENTITY_EXTRACT,
    useCallback((job) => onEntityJobFinished(job, "extract"), [onEntityJobFinished])
  );

  // ── Derived state ─────────────────────────────────────────────────────────
  const selectedEnvRecord = envs.find((e) => e.environment === selectedEnv);
  const resolvedProjectName =
    selectedProject === "__all__"
      ? undefined
      : selectedProject === "__custom__"
      ? customProject.trim() || undefined
      : selectedProject;

  const canExport =
    !!selectedEnv &&
    !!selectedEnvRecord?.hasAppKey &&
    !jobBusy &&
    (selectedProject !== "__custom__" || !!customProject.trim());

  const activeTabState = activeTab ? openTabs.get(activeTab) : null;

  // Parsed entity for active tab
  // Deferred so typing in a large XML is not blocked by re-parsing it.
  const deferredContent = useDeferredValue(activeTabState?.content);
  const parsedEntity: ParsedTwxEntity | null = useMemo(() => {
    if (!deferredContent || !activeTab?.toLowerCase().endsWith(".xml")) {
      return null;
    }
    return parseTwxEntityXml(deferredContent);
  }, [deferredContent, activeTab]);


  // ── Assistant: what is open and selected ──────────────────────────────────
  const [overviewService, setOverviewService] = useState<string | null>(null);
  const [codeSel, setCodeSel] = useState<{ file: string; range: string; text: string } | null>(null);
  const codePinRef = useRef<((wholeFile: boolean) => NewPin) | null>(null);
  const watchSelection = useCallback((ed: { getSelection: () => unknown; getModel: () => unknown; onDidChangeCursorSelection: (cb: () => void) => unknown; addAction?: (a: { id: string; label: string; contextMenuGroupId: string; run: () => void }) => unknown }, file: string) => {
    ed.addAction?.({
      id: "singl.addToChat",
      label: "Add to chat",
      contextMenuGroupId: "9_cutcopypaste",
      run: () => {
        const sel = ed.getSelection() as { isEmpty: () => boolean; startLineNumber: number; endLineNumber: number } | null;
        const model = ed.getModel() as { getValueInRange: (r: unknown) => string } | null;
        const pin = codePinRef.current?.(!sel || sel.isEmpty());
        if (!pin) return;
        if (sel && !sel.isEmpty() && model) {
          // Full selection from the editor (the tracked one is capped for the screen context).
          const head = pin.content.split("\n", 1)[0];
          pin.content = clipText(`${head}\n${model.getValueInRange(sel)}`);
        }
        addPins([pin]);
      },
    });
    ed.onDidChangeCursorSelection(() => {
      const sel = ed.getSelection() as { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number; isEmpty: () => boolean };
      const model = ed.getModel() as { getValueInRange: (r: unknown) => string } | null;
      if (!sel || !model || sel.isEmpty()) return setCodeSel(null);
      setCodeSel({
        file,
        range: `${sel.startLineNumber}:${sel.startColumn}-${sel.endLineNumber}:${sel.endColumn}`,
        text: model.getValueInRange(sel).slice(0, 4000),
      });
    });
  }, []);
  const activeFileName = activeTab?.split("/").at(-1);

  // ── Add to chat: the open code (or the selection inside it) ──
  const codePin = useCallback(
    (wholeFile: boolean): NewPin => {
      const content = activeTabState?.content ?? "";
      const sel = !wholeFile && codeSel && codeSel.file === activeTab ? codeSel : null;
      const name = activeFileName ?? "code";
      return {
        kind: "code",
        label: sel ? `${name} (selection)` : name,
        screen: "twx-entities",
        detail: sel ? `lines ${sel.range}` : `${content.length.toLocaleString()} chars`,
        content: clipText(
          sel ? `${activeTab} [${sel.range}]\n${sel.text}` : `${activeTab}\n${content}`
        ),
      };
    },
    [activeTabState?.content, activeTab, activeFileName, codeSel]
  );
  useEffect(() => {
    codePinRef.current = codePin;
  }, [codePin]);
  const pinnables: Pinnable[] = [];
  if (activeTabState?.content != null) {
    pinnables.push({ kind: "code", label: activeFileName ?? "code", detail: "open file", content: () => codePin(true).content });
    if (codeSel && codeSel.file === activeTab) {
      pinnables.push({ kind: "code", label: `${activeFileName} (selection)`, detail: codeSel.range, content: () => codePin(false).content });
    }
  }
  usePinnables(pinnables);

  useAssistantContext({
    screen: "twx-entities",
    title: "Entities",
    summary: parsedEntity
      ? `${parsedEntity.entityType}:${parsedEntity.name} open in ${selectedEnv}`
      : activeFileName
        ? `${activeFileName} open in ${selectedEnv}`
        : `Explorer on ${selectedEnv || "no environment"}, nothing open`,
    data: {
      env: selectedEnv,
      project: selectedProject,
      viewMode,
      openFile: activeTab,
      openTabs: [...openTabs.keys()].slice(0, 20),
      entity: parsedEntity
        ? { type: parsedEntity.entityType, name: parsedEntity.name, project: parsedEntity.projectName, path: activeTab, services: parsedEntity.services.length }
        : null,
    },
    selection: {
      services: parsedEntity && overviewService ? [overviewService] : [],
      code: codeSel && codeSel.file === activeTab ? codeSel : null,
    },
  });
  useAssistantAction(
    "open_entity",
    {
      description: "Open an entity (and optionally one of its services' extracted code) in the explorer for the current environment.",
      inputSchema: {
        type: "object",
        properties: { entity: { type: "string" }, type: { type: "string", description: "Collection, e.g. Things" }, service: { type: "string" } },
        required: ["entity"],
      },
    },
    async (args) => {
      const a = args as { entity: string; type?: string; service?: string };
      const found = await locateEntity({ env: selectedEnv, entity: a.entity, type: a.type, service: a.service });
      if (!found.path && !found.code) throw new Error(found.error ?? `${a.entity} was not found`);
      revealEntity(found, !!a.service);
      return { opened: found.path ?? found.code };
    }
  );

  const treeLabel = lastExportDir
    ? lastExportDir.split("/").join(" / ")
    : "EXPLORER";


  // Combined messages and status for OutputDrawer
  const activeProcessStatus =
    exportStatus === "exporting"
      ? "exporting"
      : extractStatus === "extracting"
      ? "extracting"
      : exportStatus === "error" || extractStatus === "error"
      ? "error"
      : exportStatus === "done" || extractStatus === "done"
      ? "done"
      : "idle";

  const activeProcessMessages = [...exportMessages, ...extractMessages];

  const handleClearLogs = clearEntityJobs;

  return (
    <div className="flex flex-col h-full overflow-hidden bg-background">
      {/* ── Elevated Command Bar / Toolbar ───────────────────────────────────── */}
      <div className="shrink-0 border-b bg-card/70 backdrop-blur px-4 py-2.5 flex flex-col gap-2">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          {/* Left: Environment & Project Pickers */}
          <div className="flex items-center gap-2.5 flex-wrap">
            {/* Environment Picker */}
            <div className="flex items-center gap-1.5">
              <Select value={selectedEnv} onValueChange={(v) => v && setSelectedEnv(v)}>
                <SelectTrigger className="h-8.5 text-xs font-medium min-w-36 bg-background shadow-2xs border-border">
                  <div className="flex items-center gap-2 truncate">
                    <span
                      className={cn(
                        "size-2 rounded-full shrink-0",
                        selectedEnvRecord?.hasAppKey
                          ? "bg-emerald-500 shadow-xs shadow-emerald-500/50"
                          : "bg-amber-500"
                      )}
                    />
                    <SelectValue placeholder="Select Environment" />
                  </div>
                </SelectTrigger>
                <SelectContent>
                  {envs.map((e) => (
                    <SelectItem key={e.environment} value={e.environment} className="text-xs">
                      <div className="flex items-center justify-between w-full gap-3">
                        <span className="font-semibold">{e.environment}</span>
                        {e.hasAppKey ? (
                          <span className="text-[10px] text-muted-foreground">Connected</span>
                        ) : (
                          <span className="text-[10px] text-amber-500">No App Key</span>
                        )}
                      </div>
                    </SelectItem>
                  ))}
                  {envs.length === 0 && (
                    <SelectItem value="__none__" disabled className="text-xs">
                      No environments configured
                    </SelectItem>
                  )}
                </SelectContent>
              </Select>
            </div>

            {/* Project Scope Selector */}
            <div className="flex items-center gap-1.5">
              <Select
                value={selectedProject}
                onValueChange={(v) => { if (v) setSelectedProject(v); }}
              >
                <SelectTrigger className="h-8.5 text-xs font-medium min-w-48 max-w-64 bg-background shadow-2xs border-border">
                  <SelectValue placeholder="Select Project Scope" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__all__" className="text-xs">
                    {selectedEnvRecord?.projects.length
                      ? `All configured (${selectedEnvRecord.projects.length} projects)`
                      : "All TWX projects"}
                  </SelectItem>
                  {selectedEnvRecord?.projects.map((p: ProjectConfig) => (
                    <SelectItem key={p.id} value={p.projectName} className="text-xs">
                      <div className="flex items-center gap-1.5 truncate">
                        <span>{p.projectName}</span>
                        {p.alias && p.alias !== p.projectName && (
                          <span className="text-[11px] text-muted-foreground">→ {p.alias}</span>
                        )}
                      </div>
                    </SelectItem>
                  ))}
                  <SelectItem value="__custom__" className="text-xs">
                    Custom Project…
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>

            {/* Custom project name input */}
            {selectedProject === "__custom__" && (
              <div className="flex items-center">
                <Input
                  value={customProject}
                  onChange={(e) => setCustomProject(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter" && canExport) handleExport(); }}
                  placeholder="ThingWorx project name…"
                  className="h-8.5 text-xs w-44 bg-background"
                  autoFocus
                />
              </div>
            )}
          </div>

          {/* Right: Primary Action Group & Telemetry */}
          <div className="flex items-center gap-2 shrink-0">
            {/* Utilities: refresh, settings, info in one quiet tray */}
            <div className="flex items-center h-8.5 rounded-lg border border-input bg-background shadow-2xs p-0.5 gap-0.5">
              {/* Quick Refresh Local Files */}
              <button
                type="button"
                onClick={() => selectedEnv && loadLocalDirectory(selectedEnv)}
                disabled={!selectedEnv || treeLoading}
                title="Rescan local exported files"
                className="size-7 flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-accent/60 transition-colors disabled:opacity-50 disabled:pointer-events-none cursor-pointer"
              >
                <IconRefresh className={cn("size-3.5", treeLoading && "animate-spin")} />
              </button>

              {/* Manage Environments Shortcut */}
              <button
                type="button"
                onClick={() => router.push("/settings")}
                title="Manage Environments & Projects"
                className="size-7 flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-accent/60 transition-colors cursor-pointer"
              >
                <IconSettings className="size-3.5" />
              </button>

            {/* Info & Telemetry Popover */}
            <Popover>
              <PopoverTrigger
                className="size-7 flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-accent/60 transition-colors cursor-pointer"
                title="Environment details & history"
                render={<button type="button" />}
              >
                <IconInfoCircle className="size-3.5" />
              </PopoverTrigger>
              <PopoverContent align="end" className="w-80 p-3.5 space-y-3">
                <div className="flex items-center justify-between border-b pb-2">
                  <span className="font-semibold text-xs text-foreground">Environment Details</span>
                  <Badge variant="outline" className="text-[10px] font-mono">
                    {selectedEnv || "None"}
                  </Badge>
                </div>

                <div className="space-y-2 text-xs">
                  <div className="flex justify-between py-0.5">
                    <span className="text-muted-foreground">Base URL:</span>
                    <span className="font-mono text-[11px] truncate max-w-44 text-right">
                      {selectedEnvRecord?.twxBaseUrl || "Not set"}
                    </span>
                  </div>

                  <div className="flex justify-between py-0.5">
                    <span className="text-muted-foreground">App Key:</span>
                    <span className={cn("font-medium", selectedEnvRecord?.hasAppKey ? "text-emerald-600 dark:text-emerald-400" : "text-amber-500")}>
                      {selectedEnvRecord?.hasAppKey ? "Configured" : "Missing"}
                    </span>
                  </div>

                  <div className="flex justify-between py-0.5">
                    <span className="text-muted-foreground">Configured Projects:</span>
                    <span className="font-medium">{selectedEnvRecord?.projects.length ?? 0}</span>
                  </div>

                  <div className="flex justify-between gap-3 py-0.5 border-t pt-1.5">
                    <span className="text-muted-foreground shrink-0">Last Exported:</span>
                    <span className="text-right">
                      <span className="font-medium block">{fmtDateTime(lastExported)}</span>
                      {fmtAgo(lastExported) && (
                        <span className="text-[10px] text-muted-foreground">{fmtTimestamp(lastExported)}</span>
                      )}
                    </span>
                  </div>

                  <div className="flex justify-between gap-3 py-0.5">
                    <span className="text-muted-foreground shrink-0">Last Extracted:</span>
                    <span className="text-right">
                      <span
                        className={cn("font-medium block", extractStale && "text-destructive")}
                        title={extractStale ? staleHint : undefined}
                      >
                        {fmtDateTime(lastExtracted)}
                      </span>
                      {fmtAgo(lastExtracted) && (
                        <span className="text-[10px] text-muted-foreground">{fmtTimestamp(lastExtracted)}</span>
                      )}
                    </span>
                  </div>
                </div>

                <Button
                  size="xs"
                  variant="outline"
                  onClick={() => router.push("/settings")}
                  className="w-full text-xs gap-1.5 h-7"
                >
                  <IconSettings className="size-3" />
                  Edit in Settings
                </Button>
              </PopoverContent>
            </Popover>
            </div>

            <div className="h-5 w-px bg-border mx-0.5" />

            {/* Extract from CLI Bundle: secondary step after Export */}
            <button
              type="button"
              onClick={() => handleExtract()}
              disabled={!selectedEnv || jobBusy}
              title={extractStale ? staleHint : "Extract the exported CLI bundle into Code/ folders"}
              className="relative flex items-center gap-1.5 h-8.5 px-3 rounded-lg border border-input bg-background shadow-2xs text-xs font-medium hover:bg-accent/60 transition-colors disabled:opacity-50 disabled:pointer-events-none cursor-pointer"
            >
              {extractStatus === "extracting" ? (
                <Spinner className="size-3.5" />
              ) : (
                <IconPackageImport className="size-3.5 text-muted-foreground" />
              )}
              {extractStatus === "extracting" ? "Extracting…" : "Extract"}
              {extractStale && extractStatus !== "extracting" && (
                <span className="absolute -top-0.5 -right-0.5 size-2 rounded-full bg-amber-500 ring-2 ring-background" />
              )}
            </button>

            {/* Export from ThingWorx: primary action, rightmost; menu holds variants */}
            <div className="flex items-stretch h-8.5 rounded-lg bg-primary text-primary-foreground shadow-xs overflow-hidden">
              <button
                type="button"
                onClick={() => handleExport()}
                disabled={!canExport}
                title="Export the selected project scope from ThingWorx"
                className="flex items-center gap-1.5 pl-3 pr-2.5 text-xs font-semibold hover:bg-white/10 transition-colors disabled:opacity-50 disabled:pointer-events-none cursor-pointer"
              >
                {exportStatus === "exporting" ? (
                  <Spinner className="size-3.5" />
                ) : (
                  <IconDownload className="size-3.5" />
                )}
                {exportStatus === "exporting" ? "Exporting…" : "Export"}
              </button>
              <DropdownMenu>
                <DropdownMenuTrigger
                  disabled={!canExport || extractStatus === "extracting"}
                  title="More export options"
                  className="flex items-center px-1.5 border-l border-primary-foreground/20 hover:bg-white/10 transition-colors disabled:opacity-50 disabled:pointer-events-none cursor-pointer"
                  render={<button type="button" />}
                >
                  <IconChevronDown className="size-3.5" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="text-xs min-w-48">
                  <DropdownMenuItem onClick={() => handleExport()}>
                    <IconDownload className="size-3.5" />
                    Export project
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => handleExport(undefined, true)}>
                    <IconPackageImport className="size-3.5" />
                    Export and Extract
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => setPickerOpen(true)}>
                    <IconListCheck className="size-3.5" />
                    Choose entities…
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
        </div>

        {/* Warning banner when no app key */}
        {selectedEnvRecord && !selectedEnvRecord.hasAppKey && (
          <div className="flex items-center justify-between text-xs px-3 py-1.5 rounded-md bg-amber-500/10 border border-amber-500/20 text-amber-700 dark:text-amber-400">
            <span>
              No App Key configured for &quot;{selectedEnv}&quot;. Exporting requires a valid ThingWorx App Key.
            </span>
            <Button
              size="xs"
              variant="link"
              onClick={() => router.push("/settings")}
              className="text-xs text-amber-700 dark:text-amber-400 h-auto p-0 underline font-medium"
            >
              Add App Key →
            </Button>
          </div>
        )}
      </div>

      {/* ── Main Workspace Body ──────────────────────────────────────────────── */}
      <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
        {treePaths.length > 0 ? (
          <div className="flex-1 min-h-0 flex overflow-hidden">
            {treeLoading ? (
              <div className="flex flex-1 items-center justify-center gap-2 text-muted-foreground">
                <Spinner className="size-5" />
                <span className="text-sm">Loading file tree…</span>
              </div>
            ) : (
              <>
                {/* ── Left Sidebar (File Tree & Search) ────────────────────── */}
                <div
                  className="shrink-0 flex flex-col overflow-hidden border-r bg-card/30"
                  style={{ width: treeWidth }}
                >
                  <FileTreePanel
                    scrollable={false}
                    isSearchActive={searchActive}
                    onSearchToggle={() => setSearchActive((v) => !v)}
                    searchContent={
                      <SearchPanel
                        onSearch={handleSearch}
                        onResultClick={handleSearchResultClick}
                      />
                    }
                    openEditors={
                      <OpenEditorsPanel
                        openPaths={Array.from(openTabs.keys())}
                        activePath={activeTab}
                        onSelect={setActiveTab}
                        onClose={handleCloseTab}
                        onCloseAll={handleCloseAllTabs}
                        dragItems={(paths) =>
                          paths.map((p) => ({ path: `twx-entities/${p.replace(/\/$/, "")}`, isDir: p.endsWith("/") }))
                        }
                        getDecoration={(path) => {
                          const badge = getEntryBadge(path.split("/").pop() ?? "", path);
                          return badge ? { text: badge.label, title: badge.title } : null;
                        }}
                      />
                    }
                  >
                    <div className="h-full">
                      <AppFileTree
                        model={treeModel}
                        header={
                          <AppFileTreeHeader
                            title={<span title={treeLabel}>{treeLabel}</span>}
                            icon={<IconFolder className="size-3.5 text-muted-foreground shrink-0" />}
                            count={`${treePaths.filter((p) => !p.endsWith("/")).length} files`}
                            onExpandAll={expandAllTree}
                            onCollapseAll={collapseAllTree}
                          >
                            <div className="flex items-center gap-2 px-2.5 pb-2">
                              {/* Quick Entity Type Filter Chips */}
                              <div className="flex min-w-0 items-center gap-1 overflow-x-auto">
                                {[
                                  { id: "all", label: "All" },
                                  { id: "Things", label: "Things" },
                                  { id: "ThingTemplates", label: "Templates" },
                                  { id: "ThingShapes", label: "Shapes" },
                                  { id: "Mashups", label: "Mashups" },
                                ].map((chip) => (
                                  <button
                                    key={chip.id}
                                    onClick={() => setEntityFilter(chip.id)}
                                    className={cn(
                                      "px-2 py-0.5 rounded-full text-[10px] font-medium transition-colors whitespace-nowrap cursor-pointer",
                                      entityFilter === chip.id
                                        ? "bg-primary text-primary-foreground font-semibold shadow-xs"
                                        : "bg-muted/70 text-muted-foreground hover:bg-muted hover:text-foreground"
                                    )}
                                  >
                                    {chip.label}
                                  </button>
                                ))}
                              </div>
                              <div className="ml-auto flex items-center gap-1 shrink-0">
                                <button
                                  onClick={() => lastExportDir && openNameDialog({ mode: "file", parent: lastExportDir })}
                                  title="New File…"
                                  className="text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
                                >
                                  <IconFilePlus className="size-3.5" />
                                </button>
                                <button
                                  onClick={() => lastExportDir && openNameDialog({ mode: "dir", parent: lastExportDir })}
                                  title="New Folder…"
                                  className="text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
                                >
                                  <IconFolderPlus className="size-3.5" />
                                </button>
                              </div>
                            </div>
                          </AppFileTreeHeader>
                        }
                        renderContextMenu={(item, context) => {
                          const target: TreeTarget = {
                            path: toFull(item.path),
                            type: item.kind === "directory" ? "dir" : "file",
                          };
                          const parent = target.type === "dir" ? target.path : parentOf(target.path);
                          const run = (action: () => void) => () => {
                            context.close();
                            action();
                          };
                          return (
                            <AppFileTreeMenu>
                              <AppFileTreeMenuItem
                                icon={<IconFilePlus />}
                                onClick={run(() => openNameDialog({ mode: "file", parent }))}
                              >
                                New File…
                              </AppFileTreeMenuItem>
                              <AppFileTreeMenuItem
                                icon={<IconFolderPlus />}
                                onClick={run(() => openNameDialog({ mode: "dir", parent }))}
                              >
                                New Folder…
                              </AppFileTreeMenuItem>
                              <AppFileTreeMenuSeparator />
                              <AppFileTreeMenuItem
                                icon={<IconPencil />}
                                onClick={run(() => openNameDialog({ mode: "rename", target }))}
                              >
                                Rename…
                              </AppFileTreeMenuItem>
                              <AppFileTreeMenuItem
                                icon={<IconCopy />}
                                onClick={run(() => {
                                  navigator.clipboard.writeText(target.path);
                                  toast.success("Copied relative path");
                                })}
                              >
                                Copy Path
                              </AppFileTreeMenuItem>
                              <AppFileTreeMenuSeparator />
                              <AppFileTreeMenuItem
                                icon={<IconTrash />}
                                destructive
                                onClick={run(() => setDeleteTarget(target))}
                              >
                                Delete
                              </AppFileTreeMenuItem>
                            </AppFileTreeMenu>
                          );
                        }}
                      />
                    </div>
                  </FileTreePanel>
                </div>

                {/* Resize Handle */}
                <div
                  className="w-1 shrink-0 bg-border hover:bg-primary/50 cursor-col-resize transition-colors"
                  onMouseDown={handleDragStart}
                />

                {/* ── Center Editor & Entity View Area ──────────────────────── */}
                <div className="flex-1 min-w-0 flex flex-col overflow-hidden bg-background">
                  {openTabs.size > 0 ? (
                    <>
                      {/* Top Tab Bar */}
                      <div className="shrink-0 flex items-stretch border-b bg-muted/30 overflow-x-auto select-none">
                        {Array.from(openTabs.entries()).map(([path, tab]) => {
                          const fileName = path.split("/").pop() ?? "";
                          const isActive = path === activeTab;
                          const badge = getEntryBadge(fileName, path);

                          return (
                            <div
                              key={path}
                              role="button"
                              tabIndex={0}
                              onClick={() => setActiveTab(path)}
                              onKeyDown={(e) => e.key === "Enter" && setActiveTab(path)}
                              className={cn(
                                "group flex items-center gap-1.5 px-3 py-1.5 border-r text-xs whitespace-nowrap cursor-pointer transition-colors relative",
                                isActive
                                  ? "bg-background text-foreground font-medium shadow-2xs"
                                  : "bg-muted/10 text-muted-foreground hover:bg-muted/30 hover:text-foreground"
                              )}
                            >
                              {isActive && (
                                <div className="absolute top-0 left-0 right-0 h-0.5 bg-primary" />
                              )}
                              <FileIcon name={fileName} className="size-3.5 shrink-0" />
                              <span className="font-mono text-[11.5px] truncate max-w-48">{fileName}</span>
                              {badge && (
                                <span
                                  className={cn(
                                    "px-1 py-0 text-[8.5px] font-mono font-bold rounded border uppercase select-none",
                                    badge.color
                                  )}
                                >
                                  {badge.label}
                                </span>
                              )}
                              {(tab.loading || tab.saving) && <Spinner className="size-3 shrink-0 ml-0.5" />}
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleCloseTab(path);
                                }}
                                title={isDirty(tab) ? "Unsaved changes — close tab" : "Close tab"}
                                className="ml-1 rounded p-0.5 text-muted-foreground hover:text-foreground hover:bg-accent/60 transition-colors"
                              >
                                {isDirty(tab) ? (
                                  <>
                                    <span className="block size-3 group-hover:hidden">
                                      <span className="block size-2 m-0.5 rounded-full bg-foreground/70" />
                                    </span>
                                    <IconX className="size-3 hidden group-hover:block" />
                                  </>
                                ) : (
                                  <IconX className="size-3" />
                                )}
                              </button>
                            </div>
                          );
                        })}

                        {/* Tab Bar Action Menu */}
                        <div className="ml-auto shrink-0 flex items-center px-2">
                          <DropdownMenu>
                            <DropdownMenuTrigger
                              className="h-6 px-2 text-[11px] font-medium text-muted-foreground hover:text-foreground rounded hover:bg-accent/50 transition-colors cursor-pointer"
                              render={<button type="button" />}
                            >
                              Tabs
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end" className="text-xs">
                              {activeTab && (
                                <DropdownMenuItem onClick={() => activeTab && handleCloseOthers(activeTab)}>
                                  Close Other Tabs
                                </DropdownMenuItem>
                              )}
                              <DropdownMenuItem onClick={handleCloseAllTabs}>
                                Close All Tabs
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </div>
                      </div>

                      {/* Breadcrumbs & View Mode Switcher */}
                      {activeTab && (
                        <div className="shrink-0 px-4 py-1.5 border-b bg-card/40 flex items-center justify-between gap-3 flex-wrap text-xs">
                          {/* Breadcrumb path */}
                          <div className="flex items-center gap-1.5 font-mono text-[11px] text-muted-foreground truncate min-w-0">
                            <span className="truncate">{activeTab}</span>
                            <Button
                              size="xs"
                              variant="ghost"
                              onClick={() => {
                                navigator.clipboard.writeText(activeTab);
                                toast.success("Copied relative path");
                              }}
                              title="Copy path"
                              className="h-5 w-5 p-0 text-muted-foreground hover:text-foreground"
                            >
                              <IconCopy className="size-3" />
                            </Button>
                          </div>

                          <div className="ml-auto flex items-center gap-2 shrink-0">
                            {activeTabState?.content != null && (
                              <Button
                                size="xs"
                                variant="outline"
                                draggable
                                onDragStart={(e) => setDragPins(e, [codePin(true)])}
                                onClick={() => addPins([codePin(false)])}
                                title="Add the open code (or your selection in it) to the assistant chat"
                                className="h-5 gap-1 px-1.5 text-[10.5px] font-sans shrink-0"
                              >
                                <IconMessagePlus className="size-3" />
                                Add to chat
                              </Button>
                            )}
                            {activeTabState?.content != null && (
                              <Button
                                size="xs"
                                variant="outline"
                                onClick={() => {
                                  navigator.clipboard.writeText(activeTabState.content ?? "");
                                  toast.success(
                                    isDirty(activeTabState)
                                      ? "Copied the code, including unsaved edits"
                                      : "Copied the code"
                                  );
                                }}
                                title="Copy this file's code, to paste into ThingWorx"
                                className="h-5 gap-1 px-1.5 text-[10.5px] font-sans shrink-0"
                              >
                                <IconClipboard className="size-3" />
                                Copy code
                              </Button>
                            )}
                            {activeTabState && isDirty(activeTabState) && (
                              <Button
                                size="xs"
                                variant="outline"
                                onClick={() => saveTab(activeTab)}
                                disabled={activeTabState.saving}
                                title="Save (Ctrl+S)"
                                className="h-5 gap-1 px-1.5 text-[10.5px] font-sans shrink-0"
                              >
                                {activeTabState.saving ? (
                                  <Spinner className="size-3" />
                                ) : (
                                  <IconDeviceFloppy className="size-3" />
                                )}
                                Save
                              </Button>
                            )}

                          {/* View Mode Switcher (Overview | Code | Split) */}
                          {parsedEntity && (
                            <div className="flex items-center gap-1 bg-muted/60 p-0.5 rounded-lg border">
                              <button
                                onClick={() => setViewMode("overview")}
                                className={cn(
                                  "flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-medium transition-colors cursor-pointer",
                                  viewMode === "overview"
                                    ? "bg-background text-foreground shadow-2xs font-semibold"
                                    : "text-muted-foreground hover:text-foreground"
                                )}
                              >
                                <IconEye className="size-3" />
                                Overview
                              </button>

                              <button
                                onClick={() => setViewMode("split")}
                                className={cn(
                                  "flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-medium transition-colors cursor-pointer",
                                  viewMode === "split"
                                    ? "bg-background text-foreground shadow-2xs font-semibold"
                                    : "text-muted-foreground hover:text-foreground"
                                )}
                              >
                                <IconLayoutColumns className="size-3" />
                                Split
                              </button>

                              <button
                                onClick={() => setViewMode("code")}
                                className={cn(
                                  "flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-medium transition-colors cursor-pointer",
                                  viewMode === "code"
                                    ? "bg-background text-foreground shadow-2xs font-semibold"
                                    : "text-muted-foreground hover:text-foreground"
                                )}
                              >
                                <IconCode className="size-3" />
                                Raw XML
                              </button>
                            </div>
                          )}
                          </div>
                        </div>
                      )}

                      {/* Tab Content Display */}
                      <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
                        {activeTabState?.loading ? (
                          <div className="flex flex-col items-center justify-center h-full gap-2 text-muted-foreground">
                            <Spinner className="size-6" />
                            <span className="text-xs">Loading entity…</span>
                          </div>
                        ) : activeTabState?.error ? (
                          <div className="p-6">
                            <p className="text-xs text-destructive bg-destructive/10 p-3 rounded-lg border border-destructive/20 font-mono">
                              {activeTabState.error}
                            </p>
                          </div>
                        ) : activeTab && activeTabState && activeTabState.content !== null ? (
                          <div className="flex-1 min-h-0 flex overflow-hidden">
                            {/* OVERVIEW MODE */}
                            {viewMode === "overview" && parsedEntity ? (
                              <div className="flex-1 min-h-0 min-w-0 overflow-hidden">
                                <EntityOverview
                                  entity={parsedEntity}
                                  filePath={activeTab}
                                  initialService={activeTab === linkedPath ? link?.service : undefined}
                                  onOpenServiceCode={(service) => openServiceCode(activeTab, service)}
                                  onViewCodeClick={() => setViewMode("code")}
                                  onServiceChange={setOverviewService}
                                  onReexport={selectedEnvRecord?.hasAppKey ? () => reexportTab(activeTab) : undefined}
                                />
                              </div>
                            ) : viewMode === "split" && parsedEntity ? (
                              /* SPLIT MODE (Overview left, Monaco right) */
                              <div className="flex-1 min-h-0 flex overflow-hidden">
                                <div className="w-1/2 min-w-0 border-r overflow-hidden">
                                  <EntityOverview
                                    entity={parsedEntity}
                                    filePath={activeTab}
                                      initialService={activeTab === linkedPath ? link?.service : undefined}
                                    onOpenServiceCode={(service) => openServiceCode(activeTab, service)}
                                    onServiceChange={setOverviewService}
                                    onReexport={selectedEnvRecord?.hasAppKey ? () => reexportTab(activeTab) : undefined}
                                  />
                                </div>
                                <div className="w-1/2 min-w-0 overflow-hidden">
                                  <MonacoEditor
                                    key={`split-${activeTab}`}
                                    height="100%"
                                    language={getLanguage(activeTab)}
                                    value={activeTabState.content}
                                    theme={resolvedTheme === "dark" ? "vs-dark" : "vs"}
                                    onChange={(value) => handleEditorChange(activeTab, value)}
                                    onMount={(ed, monaco) => {
                                      ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => saveActiveRef.current());
                                      watchSelection(ed, activeTab);
                                    }}
                                    options={{
                                      minimap: { enabled: false },
                                      scrollBeyondLastLine: false,
                                      wordWrap: "on",
                                      fontSize: 13,
                                      lineNumbers: "on",
                                      folding: true,
                                      automaticLayout: true,
                                    }}
                                  />
                                </div>
                              </div>
                            ) : (
                              /* CODE MODE (Full Monaco Editor) */
                              <div className="flex-1 min-h-0 min-w-0">
                                <MonacoEditor
                                  key={activeTab}
                                  height="100%"
                                  language={getLanguage(activeTab)}
                                  value={activeTabState.content}
                                  theme={resolvedTheme === "dark" ? "vs-dark" : "vs"}
                                  onChange={(value) => handleEditorChange(activeTab, value)}
                                  options={{
                                    minimap: { enabled: true },
                                    scrollBeyondLastLine: false,
                                    wordWrap: "on",
                                    fontSize: 13,
                                    lineNumbers: "on",
                                    folding: true,
                                    renderLineHighlight: "line",
                                    automaticLayout: true,
                                  }}
                                  onMount={(ed, monaco) => {
                                    editorRef.current = ed;
                                    watchSelection(ed, activeTab);
                                    ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => saveActiveRef.current());
                                    const jump = pendingJumpRef.current;
                                    if (jump) {
                                      pendingJumpRef.current = null;
                                      setTimeout(() => {
                                        ed.revealLineInCenter(jump.line);
                                        ed.setPosition({ lineNumber: jump.line, column: jump.col });
                                        ed.focus();
                                      }, 50);
                                    }
                                  }}
                                />
                              </div>
                            )}
                          </div>
                        ) : null}
                      </div>
                    </>
                  ) : (
                    /* Editor Empty State */
                    <div className="flex flex-col items-center justify-center h-full text-muted-foreground gap-3 p-6">
                      <div className="flex size-14 items-center justify-center rounded-2xl bg-muted/40 border">
                        <IconFile className="size-7 opacity-40" />
                      </div>
                      <div className="text-center space-y-1">
                        <h3 className="text-sm font-semibold text-foreground">No File Selected</h3>
                        <p className="text-xs text-muted-foreground max-w-sm">
                          Select any entity from the explorer on the left to view its structured properties, services, and raw XML.
                        </p>
                      </div>
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
        ) : (
          /* ── Global Empty State / Guided Getting Started ──────────────────── */
          <div className="flex-1 flex flex-col items-center justify-center p-8 text-center bg-radial from-muted/30 to-background">
            <div className="max-w-md w-full space-y-6">
              <div className="flex size-16 items-center justify-center rounded-2xl bg-gradient-to-br from-indigo-500/10 to-violet-500/20 border border-primary/20 text-primary mx-auto shadow-sm">
                <IconDeviceDesktopAnalytics className="size-8" />
              </div>

              <div className="space-y-2">
                <h3 className="text-lg font-bold tracking-tight text-foreground">
                  ThingWorx Entity Explorer
                </h3>
                <p className="text-xs text-muted-foreground leading-relaxed">
                  Export XML entities from ThingWorx, extract CLI bundles, and inspect properties, services, and JavaScript implementation code in high fidelity.
                </p>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-2">
                <Button
                  size="default"
                  onClick={() => handleExport()}
                  disabled={!canExport}
                  className="h-10 text-xs font-medium gap-2 shadow-sm bg-gradient-to-r from-indigo-600 to-violet-600 hover:from-indigo-500 hover:to-violet-500 text-white border-0"
                >
                  <IconDownload className="size-4" />
                  Export from ThingWorx
                </Button>

                <Button
                  size="default"
                  variant="outline"
                  onClick={() => handleExtract()}
                  disabled={!selectedEnv || jobBusy}
                  className="h-10 text-xs font-medium gap-2 shadow-2xs"
                >
                  <IconPackageImport className="size-4" />
                  Extract CLI Bundle
                </Button>
              </div>

              {envs.length === 0 && (
                <div className="p-3 rounded-lg border bg-amber-500/10 border-amber-500/20 text-xs text-amber-700 dark:text-amber-400 flex items-center justify-between gap-2 text-left">
                  <span>No environments configured yet.</span>
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={() => router.push("/settings")}
                    className="text-xs shrink-0"
                  >
                    Open Settings
                  </Button>
                </div>
              )}
            </div>
          </div>
        )}

        {/* ── Real-time Process Output Drawer ───────────────────────────────── */}
        <OutputDrawer
          title={
            exportStatus === "exporting" || exportStatus === "done"
              ? "ThingWorx Export Console"
              : "CLI Extract Console"
          }
          status={activeProcessStatus}
          messages={activeProcessMessages}
          onClear={handleClearLogs}
          isOpen={isOutputOpen}
          onToggleOpen={() => setIsOutputOpen((v) => !v)}
        />
      </div>

      {/* ── Footer: last export / extract ─────────────────────────────────── */}
      <div className="shrink-0 border-t bg-card/70 px-4 py-1 flex items-center justify-end gap-4 text-[11px] text-muted-foreground overflow-x-auto whitespace-nowrap">
        <span className="flex items-center gap-1.5" title={fmtAgo(lastExported)}>
          <IconDownload className="size-3" />
          Last exported:
          <span className="font-medium text-foreground">{fmtDateTime(lastExported)}</span>
        </span>
        <span
          className={cn("flex items-center gap-1.5", extractStale && "text-destructive")}
          title={extractStale ? staleHint : fmtAgo(lastExtracted)}
        >
          <IconPackageImport className="size-3" />
          Last extracted:
          <span className={cn("font-medium", extractStale ? "text-destructive" : "text-foreground")}>
            {fmtDateTime(lastExtracted)}
          </span>
        </span>
      </div>

      {/* ── Delete confirmation ───────────────────────────────────────────── */}
      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open && !deleteBusy) setDeleteTarget(null);
        }}
      >
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogTitle>
              Delete {deleteTarget?.type === "dir" ? "folder" : "file"} &quot;{deleteTarget?.path.split("/").pop()}&quot;?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {deleteTarget?.type === "dir"
                ? "The folder and everything inside it will be permanently deleted. "
                : "The file will be permanently deleted. "}
              This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteBusy}>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" disabled={deleteBusy} onClick={confirmDelete}>
              {deleteBusy && <Spinner className="size-3.5" />}
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <ExportPicker
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        env={selectedEnv}
        project={resolvedProjectName}
        projectLabel={resolvedProjectName ?? "All configured projects"}
        onExport={(only) => handleExport(only)}
      />

      {/* ── New file / folder, rename ─────────────────────────────────────── */}
      <Dialog
        open={nameDialog !== null}
        onOpenChange={(open) => {
          if (!open && !nameBusy) setNameDialog(null);
        }}
      >
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>
              {nameDialog?.mode === "rename"
                ? `Rename ${nameDialog.target.type === "dir" ? "folder" : "file"}`
                : nameDialog?.mode === "dir"
                ? "New folder"
                : "New file"}
            </DialogTitle>
            <DialogDescription className="font-mono text-[11px] break-all">
              {nameDialog?.mode === "rename"
                ? nameDialog.target.path
                : `in ${nameDialog?.parent ?? ""}`}
            </DialogDescription>
          </DialogHeader>

          <form onSubmit={submitNameDialog} className="flex flex-col gap-3">
            <Input
              autoFocus
              value={nameValue}
              onChange={(e) => {
                setNameValue(e.target.value);
                setNameError(null);
              }}
              onFocus={(e) => {
                // Select the base name, as VS Code does, so typing keeps the extension.
                const dot = e.target.value.lastIndexOf(".");
                e.target.setSelectionRange(0, dot > 0 ? dot : e.target.value.length);
              }}
              placeholder={nameDialog?.mode === "dir" ? "Folder name" : "File name, e.g. MyService.js"}
              className="h-8 text-xs font-mono"
              required
            />
            {nameError && <p className="text-xs text-destructive">{nameError}</p>}
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={nameBusy}
                onClick={() => setNameDialog(null)}
              >
                Cancel
              </Button>
              <Button type="submit" size="sm" disabled={nameBusy || !nameValue.trim()}>
                {nameBusy && <Spinner className="size-3.5" />}
                {nameDialog?.mode === "rename" ? "Rename" : "Create"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
