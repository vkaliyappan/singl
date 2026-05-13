"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useTheme } from "next-themes";
import {
  IconGitBranch,
  IconAlertCircle,
  IconFile,
  IconChevronRight,
  IconArrowDown,
  IconRefresh,
  IconX,
  IconPackageImport,
  IconFold,
} from "@tabler/icons-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert } from "@/components/ui/alert";
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

interface RepoExplorerProps {
  hasPatToken: boolean;
  savedRepoUrl: string;
  savedBranch: string;
  savedSlug: string;
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

async function readStream(
  res: Response,
  onMessage: (msg: string) => void,
  onDone: (payload: string) => void | Promise<void>,
  onError: (msg: string) => void,
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
      } else {
        onMessage(line);
      }
    }
  }
}

export function RepoExplorer({
  hasPatToken,
  savedRepoUrl,
  savedBranch,
  savedSlug,
}: RepoExplorerProps) {
  const { resolvedTheme } = useTheme();

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

  // ── Initial-panel state ───────────────────────────────────────────────────
  const [repoUrl, setRepoUrl] = useState(savedRepoUrl);
  const [branches, setBranches] = useState<string[]>([]);
  const [selectedBranch, setSelectedBranch] = useState(savedBranch);
  const [fetchingBranches, setFetchingBranches] = useState(false);
  const [branchError, setBranchError] = useState<string | null>(null);

  const [cloneStatus, setCloneStatus] = useState<"idle" | "cloning" | "done" | "error">(
    savedSlug ? "done" : "idle"
  );
  const [cloneMessages, setCloneMessages] = useState<string[]>([]);
  const [clonedSlug, setClonedSlug] = useState<string | null>(savedSlug || null);

  // ── Git-toolbar state ─────────────────────────────────────────────────────
  const [currentBranch, setCurrentBranch] = useState(savedBranch);
  const [gitOp, setGitOp] = useState<"checkout" | "pull" | "fetch" | null>(null);
  const [gitMessages, setGitMessages] = useState<string[]>([]);
  const [gitError, setGitError] = useState(false);

  // ── Extract state ─────────────────────────────────────────────────────────
  const [extractStatus, setExtractStatus] = useState<"idle" | "extracting" | "done" | "error">("idle");
  const [extractMessages, setExtractMessages] = useState<string[]>([]);
  const extractProgressRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    extractProgressRef.current?.scrollTo(0, extractProgressRef.current.scrollHeight);
  }, [extractMessages]);

  // ── File-tree state ───────────────────────────────────────────────────────
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

  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState<string | null>(null);
  const [fileContentError, setFileContentError] = useState<string | null>(null);
  const [loadingContent, setLoadingContent] = useState(false);

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

  // Escape key closes the open file
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && selectedFile) handleCloseFile();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selectedFile, handleCloseFile]);

  const loadDir = useCallback(async (dirPath: string, isRoot = false) => {
    if (isRoot) {
      setTreeLoading(true);
    } else {
      setLoadingDirs((prev) => new Set(prev).add(dirPath));
      setDirErrors((prev) => { const next = new Map(prev); next.delete(dirPath); return next; });
    }
    try {
      const res = await fetch(`/api/repo/files?path=${encodeURIComponent(dirPath)}`);
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

  useEffect(() => {
    if (savedSlug) loadDir(savedSlug, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Initial-panel handlers ────────────────────────────────────────────────
  const handleFetchBranches = useCallback(async () => {
    if (!repoUrl.trim()) return;
    setBranchError(null);
    setBranches([]);
    setFetchingBranches(true);
    try {
      const res = await fetch("/api/repo/branches", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repoUrl }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to fetch branches");
      const fetched = data.branches as string[];
      setBranches(fetched);
      if (!selectedBranch || !fetched.includes(selectedBranch)) {
        setSelectedBranch(fetched[0] ?? "");
      }
    } catch (err) {
      setBranchError(err instanceof Error ? err.message : String(err));
    } finally {
      setFetchingBranches(false);
    }
  }, [repoUrl, selectedBranch]);

  // Auto-load branches when git toolbar first appears (page restore case)
  useEffect(() => {
    if (cloneStatus === "done" && repoUrl && branches.length === 0) {
      handleFetchBranches();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cloneStatus]);

  const handleClone = async () => {
    setCloneStatus("cloning");
    setCloneMessages([]);
    setClonedSlug(null);
    resetFileTree();

    try {
      const res = await fetch("/api/repo/clone", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repoUrl, branch: selectedBranch }),
      });

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
            const payload = JSON.parse(line.slice(6).trim()) as { slug: string };
            setCloneStatus("done");
            setClonedSlug(payload.slug);
            setCurrentBranch(selectedBranch);
            await loadDir(payload.slug, true);
          } else if (line.startsWith("[ERROR]")) {
            setCloneStatus("error");
            setCloneMessages((prev) => [...prev, line.slice(7).trim()]);
          } else {
            setCloneMessages((prev) => [...prev, line]);
          }
        }
      }
    } catch (err) {
      setCloneStatus("error");
      setCloneMessages((prev) => [
        ...prev,
        err instanceof Error ? err.message : String(err),
      ]);
    }
  };

  const handleExtract = useCallback(async () => {
    if (!clonedSlug) return;
    setExtractStatus("extracting");
    setExtractMessages([]);
    try {
      const res = await fetch("/api/twx-cli/extract", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repoSlug: clonedSlug }),
      });
      await readStream(
        res,
        (msg) => setExtractMessages((prev) => [...prev, msg]),
        async () => { setExtractStatus("done"); },
        (msg) => {
          setExtractStatus("error");
          setExtractMessages((prev) => [...prev, `Error: ${msg}`]);
        }
      );
    } catch (err) {
      setExtractStatus("error");
      setExtractMessages((prev) => [...prev, err instanceof Error ? err.message : String(err)]);
    }
  }, [clonedSlug]);

  const handleChangeRepo = useCallback(() => {
    setCloneStatus("idle");
    setClonedSlug(null);
    setCloneMessages([]);
    setGitMessages([]);
    setGitOp(null);
    setGitError(false);
    resetFileTree();
  }, [resetFileTree]);

  // ── Git-toolbar handlers ──────────────────────────────────────────────────
  const handleCheckout = useCallback(async (branch: string) => {
    if (!clonedSlug || branch === currentBranch) return;
    setGitOp("checkout");
    setGitError(false);
    setGitMessages([]);
    try {
      const res = await fetch("/api/repo/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug: clonedSlug, branch, repoUrl }),
      });
      await readStream(
        res,
        (msg) => setGitMessages((prev) => [...prev, msg]),
        async (payload) => {
          const { branch: newBranch } = JSON.parse(payload || "{}") as { branch: string };
          setCurrentBranch(newBranch);
          resetFileTree();
          await loadDir(clonedSlug, true);
        },
        (msg) => { setGitError(true); setGitMessages((prev) => [...prev, msg]); },
      );
    } catch (err) {
      setGitError(true);
      setGitMessages((prev) => [...prev, err instanceof Error ? err.message : String(err)]);
    } finally {
      setGitOp(null);
    }
  }, [clonedSlug, currentBranch, repoUrl, loadDir, resetFileTree]);

  const handlePull = useCallback(async () => {
    if (!clonedSlug) return;
    setGitOp("pull");
    setGitError(false);
    setGitMessages([]);
    try {
      const res = await fetch("/api/repo/pull", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug: clonedSlug, repoUrl }),
      });
      await readStream(
        res,
        (msg) => setGitMessages((prev) => [...prev, msg]),
        async () => {
          resetFileTree();
          await loadDir(clonedSlug, true);
        },
        (msg) => { setGitError(true); setGitMessages((prev) => [...prev, msg]); },
      );
    } catch (err) {
      setGitError(true);
      setGitMessages((prev) => [...prev, err instanceof Error ? err.message : String(err)]);
    } finally {
      setGitOp(null);
    }
  }, [clonedSlug, repoUrl, loadDir, resetFileTree]);

  const handleFetch = useCallback(async () => {
    if (!clonedSlug) return;
    setGitOp("fetch");
    setGitError(false);
    setGitMessages([]);
    try {
      const res = await fetch("/api/repo/fetch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug: clonedSlug, repoUrl }),
      });
      await readStream(
        res,
        (msg) => setGitMessages((prev) => [...prev, msg]),
        () => {},
        (msg) => { setGitError(true); setGitMessages((prev) => [...prev, msg]); },
      );
    } catch (err) {
      setGitError(true);
      setGitMessages((prev) => [...prev, err instanceof Error ? err.message : String(err)]);
    } finally {
      setGitOp(null);
    }
  }, [clonedSlug, repoUrl]);

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
      const res = await fetch(`/api/repo/content?path=${encodeURIComponent(filePath)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setFileContent(data.content as string);
    } catch (err) {
      setFileContentError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingContent(false);
    }
  }, []);

  const hasClone = cloneStatus === "done" && !!clonedSlug;
  const canFetchBranches = repoUrl.trim().length > 0 && !fetchingBranches;
  const canClone = branches.length > 0 && !!selectedBranch && cloneStatus !== "cloning";

  const repoName = repoUrl
    ? (repoUrl.split("/").pop()?.replace(/\.git$/, "") ?? "repository")
    : "repository";

  const openFileName = selectedFile?.split("/").pop() ?? "";

  return (
    <div className="flex flex-col h-full overflow-hidden">

      {/* ── Mode: initial control panel ────────────────────────────────────── */}
      {!hasClone && (
        <div className="shrink-0 border-b bg-background px-4 py-2.5">
          {!hasPatToken && (
            <Alert className="mb-2 py-1.5 text-xs flex items-center gap-2">
              <IconAlertCircle className="size-3.5 shrink-0" />
              <span>
                No PAT token configured.{" "}
                <Link href="/settings" className="underline font-medium">
                  Go to Settings
                </Link>{" "}
                to add one.
              </span>
            </Alert>
          )}

          <div className="flex items-end gap-2">
            <div className="flex-1 min-w-0">
              <Label className="text-xs text-muted-foreground mb-1 block">
                Repository URL
              </Label>
              <Input
                placeholder="https://github.com/owner/repo"
                value={repoUrl}
                onChange={(e) => {
                  setRepoUrl(e.target.value);
                  setBranches([]);
                  setBranchError(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && canFetchBranches) handleFetchBranches();
                }}
                className="h-8 text-sm"
              />
            </div>

            <div className="shrink-0">
              <Label className="text-xs text-muted-foreground mb-1 block invisible">&nbsp;</Label>
              <Button
                size="sm"
                variant="outline"
                onClick={handleFetchBranches}
                disabled={!canFetchBranches}
                className="h-8 whitespace-nowrap"
              >
                {fetchingBranches && <Spinner className="size-3.5 mr-1.5" />}
                Fetch Branches
              </Button>
            </div>

            <div className="w-40 shrink-0">
              <Label className="text-xs text-muted-foreground mb-1 block">Branch</Label>
              {branches.length > 0 ? (
                <Select value={selectedBranch} onValueChange={(v) => setSelectedBranch(v ?? "")}>
                  <SelectTrigger className="h-8 text-sm">
                    <SelectValue placeholder="Select branch" />
                  </SelectTrigger>
                  <SelectContent>
                    {branches.map((b) => (
                      <SelectItem key={b} value={b}>{b}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <Input
                  value={selectedBranch}
                  onChange={(e) => setSelectedBranch(e.target.value)}
                  placeholder="fetch or type"
                  className="h-8 text-sm"
                />
              )}
            </div>

            <div className="shrink-0">
              <Label className="text-xs text-muted-foreground mb-1 block invisible">&nbsp;</Label>
              <Button
                size="sm"
                onClick={handleClone}
                disabled={!canClone}
                className="h-8 whitespace-nowrap"
              >
                {cloneStatus === "cloning" && <Spinner className="size-3.5 mr-1.5" />}
                {cloneStatus === "cloning" ? "Cloning…" : "Clone"}
              </Button>
            </div>
          </div>

          {branchError && (
            <p className="mt-1.5 text-xs text-destructive">{branchError}</p>
          )}
        </div>
      )}

      {/* ── Mode: git toolbar (post-clone) ─────────────────────────────────── */}
      {hasClone && (
        <div className="shrink-0 border-b bg-background px-3 py-1.5 flex items-center gap-2">
          <IconGitBranch className="size-4 shrink-0 text-muted-foreground" />

          {branches.length > 0 ? (
            <Select
              value={currentBranch}
              onValueChange={(v) => v && handleCheckout(v)}
              disabled={!!gitOp}
            >
              <SelectTrigger className="h-7 text-xs w-44 font-mono">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {branches.map((b) => (
                  <SelectItem key={b} value={b} className="font-mono text-xs">
                    {b}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <div className="flex items-center gap-1.5">
              <span className="text-xs font-mono text-foreground">{currentBranch}</span>
              <Button
                size="sm"
                variant="ghost"
                onClick={handleFetchBranches}
                disabled={fetchingBranches}
                className="h-6 text-xs px-2 text-muted-foreground"
              >
                {fetchingBranches
                  ? <Spinner className="size-3" />
                  : <IconChevronRight className="size-3 rotate-90" />}
              </Button>
            </div>
          )}

          {gitOp === "checkout" && (
            <span className="text-xs text-muted-foreground flex items-center gap-1">
              <Spinner className="size-3" /> switching…
            </span>
          )}

          <div className="h-4 w-px bg-border mx-0.5" />

          <Button
            size="sm"
            variant="outline"
            onClick={handleFetch}
            disabled={!!gitOp}
            className="h-7 text-xs gap-1.5"
          >
            {gitOp === "fetch"
              ? <Spinner className="size-3" />
              : <IconRefresh className="size-3.5" />}
            Fetch
          </Button>

          <Button
            size="sm"
            variant="outline"
            onClick={handlePull}
            disabled={!!gitOp}
            className="h-7 text-xs gap-1.5"
          >
            {gitOp === "pull"
              ? <Spinner className="size-3" />
              : <IconArrowDown className="size-3.5" />}
            Pull
          </Button>

          <div className="h-4 w-px bg-border mx-0.5" />

          <Button
            size="sm"
            variant="outline"
            onClick={handleExtract}
            disabled={!!gitOp || extractStatus === "extracting"}
            className="h-7 text-xs gap-1.5"
          >
            {extractStatus === "extracting"
              ? <Spinner className="size-3" />
              : <IconPackageImport className="size-3.5" />}
            {extractStatus === "extracting" ? "Extracting…" : "Extract"}
          </Button>

          <div className="flex-1" />

          <span className="text-xs text-muted-foreground truncate max-w-[220px] hidden md:block font-mono">
            {repoUrl.replace(/^https?:\/\//, "").split("/").slice(-2).join("/")}
          </span>

          <Button
            size="sm"
            variant="ghost"
            onClick={handleChangeRepo}
            className="h-7 text-xs gap-1 text-muted-foreground hover:text-foreground"
          >
            <IconX className="size-3.5" />
            Change Repo
          </Button>
        </div>
      )}

      {/* ── Clone progress ─────────────────────────────────────────────────── */}
      {cloneMessages.length > 0 && (
        <div className="shrink-0 border-b px-4 py-1.5 bg-muted/40 max-h-24 overflow-y-auto">
          {cloneMessages.map((msg, i) => (
            <p
              key={i}
              className={cn(
                "text-xs font-mono",
                cloneStatus === "error" && i === cloneMessages.length - 1
                  ? "text-destructive"
                  : "text-muted-foreground"
              )}
            >
              {msg}
            </p>
          ))}
          {cloneStatus === "done" && (
            <p className="text-xs text-emerald-600 dark:text-emerald-400 font-medium">
              Repository ready.
            </p>
          )}
        </div>
      )}

      {/* ── Git operation output ────────────────────────────────────────────── */}
      {gitMessages.length > 0 && (
        <div className="shrink-0 border-b px-4 py-1.5 bg-muted/40 max-h-20 overflow-y-auto relative">
          <button
            onClick={() => { setGitMessages([]); setGitError(false); }}
            className="absolute top-1.5 right-2 text-muted-foreground hover:text-foreground"
            aria-label="Clear"
          >
            <IconX className="size-3.5" />
          </button>
          {gitMessages.map((msg, i) => (
            <p
              key={i}
              className={cn(
                "text-xs font-mono pr-5",
                gitError && i === gitMessages.length - 1
                  ? "text-destructive"
                  : "text-muted-foreground"
              )}
            >
              {msg}
            </p>
          ))}
        </div>
      )}

      {/* ── Extract progress ────────────────────────────────────────────────── */}
      {extractMessages.length > 0 && (
        <div className="shrink-0 border-b bg-muted/40 flex flex-col">
          <div className="flex items-center justify-between px-4 py-1 border-b border-border/40">
            <span className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide select-none">
              Extract Output
            </span>
            <button
              onClick={() => { setExtractMessages([]); if (extractStatus !== "extracting") setExtractStatus("idle"); }}
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

      {/* ── File explorer ───────────────────────────────────────────────────── */}
      {hasClone && (
        <div className="flex-1 min-h-0 flex overflow-hidden">
          {treeLoading ? (
            <div className="flex flex-1 items-center justify-center gap-2 text-muted-foreground">
              <Spinner className="size-5" />
              <span className="text-sm">Loading file tree…</span>
            </div>
          ) : (
            <>
              {/* ── Tree panel ── */}
              <div
                className="shrink-0 flex flex-col overflow-hidden border-r"
                style={{ width: treeWidth }}
              >
                {/* EXPLORER header */}
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

                {/* Repo root row */}
                <div className="shrink-0 flex items-center gap-1 px-2 py-1 border-b select-none">
                  <IconChevronRight className="size-3.5 shrink-0 text-muted-foreground rotate-90" />
                  <span className="text-xs font-semibold text-foreground uppercase tracking-wider truncate">
                    {repoName}
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

              {/* ── Editor panel ── */}
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

                    {/* Breadcrumb path */}
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
      )}

      {cloneStatus === "idle" && (
        <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground gap-3">
          <IconGitBranch className="size-10 opacity-20" />
          <p className="text-sm">Enter a repository URL, fetch branches, then clone.</p>
        </div>
      )}
    </div>
  );
}
