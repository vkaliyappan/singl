"use client";

// Settings → AI: the last 500 calls the assistant's MCP clients made
// (tools/call and resources/read), kept in memory only.

import { useCallback, useEffect, useState } from "react";
import { IconChevronRight, IconRefresh, IconTrash } from "@tabler/icons-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import { errorMessage } from "@/lib/settings";
import { cn } from "@/lib/utils";
import { mcpCallLog, mcpCallLogClear, type McpCallLogEntry } from "./mcp-api";

const time = (ms: number) =>
  new Date(ms).toLocaleTimeString(undefined, { hour12: false });

function size(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  return bytes < 1024 * 1024
    ? `${(bytes / 1024).toFixed(1)} KB`
    : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function duration(ms: number) {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

export function McpCallLog() {
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState<McpCallLogEntry[]>([]);
  const [server, setServer] = useState("");
  const [errorsOnly, setErrorsOnly] = useState(false);
  const [shown, setShown] = useState<number | null>(null);

  const load = useCallback(() => {
    mcpCallLog()
      .then(setEntries)
      .catch(() => {});
  }, []);

  // Loaded when opened, then followed while it stays open.
  useEffect(() => {
    if (!open) return;
    load();
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [open, load]);

  const servers = [...new Set(entries.map((e) => e.server))].sort();
  const rows = entries.filter(
    (e) => (!server || e.server === server) && (!errorsOnly || e.error),
  );

  return (
    <Card className="gap-0 py-0">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-2 px-3.5 py-2.5 text-left"
      >
        <IconChevronRight
          className={`size-3.5 transition-transform ${open ? "rotate-90" : ""}`}
        />
        <span className="text-xs font-semibold">Call log</span>
        <span className="text-[11px] text-muted-foreground">
          Calls to MCP servers since the app started (last 500)
        </span>
      </button>
      {open && (
        <div className="border-t">
          <div className="flex flex-wrap items-center gap-2 px-3 py-2">
            <NativeSelect
              size="sm"
              value={server}
              onChange={(e) => setServer(e.target.value)}
              aria-label="Filter by server"
            >
              <NativeSelectOption value="">All servers</NativeSelectOption>
              {servers.map((s) => (
                <NativeSelectOption key={s} value={s}>
                  {s}
                </NativeSelectOption>
              ))}
            </NativeSelect>
            <label className="flex items-center gap-1.5 text-[11px]">
              <Checkbox
                checked={errorsOnly}
                onCheckedChange={(c) => setErrorsOnly(c === true)}
              />
              Errors only
            </label>
            <span className="flex-1" />
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Refresh the call log"
              onClick={load}
            >
              <IconRefresh />
            </Button>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Clear the call log"
              disabled={entries.length === 0}
              onClick={() =>
                void mcpCallLogClear()
                  .then(() => setEntries([]))
                  .catch((e) => toast.error(errorMessage(e)))
              }
            >
              <IconTrash />
            </Button>
          </div>
          {rows.length === 0 ? (
            <p className="px-3 pb-3 text-[11px] text-muted-foreground">
              {entries.length === 0
                ? "No calls yet."
                : "No calls match the filter."}
            </p>
          ) : (
            <ul className="max-h-96 divide-y overflow-y-auto border-t">
              {rows.map((e) => (
                <li key={e.id} className="px-3 py-1.5">
                  <button
                    type="button"
                    className="flex w-full items-center gap-2 text-left text-[11px]"
                    aria-expanded={shown === e.id}
                    onClick={() => setShown(shown === e.id ? null : e.id)}
                  >
                    <span className="w-16 shrink-0 text-muted-foreground tabular-nums">
                      {time(e.startedAt)}
                    </span>
                    <span className="shrink-0 font-medium">{e.server}</span>
                    <code className="min-w-0 flex-1 truncate font-mono">
                      {e.kind === "resource" ? `read ${e.tool}` : e.tool}
                    </code>
                    <span className="shrink-0 text-muted-foreground tabular-nums">
                      {duration(e.durationMs)}
                    </span>
                    <span className="w-14 shrink-0 text-right text-muted-foreground tabular-nums">
                      {e.error ? "" : size(e.resultBytes)}
                    </span>
                    <span
                      className={cn(
                        "w-9 shrink-0 text-right",
                        e.error
                          ? "text-destructive"
                          : "text-success",
                      )}
                    >
                      {e.error ? "error" : "ok"}
                    </span>
                  </button>
                  {shown === e.id && (
                    <div className="mt-1 space-y-1">
                      {e.error && (
                        <p className="text-[11px] break-words text-destructive">
                          {e.error}
                        </p>
                      )}
                      <pre className="selectable max-h-40 overflow-auto rounded bg-muted/50 p-1.5 font-mono text-[10.5px] break-all whitespace-pre-wrap">
                        {e.args}
                      </pre>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Card>
  );
}
