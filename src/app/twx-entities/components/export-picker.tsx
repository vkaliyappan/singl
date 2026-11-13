"use client";

// Picks which entities to export: lists every entity of the projects the
// toolbar's export covers, straight from the server, with search, type filter
// and checkboxes. Exports nothing itself; hands the selection to `onExport`.

import { useEffect, useMemo, useState } from "react";
import { IconDownload, IconRefresh, IconSearch } from "@tabler/icons-react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { listRemoteEntities, type RemoteEntity } from "@/lib/entities";
import { errorMessage } from "@/lib/settings";
import { cn } from "@/lib/utils";

const keyOf = (e: RemoteEntity) => `${e.project}\u0000${e.type}\u0000${e.name}`;

/** Rows drawn at once; the search narrows the rest. */
const MAX_ROWS = 500;

export function ExportPicker({
  open,
  onOpenChange,
  env,
  project,
  projectLabel,
  onExport,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  env: string;
  /** As for exportEnvEntities: undefined is every configured project. */
  project: string | undefined;
  projectLabel: string;
  onExport: (selected: RemoteEntity[]) => void;
}) {
  const [query, setQuery] = useState("");
  const [type, setType] = useState("all");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [refresh, setRefresh] = useState(0);

  // What the open dialog wants listed; a list is kept per env/project until
  // Refresh, so reopening the dialog does not refetch.
  const source = `${env}\u0000${project ?? ""}`;
  const want = open && env ? `${source}#${refresh}` : null;
  const [result, setResult] = useState<{
    key: string;
    source: string;
    entities: RemoteEntity[] | null;
    error: string | null;
  } | null>(null);
  const loading = want !== null && result?.key !== want;
  const entities = result?.source === source ? result.entities : null;
  const error = result?.key === want ? result?.error ?? null : null;

  useEffect(() => {
    if (!want || result?.key === want) return;
    let cancelled = false;
    const sameSource = result?.source === source;
    listRemoteEntities(env, project)
      .then((list) => {
        if (cancelled) return;
        list.sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name));
        setResult({ key: want, source, entities: list, error: null });
        if (sameSource) {
          // Refreshed: keep the picks that still exist.
          const keys = new Set(list.map(keyOf));
          setSelected((prev) => new Set([...prev].filter((k) => keys.has(k))));
        } else {
          setSelected(new Set());
          setType("all");
          setQuery("");
        }
      })
      .catch((err) => {
        if (!cancelled) setResult({ key: want, source, entities: null, error: errorMessage(err) });
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [want]);

  const multiProject = useMemo(
    () => new Set(entities?.map((e) => e.project)).size > 1,
    [entities]
  );
  const types = useMemo(
    () => [...new Set(entities?.map((e) => e.type))].sort(),
    [entities]
  );
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (entities ?? []).filter(
      (e) =>
        (type === "all" || e.type === type) &&
        (!q || e.name.toLowerCase().includes(q) || (multiProject && e.project.toLowerCase().includes(q)))
    );
  }, [entities, query, type, multiProject]);

  const visibleSelected = visible.filter((e) => selected.has(keyOf(e))).length;
  const allVisibleChecked = visible.length > 0 && visibleSelected === visible.length;

  const toggle = (e: RemoteEntity, on: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(keyOf(e));
      else next.delete(keyOf(e));
      return next;
    });

  const toggleVisible = (on: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      for (const e of visible) {
        if (on) next.add(keyOf(e));
        else next.delete(keyOf(e));
      }
      return next;
    });

  const submit = () => {
    const picked = (entities ?? []).filter((e) => selected.has(keyOf(e)));
    if (picked.length) onExport(picked);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl gap-3">
        <DialogHeader>
          <DialogTitle>Export selected entities</DialogTitle>
          <DialogDescription className="text-xs">
            {env} · {projectLabel}. Only the checked entities are exported; the projects&apos; export
            filters are ignored.
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <IconSearch className="absolute left-2 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
            <Input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search by name"
              className="h-8 pl-7 text-xs"
            />
          </div>
          <Select value={type} onValueChange={(v) => v && setType(v)}>
            <SelectTrigger className="h-8 w-44 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all" className="text-xs">
                All types
              </SelectItem>
              {types.map((t) => (
                <SelectItem key={t} value={t} className="text-xs">
                  {t}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            variant="outline"
            size="sm"
            className="h-8"
            onClick={() => setRefresh((n) => n + 1)}
            disabled={loading}
            title="Reload the list from ThingWorx"
          >
            <IconRefresh className={cn("size-3.5", loading && "animate-spin")} />
          </Button>
        </div>

        <div className="rounded-md border">
          <label className="flex items-center gap-2 border-b bg-muted/40 px-3 py-1.5 text-xs font-medium">
            <Checkbox
              checked={allVisibleChecked}
              indeterminate={visibleSelected > 0 && !allVisibleChecked}
              onCheckedChange={(on) => toggleVisible(!!on)}
              disabled={!visible.length}
            />
            <span>
              {query || type !== "all" ? "Select all shown" : "Select all"} ({visible.length})
            </span>
            <span className="ml-auto text-muted-foreground font-normal">
              {selected.size} selected
            </span>
          </label>
          <div className="h-80 overflow-y-auto">
            {loading && !entities ? (
              <div className="flex h-full items-center justify-center gap-2 text-xs text-muted-foreground">
                <Spinner className="size-3.5" /> Loading entities from ThingWorx…
              </div>
            ) : error ? (
              <p className="p-3 text-xs text-destructive">{error}</p>
            ) : !visible.length ? (
              <p className="p-3 text-xs text-muted-foreground">No entities match.</p>
            ) : (
              <>
                {visible.slice(0, MAX_ROWS).map((e) => {
                  const k = keyOf(e);
                  return (
                    <label
                      key={k}
                      className="flex items-center gap-2 px-3 py-1 text-xs hover:bg-muted/50 cursor-pointer"
                    >
                      <Checkbox checked={selected.has(k)} onCheckedChange={(on) => toggle(e, !!on)} />
                      <span className="font-mono truncate" title={e.name}>
                        {e.name}
                      </span>
                      <span className="ml-auto shrink-0 text-[10.5px] text-muted-foreground">
                        {multiProject ? `${e.project} · ${e.type}` : e.type}
                      </span>
                    </label>
                  );
                })}
                {visible.length > MAX_ROWS && (
                  <p className="px-3 py-2 text-[11px] text-muted-foreground">
                    Showing {MAX_ROWS} of {visible.length}. Search to narrow; &quot;Select all shown&quot;
                    still covers all {visible.length}.
                  </p>
                )}
              </>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button size="sm" onClick={submit} disabled={!selected.size}>
            <IconDownload className="size-3.5" />
            Export {selected.size || ""} selected
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
