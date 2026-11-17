"use client";

import { useMemo, type ReactNode } from "react";
import { IconClipboard, IconFileDiff, IconFolderOpen, IconSearch } from "@tabler/icons-react";
import {
  AppFileTree,
  AppFileTreeHeader,
  AppFileTreeMenu,
  AppFileTreeMenuItem,
  AppFileTreeMenuSeparator,
  getTreeFolder,
  useAppFileTree,
  type GitStatusEntry,
} from "@/components/pierre-file-tree";
import type { DiffNode, NodeStatus } from "@/lib/compare";

// Compare statuses → the tree's git statuses ("identical" gets none).
const GIT_STATUS: Partial<Record<NodeStatus, GitStatusEntry["status"]>> = {
  added: "added",
  removed: "deleted",
  modified: "modified",
};

/**
 * Compare diff tree. `files` are the file nodes that pass the current filters;
 * folders come from their paths. Open folders are reported through
 * `onExpandedChange` (folders end in "/").
 */
export function CompareFileTree({
  files,
  activePath,
  initialExpanded,
  header,
  onExpandedChange,
  onFileOpen,
  onCopyPath,
  leftRoot,
  rightRoot,
}: {
  files: readonly DiffNode[];
  activePath: string | null;
  initialExpanded: readonly string[];
  header?: ReactNode;
  onExpandedChange: (expanded: string[]) => void;
  onFileOpen: (path: string) => void;
  onCopyPath: (path: string) => void;
  /** Both relative to the workspace folder; rows drag from the side that exists. */
  leftRoot: string;
  rightRoot: string;
}) {
  const paths = useMemo(() => files.map((f) => f.path), [files]);
  const gitStatus = useMemo(
    () =>
      files.flatMap((f) => {
        const status = GIT_STATUS[f.status];
        return status ? [{ path: f.path, status }] : [];
      }),
    [files]
  );

  const { model, expandAll, collapseAll } = useAppFileTree({
    paths,
    gitStatus,
    activePath,
    onFileOpen,
    onExpandedChange,
    initialExpandedPaths: initialExpanded,
    dragItems: (treePaths) =>
      treePaths.map((p) => {
        const isDir = p.endsWith("/");
        const rel = p.replace(/\/$/, "");
        const under = files.filter((f) => (isDir ? f.path.startsWith(p) : f.path === rel));
        const root = under.some((f) => f.leftExists) || !under.some((f) => f.rightExists) ? leftRoot : rightRoot;
        return { path: `${root}/${rel}`, isDir };
      }),
  });

  return (
    <AppFileTree
      model={model}
      header={
        <AppFileTreeHeader
          title="Files"
          count={`${files.length} files`}
          onExpandAll={expandAll}
          onCollapseAll={collapseAll}
        >
          {header}
        </AppFileTreeHeader>
      }
      renderContextMenu={(item, context) => {
        const run = (action: () => void) => () => {
          context.close();
          action();
        };
        const relative = item.path.replace(/\/$/, "");
        const dir = getTreeFolder(model, item.path);
        return (
          <AppFileTreeMenu>
            {dir ? (
              <>
                <AppFileTreeMenuItem icon={<IconFolderOpen />} onClick={run(() => dir.toggle())}>
                  {dir.isExpanded() ? "Collapse" : "Expand"}
                </AppFileTreeMenuItem>
                <AppFileTreeMenuItem icon={<IconSearch />} onClick={run(() => model.openSearch(item.path))}>
                  Find in Folder
                </AppFileTreeMenuItem>
              </>
            ) : (
              <AppFileTreeMenuItem icon={<IconFileDiff />} onClick={run(() => onFileOpen(item.path))}>
                Open Diff
              </AppFileTreeMenuItem>
            )}
            <AppFileTreeMenuSeparator />
            <AppFileTreeMenuItem icon={<IconClipboard />} onClick={run(() => onCopyPath(relative))}>
              Copy Relative Path
            </AppFileTreeMenuItem>
          </AppFileTreeMenu>
        );
      }}
    />
  );
}
