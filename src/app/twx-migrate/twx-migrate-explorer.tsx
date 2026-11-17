"use client";

import { useState, useCallback, useEffect, useMemo } from "react";
import { useAssistantContext } from "@/lib/assistant/context";
import dynamic from "next/dynamic";
import {
  IconArrowRight,
  IconArrowsExchange,
  IconCopy,
  IconAlertTriangle,
  IconCheck,
  IconRefresh,
  IconX,
  IconTrash,
  IconCode,
  IconAdjustments,
  IconSearch,
  IconDatabase,
  IconPencil,
  IconLayersLinked,
  IconInfoCircle,
  IconSparkles,
  IconPlus,
} from "@tabler/icons-react";
import { useTheme } from "@/components/providers";
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
import {
  Combobox,
  ComboboxInput,
  ComboboxContent,
  ComboboxList,
  ComboboxItem,
  ComboboxEmpty,
} from "@/components/ui/combobox";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
} from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { errorMessage } from "@/lib/settings";
import {
  deleteMembers,
  getEntityMembers,
  listMigrateEnvs,
  listMigrateFiles,
  moveMembers,
  type DeleteResult,
  type EntityFile,
  type MoveResult,
} from "@/lib/migrate";
import type { EntityMembers, MigrateMode } from "@/lib/twx/entity-migrate";

const DiffEditor = dynamic(() => import("@monaco-editor/react").then((m) => m.DiffEditor), {
  ssr: false,
  loading: () => (
    <div className="flex items-center justify-center h-full text-muted-foreground text-xs gap-2">
      <Spinner className="size-4" /> Loading diff…
    </div>
  ),
});

type SelectedKey = string; // "property:Name" | "service:Name"
const makeKey = (kind: "property" | "service", name: string): SelectedKey => `${kind}:${name}`;

/**
 * A predicate over member names for one filter query: a glob when the query has
 * wildcards in it, a plain substring match otherwise. It lives outside the
 * component so the memo that caches it is a single call — the React Compiler
 * cannot preserve memoization of a body that branches into several closures.
 */
function memberMatcher(query: string): (name: string) => boolean {
  if (!query) return () => true;
  const lower = query.toLowerCase();
  const substring = (name: string) => name.toLowerCase().includes(lower);
  if (!query.includes("*") && !query.includes("?")) return substring;
  const escaped = query
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  try {
    const regex = new RegExp(`^${escaped}$`, "i");
    return (name: string) => regex.test(name);
  } catch {
    // An escaped query can still be an invalid pattern — fall back rather than
    // let the filter throw on every keystroke.
    return substring;
  }
}

type MoveResponse = MoveResult;
type DeleteResponse = DeleteResult;

export function TwxMigrateExplorer() {
  const { resolvedTheme } = useTheme();
  const diffTheme = resolvedTheme === "dark" ? "vs-dark" : "light";

  // ─ Environment + files
  const [envs, setEnvs] = useState<string[]>([]);
  const [selectedEnv, setSelectedEnv] = useState<string>("");
  const [files, setFiles] = useState<EntityFile[]>([]);
  const [filesLoading, setFilesLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const list = await listMigrateEnvs();
        setEnvs(list);
        setSelectedEnv((cur) => cur || list[0] || "");
      } catch (e) {
        setError(errorMessage(e));
      }
    })();
  }, []);

  const fetchFiles = useCallback(async (env: string) => {
    if (!env) return;
    setFilesLoading(true);
    setError(null);
    setFiles([]);
    try {
      setFiles(await listMigrateFiles(env));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setFilesLoading(false);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (selectedEnv) fetchFiles(selectedEnv);
  }, [selectedEnv, fetchFiles]);

  // ─ Source / target selection
  const [sourceRel, setSourceRel] = useState<string>("");
  const [targetRel, setTargetRel] = useState<string>("");
  const [sourceInput, setSourceInput] = useState("");
  const [targetInput, setTargetInput] = useState("");

  const [sourceMembers, setSourceMembers] = useState<EntityMembers | null>(null);
  const [sourceMembersLoading, setSourceMembersLoading] = useState(false);

  const [targetMembers, setTargetMembers] = useState<EntityMembers | null>(null);
  const [targetMembersLoading, setTargetMembersLoading] = useState(false);

  const [selected, setSelected] = useState<Set<SelectedKey>>(new Set());
  const [renames, setRenames] = useState<Map<SelectedKey, string>>(new Map());
  const [editingRenameKey, setEditingRenameKey] = useState<SelectedKey | null>(null);
  const [memberFilter, setMemberFilter] = useState("");
  const [activeSourceTab, setActiveSourceTab] = useState<"all" | "properties" | "services" | "selected">("all");
  const [activeTargetTab, setActiveTargetTab] = useState<"staged" | "existing">("staged");

  // Load Source members
  const loadSourceMembers = useCallback(async (relPath: string) => {
    setSourceMembersLoading(true);
    setSourceMembers(null);
    setSelected(new Set());
    setRenames(new Map());
    setEditingRenameKey(null);
    setMemberFilter("");
    try {
      setSourceMembers(await getEntityMembers(relPath));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSourceMembersLoading(false);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (sourceRel) loadSourceMembers(sourceRel);
    else setSourceMembers(null);
  }, [sourceRel, loadSourceMembers]);

  // Load Target members (for live target inspection and pre-flight conflict detection)
  const loadTargetMembers = useCallback(async (relPath: string) => {
    if (!relPath) {
      setTargetMembers(null);
      return;
    }
    setTargetMembersLoading(true);
    try {
      setTargetMembers(await getEntityMembers(relPath));
    } catch {
      setTargetMembers(null);
    } finally {
      setTargetMembersLoading(false);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (targetRel) loadTargetMembers(targetRel);
    else setTargetMembers(null);
  }, [targetRel, loadTargetMembers]);

  const toggle = useCallback((k: SelectedKey) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(k)) {
        next.delete(k);
      } else {
        next.add(k);
      }
      return next;
    });
    setRenames((prev) => {
      if (!prev.has(k) || !selected.has(k)) return prev;
      const next = new Map(prev);
      next.delete(k);
      return next;
    });
  }, [selected]);

  const setRename = useCallback((k: SelectedKey, value: string) => {
    setRenames((prev) => {
      const next = new Map(prev);
      if (value.trim()) next.set(k, value.trim());
      else next.delete(k);
      return next;
    });
  }, []);

  // Swap Source & Target
  const swapEntities = useCallback(() => {
    const prevSource = sourceRel;
    const prevTarget = targetRel;
    setSourceRel(prevTarget);
    setTargetRel(prevSource);
    setSourceInput("");
    setTargetInput("");
    setSelected(new Set());
    setRenames(new Map());
  }, [sourceRel, targetRel]);

  // ─ Mode
  const [mode, setMode] = useState<MigrateMode>("copy");

  useAssistantContext({
    screen: "twx-migrate",
    title: "Migrate",
    summary: `${mode} from ${sourceRel || "?"} to ${targetRel || "?"} in ${selectedEnv || "?"}, ${selected.size} members selected`,
    data: { env: selectedEnv, source: sourceRel, target: targetRel, mode, renames: [...renames.entries()].slice(0, 30) },
    selection: { members: [...selected].slice(0, 100) },
  });

  // ─ Preview / commit
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<MoveResponse | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [overwrite, setOverwrite] = useState<Set<SelectedKey>>(new Set());
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  // ─ Delete-from-source
  const [deletePreview, setDeletePreview] = useState<DeleteResponse | null>(null);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);

  const selectedItems = useMemo(
    () =>
      Array.from(selected).map((k) => {
        const [kind, ...rest] = k.split(":");
        const name = rest.join(":");
        const newName = renames.get(k)?.trim();
        return {
          kind: kind as "property" | "service",
          name,
          ...(newName && newName !== name ? { newName } : {}),
        };
      }),
    [selected, renames]
  );

  // File helpers
  const fileLabel = (f: EntityFile) => `${f.name} · ${f.collection} · ${f.project}`;
  const findFile = useCallback((rel: string) => files.find((f) => f.relPath === rel), [files]);
  const sourceFile = findFile(sourceRel);
  const targetFile = findFile(targetRel);
  const sourceName = sourceFile?.name ?? "";
  const targetName = targetFile?.name ?? "";

  // Filtered Source & Target file dropdowns
  const filteredSource = useMemo(() => {
    if (!sourceInput) return files;
    const q = sourceInput.toLowerCase();
    return files.filter((f) => fileLabel(f).toLowerCase().includes(q));
  }, [files, sourceInput]);

  const filteredTarget = useMemo(() => {
    const list = files.filter((f) => f.relPath !== sourceRel);
    if (!targetInput) return list;
    const q = targetInput.toLowerCase();
    return list.filter((f) => fileLabel(f).toLowerCase().includes(q));
  }, [files, sourceRel, targetInput]);

  // Member rows & filter query
  const memberQuery = memberFilter.trim();

  const matchesMemberQuery = useMemo(() => memberMatcher(memberQuery), [memberQuery]);

  const allPropRows = useMemo(
    () =>
      (sourceMembers?.properties ?? []).map((name) => ({
        kind: "property" as const,
        name,
        k: makeKey("property", name),
      })),
    [sourceMembers]
  );

  const allServiceRows = useMemo(
    () =>
      (sourceMembers?.services ?? []).map((s) => ({
        kind: "service" as const,
        name: s.name,
        k: makeKey("service", s.name),
        hasImplementation: s.hasImplementation,
        warn: s.hasImplementation ? undefined : "signature only (no code)",
      })),
    [sourceMembers]
  );

  const filteredPropRows = useMemo(
    () => allPropRows.filter((r) => matchesMemberQuery(r.name)),
    [allPropRows, matchesMemberQuery]
  );

  const filteredServiceRows = useMemo(
    () => allServiceRows.filter((r) => matchesMemberQuery(r.name)),
    [allServiceRows, matchesMemberQuery]
  );

  const visibleRows = useMemo(() => {
    if (activeSourceTab === "properties") return filteredPropRows;
    if (activeSourceTab === "services") return filteredServiceRows;
    if (activeSourceTab === "selected") {
      return [...filteredPropRows, ...filteredServiceRows].filter((r) => selected.has(r.k));
    }
    return [...filteredPropRows, ...filteredServiceRows];
  }, [activeSourceTab, filteredPropRows, filteredServiceRows, selected]);

  const visibleKeys = useMemo(() => visibleRows.map((r) => r.k), [visibleRows]);
  const allVisibleSelected = visibleKeys.length > 0 && visibleKeys.every((k) => selected.has(k));

  const toggleAllVisible = () => {
    setSelected((prev) => {
      const next = new Set(prev);
      const everyOn = visibleKeys.length > 0 && visibleKeys.every((k) => next.has(k));
      if (everyOn) {
        visibleKeys.forEach((k) => next.delete(k));
      } else {
        visibleKeys.forEach((k) => next.add(k));
      }
      return next;
    });
  };

  const clearSelection = () => {
    setSelected(new Set());
    setRenames(new Map());
  };

  // Pre-flight conflict analysis with target entity
  const preflightConflicts = useMemo(() => {
    if (!targetMembers || selectedItems.length === 0) return [];
    const targetPropSet = new Set((targetMembers.properties ?? []).map((p) => p.toLowerCase()));
    const targetServSet = new Set((targetMembers.services ?? []).map((s) => s.name.toLowerCase()));

    const conflictsList: { item: typeof selectedItems[0]; targetName: string }[] = [];

    for (const item of selectedItems) {
      const finalName = item.newName || item.name;
      const lowerName = finalName.toLowerCase();
      if (item.kind === "property" && targetPropSet.has(lowerName)) {
        conflictsList.push({ item, targetName: finalName });
      } else if (item.kind === "service" && targetServSet.has(lowerName)) {
        conflictsList.push({ item, targetName: finalName });
      }
    }
    return conflictsList;
  }, [targetMembers, selectedItems]);

  // Run dry-run preview API
  const runPreview = useCallback(
    async (ov: Set<SelectedKey>) => {
      setBusy(true);
      setError(null);
      try {
        const data = await moveMembers({
            sourceRel,
            targetRel,
            items: selectedItems,
            mode,
            overwrite: Array.from(ov),
            commit: false,
          });
        setPreview(data);
      } catch (e) {
        setError(errorMessage(e));
      } finally {
        setBusy(false);
      }
    },
    [sourceRel, targetRel, selectedItems, mode]
  );

  const openPreview = useCallback(async () => {
    setOverwrite(new Set());
    setSuccessMsg(null);
    await runPreview(new Set());
    setDialogOpen(true);
  }, [runPreview]);

  const toggleOverwrite = useCallback(
    (k: SelectedKey) => {
      setOverwrite((prev) => {
        const next = new Set(prev);
        if (next.has(k)) next.delete(k);
        else next.add(k);
        runPreview(next);
        return next;
      });
    },
    [runPreview]
  );

  const commit = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const data = await moveMembers({
          sourceRel,
          targetRel,
          items: selectedItems,
          mode,
          overwrite: Array.from(overwrite),
          commit: true,
        });
      if (!data.committed) {
        setPreview(data);
        return;
      }
      const verb = mode === "move" ? "Moved" : "Copied";
      const n = data.members.filter((m) => m.status === "moved" || m.status === "copied").length;
      setSuccessMsg(`${verb} ${n} member${n === 1 ? "" : "s"} into ${targetName}. Deploy via bundler to push changes.`);
      setDialogOpen(false);
      setSelected(new Set());
      setRenames(new Map());

      // Refresh both source and target entities
      if (sourceRel) await loadSourceMembers(sourceRel);
      if (targetRel) await loadTargetMembers(targetRel);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }, [sourceRel, targetRel, selectedItems, mode, overwrite, loadSourceMembers, loadTargetMembers, targetName]);

  const openDelete = useCallback(async () => {
    setSuccessMsg(null);
    setBusy(true);
    setError(null);
    try {
      const data = await deleteMembers({ sourceRel, items: selectedItems, commit: false });
      setDeletePreview(data);
      setDeleteDialogOpen(true);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }, [sourceRel, selectedItems]);

  const commitDelete = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const data = await deleteMembers({ sourceRel, items: selectedItems, commit: true });
      const n = data.members.filter((m) => m.status === "moved").length;
      setSuccessMsg(`Permanently deleted ${n} member${n === 1 ? "" : "s"} from ${sourceName}. Deploy via bundler to push changes.`);
      setDeleteDialogOpen(false);
      setSelected(new Set());
      setRenames(new Map());
      if (sourceRel) loadSourceMembers(sourceRel);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }, [sourceRel, selectedItems, loadSourceMembers, sourceName]);

  const canPreview = Boolean(sourceRel && targetRel && sourceRel !== targetRel && selected.size > 0 && !busy);
  const canDelete = Boolean(sourceRel && selected.size > 0 && !busy);

  const conflicts = preview?.members.filter((m) => m.status === "conflict") ?? [];
  const allWarnings = preview?.members.flatMap((m) => m.warnings.map((w) => ({ name: m.name, w }))) ?? [];
  const deleteWarnings = deletePreview?.members.flatMap((m) => m.warnings.map((w) => ({ name: m.name, w }))) ?? [];

  const selectedPropsCount = useMemo(
    () => selectedItems.filter((i) => i.kind === "property").length,
    [selectedItems]
  );
  const selectedServicesCount = useMemo(
    () => selectedItems.filter((i) => i.kind === "service").length,
    [selectedItems]
  );

  return (
    <div className="h-full flex flex-col overflow-hidden bg-background text-foreground">
      {/* ── TOP HEADER ── */}
      <header className="px-5 py-3 border-b bg-card/60 backdrop-blur-xs flex items-center justify-between gap-4 flex-wrap shrink-0">
        <div className="flex items-center gap-3">
          <div className="size-8 rounded-lg bg-primary/10 text-primary flex items-center justify-center font-bold text-sm shadow-xs border border-primary/20">
            <IconArrowsExchange className="size-4" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-sm font-semibold tracking-tight">TWX Member Migration Studio</h1>
              <Badge variant="secondary" className="text-[10px] px-1.5 py-0 font-normal">
                XML AST Engine
              </Badge>
            </div>
            <p className="text-[11px] text-muted-foreground hidden sm:block">
              Transfer, rename, copy, or purge properties &amp; services across ThingWorx entity files.
            </p>
          </div>
        </div>

        {/* Environment Selector & Status */}
        <div className="flex items-center gap-2 ml-auto">
          <div className="flex items-center gap-2 bg-muted/40 px-2.5 py-1 rounded-md border text-xs">
            <IconDatabase className="size-3.5 text-muted-foreground shrink-0" />
            <span className="text-[11px] text-muted-foreground font-medium">Environment:</span>
            <Select
              value={selectedEnv}
              onValueChange={(v) => {
                if (v) setSelectedEnv(v);
              }}
            >
              <SelectTrigger className="h-6 w-36 text-xs bg-background border-muted shadow-none">
                <SelectValue placeholder="Select env…" />
              </SelectTrigger>
              <SelectContent>
                {envs.map((e) => (
                  <SelectItem key={e} value={e} className="text-xs">
                    {e}
                  </SelectItem>
                ))}
                {envs.length === 0 && (
                  <div className="px-2 py-1 text-xs text-muted-foreground">
                    No exported environments found.
                  </div>
                )}
              </SelectContent>
            </Select>

            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    size="icon"
                    variant="ghost"
                    className="size-6 text-muted-foreground hover:text-foreground"
                    onClick={() => fetchFiles(selectedEnv)}
                    disabled={!selectedEnv || filesLoading}
                  />
                }
              >
                <IconRefresh className={cn("size-3.5", filesLoading && "animate-spin")} />
              </TooltipTrigger>
              <TooltipContent>Reload entity files from disk</TooltipContent>
            </Tooltip>
          </div>
        </div>
      </header>

      {/* ── ERROR & SUCCESS BANNERS ── */}
      {error && (
        <div className="mx-4 mt-3 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive flex items-start justify-between gap-3 shadow-xs">
          <div className="flex items-center gap-2">
            <IconAlertTriangle className="size-4 shrink-0" />
            <span className="font-mono">{error}</span>
          </div>
          <Button
            size="icon"
            variant="ghost"
            className="size-5 shrink-0 text-destructive hover:bg-destructive/20"
            onClick={() => setError(null)}
          >
            <IconX className="size-3" />
          </Button>
        </div>
      )}

      {successMsg && (
        <div className="mx-4 mt-3 rounded-lg border border-emerald-500/40 bg-emerald-500/10 p-3 text-xs text-emerald-700 dark:text-emerald-300 flex items-center justify-between gap-3 shadow-xs">
          <div className="flex items-center gap-2">
            <IconCheck className="size-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
            <span>{successMsg}</span>
          </div>
          <Button
            size="icon"
            variant="ghost"
            className="size-5 shrink-0 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-500/20"
            onClick={() => setSuccessMsg(null)}
          >
            <IconX className="size-3" />
          </Button>
        </div>
      )}

      {/* ── WORKBENCH 3-COLUMN LAYOUT ── */}
      <div className="flex-1 grid grid-cols-1 lg:grid-cols-[1fr_270px_1fr] gap-4 p-4 min-h-0 overflow-hidden">
        {/* ─────────────────────────────────────────────────────────────
            COLUMN 1: SOURCE ENTITY WORKBENCH
        ───────────────────────────────────────────────────────────── */}
        <div className="flex flex-col min-h-0 border rounded-xl bg-card shadow-xs overflow-hidden">
          {/* Card Header & Entity Selector */}
          <div className="p-3.5 border-b bg-muted/20 flex flex-col gap-2.5">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Badge variant="default" className="text-[10px] font-semibold tracking-wide uppercase px-2 py-0.5">
                  Source
                </Badge>
                <span className="text-xs font-semibold text-foreground">Source Entity</span>
              </div>
              {sourceMembers && (
                <div className="flex items-center gap-1.5">
                  <Badge variant="outline" className="text-[10px] bg-background">
                    {sourceMembers.properties.length} Props
                  </Badge>
                  <Badge variant="outline" className="text-[10px] bg-background">
                    {sourceMembers.services.length} Services
                  </Badge>
                </div>
              )}
            </div>

            {/* Combobox Search */}
            <Combobox
              inputValue={sourceInput}
              onInputValueChange={setSourceInput}
              onValueChange={(v) => {
                if (v) setSourceRel(String(v));
              }}
            >
              <ComboboxInput
                placeholder={filesLoading ? "Loading entities…" : "Search source entity…"}
                showClear
                disabled={!selectedEnv || filesLoading}
                className="w-full h-8 text-xs bg-background"
              />
              <ComboboxContent>
                <ComboboxList>
                  {filteredSource.map((f) => (
                    <ComboboxItem key={f.relPath} value={f.relPath} className="text-xs">
                      <div className="flex flex-col">
                        <span className="font-medium">{f.name}</span>
                        <span className="text-[10px] text-muted-foreground">
                          {f.collection} · {f.project}
                        </span>
                      </div>
                    </ComboboxItem>
                  ))}
                  <ComboboxEmpty className="text-xs py-3">
                    {filesLoading ? "Loading…" : "No entities found."}
                  </ComboboxEmpty>
                </ComboboxList>
              </ComboboxContent>
            </Combobox>

            {/* Source Entity Info Card */}
            {sourceFile && (
              <div className="rounded-lg bg-background/80 border p-2 text-xs flex items-center justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <div className="font-semibold text-foreground truncate flex items-center gap-1.5">
                    <IconLayersLinked className="size-3.5 text-primary shrink-0" />
                    <span className="truncate">{sourceFile.name}</span>
                  </div>
                  <div className="text-[10px] text-muted-foreground flex items-center gap-2 mt-0.5">
                    <Badge variant="secondary" className="text-[9px] px-1 py-0 h-4">
                      {sourceFile.collection}
                    </Badge>
                    <span className="truncate">Project: {sourceFile.project}</span>
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Members Workspace */}
          <div className="flex-1 flex flex-col min-h-0 bg-card/40">
            {!sourceRel ? (
              <div className="flex-1 flex flex-col items-center justify-center p-6 text-center text-muted-foreground">
                <div className="size-10 rounded-full bg-muted/60 flex items-center justify-center mb-2">
                  <IconSearch className="size-5 text-muted-foreground/60" />
                </div>
                <p className="text-xs font-medium text-foreground">Select a Source Entity</p>
                <p className="text-[11px] text-muted-foreground max-w-56 mt-1">
                  Choose an entity to inspect and pick properties and services to migrate or delete.
                </p>
              </div>
            ) : sourceMembersLoading ? (
              <div className="flex-1 flex flex-col items-center justify-center p-6 text-center text-muted-foreground gap-2">
                <Spinner className="size-5" />
                <p className="text-xs">Parsing entity definition XML…</p>
              </div>
            ) : sourceMembers ? (
              <div className="flex-1 flex flex-col min-h-0">
                {/* Filter Tabs */}
                <div className="px-3 pt-2.5 pb-2 border-b bg-muted/10 flex flex-col gap-2">
                  <Tabs
                    value={activeSourceTab}
                    onValueChange={(v) => setActiveSourceTab(v as typeof activeSourceTab)}
                    className="w-full"
                  >
                    <TabsList className="w-full grid grid-cols-4 h-7 p-0.5 bg-muted/60">
                      <TabsTrigger value="all" className="text-[11px] h-6 px-1">
                        All ({allPropRows.length + allServiceRows.length})
                      </TabsTrigger>
                      <TabsTrigger value="properties" className="text-[11px] h-6 px-1">
                        Props ({allPropRows.length})
                      </TabsTrigger>
                      <TabsTrigger value="services" className="text-[11px] h-6 px-1">
                        Services ({allServiceRows.length})
                      </TabsTrigger>
                      <TabsTrigger value="selected" className="text-[11px] h-6 px-1 font-semibold">
                        Staged ({selected.size})
                      </TabsTrigger>
                    </TabsList>
                  </Tabs>

                  {/* Search and Selection Bar */}
                  <div className="flex items-center gap-1.5">
                    <div className="relative flex-1 min-w-0">
                      <IconSearch className="size-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground/70" />
                      <Input
                        placeholder="Search members…"
                        value={memberFilter}
                        onChange={(e) => setMemberFilter(e.target.value)}
                        className="h-7 text-xs pl-7 pr-6 bg-background"
                      />
                      {memberFilter && (
                        <Button
                          type="button"
                          size="icon"
                          variant="ghost"
                          className="size-5 absolute right-1 top-1/2 -translate-y-1/2"
                          onClick={() => setMemberFilter("")}
                        >
                          <IconX className="size-3" />
                        </Button>
                      )}
                    </div>

                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="h-7 text-[11px] px-2 bg-background shrink-0"
                      disabled={visibleKeys.length === 0}
                      onClick={toggleAllVisible}
                    >
                      {allVisibleSelected ? "Deselect" : "Select all"}
                    </Button>

                    {selected.size > 0 && (
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        className="h-7 text-[11px] px-2 text-muted-foreground hover:text-foreground shrink-0"
                        onClick={clearSelection}
                      >
                        Clear
                      </Button>
                    )}
                  </div>
                </div>

                {/* Member Items Scrollable List */}
                <div className="flex-1 overflow-y-auto p-2.5 flex flex-col gap-1.5">
                  {visibleRows.length === 0 ? (
                    <div className="py-10 text-center text-muted-foreground text-xs">
                      {memberQuery ? "No members match the search query." : "No members found in this view."}
                    </div>
                  ) : (
                    visibleRows.map((r) => {
                      const isSel = selected.has(r.k);
                      const renameVal = renames.get(r.k) ?? "";
                      const isEditingRename = editingRenameKey === r.k;
                      const isService = r.kind === "service";

                      return (
                        <div
                          key={r.k}
                          className={cn(
                            "group flex flex-col gap-1.5 p-2 rounded-lg border transition-all text-xs",
                            isSel
                              ? "bg-primary/5 border-primary/40 shadow-2xs"
                              : "bg-background/70 border-border/70 hover:bg-muted/40 hover:border-border"
                          )}
                        >
                          <div className="flex items-center gap-2">
                            <Checkbox
                              checked={isSel}
                              onCheckedChange={() => toggle(r.k)}
                              className="size-4 shrink-0"
                            />

                            {/* Kind Icon */}
                            <div
                              className={cn(
                                "size-5 rounded flex items-center justify-center shrink-0 text-[10px]",
                                isService
                                  ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                                  : "bg-indigo-500/10 text-indigo-600 dark:text-indigo-400"
                              )}
                              title={isService ? "Service" : "Property"}
                            >
                              {isService ? <IconCode className="size-3.5" /> : <IconAdjustments className="size-3.5" />}
                            </div>

                            {/* Name */}
                            <span
                              className={cn(
                                "font-mono font-medium truncate flex-1 cursor-pointer select-none",
                                isSel ? "text-foreground font-semibold" : "text-foreground/85"
                              )}
                              onClick={() => toggle(r.k)}
                            >
                              {r.name}
                            </span>

                            {/* Service signature status */}
                            {"warn" in r && r.warn && (
                              <Badge
                                variant="secondary"
                                className="text-[9px] px-1 py-0 font-normal shrink-0 text-muted-foreground bg-muted"
                              >
                                signature only
                              </Badge>
                            )}

                            {/* Rename Trigger button */}
                            {isSel && (
                              <Button
                                size="icon"
                                variant={renameVal ? "secondary" : "ghost"}
                                className="size-6 shrink-0 text-muted-foreground hover:text-foreground"
                                title="Rename on target"
                                onClick={() => setEditingRenameKey(isEditingRename ? null : r.k)}
                              >
                                <IconPencil className="size-3" />
                              </Button>
                            )}
                          </div>

                          {/* Rename Input Panel (shows if renaming or if rename has been set) */}
                          {isSel && (isEditingRename || renameVal) && (
                            <div className="flex items-center gap-1.5 pl-6 pt-1 border-t border-border/40 mt-0.5">
                              <span className="text-[10px] text-muted-foreground font-mono shrink-0 flex items-center gap-1">
                                <IconArrowRight className="size-2.5" /> Target name:
                              </span>
                              <Input
                                value={renameVal}
                                placeholder={r.name}
                                onChange={(e) => setRename(r.k, e.target.value)}
                                className="h-6 text-[11px] font-mono bg-background flex-1"
                                autoFocus={isEditingRename}
                              />
                              {renameVal && (
                                <Button
                                  size="icon"
                                  variant="ghost"
                                  className="size-5 shrink-0"
                                  title="Clear rename"
                                  onClick={() => setRename(r.k, "")}
                                >
                                  <IconX className="size-2.5" />
                                </Button>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })
                  )}
                </div>
              </div>
            ) : null}
          </div>
        </div>

        {/* ─────────────────────────────────────────────────────────────
            COLUMN 2: MIGRATION HUB & ACTION BRIDGE
        ───────────────────────────────────────────────────────────── */}
        <div className="flex flex-col gap-3 min-h-0 justify-between">
          {/* Main Action Hub Card */}
          <div className="border rounded-xl bg-card shadow-xs p-3.5 flex flex-col gap-4">
            {/* Header */}
            <div className="flex items-center justify-between border-b pb-2.5">
              <span className="text-xs font-semibold text-foreground flex items-center gap-1.5">
                <IconSparkles className="size-3.5 text-primary" /> Migration Hub
              </span>
              {selected.size > 0 && (
                <Badge variant="default" className="text-[10px] px-1.5 py-0 font-mono">
                  {selected.size} Staged
                </Badge>
              )}
            </div>

            {/* Mode Switcher */}
            <div className="flex flex-col gap-1.5">
              <Label className="text-[11px] text-muted-foreground font-medium">Operation Mode</Label>
              <div className="grid grid-cols-2 gap-1 bg-muted/60 p-1 rounded-lg">
                <button
                  type="button"
                  onClick={() => setMode("copy")}
                  className={cn(
                    "flex items-center justify-center gap-1.5 py-1.5 px-2 rounded-md text-xs font-medium transition-all cursor-pointer",
                    mode === "copy"
                      ? "bg-background text-primary shadow-xs font-semibold"
                      : "text-muted-foreground hover:text-foreground"
                  )}
                >
                  <IconCopy className="size-3.5" /> Copy
                </button>
                <button
                  type="button"
                  onClick={() => setMode("move")}
                  className={cn(
                    "flex items-center justify-center gap-1.5 py-1.5 px-2 rounded-md text-xs font-medium transition-all cursor-pointer",
                    mode === "move"
                      ? "bg-background text-primary shadow-xs font-semibold"
                      : "text-muted-foreground hover:text-foreground"
                  )}
                >
                  <IconArrowsExchange className="size-3.5" /> Move
                </button>
              </div>
              <p className="text-[10px] text-muted-foreground leading-tight mt-0.5">
                {mode === "copy"
                  ? "Leaves source entity intact; writes members to target."
                  : "Removes selected members from source; writes to target."}
              </p>
            </div>

            {/* Swap Entities Button */}
            <div className="flex justify-center">
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={swapEntities}
                      disabled={!sourceRel && !targetRel}
                      className="h-7 text-[11px] gap-1.5 px-2.5 bg-background shadow-2xs"
                    />
                  }
                >
                  <IconArrowsExchange className="size-3.5" /> Swap Source &amp; Target
                </TooltipTrigger>
                <TooltipContent>Exchange source and target entities</TooltipContent>
              </Tooltip>
            </div>

            {/* Staged Transfer Stats */}
            <div className="rounded-lg bg-muted/30 border p-2.5 flex flex-col gap-1.5 text-xs">
              <div className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">
                Staged Payload
              </div>
              <div className="flex items-center justify-between text-xs">
                <span className="text-muted-foreground">Properties:</span>
                <span className="font-mono font-medium">{selectedPropsCount}</span>
              </div>
              <div className="flex items-center justify-between text-xs">
                <span className="text-muted-foreground">Services:</span>
                <span className="font-mono font-medium">{selectedServicesCount}</span>
              </div>

              {/* Pre-flight conflict callout */}
              {preflightConflicts.length > 0 && (
                <div className="mt-1.5 rounded border border-amber-500/40 bg-amber-500/10 p-2 text-[11px] text-amber-700 dark:text-amber-300 flex items-start gap-1.5">
                  <IconAlertTriangle className="size-3.5 shrink-0 mt-0.5" />
                  <div>
                    <span className="font-semibold">{preflightConflicts.length} Conflict(s)</span> with target. Overwrites will be prompted.
                  </div>
                </div>
              )}
            </div>

            {/* Primary Action Button */}
            <Button
              disabled={!canPreview}
              onClick={openPreview}
              className="w-full h-9 text-xs font-semibold gap-2 shadow-xs cursor-pointer"
            >
              {busy ? <Spinner className="size-3.5" /> : <IconArrowRight className="size-3.5" />}
              Review &amp; Migrate {selected.size > 0 ? `(${selected.size})` : ""}
            </Button>
          </div>

          {/* Danger Zone: Delete from source */}
          <div className="border border-destructive/30 rounded-xl bg-destructive/5 shadow-xs p-3 flex flex-col gap-2">
            <div className="flex items-center gap-1.5 text-xs font-semibold text-destructive">
              <IconTrash className="size-3.5" /> Delete from Source
            </div>
            <p className="text-[10px] text-muted-foreground leading-tight">
              Permanently purges selected members from source XML (no target required).
            </p>
            <Button
              variant="outline"
              size="sm"
              disabled={!canDelete}
              onClick={openDelete}
              className="w-full h-7 text-xs font-medium text-destructive hover:text-destructive hover:bg-destructive/10 border-destructive/40 cursor-pointer"
            >
              {busy ? <Spinner className="size-3" /> : <IconTrash className="size-3 mr-1" />}
              Delete Selected {selected.size > 0 ? `(${selected.size})` : ""}
            </Button>
          </div>
        </div>

        {/* ─────────────────────────────────────────────────────────────
            COLUMN 3: TARGET ENTITY & DESTINATION INSPECTOR
        ───────────────────────────────────────────────────────────── */}
        <div className="flex flex-col min-h-0 border rounded-xl bg-card shadow-xs overflow-hidden">
          {/* Card Header & Entity Selector */}
          <div className="p-3.5 border-b bg-muted/20 flex flex-col gap-2.5">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Badge variant="secondary" className="text-[10px] font-semibold tracking-wide uppercase px-2 py-0.5">
                  Target
                </Badge>
                <span className="text-xs font-semibold text-foreground">Target Entity</span>
              </div>
              {targetMembers && (
                <div className="flex items-center gap-1.5">
                  <Badge variant="outline" className="text-[10px] bg-background">
                    {targetMembers.properties.length} Props
                  </Badge>
                  <Badge variant="outline" className="text-[10px] bg-background">
                    {targetMembers.services.length} Services
                  </Badge>
                </div>
              )}
            </div>

            {/* Combobox Search */}
            <Combobox
              inputValue={targetInput}
              onInputValueChange={setTargetInput}
              onValueChange={(v) => {
                if (v) setTargetRel(String(v));
              }}
            >
              <ComboboxInput
                placeholder={filesLoading ? "Loading entities…" : "Search target entity…"}
                showClear
                disabled={!selectedEnv || filesLoading}
                className="w-full h-8 text-xs bg-background"
              />
              <ComboboxContent>
                <ComboboxList>
                  {filteredTarget.map((f) => (
                    <ComboboxItem key={f.relPath} value={f.relPath} className="text-xs">
                      <div className="flex flex-col">
                        <span className="font-medium">{f.name}</span>
                        <span className="text-[10px] text-muted-foreground">
                          {f.collection} · {f.project}
                        </span>
                      </div>
                    </ComboboxItem>
                  ))}
                  <ComboboxEmpty className="text-xs py-3">
                    {filesLoading ? "Loading…" : "No entities found."}
                  </ComboboxEmpty>
                </ComboboxList>
              </ComboboxContent>
            </Combobox>

            {/* Target Entity Info Card */}
            {targetFile && (
              <div className="rounded-lg bg-background/80 border p-2 text-xs flex items-center justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <div className="font-semibold text-foreground truncate flex items-center gap-1.5">
                    <IconLayersLinked className="size-3.5 text-secondary-foreground shrink-0" />
                    <span className="truncate">{targetFile.name}</span>
                  </div>
                  <div className="text-[10px] text-muted-foreground flex items-center gap-2 mt-0.5">
                    <Badge variant="secondary" className="text-[9px] px-1 py-0 h-4">
                      {targetFile.collection}
                    </Badge>
                    <span className="truncate">Project: {targetFile.project}</span>
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Target Inspector Body */}
          <div className="flex-1 flex flex-col min-h-0 bg-card/40">
            {!targetRel ? (
              <div className="flex-1 flex flex-col items-center justify-center p-6 text-center text-muted-foreground">
                <div className="size-10 rounded-full bg-muted/60 flex items-center justify-center mb-2">
                  <IconArrowRight className="size-5 text-muted-foreground/60" />
                </div>
                <p className="text-xs font-medium text-foreground">Select a Target Entity</p>
                <p className="text-[11px] text-muted-foreground max-w-56 mt-1">
                  Choose an entity to receive the selected members from the source entity.
                </p>
              </div>
            ) : targetMembersLoading ? (
              <div className="flex-1 flex flex-col items-center justify-center p-6 text-center text-muted-foreground gap-2">
                <Spinner className="size-5" />
                <p className="text-xs">Inspecting target entity…</p>
              </div>
            ) : (
              <div className="flex-1 flex flex-col min-h-0">
                {/* Tabs */}
                <div className="px-3 pt-2.5 pb-2 border-b bg-muted/10">
                  <Tabs
                    value={activeTargetTab}
                    onValueChange={(v) => setActiveTargetTab(v as typeof activeTargetTab)}
                    className="w-full"
                  >
                    <TabsList className="w-full grid grid-cols-2 h-7 p-0.5 bg-muted/60">
                      <TabsTrigger value="staged" className="text-[11px] h-6 px-1 font-medium">
                        Staged Inbound ({selectedItems.length})
                      </TabsTrigger>
                      <TabsTrigger value="existing" className="text-[11px] h-6 px-1">
                        Existing Members ({((targetMembers?.properties.length ?? 0) + (targetMembers?.services.length ?? 0))})
                      </TabsTrigger>
                    </TabsList>
                  </Tabs>
                </div>

                {/* Tab Content */}
                <div className="flex-1 overflow-y-auto p-2.5 flex flex-col gap-1.5">
                  {activeTargetTab === "staged" ? (
                    selectedItems.length === 0 ? (
                      <div className="py-10 text-center text-muted-foreground text-xs">
                        Select members on the left to preview how they will be written into {targetName}.
                      </div>
                    ) : (
                      selectedItems.map((item) => {
                        const isService = item.kind === "service";
                        const finalName = item.newName || item.name;
                        const hasConflict = preflightConflicts.some((c) => c.item === item);

                        return (
                          <div
                            key={`${item.kind}:${item.name}`}
                            className={cn(
                              "flex items-center justify-between gap-2 p-2 rounded-lg border text-xs bg-background/80 shadow-2xs",
                              hasConflict ? "border-amber-500/40 bg-amber-500/5" : "border-border"
                            )}
                          >
                            <div className="flex items-center gap-2 min-w-0 flex-1">
                              <div
                                className={cn(
                                  "size-5 rounded flex items-center justify-center shrink-0 text-[10px]",
                                  isService
                                    ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                                    : "bg-indigo-500/10 text-indigo-600 dark:text-indigo-400"
                                )}
                              >
                                {isService ? <IconCode className="size-3.5" /> : <IconAdjustments className="size-3.5" />}
                              </div>

                              <div className="min-w-0 flex-1 flex items-center gap-1.5 font-mono">
                                <span className="truncate font-medium">{finalName}</span>
                                {item.newName && (
                                  <span className="text-[10px] text-muted-foreground shrink-0 font-sans">
                                    (from <span className="font-mono">{item.name}</span>)
                                  </span>
                                )}
                              </div>
                            </div>

                            <div className="flex items-center gap-1.5 shrink-0">
                              {hasConflict ? (
                                <Badge variant="outline" className="text-[9px] border-amber-500/50 text-amber-600 dark:text-amber-400 bg-amber-500/10">
                                  Conflict
                                </Badge>
                              ) : (
                                <Badge variant="outline" className="text-[9px] border-emerald-500/40 text-emerald-600 dark:text-emerald-400 bg-emerald-500/10">
                                  <IconPlus className="size-2.5 mr-0.5" /> New
                                </Badge>
                              )}
                            </div>
                          </div>
                        );
                      })
                    )
                  ) : (
                    // Existing members view
                    <div className="flex flex-col gap-3">
                      <div>
                        <div className="text-[11px] font-semibold text-muted-foreground mb-1.5">
                          Existing Properties ({targetMembers?.properties.length ?? 0})
                        </div>
                        {(targetMembers?.properties.length ?? 0) === 0 ? (
                          <p className="text-[11px] text-muted-foreground/70">No existing properties.</p>
                        ) : (
                          <div className="flex flex-col gap-1">
                            {targetMembers?.properties.map((p) => (
                              <div
                                key={p}
                                className="flex items-center gap-2 p-1.5 rounded-md bg-muted/20 border text-xs font-mono"
                              >
                                <IconAdjustments className="size-3 text-indigo-500/70" />
                                <span className="truncate">{p}</span>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>

                      <div>
                        <div className="text-[11px] font-semibold text-muted-foreground mb-1.5">
                          Existing Services ({targetMembers?.services.length ?? 0})
                        </div>
                        {(targetMembers?.services.length ?? 0) === 0 ? (
                          <p className="text-[11px] text-muted-foreground/70">No existing services.</p>
                        ) : (
                          <div className="flex flex-col gap-1">
                            {targetMembers?.services.map((s) => (
                              <div
                                key={s.name}
                                className="flex items-center justify-between gap-2 p-1.5 rounded-md bg-muted/20 border text-xs font-mono"
                              >
                                <div className="flex items-center gap-2 truncate">
                                  <IconCode className="size-3 text-emerald-500/70" />
                                  <span className="truncate">{s.name}</span>
                                </div>
                                {!s.hasImplementation && (
                                  <Badge variant="secondary" className="text-[9px] px-1 py-0 font-sans">
                                    signature only
                                  </Badge>
                                )}
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ─────────────────────────────────────────────────────────────
          PREVIEW & CONFIRM MIGRATION DIALOG
      ───────────────────────────────────────────────────────────── */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-[min(80rem,calc(100vw-4rem))] w-full h-[88vh] flex flex-col p-6">
          <DialogHeader className="shrink-0 pb-2 border-b">
            <div className="flex items-center gap-2">
              <Badge variant={mode === "move" ? "destructive" : "default"} className="text-[10px] uppercase font-bold">
                {mode === "move" ? "Move" : "Copy"} Migration
              </Badge>
              <DialogTitle className="text-base font-semibold">
                Transfer {selected.size} member{selected.size === 1 ? "" : "s"}
              </DialogTitle>
            </div>
            <DialogDescription className="text-xs text-muted-foreground font-mono mt-1">
              Source: <span className="font-semibold text-foreground">{sourceName}</span> ➔ Target:{" "}
              <span className="font-semibold text-foreground">{targetName}</span>
            </DialogDescription>
          </DialogHeader>

          <div className="flex-1 flex flex-col min-h-0 gap-3 overflow-y-auto py-2">
            {/* Conflicts section */}
            {conflicts.length > 0 && (
              <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-3.5 shadow-xs shrink-0">
                <div className="flex items-center gap-2 text-xs font-semibold text-amber-700 dark:text-amber-300 mb-2">
                  <IconAlertTriangle className="size-4 shrink-0" /> Target Name Conflicts Detected ({conflicts.length})
                </div>
                <p className="text-[11px] text-amber-800/80 dark:text-amber-200/80 mb-2.5">
                  Select which items should overwrite the existing target definition. Unchecked items will be skipped to preserve target content.
                </p>
                <div className="flex flex-col gap-1.5 max-h-40 overflow-y-auto pr-1">
                  {conflicts.map((c) => {
                    const k = makeKey(c.kind, c.name);
                    const willOverwrite = overwrite.has(k);

                    return (
                      <label
                        key={k}
                        className={cn(
                          "flex items-center gap-2.5 text-xs p-2 rounded-lg border cursor-pointer select-none transition-colors",
                          willOverwrite
                            ? "bg-amber-500/20 border-amber-500/50"
                            : "bg-background/80 border-border hover:bg-muted/40"
                        )}
                      >
                        <Checkbox checked={willOverwrite} onCheckedChange={() => toggleOverwrite(k)} />
                        <Badge variant="secondary" className="text-[10px] uppercase font-mono px-1 py-0">
                          {c.kind}
                        </Badge>
                        <span className="font-mono font-semibold">
                          {c.name}
                          {c.newName && c.newName !== c.name && (
                            <span className="text-muted-foreground font-normal"> ➔ {c.newName}</span>
                          )}
                        </span>
                        <span className="text-muted-foreground text-[11px] ml-auto">
                          {willOverwrite ? "Will overwrite target" : "Will skip (keep target)"}
                        </span>
                      </label>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Warnings list */}
            {allWarnings.length > 0 && (
              <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-3 shrink-0 max-h-28 overflow-y-auto">
                <div className="text-xs font-semibold mb-1 flex items-center gap-1.5 text-amber-700 dark:text-amber-400">
                  <IconInfoCircle className="size-3.5" /> Migration Warnings
                </div>
                <ul className="list-disc pl-4 text-xs text-muted-foreground flex flex-col gap-0.5">
                  {allWarnings.map(({ name, w }, i) => (
                    <li key={i}>
                      <span className="font-mono font-medium text-foreground">{name}</span>: {w}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* Diff Viewer */}
            {preview && (
              <Tabs defaultValue="target" className="flex-1 flex flex-col min-h-0">
                <TabsList className="self-start h-7 mb-1.5">
                  <TabsTrigger value="target" className="text-xs h-6">
                    Target XML Diff
                  </TabsTrigger>
                  {mode === "move" && (
                    <TabsTrigger value="source" className="text-xs h-6">
                      Source XML Diff (Purged)
                    </TabsTrigger>
                  )}
                </TabsList>
                <TabsContent value="target" className="m-0 border rounded-xl overflow-hidden flex-1 min-h-[300px]">
                  <DiffEditor
                    height="100%"
                    language="xml"
                    theme={diffTheme}
                    original={preview.targetOriginal}
                    modified={preview.targetPreview}
                    options={{
                      readOnly: true,
                      renderSideBySide: true,
                      minimap: { enabled: false },
                      fontSize: 11,
                      scrollBeyondLastLine: false,
                      automaticLayout: true,
                    }}
                  />
                </TabsContent>
                {mode === "move" && (
                  <TabsContent value="source" className="m-0 border rounded-xl overflow-hidden flex-1 min-h-[300px]">
                    <DiffEditor
                      height="100%"
                      language="xml"
                      theme={diffTheme}
                      original={preview.sourceOriginal}
                      modified={preview.sourcePreview}
                      options={{
                        readOnly: true,
                        renderSideBySide: true,
                        minimap: { enabled: false },
                        fontSize: 11,
                        scrollBeyondLastLine: false,
                      automaticLayout: true,
                      }}
                    />
                  </TabsContent>
                )}
              </Tabs>
            )}
          </div>

          <DialogFooter className="shrink-0 pt-3 border-t flex items-center justify-between sm:justify-between">
            <Button variant="outline" size="sm" onClick={() => setDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={commit}
              disabled={busy || (preview?.hasBlockingConflict ?? false)}
              className="gap-2 font-semibold cursor-pointer"
            >
              {busy ? <Spinner className="size-3.5" /> : <IconCheck className="size-3.5" />}
              {preview?.hasBlockingConflict
                ? "Resolve conflicts to continue"
                : `Commit ${mode === "move" ? "Move" : "Copy"} to Disk`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ─────────────────────────────────────────────────────────────
          DELETE FROM SOURCE CONFIRMATION DIALOG
      ───────────────────────────────────────────────────────────── */}
      <Dialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <DialogContent className="sm:max-w-[min(72rem,calc(100vw-4rem))] w-full h-[85vh] flex flex-col p-6 border-destructive/40">
          <DialogHeader className="shrink-0 pb-2 border-b">
            <div className="flex items-center gap-2 text-destructive">
              <IconTrash className="size-4" />
              <DialogTitle className="text-base font-semibold">
                Delete {selected.size} member{selected.size === 1 ? "" : "s"} from {sourceName}
              </DialogTitle>
            </div>
            <DialogDescription className="text-xs text-muted-foreground mt-1">
              This will permanently remove selected property definitions and service implementations from the source XML on disk.
            </DialogDescription>
          </DialogHeader>

          <div className="flex-1 flex flex-col min-h-0 gap-3 overflow-y-auto py-2">
            <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive flex items-center gap-2">
              <IconAlertTriangle className="size-4 shrink-0" />
              <span>Warning: This destructive operation modifies local files. Git or re-export will be required to undo.</span>
            </div>

            {deleteWarnings.length > 0 && (
              <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-3 shrink-0 max-h-28 overflow-y-auto">
                <div className="text-xs font-semibold mb-1 flex items-center gap-1 text-amber-700 dark:text-amber-400">
                  <IconAlertTriangle className="size-3.5" /> Warnings
                </div>
                <ul className="list-disc pl-4 text-xs text-muted-foreground flex flex-col gap-0.5">
                  {deleteWarnings.map(({ name, w }, i) => (
                    <li key={i}>
                      <span className="font-mono font-medium text-foreground">{name}</span>: {w}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {deletePreview && (
              <div className="border rounded-xl overflow-hidden flex-1 min-h-[320px]">
                <DiffEditor
                  height="100%"
                  language="xml"
                  theme={diffTheme}
                  original={deletePreview.sourceOriginal}
                  modified={deletePreview.sourcePreview}
                  options={{
                    readOnly: true,
                    renderSideBySide: true,
                    minimap: { enabled: false },
                    fontSize: 11,
                    scrollBeyondLastLine: false,
                    automaticLayout: true,
                  }}
                />
              </div>
            )}
          </div>

          <DialogFooter className="shrink-0 pt-3 border-t flex items-center justify-between sm:justify-between">
            <Button variant="outline" size="sm" onClick={() => setDeleteDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={commitDelete}
              disabled={busy}
              className="gap-2 font-semibold cursor-pointer"
            >
              {busy ? <Spinner className="size-3.5" /> : <IconTrash className="size-3.5" />}
              Confirm Permanent Deletion
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

