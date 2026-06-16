"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { IconLoader2, IconPlayerPlay } from "@tabler/icons-react";
import { cn } from "@/lib/utils";
import { DirBrowser } from "@/components/dir-browser";

interface Project {
  key: string;
  alias: string;
}

interface BundleProject {
  alias: string;
  projectName: string;
}

interface DeployExplorerProps {
  envs: string[];
  projects: Project[];
  bundleProjects: BundleProject[];
  bundleSrcDir: string;
  bundleDestDir: string;
}

type LogEntry = { text: string; kind: "info" | "done" | "error" };

function LogOutput({ entries }: { entries: LogEntry[] }) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [entries.length]);

  return (
    <div
      ref={containerRef}
      className="font-mono text-xs bg-muted/30 rounded-md border p-3 h-64 overflow-y-auto"
    >
      {entries.length === 0 ? (
        <span className="text-muted-foreground">Output will appear here…</span>
      ) : (
        entries.map((e, i) => (
          <div
            key={i}
            className={cn(
              "leading-relaxed whitespace-pre-wrap break-all",
              e.kind === "done" && "text-green-600 dark:text-green-400 font-medium",
              e.kind === "error" && "text-destructive font-medium"
            )}
          >
            {e.text}
          </div>
        ))
      )}
    </div>
  );
}

async function readSSE(response: Response, onMessage: (msg: string) => void) {
  const reader = response.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const chunks = buf.split("\n\n");
    buf = chunks.pop() ?? "";
    for (const chunk of chunks) {
      const line = chunk.trim();
      if (line.startsWith("data: ")) onMessage(line.slice(6));
    }
  }
}

function classifyMessage(msg: string): LogEntry["kind"] {
  if (msg.startsWith("[DONE]")) return "done";
  if (msg.startsWith("[ERROR]")) return "error";
  return "info";
}

const ALL_PROJECTS = "__all__";

export function DeployExplorer({ envs, projects, bundleProjects, bundleSrcDir, bundleDestDir }: DeployExplorerProps) {
  // Export deployment files state
  const [exportEnv, setExportEnv] = useState("");
  const [exportParent, setExportParent] = useState("");
  const [exportSuffix, setExportSuffix] = useState("");
  const [exportProject, setExportProject] = useState(ALL_PROJECTS);
  const [exportDryRun, setExportDryRun] = useState(false);
  const [exportRunning, setExportRunning] = useState(false);
  const [exportLog, setExportLog] = useState<LogEntry[]>([]);

  // Extract deployment files state
  const [extractInput, setExtractInput] = useState("");
  const [extractOutput, setExtractOutput] = useState("");
  const [extractProject, setExtractProject] = useState(ALL_PROJECTS);
  const [extractDryRun, setExtractDryRun] = useState(false);
  const [extractRunning, setExtractRunning] = useState(false);
  const [extractLog, setExtractLog] = useState<LogEntry[]>([]);

  // Bundle state
  const [bundleSrc, setBundleSrc] = useState(bundleSrcDir);
  const [bundleDest, setBundleDest] = useState(bundleDestDir);
  const [bundleProject, setBundleProject] = useState(ALL_PROJECTS);
  const [bundleDryRun, setBundleDryRun] = useState(false);
  const [bundleRunning, setBundleRunning] = useState(false);
  const [bundleLog, setBundleLog] = useState<LogEntry[]>([]);

  const appendExportLog = useCallback((msg: string) => {
    setExportLog((prev) => [...prev, { text: msg, kind: classifyMessage(msg) }]);
  }, []);

  const appendExtractLog = useCallback((msg: string) => {
    setExtractLog((prev) => [...prev, { text: msg, kind: classifyMessage(msg) }]);
  }, []);

  const appendBundleLog = useCallback((msg: string) => {
    setBundleLog((prev) => [...prev, { text: msg, kind: classifyMessage(msg) }]);
  }, []);

  const handleExport = useCallback(async () => {
    setExportRunning(true);
    setExportLog([]);

    const flags: Record<string, string | boolean> = {};
    if (exportEnv) flags.env = exportEnv;
    if (exportParent) flags.parent = exportParent;
    if (exportSuffix) flags.suffix = exportSuffix;
    if (exportProject !== ALL_PROJECTS) flags.project = exportProject;
    if (exportDryRun) flags["dry-run"] = true;

    try {
      const res = await fetch("/api/twx/export-deploymentfiles", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(flags),
      });
      if (!res.ok || !res.body) {
        appendExportLog(`[ERROR] HTTP ${res.status}: ${res.statusText}`);
        return;
      }
      await readSSE(res, appendExportLog);
    } catch (err) {
      appendExportLog(`[ERROR] ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setExportRunning(false);
    }
  }, [exportEnv, exportParent, exportSuffix, exportProject, exportDryRun, appendExportLog]);

  const handleExtract = useCallback(async () => {
    setExtractRunning(true);
    setExtractLog([]);

    const flags: Record<string, string | boolean> = {};
    if (extractInput) flags.input = extractInput;
    if (extractOutput) flags.output = extractOutput;
    if (extractProject !== ALL_PROJECTS) flags.project = extractProject;
    if (extractDryRun) flags["dry-run"] = true;

    try {
      const res = await fetch("/api/twx/extract-deploymentfiles", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(flags),
      });
      if (!res.ok || !res.body) {
        appendExtractLog(`[ERROR] HTTP ${res.status}: ${res.statusText}`);
        return;
      }
      await readSSE(res, appendExtractLog);
    } catch (err) {
      appendExtractLog(`[ERROR] ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setExtractRunning(false);
    }
  }, [extractInput, extractOutput, extractProject, extractDryRun, appendExtractLog]);

  const handleBundle = useCallback(async () => {
    setBundleRunning(true);
    setBundleLog([]);

    const flags: Record<string, string | boolean> = {};
    if (bundleSrc) flags.src = bundleSrc;
    if (bundleDest) flags.dest = bundleDest;
    if (bundleProject !== ALL_PROJECTS) flags.project = bundleProject;
    if (bundleDryRun) flags["dry-run"] = true;

    try {
      const res = await fetch("/api/twx-cli/bundle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(flags),
      });
      if (!res.ok || !res.body) {
        appendBundleLog(`[ERROR] HTTP ${res.status}: ${res.statusText}`);
        return;
      }
      await readSSE(res, appendBundleLog);
    } catch (err) {
      appendBundleLog(`[ERROR] ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBundleRunning(false);
    }
  }, [bundleSrc, bundleDest, bundleProject, bundleDryRun, appendBundleLog]);

  return (
    <div className="flex flex-col flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-2xl px-4 py-8">
        <div className="mb-4">
          <h1 className="text-base font-semibold">Deploy</h1>
          <p className="text-xs text-muted-foreground mt-0.5">
            Export deployment ZIPs from ThingWorx and extract them into WindchillClients.
          </p>
        </div>

        <Tabs defaultValue="export">
          <TabsList variant="line" className="mb-6">
            <TabsTrigger value="export">Export Deployment Files</TabsTrigger>
            <TabsTrigger value="extract">Extract Deployment Files</TabsTrigger>
            <TabsTrigger value="bundle">Bundle</TabsTrigger>
          </TabsList>

          {/* ── Export tab ─────────────────────────────────────────────────── */}
          <TabsContent value="export">
            <div className="space-y-5">
              <div className="grid gap-4">
                <div className="grid gap-1.5">
                  <Label className="text-xs">Environment</Label>
                  <Select
                    value={exportEnv}
                    onValueChange={(v) => setExportEnv(v ?? "")}
                    disabled={exportRunning}
                  >
                    <SelectTrigger className="h-8 text-xs">
                      <SelectValue placeholder="None — use TWX_BASE_URL / TWX_APP_KEY env vars" />
                    </SelectTrigger>
                    <SelectContent>
                      {envs.map((e) => (
                        <SelectItem key={e} value={e}>
                          {e}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-[11px] text-muted-foreground">
                    <code className="font-mono">--env</code> — load credentials from the app
                    database (configured in Settings).
                  </p>
                </div>

                <div className="grid gap-1.5">
                  <Label className="text-xs">Parent directory</Label>
                  <Input
                    className="h-8 text-xs"
                    placeholder="Auto timestamp (YYYYMMDD-HHmmss)"
                    value={exportParent}
                    onChange={(e) => setExportParent(e.target.value)}
                    disabled={exportRunning}
                  />
                  <p className="text-[11px] text-muted-foreground">
                    <code className="font-mono">--parent</code> — shared parent folder name in
                    SystemRepository and locally.
                  </p>
                </div>

                <div className="grid gap-1.5">
                  <Label className="text-xs">Suffix</Label>
                  <Input
                    className="h-8 text-xs"
                    placeholder="e.g. RC1, v1.0"
                    value={exportSuffix}
                    onChange={(e) => setExportSuffix(e.target.value)}
                    disabled={exportRunning}
                  />
                  <p className="text-[11px] text-muted-foreground">
                    <code className="font-mono">--suffix</code> — text appended to each project
                    folder and ZIP name.
                  </p>
                </div>

                <div className="grid gap-1.5">
                  <Label className="text-xs">Project filter</Label>
                  <Select
                    value={exportProject}
                    onValueChange={(v) => setExportProject(v ?? ALL_PROJECTS)}
                    disabled={exportRunning}
                  >
                    <SelectTrigger className="h-8 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={ALL_PROJECTS}>All projects</SelectItem>
                      {projects.map((p) => (
                        <SelectItem key={p.key} value={p.key}>
                          {p.alias}
                          <span className="ml-1.5 text-muted-foreground font-mono text-[10px]">
                            {p.key}
                          </span>
                        </SelectItem>
                      ))}
                      {projects.length === 0 && (
                        <SelectItem value={ALL_PROJECTS} disabled>
                          No projects in manifest
                        </SelectItem>
                      )}
                    </SelectContent>
                  </Select>
                  <p className="text-[11px] text-muted-foreground">
                    <code className="font-mono">--project</code> — populated from{" "}
                    <code className="font-mono">manifest.twx.json</code>.
                  </p>
                </div>

                <div className="flex items-center gap-2">
                  <input
                    id="export-dry-run"
                    type="checkbox"
                    checked={exportDryRun}
                    onChange={(e) => setExportDryRun(e.target.checked)}
                    disabled={exportRunning}
                    className="size-3.5 rounded border accent-primary"
                  />
                  <Label
                    htmlFor="export-dry-run"
                    className="text-xs cursor-pointer select-none"
                  >
                    Dry run — preview only, no API calls or files written
                  </Label>
                </div>
              </div>

              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  className="h-8"
                  onClick={handleExport}
                  disabled={exportRunning}
                >
                  {exportRunning ? (
                    <IconLoader2 className="size-3.5 animate-spin mr-1.5" />
                  ) : (
                    <IconPlayerPlay className="size-3.5 mr-1.5" />
                  )}
                  {exportRunning ? "Running…" : "Run export-deploymentfiles"}
                </Button>
                {exportLog.length > 0 && !exportRunning && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-8"
                    onClick={() => setExportLog([])}
                  >
                    Clear
                  </Button>
                )}
              </div>

              {exportLog.length > 0 && <LogOutput entries={exportLog} />}
            </div>
          </TabsContent>

          {/* ── Extract tab ────────────────────────────────────────────────── */}
          <TabsContent value="extract">
            <div className="space-y-5">
              <div className="grid gap-4">
                <div className="grid gap-1.5">
                  <Label className="text-xs">
                    Input directory{" "}
                    <span className="text-destructive" aria-hidden>
                      *
                    </span>
                  </Label>
                  <div className="flex items-center gap-1.5">
                    <Input
                      className="h-8 text-xs min-w-0"
                      placeholder="./dist/export/20260421-143000"
                      value={extractInput}
                      onChange={(e) => setExtractInput(e.target.value)}
                      disabled={extractRunning}
                    />
                    <DirBrowser
                      onSelect={setExtractInput}
                      initialPath={extractInput || "./dist/export"}
                      disabled={extractRunning}
                    />
                  </div>
                  <p className="text-[11px] text-muted-foreground">
                    <code className="font-mono">--input</code> — directory that directly contains
                    the project folders. Browse or type a custom path.
                  </p>
                </div>

                <div className="grid gap-1.5">
                  <Label className="text-xs">Output directory</Label>
                  <div className="flex items-center gap-1.5">
                    <Input
                      className="h-8 text-xs min-w-0"
                      placeholder="./WindchillClients/ThingWorx"
                      value={extractOutput}
                      onChange={(e) => setExtractOutput(e.target.value)}
                      disabled={extractRunning}
                    />
                    <DirBrowser
                      onSelect={setExtractOutput}
                      initialPath={extractOutput || "./WindchillClients"}
                      disabled={extractRunning}
                    />
                  </div>
                  <p className="text-[11px] text-muted-foreground">
                    <code className="font-mono">--output</code> — WindchillClients root to extract
                    into.
                  </p>
                </div>

                <div className="grid gap-1.5">
                  <Label className="text-xs">Project filter</Label>
                  <Select
                    value={extractProject}
                    onValueChange={(v) => setExtractProject(v ?? ALL_PROJECTS)}
                    disabled={extractRunning}
                  >
                    <SelectTrigger className="h-8 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={ALL_PROJECTS}>All projects</SelectItem>
                      {projects.map((p) => (
                        <SelectItem key={p.key} value={p.key}>
                          {p.alias}
                          <span className="ml-1.5 text-muted-foreground font-mono text-[10px]">
                            {p.key}
                          </span>
                        </SelectItem>
                      ))}
                      {projects.length === 0 && (
                        <SelectItem value={ALL_PROJECTS} disabled>
                          No projects in manifest
                        </SelectItem>
                      )}
                    </SelectContent>
                  </Select>
                  <p className="text-[11px] text-muted-foreground">
                    <code className="font-mono">--project</code> — populated from{" "}
                    <code className="font-mono">manifest.twx.json</code>.
                  </p>
                </div>

                <div className="flex items-center gap-2">
                  <input
                    id="extract-dry-run"
                    type="checkbox"
                    checked={extractDryRun}
                    onChange={(e) => setExtractDryRun(e.target.checked)}
                    disabled={extractRunning}
                    className="size-3.5 rounded border accent-primary"
                  />
                  <Label
                    htmlFor="extract-dry-run"
                    className="text-xs cursor-pointer select-none"
                  >
                    Dry run — preview only, no files written
                  </Label>
                </div>
              </div>

              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  className="h-8"
                  onClick={handleExtract}
                  disabled={extractRunning}
                >
                  {extractRunning ? (
                    <IconLoader2 className="size-3.5 animate-spin mr-1.5" />
                  ) : (
                    <IconPlayerPlay className="size-3.5 mr-1.5" />
                  )}
                  {extractRunning ? "Running…" : "Run extract-deploymentfiles"}
                </Button>
                {extractLog.length > 0 && !extractRunning && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-8"
                    onClick={() => setExtractLog([])}
                  >
                    Clear
                  </Button>
                )}
              </div>

              {extractLog.length > 0 && <LogOutput entries={extractLog} />}
            </div>
          </TabsContent>

          {/* ── Bundle tab ─────────────────────────────────────────────────── */}
          <TabsContent value="bundle">
            <div className="space-y-5">
              <div className="grid gap-4">
                <div className="grid gap-1.5">
                  <Label className="text-xs">Source directory</Label>
                  <div className="flex items-center gap-1.5">
                    <Input
                      className="h-8 text-xs min-w-0"
                      placeholder="./WindchillClients/Thingworx"
                      value={bundleSrc}
                      onChange={(e) => setBundleSrc(e.target.value)}
                      disabled={bundleRunning}
                    />
                    <DirBrowser
                      onSelect={setBundleSrc}
                      initialPath={bundleSrc || "./WindchillClients"}
                      disabled={bundleRunning}
                    />
                  </div>
                  <p className="text-[11px] text-muted-foreground">
                    <code className="font-mono">--src</code> — directory that contains one subfolder
                    per project alias (e.g.{" "}
                    <code className="font-mono">WindchillClients/Thingworx</code>).
                  </p>
                </div>

                <div className="grid gap-1.5">
                  <Label className="text-xs">Bundle destination directory</Label>
                  <div className="flex items-center gap-1.5">
                    <Input
                      className="h-8 text-xs min-w-0"
                      placeholder="./dist/bundles"
                      value={bundleDest}
                      onChange={(e) => setBundleDest(e.target.value)}
                      disabled={bundleRunning}
                    />
                    <DirBrowser
                      onSelect={setBundleDest}
                      initialPath={bundleDest || "./dist"}
                      disabled={bundleRunning}
                    />
                  </div>
                  <p className="text-[11px] text-muted-foreground">
                    <code className="font-mono">--dest</code> — output root. Each project is copied
                    to <code className="font-mono">dest/&#123;alias&#125;/</code>.
                  </p>
                </div>

                <div className="grid gap-1.5">
                  <Label className="text-xs">Project filter</Label>
                  <Select
                    value={bundleProject}
                    onValueChange={(v) => setBundleProject(v ?? ALL_PROJECTS)}
                    disabled={bundleRunning}
                  >
                    <SelectTrigger className="h-8 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={ALL_PROJECTS}>All projects</SelectItem>
                      {bundleProjects.map((p) => (
                        <SelectItem key={p.alias} value={p.alias}>
                          {p.alias}
                          <span className="ml-1.5 text-muted-foreground font-mono text-[10px]">
                            {p.projectName}
                          </span>
                        </SelectItem>
                      ))}
                      {bundleProjects.length === 0 && (
                        <SelectItem value={ALL_PROJECTS} disabled>
                          No projects configured in Settings
                        </SelectItem>
                      )}
                    </SelectContent>
                  </Select>
                  <p className="text-[11px] text-muted-foreground">
                    <code className="font-mono">--project</code> — populated from project settings in the database.
                  </p>
                </div>

                <div className="flex items-center gap-2">
                  <input
                    id="bundle-dry-run"
                    type="checkbox"
                    checked={bundleDryRun}
                    onChange={(e) => setBundleDryRun(e.target.checked)}
                    disabled={bundleRunning}
                    className="size-3.5 rounded border accent-primary"
                  />
                  <Label
                    htmlFor="bundle-dry-run"
                    className="text-xs cursor-pointer select-none"
                  >
                    Dry run — preview only, no files written
                  </Label>
                </div>
              </div>

              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  className="h-8"
                  onClick={handleBundle}
                  disabled={bundleRunning}
                >
                  {bundleRunning ? (
                    <IconLoader2 className="size-3.5 animate-spin mr-1.5" />
                  ) : (
                    <IconPlayerPlay className="size-3.5 mr-1.5" />
                  )}
                  {bundleRunning ? "Running…" : "Run bundle"}
                </Button>
                {bundleLog.length > 0 && !bundleRunning && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-8"
                    onClick={() => setBundleLog([])}
                  >
                    Clear
                  </Button>
                )}
              </div>

              {bundleLog.length > 0 && <LogOutput entries={bundleLog} />}
            </div>
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
