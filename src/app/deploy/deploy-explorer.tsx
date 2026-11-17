"use client";

// Ported from singl-web's /deploy page. The /api/twx/* and /api/twx-cli/* routes
// are Tauri commands (src/lib/twx.ts); their log lines stream over a Channel
// instead of SSE and each command resolves with its result. Relative paths
// resolve against the workspace folder.

import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { useAssistantContext } from "@/lib/assistant/context";
import {
  IconCloudDownload,
  IconArchive,
  IconPackage,
  IconLoader2,
  IconPlayerPlay,
  IconCheck,
  IconCopy,
  IconTrash,
  IconSearch,
  IconArrowRight,
  IconClock,
  IconTerminal2,
  IconMessagePlus,
  IconLayersLinked,
  IconCircleCheck,
  IconSparkles,
  IconChevronRight,
  IconCloudUpload,
  IconPlugConnected,
  IconDatabaseExport,
  IconAlertTriangle,
} from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { toast } from "sonner";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
} from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { PathInput } from "@/components/path-input";
import { RepoDirBrowser } from "@/components/repo-dir-browser";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { errorMessage } from "@/lib/settings";
import { appendJobLog, clearJob, isJobRunning, runJob, useJob, type JobLine } from "@/lib/background-jobs";
import { addPins, usePinnables, type NewPin } from "@/lib/assistant/pins";
import {
  backupDeploymentFiles,
  bundleProjects as runBundle,
  exportDeploymentFiles,
  extractDeploymentFiles,
  listConnectors,
  updateConnectors,
  uploadDeploymentFiles,
  type BundleResult,
  type ConnectorInfo,
  type ConnectorUpdate,
  type ConnectorUpdateResult,
  type DeploymentBackupResult,
  type DeploymentExportResult,
  type DeploymentExtractResult,
  type DeploymentUploadResult,
} from "@/lib/twx";
import { PIN_LIMIT } from "@/lib/assistant/pin-utils";

/** A project as the deployment pipeline sees it, configured in Settings. */
export interface DeployProject {
  /** Folder / ZIP name used by export and extract, e.g. "ITCI_CHBUtils". */
  key: string;
  /** WindchillClients folder the project lives under, e.g. "InheritanceApp". */
  alias: string;
  /** ThingWorx project name, e.g. "ITCI.CHBUtils". */
  projectName: string;
}

interface BundleProject {
  alias: string;
  projectName: string;
}

interface DeployExplorerProps {
  envs: string[];
  /** Projects of all enabled environments, one per key. */
  projects: DeployProject[];
  projectsByEnv: Record<string, DeployProject[]>;
  bundleProjects: BundleProject[];
  bundleSrcDir: string;
  bundleDestDir: string;
  /** Folder pickers write picks inside it as "./sub/path". */
  workspaceRoot: string;
}

type TabType = "export" | "extract" | "configs" | "bundle" | "backup" | "upload";

const ORIGIN_RE = /^https?:\/\/[A-Za-z0-9.-]+(?::\d+)?$/;

/** Key of one connector's URL row: its file plus the old origin. */
function urlKey(relPath: string, origin: string): string {
  return `${relPath}|${origin}`;
}

// ── "Add to chat" helpers ────────────────────────────────────────────────────


interface LogEntry {
  id: string;
  timestamp: string;
  text: string;
  kind: "info" | "done" | "error" | "dryrun";
}

const ALL_PROJECTS = "__all__";

function formatCurrentTimestamp(): string {
  const date = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(
    date.getHours()
  )}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

/** "Deploy\\RC1/" → "/Deploy/RC1"; empty → "/". Matches the server's normalization. */
function normalizeRepoDir(dir: string): string {
  return `/${dir.replace(/\\/g, "/").split("/").filter(Boolean).join("/")}`;
}

function classifyMessage(msg: string): LogEntry["kind"] {
  if (msg.startsWith("[DONE]")) return "done";
  if (msg.startsWith("[ERROR]")) return "error";
  if (msg.includes("(dry-run)")) return "dryrun";
  return "info";
}

function logEntries(log: JobLine[]): LogEntry[] {
  return log.map((l, i) => ({
    id: String(i),
    timestamp: new Date(l.at).toLocaleTimeString("en-US", { hour12: false }),
    text: l.text,
    kind: classifyMessage(l.text),
  }));
}

const TABS: TabType[] = ["export", "extract", "configs", "bundle", "backup", "upload"];
/** Background-job key of a stage (see @/lib/background-jobs); the run outlives this page. */
const stageJob = (tab: TabType) => `deploy:${tab}`;

/**
 * Runs one stage's command as a background job: clears its console, streams log
 * lines into it, and keeps the result for the summary card. Toasts double as
 * native notifications.
 */
async function runStage<T extends { errors: string[] }>(
  tab: TabType,
  label: string,
  run: (onLine: (line: string) => void) => Promise<T>,
  summary: (result: NoInfer<T>) => string
) {
  const key = stageJob(tab);
  const r = await runJob<T>(key, run);
  if (!r) return;
  if (r.ok) {
    appendJobLog(key, `[DONE] ${summary(r.result)}`);
    if (r.result.errors.length > 0) {
      toast.warning(`${label} finished with ${r.result.errors.length} error(s)`, { description: summary(r.result) });
    } else {
      toast.success(`${label} complete`, { description: summary(r.result) });
    }
  } else {
    appendJobLog(key, `[ERROR] ${r.error}`);
    toast.error(`${label} failed`, { description: r.error });
  }
}

/** A stage's job: running flag, console entries and last good result. */
function useStage<T>(tab: TabType) {
  const job = useJob<unknown, T>(stageJob(tab));
  const log = useMemo(() => logEntries(job.log), [job.log]);
  return { running: job.status === "running", log, result: job.status === "done" ? job.result ?? null : null };
}

interface UploadPreview {
  loading: boolean;
  lines: string[];
  result: DeploymentUploadResult | null;
  error: string | null;
}

export function DeployExplorer({
  envs,
  projects,
  projectsByEnv,
  bundleProjects,
  bundleSrcDir,
  bundleDestDir,
  workspaceRoot,
}: DeployExplorerProps) {
  // Active Tab
  // Back on this page mid-run: open the running stage.
  const [activeTab, setActiveTab] = useState<TabType>(
    () => TABS.find((t) => isJobRunning(stageJob(t))) ?? "export"
  );

  // Stage 1: Export state
  const [exportEnv, setExportEnv] = useState("");
  const [exportParent, setExportParent] = useState("");
  const [exportSuffix, setExportSuffix] = useState("");
  const [exportProject, setExportProject] = useState(ALL_PROJECTS);
  // Export pulls from one server, so offer only the projects configured for it.
  const exportProjects = exportEnv ? projectsByEnv[exportEnv] ?? [] : projects;
  const [exportDryRun, setExportDryRun] = useState(false);
  const { running: exportRunning, log: exportLog, result: exportResult } = useStage<DeploymentExportResult>("export");

  // Stage 2: Extract state
  const [extractInput, setExtractInput] = useState("");
  const [extractOutput, setExtractOutput] = useState("./WindchillClients/ThingWorx");
  const [extractProject, setExtractProject] = useState(ALL_PROJECTS);
  const [extractDryRun, setExtractDryRun] = useState(false);
  const { running: extractRunning, log: extractLog, result: extractResult } = useStage<DeploymentExtractResult>("extract");

  // Stage 3: Update Configs state
  const [configSource, setConfigSource] = useState(bundleSrcDir);
  // Destination follows the source (update in place) until the user picks another folder.
  const [configDestOverride, setConfigDestOverride] = useState<string | null>(null);
  const configDest = configDestOverride ?? configSource;
  const configInPlace = configDest.trim() === configSource.trim();
  const [connectors, setConnectors] = useState<ConnectorInfo[]>([]);
  const [connectorsScanned, setConnectorsScanned] = useState(false);
  const [connectorsLoading, setConnectorsLoading] = useState(false);
  const [connectorsError, setConnectorsError] = useState<string | null>(null);
  // New origin per old origin, applied to every connector using it…
  const [globalUrlMap, setGlobalUrlMap] = useState<Record<string, string>>({});
  // …unless a connector row overrides it.
  const [urlOverrides, setUrlOverrides] = useState<Record<string, string>>({});
  // New AuthUsername per connector file; absent means unchanged.
  const [usernameInputs, setUsernameInputs] = useState<Record<string, string>>({});
  const [configCleanDest, setConfigCleanDest] = useState(false);
  const [configDryRun, setConfigDryRun] = useState(false);
  const { running: configRunning, log: configLog, result: configResult } = useStage<ConnectorUpdateResult>("configs");
  const [configConfirmOpen, setConfigConfirmOpen] = useState(false);

  // Stage 4: Bundle state
  const [bundleSrc, setBundleSrc] = useState(bundleSrcDir);
  const [bundleDest, setBundleDest] = useState(bundleDestDir);
  const [bundleProject, setBundleProject] = useState(ALL_PROJECTS);
  const [bundleDryRun, setBundleDryRun] = useState(false);
  const { running: bundleRunning, log: bundleLog, result: bundleResult } = useStage<BundleResult>("bundle");

  // Stage 5: Backup state
  const [backupEnv, setBackupEnv] = useState("");
  const [backupParent, setBackupParent] = useState("");
  const [backupSuffix, setBackupSuffix] = useState("");
  const [backupProject, setBackupProject] = useState(ALL_PROJECTS);
  const [backupZip, setBackupZip] = useState(false);
  const [backupDryRun, setBackupDryRun] = useState(false);
  const { running: backupRunning, log: backupLog, result: backupResult } = useStage<DeploymentBackupResult>("backup");
  // Backs up the server being deployed to, so offer only its projects.
  const backupProjects = backupEnv ? projectsByEnv[backupEnv] ?? [] : projects;

  // Stage 6: Upload state
  const [uploadEnv, setUploadEnv] = useState("");
  const [uploadSource, setUploadSource] = useState("");
  const [uploadDir, setUploadDir] = useState("");
  const [uploadExtract, setUploadExtract] = useState(true);
  const [uploadSubfolder, setUploadSubfolder] = useState(false);
  const [uploadDeleteZip, setUploadDeleteZip] = useState(false);
  const [uploadDryRun, setUploadDryRun] = useState(false);
  const { running: uploadRunning, log: uploadLog, result: uploadResult } = useStage<DeploymentUploadResult>("upload");
  const [uploadPreview, setUploadPreview] = useState<UploadPreview>({
    loading: false,
    lines: [],
    result: null,
    error: null,
  });

  // Console tools state
  const [searchQuery, setSearchQuery] = useState("");

  useAssistantContext({
    screen: "deploy",
    title: "Deploy",
    summary: `${activeTab} stage open`,
    data: {
      stage: activeTab,
      export: { env: exportEnv, project: exportProject, dryRun: exportDryRun },
      extract: { project: extractProject, dryRun: extractDryRun },
      backup: { env: backupEnv, project: backupProject, dryRun: backupDryRun },
      upload: { env: uploadEnv, source: uploadSource, dryRun: uploadDryRun },
      bundle: { project: bundleProject, dryRun: bundleDryRun },
    },
  });
  const [autoScroll] = useState(true);
  const [copiedLog, setCopiedLog] = useState(false);
  const logContainerRef = useRef<HTMLDivElement>(null);

  // Determine current active logs & running status
  const currentLogs = useMemo(() => {
    switch (activeTab) {
      case "export":
        return exportLog;
      case "extract":
        return extractLog;
      case "configs":
        return configLog;
      case "bundle":
        return bundleLog;
      case "backup":
        return backupLog;
      case "upload":
        return uploadLog;
    }
  }, [activeTab, exportLog, extractLog, configLog, bundleLog, backupLog, uploadLog]);

  const currentRunning = useMemo(() => {
    switch (activeTab) {
      case "export":
        return exportRunning;
      case "extract":
        return extractRunning;
      case "configs":
        return configRunning;
      case "bundle":
        return bundleRunning;
      case "backup":
        return backupRunning;
      case "upload":
        return uploadRunning;
    }
  }, [activeTab, exportRunning, extractRunning, configRunning, bundleRunning, backupRunning, uploadRunning]);

  // Filtered log lines based on search query
  const filteredLogs = useMemo(() => {
    if (!searchQuery.trim()) return currentLogs;
    const q = searchQuery.toLowerCase();
    return currentLogs.filter((e) => e.text.toLowerCase().includes(q));
  }, [currentLogs, searchQuery]);

  // Auto-scroll handler
  useEffect(() => {
    if (autoScroll && logContainerRef.current) {
      logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
    }
  }, [currentLogs, autoScroll]);

  const scanConnectors = useCallback(async (source: string) => {
    if (!source.trim()) return;
    setConnectorsLoading(true);
    setConnectorsError(null);
    try {
      setConnectors(await listConnectors(source.trim()));
      setUrlOverrides({});
      setUsernameInputs({});
    } catch (err) {
      setConnectors([]);
      setConnectorsError(errorMessage(err));
    } finally {
      setConnectorsScanned(true);
      setConnectorsLoading(false);
    }
  }, []);

  // Distinct old origins across all connectors, with how many connectors use each.
  const connectorOrigins = useMemo(() => {
    const counts = new Map<string, number>();
    for (const c of connectors) {
      for (const u of c.urls) counts.set(u.origin, (counts.get(u.origin) ?? 0) + 1);
    }
    return [...counts].map(([origin, count]) => ({ origin, count }));
  }, [connectors]);

  const effectiveUrl = useCallback(
    (relPath: string, origin: string) =>
      (urlOverrides[urlKey(relPath, origin)] ?? globalUrlMap[origin] ?? "").trim(),
    [urlOverrides, globalUrlMap]
  );

  // Changes the run will make, connector by connector — also the confirmation preview.
  const configPlan = useMemo(() => {
    return connectors
      .map((c) => {
        const urlChanges = c.urls
          .map((u) => ({ from: u.origin, to: effectiveUrl(c.relPath, u.origin), occurrences: u.occurrences }))
          .filter((u) => u.to && u.to !== u.from);
        const newUsername = usernameInputs[c.relPath];
        const usernameChange =
          c.username !== null && newUsername !== undefined && newUsername.trim() !== c.username
            ? newUsername.trim()
            : null;
        return { connector: c, urlChanges, usernameChange };
      })
      .filter((p) => p.urlChanges.length > 0 || p.usernameChange !== null);
  }, [connectors, effectiveUrl, usernameInputs]);

  const invalidUrls = useMemo(
    () => configPlan.flatMap((p) => p.urlChanges.filter((u) => !ORIGIN_RE.test(u.to)).map((u) => u.to)),
    [configPlan]
  );

  const handleConfigUpdate = useCallback(async () => {
    setConfigConfirmOpen(false);
    const updates: ConnectorUpdate[] = configPlan.map((p) => ({
      relPath: p.connector.relPath,
      urlMap: Object.fromEntries(p.urlChanges.map((u) => [u.from, u.to])),
      username: p.usernameChange,
    }));
    await runStage(
      "configs",
      "Connector update",
      (onLine) =>
        updateConnectors(
          {
            source: configSource.trim(),
            dest: configDest.trim(),
            updates,
            cleanDest: configCleanDest && !configInPlace,
            dryRun: configDryRun,
          },
          onLine
        ),
      (r) => `${r.connectorsUpdated} of ${r.connectorsFound} connectors updated, ${r.urlsReplaced} URL(s) replaced`
    );
  }, [configPlan, configSource, configDest, configInPlace, configCleanDest, configDryRun]);

  const handleBackup = useCallback(async () => {
    await runStage(
      "backup",
      "Backup",
      (onLine) =>
        backupDeploymentFiles(
          {
            env: backupEnv,
            parent: backupParent.trim(),
            suffix: backupSuffix.trim() || undefined,
            project: backupProject === ALL_PROJECTS ? undefined : backupProject,
            format: backupZip ? "zip" : "entities",
            dryRun: backupDryRun,
          },
          onLine
        ),
      (r) => `${r.projectsBackedUp} of ${r.projectsProcessed} projects backed up to SystemRepository${r.backupDir}`
    );
  }, [backupEnv, backupParent, backupSuffix, backupProject, backupZip, backupDryRun]);

  // Execution Handlers
  const handleExport = useCallback(async () => {
    await runStage(
      "export",
      "Export",
      (onLine) =>
        exportDeploymentFiles(
          {
            env: exportEnv,
            parent: exportParent.trim() || undefined,
            suffix: exportSuffix.trim() || undefined,
            project: exportProject === ALL_PROJECTS ? undefined : exportProject,
            dryRun: exportDryRun,
          },
          onLine
        ),
      (r) => `${r.zipsSaved} ZIP(s) saved from ${r.projectsProcessed} project(s)`
    );
  }, [exportEnv, exportParent, exportSuffix, exportProject, exportDryRun]);

  const handleExtract = useCallback(async () => {
    await runStage(
      "extract",
      "Extract",
      (onLine) =>
        extractDeploymentFiles(
          {
            input: extractInput.trim() || undefined,
            output: extractOutput.trim() || undefined,
            project: extractProject === ALL_PROJECTS ? undefined : extractProject,
            dryRun: extractDryRun,
          },
          onLine
        ),
      (r) => `${r.entitiesExtracted} entities extracted from ${r.zipFilesProcessed} ZIP(s)`
    );
  }, [extractInput, extractOutput, extractProject, extractDryRun]);

  const handleBundle = useCallback(async () => {
    await runStage(
      "bundle",
      "Bundle",
      (onLine) =>
        runBundle(
          {
            src: bundleSrc.trim() || undefined,
            dest: bundleDest.trim() || undefined,
            project: bundleProject === ALL_PROJECTS ? undefined : bundleProject,
            dryRun: bundleDryRun,
          },
          onLine
        ),
      (r) => `${r.zipsCreated} bundle(s) created from ${r.projectsProcessed} project(s)`
    );
  }, [bundleSrc, bundleDest, bundleProject, bundleDryRun]);

  const uploadArgs = useMemo(
    () => ({
      env: uploadEnv,
      source: uploadSource.trim(),
      target: uploadDir.trim(),
      extract: uploadExtract,
      extractSubfolder: uploadExtract && uploadSubfolder,
      deleteZip: uploadExtract && uploadDeleteZip,
    }),
    [uploadEnv, uploadSource, uploadDir, uploadExtract, uploadSubfolder, uploadDeleteZip]
  );

  const [uploadConfirmOpen, setUploadConfirmOpen] = useState(false);

  // What the upload will do, file by file: a dry run shown for confirmation before running.
  const handleUploadPreview = useCallback(async () => {
    setUploadConfirmOpen(true);
    setUploadPreview({ loading: true, lines: [], result: null, error: null });
    const lines: string[] = [];
    try {
      const result = await uploadDeploymentFiles({ ...uploadArgs, dryRun: true }, (line) => lines.push(line));
      setUploadPreview({ loading: false, lines, result, error: null });
    } catch (err) {
      setUploadPreview({ loading: false, lines, result: null, error: errorMessage(err) });
    }
  }, [uploadArgs]);

  const handleUpload = useCallback(async () => {
    setUploadConfirmOpen(false);
    await runStage(
      "upload",
      "Upload",
      (onLine) => uploadDeploymentFiles({ ...uploadArgs, dryRun: uploadDryRun }, onLine),
      (r) => `${r.filesUploaded} file(s) uploaded, ${r.zipsExtracted} ZIP(s) extracted to SystemRepository${r.targetDir}`
    );
  }, [uploadArgs, uploadDryRun]);

  // Picking a source suggests a same-named repository folder, mirroring Export's layout.
  const handleUploadSourceSelect = useCallback((dir: string) => {
    setUploadSource(dir);
    const base = dir.replace(/\\/g, "/").split("/").filter((s) => s && s !== ".").pop();
    if (base) setUploadDir((prev) => prev.trim() || `/${base}`);
  }, []);

  // Copy Logs
  const handleCopyLogs = useCallback(() => {
    const text = currentLogs.map((l) => `[${l.timestamp}] ${l.text}`).join("\n");
    navigator.clipboard.writeText(text);
    setCopiedLog(true);
    toast.success("Logs copied to clipboard");
    setTimeout(() => setCopiedLog(false), 2000);
  }, [currentLogs]);

  // Clear current active logs
  const handleClearLogs = useCallback(() => clearJob(stageJob(activeTab)), [activeTab]);

  // ── Add to chat: the pipeline settings (plus configs plan) and the console log
  const planPin = (): NewPin => ({
    kind: "deploy",
    label: "Deploy plan",
    screen: "deploy",
    detail: `${activeTab} stage open`,
    content: JSON.stringify(
      {
        stage: activeTab,
        export: { env: exportEnv, parent: exportParent, suffix: exportSuffix, project: exportProject, dryRun: exportDryRun },
        extract: { input: extractInput, output: extractOutput, project: extractProject, dryRun: extractDryRun },
        configs: {
          source: configSource,
          dest: configDest,
          inPlace: configInPlace,
          cleanDest: configCleanDest,
          dryRun: configDryRun,
          connectorChanges: configPlan.map((p) => ({
            connector: p.connector.relPath,
            urlChanges: p.urlChanges.map((u) => ({ from: u.from, to: u.to })),
            usernameChange: p.usernameChange,
          })),
        },
        bundle: { src: bundleSrc, dest: bundleDest, project: bundleProject, dryRun: bundleDryRun },
        backup: { env: backupEnv, parent: backupParent, suffix: backupSuffix, project: backupProject, zip: backupZip, dryRun: backupDryRun },
        upload: { env: uploadEnv, source: uploadSource, dir: uploadDir, extract: uploadExtract, subfolder: uploadSubfolder, deleteZip: uploadDeleteZip, dryRun: uploadDryRun },
      },
      null,
      2
    ),
  });

  const logPin = (): NewPin | null => {
    if (!currentLogs.length) return null;
    // The tail is the part that matters: the end of a run, errors included.
    const text = currentLogs.map((l) => `[${l.timestamp}] ${l.text}`).join("\n");
    return {
      kind: "log",
      label: `Log · ${activeTab}`,
      screen: "deploy",
      detail: `${currentLogs.length} lines`,
      content: text.length > PIN_LIMIT ? `… (${text.length - PIN_LIMIT} earlier characters)\n${text.slice(-PIN_LIMIT)}` : text,
    };
  };

  const pinPlan = () => addPins([planPin()]);
  const pinLog = () => {
    const p = logPin();
    if (p) addPins([p]);
  };

  usePinnables([
    { kind: "deploy", label: "Deploy plan", detail: `${activeTab} stage open`, content: () => planPin().content },
    ...(currentLogs.length
      ? [{ kind: "log", label: `Log · ${activeTab}`, detail: `${currentLogs.length} lines`, content: () => logPin()?.content ?? "" }]
      : []),
  ]);

  // Pipeline Handoff Handlers
  const handleHandoffToExtract = useCallback((folderPath?: string) => {
    if (folderPath) {
      setExtractInput(folderPath);
    }
    setActiveTab("extract");
  }, []);

  const handleHandoffToConfigs = useCallback(() => {
    if (extractOutput.trim()) setConfigSource(extractOutput.trim());
    setActiveTab("configs");
  }, [extractOutput]);

  // Bundle the updated copy, not the original extract.
  const handleHandoffToBundle = useCallback(() => {
    if (configDest.trim()) setBundleSrc(configDest.trim());
    setActiveTab("bundle");
  }, [configDest]);

  const stages = [
    {
      id: "export" as TabType,
      number: "1",
      name: "Export",
      subtitle: "Pull from TWX Server",
      icon: IconCloudDownload,
      isRunning: exportRunning,
      hasResult: !!exportResult,
    },
    {
      id: "extract" as TabType,
      number: "2",
      name: "Extract",
      subtitle: "Unpack to WindchillClients",
      icon: IconArchive,
      isRunning: extractRunning,
      hasResult: !!extractResult,
    },
    {
      id: "configs" as TabType,
      number: "3",
      name: "Update Configs",
      subtitle: "Connector URLs & creds",
      icon: IconPlugConnected,
      isRunning: configRunning,
      hasResult: !!configResult,
    },
    {
      id: "bundle" as TabType,
      number: "4",
      name: "Bundle",
      subtitle: "Create Release ZIPs",
      icon: IconPackage,
      isRunning: bundleRunning,
      hasResult: !!bundleResult,
    },
    {
      id: "backup" as TabType,
      number: "5",
      name: "Backup",
      subtitle: "Snapshot target server",
      icon: IconDatabaseExport,
      isRunning: backupRunning,
      hasResult: !!backupResult,
    },
    {
      id: "upload" as TabType,
      number: "6",
      name: "Upload",
      subtitle: "Push to SystemRepository",
      icon: IconCloudUpload,
      isRunning: uploadRunning,
      hasResult: !!uploadResult,
    },
  ];

  return (
    <TooltipProvider>
      <div className="flex flex-col flex-1 h-full overflow-y-auto bg-background/50">
        <div className="w-full max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-3.5 space-y-3">
          {/* Header */}
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 pb-2 border-b border-border/40">
            <div className="flex items-center gap-2.5">
              <div className="p-1.5 rounded-lg bg-primary/10 text-primary border border-primary/20 shrink-0">
                <IconLayersLinked className="size-4" />
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <h1 className="text-sm font-semibold tracking-tight font-heading leading-none">
                    Deployment Pipeline
                  </h1>
                  <Badge variant="outline" className="text-[9px] font-mono py-0 h-4 font-normal">
                    ThingWorx CCD
                  </Badge>
                </div>
                <p className="text-[11px] text-muted-foreground mt-0.5 leading-tight">
                  Export from ThingWorx, unpack formatted XML into source control, package deployable bundles, and upload them to a SystemRepository.
                </p>
              </div>
            </div>

            <div className="flex items-center gap-1.5 shrink-0">
              <Button
                variant="outline"
                size="xs"
                className="h-6 w-6 p-0"
                onClick={pinPlan}
                title="Add to chat"
                aria-label="Add deploy plan to chat"
              >
                <IconMessagePlus className="size-3.5" />
              </Button>
              <Badge variant="secondary" className="text-[10px] font-normal py-0 h-5">
                {projects.length} projects
              </Badge>
              <Badge variant="outline" className="text-[10px] font-normal py-0 h-5">
                {envs.length} configured envs
              </Badge>
            </div>
          </div>

          {/* Pipeline Stepper Navigation */}
          <div className="grid grid-cols-1 sm:grid-cols-3 lg:grid-cols-6 gap-2.5">
            {stages.map((stage, idx) => {
              const Icon = stage.icon;
              const isActive = activeTab === stage.id;
              return (
                <button
                  key={stage.id}
                  type="button"
                  onClick={() => setActiveTab(stage.id)}
                  className={cn(
                    "relative flex items-center gap-3 p-2.5 rounded-lg border text-left transition-all cursor-pointer group",
                    isActive
                      ? "bg-card border-primary/40 shadow-xs ring-1 ring-primary/20"
                      : "bg-card/40 border-border/60 hover:bg-card/80 hover:border-border"
                  )}
                >
                  <div
                    className={cn(
                      "flex items-center justify-center size-8 rounded-md shrink-0 transition-colors",
                      isActive
                        ? "bg-primary text-primary-foreground font-semibold"
                        : "bg-muted text-muted-foreground group-hover:text-foreground group-hover:bg-muted/80"
                    )}
                  >
                    {stage.isRunning ? (
                      <IconLoader2 className="size-3.5 animate-spin" />
                    ) : stage.hasResult ? (
                      <IconCircleCheck className="size-3.5 text-green-500 dark:text-green-400" />
                    ) : (
                      <Icon className="size-3.5" />
                    )}
                  </div>

                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-1 leading-none">
                      <span className="text-[10px] font-mono text-muted-foreground font-medium uppercase tracking-wider">
                        Stage {stage.number}
                      </span>
                      {stage.isRunning && (
                        <Badge
                          variant="secondary"
                          className="text-[9px] px-1 py-0 h-4 bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/20"
                        >
                          Running
                        </Badge>
                      )}
                      {!stage.isRunning && stage.hasResult && (
                        <Badge
                          variant="secondary"
                          className="text-[9px] px-1 py-0 h-4 bg-green-500/10 text-green-600 dark:text-green-400 border border-green-500/20"
                        >
                          Ready
                        </Badge>
                      )}
                    </div>
                    <div className="font-medium text-xs text-foreground mt-0.5 leading-snug">
                      {stage.name}
                    </div>
                    <div className="text-[10px] text-muted-foreground truncate leading-none mt-0.5">
                      {stage.subtitle}
                    </div>
                  </div>

                  {idx < stages.length - 1 && (
                    <div className="hidden lg:flex absolute -right-2 top-1/2 -translate-y-1/2 z-10 size-3.5 rounded-full bg-border items-center justify-center pointer-events-none">
                      <IconChevronRight className="size-2.5 text-muted-foreground" />
                    </div>
                  )}
                </button>
              );
            })}
          </div>

          {/* Main Workspace Area (2 Columns) */}
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-3.5 items-start">
            {/* Left Column: Stage Configuration Card */}
            <div className="lg:col-span-6 space-y-3">
              {/* STAGE 1: EXPORT */}
              {activeTab === "export" && (
                <Card className="border-border/60 shadow-xs gap-0 py-0">
                  <CardHeader className="border-b border-border/40 py-2.5 px-3.5">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-1.5">
                        <IconCloudDownload className="size-3.5 text-primary" />
                        <CardTitle className="text-xs font-semibold">Stage 1: Export from ThingWorx</CardTitle>
                      </div>
                      <Badge variant="outline" className="text-[9px] font-mono py-0 h-4">
                        export-deploymentfiles
                      </Badge>
                    </div>
                    <CardDescription className="text-[11px] text-muted-foreground">
                      Export ThingWorx project ZIP packages into the local export destination folder.
                    </CardDescription>
                  </CardHeader>

                  <CardContent className="space-y-2.5 p-3.5">
                    {/* Environment */}
                    <div className="space-y-1">
                      <div className="flex items-center justify-between">
                        <Label className="text-[11px] font-medium">
                          Environment <span className="text-destructive">*</span>
                        </Label>
                        <span className="text-[10px] text-muted-foreground font-mono">--env</span>
                      </div>
                      <Select
                        value={exportEnv}
                        onValueChange={(v) => {
                          const env = v ?? "";
                          setExportEnv(env);
                          const available = env ? projectsByEnv[env] ?? [] : projects;
                          if (!available.some((p) => p.key === exportProject)) {
                            setExportProject(ALL_PROJECTS);
                          }
                        }}
                        disabled={exportRunning}
                      >
                        <SelectTrigger className="h-8 text-xs">
                          <SelectValue placeholder="Choose an environment" />
                        </SelectTrigger>
                        <SelectContent>
                          {envs.map((e) => (
                            <SelectItem key={e} value={e}>
                              <span className="font-medium text-xs">{e}</span>
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <p className="text-[10px] text-muted-foreground leading-tight">
                        Loads API URL and AppKey configured in Settings for this environment.
                      </p>
                    </div>

                    {/* Parent Directory */}
                    <div className="space-y-1">
                      <div className="flex items-center justify-between">
                        <Label className="text-[11px] font-medium">Parent Directory Name</Label>
                        <span className="text-[10px] text-muted-foreground font-mono">--parent</span>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <Input
                          className="h-8 text-xs font-mono"
                          placeholder="Auto timestamp (YYYYMMDD-HHmmss)"
                          value={exportParent}
                          onChange={(e) => setExportParent(e.target.value)}
                          disabled={exportRunning}
                        />
                        <Tooltip>
                          <TooltipTrigger
                            render={
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                className="h-8 px-2 shrink-0 text-xs gap-1"
                                onClick={() => setExportParent(formatCurrentTimestamp())}
                                disabled={exportRunning}
                              >
                                <IconClock className="size-3" />
                                <span>Now</span>
                              </Button>
                            }
                          />
                          <TooltipContent>Insert current timestamp</TooltipContent>
                        </Tooltip>
                      </div>
                      <p className="text-[10px] text-muted-foreground leading-tight">
                        Shared parent folder name in SystemRepository and locally under <code className="font-mono">./export/</code>.
                      </p>
                    </div>

                    {/* Suffix */}
                    <div className="space-y-1">
                      <div className="flex items-center justify-between">
                        <Label className="text-[11px] font-medium">Folder & ZIP Suffix</Label>
                        <span className="text-[10px] text-muted-foreground font-mono">--suffix</span>
                      </div>
                      <Input
                        className="h-8 text-xs"
                        placeholder="e.g. RC1, v1.0, Sprint24"
                        value={exportSuffix}
                        onChange={(e) => setExportSuffix(e.target.value)}
                        disabled={exportRunning}
                      />
                      <p className="text-[10px] text-muted-foreground leading-tight">
                        Appended to each project folder and ZIP file name.
                      </p>
                    </div>

                    {/* Project Filter */}
                    <div className="space-y-1">
                      <div className="flex items-center justify-between">
                        <Label className="text-[11px] font-medium">Project Filter</Label>
                        <span className="text-[10px] text-muted-foreground font-mono">--project</span>
                      </div>
                      <Select
                        value={exportProject}
                        onValueChange={(v) => setExportProject(v ?? ALL_PROJECTS)}
                        disabled={exportRunning}
                      >
                        <SelectTrigger className="h-8 text-xs">
                          <SelectValue>{(v: string) => (v === ALL_PROJECTS ? "All Projects" : v)}</SelectValue>
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value={ALL_PROJECTS}>
                            <span className="font-medium text-xs">All Projects</span>
                            <span className="ml-2 text-muted-foreground text-[10px]">
                              ({exportProjects.length})
                            </span>
                          </SelectItem>
                          {exportProjects.map((p) => (
                            <SelectItem key={p.key} value={p.key}>
                              <span className="text-xs">{p.alias}</span>
                              <span className="ml-1.5 text-muted-foreground font-mono text-[9px]">
                                ({p.key})
                              </span>
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>

                    {/* Dry Run Toggle */}
                    <div className="flex items-center justify-between p-2 rounded-md border bg-muted/20">
                      <div className="space-y-0.5">
                        <Label htmlFor="export-dryrun" className="text-xs font-medium cursor-pointer">
                          Dry Run Mode
                        </Label>
                        <p className="text-[10px] text-muted-foreground leading-tight">
                          Preview actions without calling ThingWorx or writing files.
                        </p>
                      </div>
                      <Switch
                        id="export-dryrun"
                        checked={exportDryRun}
                        onCheckedChange={setExportDryRun}
                        disabled={exportRunning}
                      />
                    </div>
                  </CardContent>

                  <CardFooter className="flex items-center justify-between border-t border-border/40 py-2.5 px-3.5 bg-muted/10">
                    <div className="text-[10px] text-muted-foreground font-mono truncate max-w-[200px] sm:max-w-[260px]">
                      ./export/{exportParent || "[timestamp]"}
                    </div>
                    <Button
                      size="sm"
                      className="h-8 px-3 text-xs font-medium"
                      onClick={handleExport}
                      disabled={exportRunning || !exportEnv}
                    >
                      {exportRunning ? (
                        <>
                          <IconLoader2 className="size-3 animate-spin mr-1.5" />
                          Exporting…
                        </>
                      ) : (
                        <>
                          <IconPlayerPlay className="size-3 mr-1.5" />
                          Run Export
                        </>
                      )}
                    </Button>
                  </CardFooter>
                </Card>
              )}

              {/* STAGE 2: EXTRACT */}
              {activeTab === "extract" && (
                <Card className="border-border/60 shadow-xs gap-0 py-0">
                  <CardHeader className="border-b border-border/40 py-2.5 px-3.5">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-1.5">
                        <IconArchive className="size-3.5 text-primary" />
                        <CardTitle className="text-xs font-semibold">Stage 2: Extract & Format</CardTitle>
                      </div>
                      <Badge variant="outline" className="text-[9px] font-mono py-0 h-4">
                        extract-deploymentfiles
                      </Badge>
                    </div>
                    <CardDescription className="text-[11px] text-muted-foreground">
                      Unpack project ZIPs, format XML entities, and structure into WindchillClients.
                    </CardDescription>
                  </CardHeader>

                  <CardContent className="space-y-2.5 p-3.5">
                    {/* Quick helper if export result exists */}
                    {exportResult?.exportedDir && extractInput !== exportResult.exportedDir && (
                      <div className="flex items-center justify-between p-2 rounded-md border border-primary/30 bg-primary/5 text-xs">
                        <div className="flex items-center gap-1.5 text-foreground truncate min-w-0">
                          <IconSparkles className="size-3.5 text-primary shrink-0" />
                          <span className="truncate text-[11px]">
                            Recent Export:{" "}
                            <code className="font-mono text-[10px]">
                              {exportResult.exportedDir}
                            </code>
                          </span>
                        </div>
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-6 text-[10px] px-2 shrink-0 ml-2"
                          onClick={() => setExtractInput(exportResult.exportedDir)}
                        >
                          Use folder
                        </Button>
                      </div>
                    )}

                    {/* Input Directory */}
                    <div className="space-y-1">
                      <div className="flex items-center justify-between">
                        <Label className="text-[11px] font-medium">
                          Input Export Directory <span className="text-destructive">*</span>
                        </Label>
                        <span className="text-[10px] text-muted-foreground font-mono">--input</span>
                      </div>
                      <PathInput
                        directory
                        baseDir={workspaceRoot}
                        placeholder="./export/20260827-111635"
                        value={extractInput}
                        onChange={(e) => setExtractInput(e.target.value)}
                        onPick={setExtractInput}
                        disabled={extractRunning}
                      />
                      <p className="text-[10px] text-muted-foreground leading-tight">
                        The directory containing the exported project folders and ZIPs.
                      </p>
                    </div>

                    {/* Output Directory */}
                    <div className="space-y-1">
                      <div className="flex items-center justify-between">
                        <Label className="text-[11px] font-medium">Output Workspace Directory</Label>
                        <span className="text-[10px] text-muted-foreground font-mono">--output</span>
                      </div>
                      <PathInput
                        directory
                        baseDir={workspaceRoot}
                        placeholder="./WindchillClients/ThingWorx"
                        value={extractOutput}
                        onChange={(e) => setExtractOutput(e.target.value)}
                        onPick={setExtractOutput}
                        disabled={extractRunning}
                      />
                      <p className="text-[10px] text-muted-foreground leading-tight">
                        WindchillClients root destination where project XML entities will be formatted.
                      </p>
                    </div>

                    {/* Project Filter */}
                    <div className="space-y-1">
                      <div className="flex items-center justify-between">
                        <Label className="text-[11px] font-medium">Project Filter</Label>
                        <span className="text-[10px] text-muted-foreground font-mono">--project</span>
                      </div>
                      <Select
                        value={extractProject}
                        onValueChange={(v) => setExtractProject(v ?? ALL_PROJECTS)}
                        disabled={extractRunning}
                      >
                        <SelectTrigger className="h-8 text-xs">
                          <SelectValue>{(v: string) => (v === ALL_PROJECTS ? "All Projects" : v)}</SelectValue>
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value={ALL_PROJECTS}>
                            <span className="font-medium text-xs">All Projects</span>
                            <span className="ml-2 text-muted-foreground text-[10px]">
                              ({projects.length})
                            </span>
                          </SelectItem>
                          {projects.map((p) => (
                            <SelectItem key={p.key} value={p.key}>
                              <span className="text-xs">{p.alias}</span>
                              <span className="ml-1.5 text-muted-foreground font-mono text-[9px]">
                                ({p.key})
                              </span>
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>

                    {/* Dry Run Toggle */}
                    <div className="flex items-center justify-between p-2 rounded-md border bg-muted/20">
                      <div className="space-y-0.5">
                        <Label htmlFor="extract-dryrun" className="text-xs font-medium cursor-pointer">
                          Dry Run Mode
                        </Label>
                        <p className="text-[10px] text-muted-foreground leading-tight">
                          Simulate extraction without writing or modifying files on disk.
                        </p>
                      </div>
                      <Switch
                        id="extract-dryrun"
                        checked={extractDryRun}
                        onCheckedChange={setExtractDryRun}
                        disabled={extractRunning}
                      />
                    </div>
                  </CardContent>

                  <CardFooter className="flex items-center justify-between border-t border-border/40 py-2.5 px-3.5 bg-muted/10">
                    <div className="text-[10px] text-muted-foreground font-mono truncate max-w-[200px] sm:max-w-[260px]">
                      {extractOutput || "./WindchillClients/ThingWorx"}
                    </div>
                    <Button
                      size="sm"
                      className="h-8 px-3 text-xs font-medium"
                      onClick={handleExtract}
                      disabled={extractRunning || !extractInput.trim()}
                    >
                      {extractRunning ? (
                        <>
                          <IconLoader2 className="size-3 animate-spin mr-1.5" />
                          Extracting…
                        </>
                      ) : (
                        <>
                          <IconPlayerPlay className="size-3 mr-1.5" />
                          Run Extract
                        </>
                      )}
                    </Button>
                  </CardFooter>
                </Card>
              )}

              {/* STAGE 3: UPDATE CONFIGS */}
              {activeTab === "configs" && (
                <Card className="border-border/60 shadow-xs gap-0 py-0">
                  <CardHeader className="border-b border-border/40 py-2.5 px-3.5">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-1.5">
                        <IconPlugConnected className="size-3.5 text-primary" />
                        <CardTitle className="text-xs font-semibold">Stage 3: Update Connector Configs</CardTitle>
                      </div>
                      <Badge variant="outline" className="text-[9px] font-mono py-0 h-4">
                        update-connectors
                      </Badge>
                    </div>
                    <CardDescription className="text-[11px] text-muted-foreground">
                      Point Integration Connectors at the target environment before bundling. URLs are
                      replaced in each connector&apos;s configuration tables and properties.
                    </CardDescription>
                  </CardHeader>

                  <CardContent className="space-y-2.5 p-3.5">
                    {/* Source Directory */}
                    <div className="space-y-1">
                      <div className="flex items-center justify-between">
                        <Label className="text-[11px] font-medium">
                          Source Directory <span className="text-destructive">*</span>
                        </Label>
                        <span className="text-[10px] text-muted-foreground font-mono">--source</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <div className="min-w-0 flex-1">
                          <PathInput
                            directory
                            baseDir={workspaceRoot}
                            placeholder="./WindchillClients/ThingWorx"
                            value={configSource}
                            onChange={(e) => setConfigSource(e.target.value)}
                            onPick={(dir) => {
                              setConfigSource(dir);
                              scanConnectors(dir);
                            }}
                            disabled={configRunning}
                          />
                        </div>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="h-8 px-2 shrink-0 text-xs gap-1"
                          onClick={() => scanConnectors(configSource)}
                          disabled={configRunning || connectorsLoading || !configSource.trim()}
                        >
                          {connectorsLoading ? (
                            <IconLoader2 className="size-3 animate-spin" />
                          ) : (
                            <IconSearch className="size-3" />
                          )}
                          <span>Scan</span>
                        </Button>
                      </div>
                      <p className="text-[10px] text-muted-foreground leading-tight">
                        Extracted entities (project folders with Things/).
                      </p>
                    </div>

                    {/* Destination Directory */}
                    <div className="space-y-1">
                      <div className="flex items-center justify-between">
                        <Label className="text-[11px] font-medium">
                          Destination Directory <span className="text-destructive">*</span>
                        </Label>
                        <span className="text-[10px] text-muted-foreground font-mono">--dest</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <div className="min-w-0 flex-1">
                          <PathInput
                            directory
                            baseDir={workspaceRoot}
                            placeholder="Same as source"
                            value={configDest}
                            onChange={(e) => setConfigDestOverride(e.target.value)}
                            onPick={setConfigDestOverride}
                            disabled={configRunning}
                          />
                        </div>
                        {configDestOverride !== null && (
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="h-8 px-2 shrink-0 text-xs"
                            onClick={() => setConfigDestOverride(null)}
                            disabled={configRunning}
                            title="Update the connector files in the source directory"
                          >
                            Same as source
                          </Button>
                        )}
                      </div>
                      <p className="text-[10px] text-muted-foreground leading-tight">
                        {configInPlace
                          ? "Same as source: the connector files are updated in place."
                          : "The source is copied here (existing files are overwritten) and the connectors are updated in the copy."}
                      </p>
                    </div>

                    {/* Connectors */}
                    {connectorsError && (
                      <p className="text-[11px] text-destructive">{connectorsError}</p>
                    )}
                    {!connectorsError && connectorsScanned && connectors.length === 0 && !connectorsLoading && (
                      <p className="text-[11px] text-muted-foreground">
                        No Integration Connectors found in this directory.
                      </p>
                    )}

                    {connectorOrigins.length > 0 && (
                      <div className="space-y-1.5">
                        <Label className="text-[11px] font-medium">Replace URL everywhere</Label>
                        {connectorOrigins.map(({ origin, count }) => {
                          const value = globalUrlMap[origin] ?? "";
                          const invalid = !!value.trim() && !ORIGIN_RE.test(value.trim());
                          return (
                            <div key={origin} className="space-y-0.5">
                              <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                                <span className="font-mono truncate">{origin}</span>
                                <span className="shrink-0">· {count} connector(s)</span>
                              </div>
                              <Input
                                className={cn("h-7 text-xs font-mono", invalid && "border-destructive")}
                                placeholder="https://new-host.example.com"
                                value={value}
                                onChange={(e) =>
                                  setGlobalUrlMap((prev) => ({ ...prev, [origin]: e.target.value }))
                                }
                                disabled={configRunning}
                              />
                            </div>
                          );
                        })}
                        <p className="text-[10px] text-muted-foreground leading-tight">
                          Scheme and host only (e.g. <code className="font-mono">https://host.example.com</code>).
                          Paths after the host are kept.
                        </p>
                      </div>
                    )}

                    {connectors.length > 0 && (
                      <div className="space-y-1.5">
                        <Label className="text-[11px] font-medium">
                          Integration Connectors ({connectors.length})
                        </Label>
                        <div className="space-y-1.5 max-h-[420px] overflow-y-auto pr-0.5">
                          {connectors.map((c) => (
                            <div key={c.relPath} className="rounded-md border bg-background/50 p-2 space-y-1.5">
                              <div className="min-w-0">
                                <div className="text-xs font-medium truncate">{c.name}</div>
                                <div className="text-[10px] text-muted-foreground font-mono truncate" title={c.relPath}>
                                  {c.relPath}
                                </div>
                                {c.baseUrl && (
                                  <div className="text-[10px] text-muted-foreground truncate" title={c.baseUrl}>
                                    BaseURL: <span className="font-mono">{c.baseUrl}</span>
                                  </div>
                                )}
                              </div>

                              {c.urls.map((u) => {
                                const key = urlKey(c.relPath, u.origin);
                                const value = urlOverrides[key] ?? globalUrlMap[u.origin] ?? "";
                                const invalid = !!value.trim() && !ORIGIN_RE.test(value.trim());
                                return (
                                  <div key={key} className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-1.5">
                                    <span className="text-[10px] font-mono truncate text-muted-foreground" title={u.origin}>
                                      {u.origin}
                                      <span className="ml-1">×{u.occurrences}</span>
                                    </span>
                                    <IconArrowRight className="size-3 text-muted-foreground" />
                                    <Input
                                      className={cn("h-7 text-[11px] font-mono", invalid && "border-destructive")}
                                      placeholder="unchanged"
                                      value={value}
                                      onChange={(e) =>
                                        setUrlOverrides((prev) => ({ ...prev, [key]: e.target.value }))
                                      }
                                      disabled={configRunning}
                                    />
                                  </div>
                                );
                              })}

                              {c.username !== null && (
                                <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-1.5">
                                  <span className="text-[10px] truncate text-muted-foreground">
                                    AuthUsername:{" "}
                                    <span className="font-mono">{c.username || "(empty)"}</span>
                                  </span>
                                  <IconArrowRight className="size-3 text-muted-foreground" />
                                  <Input
                                    className="h-7 text-[11px] font-mono"
                                    placeholder="unchanged"
                                    value={usernameInputs[c.relPath] ?? ""}
                                    onChange={(e) =>
                                      setUsernameInputs((prev) => {
                                        const next = { ...prev };
                                        if (e.target.value) next[c.relPath] = e.target.value;
                                        else delete next[c.relPath];
                                        return next;
                                      })
                                    }
                                    disabled={configRunning}
                                  />
                                </div>
                              )}
                            </div>
                          ))}
                        </div>
                        <p className="text-[10px] text-muted-foreground leading-tight flex items-start gap-1">
                          <IconAlertTriangle className="size-3 shrink-0 mt-px" />
                          Passwords (AuthPassword) are never included in exports, so they cannot be set here.
                          Set them on the target server after import.
                        </p>
                      </div>
                    )}

                    {/* Clean destination — only for a separate copy */}
                    {!configInPlace && (
                      <div className="flex items-center justify-between p-2 rounded-md border bg-muted/20">
                        <div className="space-y-0.5">
                          <Label htmlFor="config-clean" className="text-xs font-medium cursor-pointer">
                            Clear Destination First
                          </Label>
                          <p className="text-[10px] text-muted-foreground leading-tight">
                            Delete the destination folder before copying, so no old files end up in the bundle.
                          </p>
                        </div>
                        <Switch
                          id="config-clean"
                          checked={configCleanDest}
                          onCheckedChange={setConfigCleanDest}
                          disabled={configRunning}
                        />
                      </div>
                    )}

                    {/* Dry Run Toggle */}
                    <div className="flex items-center justify-between p-2 rounded-md border bg-muted/20">
                      <div className="space-y-0.5">
                        <Label htmlFor="config-dryrun" className="text-xs font-medium cursor-pointer">
                          Dry Run Mode
                        </Label>
                        <p className="text-[10px] text-muted-foreground leading-tight">
                          Preview replacements without copying or writing files.
                        </p>
                      </div>
                      <Switch
                        id="config-dryrun"
                        checked={configDryRun}
                        onCheckedChange={setConfigDryRun}
                        disabled={configRunning}
                      />
                    </div>
                  </CardContent>

                  <CardFooter className="flex items-center justify-between border-t border-border/40 py-2.5 px-3.5 bg-muted/10">
                    <div className="text-[10px] text-muted-foreground font-mono truncate max-w-[200px] sm:max-w-[260px]">
                      {invalidUrls.length > 0
                        ? <span className="text-destructive">Invalid URL: {invalidUrls[0]}</span>
                        : `${configPlan.length} connector(s) to update`}
                    </div>
                    <Button
                      size="sm"
                      className="h-8 px-3 text-xs font-medium"
                      onClick={() => setConfigConfirmOpen(true)}
                      disabled={
                        configRunning ||
                        connectorsLoading ||
                        !configSource.trim() ||
                        !configDest.trim() ||
                        invalidUrls.length > 0
                      }
                    >
                      {configRunning ? (
                        <>
                          <IconLoader2 className="size-3 animate-spin mr-1.5" />
                          Updating…
                        </>
                      ) : (
                        <>
                          <IconPlayerPlay className="size-3 mr-1.5" />
                          Run Update
                        </>
                      )}
                    </Button>
                  </CardFooter>
                </Card>
              )}

              {/* Update Configs preview & confirmation */}
              <Dialog open={configConfirmOpen} onOpenChange={setConfigConfirmOpen}>
                <DialogContent className="sm:max-w-2xl">
                  <DialogHeader>
                    <DialogTitle>
                      {configDryRun ? "Preview dry run" : "Confirm connector updates"}
                    </DialogTitle>
                    <DialogDescription className="text-xs">
                      {configInPlace ? (
                        <>
                          Connectors in <code className="font-mono">{configSource.trim()}</code> are
                          updated in place.
                        </>
                      ) : (
                        <>
                          <code className="font-mono">{configSource.trim()}</code> is copied to{" "}
                          <code className="font-mono">{configDest.trim()}</code>
                          {configCleanDest && " (destination deleted first)"}, then the changes below are
                          applied to the copy.
                        </>
                      )}
                    </DialogDescription>
                  </DialogHeader>

                  {configPlan.length === 0 ? (
                    <p className="text-xs text-muted-foreground">
                      No connector changes entered — the source will only be copied.
                    </p>
                  ) : (
                    <div className="border rounded-md overflow-hidden">
                      <div className="max-h-80 overflow-auto">
                        <table className="w-full text-[11px]">
                          <thead className="bg-muted/50 sticky top-0">
                            <tr className="text-left text-muted-foreground">
                              <th className="px-2 py-1 font-medium">Connector</th>
                              <th className="px-2 py-1 font-medium">Old</th>
                              <th className="px-2 py-1 font-medium">New</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-border/40">
                            {configPlan.flatMap((p) => [
                              ...p.urlChanges.map((u) => (
                                <tr key={`${p.connector.relPath}|${u.from}`}>
                                  <td className="px-2 py-1 font-medium break-all">{p.connector.name}</td>
                                  <td className="px-2 py-1 font-mono break-all text-muted-foreground">
                                    {u.from} <span className="text-[10px]">×{u.occurrences}</span>
                                  </td>
                                  <td className="px-2 py-1 font-mono break-all">{u.to}</td>
                                </tr>
                              )),
                              ...(p.usernameChange !== null
                                ? [
                                    <tr key={`${p.connector.relPath}|username`}>
                                      <td className="px-2 py-1 font-medium break-all">{p.connector.name}</td>
                                      <td className="px-2 py-1 font-mono break-all text-muted-foreground">
                                        AuthUsername: {p.connector.username || "(empty)"}
                                      </td>
                                      <td className="px-2 py-1 font-mono break-all">
                                        {p.usernameChange || "(empty)"}
                                      </td>
                                    </tr>,
                                  ]
                                : []),
                            ])}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}

                  <DialogFooter>
                    <Button variant="outline" size="sm" onClick={() => setConfigConfirmOpen(false)}>
                      Cancel
                    </Button>
                    <Button size="sm" onClick={handleConfigUpdate}>
                      <IconPlugConnected className="size-3 mr-1.5" />
                      {configDryRun ? "Run dry run" : `Apply to ${configPlan.length} connector(s)`}
                    </Button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>

              {/* STAGE 4: BUNDLE */}
              {activeTab === "bundle" && (
                <Card className="border-border/60 shadow-xs gap-0 py-0">
                  <CardHeader className="border-b border-border/40 py-2.5 px-3.5">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-1.5">
                        <IconPackage className="size-3.5 text-primary" />
                        <CardTitle className="text-xs font-semibold">Stage 4: Bundle Release</CardTitle>
                      </div>
                      <Badge variant="outline" className="text-[9px] font-mono py-0 h-4">
                        twx bundle
                      </Badge>
                    </div>
                    <CardDescription className="text-[11px] text-muted-foreground">
                      Package local WindchillClients projects into clean distributable release ZIPs.
                    </CardDescription>
                  </CardHeader>

                  <CardContent className="space-y-2.5 p-3.5">
                    {/* Source Directory */}
                    <div className="space-y-1">
                      <div className="flex items-center justify-between">
                        <Label className="text-[11px] font-medium">Source Directory</Label>
                        <span className="text-[10px] text-muted-foreground font-mono">--src</span>
                      </div>
                      <PathInput
                        directory
                        baseDir={workspaceRoot}
                        placeholder="./WindchillClients/Thingworx"
                        value={bundleSrc}
                        onChange={(e) => setBundleSrc(e.target.value)}
                        onPick={setBundleSrc}
                        disabled={bundleRunning}
                      />
                      <p className="text-[10px] text-muted-foreground leading-tight">
                        Folder containing the project subfolders.
                      </p>
                    </div>

                    {/* Destination Directory */}
                    <div className="space-y-1">
                      <div className="flex items-center justify-between">
                        <Label className="text-[11px] font-medium">Destination Directory</Label>
                        <span className="text-[10px] text-muted-foreground font-mono">--dest</span>
                      </div>
                      <PathInput
                        directory
                        baseDir={workspaceRoot}
                        placeholder="./bundles"
                        value={bundleDest}
                        onChange={(e) => setBundleDest(e.target.value)}
                        onPick={setBundleDest}
                        disabled={bundleRunning}
                      />
                      <p className="text-[10px] text-muted-foreground leading-tight">
                        Output location where final release ZIP archives are created.
                      </p>
                    </div>

                    {/* Project Filter */}
                    <div className="space-y-1">
                      <div className="flex items-center justify-between">
                        <Label className="text-[11px] font-medium">Project Filter</Label>
                        <span className="text-[10px] text-muted-foreground font-mono">--project</span>
                      </div>
                      <Select
                        value={bundleProject}
                        onValueChange={(v) => setBundleProject(v ?? ALL_PROJECTS)}
                        disabled={bundleRunning}
                      >
                        <SelectTrigger className="h-8 text-xs">
                          <SelectValue>{(v: string) => (v === ALL_PROJECTS ? "All Projects" : v)}</SelectValue>
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value={ALL_PROJECTS}>
                            <span className="font-medium text-xs">All Projects</span>
                            <span className="ml-2 text-muted-foreground text-[10px]">
                              ({bundleProjects.length})
                            </span>
                          </SelectItem>
                          {bundleProjects.map((p) => (
                            <SelectItem key={p.alias} value={p.alias}>
                              <span className="text-xs">{p.alias}</span>
                              <span className="ml-1.5 text-muted-foreground font-mono text-[9px]">
                                ({p.projectName})
                              </span>
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>

                    {/* Dry Run Toggle */}
                    <div className="flex items-center justify-between p-2 rounded-md border bg-muted/20">
                      <div className="space-y-0.5">
                        <Label htmlFor="bundle-dryrun" className="text-xs font-medium cursor-pointer">
                          Dry Run Mode
                        </Label>
                        <p className="text-[10px] text-muted-foreground leading-tight">
                          Preview bundles without writing ZIP files to destination.
                        </p>
                      </div>
                      <Switch
                        id="bundle-dryrun"
                        checked={bundleDryRun}
                        onCheckedChange={setBundleDryRun}
                        disabled={bundleRunning}
                      />
                    </div>
                  </CardContent>

                  <CardFooter className="flex items-center justify-between border-t border-border/40 py-2.5 px-3.5 bg-muted/10">
                    <div className="text-[10px] text-muted-foreground font-mono truncate max-w-[200px] sm:max-w-[260px]">
                      {bundleDest || "./bundles"}
                    </div>
                    <Button
                      size="sm"
                      className="h-8 px-3 text-xs font-medium"
                      onClick={handleBundle}
                      disabled={bundleRunning}
                    >
                      {bundleRunning ? (
                        <>
                          <IconLoader2 className="size-3 animate-spin mr-1.5" />
                          Bundling…
                        </>
                      ) : (
                        <>
                          <IconPlayerPlay className="size-3 mr-1.5" />
                          Run Bundle
                        </>
                      )}
                    </Button>
                  </CardFooter>
                </Card>
              )}

              {/* STAGE 5: BACKUP */}
              {activeTab === "backup" && (
                <Card className="border-border/60 shadow-xs gap-0 py-0">
                  <CardHeader className="border-b border-border/40 py-2.5 px-3.5">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-1.5">
                        <IconDatabaseExport className="size-3.5 text-primary" />
                        <CardTitle className="text-xs font-semibold">Stage 5: Backup Target Server</CardTitle>
                      </div>
                      <Badge variant="outline" className="text-[9px] font-mono py-0 h-4">
                        backup-deploymentfiles
                      </Badge>
                    </div>
                    <CardDescription className="text-[11px] text-muted-foreground">
                      Before deploying, back up the current projects on the target server as source-control
                      entities or ZIP files in its SystemRepository. Nothing is downloaded.
                    </CardDescription>
                  </CardHeader>

                  <CardContent className="space-y-2.5 p-3.5">
                    {/* Environment */}
                    <div className="space-y-1">
                      <div className="flex items-center justify-between">
                        <Label className="text-[11px] font-medium">
                          Environment <span className="text-destructive">*</span>
                        </Label>
                        <span className="text-[10px] text-muted-foreground font-mono">--env</span>
                      </div>
                      <Select
                        value={backupEnv}
                        onValueChange={(v) => {
                          const env = v ?? "";
                          setBackupEnv(env);
                          const available = env ? projectsByEnv[env] ?? [] : projects;
                          if (!available.some((p) => p.key === backupProject)) {
                            setBackupProject(ALL_PROJECTS);
                          }
                        }}
                        disabled={backupRunning}
                      >
                        <SelectTrigger className="h-8 text-xs">
                          <SelectValue placeholder="Choose an environment" />
                        </SelectTrigger>
                        <SelectContent>
                          {envs.map((e) => (
                            <SelectItem key={e} value={e}>
                              <span className="font-medium text-xs">{e}</span>
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <p className="text-[10px] text-muted-foreground leading-tight">
                        The server you are about to deploy to.
                      </p>
                    </div>

                    {/* Backup Folder */}
                    <div className="space-y-1">
                      <div className="flex items-center justify-between">
                        <Label className="text-[11px] font-medium">
                          Backup Folder Name <span className="text-destructive">*</span>
                        </Label>
                        <span className="text-[10px] text-muted-foreground font-mono">--parent</span>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <Input
                          className="h-8 text-xs font-mono"
                          placeholder="Backup_20261009-101500"
                          value={backupParent}
                          onChange={(e) => setBackupParent(e.target.value)}
                          disabled={backupRunning}
                        />
                        <Tooltip>
                          <TooltipTrigger
                            render={
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                className="h-8 px-2 shrink-0 text-xs gap-1"
                                onClick={() => setBackupParent(`Backup_${formatCurrentTimestamp()}`)}
                                disabled={backupRunning}
                              >
                                <IconClock className="size-3" />
                                <span>Now</span>
                              </Button>
                            }
                          />
                          <TooltipContent>Insert current timestamp</TooltipContent>
                        </Tooltip>
                      </div>
                      <p className="text-[10px] text-muted-foreground leading-tight">
                        Folder in SystemRepository; each project goes in its own subfolder.
                      </p>
                    </div>

                    {/* Suffix */}
                    <div className="space-y-1">
                      <div className="flex items-center justify-between">
                        <Label className="text-[11px] font-medium">Folder Suffix</Label>
                        <span className="text-[10px] text-muted-foreground font-mono">--suffix</span>
                      </div>
                      <Input
                        className="h-8 text-xs"
                        placeholder="e.g. PreRC1"
                        value={backupSuffix}
                        onChange={(e) => setBackupSuffix(e.target.value)}
                        disabled={backupRunning}
                      />
                      <p className="text-[10px] text-muted-foreground leading-tight">
                        Appended to each project folder name.
                      </p>
                    </div>

                    {/* Project Filter */}
                    <div className="space-y-1">
                      <div className="flex items-center justify-between">
                        <Label className="text-[11px] font-medium">Project Filter</Label>
                        <span className="text-[10px] text-muted-foreground font-mono">--project</span>
                      </div>
                      <Select
                        value={backupProject}
                        onValueChange={(v) => setBackupProject(v ?? ALL_PROJECTS)}
                        disabled={backupRunning}
                      >
                        <SelectTrigger className="h-8 text-xs">
                          <SelectValue>{(v: string) => (v === ALL_PROJECTS ? "All Projects" : v)}</SelectValue>
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value={ALL_PROJECTS}>
                            <span className="font-medium text-xs">All Projects</span>
                            <span className="ml-2 text-muted-foreground text-[10px]">
                              ({backupProjects.length})
                            </span>
                          </SelectItem>
                          {backupProjects.map((p) => (
                            <SelectItem key={p.key} value={p.key}>
                              <span className="text-xs">{p.alias}</span>
                              <span className="ml-1.5 text-muted-foreground font-mono text-[9px]">
                                ({p.key})
                              </span>
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>

                    {/* ZIP Toggle */}
                    <div className="flex items-center justify-between p-2 rounded-md border bg-muted/20">
                      <div className="space-y-0.5">
                        <Label htmlFor="backup-zip" className="text-xs font-medium cursor-pointer">
                          Backup as ZIP File
                        </Label>
                        <p className="text-[10px] text-muted-foreground leading-tight">
                          {backupZip
                            ? "One ZIP per project, saved in its project folder."
                            : "Off: entities are written as source-control XML folders."}
                        </p>
                      </div>
                      <Switch
                        id="backup-zip"
                        checked={backupZip}
                        onCheckedChange={setBackupZip}
                        disabled={backupRunning}
                      />
                    </div>

                    {/* Dry Run Toggle */}
                    <div className="flex items-center justify-between p-2 rounded-md border bg-muted/20">
                      <div className="space-y-0.5">
                        <Label htmlFor="backup-dryrun" className="text-xs font-medium cursor-pointer">
                          Dry Run Mode
                        </Label>
                        <p className="text-[10px] text-muted-foreground leading-tight">
                          Preview the backup folders without calling ThingWorx.
                        </p>
                      </div>
                      <Switch
                        id="backup-dryrun"
                        checked={backupDryRun}
                        onCheckedChange={setBackupDryRun}
                        disabled={backupRunning}
                      />
                    </div>
                  </CardContent>

                  <CardFooter className="flex items-center justify-between border-t border-border/40 py-2.5 px-3.5 bg-muted/10">
                    <div className="text-[10px] text-muted-foreground font-mono truncate max-w-[200px] sm:max-w-[260px]">
                      SystemRepository/{backupParent.trim() || "[folder]"}
                    </div>
                    <Button
                      size="sm"
                      className="h-8 px-3 text-xs font-medium"
                      onClick={handleBackup}
                      disabled={backupRunning || !backupEnv || !backupParent.trim()}
                    >
                      {backupRunning ? (
                        <>
                          <IconLoader2 className="size-3 animate-spin mr-1.5" />
                          Backing up…
                        </>
                      ) : (
                        <>
                          <IconPlayerPlay className="size-3 mr-1.5" />
                          Run Backup
                        </>
                      )}
                    </Button>
                  </CardFooter>
                </Card>
              )}

              {/* STAGE 6: UPLOAD */}
              {activeTab === "upload" && (
                <Card className="border-border/60 shadow-xs gap-0 py-0">
                  <CardHeader className="border-b border-border/40 py-2.5 px-3.5">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-1.5">
                        <IconCloudUpload className="size-3.5 text-primary" />
                        <CardTitle className="text-xs font-semibold">Stage 6: Upload to SystemRepository</CardTitle>
                      </div>
                      <Badge variant="outline" className="text-[9px] font-mono py-0 h-4">
                        upload-deploymentfiles
                      </Badge>
                    </div>
                    <CardDescription className="text-[11px] text-muted-foreground">
                      Upload a local folder into SystemRepository, keeping its structure, and extract ZIP archives.
                    </CardDescription>
                  </CardHeader>

                  <CardContent className="space-y-2.5 p-3.5">
                    {/* Environment */}
                    <div className="space-y-1">
                      <div className="flex items-center justify-between">
                        <Label className="text-[11px] font-medium">
                          Environment <span className="text-destructive">*</span>
                        </Label>
                        <span className="text-[10px] text-muted-foreground font-mono">--env</span>
                      </div>
                      <Select
                        value={uploadEnv}
                        onValueChange={(v) => setUploadEnv(v ?? "")}
                        disabled={uploadRunning}
                      >
                        <SelectTrigger className="h-8 text-xs">
                          <SelectValue placeholder="Choose an environment" />
                        </SelectTrigger>
                        <SelectContent>
                          {envs.map((e) => (
                            <SelectItem key={e} value={e}>
                              <span className="font-medium text-xs">{e}</span>
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <p className="text-[10px] text-muted-foreground leading-tight">
                        Target ThingWorx server whose SystemRepository receives the files.
                      </p>
                    </div>

                    {/* Source Directory */}
                    <div className="space-y-1">
                      <div className="flex items-center justify-between">
                        <Label className="text-[11px] font-medium">
                          Source Directory <span className="text-destructive">*</span>
                        </Label>
                        <span className="text-[10px] text-muted-foreground font-mono">--source</span>
                      </div>
                      <PathInput
                        directory
                        baseDir={workspaceRoot}
                        placeholder="./export/20260615-154902"
                        value={uploadSource}
                        onChange={(e) => setUploadSource(e.target.value)}
                        onPick={handleUploadSourceSelect}
                        disabled={uploadRunning}
                      />
                      <p className="text-[10px] text-muted-foreground leading-tight">
                        Local folder to upload. All files in it and its subfolders are uploaded, keeping
                        the same folder structure. Run Upload lists them for confirmation first.
                      </p>
                    </div>

                    {/* Target Directory */}
                    <div className="space-y-1">
                      <div className="flex items-center justify-between">
                        <Label className="text-[11px] font-medium">
                          Target Repository Directory <span className="text-destructive">*</span>
                        </Label>
                        <span className="text-[10px] text-muted-foreground font-mono">--target</span>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <Input
                          className="h-8 text-xs font-mono"
                          placeholder="/20260615-154902"
                          value={uploadDir}
                          onChange={(e) => setUploadDir(e.target.value)}
                          disabled={uploadRunning}
                        />
                        <RepoDirBrowser
                          env={uploadEnv}
                          onSelect={setUploadDir}
                          initialPath={uploadDir.trim() || "/"}
                          disabled={uploadRunning}
                        />
                        <Tooltip>
                          <TooltipTrigger
                            render={
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                className="h-8 px-2 shrink-0 text-xs gap-1"
                                onClick={() => setUploadDir(`/${formatCurrentTimestamp()}`)}
                                disabled={uploadRunning}
                              >
                                <IconClock className="size-3" />
                                <span>Now</span>
                              </Button>
                            }
                          />
                          <TooltipContent>Use a timestamped folder</TooltipContent>
                        </Tooltip>
                      </div>
                      <p className="text-[10px] text-muted-foreground leading-tight">
                        Folder in SystemRepository that receives the source folder&apos;s contents. Missing
                        folders are created.
                      </p>
                    </div>

                    {/* Extract Toggle */}
                    <div className="flex items-center justify-between p-2 rounded-md border bg-muted/20">
                      <div className="space-y-0.5">
                        <Label htmlFor="upload-extract" className="text-xs font-medium cursor-pointer">
                          Extract ZIP Files
                        </Label>
                        <p className="text-[10px] text-muted-foreground leading-tight">
                          Run ExtractZipArchive on each uploaded .zip after upload.
                        </p>
                      </div>
                      <Switch
                        id="upload-extract"
                        checked={uploadExtract}
                        onCheckedChange={setUploadExtract}
                        disabled={uploadRunning}
                      />
                    </div>

                    {uploadExtract && (
                      <>
                        <div className="flex items-center justify-between p-2 rounded-md border bg-muted/20">
                          <div className="space-y-0.5">
                            <Label htmlFor="upload-subfolder" className="text-xs font-medium cursor-pointer">
                              Extract Into Subfolder
                            </Label>
                            <p className="text-[10px] text-muted-foreground leading-tight">
                              Unpack each ZIP into a folder named after it instead of the directory itself.
                            </p>
                          </div>
                          <Switch
                            id="upload-subfolder"
                            checked={uploadSubfolder}
                            onCheckedChange={setUploadSubfolder}
                            disabled={uploadRunning}
                          />
                        </div>

                        <div className="flex items-center justify-between p-2 rounded-md border bg-muted/20">
                          <div className="space-y-0.5">
                            <Label htmlFor="upload-deletezip" className="text-xs font-medium cursor-pointer">
                              Delete ZIP After Extract
                            </Label>
                            <p className="text-[10px] text-muted-foreground leading-tight">
                              Remove the uploaded archive once it is extracted successfully.
                            </p>
                          </div>
                          <Switch
                            id="upload-deletezip"
                            checked={uploadDeleteZip}
                            onCheckedChange={setUploadDeleteZip}
                            disabled={uploadRunning}
                          />
                        </div>
                      </>
                    )}

                    {/* Dry Run Toggle */}
                    <div className="flex items-center justify-between p-2 rounded-md border bg-muted/20">
                      <div className="space-y-0.5">
                        <Label htmlFor="upload-dryrun" className="text-xs font-medium cursor-pointer">
                          Dry Run Mode
                        </Label>
                        <p className="text-[10px] text-muted-foreground leading-tight">
                          Preview uploads and extractions without calling ThingWorx.
                        </p>
                      </div>
                      <Switch
                        id="upload-dryrun"
                        checked={uploadDryRun}
                        onCheckedChange={setUploadDryRun}
                        disabled={uploadRunning}
                      />
                    </div>
                  </CardContent>

                  <CardFooter className="flex items-center justify-between border-t border-border/40 py-2.5 px-3.5 bg-muted/10">
                    <div className="text-[10px] text-muted-foreground font-mono truncate max-w-[200px] sm:max-w-[260px]">
                      SystemRepository{uploadDir.trim() ? `/${uploadDir.trim().replace(/^[\\/]+/, "")}` : "/[dir]"}
                    </div>
                    <Button
                      size="sm"
                      className="h-8 px-3 text-xs font-medium"
                      onClick={handleUploadPreview}
                      disabled={uploadRunning || !uploadEnv || !uploadSource.trim() || !uploadDir.trim()}
                    >
                      {uploadRunning ? (
                        <>
                          <IconLoader2 className="size-3 animate-spin mr-1.5" />
                          Uploading…
                        </>
                      ) : (
                        <>
                          <IconPlayerPlay className="size-3 mr-1.5" />
                          Run Upload
                        </>
                      )}
                    </Button>
                  </CardFooter>
                </Card>
              )}

              {/* Upload preview & confirmation */}
              <Dialog open={uploadConfirmOpen} onOpenChange={setUploadConfirmOpen}>
                <DialogContent className="sm:max-w-2xl">
                  <DialogHeader>
                    <DialogTitle>
                      {uploadDryRun ? "Preview dry run" : "Confirm upload to SystemRepository"}
                    </DialogTitle>
                    <DialogDescription className="text-xs">
                      {uploadPreview.result
                        ? `${uploadPreview.result.filesUploaded} file(s)`
                        : "Files"}{" "}
                      from <code className="font-mono">{uploadSource.trim()}</code> to{" "}
                      <code className="font-mono">
                        SystemRepository{normalizeRepoDir(uploadDir)}
                      </code>{" "}
                      on <span className="font-medium">{uploadEnv}</span>.
                      {!uploadDryRun && " Files with the same path are overwritten."}
                    </DialogDescription>
                  </DialogHeader>

                  <div className="border rounded-md overflow-hidden">
                    <div className="max-h-80 overflow-auto p-2 font-mono text-[11px] space-y-0.5 select-text">
                      {uploadPreview.loading ? (
                        <div className="flex items-center gap-2 text-muted-foreground">
                          <IconLoader2 className="size-3.5 animate-spin" />
                          Listing files…
                        </div>
                      ) : (
                        <>
                          {uploadPreview.lines.map((line, i) => (
                            <div key={i} className="break-all whitespace-pre-wrap text-muted-foreground">
                              {line.replace("(dry-run) Would ", "")}
                            </div>
                          ))}
                          {uploadPreview.error && (
                            <div className="break-all whitespace-pre-wrap text-destructive">{uploadPreview.error}</div>
                          )}
                        </>
                      )}
                    </div>
                  </div>

                  <DialogFooter>
                    <Button variant="outline" size="sm" onClick={() => setUploadConfirmOpen(false)}>
                      Cancel
                    </Button>
                    <Button size="sm" onClick={handleUpload} disabled={!uploadPreview.result}>
                      <IconCloudUpload className="size-3 mr-1.5" />
                      {uploadDryRun
                        ? "Run dry run"
                        : `Upload ${uploadPreview.result?.filesUploaded ?? 0} file(s)`}
                    </Button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>
            </div>

            {/* Right Column: Live Execution Terminal & Results */}
            <div className="lg:col-span-6 space-y-3">
              {/* Structured Completion Summary Card */}
              {activeTab === "export" && exportResult && (
                <Card className="border-green-500/30 bg-green-500/5 shadow-xs gap-0 py-0">
                  <CardContent className="p-3 space-y-2.5">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-1.5">
                        <IconCircleCheck className="size-4 text-green-600 dark:text-green-400" />
                        <span className="font-semibold text-xs text-foreground">
                          Export Completed Successfully
                        </span>
                      </div>
                      <Badge variant="secondary" className="text-[10px] font-mono py-0 h-4">
                        {exportResult.zipsSaved} ZIPs saved
                      </Badge>
                    </div>

                    <div className="grid grid-cols-2 gap-2 text-xs">
                      <div className="p-1.5 rounded border bg-background/50">
                        <span className="text-muted-foreground text-[10px]">Projects Processed</span>
                        <div className="font-semibold text-xs">{exportResult.projectsProcessed}</div>
                      </div>
                      <div className="p-1.5 rounded border bg-background/50">
                        <span className="text-muted-foreground text-[10px]">Errors / Warnings</span>
                        <div
                          className={cn(
                            "font-semibold text-xs",
                            exportResult.errors.length > 0 ? "text-destructive" : "text-green-600"
                          )}
                        >
                          {exportResult.errors.length}
                        </div>
                      </div>
                    </div>

                    {exportResult.exportedDir && (
                      <div className="p-1.5 rounded border bg-background/50 text-[10px] font-mono break-all flex items-center justify-between gap-1.5">
                        <span className="truncate">{exportResult.exportedDir}</span>
                        <Tooltip>
                          <TooltipTrigger
                            render={
                              <button
                                type="button"
                                className="text-muted-foreground hover:text-foreground shrink-0 cursor-pointer"
                                onClick={() =>
                                  navigator.clipboard.writeText(exportResult.exportedDir)
                                }
                              >
                                <IconCopy className="size-3" />
                              </button>
                            }
                          />
                          <TooltipContent>Copy output path</TooltipContent>
                        </Tooltip>
                      </div>
                    )}

                    <Button
                      size="sm"
                      className="w-full h-7 text-xs font-medium gap-1"
                      onClick={() => handleHandoffToExtract(exportResult.exportedDir)}
                    >
                      <span>Proceed to Stage 2: Extract Files</span>
                      <IconArrowRight className="size-3" />
                    </Button>
                  </CardContent>
                </Card>
              )}

              {activeTab === "extract" && extractResult && (
                <Card className="border-green-500/30 bg-green-500/5 shadow-xs gap-0 py-0">
                  <CardContent className="p-3 space-y-2.5">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-1.5">
                        <IconCircleCheck className="size-4 text-green-600 dark:text-green-400" />
                        <span className="font-semibold text-xs text-foreground">
                          Extraction Completed Successfully
                        </span>
                      </div>
                      <Badge variant="secondary" className="text-[10px] font-mono py-0 h-4">
                        {extractResult.entitiesExtracted} entities extracted
                      </Badge>
                    </div>

                    <div className="grid grid-cols-3 gap-1.5 text-xs">
                      <div className="p-1.5 rounded border bg-background/50">
                        <span className="text-muted-foreground text-[10px]">ZIPs Processed</span>
                        <div className="font-semibold text-xs">
                          {extractResult.zipFilesProcessed}
                        </div>
                      </div>
                      <div className="p-1.5 rounded border bg-background/50">
                        <span className="text-muted-foreground text-[10px]">Extracted</span>
                        <div className="font-semibold text-xs text-green-600">
                          {extractResult.entitiesExtracted}
                        </div>
                      </div>
                      <div className="p-1.5 rounded border bg-background/50">
                        <span className="text-muted-foreground text-[10px]">Skipped</span>
                        <div className="font-semibold text-xs text-muted-foreground">
                          {extractResult.entitiesSkipped}
                        </div>
                      </div>
                    </div>

                    <Button
                      size="sm"
                      className="w-full h-7 text-xs font-medium gap-1"
                      onClick={handleHandoffToConfigs}
                    >
                      <span>Proceed to Stage 3: Update Configs</span>
                      <IconArrowRight className="size-3" />
                    </Button>
                  </CardContent>
                </Card>
              )}

              {activeTab === "configs" && configResult && (
                <Card className="border-green-500/30 bg-green-500/5 shadow-xs gap-0 py-0">
                  <CardContent className="p-3 space-y-2.5">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-1.5">
                        <IconCircleCheck className="size-4 text-green-600 dark:text-green-400" />
                        <span className="font-semibold text-xs text-foreground">
                          Connector Configs Updated
                        </span>
                      </div>
                      <Badge variant="secondary" className="text-[10px] font-mono py-0 h-4">
                        {configResult.connectorsUpdated} of {configResult.connectorsFound} connectors
                      </Badge>
                    </div>

                    <div className="grid grid-cols-3 gap-1.5 text-xs">
                      <div className="p-1.5 rounded border bg-background/50">
                        <span className="text-muted-foreground text-[10px]">URLs Replaced</span>
                        <div className="font-semibold text-xs text-green-600">{configResult.urlsReplaced}</div>
                      </div>
                      <div className="p-1.5 rounded border bg-background/50">
                        <span className="text-muted-foreground text-[10px]">Usernames</span>
                        <div className="font-semibold text-xs">{configResult.usernamesUpdated}</div>
                      </div>
                      <div className="p-1.5 rounded border bg-background/50">
                        <span className="text-muted-foreground text-[10px]">Errors</span>
                        <div
                          className={cn(
                            "font-semibold text-xs",
                            configResult.errors.length > 0 ? "text-destructive" : "text-green-600"
                          )}
                        >
                          {configResult.errors.length}
                        </div>
                      </div>
                    </div>

                    <Button
                      size="sm"
                      className="w-full h-7 text-xs font-medium gap-1"
                      onClick={handleHandoffToBundle}
                    >
                      <span>Proceed to Stage 4: Bundle Release</span>
                      <IconArrowRight className="size-3" />
                    </Button>
                  </CardContent>
                </Card>
              )}

              {activeTab === "bundle" && bundleResult && (
                <Card className="border-green-500/30 bg-green-500/5 shadow-xs gap-0 py-0">
                  <CardContent className="p-3 space-y-2.5">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-1.5">
                        <IconCircleCheck className="size-4 text-green-600 dark:text-green-400" />
                        <span className="font-semibold text-xs text-foreground">
                          Bundling Completed
                        </span>
                      </div>
                      <Badge variant="secondary" className="text-[10px] font-mono py-0 h-4">
                        {bundleResult.zipsCreated} Bundles generated
                      </Badge>
                    </div>

                    <div className="grid grid-cols-2 gap-2 text-xs">
                      <div className="p-1.5 rounded border bg-background/50">
                        <span className="text-muted-foreground text-[10px]">Projects Processed</span>
                        <div className="font-semibold text-xs">
                          {bundleResult.projectsProcessed}
                        </div>
                      </div>
                      <div className="p-1.5 rounded border bg-background/50">
                        <span className="text-muted-foreground text-[10px]">ZIP Packages Created</span>
                        <div className="font-semibold text-xs text-green-600">
                          {bundleResult.zipsCreated}
                        </div>
                      </div>
                    </div>

                    <Button
                      size="sm"
                      className="w-full h-7 text-xs font-medium gap-1"
                      onClick={() => setActiveTab("backup")}
                    >
                      <span>Proceed to Stage 5: Backup Target Server</span>
                      <IconArrowRight className="size-3" />
                    </Button>
                  </CardContent>
                </Card>
              )}

              {activeTab === "backup" && backupResult && (
                <Card className="border-green-500/30 bg-green-500/5 shadow-xs gap-0 py-0">
                  <CardContent className="p-3 space-y-2.5">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-1.5">
                        <IconCircleCheck className="size-4 text-green-600 dark:text-green-400" />
                        <span className="font-semibold text-xs text-foreground">
                          Backup Completed
                        </span>
                      </div>
                      <Badge variant="secondary" className="text-[10px] font-mono py-0 h-4">
                        {backupResult.projectsBackedUp} projects backed up
                      </Badge>
                    </div>

                    <div className="grid grid-cols-2 gap-2 text-xs">
                      <div className="p-1.5 rounded border bg-background/50">
                        <span className="text-muted-foreground text-[10px]">Projects Processed</span>
                        <div className="font-semibold text-xs">{backupResult.projectsProcessed}</div>
                      </div>
                      <div className="p-1.5 rounded border bg-background/50">
                        <span className="text-muted-foreground text-[10px]">Errors</span>
                        <div
                          className={cn(
                            "font-semibold text-xs",
                            backupResult.errors.length > 0 ? "text-destructive" : "text-green-600"
                          )}
                        >
                          {backupResult.errors.length}
                        </div>
                      </div>
                    </div>

                    <div className="p-1.5 rounded border bg-background/50 text-[10px] font-mono break-all">
                      SystemRepository{backupResult.backupDir}
                    </div>

                    <Button
                      size="sm"
                      className="w-full h-7 text-xs font-medium gap-1"
                      onClick={() => {
                        if (backupEnv && !uploadEnv) setUploadEnv(backupEnv);
                        setActiveTab("upload");
                      }}
                    >
                      <span>Proceed to Stage 6: Upload to SystemRepository</span>
                      <IconArrowRight className="size-3" />
                    </Button>
                  </CardContent>
                </Card>
              )}

              {activeTab === "upload" && uploadResult && (
                <Card className="border-green-500/30 bg-green-500/5 shadow-xs gap-0 py-0">
                  <CardContent className="p-3 space-y-2.5">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-1.5">
                        <IconCircleCheck className="size-4 text-green-600 dark:text-green-400" />
                        <span className="font-semibold text-xs text-foreground">
                          Upload Completed
                        </span>
                      </div>
                      <Badge variant="secondary" className="text-[10px] font-mono py-0 h-4">
                        {uploadResult.filesUploaded} files uploaded
                      </Badge>
                    </div>

                    <div className="grid grid-cols-3 gap-1.5 text-xs">
                      <div className="p-1.5 rounded border bg-background/50">
                        <span className="text-muted-foreground text-[10px]">Uploaded</span>
                        <div className="font-semibold text-xs">{uploadResult.filesUploaded}</div>
                      </div>
                      <div className="p-1.5 rounded border bg-background/50">
                        <span className="text-muted-foreground text-[10px]">ZIPs Extracted</span>
                        <div className="font-semibold text-xs text-green-600">
                          {uploadResult.zipsExtracted}
                        </div>
                      </div>
                      <div className="p-1.5 rounded border bg-background/50">
                        <span className="text-muted-foreground text-[10px]">Errors</span>
                        <div
                          className={cn(
                            "font-semibold text-xs",
                            uploadResult.errors.length > 0 ? "text-destructive" : "text-green-600"
                          )}
                        >
                          {uploadResult.errors.length}
                        </div>
                      </div>
                    </div>

                    <div className="p-1.5 rounded border bg-background/50 text-[10px] font-mono break-all">
                      SystemRepository{uploadResult.targetDir}
                    </div>
                  </CardContent>
                </Card>
              )}

              {/* Real-time Terminal Card */}
              <Card className="border-border/60 shadow-xs overflow-hidden flex flex-col gap-0 py-0">
                {/* Console Header Bar */}
                <div className="flex flex-wrap items-center justify-between gap-1.5 px-3 py-1.5 border-b bg-muted/40">
                  <div className="flex items-center gap-2">
                    <IconTerminal2 className="size-3.5 text-muted-foreground" />
                    <span className="text-xs font-medium">Live Execution Console</span>
                    {currentRunning ? (
                      <span className="flex items-center gap-1 text-[10px] text-amber-600 dark:text-amber-400 font-mono">
                        <span className="size-1.5 rounded-full bg-amber-500 animate-pulse" />
                        streaming
                      </span>
                    ) : currentLogs.length > 0 ? (
                      <span className="flex items-center gap-1 text-[10px] text-green-600 dark:text-green-400 font-mono">
                        <span className="size-1.5 rounded-full bg-green-500" />
                        completed
                      </span>
                    ) : (
                      <span className="text-[10px] text-muted-foreground font-mono">idle</span>
                    )}
                  </div>

                  {/* Console Controls */}
                  <div className="flex items-center gap-1">
                    {/* Search in logs */}
                    {currentLogs.length > 0 && (
                      <div className="relative flex items-center">
                        <IconSearch className="size-3 text-muted-foreground absolute left-1.5 pointer-events-none" />
                        <input
                          type="text"
                          placeholder="Filter logs..."
                          value={searchQuery}
                          onChange={(e) => setSearchQuery(e.target.value)}
                          className="h-5 w-24 sm:w-28 pl-5 pr-1.5 rounded text-[10px] bg-background border border-border/60 focus:outline-none focus:ring-1 focus:ring-ring"
                        />
                      </div>
                    )}

                    {/* Add log to chat */}
                    {currentLogs.length > 0 && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-5 px-1 text-xs text-muted-foreground hover:text-foreground"
                        onClick={pinLog}
                        title="Add to chat"
                        aria-label="Add log to chat"
                      >
                        <IconMessagePlus className="size-3" />
                      </Button>
                    )}

                    {/* Copy logs */}
                    {currentLogs.length > 0 && (
                      <Tooltip>
                        <TooltipTrigger
                          render={
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-5 px-1 text-xs text-muted-foreground hover:text-foreground"
                              onClick={handleCopyLogs}
                            >
                              {copiedLog ? (
                                <IconCheck className="size-3 text-green-500" />
                              ) : (
                                <IconCopy className="size-3" />
                              )}
                            </Button>
                          }
                        />
                        <TooltipContent>{copiedLog ? "Copied!" : "Copy all logs"}</TooltipContent>
                      </Tooltip>
                    )}

                    {/* Clear logs */}
                    {currentLogs.length > 0 && !currentRunning && (
                      <Tooltip>
                        <TooltipTrigger
                          render={
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-5 px-1 text-xs text-muted-foreground hover:text-destructive"
                              onClick={handleClearLogs}
                            >
                              <IconTrash className="size-3" />
                            </Button>
                          }
                        />
                        <TooltipContent>Clear console</TooltipContent>
                      </Tooltip>
                    )}
                  </div>
                </div>

                {/* Console Log Body */}
                <div
                  ref={logContainerRef}
                  className="font-mono text-[11px] bg-zinc-950 text-zinc-300 p-3 h-[270px] overflow-y-auto select-text space-y-0.5"
                >
                  {filteredLogs.length === 0 ? (
                    <div className="h-full flex flex-col items-center justify-center text-center text-zinc-500 py-8">
                      <IconTerminal2 className="size-6 mb-1.5 opacity-40 stroke-1" />
                      <p className="text-[11px]">No execution output yet.</p>
                      <p className="text-[9px] mt-0.5 opacity-70">
                        Configure parameters on the left and click Run to start this stage.
                      </p>
                    </div>
                  ) : (
                    filteredLogs.map((entry) => {
                      const isDone = entry.kind === "done";
                      const isError = entry.kind === "error";
                      const isDryRun = entry.kind === "dryrun";

                      return (
                        <div
                          key={entry.id}
                          className={cn(
                            "leading-snug flex items-start gap-1.5 py-0.5 border-l-2 pl-1.5 transition-colors",
                            isDone &&
                              "border-green-500 bg-green-950/30 text-green-300 font-medium",
                            isError && "border-red-500 bg-red-950/30 text-red-300 font-medium",
                            isDryRun && "border-amber-500 text-amber-200/90",
                            !isDone && !isError && !isDryRun && "border-transparent text-zinc-300"
                          )}
                        >
                          <span className="text-zinc-500 text-[9px] shrink-0 select-none font-mono">
                            {entry.timestamp}
                          </span>
                          <span className="whitespace-pre-wrap break-all flex-1 text-[10px]">
                            {entry.text}
                          </span>
                        </div>
                      );
                    })
                  )}
                </div>

                {/* Console Footer Status */}
                <div className="flex items-center justify-between px-3 py-1 border-t bg-muted/20 text-[9px] text-muted-foreground font-mono">
                  <span>
                    {filteredLogs.length}{" "}
                    {filteredLogs.length === 1 ? "line" : "lines"}
                    {searchQuery ? ` (filtered from ${currentLogs.length})` : ""}
                  </span>
                  <span>Press Run to execute stage</span>
                </div>
              </Card>
            </div>
          </div>
        </div>
      </div>
    </TooltipProvider>
  );
}
