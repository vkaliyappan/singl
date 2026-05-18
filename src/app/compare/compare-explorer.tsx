"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import dynamic from "next/dynamic";
import { useTheme } from "@/components/providers";
import {
  IconRefresh,
  IconLoader2,
  IconSettings,
  IconEye,
  IconEyeOff,
  IconArrowsExchange,
  IconX,
} from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { FileIcon, FileTreeNode, FileTreePanel, OpenEditorsPanel } from "@/components/file-tree";
import { SearchPanel, type SearchOptions, type SearchFileResult } from "@/components/search-panel";
import type { DiffNode, NodeStatus } from "@/lib/compare/diff-tree";
import type { OnMount, DiffOnMount } from "@monaco-editor/react";

const loading = () => (
  <div className="flex items-center justify-center h-full text-muted-foreground text-xs">
    Loading editor…
  </div>
);

const MonacoDiffEditor = dynamic(
  () => import("@monaco-editor/react").then((m) => ({ default: m.DiffEditor })),
  { ssr: false, loading }
);

const MonacoEditor = dynamic(
  () => import("@monaco-editor/react"),
  { ssr: false, loading }
);

interface TreeData {
  nodes: DiffNode[];
  summary: { added: number; removed: number; modified: number; identical: number };
  leftRoot: string;
  rightRoot: string;
}

interface DiffTabState {
  node: DiffNode;
  leftContent: string | null;
  rightContent: string | null;
  loading: boolean;
  error: string | null;
}

interface CompareExplorerProps {
  envs: string[];
}

function StatusBadge({ status }: { status: NodeStatus }) {
  if (status === "identical") return null;
  const map: Record<NodeStatus, { label: string; className: string }> = {
    added:    { label: "A", className: "text-green-600 dark:text-green-400 font-bold" },
    removed:  { label: "D", className: "text-red-500 dark:text-red-400 font-bold" },
    modified: { label: "M", className: "text-amber-500 dark:text-amber-400 font-bold" },
    identical: { label: "", className: "" },
  };
  const { label, className } = map[status];
  return <span className={cn("text-[10px] shrink-0 w-3 text-center", className)}>{label}</span>;
}

function TreeNode({
  node,
  depth,
  nodeMap,
  expandedDirs,
  selectedPath,
  hideIdentical,
  onFileClick,
  onDirToggle,
}: {
  node: DiffNode;
  depth: number;
  nodeMap: Map<string, DiffNode>;
  expandedDirs: Set<string>;
  selectedPath: string | null;
  hideIdentical: boolean;
  onFileClick: (path: string, node: DiffNode) => void;
  onDirToggle: (path: string) => void;
}) {
  if (hideIdentical && node.status === "identical") return null;

  const children = (node.children ?? [])
    .map((p) => nodeMap.get(p))
    .filter((n): n is DiffNode => !!n)
    .filter((n) => !hideIdentical || n.status !== "identical");

  return (
    <FileTreeNode
      name={node.name}
      type={node.type}
      path={node.path}
      depth={depth}
      isExpanded={expandedDirs.has(node.path)}
      isSelected={selectedPath === node.path}
      badge={<StatusBadge status={node.status} />}
      onFileClick={(path) => onFileClick(path, node)}
      onDirToggle={onDirToggle}
    >
      {children.map((child) => (
        <TreeNode
          key={child.path}
          node={child}
          depth={depth + 1}
          nodeMap={nodeMap}
          expandedDirs={expandedDirs}
          selectedPath={selectedPath}
          hideIdentical={hideIdentical}
          onFileClick={onFileClick}
          onDirToggle={onDirToggle}
        />
      ))}
    </FileTreeNode>
  );
}

const STORAGE_KEY = "singl:compare";

type SavedState = {
  selectedEnv?: string;
  baseIsRepo?: boolean;
  hideIdentical?: boolean;
  diffView?: "side" | "inline";
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

  // ── Search panel state ────────────────────────────────────────────────────
  const [searchActive, setSearchActive] = useState(false);

  // ── Resize panel ────────────────────────────────────────────────────────────
  const [treeWidth, setTreeWidth] = useState(280);
  const treeWidthRef = useRef(treeWidth);
  useEffect(() => { treeWidthRef.current = treeWidth; });

  const handleDragStart = useCallback((e: React.MouseEvent) => {
    const startX = e.clientX;
    const startWidth = treeWidthRef.current;
    const onMove = (ev: MouseEvent) => {
      setTreeWidth(Math.max(160, Math.min(600, startWidth + ev.clientX - startX)));
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

  // ── Compare state ────────────────────────────────────────────────────────────
  const [selectedEnv, setSelectedEnv] = useState<string>(envs[0] ?? "");
  const [baseIsRepo, setBaseIsRepo] = useState(true);
  const [treeData, setTreeData] = useState<TreeData | null>(null);
  const [treeLoading, setTreeLoading] = useState(false);
  const [treeError, setTreeError] = useState<string | null>(null);

  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set());
  const [hideIdentical, setHideIdentical] = useState(false);
  const [diffView, setDiffView] = useState<"side" | "inline">("side");

  // ── Multi-tab diff state ──────────────────────────────────────────────────
  const [openDiffTabs, setOpenDiffTabs] = useState<Map<string, DiffTabState>>(new Map());
  const [activeTab, setActiveTab] = useState<string | null>(null);
  const openDiffTabsRef = useRef(openDiffTabs);
  openDiffTabsRef.current = openDiffTabs;
  const activeTabRef = useRef(activeTab);
  activeTabRef.current = activeTab;

  const [nodeMap, setNodeMap] = useState<Map<string, DiffNode>>(new Map());

  // ── Editor refs for search jump ───────────────────────────────────────────────
  const pendingJumpRef = useRef<{ line: number; col: number } | null>(null);
  const editorRef = useRef<Parameters<OnMount>[0] | null>(null);
  const diffEditorRef = useRef<Parameters<DiffOnMount>[0] | null>(null);

  // ── Persistence ──────────────────────────────────────────────────────────────
  const hasMountedRef = useRef(false);
  const pendingRestorePathRef = useRef<string | null>(null);

  // Restore persisted state after mount (must be default values above to match SSR)
  useEffect(() => {
    const saved = readSavedState();
    if (saved.treeWidth !== undefined) setTreeWidth(saved.treeWidth);
    if (saved.selectedEnv) setSelectedEnv(saved.selectedEnv);
    if (saved.baseIsRepo !== undefined) setBaseIsRepo(saved.baseIsRepo);
    if (saved.hideIdentical !== undefined) setHideIdentical(saved.hideIdentical);
    if (saved.diffView) setDiffView(saved.diffView);
    if (saved.expandedDirs) setExpandedDirs(new Set(saved.expandedDirs));
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
  }, []);

  const selectedEnvRef = useRef(selectedEnv);
  useEffect(() => { selectedEnvRef.current = selectedEnv; });

  const handleFileClick = useCallback(async (path: string, node: DiffNode) => {
    if (openDiffTabsRef.current.has(path)) {
      setActiveTab(path);
      return;
    }
    setOpenDiffTabs((prev) => new Map(prev).set(path, {
      node,
      leftContent: null,
      rightContent: null,
      loading: true,
      error: null,
    }));
    setActiveTab(path);

    try {
      const res = await fetch(
        `/api/compare/content?env=${encodeURIComponent(selectedEnvRef.current)}&path=${encodeURIComponent(path)}`
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to load content");
      setOpenDiffTabs((prev) => {
        const next = new Map(prev);
        next.set(path, {
          node,
          leftContent: data.leftContent ?? "",
          rightContent: data.rightContent ?? "",
          loading: false,
          error: (data.leftTooLarge || data.rightTooLarge) ? "File too large to display (> 1 MB)" : null,
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
          error: e instanceof Error ? e.message : String(e),
        });
        return next;
      });
    }
  }, []);

  // Re-fetch file content after restore once nodeMap is populated
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
          hideIdentical,
          diffView,
          treeWidth,
          expandedDirs: Array.from(expandedDirs),
          selectedPath: activeTab,
          treeData,
        })
      );
    } catch {}
  }, [selectedEnv, baseIsRepo, hideIdentical, diffView, treeWidth, expandedDirs, activeTab, treeData]);

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

  // Escape key closes the active tab
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && activeTabRef.current) handleCloseTab(activeTabRef.current);
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
    setExpandedDirs(new Set());

    try {
      const res = await fetch(`/api/compare/tree?env=${encodeURIComponent(env)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to load tree");
      setTreeData(data);
      const map = new Map<string, DiffNode>();
      for (const node of data.nodes) map.set(node.path, node);
      setNodeMap(map);
    } catch (e) {
      setTreeError(e instanceof Error ? e.message : String(e));
    } finally {
      setTreeLoading(false);
    }
  }, []);

  const handleDirToggle = useCallback((path: string) => {
    setExpandedDirs((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const handleCollapseAll = useCallback(() => {
    setExpandedDirs(new Set());
  }, []);

  const handleExpandAll = useCallback(() => {
    const allDirs = new Set<string>();
    for (const [path, node] of nodeMap) {
      if (node.type === "dir") allDirs.add(path);
    }
    setExpandedDirs(allDirs);
  }, [nodeMap]);

  // ── Search handlers ───────────────────────────────────────────────────────
  const handleSearch = useCallback(async (query: string, opts: SearchOptions): Promise<SearchFileResult[]> => {
    if (!selectedEnv) return [];
    const params = new URLSearchParams({
      env: selectedEnv,
      q: query,
      side: "both",
      case: opts.caseSensitive ? "1" : "0",
      word: opts.wholeWord ? "1" : "0",
      regex: opts.useRegex ? "1" : "0",
      filename: opts.matchFilename ? "1" : "0",
    });
    const res = await fetch(`/api/compare/search?${params}`);
    const data = await res.json() as { results?: SearchFileResult[]; error?: string; warnings?: string[] };
    if (!res.ok) throw new Error(data.error ?? "Search failed");
    const results = data.results ?? [];
    if (results.length === 0 && data.warnings?.length) throw new Error(data.warnings.join("\n"));
    return results;
  }, [selectedEnv]);

  const handleSearchResultClick = useCallback((filePath: string, lineNumber: number, col: number) => {
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
  }, [nodeMap, handleFileClick]);

  const rootNodes = treeData
    ? treeData.nodes
        .filter((n) => !n.path.includes("/"))
        .filter((n) => !hideIdentical || n.status !== "identical")
    : [];

  const activeTabData = activeTab ? openDiffTabs.get(activeTab) : null;

  const language = activeTab
    ? (() => {
        const ext = activeTab.split(".").pop()?.toLowerCase() ?? "";
        const map: Record<string, string> = {
          ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript",
          json: "json", py: "python", xml: "xml", html: "html", css: "css",
          md: "markdown", yaml: "yaml", yml: "yaml", sql: "sql", sh: "shell",
        };
        return map[ext] ?? "plaintext";
      })()
    : "plaintext";

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Toolbar */}
      <div className="flex items-center gap-2 px-3 py-2 border-b shrink-0 flex-wrap">
        <Select
          value={selectedEnv}
          onValueChange={(v) => { if (v) setSelectedEnv(v); }}
          disabled={treeLoading}
        >
          <SelectTrigger className="h-7 text-xs w-40">
            <SelectValue placeholder="Select env…" />
          </SelectTrigger>
          <SelectContent>
            {envs.length === 0 && (
              <SelectItem value="__none__" disabled>No environments</SelectItem>
            )}
            {envs.map((e) => (
              <SelectItem key={e} value={e}>{e}</SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Button
          size="sm"
          className="h-7 text-xs"
          onClick={() => loadTree(selectedEnv)}
          disabled={!selectedEnv || treeLoading}
        >
          {treeLoading ? (
            <IconLoader2 className="size-3.5 animate-spin mr-1" />
          ) : (
            <IconRefresh className="size-3.5 mr-1" />
          )}
          Compare
        </Button>

        {/* Base selector */}
        <div className="flex items-center gap-1 ml-1 rounded-md border overflow-hidden text-xs">
          <button
            onClick={() => setBaseIsRepo(true)}
            className={cn(
              "px-2 py-1 transition-colors",
              baseIsRepo
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:text-foreground hover:bg-accent/40"
            )}
            title="Use Repo as base (original)"
          >
            Repo
          </button>
          <button
            onClick={() => setBaseIsRepo(false)}
            className={cn(
              "px-2 py-1 transition-colors",
              !baseIsRepo
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:text-foreground hover:bg-accent/40"
            )}
            title="Use TWX Entities as base (original)"
          >
            TWX
          </button>
        </div>

        {treeData && (
          <button
            onClick={() => setHideIdentical((v) => !v)}
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            {hideIdentical ? <IconEye className="size-3.5" /> : <IconEyeOff className="size-3.5" />}
            {hideIdentical ? "Show all" : "Hide identical"}
          </button>
        )}

        {treeData && (
          <div className="ml-auto flex items-center gap-2 text-[11px] text-muted-foreground">
            {treeData.summary.added > 0 && (
              <span className="text-green-600 dark:text-green-400">+{treeData.summary.added} added</span>
            )}
            {treeData.summary.removed > 0 && (
              <span className="text-red-500 dark:text-red-400">-{treeData.summary.removed} removed</span>
            )}
            {treeData.summary.modified > 0 && (
              <span className="text-amber-500 dark:text-amber-400">~{treeData.summary.modified} modified</span>
            )}
            {treeData.summary.identical > 0 && (
              <span>{treeData.summary.identical} identical</span>
            )}
          </div>
        )}

        <a
          href="/settings"
          className={cn(
            "flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors",
            !treeData && "ml-auto"
          )}
          title="Configure compare paths"
        >
          <IconSettings className="size-3.5" />
        </a>
      </div>

      {/* Main split layout */}
      <div className="flex-1 min-h-0 flex overflow-hidden">
        {/* Tree panel */}
        <div
          className="shrink-0 flex flex-col overflow-hidden border-r"
          style={{ width: treeWidth }}
        >
          <FileTreePanel
            onCollapseAll={treeData ? handleCollapseAll : undefined}
            onExpandAll={treeData ? handleExpandAll : undefined}
            isSearchActive={searchActive}
            onSearchToggle={() => setSearchActive((v) => !v)}
            searchContent={
              <SearchPanel
                onSearch={handleSearch}
                onResultClick={handleSearchResultClick}
              />
            }
            openEditors={
              openDiffTabs.size > 0 ? (
                <OpenEditorsPanel
                  openPaths={Array.from(openDiffTabs.keys())}
                  activePath={activeTab}
                  onSelect={setActiveTab}
                  onClose={handleCloseTab}
                  onCloseAll={handleCloseAllTabs}
                  getBadge={(path) => {
                    const tab = openDiffTabs.get(path);
                    return tab ? <StatusBadge status={tab.node.status} /> : null;
                  }}
                />
              ) : undefined
            }
            header={treeData && (
              <div className="flex flex-col px-2 py-1.5 border-b gap-1 shrink-0">
                <div
                  className="text-[10px] truncate cursor-help"
                  title={`Full path: ${treeData.leftRoot}`}
                >
                  <span className="font-semibold text-foreground">Repo</span>{" "}
                  <span className="text-muted-foreground font-mono">{treeData.leftRoot}</span>
                </div>
                <div
                  className="text-[10px] truncate cursor-help"
                  title={`Full path: ${treeData.rightRoot}`}
                >
                  <span className="font-semibold text-foreground">TWX</span>{" "}
                  <span className="text-muted-foreground font-mono">{treeData.rightRoot}</span>
                </div>
              </div>
            )}
          >
            {treeError && (
              <p className="text-xs text-destructive px-3 py-2">{treeError}</p>
            )}
            {!treeData && !treeLoading && !treeError && (
              <div className="px-3 py-4 text-xs text-muted-foreground leading-relaxed">
                Select an environment and click <strong>Compare</strong>.
              </div>
            )}
            {treeLoading && (
              <div className="flex items-center gap-2 px-3 py-4 text-xs text-muted-foreground">
                <IconLoader2 className="size-3.5 animate-spin" />
                Building diff tree…
              </div>
            )}
            {rootNodes.map((node) => (
              <TreeNode
                key={node.path}
                node={node}
                depth={0}
                nodeMap={nodeMap}
                expandedDirs={expandedDirs}
                selectedPath={activeTab}
                hideIdentical={hideIdentical}
                onFileClick={handleFileClick}
                onDirToggle={handleDirToggle}
              />
            ))}
          </FileTreePanel>
        </div>

        {/* Drag handle */}
        <div
          onMouseDown={handleDragStart}
          className="w-1 shrink-0 cursor-col-resize bg-border/40 hover:bg-border transition-colors"
        />

        {/* Diff editor panel */}
        <div className="flex-1 min-w-0 flex flex-col overflow-hidden">
          {openDiffTabs.size > 0 ? (
            <>
              {/* Tab bar */}
              <div className="shrink-0 flex flex-wrap items-stretch border-b bg-muted/20">
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
                      className={cn(
                        "flex items-center gap-1.5 px-3 py-1 border-r text-xs whitespace-nowrap cursor-pointer select-none",
                        isActive
                          ? "border-t-2 border-t-primary bg-background text-foreground"
                          : "border-t-2 border-t-transparent bg-muted/10 text-muted-foreground hover:bg-muted/20 hover:text-foreground"
                      )}
                    >
                      <FileIcon name={fileName} className="size-3.5 shrink-0" />
                      <span className="font-mono">{fileName}</span>
                      <StatusBadge status={tab.node.status} />
                      {tab.loading && <IconLoader2 className="size-3 animate-spin shrink-0 ml-0.5" />}
                      <button
                        onClick={(e) => { e.stopPropagation(); handleCloseTab(path); }}
                        title="Close"
                        className="ml-1 rounded p-0.5 text-muted-foreground hover:text-foreground hover:bg-accent/60 transition-colors"
                      >
                        <IconX className="size-3" />
                      </button>
                    </div>
                  );
                })}
                <button
                  onClick={handleCloseAllTabs}
                  title="Close All Editors"
                  className="ml-auto shrink-0 px-3 flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground border-l bg-muted/20 transition-colors whitespace-nowrap"
                >
                  <IconX className="size-3" />
                  Close All
                </button>
              </div>

              {/* Active tab content */}
              {activeTab && activeTabData && (
                <>
                  {/* Breadcrumb */}
                  <div className="shrink-0 px-3 py-0.5 border-b bg-muted/10 flex items-center justify-between">
                    <span className="text-[11px] text-muted-foreground font-mono truncate">{activeTab}</span>
                    <div className="flex items-center gap-3 shrink-0 ml-2">
                      <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                        <span className={baseIsRepo ? "text-foreground font-medium" : ""}>Repo</span>
                        <IconArrowsExchange className="size-3" />
                        <span className={!baseIsRepo ? "text-foreground font-medium" : ""}>TWX</span>
                        <span className="ml-1 opacity-60">(base ← left)</span>
                      </div>
                      {activeTabData.node.status !== "identical" && (
                        <div className="flex items-center rounded border overflow-hidden text-[10px]">
                          <button
                            onClick={() => setDiffView("side")}
                            className={cn(
                              "px-2 py-0.5 transition-colors",
                              diffView === "side"
                                ? "bg-primary text-primary-foreground"
                                : "text-muted-foreground hover:text-foreground hover:bg-accent/40"
                            )}
                            title="Side by side diff"
                          >
                            Side by side
                          </button>
                          <button
                            onClick={() => setDiffView("inline")}
                            className={cn(
                              "px-2 py-0.5 transition-colors",
                              diffView === "inline"
                                ? "bg-primary text-primary-foreground"
                                : "text-muted-foreground hover:text-foreground hover:bg-accent/40"
                            )}
                            title="Inline diff"
                          >
                            Inline
                          </button>
                        </div>
                      )}
                    </div>
                  </div>

                  {activeTabData.error && (
                    <div className="flex items-center justify-center flex-1 text-xs text-destructive px-4">
                      {activeTabData.error}
                    </div>
                  )}

                  {activeTabData.loading && (
                    <div className="flex items-center justify-center flex-1 gap-2 text-xs text-muted-foreground">
                      <IconLoader2 className="size-4 animate-spin" />
                      Loading diff…
                    </div>
                  )}

                  {!activeTabData.error && !activeTabData.loading && activeTabData.leftContent !== null && (
                    <div className="flex-1 min-h-0">
                      {activeTabData.node.status === "identical" ? (
                        <MonacoEditor
                          key={activeTab}
                          height="100%"
                          language={language}
                          value={activeTabData.leftContent ?? ""}
                          theme={resolvedTheme === "dark" ? "vs-dark" : "vs"}
                          options={{
                            readOnly: true,
                            automaticLayout: true,
                            fontSize: 12,
                            minimap: { enabled: true },
                            scrollBeyondLastLine: false,
                          }}
                          onMount={(editor) => {
                            editorRef.current = editor;
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
                          key={`${activeTab}-${diffView}`}
                          height="100%"
                          language={language}
                          original={baseIsRepo ? activeTabData.leftContent : (activeTabData.rightContent ?? "")}
                          modified={baseIsRepo ? (activeTabData.rightContent ?? "") : activeTabData.leftContent}
                          theme={resolvedTheme === "dark" ? "vs-dark" : "vs"}
                          options={{
                            readOnly: true,
                            originalEditable: false,
                            renderSideBySide: diffView === "side",
                            automaticLayout: true,
                            fontSize: 12,
                            minimap: { enabled: false },
                            scrollBeyondLastLine: false,
                            renderOverviewRuler: false,
                          }}
                          onMount={(editor) => {
                            diffEditorRef.current = editor;
                            if (diffView === "inline") {
                              editor.getModifiedEditor().updateOptions({ minimap: { enabled: true } });
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
            <div className="flex items-center justify-center flex-1 text-xs text-muted-foreground">
              Select a file from the tree to view its diff.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
