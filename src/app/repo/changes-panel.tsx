"use client";

import { useState, useEffect, useCallback, useReducer } from "react";
import dynamic from "next/dynamic";
import { useTheme } from "@/components/providers";
import { IconRefresh, IconGitCommit, IconFile } from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { FileIcon, getLanguage } from "@/components/file-tree";

const MonacoDiffEditor = dynamic(
  () => import("@monaco-editor/react").then((m) => ({ default: m.DiffEditor })),
  {
    ssr: false,
    loading: () => (
      <div className="flex items-center justify-center h-full text-muted-foreground text-xs">
        Loading editor…
      </div>
    ),
  }
);

interface ChangedFile {
  path: string;
  status: "M" | "A" | "D" | "?";
}

function StatusBadge({ status }: { status: ChangedFile["status"] }) {
  const map: Record<ChangedFile["status"], { label: string; className: string }> = {
    M: { label: "M", className: "text-amber-500 dark:text-amber-400" },
    A: { label: "A", className: "text-green-600 dark:text-green-400" },
    D: { label: "D", className: "text-red-500 dark:text-red-400" },
    "?": { label: "?", className: "text-muted-foreground" },
  };
  const { label, className } = map[status];
  return (
    <span className={cn("text-[10px] shrink-0 w-3 text-center font-bold", className)}>
      {label}
    </span>
  );
}

type StatusState = { loading: boolean; files: ChangedFile[]; repoPath: string | null; error: string | null };
type StatusAction =
  | { type: "loading" }
  | { type: "loaded"; files: ChangedFile[]; repoPath: string | null }
  | { type: "error"; error: string };

function statusReducer(_state: StatusState, action: StatusAction): StatusState {
  switch (action.type) {
    case "loading": return { loading: true, files: [], repoPath: null, error: null };
    case "loaded": return { loading: false, files: action.files, repoPath: action.repoPath, error: null };
    case "error": return { loading: false, files: [], repoPath: null, error: action.error };
  }
}

export function ChangesPanel({ refreshTrigger }: { refreshTrigger?: number }) {
  const { resolvedTheme } = useTheme();
  const [status, dispatch] = useReducer(statusReducer, { loading: false, files: [], repoPath: null, error: null });
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [diffContent, setDiffContent] = useState<{ original: string; modified: string; hasTextualChanges: boolean } | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffError, setDiffError] = useState<string | null>(null);

  const [panelWidth, setPanelWidth] = useState(256);

  const handleDragStart = useCallback((e: React.MouseEvent) => {
    const startX = e.clientX;
    const startWidth = panelWidth;
    const onMove = (ev: MouseEvent) => {
      setPanelWidth(Math.max(160, Math.min(600, startWidth + ev.clientX - startX)));
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
      const res = await fetch("/api/repo/status");
      const data = (await res.json()) as { files?: ChangedFile[]; repoPath?: string; error?: string };
      if (!res.ok) throw new Error(data.error ?? "Failed to load status");
      dispatch({ type: "loaded", files: data.files ?? [], repoPath: data.repoPath ?? null });
    } catch (err) {
      dispatch({ type: "error", error: err instanceof Error ? err.message : String(err) });
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
      const res = await fetch(`/api/repo/diff?file=${encodeURIComponent(filePath)}`);
      const data = (await res.json()) as { original?: string; modified?: string; hasTextualChanges?: boolean; error?: string };
      if (!res.ok) throw new Error(data.error ?? "Failed to load diff");
      setDiffContent({ original: data.original ?? "", modified: data.modified ?? "", hasTextualChanges: data.hasTextualChanges ?? true });
    } catch (err) {
      setDiffError(err instanceof Error ? err.message : String(err));
    } finally {
      setDiffLoading(false);
    }
  }, []);

  return (
    <div className="flex flex-1 min-h-0 overflow-hidden">
      {/* File list */}
      <div className="shrink-0 border-r flex flex-col overflow-hidden" style={{ width: panelWidth }}>
        <div className="shrink-0 flex items-center justify-between px-3 py-2 border-b">
          <div className="flex flex-col min-w-0">
            <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Changes
            </span>
            {status.repoPath && (
              <span className="text-[10px] text-muted-foreground/60 font-mono truncate" title={status.repoPath}>
                {status.repoPath}
              </span>
            )}
          </div>
          <Button
            size="sm"
            variant="ghost"
            onClick={fetchStatus}
            disabled={status.loading}
            className="h-6 w-6 p-0"
            title="Refresh"
          >
            {status.loading ? <Spinner className="size-3" /> : <IconRefresh className="size-3.5" />}
          </Button>
        </div>

        <div className="flex-1 overflow-y-auto">
          {status.error ? (
            <p className="px-3 py-2 text-xs text-destructive">{status.error}</p>
          ) : status.files.length === 0 && !status.loading ? (
            <div className="flex flex-col items-center justify-center h-full gap-2 text-muted-foreground py-8">
              <IconGitCommit className="size-8 opacity-20" />
              <p className="text-xs">No uncommitted changes</p>
            </div>
          ) : (
            <div className="py-0.5">
              {status.files.map((f) => {
                const fileName = f.path.split("/").pop() ?? f.path;
                return (
                  <button
                    key={f.path}
                    onClick={() => handleFileClick(f.path)}
                    className={cn(
                      "w-full flex items-center gap-1.5 px-3 py-1 text-xs text-left hover:bg-accent/50 transition-colors",
                      selectedFile === f.path && "bg-accent text-accent-foreground"
                    )}
                  >
                    <StatusBadge status={f.status} />
                    <FileIcon name={fileName} className="size-3.5 shrink-0 text-muted-foreground" />
                    <span className="font-mono truncate flex-1" title={f.path}>{fileName}</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {status.files.length > 0 && (
          <div className="shrink-0 border-t px-3 py-1.5">
            <span className="text-[11px] text-muted-foreground">
              {status.files.length} file{status.files.length !== 1 ? "s" : ""} changed
            </span>
          </div>
        )}
      </div>

      {/* Resize handle */}
      <div
        className="w-1 shrink-0 bg-border hover:bg-primary/40 cursor-col-resize transition-colors"
        onMouseDown={handleDragStart}
      />

      {/* Diff editor */}
      <div className="flex-1 min-w-0 flex flex-col overflow-hidden">
        {!selectedFile ? (
          <div className="flex flex-col items-center justify-center h-full text-muted-foreground gap-2">
            <IconFile className="size-8 opacity-20" />
            <p className="text-xs">Select a file to view changes</p>
          </div>
        ) : diffLoading ? (
          <div className="flex items-center justify-center h-full">
            <Spinner className="size-5" />
          </div>
        ) : diffError ? (
          <div className="p-4">
            <p className="text-xs text-destructive">{diffError}</p>
          </div>
        ) : diffContent ? (
          <>
            <div className="shrink-0 px-3 py-1 border-b bg-muted/10">
              <span className="text-[11px] text-muted-foreground font-mono truncate">{selectedFile}</span>
            </div>
            {!diffContent.hasTextualChanges ? (
              <div className="flex flex-col items-center justify-center h-full gap-1.5 text-muted-foreground">
                <p className="text-xs font-medium">No textual changes</p>
                <p className="text-[11px] text-muted-foreground/60 text-center max-w-xs">
                  The file differs only in line endings or file mode (e.g. CRLF vs LF via git&apos;s autocrlf setting).
                </p>
              </div>
            ) : (
              <div className="flex-1 min-h-0">
                <MonacoDiffEditor
                  key={selectedFile}
                  height="100%"
                  language={getLanguage(selectedFile)}
                  original={diffContent.original}
                  modified={diffContent.modified}
                  theme={resolvedTheme === "dark" ? "vs-dark" : "vs"}
                  options={{
                    readOnly: true,
                    renderSideBySide: true,
                    minimap: { enabled: false },
                    scrollBeyondLastLine: false,
                    fontSize: 13,
                    automaticLayout: true,
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
