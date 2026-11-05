"use client";

import { useState, useEffect, useCallback, useReducer } from "react";
import dynamic from "next/dynamic";
import { useTheme } from "@/components/providers";
import {
  IconRefresh,
  IconGitCommit,
  IconSearch,
  IconLayoutColumns,
  IconLayoutRows,
  IconCopy,
  IconCheck,
  IconFileDiff,
  IconInfoCircle,
} from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { FileIcon, getLanguage } from "@/components/file-tree";
import { toast } from "sonner";
import { getRepoDiff, getRepoStatus, type ChangedFile } from "@/lib/repo";
import { errorMessage } from "@/lib/settings";

const MonacoDiffEditor = dynamic(
  () => import("@monaco-editor/react").then((m) => ({ default: m.DiffEditor })),
  {
    ssr: false,
    loading: () => (
      <div className="flex items-center justify-center h-full text-muted-foreground text-xs">
        Loading diff editor…
      </div>
    ),
  }
);

function StatusBadge({ status }: { status: ChangedFile["status"] }) {
  const map: Record<ChangedFile["status"], { label: string; title: string; className: string }> = {
    M: { label: "M", title: "Modified", className: "text-amber-500 dark:text-amber-400 bg-amber-500/10 border-amber-500/30" },
    A: { label: "A", title: "Added", className: "text-emerald-600 dark:text-emerald-400 bg-emerald-500/10 border-emerald-500/30" },
    D: { label: "D", title: "Deleted", className: "text-rose-500 dark:text-rose-400 bg-rose-500/10 border-rose-500/30" },
    "?": { label: "?", title: "Untracked", className: "text-muted-foreground bg-muted border-border" },
  };
  const { label, title, className } = map[status];
  return (
    <span
      title={title}
      className={cn(
        "text-[10px] shrink-0 size-4 flex items-center justify-center font-bold rounded border",
        className
      )}
    >
      {label}
    </span>
  );
}

type StatusState = { loading: boolean; files: ChangedFile[]; error: string | null };
type StatusAction =
  | { type: "loading" }
  | { type: "loaded"; files: ChangedFile[] }
  | { type: "error"; error: string };

function statusReducer(_state: StatusState, action: StatusAction): StatusState {
  switch (action.type) {
    case "loading": return { loading: true, files: [], error: null };
    case "loaded": return { loading: false, files: action.files, error: null };
    case "error": return { loading: false, files: [], error: action.error };
  }
}

export function ChangesPanel({ refreshTrigger }: { refreshTrigger?: number }) {
  const { resolvedTheme } = useTheme();
  const [status, dispatch] = useReducer(statusReducer, { loading: false, files: [], error: null });
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [diffContent, setDiffContent] = useState<{ original: string; modified: string; hasTextualChanges: boolean } | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [searchFilter, setSearchFilter] = useState("");
  const [sideBySide, setSideBySide] = useState(true);
  const [copiedPath, setCopiedPath] = useState(false);

  const [panelWidth, setPanelWidth] = useState(280);

  const handleDragStart = useCallback((e: React.MouseEvent) => {
    const startX = e.clientX;
    const startWidth = panelWidth;
    const onMove = (ev: MouseEvent) => {
      setPanelWidth(Math.max(180, Math.min(600, startWidth + ev.clientX - startX)));
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
  }, [panelWidth]);

  const fetchStatus = useCallback(async () => {
    dispatch({ type: "loading" });
    try {
      dispatch({ type: "loaded", files: await getRepoStatus() });
    } catch (err) {
      dispatch({ type: "error", error: errorMessage(err) });
    }
  }, []);

  useEffect(() => {
    fetchStatus();
  }, [fetchStatus, refreshTrigger]);

  const handleFileClick = useCallback(async (filePath: string) => {
    setSelectedFile(filePath);
    setDiffContent(null);
    setDiffError(null);
    setDiffLoading(true);
    try {
      setDiffContent(await getRepoDiff(filePath));
    } catch (err) {
      setDiffError(errorMessage(err));
    } finally {
      setDiffLoading(false);
    }
  }, []);

  const handleCopyPath = () => {
    if (!selectedFile) return;
    navigator.clipboard.writeText(selectedFile);
    setCopiedPath(true);
    toast.success("File path copied to clipboard");
    setTimeout(() => setCopiedPath(false), 2000);
  };

  const modifiedCount = status.files.filter((f) => f.status === "M").length;
  const addedCount = status.files.filter((f) => f.status === "A").length;
  const deletedCount = status.files.filter((f) => f.status === "D").length;
  const untrackedCount = status.files.filter((f) => f.status === "?").length;

  const filteredFiles = status.files.filter((f) =>
    f.path.toLowerCase().includes(searchFilter.toLowerCase())
  );

  const activeSelectedFileObj = status.files.find((f) => f.path === selectedFile);

  return (
    <div className="flex flex-1 min-h-0 overflow-hidden bg-background">
      {/* File list sidebar */}
      <div
        className="shrink-0 border-r flex flex-col overflow-hidden bg-card/40"
        style={{ width: panelWidth }}
      >
        {/* Header */}
        <div className="shrink-0 px-3 py-2 border-b flex items-center justify-between">
          <div className="flex items-center gap-1.5">
            <IconGitCommit className="size-4 text-primary" />
            <span className="text-xs font-semibold uppercase tracking-wider text-foreground">
              Source Control
            </span>
            {status.files.length > 0 && (
              <Badge variant="secondary" className="text-[10px] px-1.5 py-0 h-4 font-mono font-bold">
                {status.files.length}
              </Badge>
            )}
          </div>

          <Button
            size="sm"
            variant="ghost"
            onClick={fetchStatus}
            disabled={status.loading}
            className="h-6 w-6 p-0 text-muted-foreground hover:text-foreground"
            title="Refresh changes"
          >
            {status.loading ? <Spinner className="size-3" /> : <IconRefresh className="size-3.5" />}
          </Button>
        </div>

        {/* Status Summary Pills */}
        {status.files.length > 0 && (
          <div className="shrink-0 px-3 py-1.5 border-b bg-muted/20 flex flex-wrap items-center gap-1.5 text-[11px]">
            {modifiedCount > 0 && (
              <span className="inline-flex items-center gap-1 text-amber-600 dark:text-amber-400 font-medium">
                <span className="size-1.5 rounded-full bg-amber-500" />
                {modifiedCount} modified
              </span>
            )}
            {addedCount > 0 && (
              <span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400 font-medium">
                <span className="size-1.5 rounded-full bg-emerald-500" />
                {addedCount} added
              </span>
            )}
            {deletedCount > 0 && (
              <span className="inline-flex items-center gap-1 text-rose-500 dark:text-rose-400 font-medium">
                <span className="size-1.5 rounded-full bg-rose-500" />
                {deletedCount} deleted
              </span>
            )}
            {untrackedCount > 0 && (
              <span className="inline-flex items-center gap-1 text-muted-foreground font-medium">
                <span className="size-1.5 rounded-full bg-muted-foreground/60" />
                {untrackedCount} untracked
              </span>
            )}
          </div>
        )}

        {/* Filter input */}
        {status.files.length > 5 && (
          <div className="shrink-0 p-2 border-b bg-background">
            <div className="relative">
              <IconSearch className="size-3 absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={searchFilter}
                onChange={(e) => setSearchFilter(e.target.value)}
                placeholder="Filter changed files..."
                className="h-7 text-xs pl-7"
              />
            </div>
          </div>
        )}

        {/* Changed Files List */}
        <div className="flex-1 overflow-y-auto">
          {status.error ? (
            <div className="p-3 text-xs text-destructive flex items-start gap-2">
              <IconInfoCircle className="size-4 shrink-0 mt-0.5" />
              <span>{status.error}</span>
            </div>
          ) : status.files.length === 0 && !status.loading ? (
            <div className="flex flex-col items-center justify-center h-full gap-2 text-muted-foreground py-8">
              <IconFileDiff className="size-8 opacity-20" />
              <p className="text-xs font-medium">Working tree clean</p>
              <p className="text-[11px] text-muted-foreground/60">No uncommitted changes detected</p>
            </div>
          ) : (
            <div className="py-1">
              {filteredFiles.map((f) => {
                const fileName = f.path.split("/").pop() ?? f.path;
                const dirPath = f.path.includes("/") ? f.path.substring(0, f.path.lastIndexOf("/")) : "";
                const isSelected = selectedFile === f.path;

                return (
                  <button
                    key={f.path}
                    onClick={() => handleFileClick(f.path)}
                    className={cn(
                      "w-full flex items-center gap-2 px-3 py-1.5 text-xs text-left transition-colors cursor-pointer group",
                      isSelected
                        ? "bg-primary/10 text-primary font-medium border-l-2 border-l-primary"
                        : "hover:bg-accent/40 text-foreground border-l-2 border-l-transparent"
                    )}
                  >
                    <StatusBadge status={f.status} />
                    <FileIcon name={fileName} className="size-3.5 shrink-0" />
                    <div className="flex-1 min-w-0 font-mono">
                      <div className="truncate">{fileName}</div>
                      {dirPath && (
                        <div className="text-[10px] text-muted-foreground/60 truncate -mt-0.5">
                          {dirPath}
                        </div>
                      )}
                    </div>
                  </button>
                );
              })}
              {filteredFiles.length === 0 && searchFilter && (
                <p className="text-xs text-muted-foreground text-center py-4">No matching changes</p>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Resize handle */}
      <div
        className="w-1 shrink-0 bg-border hover:bg-primary/40 cursor-col-resize transition-colors"
        onMouseDown={handleDragStart}
      />

      {/* Diff editor main panel */}
      <div className="flex-1 min-w-0 flex flex-col overflow-hidden bg-background">
        {!selectedFile ? (
          <div className="flex flex-col items-center justify-center h-full text-muted-foreground gap-2">
            <IconFileDiff className="size-10 opacity-20" />
            <p className="text-xs font-medium">Select a file to inspect diff</p>
            <p className="text-[11px] text-muted-foreground/60">
              View side-by-side or inline changes against HEAD
            </p>
          </div>
        ) : diffLoading ? (
          <div className="flex flex-col items-center justify-center h-full gap-2 text-muted-foreground">
            <Spinner className="size-5" />
            <span className="text-xs font-mono">Loading diff for {selectedFile}…</span>
          </div>
        ) : diffError ? (
          <div className="p-6">
            <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-xs text-destructive">
              <p className="font-medium">Failed to compute diff</p>
              <p className="mt-1 font-mono">{diffError}</p>
            </div>
          </div>
        ) : diffContent ? (
          <>
            {/* Diff Header Bar */}
            <div className="shrink-0 px-3 py-1.5 border-b bg-muted/20 flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 min-w-0">
                {activeSelectedFileObj && <StatusBadge status={activeSelectedFileObj.status} />}
                <span className="text-xs font-mono font-medium truncate text-foreground">
                  {selectedFile}
                </span>

                <Tooltip>
                  <TooltipTrigger
                    onClick={handleCopyPath}
                    className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
                  >
                    {copiedPath ? <IconCheck className="size-3 text-emerald-500" /> : <IconCopy className="size-3" />}
                  </TooltipTrigger>
                  <TooltipContent side="bottom">Copy file path</TooltipContent>
                </Tooltip>
              </div>

              {/* View controls */}
              <div className="flex items-center gap-1.5 shrink-0">
                <div className="flex items-center rounded-md border bg-background p-0.5 shadow-2xs">
                  <Button
                    size="xs"
                    variant={sideBySide ? "secondary" : "ghost"}
                    onClick={() => setSideBySide(true)}
                    className="h-6 text-[11px] px-2 gap-1"
                    title="Side-by-side diff"
                  >
                    <IconLayoutColumns className="size-3" />
                    Split
                  </Button>
                  <Button
                    size="xs"
                    variant={!sideBySide ? "secondary" : "ghost"}
                    onClick={() => setSideBySide(false)}
                    className="h-6 text-[11px] px-2 gap-1"
                    title="Inline diff"
                  >
                    <IconLayoutRows className="size-3" />
                    Unified
                  </Button>
                </div>
              </div>
            </div>

            {/* Diff Content */}
            {!diffContent.hasTextualChanges ? (
              <div className="flex flex-col items-center justify-center h-full gap-2 text-muted-foreground p-6">
                <IconInfoCircle className="size-8 opacity-40 text-amber-500" />
                <p className="text-xs font-semibold text-foreground">No textual content diff</p>
                <p className="text-[11px] text-muted-foreground/80 text-center max-w-sm leading-relaxed">
                  The file differs only in file modes or line endings (CRLF vs LF).
                </p>
              </div>
            ) : (
              <div className="flex-1 min-h-0">
                <MonacoDiffEditor
                  key={`${selectedFile}-${sideBySide ? "split" : "inline"}`}
                  height="100%"
                  language={getLanguage(selectedFile)}
                  original={diffContent.original}
                  modified={diffContent.modified}
                  theme={resolvedTheme === "dark" ? "vs-dark" : "vs"}
                  options={{
                    readOnly: true,
                    renderSideBySide: sideBySide,
                    minimap: { enabled: true },
                    scrollBeyondLastLine: false,
                    fontSize: 13,
                    automaticLayout: true,
                    lineNumbers: "on",
                  }}
                />
              </div>
            )}
          </>
        ) : null}
      </div>
    </div>
  );
}
