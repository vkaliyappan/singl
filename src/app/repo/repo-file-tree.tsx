"use client";

import { useEffect, useState } from "react";
import { IconClipboard, IconFile, IconFolderOpen, IconSearch } from "@tabler/icons-react";
import { toast } from "sonner";
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
import { getRepoStatus, type RepoSlot } from "@/lib/repo";

// repo_status codes → the tree's git statuses.
const GIT_STATUS: Record<string, GitStatusEntry["status"]> = {
  M: "modified",
  A: "added",
  D: "deleted",
  "?": "untracked",
};

function copy(text: string) {
  navigator.clipboard.writeText(text).then(
    () => toast.success("Copied to clipboard"),
    () => toast.error("Could not copy")
  );
}

/**
 * Repo explorer tree. `paths` are relative to the repo root (folders end in
 * "/"); `rootPrefix` turns them into the app's file paths.
 */
export function RepoFileTree({
  slot,
  title,
  paths,
  rootPrefix,
  activePath,
  statusKey,
  onFileOpen,
}: {
  slot: RepoSlot;
  title: string;
  paths: readonly string[];
  rootPrefix: string;
  activePath: string | null;
  /** Bump to re-read git status. */
  statusKey?: number;
  onFileOpen: (path: string) => void;
}) {
  const prefix = `${rootPrefix}/`;
  const [gitStatus, setGitStatus] = useState<GitStatusEntry[]>([]);

  const { model, expandAll, collapseAll } = useAppFileTree({
    paths,
    gitStatus,
    activePath: activePath?.startsWith(prefix) ? activePath.slice(prefix.length) : null,
    onFileOpen: (path) => onFileOpen(prefix + path),
  });

  // Deleted files are not on disk, so they are not in the tree either.
  useEffect(() => {
    if (paths.length === 0) return;
    let cancelled = false;
    getRepoStatus(slot)
      .then((files) => {
        if (cancelled) return;
        const known = new Set(paths);
        setGitStatus(
          files
            .filter((f) => known.has(f.path) && GIT_STATUS[f.status])
            .map((f) => ({ path: f.path, status: GIT_STATUS[f.status] }))
        );
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [slot, paths, statusKey]);

  return (
    <AppFileTree
      model={model}
      header={
        <AppFileTreeHeader
          title={title}
          count={`${paths.length} files`}
          onExpandAll={expandAll}
          onCollapseAll={collapseAll}
        />
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
              <AppFileTreeMenuItem icon={<IconFile />} onClick={run(() => onFileOpen(prefix + item.path))}>
                Open
              </AppFileTreeMenuItem>
            )}
            <AppFileTreeMenuSeparator />
            <AppFileTreeMenuItem icon={<IconClipboard />} onClick={run(() => copy(prefix + relative))}>
              Copy Path
            </AppFileTreeMenuItem>
            <AppFileTreeMenuItem icon={<IconClipboard />} onClick={run(() => copy(relative))}>
              Copy Relative Path
            </AppFileTreeMenuItem>
          </AppFileTreeMenu>
        );
      }}
    />
  );
}
