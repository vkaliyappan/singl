"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  IconArrowRight,
  IconChevronRight,
  IconCopy,
  IconDotsVertical,
  IconDownload,
  IconFileImport,
  IconFolder,
  IconFolderPlus,
  IconFolderSymlink,
  IconLayoutGrid,
  IconLayoutList,
  IconPlus,
  IconSearch,
  IconSitemap,
  IconSparkles,
  IconStack2,
  IconTrash,
} from "@tabler/icons-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { cn } from "@/lib/utils";
import {
  createFlow,
  createFolder,
  deleteFlow,
  deleteFolder,
  duplicateFlow,
  flowHref,
  importFlow,
  moveFlow,
  moveFolder,
  renameFolder,
} from "./actions";
import { BLUEPRINTS, type BlueprintTemplate } from "./blueprints";
import { FlowTree, type DragPayload } from "./flow-tree";
import {
  ROOT_ID,
  buildFolderTree,
  flattenFolders,
  folderPath,
  formatRelativeTime,
  graphStats,
  subtreeIds,
  type EnvRow,
  type FlowRow,
  type FolderNode,
  type FolderRow,
} from "./hub-model";

type FolderDialogState =
  | { mode: "create"; parentId: string | null; parentName: string }
  | { mode: "rename"; folder: FolderNode };

export function FlowHub({
  flows,
  folders,
  envs,
}: {
  flows: FlowRow[];
  folders: FolderRow[];
  envs: EnvRow[];
}) {
  const router = useRouter();

  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(null);
  const [expandedIds, setExpandedIds] = useState<string[]>([ROOT_ID]);
  const [search, setSearch] = useState("");
  const [envFilter, setEnvFilter] = useState("all");
  const [sortBy, setSortBy] = useState<"updated" | "name" | "nodes">("updated");
  const [viewMode, setViewMode] = useState<"grid" | "table">("grid");
  const [includeSubfolders, setIncludeSubfolders] = useState(true);

  const [createOpen, setCreateOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [blueprintsOpen, setBlueprintsOpen] = useState(false);
  const [importJson, setImportJson] = useState("");
  const [importName, setImportName] = useState("");
  const [importEnv, setImportEnv] = useState(envs[0]?.environment ?? "");
  const [importError, setImportError] = useState("");

  const [folderDialog, setFolderDialog] = useState<FolderDialogState | null>(null);
  const [folderName, setFolderName] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<FolderNode | null>(null);

  // Shared with the tree so a card dragged in the main pane can land on a row.
  const [dragItem, setDragItem] = useState<DragPayload | null>(null);
  const [paneDropActive, setPaneDropActive] = useState(false);

  const { roots, rootFlows, byId } = useMemo(
    () => buildFolderTree(folders, flows),
    [folders, flows]
  );

  const breadcrumb = useMemo(
    () => folderPath(byId, selectedFolderId),
    [byId, selectedFolderId]
  );

  const folderOptions = useMemo(() => flattenFolders(roots), [roots]);

  /** Ids whose flows belong in the main pane for the current selection. */
  const scopeIds = useMemo(() => {
    if (!selectedFolderId) return null; // null = every flow
    const node = byId.get(selectedFolderId);
    if (!node) return new Set<string>();
    return new Set(includeSubfolders ? subtreeIds(node) : [node.id]);
  }, [byId, selectedFolderId, includeSubfolders]);

  const visibleFlows = useMemo(() => {
    const query = search.trim().toLowerCase();

    const list = flows.filter((f) => {
      if (scopeIds && !(f.folderId && scopeIds.has(f.folderId))) return false;
      if (envFilter !== "all" && f.environment !== envFilter) return false;
      if (!query) return true;

      const { nodes } = graphStats(f.graph);
      const inNodes = nodes.some(
        (n) =>
          n.label.toLowerCase().includes(query) ||
          (n.kind === "service" &&
            (n.entityName.toLowerCase().includes(query) ||
              n.serviceName.toLowerCase().includes(query)))
      );
      return (
        f.name.toLowerCase().includes(query) ||
        f.environment.toLowerCase().includes(query) ||
        inNodes
      );
    });

    return list.sort((a, b) => {
      if (sortBy === "name") return a.name.localeCompare(b.name);
      if (sortBy === "nodes") {
        return graphStats(b.graph).nodes.length - graphStats(a.graph).nodes.length;
      }
      const da = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
      const db = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
      return db - da;
    });
  }, [flows, scopeIds, envFilter, search, sortBy]);

  const expand = (ids: string[]) =>
    setExpandedIds((prev) => [...new Set([...prev, ...ids])]);

  const selectFolder = (folderId: string | null) => {
    setSelectedFolderId(folderId);
    if (folderId) {
      expand([ROOT_ID, ...folderPath(byId, folderId).map((f) => f.id)]);
    }
  };

  const runAction = async (
    promise: Promise<{ error?: string }>,
    okMessage: string
  ) => {
    const res = await promise;
    if (res.error) {
      toast.error(res.error);
      return false;
    }
    toast.success(okMessage);
    return true;
  };

  const handleDropItem = async (payload: DragPayload, folderId: string | null) => {
    if (payload.kind === "flow") {
      const flow = flows.find((f) => f.id === payload.id);
      if (!flow || flow.folderId === folderId) return;
      await runAction(
        moveFlow(payload.id, folderId),
        folderId
          ? `Moved "${flow.name}" to ${byId.get(folderId)?.name ?? "folder"}`
          : `Moved "${flow.name}" to the root`
      );
      return;
    }

    const folder = byId.get(payload.id);
    if (!folder || folder.parentId === folderId) return;
    await runAction(
      moveFolder(payload.id, folderId),
      folderId
        ? `Moved "${folder.name}" into ${byId.get(folderId)?.name ?? "folder"}`
        : `Moved "${folder.name}" to the root`
    );
    if (folderId) expand([folderId]);
  };

  const submitFolderDialog = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!folderDialog) return;
    const name = folderName.trim();
    if (!name) return;

    if (folderDialog.mode === "create") {
      const res = await createFolder(name, folderDialog.parentId);
      if (res.error) {
        toast.error(res.error);
        return;
      }
      toast.success(`Folder "${name}" created`);
      if (folderDialog.parentId) expand([ROOT_ID, folderDialog.parentId]);
      if (res.id) setSelectedFolderId(res.id);
    } else {
      const ok = await runAction(
        renameFolder(folderDialog.folder.id, name),
        "Folder renamed"
      );
      if (!ok) return;
    }
    setFolderDialog(null);
    setFolderName("");
  };

  const removeFolder = async (recursive: boolean) => {
    if (!deleteTarget) return;
    const ok = await runAction(
      deleteFolder(deleteTarget.id, recursive),
      recursive
        ? `Deleted "${deleteTarget.name}" and its contents`
        : `Deleted "${deleteTarget.name}", contents moved up`
    );
    if (ok && selectedFolderId === deleteTarget.id) setSelectedFolderId(null);
    setDeleteTarget(null);
  };

  const handleExport = (flow: FlowRow) => {
    const href =
      "data:text/json;charset=utf-8," + encodeURIComponent(flow.graph);
    const anchor = document.createElement("a");
    anchor.setAttribute("href", href);
    anchor.setAttribute(
      "download",
      `${flow.name.replace(/\s+/g, "_")}.twxflow.json`
    );
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  };

  const handleApplyTemplate = async (tmpl: BlueprintTemplate) => {
    const res = await importFlow(
      tmpl.name,
      envs[0]?.environment ?? "",
      JSON.stringify(tmpl.graph),
      selectedFolderId
    );
    if (res.error) {
      toast.error(res.error);
      return;
    }
    if (res.id) router.push(flowHref(res.id));
  };

  const handleImportSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setImportError("");
    try {
      const parsed = JSON.parse(importJson);
      if (!parsed.nodes || !Array.isArray(parsed.nodes)) {
        throw new Error("Invalid flow JSON: missing 'nodes' array");
      }
      const res = await importFlow(
        importName || "Imported Flow",
        importEnv,
        JSON.stringify(parsed),
        selectedFolderId
      );
      if (res.error) setImportError(res.error);
      else if (res.id) {
        setImportOpen(false);
        router.push(flowHref(res.id));
      }
    } catch (err) {
      setImportError(err instanceof Error ? err.message : "Invalid JSON syntax");
    }
  };

  const startCardDrag = (e: React.DragEvent, flow: FlowRow) => {
    setDragItem({ kind: "flow", id: flow.id });
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", flow.id);
  };

  const currentFolderLabel = selectedFolderId
    ? (byId.get(selectedFolderId)?.name ?? "Folder")
    : "All flows";

  return (
    <div className="flex flex-1 min-h-0 flex-col">
      {/* Header */}
      <header className="flex flex-wrap items-center gap-3 border-b px-4 py-3">
        <div className="flex items-center gap-2">
          <IconSitemap className="size-5 text-primary" />
          <h1 className="text-sm font-semibold tracking-tight">Service Flows</h1>
          <Badge variant="secondary" className="font-mono text-[10px]">
            {flows.length}
          </Badge>
        </div>

        <div className="relative min-w-52 flex-1 max-w-md">
          <IconSearch className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search flows by name, node, or service..."
            className="h-8 pl-8 text-xs"
          />
        </div>

        <div className="ml-auto flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setBlueprintsOpen(true)}
          >
            <IconSparkles className="size-3.5 text-amber-500" />
            Blueprints
          </Button>
          <Button variant="outline" size="sm" onClick={() => setImportOpen(true)}>
            <IconFileImport className="size-3.5" />
            Import
          </Button>
          <Button size="sm" onClick={() => setCreateOpen(true)}>
            <IconPlus className="size-3.5" />
            New flow
          </Button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* Sidebar */}
        <aside className="hidden w-64 shrink-0 border-r bg-card/40 md:block">
          <FlowTree
            roots={roots}
            rootFlows={rootFlows}
            totalFlows={flows.length}
            selectedFolderId={selectedFolderId}
            onSelectFolder={selectFolder}
            expandedIds={expandedIds}
            onExpandedChange={setExpandedIds}
            onDropItem={handleDropItem}
            dragItem={dragItem}
            onDragItemChange={setDragItem}
            onNewRootFolder={() => {
              setFolderName("");
              setFolderDialog({
                mode: "create",
                parentId: null,
                parentName: "All flows",
              });
            }}
            onFolderAction={(action, folder) => {
              if (action === "new-child") {
                setFolderName("");
                setFolderDialog({
                  mode: "create",
                  parentId: folder.id,
                  parentName: folder.name,
                });
              } else if (action === "rename") {
                setFolderName(folder.name);
                setFolderDialog({ mode: "rename", folder });
              } else {
                setDeleteTarget(folder);
              }
            }}
          />
        </aside>

        {/* Main pane — dropping here moves a flow into the selected folder. */}
        <main
          className={cn(
            "flex min-w-0 flex-1 flex-col overflow-auto",
            paneDropActive && "bg-primary/5 ring-1 ring-inset ring-primary/40"
          )}
          onDragOver={(e) => {
            if (dragItem?.kind !== "flow") return;
            e.preventDefault();
            setPaneDropActive(true);
          }}
          onDragLeave={() => setPaneDropActive(false)}
          onDrop={(e) => {
            e.preventDefault();
            setPaneDropActive(false);
            setDragItem(null);
            if (dragItem?.kind === "flow") handleDropItem(dragItem, selectedFolderId);
          }}
        >
          {/* Breadcrumb + toolbar */}
          <div className="sticky top-0 z-10 flex flex-wrap items-center gap-2 border-b bg-background/95 px-4 py-2 backdrop-blur">
            <nav className="flex min-w-0 items-center gap-1 text-xs">
              <button
                type="button"
                onClick={() => selectFolder(null)}
                className="flex items-center gap-1 rounded px-1.5 py-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                <IconStack2 className="size-3.5" />
                All flows
              </button>
              {breadcrumb.map((node, i) => (
                <span key={node.id} className="flex min-w-0 items-center gap-1">
                  <IconChevronRight className="size-3 shrink-0 text-muted-foreground" />
                  <button
                    type="button"
                    onClick={() => selectFolder(node.id)}
                    className={cn(
                      "truncate rounded px-1.5 py-0.5 hover:bg-accent",
                      i === breadcrumb.length - 1
                        ? "font-medium text-foreground"
                        : "text-muted-foreground"
                    )}
                  >
                    {node.name}
                  </button>
                </span>
              ))}
            </nav>

            <div className="ml-auto flex flex-wrap items-center gap-2">
              <span className="text-[11px] text-muted-foreground">
                {visibleFlows.length}{" "}
                {visibleFlows.length === 1 ? "flow" : "flows"}
              </span>

              {selectedFolderId && (
                <Button
                  variant={includeSubfolders ? "secondary" : "ghost"}
                  size="sm"
                  onClick={() => setIncludeSubfolders((v) => !v)}
                  title="Include flows from subfolders"
                >
                  <IconFolder className="size-3.5" />
                  Subfolders
                </Button>
              )}

              <NativeSelect
                value={envFilter}
                onChange={(e) => setEnvFilter(e.target.value)}
                className="h-7 w-36 text-xs"
                aria-label="Filter by environment"
              >
                <option value="all">All environments</option>
                {envs.map((env) => (
                  <option key={env.environment} value={env.environment}>
                    {env.environment}
                  </option>
                ))}
              </NativeSelect>

              <NativeSelect
                value={sortBy}
                onChange={(e) =>
                  setSortBy(e.target.value as "updated" | "name" | "nodes")
                }
                className="h-7 w-36 text-xs"
                aria-label="Sort flows"
              >
                <option value="updated">Recently updated</option>
                <option value="name">Name (A–Z)</option>
                <option value="nodes">Most steps</option>
              </NativeSelect>

              <div className="flex items-center gap-0.5 rounded-md border p-0.5">
                <Button
                  variant={viewMode === "grid" ? "secondary" : "ghost"}
                  size="icon-sm"
                  onClick={() => setViewMode("grid")}
                  aria-label="Grid view"
                  title="Grid view"
                >
                  <IconLayoutGrid className="size-3.5" />
                </Button>
                <Button
                  variant={viewMode === "table" ? "secondary" : "ghost"}
                  size="icon-sm"
                  onClick={() => setViewMode("table")}
                  aria-label="Table view"
                  title="Table view"
                >
                  <IconLayoutList className="size-3.5" />
                </Button>
              </div>
            </div>
          </div>

          <div className="flex-1 p-4">
            {visibleFlows.length === 0 ? (
              <EmptyState
                hasFlows={flows.length > 0}
                folderLabel={currentFolderLabel}
                onCreate={() => setCreateOpen(true)}
                onBrowse={() => setBlueprintsOpen(true)}
              />
            ) : viewMode === "grid" ? (
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
                {visibleFlows.map((flow) => (
                  <FlowCard
                    key={flow.id}
                    flow={flow}
                    folderLabel={
                      flow.folderId ? byId.get(flow.folderId)?.name : undefined
                    }
                    folderOptions={folderOptions}
                    onDragStart={(e) => startCardDrag(e, flow)}
                    onDragEnd={() => setDragItem(null)}
                    onExport={() => handleExport(flow)}
                    onDuplicate={async () => {
                      await runAction(duplicateFlow(flow.id), "Flow duplicated");
                    }}
                    onMove={async (folderId) => {
                      await handleDropItem({ kind: "flow", id: flow.id }, folderId);
                    }}
                  />
                ))}
              </div>
            ) : (
              <FlowTable
                flows={visibleFlows}
                byId={byId}
                folderOptions={folderOptions}
                onExport={handleExport}
                onDuplicate={async (id) => {
                  await runAction(duplicateFlow(id), "Flow duplicated");
                }}
                onMove={async (id, folderId) => {
                  await handleDropItem({ kind: "flow", id }, folderId);
                }}
                onDragStart={startCardDrag}
                onDragEnd={() => setDragItem(null)}
              />
            )}
          </div>
        </main>
      </div>

      {/* Create flow */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Create service flow</DialogTitle>
            <DialogDescription>
              The new canvas lands in{" "}
              <span className="font-medium text-foreground">
                {currentFolderLabel}
              </span>
              .
            </DialogDescription>
          </DialogHeader>

          <form
            action={async (formData) => {
              const res = await createFlow(formData);
              if (res.error) toast.error(res.error);
              else if (res.id) router.push(flowHref(res.id));
            }}
            className="flex flex-col gap-3"
          >
            <input type="hidden" name="folderId" value={selectedFolderId ?? ""} />
            <div className="flex flex-col gap-1">
              <label className="text-xs font-medium">Flow name</label>
              <Input
                name="name"
                placeholder="e.g. BOM Transformation Pipeline"
                className="h-8 text-xs"
                required
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs font-medium">Target environment</label>
              <NativeSelect
                name="environment"
                className="h-8 text-xs"
                defaultValue={envs[0]?.environment ?? ""}
              >
                {envs.length === 0 && (
                  <option value="">No environments configured</option>
                )}
                {envs.map((env) => (
                  <option key={env.environment} value={env.environment}>
                    {env.environment}
                  </option>
                ))}
              </NativeSelect>
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setCreateOpen(false)}
              >
                Cancel
              </Button>
              <Button type="submit" size="sm">
                Create &amp; open canvas
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Import flow */}
      <Dialog open={importOpen} onOpenChange={setImportOpen}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Import service flow</DialogTitle>
            <DialogDescription>
              Paste a exported graph. It is stored in {currentFolderLabel}.
            </DialogDescription>
          </DialogHeader>

          <form onSubmit={handleImportSubmit} className="flex flex-col gap-3">
            <div className="grid grid-cols-2 gap-2">
              <div className="flex flex-col gap-1">
                <label className="text-xs font-medium">Flow name</label>
                <Input
                  value={importName}
                  onChange={(e) => setImportName(e.target.value)}
                  placeholder="My Imported Flow"
                  className="h-8 text-xs"
                />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-xs font-medium">Target environment</label>
                <NativeSelect
                  value={importEnv}
                  onChange={(e) => setImportEnv(e.target.value)}
                  className="h-8 text-xs"
                >
                  {envs.map((env) => (
                    <option key={env.environment} value={env.environment}>
                      {env.environment}
                    </option>
                  ))}
                </NativeSelect>
              </div>
            </div>

            <div className="flex flex-col gap-1">
              <label className="text-xs font-medium">Graph JSON</label>
              <textarea
                value={importJson}
                onChange={(e) => setImportJson(e.target.value)}
                placeholder='{"nodes": [...], "edges": [...]}'
                className="min-h-40 w-full rounded-md border border-input bg-input/20 p-2 font-mono text-xs outline-none focus:border-ring focus:ring-2 focus:ring-ring/30"
                required
              />
            </div>

            {importError && (
              <p className="text-xs font-medium text-destructive">{importError}</p>
            )}

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setImportOpen(false)}
              >
                Cancel
              </Button>
              <Button type="submit" size="sm">
                Import &amp; open canvas
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Blueprints */}
      <Dialog open={blueprintsOpen} onOpenChange={setBlueprintsOpen}>
        <DialogContent className="sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>Blueprints</DialogTitle>
            <DialogDescription>
              Pre-wired canvases. Applying one creates a flow in{" "}
              {currentFolderLabel}.
            </DialogDescription>
          </DialogHeader>

          <div className="grid max-h-[60vh] gap-3 overflow-auto pr-1 sm:grid-cols-2">
            {BLUEPRINTS.map((tmpl) => (
              <div
                key={tmpl.id}
                className="flex flex-col gap-2 rounded-lg border bg-card/60 p-3"
              >
                <div className="flex items-start justify-between gap-2">
                  <p className="text-xs font-semibold">{tmpl.name}</p>
                  <Badge variant="secondary" className="shrink-0 text-[10px]">
                    {tmpl.category}
                  </Badge>
                </div>
                <p className="text-[11px] leading-relaxed text-muted-foreground">
                  {tmpl.description}
                </p>
                <div className="mt-auto flex items-center justify-between pt-1">
                  <span className="font-mono text-[10px] text-muted-foreground">
                    {tmpl.graph.nodes.length} steps
                  </span>
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={() => handleApplyTemplate(tmpl)}
                  >
                    Use blueprint
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </DialogContent>
      </Dialog>

      {/* Create / rename folder */}
      <Dialog
        open={folderDialog !== null}
        onOpenChange={(open) => {
          if (!open) setFolderDialog(null);
        }}
      >
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>
              {folderDialog?.mode === "rename" ? "Rename folder" : "New folder"}
            </DialogTitle>
            <DialogDescription>
              {folderDialog?.mode === "create"
                ? `Created inside ${folderDialog.parentName}.`
                : "Flows inside keep their place."}
            </DialogDescription>
          </DialogHeader>

          <form onSubmit={submitFolderDialog} className="flex flex-col gap-3">
            <Input
              autoFocus
              value={folderName}
              onChange={(e) => setFolderName(e.target.value)}
              placeholder="Folder name"
              className="h-8 text-xs"
              required
            />
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setFolderDialog(null)}
              >
                Cancel
              </Button>
              <Button type="submit" size="sm">
                {folderDialog?.mode === "rename" ? "Rename" : "Create folder"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Delete folder */}
      <Dialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Delete &quot;{deleteTarget?.name}&quot;</DialogTitle>
            <DialogDescription>
              This folder holds {deleteTarget?.totalFlows ?? 0} flow
              {deleteTarget?.totalFlows === 1 ? "" : "s"} and{" "}
              {deleteTarget?.children.length ?? 0} subfolder
              {deleteTarget?.children.length === 1 ? "" : "s"}. Choose what
              happens to them.
            </DialogDescription>
          </DialogHeader>

          <DialogFooter className="sm:flex-col sm:items-stretch sm:gap-2">
            <Button size="sm" variant="outline" onClick={() => removeFolder(false)}>
              <IconFolderSymlink className="size-3.5" />
              Delete folder, keep contents
            </Button>
            <Button
              size="sm"
              variant="destructive"
              onClick={() => removeFolder(true)}
            >
              <IconTrash className="size-3.5" />
              Delete folder and everything inside
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setDeleteTarget(null)}>
              Cancel
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function EmptyState({
  hasFlows,
  folderLabel,
  onCreate,
  onBrowse,
}: {
  hasFlows: boolean;
  folderLabel: string;
  onCreate: () => void;
  onBrowse: () => void;
}) {
  return (
    <div className="flex h-full min-h-64 flex-col items-center justify-center gap-3 rounded-xl border border-dashed bg-card/30 py-16 text-center">
      <IconSitemap className="size-9 text-muted-foreground/50" />
      <div>
        <p className="text-xs font-medium text-foreground">
          {hasFlows ? `Nothing in ${folderLabel}` : "No service flows yet"}
        </p>
        <p className="mt-0.5 text-[11px] text-muted-foreground">
          {hasFlows
            ? "Drag a flow onto this pane to move it here, or create a new one."
            : "Create a canvas, or start from a blueprint."}
        </p>
      </div>
      <div className="flex items-center gap-2">
        <Button size="sm" onClick={onCreate}>
          <IconPlus className="size-3.5" />
          New flow
        </Button>
        <Button size="sm" variant="outline" onClick={onBrowse}>
          <IconSparkles className="size-3.5 text-amber-500" />
          Blueprints
        </Button>
      </div>
    </div>
  );
}

type MoveMenuProps = {
  folderOptions: { id: string; label: string }[];
  onMove: (folderId: string | null) => void;
};

function FlowActionsMenu({
  folderOptions,
  onMove,
  onExport,
  onDuplicate,
  flowId,
  flowName,
}: MoveMenuProps & {
  onExport: () => void;
  onDuplicate: () => void;
  flowId: string;
  flowName: string;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className="flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
        render={<button type="button" aria-label={`Actions for ${flowName}`} />}
      >
        <IconDotsVertical className="size-3.5" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52 text-xs">
        <DropdownMenuItem onClick={onExport}>
          <IconDownload className="size-3.5" />
          Export JSON
        </DropdownMenuItem>
        <DropdownMenuItem onClick={onDuplicate}>
          <IconCopy className="size-3.5" />
          Duplicate
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuLabel className="text-[10px] uppercase tracking-wide">
            Move to
          </DropdownMenuLabel>
          <DropdownMenuItem onClick={() => onMove(null)}>
            <IconStack2 className="size-3.5" />
            All flows (root)
          </DropdownMenuItem>
          {folderOptions.length === 0 ? (
            <DropdownMenuItem disabled>
              <IconFolderPlus className="size-3.5" />
              No folders yet
            </DropdownMenuItem>
          ) : (
            folderOptions.map((option) => (
              <DropdownMenuItem
                key={option.id}
                onClick={() => onMove(option.id)}
                className="truncate"
              >
                <IconFolder className="size-3.5 text-amber-500/90" />
                {option.label}
              </DropdownMenuItem>
            ))
          )}
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <form
          action={async (formData) => {
            const res = await deleteFlow(formData);
            if (res.error) toast.error(res.error);
          }}
        >
          <input type="hidden" name="id" value={flowId} />
          <DropdownMenuItem
            variant="destructive"
            // A real submit button, so the form posts; Base UI has to be told.
            nativeButton
            render={<button type="submit" />}
            closeOnClick={false}
          >
            <IconTrash className="size-3.5" />
            Delete flow
          </DropdownMenuItem>
        </form>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function FlowCard({
  flow,
  folderLabel,
  folderOptions,
  onDragStart,
  onDragEnd,
  onExport,
  onDuplicate,
  onMove,
}: MoveMenuProps & {
  flow: FlowRow;
  folderLabel?: string;
  onDragStart: (e: React.DragEvent) => void;
  onDragEnd: () => void;
  onExport: () => void;
  onDuplicate: () => void;
}) {
  const { nodes, edges } = graphStats(flow.graph);
  const preview = nodes.slice(0, 3);
  const extra = Math.max(0, nodes.length - 3);

  return (
    <div
      draggable
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      className="group flex cursor-grab flex-col gap-2.5 rounded-xl border bg-card/70 p-3 transition-colors hover:border-primary/50 hover:bg-card active:cursor-grabbing"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <Link
            href={flowHref(flow.id)}
            className="block truncate text-xs font-semibold hover:underline"
          >
            {flow.name}
          </Link>
          <p className="mt-0.5 flex items-center gap-1 text-[10px] text-muted-foreground">
            <span>{formatRelativeTime(flow.updatedAt)}</span>
            <span>·</span>
            <span>{nodes.length} steps</span>
            <span>·</span>
            <span>{edges.length} wires</span>
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {flow.environment && (
            <Badge variant="secondary" className="font-mono text-[10px]">
              {flow.environment}
            </Badge>
          )}
          <FlowActionsMenu
            flowId={flow.id}
            flowName={flow.name}
            folderOptions={folderOptions}
            onMove={onMove}
            onExport={onExport}
            onDuplicate={onDuplicate}
          />
        </div>
      </div>

      <div className="flex items-center gap-1.5 overflow-hidden rounded-md border bg-muted/30 px-2 py-1.5 font-mono text-[10px]">
        {preview.length === 0 ? (
          <span className="text-muted-foreground italic">Empty canvas</span>
        ) : (
          preview.map((node, i) => (
            <div key={node.id} className="flex min-w-0 items-center gap-1">
              <span
                className="truncate rounded border bg-background px-1.5 py-0.5"
                title={node.label}
              >
                {node.label}
              </span>
              {i < preview.length - 1 && (
                <IconArrowRight className="size-3 shrink-0 text-muted-foreground" />
              )}
            </div>
          ))
        )}
        {extra > 0 && (
          <span className="shrink-0 text-muted-foreground">+{extra}</span>
        )}
      </div>

      <div className="mt-auto flex items-center justify-between border-t pt-2">
        {folderLabel ? (
          <span className="flex items-center gap-1 truncate text-[10px] text-muted-foreground">
            <IconFolder className="size-3 text-amber-500/80" />
            {folderLabel}
          </span>
        ) : (
          <span className="text-[10px] text-muted-foreground">Root</span>
        )}
        <Link
          href={flowHref(flow.id)}
          className="text-[11px] font-medium text-primary hover:underline"
        >
          Open canvas →
        </Link>
      </div>
    </div>
  );
}

function FlowTable({
  flows,
  byId,
  folderOptions,
  onExport,
  onDuplicate,
  onMove,
  onDragStart,
  onDragEnd,
}: {
  flows: FlowRow[];
  byId: Map<string, FolderNode>;
  folderOptions: { id: string; label: string }[];
  onExport: (flow: FlowRow) => void;
  onDuplicate: (id: string) => void;
  onMove: (id: string, folderId: string | null) => void;
  onDragStart: (e: React.DragEvent, flow: FlowRow) => void;
  onDragEnd: () => void;
}) {
  return (
    <div className="overflow-hidden rounded-xl border">
      <table className="w-full text-left text-xs">
        <thead className="border-b bg-muted/50 text-muted-foreground">
          <tr>
            <th className="p-2.5 font-medium">Flow</th>
            <th className="p-2.5 font-medium">Folder</th>
            <th className="p-2.5 font-medium">Environment</th>
            <th className="p-2.5 font-medium">Steps</th>
            <th className="p-2.5 font-medium">Wires</th>
            <th className="p-2.5 font-medium">Updated</th>
            <th className="p-2.5" />
          </tr>
        </thead>
        <tbody className="divide-y">
          {flows.map((flow) => {
            const { nodes, edges } = graphStats(flow.graph);
            return (
              <tr
                key={flow.id}
                draggable
                onDragStart={(e) => onDragStart(e, flow)}
                onDragEnd={onDragEnd}
                className="cursor-grab transition-colors hover:bg-muted/30 active:cursor-grabbing"
              >
                <td className="p-2.5 font-medium">
                  <Link
                    href={flowHref(flow.id)}
                    className="hover:underline"
                  >
                    {flow.name}
                  </Link>
                </td>
                <td className="p-2.5 text-muted-foreground">
                  {flow.folderId ? (byId.get(flow.folderId)?.name ?? "—") : "Root"}
                </td>
                <td className="p-2.5 font-mono text-[11px] text-muted-foreground">
                  {flow.environment || "—"}
                </td>
                <td className="p-2.5 tabular-nums">{nodes.length}</td>
                <td className="p-2.5 tabular-nums">{edges.length}</td>
                <td className="p-2.5 text-muted-foreground">
                  {formatRelativeTime(flow.updatedAt)}
                </td>
                <td className="p-2.5 text-right">
                  <FlowActionsMenu
                    flowId={flow.id}
                    flowName={flow.name}
                    folderOptions={folderOptions}
                    onMove={(folderId) => onMove(flow.id, folderId)}
                    onExport={() => onExport(flow)}
                    onDuplicate={() => onDuplicate(flow.id)}
                  />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
