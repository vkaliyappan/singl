"use client";

import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { useRouter } from "next/navigation";

import { flowHref } from "./actions";
import {
  IconExternalLink,
  IconFoldDown,
  IconFoldUp,
  IconFolder,
  IconFolderPlus,
  IconPencil,
  IconTrash,
} from "@tabler/icons-react";

import { Button } from "@/components/ui/button";
import {
  AppFileTree,
  AppFileTreeMenu,
  AppFileTreeMenuItem,
  AppFileTreeMenuSeparator,
  getTreeFolder,
  useAppFileTree,
} from "@/components/pierre-file-tree";
import { ROOT_ID, type FlowRow, type FolderNode } from "./hub-model";

export type DragPayload = { kind: "flow" | "folder"; id: string };
export type FolderMenuAction = "new-child" | "rename" | "delete";

type FlowTreeProps = {
  roots: FolderNode[];
  rootFlows: FlowRow[];
  totalFlows: number;
  selectedFolderId: string | null;
  onSelectFolder: (folderId: string | null) => void;
  expandedIds: string[];
  onExpandedChange: (ids: string[]) => void;
  onDropItem: (payload: DragPayload, folderId: string | null) => void;
  onFolderAction: (action: FolderMenuAction, folder: FolderNode) => void;
  onNewRootFolder: () => void;
  /**
   * Owned by the hub so a card dragged out of the main pane can be dropped on a
   * folder row here — `dataTransfer` is unreadable during dragover, so the
   * in-flight item has to be mirrored in state.
   */
  dragItem: DragPayload | null;
  onDragItemChange: (item: DragPayload | null) => void;
};

/** The "All flows" row; everything sits under it so it can be selected and dropped on. */
const ROOT_PATH = "All flows/";

type Entry =
  | { kind: "root"; totalFlows: number }
  | { kind: "folder"; folder: FolderNode }
  | { kind: "flow"; flow: FlowRow };

/**
 * The tree addresses rows by path and shows the last segment as the label,
 * so names become segments: "/" is swapped for a look-alike and siblings
 * with the same name get a " (2)" suffix.
 */
function buildPaths(roots: FolderNode[], rootFlows: FlowRow[], totalFlows: number) {
  const entries = new Map<string, Entry>([[ROOT_PATH, { kind: "root", totalFlows }]]);
  const folderPathById = new Map<string, string>();
  const paths: string[] = [];

  const add = (parent: string, folders: FolderNode[], flows: FlowRow[]) => {
    const used = new Set<string>();
    const segment = (name: string) => {
      const base = name.replaceAll("/", "∕").trim() || "untitled";
      let candidate = base;
      for (let n = 2; used.has(candidate.toLowerCase()); n++) candidate = `${base} (${n})`;
      used.add(candidate.toLowerCase());
      return candidate;
    };
    for (const folder of folders) {
      const path = `${parent}${segment(folder.name)}/`;
      entries.set(path, { kind: "folder", folder });
      folderPathById.set(folder.id, path);
      if (folder.children.length + folder.flows.length === 0) paths.push(path);
      add(path, folder.children, folder.flows);
    }
    for (const flow of flows) {
      const path = `${parent}${segment(flow.name)}`;
      entries.set(path, { kind: "flow", flow });
      paths.push(path);
    }
  };
  add(ROOT_PATH, roots, rootFlows);
  if (paths.length === 0) paths.push(ROOT_PATH);

  return { paths, entries, folderPathById };
}

export function FlowTree({
  roots,
  rootFlows,
  totalFlows,
  selectedFolderId,
  onSelectFolder,
  expandedIds,
  onExpandedChange,
  onDropItem,
  onFolderAction,
  onNewRootFolder,
  dragItem,
  onDragItemChange,
}: FlowTreeProps) {
  const router = useRouter();
  const tree = useMemo(() => buildPaths(roots, rootFlows, totalFlows), [roots, rootFlows, totalFlows]);

  const pathOfFolder = (id: string | null) =>
    id === null || id === ROOT_ID ? ROOT_PATH : tree.folderPathById.get(id);
  /** Folder id a path stands for; null for the root, undefined for flows. */
  const folderIdOf = (path: string | null): string | null | undefined => {
    const entry = path === null ? { kind: "root" as const } : tree.entries.get(path);
    if (entry?.kind === "root") return null;
    if (entry?.kind === "folder") return entry.folder.id;
    return undefined;
  };
  const payloadOf = (path: string): DragPayload | null => {
    const entry = tree.entries.get(path);
    if (entry?.kind === "folder") return { kind: "folder", id: entry.folder.id };
    if (entry?.kind === "flow") return { kind: "flow", id: entry.flow.id };
    return null;
  };

  // The model reads its options once; these callbacks read the latest render.
  const latest = useRef({ tree, folderIdOf, payloadOf, onSelectFolder, onDropItem });
  useLayoutEffect(() => {
    latest.current = { tree, folderIdOf, payloadOf, onSelectFolder, onDropItem };
  });

  const { model, expandAll, collapseAll } = useAppFileTree({
    paths: tree.paths,
    activePath: pathOfFolder(selectedFolderId) ?? null,
    // Folder rows hold actions; merging single-child chains would hide them.
    flattenEmptyDirectories: false,
    initialExpandedPaths: expandedIds.flatMap((id) => pathOfFolder(id) ?? []),
    onFileOpen: (path) => {
      const entry = latest.current.tree.entries.get(path);
      if (entry?.kind === "flow") router.push(flowHref(entry.flow.id));
    },
    onSelectionChange: (selected) => {
      if (selected.length !== 1) return;
      const folderId = latest.current.folderIdOf(selected[0]);
      if (folderId !== undefined) latest.current.onSelectFolder(folderId);
    },
    renderRowDecoration: ({ item }) => {
      const entry = latest.current.tree.entries.get(item.path);
      if (entry?.kind === "root") return { text: String(entry.totalFlows), title: "Flows" };
      if (entry?.kind === "folder") {
        return { text: String(entry.folder.totalFlows), title: "Flows in this folder and below" };
      }
      return null;
    },
    dragAndDrop: {
      canDrag: (paths) => paths.length === 1 && latest.current.payloadOf(paths[0]) !== null,
      canDrop: ({ draggedPaths, target }) => {
        const { folderIdOf, payloadOf } = latest.current;
        const payload = payloadOf(draggedPaths[0]);
        const folderId = folderIdOf(target.directoryPath);
        return !!payload && folderId !== undefined && !(payload.kind === "folder" && payload.id === folderId);
      },
      onDropComplete: ({ draggedPaths, target }) => {
        const { folderIdOf, payloadOf, onDropItem } = latest.current;
        const payload = payloadOf(draggedPaths[0]);
        const folderId = folderIdOf(target.directoryPath);
        if (payload && folderId !== undefined) onDropItem(payload, folderId);
      },
    },
  });

  // Keep the hub's expanded ids in step with the tree. Notifications from a
  // path reset are skipped until the saved expansion has been re-applied.
  const appliedPaths = useRef<readonly string[] | null>(null);
  const expandedKey = useRef(expandedIds.join("\n"));
  useEffect(
    () =>
      model.subscribe(() => {
        if (appliedPaths.current !== latest.current.tree.paths) return;
        const ids = [ROOT_ID];
        for (const [path, entry] of latest.current.tree.entries) {
          if (entry.kind === "folder" && getTreeFolder(model, path)?.isExpanded()) ids.push(entry.folder.id);
        }
        const key = ids.join("\n");
        if (key === expandedKey.current) return;
        expandedKey.current = key;
        onExpandedChange(ids);
      }),
    [model, onExpandedChange]
  );
  useEffect(() => {
    expandedKey.current = expandedIds.join("\n");
    for (const id of expandedIds) {
      const path = pathOfFolder(id);
      if (path) getTreeFolder(model, path)?.expand();
    }
    appliedPaths.current = tree.paths;
    // pathOfFolder only reads `tree`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model, tree, expandedIds]);

  // Cards dragged in from the main pane are plain HTML5 drags the tree does
  // not know about; find the folder row under the pointer through the shadow root.
  const internalDrag = useRef(false);
  const folderAtEvent = (e: React.DragEvent): string | null | undefined => {
    for (const el of e.nativeEvent.composedPath()) {
      const path = el instanceof HTMLElement ? el.dataset.itemPath : undefined;
      if (path) return folderIdOf(path);
    }
    return undefined;
  };
  const acceptsExternal = (folderId: string | null | undefined): folderId is string | null =>
    !internalDrag.current &&
    dragItem !== null &&
    folderId !== undefined &&
    !(dragItem.kind === "folder" && dragItem.id === folderId);

  return (
    <div
      className="h-full min-h-0"
      onDragStart={(e) => {
        // Let rows dragged out of the tree land on the main pane too.
        for (const el of e.nativeEvent.composedPath()) {
          const path = el instanceof HTMLElement ? el.dataset.itemPath : undefined;
          if (!path) continue;
          internalDrag.current = true;
          onDragItemChange(payloadOf(path));
          return;
        }
      }}
      onDragEnd={() => {
        internalDrag.current = false;
        onDragItemChange(null);
      }}
      onDragOver={(e) => {
        const folderId = folderAtEvent(e);
        if (!acceptsExternal(folderId)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        const path = pathOfFolder(folderId);
        if (path && model.getFocusedPath() !== path) model.focusPath(path);
      }}
      onDrop={(e) => {
        const folderId = folderAtEvent(e);
        if (!acceptsExternal(folderId) || !dragItem) return;
        e.preventDefault();
        onDragItemChange(null);
        onDropItem(dragItem, folderId);
      }}
    >
      <AppFileTree
        model={model}
        header={
          <div className="select-none">
            <div className="flex items-center justify-between gap-2 px-3 py-1.5">
              <span className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                Library
              </span>
              <div className="flex items-center gap-0.5">
                <Button variant="ghost" size="icon-sm" onClick={expandAll} title="Expand All" aria-label="Expand all">
                  <IconFoldDown className="size-3.5" />
                </Button>
                <Button variant="ghost" size="icon-sm" onClick={collapseAll} title="Collapse All" aria-label="Collapse all">
                  <IconFoldUp className="size-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={onNewRootFolder}
                  title="New folder"
                  aria-label="New folder"
                >
                  <IconFolderPlus className="size-3.5" />
                </Button>
              </div>
            </div>
            {roots.length === 0 && (
              <p className="px-4 pb-2 text-xs leading-relaxed text-muted-foreground">
                No folders yet. Create one, then drag flows onto it to nest them.
              </p>
            )}
          </div>
        }
        renderContextMenu={(item, context) => {
          const run = (action: () => void) => () => {
            context.close();
            action();
          };
          const entry = tree.entries.get(item.path);
          if (!entry) return null;
          return (
            <AppFileTreeMenu>
              {entry.kind === "root" && (
                <AppFileTreeMenuItem icon={<IconFolderPlus />} onClick={run(onNewRootFolder)}>
                  New folder
                </AppFileTreeMenuItem>
              )}
              {entry.kind === "flow" && (
                <AppFileTreeMenuItem
                  icon={<IconExternalLink />}
                  onClick={run(() => router.push(flowHref(entry.flow.id)))}
                >
                  Open flow
                </AppFileTreeMenuItem>
              )}
              {entry.kind === "folder" && (
                <>
                  <AppFileTreeMenuItem
                    icon={<IconFolder />}
                    onClick={run(() => onFolderAction("new-child", entry.folder))}
                  >
                    New subfolder
                  </AppFileTreeMenuItem>
                  <AppFileTreeMenuItem
                    icon={<IconPencil />}
                    onClick={run(() => onFolderAction("rename", entry.folder))}
                  >
                    Rename
                  </AppFileTreeMenuItem>
                  <AppFileTreeMenuSeparator />
                  <AppFileTreeMenuItem
                    destructive
                    icon={<IconTrash />}
                    onClick={run(() => onFolderAction("delete", entry.folder))}
                  >
                    Delete
                  </AppFileTreeMenuItem>
                </>
              )}
            </AppFileTreeMenu>
          );
        }}
      />
    </div>
  );
}
