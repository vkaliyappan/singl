"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import dynamic from "next/dynamic";
import { useTheme } from "next-themes";
import {
  IconChevronRight,
  IconFile,
  IconX,
  IconSettings,
  IconDownload,
  IconPackageImport,
  IconFold,
} from "@tabler/icons-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Spinner } from "@/components/ui/spinner";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { FileIcon, FileTreeNode, getLanguage } from "@/components/file-tree";
import {
  ExistingEnvCard,
  NewEnvCard,
  type EnvSetting,
  type ProjectConfig,
} from "@/app/settings/settings-form";

const MonacoEditor = dynamic(() => import("@monaco-editor/react"), {
  ssr: false,
  loading: () => (
    <div className="flex items-center justify-center h-full text-muted-foreground text-xs">
      Loading editor…
    </div>
  ),
});

interface FileEntry {
  name: string;
  type: "file" | "dir";
  path: string;
}

function TreeNode({
  entry,
  depth,
  selectedFile,
  expandedDirs,
  dirContents,
  loadingDirs,
  dirErrors,
  onFileClick,
  onDirToggle,
}: {
  entry: FileEntry;
  depth: number;
  selectedFile: string | null;
  expandedDirs: Set<string>;
  dirContents: Map<string, FileEntry[]>;
  loadingDirs: Set<string>;
  dirErrors: Map<string, string>;
  onFileClick: (path: string) => void;
  onDirToggle: (path: string) => void;
}) {
  const children = dirContents.get(entry.path) ?? [];
  return (
    <FileTreeNode
      name={entry.name}
      type={entry.type}
      path={entry.path}
      depth={depth}
      isExpanded={expandedDirs.has(entry.path)}
      isLoading={loadingDirs.has(entry.path)}
      isSelected={selectedFile === entry.path}
      loadError={dirErrors.get(entry.path)}
      onFileClick={onFileClick}
      onDirToggle={onDirToggle}
    >
      {children.map((child) => (
        <TreeNode
          key={child.path}
          entry={child}
          depth={depth + 1}
          selectedFile={selectedFile}
          expandedDirs={expandedDirs}
          dirContents={dirContents}
          loadingDirs={loadingDirs}
          dirErrors={dirErrors}
          onFileClick={onFileClick}
          onDirToggle={onDirToggle}
        />
      ))}
    </FileTreeNode>
  );
}

// ── SSE stream reader ──────────────────────────────────────────────────────

async function readStream(
  res: Response,
  onMessage: (msg: string) => void,
  onDone: (payload: string) => void | Promise<void>,
  onError: (msg: string) => void
): Promise<void> {
  if (!res.body) throw new Error("No response body");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split("\n\n");
    buffer = lines.pop() ?? "";

    for (const chunk of lines) {
      const line = chunk.replace(/^data: /, "").trim();
      if (!line) continue;
      if (line.startsWith("[DONE]")) {
        await onDone(line.slice(6).trim());
      } else if (line.startsWith("[ERROR]")) {
        onError(line.slice(7).trim());
      } else if (line.startsWith("[WARN]")) {
        onMessage(line);
      } else {
        onMessage(line);
      }
    }
  }
}

// ── Main component ─────────────────────────────────────────────────────────

interface TwxExplorerProps {
  initialEnvs: EnvSetting[];
}

export function TwxExplorer({ initialEnvs }: TwxExplorerProps) {
  const router = useRouter();
  const { resolvedTheme } = useTheme();

  // ── Env management ────────────────────────────────────────────────────────
  const [envs, setEnvs] = useState<EnvSetting[]>(initialEnvs);
  const [showEnvManager, setShowEnvManager] = useState(initialEnvs.length === 0);
  const [showNewEnvForm, setShowNewEnvForm] = useState(false);

  const handleEnvSuccess = useCallback(() => router.refresh(), [router]);
  const handleNewEnvCancel = useCallback(() => setShowNewEnvForm(false), []);
  const handleNewEnvSuccess = useCallback(() => {
    setShowNewEnvForm(false);
    router.refresh();
  }, [router]);

  useEffect(() => {
    setEnvs(initialEnvs);
    if (!initialEnvs.find((e) => e.environment === selectedEnv)) {
      setSelectedEnv(initialEnvs[0]?.environment ?? "");
      setSelectedProject("__all__");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialEnvs]);

  // ── Export toolbar ────────────────────────────────────────────────────────
  const [selectedEnv, setSelectedEnv] = useState(initialEnvs[0]?.environment ?? "");
  // "__all__" = all configured/TWX projects; "__custom__" = show text input; else = specific project name
  const [selectedProject, setSelectedProject] = useState("__all__");
  const [customProject, setCustomProject] = useState("");
  const [exportStatus, setExportStatus] = useState<"idle" | "exporting" | "done" | "error">("idle");
  const [exportMessages, setExportMessages] = useState<string[]>([]);
  const [lastExportDir, setLastExportDir] = useState<string | null>(null);

  const progressRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    progressRef.current?.scrollTo(0, progressRef.current.scrollHeight);
  }, [exportMessages]);

  // ── Extract toolbar ───────────────────────────────────────────────────────
  const [extractStatus, setExtractStatus] = useState<"idle" | "extracting" | "done" | "error">("idle");
  const [extractMessages, setExtractMessages] = useState<string[]>([]);
  const extractProgressRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    extractProgressRef.current?.scrollTo(0, extractProgressRef.current.scrollHeight);
  }, [extractMessages]);

  // ── File tree ─────────────────────────────────────────────────────────────
  const [rootEntries, setRootEntries] = useState<FileEntry[]>([]);
  const [treeLoading, setTreeLoading] = useState(false);
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set());
  const [dirContents, setDirContents] = useState<Map<string, FileEntry[]>>(new Map());
  const [loadingDirs, setLoadingDirs] = useState<Set<string>>(new Set());
  const [dirErrors, setDirErrors] = useState<Map<string, string>>(new Map());

  const expandedDirsRef = useRef(expandedDirs);
  expandedDirsRef.current = expandedDirs;
  const dirContentsRef = useRef(dirContents);
  dirContentsRef.current = dirContents;

  // ── File viewer ───────────────────────────────────────────────────────────
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState<string | null>(null);
  const [fileContentError, setFileContentError] = useState<string | null>(null);
  const [loadingContent, setLoadingContent] = useState(false);

  // ── Resize panel ──────────────────────────────────────────────────────────
  const [treeWidth, setTreeWidth] = useState(280);
  const treeWidthRef = useRef(280);
  treeWidthRef.current = treeWidth;

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

  // ── Helpers ───────────────────────────────────────────────────────────────
  const resetFileTree = useCallback(() => {
    setRootEntries([]);
    setExpandedDirs(new Set());
    setDirContents(new Map());
    setDirErrors(new Map());
    setSelectedFile(null);
    setFileContent(null);
    setFileContentError(null);
  }, []);

  const handleCollapseAll = useCallback(() => {
    setExpandedDirs(new Set());
  }, []);

  const handleCloseFile = useCallback(() => {
    setSelectedFile(null);
    setFileContent(null);
    setFileContentError(null);
  }, []);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && selectedFile) handleCloseFile();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selectedFile, handleCloseFile]);

  // ── Auto-load persisted exports on env change ─────────────────────────────
  const exportStatusRef = useRef(exportStatus);
  exportStatusRef.current = exportStatus;

  useEffect(() => {
    if (!selectedEnv || exportStatusRef.current === "exporting") return;
    const safeEnv = selectedEnv.replace(/[^a-zA-Z0-9_\-]/g, "_");
    let cancelled = false;

    (async () => {
      resetFileTree();
      setLastExportDir(null);
      try {
        const res = await fetch(
          `/api/twx-entities/files?path=${encodeURIComponent(safeEnv)}`
        );
        const data = (await res.json()) as { entries?: FileEntry[] };
        if (cancelled) return;
        const entries = data.entries ?? [];
        if (entries.length > 0) {
          setRootEntries(entries);
          setLastExportDir(safeEnv);
        }
      } catch {
        // silently ignore — no persisted exports to show
      }
    })();

    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedEnv]);

  const loadDir = useCallback(async (dirPath: string, isRoot = false) => {
    if (isRoot) {
      setTreeLoading(true);
    } else {
      setLoadingDirs((prev) => new Set(prev).add(dirPath));
      setDirErrors((prev) => {
        const next = new Map(prev);
        next.delete(dirPath);
        return next;
      });
    }
    try {
      const res = await fetch(
        `/api/twx-entities/files?path=${encodeURIComponent(dirPath)}`
      );
      const data = (await res.json()) as { entries?: FileEntry[]; error?: string };
      if (!res.ok) throw new Error(data.error ?? "Failed to load directory");
      const entries = data.entries ?? [];
      if (isRoot) {
        setRootEntries(entries);
      } else {
        setDirContents((prev) => new Map(prev).set(dirPath, entries));
      }
    } catch (err) {
      if (!isRoot) {
        const msg = err instanceof Error ? err.message : String(err);
        setDirErrors((prev) => new Map(prev).set(dirPath, msg));
      }
    } finally {
      if (isRoot) setTreeLoading(false);
      else
        setLoadingDirs((prev) => {
          const next = new Set(prev);
          next.delete(dirPath);
          return next;
        });
    }
  }, []);

  const handleDirToggle = useCallback(
    async (dirPath: string) => {
      const isExpanded = expandedDirsRef.current.has(dirPath);
      setExpandedDirs((prev) => {
        const next = new Set(prev);
        if (isExpanded) next.delete(dirPath);
        else next.add(dirPath);
        return next;
      });
      if (!isExpanded && !dirContentsRef.current.has(dirPath)) {
        await loadDir(dirPath, false);
      }
    },
    [loadDir]
  );

  const handleFileClick = useCallback(async (filePath: string) => {
    setSelectedFile(filePath);
    setFileContent(null);
    setFileContentError(null);
    setLoadingContent(true);
    try {
      const res = await fetch(
        `/api/twx-entities/content?path=${encodeURIComponent(filePath)}`
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setFileContent(data.content as string);
    } catch (err) {
      setFileContentError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingContent(false);
    }
  }, []);

  // ── Export handler ────────────────────────────────────────────────────────
  const handleExport = async () => {
    const envRecord = envs.find((e) => e.environment === selectedEnv);
    if (!envRecord?.hasAppKey) return;

    setExportStatus("exporting");
    setExportMessages([]);
    resetFileTree();
    setLastExportDir(null);

    try {
      const res = await fetch("/api/twx-entities/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ envName: selectedEnv, projectName: resolvedProjectName }),
      });

      await readStream(
        res,
        (msg) => setExportMessages((prev) => [...prev, msg]),
        async (payload) => {
          const parsed = JSON.parse(payload || "{}") as {
            outputDir?: string;
            exported?: number;
            skipped?: number;
          };
          const dir = parsed.outputDir ?? "";
          setLastExportDir(dir);
          setExportStatus("done");
          if (dir) await loadDir(dir, true);
        },
        (msg) => {
          setExportStatus("error");
          setExportMessages((prev) => [...prev, `Error: ${msg}`]);
        }
      );
    } catch (err) {
      setExportStatus("error");
      setExportMessages((prev) => [
        ...prev,
        err instanceof Error ? err.message : String(err),
      ]);
    }
  };

  // ── Extract handler ───────────────────────────────────────────────────────
  const handleExtract = async () => {
    setExtractStatus("extracting");
    setExtractMessages([]);

    try {
      const res = await fetch("/api/twx-cli/extract", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ envName: selectedEnv }),
      });

      await readStream(
        res,
        (msg) => setExtractMessages((prev) => [...prev, msg]),
        async () => {
          setExtractStatus("done");
          const safeEnv = selectedEnv.replace(/[^a-zA-Z0-9_\-]/g, "_");
          if (safeEnv) {
            setLastExportDir(safeEnv);
            await loadDir(safeEnv, true);
          }
        },
        (msg) => {
          setExtractStatus("error");
          setExtractMessages((prev) => [...prev, `Error: ${msg}`]);
        }
      );
    } catch (err) {
      setExtractStatus("error");
      setExtractMessages((prev) => [
        ...prev,
        err instanceof Error ? err.message : String(err),
      ]);
    }
  };

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
    exportStatus !== "exporting" &&
    (selectedProject !== "__custom__" || !!customProject.trim());

  const openFileName = selectedFile?.split("/").pop() ?? "";

  const treeLabel = lastExportDir
    ? lastExportDir.split("/").join(" / ")
    : "EXPLORER";

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col h-full overflow-hidden">

      {/* ── Toolbar ─────────────────────────────────────────────────────────── */}
      <div className="shrink-0 border-b bg-background px-4 py-2.5 flex flex-col gap-2">
        <div className="flex items-end gap-2 flex-wrap">

          {/* Environment selector */}
          <div className="flex flex-col gap-1">
            <Label className="text-xs text-muted-foreground">Environment</Label>
            {envs.length > 0 ? (
              <Select value={selectedEnv} onValueChange={(v) => v && setSelectedEnv(v)}>
                <SelectTrigger className="h-8 text-sm w-40">
                  <SelectValue placeholder="Select env" />
                </SelectTrigger>
                <SelectContent>
                  {envs.map((e) => (
                    <SelectItem key={e.environment} value={e.environment}>
                      {e.environment}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <div className="h-8 flex items-center px-3 rounded-md border text-xs text-muted-foreground w-40">
                No environments
              </div>
            )}
          </div>

          {/* Manage environments toggle */}
          <div className="flex flex-col gap-1">
            <Label className="text-xs text-muted-foreground invisible">&nbsp;</Label>
            <Button
              size="sm"
              variant={showEnvManager ? "secondary" : "outline"}
              onClick={() => {
                setShowEnvManager((v) => !v);
                if (showEnvManager) setShowNewEnvForm(false);
              }}
              className="h-8 gap-1.5 whitespace-nowrap"
            >
              <IconSettings className="size-3.5" />
              Manage Environments
            </Button>
          </div>

          <div className="h-6 w-px bg-border self-end mb-1 hidden sm:block" />

          {/* Project selector */}
          <div className="flex flex-col gap-1">
            <Label className="text-xs text-muted-foreground">Project</Label>
            <Select
              value={selectedProject}
              onValueChange={(v) => { if (v) setSelectedProject(v); }}
            >
              <SelectTrigger className="h-8 text-sm w-52">
                <SelectValue placeholder="Select project" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__all__">
                  {selectedEnvRecord?.projects.length
                    ? "All configured projects"
                    : "All TWX projects"}
                </SelectItem>
                {selectedEnvRecord?.projects.map((p: ProjectConfig) => (
                  <SelectItem key={p.id} value={p.projectName}>
                    {p.projectName}
                    {p.alias && p.alias !== p.projectName && (
                      <span className="text-muted-foreground ml-1 text-[11px]">→ {p.alias}</span>
                    )}
                  </SelectItem>
                ))}
                <SelectItem value="__custom__">Custom…</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Custom project input (only when Custom is selected) */}
          {selectedProject === "__custom__" && (
            <div className="flex flex-col gap-1 flex-1 min-w-32">
              <Label className="text-xs text-muted-foreground invisible">&nbsp;</Label>
              <Input
                value={customProject}
                onChange={(e) => setCustomProject(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && canExport) handleExport(); }}
                placeholder="TWX project name"
                className="h-8 text-sm"
                autoFocus
              />
            </div>
          )}

          {/* Export button */}
          <div className="flex flex-col gap-1">
            <Label className="text-xs text-muted-foreground invisible">&nbsp;</Label>
            <Button
              size="sm"
              onClick={handleExport}
              disabled={!canExport}
              className="h-8 gap-1.5 whitespace-nowrap"
            >
              {exportStatus === "exporting" ? (
                <Spinner className="size-3.5" />
              ) : (
                <IconDownload className="size-3.5" />
              )}
              {exportStatus === "exporting" ? "Exporting…" : "Export"}
            </Button>
          </div>

          {/* Extract button */}
          <div className="flex flex-col gap-1">
            <Label className="text-xs text-muted-foreground invisible">&nbsp;</Label>
            <Button
              size="sm"
              variant="outline"
              onClick={handleExtract}
              disabled={!selectedEnv || extractStatus === "extracting"}
              className="h-8 gap-1.5 whitespace-nowrap"
            >
              {extractStatus === "extracting" ? (
                <Spinner className="size-3.5" />
              ) : (
                <IconPackageImport className="size-3.5" />
              )}
              {extractStatus === "extracting" ? "Extracting…" : "Extract"}
            </Button>
          </div>
        </div>

        {/* Missing app key warning */}
        {selectedEnvRecord && !selectedEnvRecord.hasAppKey && (
          <p className="text-xs text-amber-600 dark:text-amber-400">
            No App Key configured for &quot;{selectedEnv}&quot;. Open Manage Environments to add one.
          </p>
        )}

        {/* Env manager section */}
        {showEnvManager && (
          <div className="flex flex-col gap-2 pt-1 border-t mt-1">
            {envs.map((s) => (
              <ExistingEnvCard
                key={`${s.environment}:${s.twxBaseUrl}:${s.hasAppKey}`}
                setting={s}
                onSuccess={handleEnvSuccess}
              />
            ))}

            {showNewEnvForm ? (
              <NewEnvCard
                onCancel={handleNewEnvCancel}
                onSuccess={handleNewEnvSuccess}
              />
            ) : (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setShowNewEnvForm(true)}
                className="self-start h-7 text-xs"
              >
                + Add Configuration
              </Button>
            )}
          </div>
        )}
      </div>

      {/* ── Export progress ──────────────────────────────────────────────────── */}
      {exportMessages.length > 0 && (
        <div className="shrink-0 border-b bg-muted/40 flex flex-col">
          {/* sticky header with clear button */}
          <div className="flex items-center justify-between px-4 py-1 border-b border-border/40">
            <span className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide select-none">
              Output
            </span>
            <button
              onClick={() => {
                setExportMessages([]);
                if (exportStatus !== "exporting") setExportStatus("idle");
              }}
              disabled={exportStatus === "exporting"}
              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground disabled:opacity-40 transition-colors"
            >
              <IconX className="size-3" />
              Clear
            </button>
          </div>
          {/* scrollable messages */}
          <div ref={progressRef} className="max-h-24 overflow-y-auto px-4 py-1.5">
            {exportMessages.map((msg, i) => (
              <p
                key={i}
                className={cn(
                  "text-xs font-mono",
                  msg.startsWith("[WARN]")
                    ? "text-amber-600 dark:text-amber-400"
                    : exportStatus === "error" && i === exportMessages.length - 1
                    ? "text-destructive"
                    : "text-muted-foreground"
                )}
              >
                {msg}
              </p>
            ))}
            {exportStatus === "done" && (
              <p className="text-xs text-emerald-600 dark:text-emerald-400 font-medium">
                Export complete.
              </p>
            )}
          </div>
        </div>
      )}

      {/* ── Extract progress ─────────────────────────────────────────────────── */}
      {extractMessages.length > 0 && (
        <div className="shrink-0 border-b bg-muted/40 flex flex-col">
          <div className="flex items-center justify-between px-4 py-1 border-b border-border/40">
            <span className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide select-none">
              Extract Output
            </span>
            <button
              onClick={() => {
                setExtractMessages([]);
                if (extractStatus !== "extracting") setExtractStatus("idle");
              }}
              disabled={extractStatus === "extracting"}
              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground disabled:opacity-40 transition-colors"
            >
              <IconX className="size-3" />
              Clear
            </button>
          </div>
          <div ref={extractProgressRef} className="max-h-24 overflow-y-auto px-4 py-1.5">
            {extractMessages.map((msg, i) => (
              <p
                key={i}
                className={cn(
                  "text-xs font-mono",
                  msg.startsWith("[WARN]")
                    ? "text-amber-600 dark:text-amber-400"
                    : extractStatus === "error" && i === extractMessages.length - 1
                    ? "text-destructive"
                    : extractStatus === "done" && i === extractMessages.length - 1
                    ? "text-emerald-600 dark:text-emerald-400 font-medium"
                    : "text-muted-foreground"
                )}
              >
                {msg}
              </p>
            ))}
            {extractStatus === "done" && (
              <p className="text-xs text-emerald-600 dark:text-emerald-400 font-medium">
                Extract complete.
              </p>
            )}
          </div>
        </div>
      )}

      {/* ── File explorer ────────────────────────────────────────────────────── */}
      {rootEntries.length > 0 ? (
        <div className="flex-1 min-h-0 flex overflow-hidden">
          {treeLoading ? (
            <div className="flex flex-1 items-center justify-center gap-2 text-muted-foreground">
              <Spinner className="size-5" />
              <span className="text-sm">Loading file tree…</span>
            </div>
          ) : (
            <>
              {/* Tree panel */}
              <div
                className="shrink-0 flex flex-col overflow-hidden border-r"
                style={{ width: treeWidth }}
              >
                <div className="shrink-0 px-3 py-1.5 border-b flex items-center justify-between">
                  <span className="text-[10px] font-semibold tracking-widest text-muted-foreground uppercase select-none">
                    Explorer
                  </span>
                  <button
                    onClick={handleCollapseAll}
                    title="Collapse All"
                    className="text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
                  >
                    <IconFold className="size-3.5" />
                  </button>
                </div>

                <div className="shrink-0 flex items-center gap-1 px-2 py-1 border-b select-none">
                  <IconChevronRight className="size-3.5 shrink-0 text-muted-foreground rotate-90" />
                  <span className="text-xs font-semibold text-foreground uppercase tracking-wider truncate" title={treeLabel}>
                    {treeLabel}
                  </span>
                </div>

                <ScrollArea className="flex-1 min-h-0">
                  <div className="py-0.5">
                    {rootEntries.map((entry) => (
                      <TreeNode
                        key={entry.path}
                        entry={entry}
                        depth={0}
                        selectedFile={selectedFile}
                        expandedDirs={expandedDirs}
                        dirContents={dirContents}
                        loadingDirs={loadingDirs}
                        dirErrors={dirErrors}
                        onFileClick={handleFileClick}
                        onDirToggle={handleDirToggle}
                      />
                    ))}
                  </div>
                </ScrollArea>
              </div>

              {/* Resize handle */}
              <div
                className="w-1 shrink-0 bg-border hover:bg-primary/40 cursor-col-resize transition-colors"
                onMouseDown={handleDragStart}
              />

              {/* Editor panel */}
              <div className="flex-1 min-w-0 flex flex-col overflow-hidden">
                {selectedFile ? (
                  <>
                    {/* Tab bar */}
                    <div className="shrink-0 flex items-stretch border-b bg-muted/20 overflow-x-auto">
                      <div className="flex items-center gap-1.5 px-3 py-1 border-r border-t-2 border-t-primary bg-background text-xs whitespace-nowrap">
                        <FileIcon name={openFileName} className="size-3.5 shrink-0" />
                        <span className="font-mono text-foreground">{openFileName}</span>
                        <button
                          onClick={handleCloseFile}
                          title="Close (Esc)"
                          className="ml-1 rounded p-0.5 text-muted-foreground hover:text-foreground hover:bg-accent/60 transition-colors"
                        >
                          <IconX className="size-3" />
                        </button>
                      </div>
                      <div className="flex-1 bg-muted/10" />
                    </div>

                    {/* Breadcrumb */}
                    <div className="shrink-0 px-3 py-0.5 border-b bg-muted/10">
                      <span className="text-[11px] text-muted-foreground font-mono truncate">
                        {selectedFile}
                      </span>
                    </div>

                    {/* Content */}
                    <div className="flex-1 min-h-0">
                      {loadingContent ? (
                        <div className="flex items-center justify-center h-full">
                          <Spinner className="size-5" />
                        </div>
                      ) : fileContentError ? (
                        <div className="p-4">
                          <p className="text-xs text-destructive">{fileContentError}</p>
                        </div>
                      ) : (
                        <MonacoEditor
                          height="100%"
                          language={getLanguage(selectedFile)}
                          value={fileContent ?? ""}
                          theme={resolvedTheme === "dark" ? "vs-dark" : "vs"}
                          options={{
                            readOnly: true,
                            minimap: { enabled: false },
                            scrollBeyondLastLine: false,
                            wordWrap: "on",
                            fontSize: 13,
                            lineNumbers: "on",
                            folding: true,
                            renderLineHighlight: "line",
                            automaticLayout: true,
                          }}
                        />
                      )}
                    </div>
                  </>
                ) : (
                  <div className="flex flex-col items-center justify-center h-full text-muted-foreground gap-2">
                    <IconFile className="size-8 opacity-20" />
                    <p className="text-xs">Select a file to view its content</p>
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      ) : (
        /* Empty state */
        <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground gap-3">
          <IconDownload className="size-10 opacity-20" />
          {envs.length === 0 ? (
            <p className="text-sm">No environments configured. Click &quot;Manage Environments&quot; to add one.</p>
          ) : exportStatus === "done" ? (
            <p className="text-sm">Export completed but no files were found. Check the project name.</p>
          ) : (
            <p className="text-sm">Select an environment and project name, then click Export.</p>
          )}
        </div>
      )}
    </div>
  );
}
