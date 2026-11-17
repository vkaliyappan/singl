"use client";

// Ported from singl-web's /repo page. The /api/repo/* routes are Tauri commands
// (src/lib/repo.ts, src/lib/twx.ts); git and extract output streams over a
// Channel instead of SSE.

import { useState, useCallback, useEffect, useRef, useMemo } from "react";
import dynamic from "next/dynamic";
import { useAssistantContext } from "@/lib/assistant/context";
import { useTheme } from "@/components/providers";
import {
  IconGitBranch,
  IconFile,
  IconArrowDown,
  IconRefresh,
  IconX,
  IconInfoCircle,
  IconPackageImport,
  IconGitCommit,
  IconTrash,
  IconSearch,
  IconLayoutSidebarLeftCollapse,
  IconLayoutSidebarLeftExpand,
  IconCopy,
  IconCheck,
  IconDownload,
  IconTextWrap,
  IconMap,
  IconBrandGithub,
  IconBrandAzure,
  IconBrandGitlab,
  IconFolderCode,
  IconCode,
  IconMessagePlus,
} from "@tabler/icons-react";
import { ChangesPanel } from "./changes-panel";
import { addPins, usePinnables, type NewPin } from "@/lib/assistant/pins";
import { RepoSetupCard } from "./repo-setup-card";
import { RepoOutputDrawer } from "./repo-output-drawer";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { FileIcon, FileTreePanel, OpenEditorsPanel, getLanguage } from "@/components/file-tree";
import { RepoFileTree } from "./repo-file-tree";
import { SearchPanel, type SearchOptions, type SearchFileResult } from "@/components/search-panel";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { toast } from "sonner";
import { listBranches, listRepoFiles, readRepoFile, searchRepo, type RepoSlot } from "@/lib/repo";
import { errorMessage } from "@/lib/settings";
import { clearJob, isJobRunning, useJob, useJobFinished, type Job } from "@/lib/background-jobs";
import {
  repoJobKey,
  loadRepoTimes,
  startCheckout,
  startClear,
  startClone,
  startExtract,
  startFetch,
  startPull,
  type RepoJobMeta,
} from "@/lib/repo-jobs";
import { clipText, PIN_LIMIT } from "@/lib/assistant/pin-utils";
import { onAssistantChange } from "@/lib/assistant/changes";

const MonacoEditor = dynamic(() => import("@monaco-editor/react"), {
  ssr: false,
  loading: () => (
    <div className="flex items-center justify-center h-full text-muted-foreground text-xs">
      Loading editor…
    </div>
  ),
});

// ── "Add to chat" helpers ────────────────────────────────────────────────────



interface TabState {
  content: string | null;
  error: string | null;
  loading: boolean;
}

interface RepoExplorerProps {
  slot: RepoSlot;
  hasPatToken: boolean;
  savedRepoUrl: string;
  savedBranch: string;
  savedSlug: string;
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

function getProviderInfo(url: string) {
  const lower = url.toLowerCase();
  if (lower.includes("github.com")) {
    return { name: "GitHub", icon: IconBrandGithub, color: "text-foreground" };
  }
  if (lower.includes("dev.azure.com") || lower.includes("visualstudio.com")) {
    return { name: "Azure DevOps", icon: IconBrandAzure, color: "text-blue-500" };
  }
  if (lower.includes("gitlab.com")) {
    return { name: "GitLab", icon: IconBrandGitlab, color: "text-orange-500" };
  }
  return { name: "Git Repository", icon: IconFolderCode, color: "text-primary" };
}

export function RepoExplorer({
  slot,
  hasPatToken,
  savedRepoUrl,
  savedBranch,
  savedSlug,
}: RepoExplorerProps) {
  const { resolvedTheme } = useTheme();
  const REPO_JOB = repoJobKey(slot);
  const storageKey = slot === 1 ? "singl:repo" : `singl:repo${slot}`;

  // ── View (explorer / changes) ─────────────────────────────────────────────
  const [view, setView] = useState<"explorer" | "changes">("explorer");

  // ── Sidebar & Panel State ─────────────────────────────────────────────────
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [treeWidth, setTreeWidth] = useState(280);
  const treeWidthRef = useRef(280);
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

  // ── Search panel state ────────────────────────────────────────────────────
  const [searchActive, setSearchActive] = useState(false);
  const editorRef = useRef<{
    revealLineInCenter: (n: number) => void;
    setPosition: (p: { lineNumber: number; column: number }) => void;
    focus: () => void;
  } | null>(null);
  const pendingJumpRef = useRef<{ line: number; col: number } | null>(null);

  // ── Initial-panel state ───────────────────────────────────────────────────
  const [repoUrl, setRepoUrl] = useState(savedRepoUrl);
  const [branches, setBranches] = useState<string[]>([]);
  const [selectedBranch, setSelectedBranch] = useState(savedBranch);
  const [fetchingBranches, setFetchingBranches] = useState(false);
  const [branchError, setBranchError] = useState<string | null>(null);

  // Git / extract operations run as one background job (@/lib/repo-jobs) that outlives this page.
  const repoJob = useJob<RepoJobMeta>(REPO_JOB);
  const runningOp = repoJob.status === "running" ? repoJob.meta?.op ?? null : null;

  const [cloneState, setCloneStatus] = useState<"idle" | "done" | "error">(savedSlug ? "done" : "idle");
  const cloneStatus = runningOp === "clone" ? "cloning" : cloneState;
  const [clonedSlug, setClonedSlug] = useState<string | null>(savedSlug || null);

  // ── Git-toolbar state ─────────────────────────────────────────────────────
  const [currentBranch, setCurrentBranch] = useState(savedBranch);
  const gitOp = runningOp === "checkout" || runningOp === "pull" || runningOp === "fetch" ? runningOp : null;

  // ── Extract state ─────────────────────────────────────────────────────────
  // Extract / Clear turn TWX package XML into Code/ folders: the TWX page only.
  const canExtract = slot === 1;
  const extractStatus = runningOp === "extract" ? "extracting" : "idle";

  // ── Clear extracted state ─────────────────────────────────────────────────
  const [clearDialogOpen, setClearDialogOpen] = useState(false);
  const clearStatus = runningOp === "clear" ? "clearing" : "idle";
  const [changesPanelRefresh, setChangesPanelRefresh] = useState(0);

  // ── Console Output Drawer State ───────────────────────────────────────────
  const [consoleOpen, setConsoleOpen] = useState(() => isJobRunning(REPO_JOB));
  const consoleTitle = repoJob.meta?.title ?? "Process Console";
  const consoleStatus = repoJob.status;
  const consoleRunningLabel = repoJob.meta?.runningLabel ?? "Processing...";
  const consoleMessages = useMemo(() => repoJob.log.map((l) => l.text), [repoJob.log]);

  // ── Timestamps ────────────────────────────────────────────────────────────
  const [lastPulled, setLastPulled] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);

  // ── File-tree state ───────────────────────────────────────────────────────
  // Every file in the repo, relative to its root (folders end in "/").
  const [treePaths, setTreePaths] = useState<string[]>([]);
  const [treeLoading, setTreeLoading] = useState(false);

  // ── Multi-tab editor state ────────────────────────────────────────────────
  const [openTabs, setOpenTabs] = useState<Map<string, TabState>>(new Map());
  const [activeTab, setActiveTab] = useState<string | null>(null);
  const openTabsRef = useRef(openTabs);
  openTabsRef.current = openTabs;
  const activeTabRef = useRef(activeTab);
  activeTabRef.current = activeTab;

  // ── Editor Controls ───────────────────────────────────────────────────────
  const [wordWrap, setWordWrap] = useState<"on" | "off">("on");
  const [minimapEnabled, setMinimapEnabled] = useState(true);
  const [copiedContent, setCopiedContent] = useState(false);
  const [copiedBreadcrumb, setCopiedBreadcrumb] = useState(false);
  const [copiedCloneUrl, setCopiedCloneUrl] = useState(false);

  // ── Assistant: repo state and the code selected in the viewer ─────────────
  const [codeSel, setCodeSel] = useState<{ file: string; range: string; text: string } | null>(null);
  useAssistantContext({
    screen: slot === 1 ? "repo" : "repo2",
    title: slot === 1 ? "TWX Repository" : "Windchill Repository",
    summary:
      cloneState === "done"
        ? `${clonedSlug ?? "repository"} on ${currentBranch || "?"}${activeTab ? `, ${activeTab.split("/").at(-1)} open` : ""} (${view})`
        : "No repository cloned yet",
    data: { repoUrl, branch: currentBranch, cloned: cloneState === "done", view, openFile: activeTab, lastPulled },
    selection: { file: activeTab && view === "explorer" ? activeTab : null, code: codeSel && codeSel.file === activeTab ? codeSel : null },
  });

  // ── Persistence ───────────────────────────────────────────────────────────
  const hasMountedRef = useRef(false);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(storageKey);
      if (!raw) return;
      const s = JSON.parse(raw) as {
        treeWidth?: number;
        activeTab?: string | null;
        selectedFile?: string | null;
        wordWrap?: "on" | "off";
        minimapEnabled?: boolean;
      };
      if (typeof s.treeWidth === "number") {
        setTreeWidth(s.treeWidth);
        treeWidthRef.current = s.treeWidth;
      }
      if (s.wordWrap) setWordWrap(s.wordWrap);
      if (typeof s.minimapEnabled === "boolean") setMinimapEnabled(s.minimapEnabled);
      const fileToRestore = s.activeTab ?? s.selectedFile ?? null;
      if (fileToRestore) handleFileClick(fileToRestore);
    } catch {}
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!hasMountedRef.current) {
      hasMountedRef.current = true;
      return;
    }
    try {
      localStorage.setItem(
        storageKey,
        JSON.stringify({ treeWidth, activeTab, wordWrap, minimapEnabled })
      );
    } catch {}
  }, [storageKey, treeWidth, activeTab, wordWrap, minimapEnabled]);

  useEffect(() => {
    const s = loadRepoTimes(slot);
    if (s.lastPulled) setLastPulled(s.lastPulled);
    if (s.lastUpdated) setLastUpdated(s.lastUpdated);
  }, [slot]);

  // ── Helpers ───────────────────────────────────────────────────────────────
  const resetFileTree = useCallback(() => {
    setTreePaths([]);
    setOpenTabs(new Map());
    setActiveTab(null);
  }, []);

  const handleCloseTab = useCallback((path: string) => {
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
  }, []);

  const handleCloseAllTabs = useCallback(() => {
    setOpenTabs(new Map());
    setActiveTab(null);
  }, []);

  const handleCloseOtherTabs = useCallback((keepPath: string) => {
    setOpenTabs((prev) => {
      const next = new Map();
      const current = prev.get(keepPath);
      if (current) next.set(keepPath, current);
      return next;
    });
    setActiveTab(keepPath);
  }, []);

  // Escape key closes the active tab
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && activeTabRef.current) {
        handleCloseTab(activeTabRef.current);
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "b") {
        e.preventDefault();
        setSidebarOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [handleCloseTab]);

  const loadDir = useCallback(async () => {
    setTreeLoading(true);
    try {
      setTreePaths(await listRepoFiles(slot));
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setTreeLoading(false);
    }
  }, [slot]);

  useEffect(() => {
    if (savedSlug) loadDir();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A pull, checkout or clean by the assistant changes the files on disk:
  // re-list them and reload the open (read-only) tabs.
  useEffect(() => {
    return onAssistantChange("repo", () => {
      void loadDir();
      for (const path of openTabsRef.current.keys()) {
        readRepoFile(slot, path.slice(path.indexOf("/") + 1))
          .then((content) =>
            setOpenTabs((prev) =>
              prev.has(path) ? new Map(prev).set(path, { content, error: null, loading: false }) : prev
            )
          )
          .catch(() => {});
      }
    });
  }, [loadDir, slot]);

  // ── Initial-panel handlers ────────────────────────────────────────────────
  const handleFetchBranches = useCallback(async () => {
    if (!repoUrl.trim()) return;
    setBranchError(null);
    setBranches([]);
    setFetchingBranches(true);
    try {
      const fetched = await listBranches(repoUrl);
      setBranches(fetched);
      if (!selectedBranch || !fetched.includes(selectedBranch)) {
        setSelectedBranch(fetched[0] ?? "");
      }
      toast.success(`Fetched ${fetched.length} branches`);
    } catch (err) {
      const msg = errorMessage(err);
      setBranchError(msg);
      toast.error(msg);
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

  const handleClone = () => {
    if (isJobRunning(REPO_JOB)) return;
    setClonedSlug(null);
    resetFileTree();
    setConsoleOpen(true);
    void startClone(slot, repoUrl, selectedBranch);
  };

  const handleExtract = useCallback(() => {
    if (!clonedSlug) return;
    setConsoleOpen(true);
    void startExtract(slot, clonedSlug);
  }, [slot, clonedSlug]);

  const handleClearExtracted = useCallback(() => {
    setConsoleOpen(true);
    void startClear(slot);
  }, [slot]);

  const handleChangeRepo = useCallback(() => {
    if (isJobRunning(REPO_JOB)) return;
    setCloneStatus("idle");
    setClonedSlug(null);
    clearJob(REPO_JOB);
    resetFileTree();
  }, [REPO_JOB, resetFileTree]);

  // ── Git-toolbar handlers ──────────────────────────────────────────────────
  const handleCheckout = useCallback(
    (branch: string) => {
      if (!clonedSlug || branch === currentBranch) return;
      setConsoleOpen(true);
      void startCheckout(slot, branch);
    },
    [slot, clonedSlug, currentBranch]
  );

  const handlePull = useCallback(() => {
    if (!clonedSlug) return;
    setConsoleOpen(true);
    void startPull(slot, clonedSlug, currentBranch);
  }, [slot, clonedSlug, currentBranch]);

  const handleFetch = useCallback(() => {
    if (!clonedSlug) return;
    setConsoleOpen(true);
    void startFetch(slot);
  }, [slot, clonedSlug]);

  // An operation ended while this page is open: bring the page up to date.
  // (One that ended while it was closed is picked up by the mount-time loads.)
  useJobFinished<RepoJobMeta>(
    REPO_JOB,
    useCallback(
      (job: Job<RepoJobMeta>) => {
        const meta = job.meta;
        if (!meta) return;
        if (job.status !== "done") {
          if (meta.op === "clone") setCloneStatus("error");
          return;
        }
        const times = loadRepoTimes(slot);
        switch (meta.op) {
          case "clone":
            setCloneStatus("done");
            setClonedSlug(job.result as string);
            if (meta.branch) setCurrentBranch(meta.branch);
            if (times.lastUpdated) setLastUpdated(times.lastUpdated);
            break;
          case "checkout":
            if (meta.branch) setCurrentBranch(meta.branch);
            break;
          case "pull":
            if (times.lastPulled) setLastPulled(times.lastPulled);
            if (times.lastUpdated) setLastUpdated(times.lastUpdated);
            break;
          case "extract":
          case "clear":
            setChangesPanelRefresh((n) => n + 1);
            break;
          case "fetch":
            return;
        }
        resetFileTree();
        void loadDir();
      },
      [slot, loadDir, resetFileTree]
    )
  );

  const handleFileClick = useCallback(async (filePath: string) => {
    if (openTabsRef.current.has(filePath)) {
      setActiveTab(filePath);
      return;
    }
    setOpenTabs((prev) => new Map(prev).set(filePath, { content: null, error: null, loading: true }));
    setActiveTab(filePath);
    try {
      // Tabs are keyed "<slug>/<path>"; the command takes the path inside the clone.
      const content = await readRepoFile(slot, filePath.slice(filePath.indexOf("/") + 1));
      setOpenTabs((prev) => {
        const next = new Map(prev);
        next.set(filePath, { content, error: null, loading: false });
        return next;
      });
    } catch (err) {
      setOpenTabs((prev) => {
        const next = new Map(prev);
        next.set(filePath, {
          content: null,
          error: errorMessage(err),
          loading: false,
        });
        return next;
      });
    }
  }, [slot]);

  // ── Search handlers ───────────────────────────────────────────────────────
  const handleSearch = useCallback(
    async (query: string, opts: SearchOptions): Promise<SearchFileResult[]> => {
      if (!clonedSlug) return [];
      try {
        return await searchRepo(slot, query, opts);
      } catch (err) {
        throw new Error(errorMessage(err));
      }
    },
    [slot, clonedSlug]
  );

  const handleSearchResultClick = useCallback(
    async (filePath: string, lineNumber: number, col: number) => {
      const fullPath = clonedSlug ? `${clonedSlug}/${filePath}` : filePath;
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
    },
    [clonedSlug, handleFileClick]
  );

  // ── File Actions ──────────────────────────────────────────────────────────
  const handleCopyContent = () => {
    if (!activeTab || !activeTabState?.content) return;
    navigator.clipboard.writeText(activeTabState.content);
    setCopiedContent(true);
    toast.success("File content copied to clipboard");
    setTimeout(() => setCopiedContent(false), 2000);
  };

  const handleCopyBreadcrumbPath = () => {
    if (!activeTab) return;
    navigator.clipboard.writeText(activeTab);
    setCopiedBreadcrumb(true);
    toast.success("Relative file path copied");
    setTimeout(() => setCopiedBreadcrumb(false), 2000);
  };

  const handleDownloadFile = () => {
    if (!activeTab || !activeTabState?.content) return;
    const fileName = activeTab.split("/").pop() ?? "download";
    const blob = new Blob([activeTabState.content], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName;
    a.click();
    URL.revokeObjectURL(url);
    toast.success(`Downloaded ${fileName}`);
  };

  const handleCopyCloneUrl = () => {
    if (!repoUrl) return;
    navigator.clipboard.writeText(repoUrl);
    setCopiedCloneUrl(true);
    toast.success("Repository URL copied");
    setTimeout(() => setCopiedCloneUrl(false), 2000);
  };

  const hasClone = cloneStatus === "done" && !!clonedSlug;
  const repoName = repoUrl
    ? (repoUrl.split("/").pop()?.replace(/\.git$/, "") ?? "repository")
    : "repository";

  const provider = getProviderInfo(repoUrl);
  const ProviderIcon = provider.icon;
  const activeTabState = activeTab ? openTabs.get(activeTab) : null;
  const activeFileName = activeTab ? (activeTab.split("/").pop() ?? "") : "";
  const activeLang = activeTab ? getLanguage(activeTab) : "";
  const activeLineCount = activeTabState?.content ? activeTabState.content.split("\n").length : 0;

  // ── Add to chat: the open file. This screen shows file contents, not diffs;
  // the diff and changed-file list are pinned from the Changes view (changes-panel).
  const pinScreen = slot === 1 ? "repo" : "repo2";
  const filePin = (): NewPin | null => {
    if (!activeTab || !activeTabState?.content) return null;
    return {
      kind: "file",
      label: activeTab,
      screen: pinScreen,
      detail: `${activeLineCount} lines`,
      content: clipText(activeTabState.content, PIN_LIMIT),
    };
  };
  const pinFile = () => {
    const p = filePin();
    if (p) addPins([p]);
  };
  usePinnables(
    view === "explorer" && activeTab && activeTabState?.content
      ? [{ kind: "file", label: activeTab, detail: `${activeLineCount} lines`, content: () => filePin()?.content ?? "" }]
      : []
  );

  return (
    <div className="flex flex-col h-full overflow-hidden bg-background">
      {/* ── Mode: Initial setup when no repository is cloned ─────────────── */}
      {!hasClone && (
        <RepoSetupCard
          hasPatToken={hasPatToken}
          repoUrl={repoUrl}
          onRepoUrlChange={(url) => {
            setRepoUrl(url);
            setBranches([]);
            setBranchError(null);
          }}
          branches={branches}
          selectedBranch={selectedBranch}
          onSelectBranch={setSelectedBranch}
          fetchingBranches={fetchingBranches}
          branchError={branchError}
          onFetchBranches={handleFetchBranches}
          cloneStatus={cloneStatus}
          onClone={handleClone}
        />
      )}

      {/* ── Mode: Git Toolbar & Workspace (Post-clone) ───────────────────── */}
      {hasClone && (
        <>
          {/* Top Repository Bar */}
          <div className="shrink-0 border-b bg-card/80 backdrop-blur px-3 py-1.5 flex items-center justify-between gap-3 select-none">
            {/* Left: Repo Identity & Branch Selector */}
            <div className="flex items-center gap-2.5 min-w-0">
              {/* Sidebar toggle */}
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setSidebarOpen((v) => !v)}
                className="h-7 w-7 p-0 text-muted-foreground hover:text-foreground shrink-0"
                title={sidebarOpen ? "Hide sidebar (Ctrl+B)" : "Show sidebar (Ctrl+B)"}
              >
                {sidebarOpen ? (
                  <IconLayoutSidebarLeftCollapse className="size-4" />
                ) : (
                  <IconLayoutSidebarLeftExpand className="size-4" />
                )}
              </Button>

              <div className="h-4 w-px bg-border/60 shrink-0" />

              {/* Repo Tag / Provider */}
              <div className="flex items-center gap-1.5 min-w-0">
                <ProviderIcon className={cn("size-4 shrink-0", provider.color)} />
                <span className="text-xs font-semibold tracking-tight text-foreground truncate">
                  {repoName}
                </span>

                <Tooltip>
                  <TooltipTrigger
                    onClick={handleCopyCloneUrl}
                    className="p-1 rounded text-muted-foreground/60 hover:text-foreground transition-colors shrink-0"
                  >
                    {copiedCloneUrl ? (
                      <IconCheck className="size-3 text-emerald-500" />
                    ) : (
                      <IconCopy className="size-3" />
                    )}
                  </TooltipTrigger>
                  <TooltipContent side="bottom">Copy repository URL</TooltipContent>
                </Tooltip>
              </div>

              {/* Branch Selector */}
              <div className="flex items-center gap-1">
                {branches.length > 0 ? (
                  <Select
                    value={currentBranch}
                    onValueChange={(v) => v && handleCheckout(v)}
                    disabled={!!gitOp}
                  >
                    <SelectTrigger className="h-7 text-xs font-mono max-w-[190px] gap-1.5 bg-background shadow-2xs border-border/70">
                      <IconGitBranch className="size-3.5 shrink-0 text-primary" />
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className="max-h-64">
                      {branches.map((b) => (
                        <SelectItem key={b} value={b} className="font-mono text-xs">
                          <div className="flex items-center gap-1.5">
                            <span>{b}</span>
                            {b === currentBranch && (
                              <Badge
                                variant="secondary"
                                className="text-[9px] px-1 py-0 h-3.5 bg-primary/10 text-primary border-primary/20"
                              >
                                active
                              </Badge>
                            )}
                          </div>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  <div className="flex items-center gap-1.5 px-2 py-0.5 rounded border bg-background text-xs font-mono">
                    <IconGitBranch className="size-3.5 text-primary" />
                    <span>{currentBranch}</span>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={handleFetchBranches}
                      disabled={fetchingBranches}
                      className="h-5 w-5 p-0 text-muted-foreground hover:text-foreground ml-0.5"
                      title="Fetch branches"
                    >
                      {fetchingBranches ? (
                        <Spinner className="size-3" />
                      ) : (
                        <IconRefresh className="size-3" />
                      )}
                    </Button>
                  </div>
                )}

                {gitOp === "checkout" && (
                  <Badge variant="outline" className="text-[10px] animate-pulse gap-1 h-5">
                    <Spinner className="size-2.5" /> switching
                  </Badge>
                )}
              </div>
            </div>

            {/* Right: Git Actions & Tools */}
            <div className="flex items-center gap-1.5 shrink-0">
              {/* Sync Actions */}
              <div className="flex items-center rounded-md border bg-background p-0.5 shadow-2xs">
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        size="xs"
                        variant="ghost"
                        onClick={handleFetch}
                        disabled={!!gitOp}
                        className="h-6 text-xs gap-1 px-2 text-muted-foreground hover:text-foreground"
                      >
                        {gitOp === "fetch" ? (
                          <Spinner className="size-3" />
                        ) : (
                          <IconRefresh className="size-3.5" />
                        )}
                        Fetch
                      </Button>
                    }
                  />
                  <TooltipContent side="bottom">
                    Fetch latest commits and branches from remote
                  </TooltipContent>
                </Tooltip>

                <div className="h-3.5 w-px bg-border/60" />

                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        size="xs"
                        variant="ghost"
                        onClick={handlePull}
                        disabled={!!gitOp}
                        className="h-6 text-xs gap-1 px-2 text-muted-foreground hover:text-foreground"
                      >
                        {gitOp === "pull" ? (
                          <Spinner className="size-3" />
                        ) : (
                          <IconArrowDown className="size-3.5" />
                        )}
                        Pull
                      </Button>
                    }
                  />
                  <TooltipContent side="bottom">
                    Pull latest changes (Last pulled: {fmtTimestamp(lastPulled)})
                  </TooltipContent>
                </Tooltip>
              </div>

              {/* Build / Extract Actions: TWX packages only, so not on the Windchill page */}
              {canExtract && (
              <>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={handleExtract}
                      disabled={!!gitOp || extractStatus === "extracting"}
                      className="h-7 text-xs gap-1.5 shadow-2xs border-border/70"
                    >
                      {extractStatus === "extracting" ? (
                        <Spinner className="size-3" />
                      ) : (
                        <IconPackageImport className="size-3.5 text-primary" />
                      )}
                      {extractStatus === "extracting" ? "Extracting…" : "Extract"}
                    </Button>
                  }
                />
                <TooltipContent side="bottom">
                  Extract XML deployment entities into inspectable Code/ directories
                </TooltipContent>
              </Tooltip>

              <AlertDialog open={clearDialogOpen} onOpenChange={setClearDialogOpen}>
                <AlertDialogTrigger
                  render={
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={!!gitOp || clearStatus === "clearing"}
                      className="h-7 text-xs gap-1 text-rose-600 dark:text-rose-400 hover:text-rose-600 border-rose-500/30 hover:bg-rose-500/10 shadow-2xs"
                    >
                      {clearStatus === "clearing" ? (
                        <Spinner className="size-3" />
                      ) : (
                        <IconTrash className="size-3.5" />
                      )}
                      Clear
                    </Button>
                  }
                />
                <AlertDialogContent size="sm">
                  <AlertDialogHeader>
                    <AlertDialogTitle>Clear extracted code directories?</AlertDialogTitle>
                    <AlertDialogDescription>
                      This will remove all generated <code>Code/</code> directories created by Extract.
                      Your git workspace and tracked files will remain intact.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction
                      variant="destructive"
                      onClick={() => {
                        setClearDialogOpen(false);
                        handleClearExtracted();
                      }}
                    >
                      Clear Extracted
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
              </>
              )}

              <div className="h-4 w-px bg-border/60 mx-0.5" />

              {/* Search Toggle */}
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      size="sm"
                      variant={searchActive ? "secondary" : "ghost"}
                      onClick={() => {
                        if (!sidebarOpen) setSidebarOpen(true);
                        setSearchActive((v) => !v);
                      }}
                      className="h-7 w-7 p-0 text-muted-foreground hover:text-foreground"
                    >
                      <IconSearch className="size-3.5" />
                    </Button>
                  }
                />
                <TooltipContent side="bottom">Search files in repository</TooltipContent>
              </Tooltip>

              {/* Info / Timestamps */}
              <Tooltip>
                <TooltipTrigger className="h-7 w-7 flex items-center justify-center rounded text-muted-foreground hover:text-foreground transition-colors shrink-0">
                  <IconInfoCircle className="size-3.5" />
                </TooltipTrigger>
                <TooltipContent side="bottom">
                  <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-0.5 text-left text-xs">
                    <span className="opacity-70">Repository:</span>
                    <span className="font-mono">{repoName}</span>
                    <span className="opacity-70">Last pulled:</span>
                    <span>{fmtTimestamp(lastPulled)}</span>
                    <span className="opacity-70">Last updated:</span>
                    <span>{fmtTimestamp(lastUpdated)}</span>
                  </div>
                </TooltipContent>
              </Tooltip>

              {/* Change Repo */}
              <Button
                size="sm"
                variant="ghost"
                onClick={handleChangeRepo}
                className="h-7 text-xs gap-1 text-muted-foreground hover:text-foreground px-2"
              >
                <IconX className="size-3.5" />
                <span className="hidden sm:inline">Switch</span>
              </Button>
            </div>
          </div>

          {/* Main Workspace Area */}
          <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
            {/* View Selector (Explorer vs Changes) */}
            <div className="shrink-0 border-b flex items-center bg-muted/20 px-2 select-none">
              <button
                onClick={() => setView("explorer")}
                className={cn(
                  "flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium border-b-2 transition-all cursor-pointer",
                  view === "explorer"
                    ? "border-primary text-foreground font-semibold"
                    : "border-transparent text-muted-foreground hover:text-foreground"
                )}
              >
                <IconFile className="size-3.5" />
                Explorer
              </button>
              <button
                onClick={() => setView("changes")}
                className={cn(
                  "flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium border-b-2 transition-all cursor-pointer",
                  view === "changes"
                    ? "border-primary text-foreground font-semibold"
                    : "border-transparent text-muted-foreground hover:text-foreground"
                )}
              >
                <IconGitCommit className="size-3.5" />
                Changes
              </button>
            </div>

            {/* Explorer View */}
            {view === "explorer" && (
              <div className="flex-1 min-h-0 flex overflow-hidden">
                {treeLoading ? (
                  <div className="flex flex-1 items-center justify-center gap-2 text-muted-foreground">
                    <Spinner className="size-5" />
                    <span className="text-sm font-mono">Loading file tree…</span>
                  </div>
                ) : (
                  <>
                    {/* Tree Panel */}
                    {sidebarOpen && (
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
                                paths.map((p) => ({ path: `repo/${p.replace(/\/$/, "")}`, isDir: p.endsWith("/") }))
                              }
                            />
                          }
                        >
                          <RepoFileTree
                            slot={slot}
                            title={repoName}
                            paths={treePaths}
                            rootPrefix={clonedSlug ?? ""}
                            activePath={activeTab}
                            statusKey={changesPanelRefresh}
                            onFileOpen={handleFileClick}
                          />
                        </FileTreePanel>
                      </div>
                    )}

                    {/* Resize handle */}
                    {sidebarOpen && (
                      <div
                        className="w-1 shrink-0 bg-border/60 hover:bg-primary/50 cursor-col-resize transition-colors"
                        onMouseDown={handleDragStart}
                      />
                    )}

                    {/* Editor panel */}
                    <div className="flex-1 min-w-0 flex flex-col overflow-hidden bg-background">
                      {openTabs.size > 0 ? (
                        <>
                          {/* Tab bar */}
                          <div className="shrink-0 flex items-stretch border-b bg-muted/20 overflow-x-auto select-none">
                            {Array.from(openTabs.entries()).map(([path, tab]) => {
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
                                    "group/tab flex items-center gap-1.5 px-3 py-1.5 border-r text-xs whitespace-nowrap cursor-pointer transition-all",
                                    isActive
                                      ? "border-t-2 border-t-primary bg-background text-foreground font-medium shadow-2xs"
                                      : "border-t-2 border-t-transparent bg-muted/10 text-muted-foreground hover:bg-muted/30 hover:text-foreground"
                                  )}
                                >
                                  <FileIcon name={fileName} className="size-3.5 shrink-0" />
                                  <span className="font-mono text-xs">{fileName}</span>
                                  {tab.loading && <Spinner className="size-3 shrink-0 ml-0.5" />}
                                  <button
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      handleCloseTab(path);
                                    }}
                                    title="Close tab (Esc)"
                                    className="ml-1 rounded p-0.5 text-muted-foreground opacity-60 group-hover/tab:opacity-100 hover:text-foreground hover:bg-accent/60 transition-all"
                                  >
                                    <IconX className="size-3" />
                                  </button>
                                </div>
                              );
                            })}

                            <div className="ml-auto flex items-center shrink-0 pr-1">
                              <Button
                                size="xs"
                                variant="ghost"
                                onClick={() => activeTab && handleCloseOtherTabs(activeTab)}
                                title="Close other tabs"
                                className="h-6 text-[11px] px-2 text-muted-foreground hover:text-foreground"
                              >
                                Close Others
                              </Button>
                              <Button
                                size="xs"
                                variant="ghost"
                                onClick={handleCloseAllTabs}
                                title="Close all tabs"
                                className="h-6 text-[11px] px-2 text-muted-foreground hover:text-foreground"
                              >
                                Close All
                              </Button>
                            </div>
                          </div>

                          {activeTab && activeTabState && (
                            <>
                              {/* Breadcrumbs & File Action Bar */}
                              <div className="shrink-0 px-3 py-1 border-b bg-muted/10 flex items-center justify-between gap-2 select-none">
                                {/* Breadcrumb Path */}
                                <div className="flex items-center gap-1 min-w-0 text-[11px] font-mono text-muted-foreground truncate">
                                  <FileIcon name={activeFileName} className="size-3.5 shrink-0" />
                                  <span className="truncate">{activeTab}</span>

                                  <Tooltip>
                                    <TooltipTrigger
                                      onClick={handleCopyBreadcrumbPath}
                                      className="p-0.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors shrink-0"
                                    >
                                      {copiedBreadcrumb ? (
                                        <IconCheck className="size-3 text-emerald-500" />
                                      ) : (
                                        <IconCopy className="size-3" />
                                      )}
                                    </TooltipTrigger>
                                    <TooltipContent side="bottom">Copy relative path</TooltipContent>
                                  </Tooltip>
                                </div>

                                {/* Editor Action Buttons */}
                                <div className="flex items-center gap-1 shrink-0 text-xs">
                                  <Button
                                    size="xs"
                                    variant="ghost"
                                    onClick={pinFile}
                                    disabled={!activeTabState?.content}
                                    className="h-6 w-6 p-0 text-muted-foreground hover:text-foreground"
                                    title="Add to chat"
                                    aria-label="Add file to chat"
                                  >
                                    <IconMessagePlus className="size-3.5" />
                                  </Button>
                                  {activeLang && (
                                    <Badge
                                      variant="secondary"
                                      className="text-[10px] uppercase font-mono px-1.5 py-0 h-4"
                                    >
                                      {activeLang}
                                    </Badge>
                                  )}

                                  {activeLineCount > 0 && (
                                    <span className="text-[10px] text-muted-foreground font-mono hidden md:inline px-1">
                                      {activeLineCount} lines
                                    </span>
                                  )}

                                  <Tooltip>
                                    <TooltipTrigger
                                      render={
                                        <Button
                                          size="xs"
                                          variant={wordWrap === "on" ? "secondary" : "ghost"}
                                          onClick={() => setWordWrap((w) => (w === "on" ? "off" : "on"))}
                                          className="h-6 w-6 p-0 text-muted-foreground hover:text-foreground"
                                        >
                                          <IconTextWrap className="size-3.5" />
                                        </Button>
                                      }
                                    />
                                    <TooltipContent side="bottom">Toggle Word Wrap</TooltipContent>
                                  </Tooltip>

                                  <Tooltip>
                                    <TooltipTrigger
                                      render={
                                        <Button
                                          size="xs"
                                          variant={minimapEnabled ? "secondary" : "ghost"}
                                          onClick={() => setMinimapEnabled((m) => !m)}
                                          className="h-6 w-6 p-0 text-muted-foreground hover:text-foreground"
                                        >
                                          <IconMap className="size-3.5" />
                                        </Button>
                                      }
                                    />
                                    <TooltipContent side="bottom">Toggle Minimap</TooltipContent>
                                  </Tooltip>

                                  <Tooltip>
                                    <TooltipTrigger
                                      render={
                                        <Button
                                          size="xs"
                                          variant="ghost"
                                          onClick={handleCopyContent}
                                          className="h-6 w-6 p-0 text-muted-foreground hover:text-foreground"
                                        >
                                          {copiedContent ? (
                                            <IconCheck className="size-3 text-emerald-500" />
                                          ) : (
                                            <IconCopy className="size-3.5" />
                                          )}
                                        </Button>
                                      }
                                    />
                                    <TooltipContent side="bottom">Copy file content</TooltipContent>
                                  </Tooltip>

                                  <Tooltip>
                                    <TooltipTrigger
                                      render={
                                        <Button
                                          size="xs"
                                          variant="ghost"
                                          onClick={handleDownloadFile}
                                          className="h-6 w-6 p-0 text-muted-foreground hover:text-foreground"
                                        >
                                          <IconDownload className="size-3.5" />
                                        </Button>
                                      }
                                    />
                                    <TooltipContent side="bottom">Download file</TooltipContent>
                                  </Tooltip>
                                </div>
                              </div>

                              {/* Editor Canvas */}
                              <div className="flex-1 min-h-0">
                                {activeTabState.loading ? (
                                  <div className="flex items-center justify-center h-full gap-2 text-muted-foreground">
                                    <Spinner className="size-5" />
                                    <span className="text-xs font-mono">Loading content…</span>
                                  </div>
                                ) : activeTabState.error ? (
                                  <div className="p-6">
                                    <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-xs text-destructive">
                                      <p className="font-medium">Failed to read file content</p>
                                      <p className="mt-1 font-mono">{activeTabState.error}</p>
                                    </div>
                                  </div>
                                ) : (
                                  <MonacoEditor
                                    key={activeTab}
                                    height="100%"
                                    language={activeLang}
                                    value={activeTabState.content ?? ""}
                                    theme={resolvedTheme === "dark" ? "vs-dark" : "vs"}
                                    options={{
                                      readOnly: true,
                                      minimap: { enabled: minimapEnabled },
                                      scrollBeyondLastLine: false,
                                      wordWrap: wordWrap,
                                      fontSize: 13,
                                      lineNumbers: "on",
                                      folding: true,
                                      renderLineHighlight: "line",
                                      automaticLayout: true,
                                      contextmenu: true,
                                    }}
                                    onMount={(ed) => {
                                      editorRef.current = ed;
                                      const file = activeTab;
                                      ed.onDidChangeCursorSelection(() => {
                                        const sel = ed.getSelection();
                                        const model = ed.getModel();
                                        if (!sel || !model || sel.isEmpty()) return setCodeSel(null);
                                        setCodeSel({
                                          file: file ?? "",
                                          range: `${sel.startLineNumber}:${sel.startColumn}-${sel.endLineNumber}:${sel.endColumn}`,
                                          text: model.getValueInRange(sel).slice(0, 4000),
                                        });
                                      });
                                      const jump = pendingJumpRef.current;
                                      if (jump) {
                                        pendingJumpRef.current = null;
                                        setTimeout(() => {
                                          ed.revealLineInCenter(jump.line);
                                          ed.setPosition({
                                            lineNumber: jump.line,
                                            column: jump.col,
                                          });
                                          ed.focus();
                                        }, 50);
                                      }
                                    }}
                                  />
                                )}
                              </div>
                            </>
                          )}
                        </>
                      ) : (
                        /* Empty state when no tabs are open */
                        <div className="flex flex-col items-center justify-center h-full text-muted-foreground gap-3 p-6 text-center">
                          <div className="size-12 rounded-2xl bg-muted/40 border flex items-center justify-center">
                            <IconCode className="size-6 opacity-40" />
                          </div>
                          <div>
                            <p className="text-sm font-medium text-foreground">No file open</p>
                            <p className="text-xs text-muted-foreground mt-0.5">
                              Select a file from the explorer sidebar to view and inspect
                            </p>
                          </div>
                          <div className="flex items-center gap-2 mt-2">
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => {
                                if (!sidebarOpen) setSidebarOpen(true);
                                setSearchActive(true);
                              }}
                              className="h-8 text-xs gap-1.5"
                            >
                              <IconSearch className="size-3.5" />
                              Search in Files
                            </Button>
                          </div>
                        </div>
                      )}
                    </div>
                  </>
                )}
              </div>
            )}

            {/* Changes View */}
            {view === "changes" && <ChangesPanel slot={slot} refreshTrigger={changesPanelRefresh} />}
          </div>
        </>
      )}

      {/* ── Console Output Drawer ─────────────────────────────────────────── */}
      <RepoOutputDrawer
        title={consoleTitle}
        status={consoleStatus}
        runningLabel={consoleRunningLabel}
        messages={consoleMessages}
        onClear={() => clearJob(REPO_JOB)}
        isOpen={consoleOpen}
        onToggleOpen={() => setConsoleOpen((v) => !v)}
      />
    </div>
  );
}
