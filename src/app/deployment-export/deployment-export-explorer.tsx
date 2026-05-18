"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import {
  IconCloudUpload,
  IconPackageImport,
  IconSettings,
  IconX,
  IconInfoCircle,
  IconFolder,
  IconFileZip,
  IconChevronRight,
} from "@tabler/icons-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DirPicker } from "@/components/dir-picker";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  ExistingEnvCard,
  NewEnvCard,
  type EnvSetting,
  type ProjectConfig,
} from "@/app/settings/settings-form";

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
      } else {
        onMessage(line);
      }
    }
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

// ── Types ──────────────────────────────────────────────────────────────────

interface DeploymentExportResult {
  projectsProcessed: number;
  zipsSaved: number;
  savedFiles: string[];
  exportedDir: string;
  errors: string[];
}

interface DeploymentExtractResult {
  zipFilesProcessed: number;
  entitiesExtracted: number;
  entitiesSkipped: number;
  errors: string[];
}

// Groups savedFiles into { dir -> [zipName, ...] } for display
function groupSavedFiles(files: string[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const f of files) {
    const normalized = f.replace(/\\/g, "/");
    const lastSlash = normalized.lastIndexOf("/");
    const dir = lastSlash >= 0 ? normalized.slice(0, lastSlash) : ".";
    const file = lastSlash >= 0 ? normalized.slice(lastSlash + 1) : f;
    if (!map.has(dir)) map.set(dir, []);
    map.get(dir)!.push(file);
  }
  return map;
}

interface DeploymentExportExplorerProps {
  initialEnvs: EnvSetting[];
}

// ── Main component ─────────────────────────────────────────────────────────

export function DeploymentExportExplorer({ initialEnvs }: DeploymentExportExplorerProps) {
  const router = useRouter();

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

  // ── Export toolbar state ──────────────────────────────────────────────────
  const [selectedEnv, setSelectedEnv] = useState(initialEnvs[0]?.environment ?? "");
  const [selectedProject, setSelectedProject] = useState("__all__");
  const [customProject, setCustomProject] = useState("");
  const [parentDir, setParentDir] = useState("");
  const [suffix, setSuffix] = useState("");
  const [outputDir, setOutputDir] = useState("./export");
  const [dryRun, setDryRun] = useState(false);

  // ── Export status ─────────────────────────────────────────────────────────
  const [exportStatus, setExportStatus] = useState<"idle" | "exporting" | "done" | "error">("idle");
  const [exportMessages, setExportMessages] = useState<string[]>([]);
  const [exportResult, setExportResult] = useState<DeploymentExportResult | null>(null);
  const [lastExported, setLastExported] = useState<string | null>(null);

  // ── Extract toolbar state ─────────────────────────────────────────────────
  const [extractInputDir, setExtractInputDir] = useState("");
  const [extractOutputDir, setExtractOutputDir] = useState("./WindchillClients/ThingWorx");
  const [extractDryRun, setExtractDryRun] = useState(false);
  const [extractStatus, setExtractStatus] = useState<"idle" | "extracting" | "done" | "error">("idle");
  const [extractMessages, setExtractMessages] = useState<string[]>([]);
  const [extractResult, setExtractResult] = useState<DeploymentExtractResult | null>(null);
  const [lastExtracted, setLastExtracted] = useState<string | null>(null);

  // ── Scroll refs ───────────────────────────────────────────────────────────
  const exportProgressRef = useRef<HTMLDivElement>(null);
  const extractProgressRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    exportProgressRef.current?.scrollTo(0, exportProgressRef.current.scrollHeight);
  }, [exportMessages]);

  useEffect(() => {
    extractProgressRef.current?.scrollTo(0, extractProgressRef.current.scrollHeight);
  }, [extractMessages]);

  // ── Persistence ───────────────────────────────────────────────────────────
  const hasMountedRef = useRef(false);

  useEffect(() => {
    try {
      const raw = localStorage.getItem("singl:deploy-export");
      if (!raw) return;
      const s = JSON.parse(raw) as {
        selectedEnv?: string;
        selectedProject?: string;
        customProject?: string;
        parentDir?: string;
        suffix?: string;
        outputDir?: string;
        dryRun?: boolean;
        extractInputDir?: string;
        extractOutputDir?: string;
        extractDryRun?: boolean;
      };
      if (s.selectedEnv && initialEnvs.find((e) => e.environment === s.selectedEnv)) {
        setSelectedEnv(s.selectedEnv);
      }
      if (s.selectedProject) setSelectedProject(s.selectedProject);
      if (typeof s.customProject === "string") setCustomProject(s.customProject);
      if (typeof s.parentDir === "string") setParentDir(s.parentDir);
      if (typeof s.suffix === "string") setSuffix(s.suffix);
      if (typeof s.outputDir === "string") setOutputDir(s.outputDir);
      if (typeof s.dryRun === "boolean") setDryRun(s.dryRun);
      if (typeof s.extractInputDir === "string") setExtractInputDir(s.extractInputDir);
      if (typeof s.extractOutputDir === "string") setExtractOutputDir(s.extractOutputDir);
      if (typeof s.extractDryRun === "boolean") setExtractDryRun(s.extractDryRun);
    } catch {}
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    try {
      const raw = localStorage.getItem("singl:deploy-export:ts");
      if (!raw) return;
      const s = JSON.parse(raw) as { lastExported?: string; lastExtracted?: string };
      if (s.lastExported) setLastExported(s.lastExported);
      if (s.lastExtracted) setLastExtracted(s.lastExtracted);
    } catch {}
  }, []);

  useEffect(() => {
    if (!hasMountedRef.current) {
      hasMountedRef.current = true;
      return;
    }
    try {
      localStorage.setItem(
        "singl:deploy-export",
        JSON.stringify({
          selectedEnv, selectedProject, customProject,
          parentDir, suffix, outputDir, dryRun,
          extractInputDir, extractOutputDir, extractDryRun,
        })
      );
    } catch {}
  }, [selectedEnv, selectedProject, customProject, parentDir, suffix, outputDir, dryRun, extractInputDir, extractOutputDir, extractDryRun]);

  // ── Export handler ────────────────────────────────────────────────────────
  const handleExport = async () => {
    const envRecord = envs.find((e) => e.environment === selectedEnv);
    if (!envRecord?.hasAppKey) return;

    setExportStatus("exporting");
    setExportMessages([]);
    setExportResult(null);

    const projectFilter =
      selectedProject === "__all__"
        ? undefined
        : selectedProject === "__custom__"
        ? customProject.trim() || undefined
        : selectedProject;

    try {
      const res = await fetch("/api/twx/export-deploymentfiles", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          envName: selectedEnv,
          ...(projectFilter ? { projectName: projectFilter } : {}),
          ...(parentDir.trim() ? { parent: parentDir.trim() } : {}),
          ...(suffix.trim() ? { suffix: suffix.trim() } : {}),
          ...(outputDir.trim() ? { output: outputDir.trim() } : {}),
          dryRun,
        }),
      });

      await readStream(
        res,
        (msg) => setExportMessages((prev) => [...prev, msg]),
        (payload) => {
          const parsed = JSON.parse(payload || "{}") as DeploymentExportResult;
          setExportResult(parsed);
          setExportStatus("done");
          // Auto-fill extract input dir from the exported parent dir
          if (parsed.exportedDir) setExtractInputDir(parsed.exportedDir);
          const now = new Date().toISOString();
          setLastExported(now);
          try {
            const existing = JSON.parse(localStorage.getItem("singl:deploy-export:ts") ?? "{}") as { lastExtracted?: string };
            localStorage.setItem("singl:deploy-export:ts", JSON.stringify({ lastExported: now, lastExtracted: existing.lastExtracted ?? null }));
          } catch {}
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
    if (!selectedEnv || !extractInputDir.trim()) return;

    setExtractStatus("extracting");
    setExtractMessages([]);
    setExtractResult(null);

    try {
      const res = await fetch("/api/twx/extract-deploymentfiles", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          envName: selectedEnv,
          inputDir: extractInputDir.trim(),
          ...(extractOutputDir.trim() ? { output: extractOutputDir.trim() } : {}),
          dryRun: extractDryRun,
        }),
      });

      await readStream(
        res,
        (msg) => setExtractMessages((prev) => [...prev, msg]),
        (payload) => {
          const parsed = JSON.parse(payload || "{}") as DeploymentExtractResult;
          setExtractResult(parsed);
          setExtractStatus("done");
          const now = new Date().toISOString();
          setLastExtracted(now);
          try {
            const existing = JSON.parse(localStorage.getItem("singl:deploy-export:ts") ?? "{}") as { lastExported?: string };
            localStorage.setItem("singl:deploy-export:ts", JSON.stringify({ lastExported: existing.lastExported ?? null, lastExtracted: now }));
          } catch {}
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
  const canExport =
    !!selectedEnv &&
    !!selectedEnvRecord?.hasAppKey &&
    exportStatus !== "exporting" &&
    (selectedProject !== "__custom__" || !!customProject.trim());
  const canExtract =
    !!selectedEnv &&
    !!extractInputDir.trim() &&
    extractStatus !== "extracting";

  const groupedFiles = exportResult?.savedFiles ? groupSavedFiles(exportResult.savedFiles) : null;

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col h-full overflow-y-auto">

      {/* ══ EXPORT SECTION ══════════════════════════════════════════════════ */}
      <div className="shrink-0 border-b bg-background px-4 py-2.5 flex flex-col gap-2">

        {/* Section heading */}
        <div className="flex items-center gap-2">
          <IconCloudUpload className="size-4 text-muted-foreground" />
          <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Export</span>
        </div>

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

          <div className="h-6 w-px bg-border self-end mb-1 hidden sm:block" />

          {/* Parent directory */}
          <div className="flex flex-col gap-1">
            <Label className="text-xs text-muted-foreground">Parent dir</Label>
            <Input
              value={parentDir}
              onChange={(e) => setParentDir(e.target.value)}
              placeholder="auto (timestamp)"
              className="h-8 text-sm w-44"
            />
          </div>

          {/* Suffix */}
          <div className="flex flex-col gap-1">
            <Label className="text-xs text-muted-foreground">Suffix</Label>
            <Input
              value={suffix}
              onChange={(e) => setSuffix(e.target.value)}
              placeholder="optional"
              className="h-8 text-sm w-32"
            />
          </div>

          {/* Output directory */}
          <div className="flex flex-col gap-1">
            <Label className="text-xs text-muted-foreground">Output dir</Label>
            <DirPicker
              value={outputDir}
              onChange={setOutputDir}
              placeholder="./export"
              startFrom="export"
              inputClassName="w-36"
            />
          </div>

          <div className="h-6 w-px bg-border self-end mb-1 hidden sm:block" />

          {/* Dry-run */}
          <div className="flex flex-col gap-1">
            <Label className="text-xs text-muted-foreground">Dry run</Label>
            <div className="h-8 flex items-center">
              <Switch checked={dryRun} onCheckedChange={setDryRun} aria-label="Dry run" />
            </div>
          </div>

          {/* Export button */}
          <div className="flex flex-col gap-1">
            <Label className="text-xs text-muted-foreground invisible">&nbsp;</Label>
            <Button
              size="sm"
              onClick={handleExport}
              disabled={!canExport}
              className="h-8 gap-1.5 whitespace-nowrap"
            >
              {exportStatus === "exporting" ? <Spinner className="size-3.5" /> : <IconCloudUpload className="size-3.5" />}
              {exportStatus === "exporting" ? "Exporting…" : dryRun ? "Dry Run" : "Export"}
            </Button>
          </div>

          {/* Info tooltip */}
          <div className="flex flex-col gap-1">
            <Label className="text-xs text-muted-foreground invisible">&nbsp;</Label>
            <Tooltip>
              <TooltipTrigger className="h-8 w-8 flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-accent/40 transition-colors border border-transparent">
                <IconInfoCircle className="size-4" />
              </TooltipTrigger>
              <TooltipContent side="bottom">
                <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-0.5 text-left">
                  <span className="opacity-70">Last exported</span>
                  <span>{fmtTimestamp(lastExported)}</span>
                  <span className="opacity-70">Last extracted</span>
                  <span>{fmtTimestamp(lastExtracted)}</span>
                </div>
              </TooltipContent>
            </Tooltip>
          </div>
        </div>

        {/* Missing app key warning */}
        {selectedEnvRecord && !selectedEnvRecord.hasAppKey && (
          <p className="text-xs text-amber-600 dark:text-amber-400">
            No App Key configured for &quot;{selectedEnv}&quot;. Open Manage Environments to add one.
          </p>
        )}

        {/* Env manager */}
        {showEnvManager && (
          <div className="flex flex-col gap-2 pt-1 border-t mt-1 overflow-y-auto max-h-72">
            {envs.map((s) => (
              <ExistingEnvCard
                key={`${s.environment}:${s.twxBaseUrl}:${s.hasAppKey}`}
                setting={s}
                onSuccess={handleEnvSuccess}
              />
            ))}
            {showNewEnvForm ? (
              <NewEnvCard onCancel={handleNewEnvCancel} onSuccess={handleNewEnvSuccess} />
            ) : (
              <Button variant="outline" size="sm" onClick={() => setShowNewEnvForm(true)} className="self-start h-7 text-xs">
                + Add Configuration
              </Button>
            )}
          </div>
        )}
      </div>

      {/* ── Export output ────────────────────────────────────────────────────── */}
      {exportMessages.length > 0 && (
        <div className="shrink-0 border-b bg-muted/40 flex flex-col">
          <div className="flex items-center justify-between px-4 py-1 border-b border-border/40">
            <span className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide select-none">Export Output</span>
            <button
              onClick={() => { setExportMessages([]); if (exportStatus !== "exporting") setExportStatus("idle"); }}
              disabled={exportStatus === "exporting"}
              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground disabled:opacity-40 transition-colors"
            >
              <IconX className="size-3" /> Clear
            </button>
          </div>
          <div ref={exportProgressRef} className="max-h-40 overflow-y-auto px-4 py-1.5">
            {exportMessages.map((msg, i) => (
              <p key={i} className={cn("text-xs font-mono",
                msg.startsWith("[WARN]") ? "text-amber-600 dark:text-amber-400"
                : exportStatus === "error" && i === exportMessages.length - 1 ? "text-destructive"
                : "text-muted-foreground"
              )}>
                {msg}
              </p>
            ))}
            {exportStatus === "done" && (
              <p className="text-xs text-emerald-600 dark:text-emerald-400 font-medium">
                {dryRun ? "Dry run complete." : "Export complete."}
              </p>
            )}
          </div>
        </div>
      )}

      {/* ── Export result summary + file listing ─────────────────────────────── */}
      {exportStatus === "done" && exportResult && (
        <div className="shrink-0 border-b bg-muted/20 px-4 py-3 flex flex-col gap-3">
          {/* Stats row */}
          <div className="flex flex-wrap gap-6">
            <div className="flex flex-col gap-0.5">
              <span className="text-[11px] text-muted-foreground uppercase tracking-wide">Projects</span>
              <span className="text-sm font-semibold">{exportResult.projectsProcessed}</span>
            </div>
            {!dryRun && (
              <div className="flex flex-col gap-0.5">
                <span className="text-[11px] text-muted-foreground uppercase tracking-wide">ZIPs saved</span>
                <span className="text-sm font-semibold text-emerald-600 dark:text-emerald-400">{exportResult.zipsSaved}</span>
              </div>
            )}
            {exportResult.errors.length > 0 && (
              <div className="flex flex-col gap-0.5">
                <span className="text-[11px] text-muted-foreground uppercase tracking-wide">Errors</span>
                <span className="text-sm font-semibold text-destructive">{exportResult.errors.length}</span>
              </div>
            )}
          </div>

          {/* Error list */}
          {exportResult.errors.length > 0 && (
            <div className="flex flex-col gap-1">
              {exportResult.errors.map((err, i) => (
                <p key={i} className="text-xs text-destructive font-mono">{err}</p>
              ))}
            </div>
          )}

          {/* File tree listing */}
          {groupedFiles && groupedFiles.size > 0 && (
            <div className="flex flex-col gap-1">
              <span className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide">Saved files</span>
              <div className="rounded-md border bg-muted/30 px-3 py-2 flex flex-col gap-1.5 text-xs font-mono">
                {Array.from(groupedFiles.entries()).map(([dir, files]) => (
                  <div key={dir}>
                    <div className="flex items-center gap-1.5 text-muted-foreground">
                      <IconChevronRight className="size-3 shrink-0 rotate-90" />
                      <IconFolder className="size-3.5 shrink-0 text-amber-500" />
                      <span className="truncate">{dir}</span>
                    </div>
                    {files.map((f) => (
                      <div key={f} className="flex items-center gap-1.5 pl-6 mt-0.5 text-foreground/80">
                        <IconFileZip className="size-3.5 shrink-0 text-blue-500" />
                        <span>{f}</span>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ══ EXTRACT SECTION ═════════════════════════════════════════════════ */}
      <div className="shrink-0 border-b bg-background px-4 py-2.5 flex flex-col gap-2">

        {/* Section heading */}
        <div className="flex items-center gap-2">
          <IconPackageImport className="size-4 text-muted-foreground" />
          <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Extract</span>
        </div>

        <div className="flex items-end gap-2 flex-wrap">

          {/* Input dir */}
          <div className="flex flex-col gap-1 flex-1 min-w-56">
            <Label className="text-xs text-muted-foreground">Input dir (parent folder with project ZIPs)</Label>
            <DirPicker
              value={extractInputDir}
              onChange={setExtractInputDir}
              placeholder="e.g. ./export/20260518-120000"
              startFrom="export"
              className="flex-1"
            />
          </div>

          {/* Output dir */}
          <div className="flex flex-col gap-1">
            <Label className="text-xs text-muted-foreground">Output dir</Label>
            <DirPicker
              value={extractOutputDir}
              onChange={setExtractOutputDir}
              placeholder="./WindchillClients/ThingWorx"
              inputClassName="w-52"
            />
          </div>

          <div className="h-6 w-px bg-border self-end mb-1 hidden sm:block" />

          {/* Dry-run */}
          <div className="flex flex-col gap-1">
            <Label className="text-xs text-muted-foreground">Dry run</Label>
            <div className="h-8 flex items-center">
              <Switch checked={extractDryRun} onCheckedChange={setExtractDryRun} aria-label="Extract dry run" />
            </div>
          </div>

          {/* Extract button */}
          <div className="flex flex-col gap-1">
            <Label className="text-xs text-muted-foreground invisible">&nbsp;</Label>
            <Button
              size="sm"
              variant="outline"
              onClick={handleExtract}
              disabled={!canExtract}
              className="h-8 gap-1.5 whitespace-nowrap"
            >
              {extractStatus === "extracting" ? <Spinner className="size-3.5" /> : <IconPackageImport className="size-3.5" />}
              {extractStatus === "extracting" ? "Extracting…" : extractDryRun ? "Dry Run" : "Extract"}
            </Button>
          </div>
        </div>
      </div>

      {/* ── Extract output ───────────────────────────────────────────────────── */}
      {extractMessages.length > 0 && (
        <div className="shrink-0 border-b bg-muted/40 flex flex-col">
          <div className="flex items-center justify-between px-4 py-1 border-b border-border/40">
            <span className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide select-none">Extract Output</span>
            <button
              onClick={() => { setExtractMessages([]); if (extractStatus !== "extracting") setExtractStatus("idle"); }}
              disabled={extractStatus === "extracting"}
              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground disabled:opacity-40 transition-colors"
            >
              <IconX className="size-3" /> Clear
            </button>
          </div>
          <div ref={extractProgressRef} className="max-h-40 overflow-y-auto px-4 py-1.5">
            {extractMessages.map((msg, i) => (
              <p key={i} className={cn("text-xs font-mono",
                msg.startsWith("[WARN]") ? "text-amber-600 dark:text-amber-400"
                : extractStatus === "error" && i === extractMessages.length - 1 ? "text-destructive"
                : "text-muted-foreground"
              )}>
                {msg}
              </p>
            ))}
            {extractStatus === "done" && (
              <p className="text-xs text-emerald-600 dark:text-emerald-400 font-medium">
                {extractDryRun ? "Dry run complete." : "Extract complete."}
              </p>
            )}
          </div>
        </div>
      )}

      {/* ── Extract result summary ───────────────────────────────────────────── */}
      {extractStatus === "done" && extractResult && (
        <div className="shrink-0 border-b bg-muted/20 px-4 py-3 flex flex-wrap gap-6">
          <div className="flex flex-col gap-0.5">
            <span className="text-[11px] text-muted-foreground uppercase tracking-wide">ZIPs processed</span>
            <span className="text-sm font-semibold">{extractResult.zipFilesProcessed}</span>
          </div>
          <div className="flex flex-col gap-0.5">
            <span className="text-[11px] text-muted-foreground uppercase tracking-wide">Entities extracted</span>
            <span className="text-sm font-semibold text-emerald-600 dark:text-emerald-400">{extractResult.entitiesExtracted}</span>
          </div>
          {extractResult.entitiesSkipped > 0 && (
            <div className="flex flex-col gap-0.5">
              <span className="text-[11px] text-muted-foreground uppercase tracking-wide">Skipped</span>
              <span className="text-sm font-semibold text-amber-600 dark:text-amber-400">{extractResult.entitiesSkipped}</span>
            </div>
          )}
          {extractResult.errors.length > 0 && (
            <div className="flex flex-col gap-0.5">
              <span className="text-[11px] text-muted-foreground uppercase tracking-wide">Errors</span>
              <span className="text-sm font-semibold text-destructive">{extractResult.errors.length}</span>
            </div>
          )}
          {extractResult.errors.length > 0 && (
            <div className="flex flex-col gap-1 w-full">
              {extractResult.errors.map((err, i) => (
                <p key={i} className="text-xs text-destructive font-mono">{err}</p>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── Empty state ──────────────────────────────────────────────────────── */}
      {exportStatus === "idle" && exportMessages.length === 0 && extractMessages.length === 0 && (
        <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground gap-3 py-12">
          <IconCloudUpload className="size-10 opacity-20" />
          {envs.length === 0 ? (
            <p className="text-sm">No environments configured. Click &quot;Manage Environments&quot; to add one.</p>
          ) : (
            <div className="flex flex-col items-center gap-1">
              <p className="text-sm">Configure options above and click Export.</p>
              <p className="text-xs opacity-60">ZIPs are saved to the TWX SystemRepository and downloaded locally. Use Extract to unpack them.</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
