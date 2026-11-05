"use client";

import { useState, useCallback } from "react";
import {
  IconFolder,
  IconFolderOpen,
  IconFolderPlus,
  IconChevronUp,
  IconLoader2,
  IconDatabase,
} from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { errorMessage } from "@/lib/settings";
import { listRepositoryDirs, type RepositoryDir } from "@/lib/twx";

// Ported from singl-web; /api/twx/repo-dirs is the twx_repo_dirs command.

interface RepoDirBrowserProps {
  onSelect: (path: string) => void;
  /** Environment whose SystemRepository is browsed; the button is disabled without one. */
  env?: string;
  initialPath?: string;
  disabled?: boolean;
}

function joinRepoPath(dir: string, name: string): string {
  return dir === "/" ? `/${name}` : `${dir}/${name}`;
}

/** Folder picker over a ThingWorx SystemRepository, like DirBrowser for local disk. */
export function RepoDirBrowser({ onSelect, env = "", initialPath = "/", disabled }: RepoDirBrowserProps) {
  const [open, setOpen] = useState(false);
  const [currentPath, setCurrentPath] = useState("/");
  const [entries, setEntries] = useState<RepositoryDir[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newFolder, setNewFolder] = useState("");

  const loadDir = useCallback(
    async (dirPath: string) => {
      setLoading(true);
      setError(null);
      try {
        const data = await listRepositoryDirs(env, dirPath);
        setCurrentPath(data.currentPath);
        setEntries(data.entries);
      } catch (err) {
        setError(errorMessage(err));
      } finally {
        setLoading(false);
      }
    },
    [env]
  );

  const handleOpenChange = useCallback(
    (next: boolean) => {
      setOpen(next);
      if (next) {
        setNewFolder("");
        loadDir(initialPath || "/");
      }
    },
    [initialPath, loadDir]
  );

  const parentPath: string | null =
    currentPath === "/" ? null : currentPath.split("/").slice(0, -1).join("/") || "/";

  const trimmedNew = newFolder.trim().replace(/[\\/]+/g, "");
  const selection = trimmedNew ? joinRepoPath(currentPath, trimmedNew) : currentPath;

  const handleSelect = () => {
    onSelect(selection);
    setOpen(false);
  };

  return (
    <>
      <Button
        variant="outline"
        size="icon-sm"
        type="button"
        disabled={disabled || !env}
        onClick={() => handleOpenChange(true)}
        title={env ? "Browse SystemRepository folders" : "Choose an environment to browse its SystemRepository"}
        className="shrink-0"
      >
        <IconDatabase className="size-3.5" />
      </Button>

      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent className="sm:max-w-md" showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Select SystemRepository folder</DialogTitle>
          </DialogHeader>

          <div className="flex items-center gap-1.5 px-2 py-1.5 bg-muted/50 rounded-md overflow-hidden">
            <IconFolderOpen className="size-3 shrink-0 text-muted-foreground" />
            <span className="text-[11px] font-mono text-muted-foreground truncate">
              SystemRepository{currentPath === "/" ? "/" : currentPath}
            </span>
            {env && (
              <span className="ml-auto text-[10px] text-muted-foreground shrink-0">{env}</span>
            )}
          </div>

          <div className="border rounded-md overflow-hidden">
            <div className="max-h-64 overflow-y-auto">
              {loading && (
                <div className="flex items-center gap-2 px-3 py-4 text-xs text-muted-foreground">
                  <IconLoader2 className="size-3.5 animate-spin" />
                  Loading…
                </div>
              )}
              {!loading && error && <p className="px-3 py-4 text-xs text-destructive">{error}</p>}
              {!loading && !error && (
                <>
                  {parentPath !== null && (
                    <button
                      onClick={() => loadDir(parentPath)}
                      className="w-full flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground hover:bg-muted/50 transition-colors border-b"
                    >
                      <IconChevronUp className="size-3.5 shrink-0" />
                      <span className="font-mono">..</span>
                    </button>
                  )}
                  {entries.length === 0 ? (
                    <p className="px-3 py-4 text-xs text-muted-foreground">No subfolders</p>
                  ) : (
                    entries.map((entry) => (
                      <button
                        key={entry.path}
                        onClick={() => loadDir(entry.path)}
                        className="w-full flex items-center gap-2 px-3 py-2 text-xs hover:bg-muted/50 transition-colors border-b last:border-b-0"
                      >
                        <IconFolder className="size-3.5 shrink-0 text-muted-foreground" />
                        <span>{entry.name}</span>
                      </button>
                    ))
                  )}
                </>
              )}
            </div>
          </div>

          <div className="flex items-center gap-1.5">
            <IconFolderPlus className="size-3.5 shrink-0 text-muted-foreground" />
            <Input
              className="h-8 text-xs font-mono"
              placeholder="New subfolder (optional, created on upload)"
              value={newFolder}
              onChange={(e) => setNewFolder(e.target.value)}
            />
          </div>

          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={handleSelect}
              disabled={loading || !!error}
              className="max-w-64"
              title={selection}
            >
              <span className="truncate">Select {selection}</span>
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
