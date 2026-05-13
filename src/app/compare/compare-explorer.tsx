"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import dynamic from "next/dynamic";
import { useTheme } from "next-themes";
import {
  IconRefresh,
  IconLoader2,
  IconSettings,
  IconEye,
  IconEyeOff,
  IconArrowsExchange,
} from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { FileTreeNode } from "@/components/file-tree";
import type { DiffNode, NodeStatus } from "@/lib/compare/diff-tree";

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

export function CompareExplorer({ envs }: CompareExplorerProps) {
  const { resolvedTheme } = useTheme();

  // ── Resize panel ────────────────────────────────────────────────────────────
  const [treeWidth, setTreeWidth] = useState(280);
  const treeWidthRef = useRef(280);
  // Sync ref after render so handleDragStart always reads the latest width
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
  const [baseIsRepo, setBaseIsRepo] = useState(true); // true = Repo is original/left
  const [treeData, setTreeData] = useState<TreeData | null>(null);
  const [treeLoading, setTreeLoading] = useState(false);
  const [treeError, setTreeError] = useState<string | null>(null);

  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set());
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [hideIdentical, setHideIdentical] = useState(false);

  const [leftContent, setLeftContent] = useState<string | null>(null);
  const [rightContent, setRightContent] = useState<string | null>(null);
  const [contentLoading, setContentLoading] = useState(false);
  const [contentError, setContentError] = useState<string | null>(null);
  const [selectedNode, setSelectedNode] = useState<DiffNode | null>(null);

  const [nodeMap, setNodeMap] = useState<Map<string, DiffNode>>(new Map());

  const loadTree = useCallback(async (env: string) => {
    if (!env) return;
    setTreeLoading(true);
    setTreeError(null);
    setTreeData(null);
    setSelectedPath(null);
    setLeftContent(null);
    setRightContent(null);
    setSelectedNode(null);
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

  const handleFileClick = useCallback(async (path: string, node: DiffNode) => {
    setSelectedPath(path);
    setSelectedNode(node);
    setContentLoading(true);
    setContentError(null);
    setLeftContent(null);
    setRightContent(null);

    try {
      const res = await fetch(
        `/api/compare/content?env=${encodeURIComponent(selectedEnv)}&path=${encodeURIComponent(path)}`
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to load content");
      if (data.leftTooLarge || data.rightTooLarge) {
        setContentError("File too large to display (> 1 MB)");
      }
      setLeftContent(data.leftContent ?? "");
      setRightContent(data.rightContent ?? "");
    } catch (e) {
      setContentError(e instanceof Error ? e.message : String(e));
    } finally {
      setContentLoading(false);
    }
  }, [selectedEnv]);

  const handleDirToggle = useCallback((path: string) => {
    setExpandedDirs((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const rootNodes = treeData
    ? treeData.nodes
        .filter((n) => !n.path.includes("/"))
        .filter((n) => !hideIdentical || n.status !== "identical")
    : [];

  const language = selectedPath
    ? (() => {
        const ext = selectedPath.split(".").pop()?.toLowerCase() ?? "";
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
          {treeData && (
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

          <ScrollArea className="flex-1 min-h-0">
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
                selectedPath={selectedPath}
                hideIdentical={hideIdentical}
                onFileClick={handleFileClick}
                onDirToggle={handleDirToggle}
              />
            ))}
          </ScrollArea>
        </div>

        {/* Drag handle */}
        <div
          onMouseDown={handleDragStart}
          className="w-1 shrink-0 cursor-col-resize bg-border/40 hover:bg-border transition-colors"
        />

        {/* Diff editor panel */}
        <div className="flex-1 min-w-0 flex flex-col overflow-hidden">
          {selectedNode && (
            <div className="flex items-center gap-2 px-3 py-1.5 border-b text-xs shrink-0">
              <span className="font-mono text-muted-foreground truncate">{selectedPath}</span>
              <StatusBadge status={selectedNode.status} />
              <div className="ml-auto flex items-center gap-1.5 text-[10px] text-muted-foreground shrink-0">
                <span className={baseIsRepo ? "text-foreground font-medium" : ""}>Repo</span>
                <IconArrowsExchange className="size-3" />
                <span className={!baseIsRepo ? "text-foreground font-medium" : ""}>TWX</span>
                <span className="ml-1 opacity-60">(base ← left)</span>
              </div>
            </div>
          )}

          {contentError && (
            <div className="flex items-center justify-center flex-1 text-xs text-destructive px-4">
              {contentError}
            </div>
          )}

          {contentLoading && (
            <div className="flex items-center justify-center flex-1 gap-2 text-xs text-muted-foreground">
              <IconLoader2 className="size-4 animate-spin" />
              Loading diff…
            </div>
          )}

          {!selectedPath && !contentLoading && (
            <div className="flex items-center justify-center flex-1 text-xs text-muted-foreground">
              Select a file from the tree to view its diff.
            </div>
          )}

          {!contentError && !contentLoading && selectedPath && leftContent !== null && (
            <div className="flex-1 min-h-0">
              {selectedNode?.status === "identical" ? (
                // Plain editor for identical files — no double line numbers
                <MonacoEditor
                  height="100%"
                  language={language}
                  value={leftContent ?? ""}
                  theme={resolvedTheme === "dark" ? "vs-dark" : "vs"}
                  options={{
                    readOnly: true,
                    automaticLayout: true,
                    fontSize: 12,
                    minimap: { enabled: false },
                    scrollBeyondLastLine: false,
                  }}
                />
              ) : (
                <MonacoDiffEditor
                  height="100%"
                  language={language}
                  original={baseIsRepo ? leftContent : (rightContent ?? "")}
                  modified={baseIsRepo ? (rightContent ?? "") : leftContent}
                  theme={resolvedTheme === "dark" ? "vs-dark" : "vs"}
                  options={{
                    readOnly: true,
                    originalEditable: false,
                    renderSideBySide: true,
                    automaticLayout: true,
                    fontSize: 12,
                    minimap: { enabled: false },
                    scrollBeyondLastLine: false,
                    renderOverviewRuler: false,
                  }}
                />
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
