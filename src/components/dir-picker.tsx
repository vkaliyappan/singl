"use client";

import { useState, useCallback } from "react";
import {
  IconFolder,
  IconFolderOpen,
  IconChevronRight,
  IconHome,
  IconLoader2,
} from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

interface DirEntry {
  name: string;
  path: string;
}

interface DirPickerProps {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  /** If set, the browser is rooted here — navigation cannot go above this directory. */
  startFrom?: string;
  className?: string;
  inputClassName?: string;
}

function normalize(p: string) {
  return p.trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
}

export function DirPicker({ value, onChange, placeholder, startFrom, className, inputClassName }: DirPickerProps) {
  const root = normalize(startFrom ?? "");

  const [open, setOpen] = useState(false);
  const [browsePath, setBrowsePath] = useState(root);
  const [entries, setEntries] = useState<DirEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadDir = useCallback(async (p: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/fs/dirs?path=${encodeURIComponent(p)}`);
      const data = (await res.json()) as { entries?: DirEntry[]; error?: string };
      if (!res.ok) throw new Error(data.error ?? "Failed to load");
      setEntries(data.entries ?? []);
      setBrowsePath(p);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  // Called by the Popover when open state changes — event handler, not an effect
  const handleOpenChange = useCallback((newOpen: boolean) => {
    setOpen(newOpen);
    if (newOpen) {
      const r = normalize(startFrom ?? "");
      const fromValue = normalize(value);
      const start = (r && fromValue.startsWith(r)) || (!r && fromValue) ? fromValue : r;
      void loadDir(start);
    }
  }, [value, startFrom, loadDir]);

  const atRoot = browsePath === root;

  const navigateUp = useCallback(() => {
    if (atRoot) return;
    const parent = browsePath.includes("/")
      ? browsePath.slice(0, browsePath.lastIndexOf("/"))
      : "";
    // Never go above the root boundary
    const target = root && !parent.startsWith(root) ? root : parent;
    loadDir(target);
  }, [atRoot, browsePath, root, loadDir]);

  const handleSelect = useCallback(() => {
    onChange(browsePath ? `./${browsePath}` : ".");
    setOpen(false);
  }, [browsePath, onChange]);

  // Breadcrumb: segments relative to root
  // e.g. root="export", browsePath="export/20260518/PROJ" → ["20260518", "PROJ"]
  const relPath = root
    ? browsePath.slice(root.length).replace(/^\//, "")
    : browsePath;
  const relSegments = relPath ? relPath.split("/") : [];

  return (
    <div className={cn("flex items-center gap-1", className)}>
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={cn("h-8 text-sm min-w-0", inputClassName)}
      />
      <Popover open={open} onOpenChange={handleOpenChange}>
        <PopoverTrigger
          className="h-8 w-8 shrink-0 flex items-center justify-center rounded-md border border-input bg-background hover:bg-accent/50 text-muted-foreground hover:text-foreground transition-colors"
          title="Browse folders"
          render={<button type="button" />}
        >
          <IconFolderOpen className="size-3.5" />
        </PopoverTrigger>
        <PopoverContent className="w-80 p-0 gap-0" side="bottom" align="end">

          {/* Breadcrumb — scoped to root */}
          <div className="flex items-center gap-0.5 px-2 py-1.5 border-b flex-wrap min-h-8">
            <button
              onClick={() => loadDir(root)}
              className="flex items-center gap-1 p-1 rounded hover:bg-accent/60 transition-colors text-muted-foreground hover:text-foreground"
              title={root || "Root"}
            >
              <IconHome className="size-3.5" />
              {root && (
                <span className={cn("text-xs font-mono", relSegments.length === 0 ? "text-foreground font-medium" : "")}>
                  {root}
                </span>
              )}
            </button>
            {relSegments.map((seg, i) => (
              <div key={i} className="flex items-center gap-0.5">
                <IconChevronRight className="size-3 text-muted-foreground shrink-0" />
                <button
                  onClick={() => {
                    const target = [root, ...relSegments.slice(0, i + 1)].filter(Boolean).join("/");
                    loadDir(target);
                  }}
                  className={cn(
                    "text-xs px-1 py-0.5 rounded hover:bg-accent/60 transition-colors font-mono truncate max-w-28",
                    i === relSegments.length - 1 ? "text-foreground font-medium" : "text-muted-foreground"
                  )}
                >
                  {seg}
                </button>
              </div>
            ))}
          </div>

          {/* Directory list */}
          <div className="max-h-52 overflow-y-auto">
            {loading ? (
              <div className="flex items-center justify-center py-6 gap-2 text-muted-foreground">
                <IconLoader2 className="size-4 animate-spin" />
                <span className="text-xs">Loading…</span>
              </div>
            ) : error ? (
              <p className="text-xs text-destructive px-3 py-3">{error}</p>
            ) : (
              <div className="py-1">
                {/* .. only shown when not at root boundary */}
                {!atRoot && (
                  <button
                    onClick={navigateUp}
                    className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-muted-foreground hover:bg-accent/50 transition-colors"
                  >
                    <IconFolder className="size-3.5 shrink-0" />
                    <span className="font-mono">..</span>
                  </button>
                )}
                {entries.length === 0 ? (
                  <p className="text-xs text-muted-foreground px-3 py-3 text-center">No subdirectories</p>
                ) : (
                  entries.map((e) => (
                    <button
                      key={e.path}
                      onClick={() => loadDir(e.path)}
                      className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-accent/50 transition-colors"
                    >
                      <IconFolder className="size-3.5 shrink-0 text-amber-500" />
                      <span className="font-mono truncate">{e.name}</span>
                    </button>
                  ))
                )}
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="border-t px-2 py-1.5 flex items-center justify-between gap-2">
            <span className="text-[11px] text-muted-foreground font-mono truncate">
              {browsePath ? `./${browsePath}` : "."}
            </span>
            <Button size="sm" className="h-6 text-xs px-2.5 shrink-0" onClick={handleSelect}>
              Select
            </Button>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}
