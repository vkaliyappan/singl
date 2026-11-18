"use client";

// Ported from singl-web's Compare page; diffs come from the compare commands
// (src/lib/compare.ts) instead of /api/compare.

import { useState, useCallback, useRef, useEffect, useMemo } from "react";
import { useAssistantContext } from "@/lib/assistant/context";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useTheme } from "@/components/providers";
import {
  IconRefresh,
  IconLoader2,
  IconSettings,
  IconEye,
  IconEyeOff,
  IconArrowsExchange,
  IconX,
  IconCheck,
  IconCopy,
  IconArrowUp,
  IconArrowDown,
  IconColumns,
  IconLayoutList,
  IconFilter,
  IconPlus,
  IconMinus,
  IconEdit,
  IconEqual,
  IconInfoCircle,
  IconMessagePlus,
  IconFileDiff,
  IconSpace,
  IconTextWrap,
  IconGitCompare,
} from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { FileIcon, FileTreePanel, OpenEditorsPanel } from "@/components/file-tree";
import { CompareFileTree } from "./compare-file-tree";
import { SearchPanel, type SearchOptions, type SearchFileResult } from "@/components/search-panel";
import { getCompareContent, getCompareTree, searchCompare, type DiffNode, type NodeStatus } from "@/lib/compare";
import { addPins, usePinnables, type NewPin } from "@/lib/assistant/pins";
import { errorMessage } from "@/lib/settings";
import type { OnMount, DiffOnMount } from "@monaco-editor/react";
import { clipText, PIN_LIMIT } from "@/lib/assistant/pin-utils";

const editorLoading = () => (
  <div className="flex flex-col items-center justify-center h-full gap-2 text-muted-foreground text-xs">
    <IconLoader2 className="size-5 animate-spin text-primary" />
    <span>Loading Monaco editor…</span>
  </div>
);

const MonacoDiffEditor = dynamic(
  () => import("@monaco-editor/react").then((m) => ({ default: m.DiffEditor })),
  { ssr: false, loading: editorLoading }
);

const MonacoEditor = dynamic(
  () => import("@monaco-editor/react"),
  { ssr: false, loading: editorLoading }
);

interface TreeData {
  nodes: DiffNode[];
  summary: { added: number; removed: number; modified: number; identical: number };
  leftRoot: string;
  rightRoot: string;
}

// ── "Add to chat" helpers ────────────────────────────────────────────────────



interface DiffTabState {
  node: DiffNode;
  leftContent: string | null;
  rightContent: string | null;
  leftSize?: number;
  rightSize?: number;
  loading: boolean;
  error: string | null;
}

interface CompareExplorerProps {
  envs: string[];
}

type StatusFilterType = "all" | "changed" | "modified" | "added" | "removed" | "identical";

function formatBytes(bytes?: number): string {
  if (bytes === undefined || bytes === null) return "";
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

function StatusBadge({ status, size = "sm" }: { status: NodeStatus; size?: "sm" | "md" }) {
  if (status === "identical") return null;

  const config: Record<
    Exclude<NodeStatus, "identical">,
    { label: string; full: string; className: string; bg: string }
  > = {
    added: {
      label: "A",
      full: "Added",
      className: "text-emerald-600 dark:text-emerald-400 font-bold",
      bg: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/30",
    },
    removed: {
      label: "D",
      full: "Deleted",
      className: "text-rose-600 dark:text-rose-400 font-bold",
      bg: "bg-rose-500/10 text-rose-600 dark:text-rose-400 border-rose-500/30",
    },
    modified: {
      label: "M",
      full: "Modified",
      className: "text-amber-600 dark:text-amber-400 font-bold",
      bg: "bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/30",
    },
  };

  const item = config[status as Exclude<NodeStatus, "identical">];
  if (!item) return null;

  if (size === "md") {
    return (
      <span
        className={cn(
          "inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium border uppercase tracking-wider",
          item.bg
        )}
      >
        {item.full}
      </span>
    );
  }

  return (
    <span
      className={cn("text-[10px] shrink-0 w-3 text-center", item.className)}
      title={item.full}
    >
      {item.label}
    </span>
  );
}

const STATUS_DECORATION: Record<Exclude<NodeStatus, "identical">, { text: string; title: string }> = {
  added: { text: "A", title: "Added" },
  removed: { text: "D", title: "Deleted" },
  modified: { text: "M", title: "Modified" },
};

const STORAGE_KEY = "singl:compare:v2";

type SavedState = {
  selectedEnv?: string;
  baseIsRepo?: boolean;
  statusFilter?: StatusFilterType;
  hideIdentical?: boolean;
  diffView?: "side" | "inline";
  ignoreTrimWhitespace?: boolean;
  wordWrap?: boolean;
  treeWidth?: number;
  expandedDirs?: string[];
  selectedPath?: string | null;
  treeData?: TreeData | null;
};

function readSavedState(): SavedState {
  if (typeof window === "undefined") return {};
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as SavedState) : {};
  } catch {
    return {};
  }
}

export function CompareExplorer({ envs }: CompareExplorerProps) {
  const { resolvedTheme } = useTheme();

  // ── Search & Filter State ──────────────────────────────────────────────────
  const [searchActive, setSearchActive] = useState(false);
  const [quickFilter, setQuickFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilterType>("all");

  // ── Panel Resizing ────────────────────────────────────────────────────────
  const [treeWidth, setTreeWidth] = useState(300);
  const treeWidthRef = useRef(treeWidth);
  useEffect(() => {
    treeWidthRef.current = treeWidth;
  });

  const handleDragStart = useCallback((e: React.MouseEvent) => {
    const startX = e.clientX;
    const startWidth = treeWidthRef.current;
    const onMove = (ev: MouseEvent) => {
      setTreeWidth(Math.max(200, Math.min(650, startWidth + ev.clientX - startX)));
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

  // ── Compare Data State ────────────────────────────────────────────────────
  const [selectedEnv, setSelectedEnv] = useState<string>(envs[0] ?? "");
  const [baseIsRepo, setBaseIsRepo] = useState(true);
  const [treeData, setTreeData] = useState<TreeData | null>(null);
  const [treeLoading, setTreeLoading] = useState(false);
  const [treeError, setTreeError] = useState<string | null>(null);

  // Open folders in the tree, as "a/", "a/b/"; persisted across reloads.
  const [expandedDirs, setExpandedDirs] = useState<string[]>([]);
  const [hideIdentical, setHideIdentical] = useState(false);
  const [diffView, setDiffView] = useState<"side" | "inline">("side");
  const [ignoreTrimWhitespace, setIgnoreTrimWhitespace] = useState(true);
  const [wordWrap, setWordWrap] = useState(true);
  const [copiedPath, setCopiedPath] = useState<string | null>(null);

  // ── Multi-tab Diff State ──────────────────────────────────────────────────
  const [openDiffTabs, setOpenDiffTabs] = useState<Map<string, DiffTabState>>(new Map());
  const [activeTab, setActiveTab] = useState<string | null>(null);
  const openDiffTabsRef = useRef(openDiffTabs);
  openDiffTabsRef.current = openDiffTabs;
  const activeTabRef = useRef(activeTab);
  activeTabRef.current = activeTab;

  const [nodeMap, setNodeMap] = useState<Map<string, DiffNode>>(new Map());

  useAssistantContext({
    screen: "compare",
    title: "Compare",
    summary: `Comparing ${baseIsRepo ? "repository" : "local exports"} with ${selectedEnv || "no environment"}${
      activeTab ? `, ${activeTab.split("/").at(-1)} diff open` : ""
    }`,
    data: { env: selectedEnv, baseIsRepo, statusFilter, hideIdentical, quickFilter, openDiffs: [...openDiffTabs.keys()].slice(0, 20), activeDiff: activeTab },
    selection: { files: activeTab ? [activeTab] : [] },
  });

  // ── Monaco Editor & Diff Navigator Refs ───────────────────────────────────
  const pendingJumpRef = useRef<{ line: number; col: number } | null>(null);
  const singleEditorRef = useRef<Parameters<OnMount>[0] | null>(null);
  const diffEditorRef = useRef<Parameters<DiffOnMount>[0] | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const diffNavigatorRef = useRef<any>(null);

  // ── Persistence ───────────────────────────────────────────────────────────
  const hasMountedRef = useRef(false);
  const pendingRestorePathRef = useRef<string | null>(null);

  useEffect(() => {
    const saved = readSavedState();
    if (saved.treeWidth !== undefined) setTreeWidth(saved.treeWidth);
    if (saved.selectedEnv && envs.includes(saved.selectedEnv)) setSelectedEnv(saved.selectedEnv);
    if (saved.baseIsRepo !== undefined) setBaseIsRepo(saved.baseIsRepo);
    if (saved.statusFilter) setStatusFilter(saved.statusFilter);
    if (saved.hideIdentical !== undefined) setHideIdentical(saved.hideIdentical);
    if (saved.diffView) setDiffView(saved.diffView);
    if (saved.ignoreTrimWhitespace !== undefined) setIgnoreTrimWhitespace(saved.ignoreTrimWhitespace);
    if (saved.wordWrap !== undefined) setWordWrap(saved.wordWrap);
    if (saved.expandedDirs) setExpandedDirs(saved.expandedDirs.map((d) => (d.endsWith("/") ? d : `${d}/`)));
    if (saved.treeData) {
      setTreeData(saved.treeData);
      const map = new Map<string, DiffNode>();
      for (const n of saved.treeData.nodes) map.set(n.path, n);
      setNodeMap(map);
      if (saved.selectedPath) {
        pendingRestorePathRef.current = saved.selectedPath;
        setActiveTab(saved.selectedPath);
      }
    }
  }, [envs]);

  const selectedEnvRef = useRef(selectedEnv);
  useEffect(() => {
    selectedEnvRef.current = selectedEnv;
  });

  const handleCopyPath = useCallback((path: string) => {
    navigator.clipboard?.writeText(path);
    setCopiedPath(path);
    setTimeout(() => setCopiedPath((prev) => (prev === path ? null : prev)), 2000);
  }, []);

  const handleFileClick = useCallback(async (path: string, node: DiffNode) => {
    if (openDiffTabsRef.current.has(path)) {
      setActiveTab(path);
      return;
    }
    setOpenDiffTabs((prev) =>
      new Map(prev).set(path, {
        node,
        leftContent: null,
        rightContent: null,
        loading: true,
        error: null,
      })
    );
    setActiveTab(path);

    try {
      const { left, right } = await getCompareContent(selectedEnvRef.current, path);
      setOpenDiffTabs((prev) => {
        const next = new Map(prev);
        next.set(path, {
          node,
          leftContent: left.content ?? "",
          rightContent: right.content ?? "",
          leftSize: left.size ?? undefined,
          rightSize: right.size ?? undefined,
          loading: false,
          error:
            left.tooLarge || right.tooLarge
              ? "File too large to display in Monaco diff (> 1 MB)"
              : null,
        });
        return next;
      });
    } catch (e) {
      setOpenDiffTabs((prev) => {
        const next = new Map(prev);
        next.set(path, {
          node,
          leftContent: null,
          rightContent: null,
          loading: false,
          error: errorMessage(e),
        });
        return next;
      });
    }
  }, []);

  // Re-fetch file content after state restore
  useEffect(() => {
    const path = pendingRestorePathRef.current;
    if (!path || nodeMap.size === 0) return;
    pendingRestorePathRef.current = null;
    const node = nodeMap.get(path);
    if (node) handleFileClick(path, node);
  }, [nodeMap, handleFileClick]);

  useEffect(() => {
    if (!hasMountedRef.current) {
      hasMountedRef.current = true;
      return;
    }
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          selectedEnv,
          baseIsRepo,
          statusFilter,
          hideIdentical,
          diffView,
          ignoreTrimWhitespace,
          wordWrap,
          treeWidth,
          expandedDirs,
          selectedPath: activeTab,
          treeData,
        })
      );
    } catch {}
  }, [
    selectedEnv,
    baseIsRepo,
    statusFilter,
    hideIdentical,
    diffView,
    ignoreTrimWhitespace,
    wordWrap,
    treeWidth,
    expandedDirs,
    activeTab,
    treeData,
  ]);

  const handleCloseTab = useCallback((path: string) => {
    const tabs = Array.from(openDiffTabsRef.current.keys());
    const idx = tabs.indexOf(path);
    setOpenDiffTabs((prev) => {
      const next = new Map(prev);
      next.delete(path);
      return next;
    });
    setActiveTab((prev) => {
      if (prev !== path) return prev;
      return tabs[idx + 1] ?? tabs[idx - 1] ?? null;
    });
  }, []);

  const handleCloseAllTabs = useCallback(() => {
    setOpenDiffTabs(new Map());
    setActiveTab(null);
  }, []);

  const handleCloseOtherTabs = useCallback((keepPath: string) => {
    setOpenDiffTabs((prev) => {
      const current = prev.get(keepPath);
      if (!current) return new Map();
      return new Map([[keepPath, current]]);
    });
    setActiveTab(keepPath);
  }, []);

  // Keyboard shortcut listener
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      // Escape closes current tab
      if (e.key === "Escape" && activeTabRef.current) {
        handleCloseTab(activeTabRef.current);
      }
      // F7 / Shift+F7 for Monaco Diff Navigation
      if (e.key === "F7") {
        e.preventDefault();
        if (e.shiftKey) {
          diffNavigatorRef.current?.previous();
        } else {
          diffNavigatorRef.current?.next();
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [handleCloseTab]);

  const loadTree = useCallback(async (env: string) => {
    if (!env) return;
    setTreeLoading(true);
    setTreeError(null);
    setTreeData(null);
    setOpenDiffTabs(new Map());
    setActiveTab(null);
    setExpandedDirs([]);
    setQuickFilter("");

    try {
      const data = await getCompareTree(env);
      setTreeData(data);
      const map = new Map<string, DiffNode>();
      for (const node of data.nodes) map.set(node.path, node);
      setNodeMap(map);

      // Auto expand first-level directories if small
      setExpandedDirs(
        data.nodes
          .filter((node) => node.type === "dir" && !node.path.includes("/"))
          .map((node) => `${node.path}/`)
      );
    } catch (e) {
      setTreeError(errorMessage(e));
    } finally {
      setTreeLoading(false);
    }
  }, []);

  // ── Diff Navigator Next / Prev ────────────────────────────────────────────
  const handleNextDiff = useCallback(() => {
    diffNavigatorRef.current?.next();
  }, []);

  const handlePrevDiff = useCallback(() => {
    diffNavigatorRef.current?.previous();
  }, []);

  // ── Search Panel Handlers ─────────────────────────────────────────────────
  const handleSearch = useCallback(
    async (query: string, opts: SearchOptions): Promise<SearchFileResult[]> => {
      if (!selectedEnv) return [];
      let data;
      try {
        data = await searchCompare(selectedEnv, query, opts);
      } catch (err) {
        throw new Error(errorMessage(err));
      }
      if (data.results.length === 0 && data.warnings.length) throw new Error(data.warnings.join("\n"));
      return data.results;
    },
    [selectedEnv]
  );

  const handleSearchResultClick = useCallback(
    (filePath: string, lineNumber: number, col: number) => {
      pendingJumpRef.current = { line: lineNumber, col };
      const node = nodeMap.get(filePath) ?? {
        path: filePath,
        name: filePath.split("/").pop() ?? filePath,
        type: "file" as const,
        status: "identical" as const,
        leftExists: true,
        rightExists: true,
      };
      handleFileClick(filePath, node);
    },
    [nodeMap, handleFileClick]
  );

  // ── Files that pass the filters (folders follow from their paths) ────────
  const visibleFiles = useMemo(() => {
    if (!treeData) return [];
    const lowerFilter = quickFilter.trim().toLowerCase();
    return treeData.nodes.filter((node) => {
      if (node.type !== "file") return false;
      if (hideIdentical && node.status === "identical") return false;
      if (statusFilter === "changed" && node.status === "identical") return false;
      if (statusFilter === "modified" && node.status !== "modified") return false;
      if (statusFilter === "added" && node.status !== "added") return false;
      if (statusFilter === "removed" && node.status !== "removed") return false;
      if (statusFilter === "identical" && node.status !== "identical") return false;
      return !lowerFilter || node.path.toLowerCase().includes(lowerFilter);
    });
  }, [treeData, quickFilter, statusFilter, hideIdentical]);

  const handleTreeFileOpen = useCallback(
    (path: string) => {
      const node = nodeMap.get(path);
      if (node) handleFileClick(path, node);
    },
    [nodeMap, handleFileClick]
  );

  const activeTabData = activeTab ? openDiffTabs.get(activeTab) : null;

  // ── Add to chat: the active file's comparison (both sides, each clipped) ──
  const leftName = baseIsRepo ? "Repo" : "TWX";
  const rightName = baseIsRepo ? "TWX" : "Repo";
  const compareReady = !!activeTab && !!activeTabData && activeTabData.leftContent !== null && activeTabData.rightContent !== null;
  const comparePin = (): NewPin | null => {
    if (!activeTab || !activeTabData || activeTabData.leftContent === null || activeTabData.rightContent === null) return null;
    const half = PIN_LIMIT / 2;
    return {
      kind: "diff",
      label: activeTab,
      screen: "compare",
      detail: `${leftName} ↔ ${rightName}${selectedEnv ? ` · ${selectedEnv}` : ""}`,
      content: [
        `=== Left: ${leftName} ===`,
        clipText(activeTabData.leftContent, half),
        `=== Right: ${rightName}${selectedEnv ? ` (${selectedEnv})` : ""} ===`,
        clipText(activeTabData.rightContent, half),
      ].join("\n"),
    };
  };
  const pinCompare = () => {
    const p = comparePin();
    if (p) addPins([p]);
  };
  usePinnables(
    compareReady ? [{ kind: "diff", label: activeTab ?? "", detail: `${leftName} ↔ ${rightName}`, content: () => comparePin()?.content ?? "" }] : []
  );

  const language = useMemo(() => {
    if (!activeTab) return "plaintext";
    const ext = activeTab.split(".").pop()?.toLowerCase() ?? "";
    const map: Record<string, string> = {
      ts: "typescript",
      tsx: "typescript",
      js: "javascript",
      jsx: "javascript",
      json: "json",
      py: "python",
      xml: "xml",
      html: "html",
      css: "css",
      md: "markdown",
      yaml: "yaml",
      yml: "yaml",
      sql: "sql",
      sh: "shell",
      graphql: "graphql",
      gql: "graphql",
    };
    return map[ext] ?? "plaintext";
  }, [activeTab]);

  const totalChanges = useMemo(() => {
    if (!treeData) return 0;
    return treeData.summary.added + treeData.summary.removed + treeData.summary.modified;
  }, [treeData]);

  return (
    <div className="flex flex-col h-full overflow-hidden bg-background">
      {/* ── Top Command Bar & Global Controls ─────────────────────────────────── */}
      <header className="flex items-center justify-between gap-3 px-3 py-2 border-b bg-card/60 backdrop-blur shrink-0 flex-wrap">
        {/* Left: Environment & Run Action */}
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1.5">
            <IconGitCompare className="size-4 text-primary shrink-0" />
            <span className="font-semibold text-xs tracking-tight hidden sm:inline">Compare:</span>
          </div>

          <Select
            value={selectedEnv}
            onValueChange={(v) => {
              if (v) setSelectedEnv(v);
            }}
            disabled={treeLoading}
          >
            <SelectTrigger className="h-8 text-xs w-44 font-medium bg-background">
              <SelectValue placeholder="Select environment…" />
            </SelectTrigger>
            <SelectContent>
              {envs.length === 0 && (
                <SelectItem value="__none__" disabled>
                  No environments configured
                </SelectItem>
              )}
              {envs.map((e) => (
                <SelectItem key={e} value={e}>
                  <span className="font-medium">{e}</span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Button
            size="sm"
            className="h-8 text-xs font-semibold px-3 shadow-xs"
            onClick={() => loadTree(selectedEnv)}
            disabled={!selectedEnv || treeLoading}
          >
            {treeLoading ? (
              <IconLoader2 className="size-3.5 animate-spin mr-1.5" />
            ) : (
              <IconRefresh className="size-3.5 mr-1.5" />
            )}
            Compare
          </Button>

          {/* Direction Switcher (Repo ↔ TWX) */}
          <div className="flex items-center rounded-md border bg-muted/30 p-0.5 text-xs">
            <button
              onClick={() => setBaseIsRepo((prev) => !prev)}
              className="flex items-center gap-1 px-2 py-1 rounded hover:bg-background transition-all text-xs font-medium cursor-pointer"
              title={`Click to swap base (Left: ${baseIsRepo ? "Repo" : "TWX"}, Right: ${baseIsRepo ? "TWX" : "Repo"})`}
            >
              <span
                className={cn(
                  "px-1 rounded text-[11px]",
                  baseIsRepo ? "bg-primary/10 text-primary font-semibold" : "text-muted-foreground"
                )}
              >
                Repo
              </span>
              <IconArrowsExchange className="size-3 text-muted-foreground" />
              <span
                className={cn(
                  "px-1 rounded text-[11px]",
                  !baseIsRepo ? "bg-primary/10 text-primary font-semibold" : "text-muted-foreground"
                )}
              >
                TWX
              </span>
            </button>
          </div>
        </div>

        {/* Center: Diff Summary & Interactive Filter Pills */}
        {treeData && (
          <div className="flex items-center gap-1.5 bg-muted/40 p-1 rounded-lg border text-xs">
            <button
              onClick={() => setStatusFilter("all")}
              className={cn(
                "px-2 py-0.5 rounded text-[11px] font-medium transition-colors cursor-pointer",
                statusFilter === "all"
                  ? "bg-background text-foreground shadow-xs font-semibold"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              All ({treeData.nodes.filter((n) => n.type === "file").length})
            </button>

            <button
              onClick={() => setStatusFilter("changed")}
              className={cn(
                "px-2 py-0.5 rounded text-[11px] font-medium transition-colors cursor-pointer",
                statusFilter === "changed"
                  ? "bg-background text-foreground shadow-xs font-semibold"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              Changes ({totalChanges})
            </button>

            {treeData.summary.modified > 0 && (
              <button
                onClick={() => setStatusFilter("modified")}
                className={cn(
                  "flex items-center gap-1 px-2 py-0.5 rounded text-[11px] transition-colors cursor-pointer",
                  statusFilter === "modified"
                    ? "bg-amber-500/20 text-amber-700 dark:text-amber-300 font-semibold"
                    : "text-amber-600 dark:text-amber-400 hover:bg-amber-500/10"
                )}
              >
                <IconEdit className="size-3" />
                <span>{treeData.summary.modified} modified</span>
              </button>
            )}

            {treeData.summary.added > 0 && (
              <button
                onClick={() => setStatusFilter("added")}
                className={cn(
                  "flex items-center gap-1 px-2 py-0.5 rounded text-[11px] transition-colors cursor-pointer",
                  statusFilter === "added"
                    ? "bg-emerald-500/20 text-emerald-700 dark:text-emerald-300 font-semibold"
                    : "text-emerald-600 dark:text-emerald-400 hover:bg-emerald-500/10"
                )}
              >
                <IconPlus className="size-3" />
                <span>{treeData.summary.added} added</span>
              </button>
            )}

            {treeData.summary.removed > 0 && (
              <button
                onClick={() => setStatusFilter("removed")}
                className={cn(
                  "flex items-center gap-1 px-2 py-0.5 rounded text-[11px] transition-colors cursor-pointer",
                  statusFilter === "removed"
                    ? "bg-rose-500/20 text-rose-700 dark:text-rose-300 font-semibold"
                    : "text-rose-600 dark:text-rose-400 hover:bg-rose-500/10"
                )}
              >
                <IconMinus className="size-3" />
                <span>{treeData.summary.removed} removed</span>
              </button>
            )}
          </div>
        )}

        {/* Right: Quick Settings & View Mode */}
        <div className="flex items-center gap-2 ml-auto">
          {treeData && (
            <Button
              variant={hideIdentical ? "secondary" : "ghost"}
              size="sm"
              className="h-8 text-xs px-2.5 gap-1.5 cursor-pointer"
              onClick={() => setHideIdentical((v) => !v)}
              title={hideIdentical ? "Show identical files" : "Hide identical files"}
            >
              {hideIdentical ? <IconEyeOff className="size-3.5" /> : <IconEye className="size-3.5" />}
              <span className="hidden sm:inline">{hideIdentical ? "Hidden Identical" : "Hide Identical"}</span>
            </Button>
          )}

          <Link
            href="/settings"
            className="p-1.5 rounded-md hover:bg-muted text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
            title="Configure Compare Paths & Credentials"
          >
            <IconSettings className="size-4" />
          </Link>
        </div>
      </header>

      {/* ── Main Split View ─────────────────────────────────────────────────── */}
      <div className="flex-1 min-h-0 flex overflow-hidden">
        {/* ── Left Panel: File Explorer & Search ──────────────────────────────── */}
        <aside
          className="shrink-0 flex flex-col overflow-hidden border-r bg-card/30 select-none"
          style={{ width: treeWidth }}
        >
          {/* Quick Filter Input in Explorer Header */}
          {!searchActive && treeData && (
            <div className="p-2 border-b bg-background/50 flex flex-col gap-1.5 shrink-0">
              <div className="relative flex items-center">
                <IconFilter className="absolute left-2 size-3.5 text-muted-foreground pointer-events-none" />
                <Input
                  value={quickFilter}
                  onChange={(e) => setQuickFilter(e.target.value)}
                  placeholder="Filter tree by filename…"
                  className="h-7 text-xs pl-7 pr-6 font-mono bg-muted/20"
                />
                {quickFilter && (
                  <button
                    onClick={() => setQuickFilter("")}
                    className="absolute right-1.5 p-0.5 rounded text-muted-foreground hover:text-foreground cursor-pointer"
                    title="Clear filter"
                  >
                    <IconX className="size-3" />
                  </button>
                )}
              </div>
            </div>
          )}

          <FileTreePanel
            scrollable={false}
            isSearchActive={searchActive}
            onSearchToggle={() => setSearchActive((v) => !v)}
            searchContent={
              <SearchPanel onSearch={handleSearch} onResultClick={handleSearchResultClick} />
            }
            openEditors={
              openDiffTabs.size > 0 ? (
                <OpenEditorsPanel
                  openPaths={Array.from(openDiffTabs.keys())}
                  activePath={activeTab}
                  onSelect={setActiveTab}
                  onClose={handleCloseTab}
                  onCloseAll={handleCloseAllTabs}
                  dragItems={(paths) =>
                    paths.map((p) => {
                      const isDir = p.endsWith("/");
                      const rel = p.replace(/\/$/, "");
                      const node = openDiffTabs.get(rel)?.node;
                      const root = node && !node.leftExists && node.rightExists ? treeData?.rightRoot : treeData?.leftRoot;
                      return { path: `${root ?? ""}/${rel}`, isDir };
                    })
                  }
                  getDecoration={(path) => {
                    const status = openDiffTabs.get(path)?.node.status;
                    return status && status !== "identical" ? STATUS_DECORATION[status] : null;
                  }}
                />
              ) : undefined
            }
          >
            <div className="flex h-full flex-col">
            {/* Tree States */}
            {treeError && (
              <div className="p-3 m-2 rounded-lg bg-destructive/10 border border-destructive/20 text-xs text-destructive flex flex-col gap-2">
                <div className="flex items-center gap-1.5 font-semibold">
                  <IconInfoCircle className="size-4" />
                  <span>Comparison Error</span>
                </div>
                <p className="leading-relaxed">{treeError}</p>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs mt-1 w-fit"
                  onClick={() => loadTree(selectedEnv)}
                >
                  <IconRefresh className="size-3 mr-1" /> Retry
                </Button>
              </div>
            )}

            {!treeData && !treeLoading && !treeError && (
              <div className="p-4 flex flex-col items-center justify-center text-center gap-3 text-muted-foreground my-auto">
                <div className="p-3 rounded-full bg-muted/60 border">
                  <IconGitCompare className="size-6 text-primary" />
                </div>
                <div className="text-xs max-w-[220px]">
                  <p className="font-medium text-foreground mb-1">Ready to compare</p>
                  <p className="text-[11px] leading-relaxed">
                    Select an environment above and click <strong>Compare</strong> to generate the diff tree.
                  </p>
                </div>
              </div>
            )}

            {treeLoading && (
              <div className="flex flex-col items-center justify-center gap-2 p-6 text-xs text-muted-foreground my-auto">
                <IconLoader2 className="size-6 animate-spin text-primary" />
                <p className="font-medium text-foreground">Analyzing file differences…</p>
                <p className="text-[11px] text-muted-foreground">Calculating SHA hashes</p>
              </div>
            )}

            {treeData && !treeLoading && visibleFiles.length === 0 && (
              <div className="p-4 text-center text-xs text-muted-foreground">
                <p className="font-medium text-foreground">No matching files</p>
                <p className="text-[11px] mt-1">Try clearing filters or changing the status filter.</p>
                {(quickFilter || statusFilter !== "all" || hideIdentical) && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 text-xs mt-2"
                    onClick={() => {
                      setQuickFilter("");
                      setStatusFilter("all");
                      setHideIdentical(false);
                    }}
                  >
                    Reset all filters
                  </Button>
                )}
              </div>
            )}

            {treeData && !treeLoading && visibleFiles.length > 0 && (
              <div className="flex-1 min-h-0">
                <CompareFileTree
                  files={visibleFiles}
                  activePath={activeTab}
                  initialExpanded={expandedDirs}
                  onExpandedChange={setExpandedDirs}
                  onFileOpen={handleTreeFileOpen}
                  onCopyPath={handleCopyPath}
                  leftRoot={treeData.leftRoot}
                  rightRoot={treeData.rightRoot}
                  header={
                <div className="flex flex-col px-3 py-2 border-y gap-1 bg-muted/20 text-[11px]">
                  <div className="flex items-center justify-between">
                    <span className="font-semibold text-foreground flex items-center gap-1">
                      <span className="size-2 rounded-full bg-blue-500 inline-block" />
                      Repo Root:
                    </span>
                    <button
                      onClick={() => handleCopyPath(treeData.leftRoot)}
                      className="text-muted-foreground hover:text-foreground p-0.5 rounded cursor-pointer"
                      title="Copy Repo path"
                    >
                      <IconCopy className="size-3" />
                    </button>
                  </div>
                  <div className="font-mono text-[10px] text-muted-foreground truncate" title={treeData.leftRoot}>
                    {treeData.leftRoot}
                  </div>

                  <div className="flex items-center justify-between mt-1 pt-1 border-t border-border/40">
                    <span className="font-semibold text-foreground flex items-center gap-1">
                      <span className="size-2 rounded-full bg-emerald-500 inline-block" />
                      TWX Root:
                    </span>
                    <button
                      onClick={() => handleCopyPath(treeData.rightRoot)}
                      className="text-muted-foreground hover:text-foreground p-0.5 rounded cursor-pointer"
                      title="Copy TWX path"
                    >
                      <IconCopy className="size-3" />
                    </button>
                  </div>
                  <div className="font-mono text-[10px] text-muted-foreground truncate" title={treeData.rightRoot}>
                    {treeData.rightRoot}
                  </div>
                </div>
                  }
                />
              </div>
            )}
            </div>
          </FileTreePanel>
        </aside>

        {/* ── Resizable Split Drag Handle ────────────────────────────────────── */}
        <div
          onMouseDown={handleDragStart}
          className="w-1.5 shrink-0 cursor-col-resize bg-border/40 hover:bg-primary/50 transition-colors relative group"
        >
          <div className="absolute inset-y-0 -left-1 -right-1" />
        </div>

        {/* ── Right Panel: Multi-tab Monaco Diff Workspace ──────────────────── */}
        <main className="flex-1 min-w-0 flex flex-col overflow-hidden bg-background">
          {openDiffTabs.size > 0 ? (
            <>
              {/* VS Code Style Tab Bar */}
              <div className="shrink-0 flex items-center border-b bg-muted/30 overflow-x-auto no-scrollbar select-none">
                <div className="flex items-stretch min-w-0 flex-1">
                  {Array.from(openDiffTabs.entries()).map(([path, tab]) => {
                    const fileName = path.split("/").pop() ?? "";
                    const isActive = path === activeTab;
                    return (
                      <div
                        key={path}
                        role="button"
                        tabIndex={0}
                        onClick={() => setActiveTab(path)}
                        onKeyDown={(e) => e.key === "Enter" && setActiveTab(path)}
                        onContextMenu={(e) => {
                          e.preventDefault();
                          handleCloseOtherTabs(path);
                        }}
                        className={cn(
                          "group/tab flex items-center gap-2 px-3 py-1.5 border-r text-xs whitespace-nowrap cursor-pointer transition-all border-t-2",
                          isActive
                            ? "border-t-primary bg-background text-foreground font-medium shadow-xs"
                            : "border-t-transparent bg-muted/10 text-muted-foreground hover:bg-muted/30 hover:text-foreground"
                        )}
                      >
                        <FileIcon name={fileName} className="size-3.5 shrink-0" />
                        <span className="font-mono text-xs truncate max-w-[180px]">{fileName}</span>
                        <StatusBadge status={tab.node.status} />
                        {tab.loading && <IconLoader2 className="size-3 animate-spin shrink-0 text-primary" />}

                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            handleCloseTab(path);
                          }}
                          title="Close (Esc)"
                          className="rounded p-0.5 text-muted-foreground hover:text-foreground hover:bg-accent transition-colors cursor-pointer"
                        >
                          <IconX className="size-3" />
                        </button>
                      </div>
                    );
                  })}
                </div>

                <div className="flex items-center gap-1 px-2 shrink-0 border-l bg-background/50">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 px-2 text-[11px] text-muted-foreground hover:text-foreground cursor-pointer"
                    onClick={handleCloseAllTabs}
                    title="Close all open editors"
                  >
                    Close All
                  </Button>
                </div>
              </div>

              {/* Active Tab Diff Breadcrumbs & Editor Controls */}
              {activeTab && activeTabData && (
                <>
                  <div className="shrink-0 px-3 py-1.5 border-b bg-card flex items-center justify-between gap-2 flex-wrap">
                    {/* Left: Path Breadcrumb & Status */}
                    <div className="flex items-center gap-2 min-w-0">
                      <FileIcon name={activeTab} className="size-4 shrink-0" />
                      <span className="text-xs font-mono font-medium text-foreground truncate" title={activeTab}>
                        {activeTab}
                      </span>

                      <StatusBadge status={activeTabData.node.status} size="md" />

                      {copiedPath === activeTab ? (
                        <span className="flex items-center gap-1 text-[10px] text-emerald-600 dark:text-emerald-400 font-medium">
                          <IconCheck className="size-3" /> Copied
                        </span>
                      ) : (
                        <button
                          onClick={() => handleCopyPath(activeTab)}
                          className="text-muted-foreground hover:text-foreground p-0.5 rounded transition-colors cursor-pointer"
                          title="Copy file path"
                        >
                          <IconCopy className="size-3.5" />
                        </button>
                      )}
                    </div>

                    {/* Right: Diff Navigation & View Options */}
                    <div className="flex items-center gap-2 shrink-0 ml-auto">
                      <Button
                        size="xs"
                        variant="ghost"
                        onClick={pinCompare}
                        disabled={!compareReady}
                        className="h-6 w-6 p-0 text-muted-foreground hover:text-foreground"
                        title="Add to chat"
                        aria-label="Add comparison to chat"
                      >
                        <IconMessagePlus className="size-3.5" />
                      </Button>

                      {/* Left vs Right Side Origin Indicator */}
                      <div className="hidden md:flex items-center gap-1.5 text-[11px] text-muted-foreground bg-muted/40 px-2 py-0.5 rounded border">
                        <span className={cn(baseIsRepo ? "font-semibold text-foreground" : "")}>
                          Left: {baseIsRepo ? "Repo" : "TWX"}
                        </span>
                        <span>←</span>
                        <span className={cn(!baseIsRepo ? "font-semibold text-foreground" : "")}>
                          Right: {baseIsRepo ? "TWX" : "Repo"}
                        </span>
                      </div>

                      {/* Diff Navigator (Next / Prev Change) */}
                      {activeTabData.node.status !== "identical" && (
                        <div className="flex items-center rounded border bg-background overflow-hidden">
                          <button
                            onClick={handlePrevDiff}
                            className="px-2 py-1 text-xs hover:bg-accent text-muted-foreground hover:text-foreground transition-colors border-r cursor-pointer"
                            title="Previous difference (Shift+F7)"
                          >
                            <IconArrowUp className="size-3.5" />
                          </button>

                          <button
                            onClick={handleNextDiff}
                            className="px-2 py-1 text-xs hover:bg-accent text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
                            title="Next difference (F7)"
                          >
                            <IconArrowDown className="size-3.5" />
                          </button>
                        </div>
                      )}

                      {/* Side-by-side vs Inline Toggle */}
                      {activeTabData.node.status !== "identical" && (
                        <div className="flex items-center rounded border bg-background overflow-hidden p-0.5 text-xs">
                          <button
                            onClick={() => setDiffView("side")}
                            className={cn(
                              "flex items-center gap-1 px-2 py-0.5 rounded transition-colors text-[11px] cursor-pointer",
                              diffView === "side"
                                ? "bg-primary text-primary-foreground font-medium"
                                : "text-muted-foreground hover:text-foreground hover:bg-muted"
                            )}
                            title="Side by side diff"
                          >
                            <IconColumns className="size-3" />
                            <span className="hidden lg:inline">Side-by-side</span>
                          </button>
                          <button
                            onClick={() => setDiffView("inline")}
                            className={cn(
                              "flex items-center gap-1 px-2 py-0.5 rounded transition-colors text-[11px] cursor-pointer",
                              diffView === "inline"
                                ? "bg-primary text-primary-foreground font-medium"
                                : "text-muted-foreground hover:text-foreground hover:bg-muted"
                            )}
                            title="Inline unified diff"
                          >
                            <IconLayoutList className="size-3" />
                            <span className="hidden lg:inline">Inline</span>
                          </button>
                        </div>
                      )}

                      {/* Editor Preferences: Whitespace & Wordwrap */}
                      <div className="flex items-center gap-1">
                        <Button
                          variant={ignoreTrimWhitespace ? "secondary" : "ghost"}
                          size="sm"
                          className="h-7 px-2 text-[11px] cursor-pointer"
                          onClick={() => setIgnoreTrimWhitespace((v) => !v)}
                          title="Toggle ignore leading/trailing whitespace changes"
                        >
                          <IconSpace className="size-3.5" />
                          <span className="hidden xl:inline ml-1">
                            {ignoreTrimWhitespace ? "Ignore WS" : "Exact WS"}
                          </span>
                        </Button>

                        <Button
                          variant={wordWrap ? "secondary" : "ghost"}
                          size="sm"
                          className="h-7 px-2 text-[11px] cursor-pointer"
                          onClick={() => setWordWrap((v) => !v)}
                          title="Toggle word wrap"
                        >
                          <IconTextWrap className="size-3.5" />
                          <span className="hidden xl:inline ml-1">
                            {wordWrap ? "Wrap" : "No Wrap"}
                          </span>
                        </Button>
                      </div>
                    </div>
                  </div>

                  {/* One-Sided File Warning Notice */}
                  {activeTabData.node.status === "added" && (
                    <div className="px-3 py-1.5 bg-emerald-500/10 border-b border-emerald-500/20 text-xs text-emerald-700 dark:text-emerald-300 flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <IconPlus className="size-4 shrink-0" />
                        <span>
                          This file only exists in <strong>TWX Entities</strong> (Added / New file).
                        </span>
                      </div>
                      <span className="font-mono text-[11px] opacity-80">
                        {formatBytes(activeTabData.rightSize)}
                      </span>
                    </div>
                  )}

                  {activeTabData.node.status === "removed" && (
                    <div className="px-3 py-1.5 bg-rose-500/10 border-b border-rose-500/20 text-xs text-rose-700 dark:text-rose-300 flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <IconMinus className="size-4 shrink-0" />
                        <span>
                          This file only exists in <strong>Repo</strong> (Deleted / Missing in TWX).
                        </span>
                      </div>
                      <span className="font-mono text-[11px] opacity-80">
                        {formatBytes(activeTabData.leftSize)}
                      </span>
                    </div>
                  )}

                  {/* Editor Error / Loading */}
                  {activeTabData.error && (
                    <div className="flex flex-col items-center justify-center flex-1 gap-2 text-xs text-destructive p-6">
                      <IconInfoCircle className="size-6" />
                      <p className="font-medium">{activeTabData.error}</p>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => handleFileClick(activeTab, activeTabData.node)}
                      >
                        Retry Loading
                      </Button>
                    </div>
                  )}

                  {activeTabData.loading && (
                    <div className="flex flex-col items-center justify-center flex-1 gap-2 text-xs text-muted-foreground">
                      <IconLoader2 className="size-6 animate-spin text-primary" />
                      <span>Loading file content…</span>
                    </div>
                  )}

                  {/* Monaco Editor Diff Render */}
                  {!activeTabData.error &&
                    !activeTabData.loading &&
                    activeTabData.leftContent !== null && (
                      <div className="flex-1 min-h-0 relative">
                        {activeTabData.node.status === "identical" ? (
                          <MonacoEditor
                            className="min-w-0"
                            key={activeTab}
                            height="100%"
                            language={language}
                            value={activeTabData.leftContent ?? ""}
                            theme={resolvedTheme === "dark" ? "vs-dark" : "vs"}
                            options={{
                              readOnly: true,
                              automaticLayout: true,
                              fontSize: 12.5,
                              lineHeight: 20,
                              fontFamily:
                                "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
                              minimap: { enabled: true },
                              scrollBeyondLastLine: false,
                              wordWrap: wordWrap ? "on" : "off",
                              renderWhitespace: "selection",
                              smoothScrolling: true,
                            }}
                            onMount={(editor) => {
                              singleEditorRef.current = editor;
                              const jump = pendingJumpRef.current;
                              if (jump) {
                                pendingJumpRef.current = null;
                                editor.revealLineInCenter(jump.line);
                                editor.setPosition({ lineNumber: jump.line, column: jump.col });
                                editor.focus();
                              }
                            }}
                          />
                        ) : (
                          <MonacoDiffEditor
                            key={`${activeTab}-${diffView}-${ignoreTrimWhitespace}-${wordWrap}`}
                            height="100%"
                            language={language}
                            original={
                              baseIsRepo
                                ? activeTabData.leftContent ?? ""
                                : activeTabData.rightContent ?? ""
                            }
                            modified={
                              baseIsRepo
                                ? activeTabData.rightContent ?? ""
                                : activeTabData.leftContent ?? ""
                            }
                            theme={resolvedTheme === "dark" ? "vs-dark" : "vs"}
                            options={{
                              readOnly: true,
                              originalEditable: false,
                              renderSideBySide: diffView === "side",
                              automaticLayout: true,
                              fontSize: 12.5,
                              lineHeight: 20,
                              fontFamily:
                                "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
                              minimap: { enabled: true },
                              scrollBeyondLastLine: false,
                              renderOverviewRuler: true,
                              ignoreTrimWhitespace,
                              diffWordWrap: wordWrap ? "on" : "off",
                              renderWhitespace: "selection",
                              smoothScrolling: true,
                            }}
                            onMount={(editor, monaco) => {
                              diffEditorRef.current = editor;

                              // Initialize Diff Navigator
                              try {
                                diffNavigatorRef.current = monaco.editor.createDiffNavigator(
                                  editor,
                                  {
                                    followsCaret: true,
                                    ignoreCharChanges: true,
                                  }
                                );
                              } catch {}

                              if (diffView === "inline") {
                                editor
                                  .getModifiedEditor()
                                  .updateOptions({ minimap: { enabled: true } });
                              }

                              const jump = pendingJumpRef.current;
                              if (jump) {
                                pendingJumpRef.current = null;
                                const target = editor.getModifiedEditor();
                                target.revealLineInCenter(jump.line);
                                target.setPosition({ lineNumber: jump.line, column: jump.col });
                                target.focus();
                              }
                            }}
                          />
                        )}
                      </div>
                    )}
                </>
              )}
            </>
          ) : (
            /* ── Overview Dashboard (No Tab Open) ────────────────────────────── */
            <div className="flex-1 flex flex-col items-center justify-center p-6 overflow-y-auto bg-muted/10">
              {treeData ? (
                <div className="max-w-xl w-full flex flex-col gap-6">
                  {/* Dashboard Header */}
                  <div className="text-center space-y-1">
                    <div className="inline-flex p-3 rounded-2xl bg-primary/10 text-primary mb-1">
                      <IconGitCompare className="size-8" />
                    </div>
                    <h2 className="text-lg font-semibold tracking-tight">
                      Comparison Summary for <span className="text-primary">{selectedEnv}</span>
                    </h2>
                    <p className="text-xs text-muted-foreground">
                      Comparing local Git repository against downloaded ThingWorx entities.
                    </p>
                  </div>

                  {/* Summary Metric Cards */}
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                    <button
                      onClick={() => setStatusFilter("modified")}
                      className="p-3 rounded-xl border bg-card hover:bg-accent/40 transition-all text-left flex flex-col gap-1 cursor-pointer group"
                    >
                      <span className="text-[11px] text-muted-foreground flex items-center justify-between">
                        Modified
                        <IconEdit className="size-3.5 text-amber-500" />
                      </span>
                      <span className="text-2xl font-bold text-amber-600 dark:text-amber-400">
                        {treeData.summary.modified}
                      </span>
                      <span className="text-[10px] text-muted-foreground group-hover:text-foreground">
                        Files with diffs →
                      </span>
                    </button>

                    <button
                      onClick={() => setStatusFilter("added")}
                      className="p-3 rounded-xl border bg-card hover:bg-accent/40 transition-all text-left flex flex-col gap-1 cursor-pointer group"
                    >
                      <span className="text-[11px] text-muted-foreground flex items-center justify-between">
                        Added
                        <IconPlus className="size-3.5 text-emerald-500" />
                      </span>
                      <span className="text-2xl font-bold text-emerald-600 dark:text-emerald-400">
                        {treeData.summary.added}
                      </span>
                      <span className="text-[10px] text-muted-foreground group-hover:text-foreground">
                        Only in TWX →
                      </span>
                    </button>

                    <button
                      onClick={() => setStatusFilter("removed")}
                      className="p-3 rounded-xl border bg-card hover:bg-accent/40 transition-all text-left flex flex-col gap-1 cursor-pointer group"
                    >
                      <span className="text-[11px] text-muted-foreground flex items-center justify-between">
                        Deleted
                        <IconMinus className="size-3.5 text-rose-500" />
                      </span>
                      <span className="text-2xl font-bold text-rose-600 dark:text-rose-400">
                        {treeData.summary.removed}
                      </span>
                      <span className="text-[10px] text-muted-foreground group-hover:text-foreground">
                        Only in Repo →
                      </span>
                    </button>

                    <button
                      onClick={() => setStatusFilter("identical")}
                      className="p-3 rounded-xl border bg-card hover:bg-accent/40 transition-all text-left flex flex-col gap-1 cursor-pointer group"
                    >
                      <span className="text-[11px] text-muted-foreground flex items-center justify-between">
                        Identical
                        <IconEqual className="size-3.5 text-blue-500" />
                      </span>
                      <span className="text-2xl font-bold text-muted-foreground">
                        {treeData.summary.identical}
                      </span>
                      <span className="text-[10px] text-muted-foreground group-hover:text-foreground">
                        Matching files →
                      </span>
                    </button>
                  </div>

                  {/* Changed Files Quick-List */}
                  {totalChanges > 0 ? (
                    <div className="rounded-xl border bg-card p-4 space-y-3">
                      <div className="flex items-center justify-between border-b pb-2">
                        <span className="text-xs font-semibold">Quick Open Changed Files</span>
                        <span className="text-[11px] text-muted-foreground font-mono">
                          {totalChanges} changed file{totalChanges !== 1 ? "s" : ""}
                        </span>
                      </div>
                      <div className="max-h-48 overflow-y-auto space-y-1 pr-1">
                        {treeData.nodes
                          .filter((n) => n.type === "file" && n.status !== "identical")
                          .slice(0, 15)
                          .map((node) => (
                            <button
                              key={node.path}
                              onClick={() => handleFileClick(node.path, node)}
                              className="w-full flex items-center justify-between gap-2 p-1.5 rounded-lg hover:bg-muted/60 text-left transition-colors text-xs font-mono cursor-pointer"
                            >
                              <div className="flex items-center gap-2 truncate">
                                <FileIcon name={node.name} className="size-3.5 shrink-0" />
                                <span className="truncate">{node.path}</span>
                              </div>
                              <StatusBadge status={node.status} />
                            </button>
                          ))}
                      </div>
                    </div>
                  ) : (
                    <div className="rounded-xl border bg-card/60 p-4 text-center text-xs text-muted-foreground">
                      <IconCheck className="size-5 text-emerald-500 mx-auto mb-1" />
                      <p className="font-semibold text-foreground">All files are identical</p>
                      <p className="text-[11px] mt-0.5">Repo and TWX entities are in sync for this environment.</p>
                    </div>
                  )}

                  {/* Keyboard Shortcuts Reference */}
                  <div className="rounded-xl border bg-card/40 p-3 text-[11px] text-muted-foreground flex items-center justify-around flex-wrap gap-2">
                    <div className="flex items-center gap-1.5">
                      <kbd className="px-1.5 py-0.5 rounded bg-muted border font-mono text-[10px]">F7</kbd>
                      <span>Next Diff</span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <kbd className="px-1.5 py-0.5 rounded bg-muted border font-mono text-[10px]">Shift+F7</kbd>
                      <span>Prev Diff</span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <kbd className="px-1.5 py-0.5 rounded bg-muted border font-mono text-[10px]">Esc</kbd>
                      <span>Close Tab</span>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="flex flex-col items-center justify-center text-center gap-3 max-w-sm">
                  <div className="p-4 rounded-2xl bg-muted border">
                    <IconFileDiff className="size-8 text-muted-foreground" />
                  </div>
                  <h3 className="font-semibold text-sm">No Active Comparison</h3>
                  <p className="text-xs text-muted-foreground leading-relaxed">
                    Select your target environment and start comparison from the top bar to inspect differences.
                  </p>
                </div>
              )}
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
