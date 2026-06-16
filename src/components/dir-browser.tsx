"use client";

import { useState, useCallback } from "react";
import {
  IconFolder,
  IconFolderOpen,
  IconChevronUp,
  IconLoader2,
} from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";

interface DirEntry {
  name: string;
  path: string;
}

interface DirResponse {
  entries?: DirEntry[];
  currentPath?: string;
  error?: string;
}

interface DirBrowserProps {
  onSelect: (path: string) => void;
  initialPath?: string;
  disabled?: boolean;
}

export function DirBrowser({ onSelect, initialPath = "", disabled }: DirBrowserProps) {
  const [open, setOpen] = useState(false);
  const [currentPath, setCurrentPath] = useState("");
  const [entries, setEntries] = useState<DirEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadDir = useCallback(async (dirPath: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/fs/dirs?path=${encodeURIComponent(dirPath)}`);
      const data: DirResponse = await res.json();
      if (!res.ok || data.error) throw new Error(data.error ?? "Failed to load directory");
      setCurrentPath(data.currentPath ?? "");
      setEntries(data.entries ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  const handleOpenChange = useCallback(
    (next: boolean) => {
      setOpen(next);
      if (next) {
        const start = initialPath.replace(/^\.\/?/, "");
        loadDir(start);
      }
    },
    [initialPath, loadDir]
  );

  // parent: null means we're at root (no ".." entry)
  const parentPath: string | null = currentPath
    ? currentPath.split("/").slice(0, -1).join("/")
    : null;

  const displayPath = currentPath ? `./${currentPath}` : ".";

  const handleSelect = () => {
    onSelect(currentPath ? `./${currentPath}` : ".");
    setOpen(false);
  };

  return (
    <>
      <Button
        variant="outline"
        size="icon-sm"
        type="button"
        disabled={disabled}
        onClick={() => handleOpenChange(true)}
        title="Browse directories"
        className="shrink-0"
      >
        <IconFolder className="size-3.5" />
      </Button>

      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent className="sm:max-w-md" showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Select directory</DialogTitle>
          </DialogHeader>

          {/* Current path bar */}
          <div className="flex items-center gap-1.5 px-2 py-1.5 bg-muted/50 rounded-md overflow-hidden">
            <IconFolderOpen className="size-3 shrink-0 text-muted-foreground" />
            <span className="text-[11px] font-mono text-muted-foreground truncate">
              {displayPath}
            </span>
          </div>

          {/* Listing */}
          <div className="border rounded-md overflow-hidden">
            <div className="max-h-64 overflow-y-auto">
              {loading && (
                <div className="flex items-center gap-2 px-3 py-4 text-xs text-muted-foreground">
                  <IconLoader2 className="size-3.5 animate-spin" />
                  Loading…
                </div>
              )}
              {!loading && error && (
                <p className="px-3 py-4 text-xs text-destructive">{error}</p>
              )}
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
                    <p className="px-3 py-4 text-xs text-muted-foreground">
                      No subdirectories
                    </p>
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

          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button size="sm" onClick={handleSelect} disabled={loading}>
              Select this directory
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
