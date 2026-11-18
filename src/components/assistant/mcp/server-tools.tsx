"use client";

// Per-server tool control in Settings: a checkbox for every tool of a running
// MCP server (unchecked = the assistant never sees it) and a read-only switch
// (only tools that resolve to a read are offered).

import { useEffect, useState } from "react";
import { IconChevronRight } from "@tabler/icons-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import { RiskBadge } from "@/components/assistant/messages";
import type { McpServerConfig, McpServerStatus } from "@/lib/assistant/api";
import { errorMessage } from "@/lib/settings";
import { mcpSetDisabledTools, mcpTools, type McpToolInfo } from "./mcp-api";

function ServerTools({
  server,
  tools,
  config,
  onReadOnly,
  onChange,
}: {
  server: string;
  tools: McpToolInfo[];
  /** Settings-page servers only: a project server's read-only flag is not editable here. */
  config: McpServerConfig | undefined;
  onReadOnly: (on: boolean) => void;
  onChange: (tools: McpToolInfo[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const offered = tools.filter((t) => !t.disabled && !t.hidden).length;

  const setDisabled = (disabled: string[]) =>
    mcpSetDisabledTools(server, disabled)
      .then(onChange)
      .catch((e) => toast.error(errorMessage(e)));
  const toggle = (t: McpToolInfo, on: boolean) =>
    setDisabled(
      tools
        .filter((x) => (x.original === t.original ? !on : x.disabled))
        .map((x) => x.original),
    );

  return (
    <div>
      <div className="flex items-center gap-2 px-3 py-2">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
        >
          <IconChevronRight
            className={`size-3.5 shrink-0 transition-transform ${open ? "rotate-90" : ""}`}
          />
          <span className="truncate text-xs font-medium">{server}</span>
          <span className="shrink-0 text-[10px] text-muted-foreground">
            {offered} of {tools.length} tools offered
          </span>
        </button>
        {config && (
          <label
            className="flex shrink-0 items-center gap-1.5 text-[10px] text-muted-foreground"
            title="Only tools that resolve to a read are offered, and they run without approval"
          >
            Read-only
            <Switch
              checked={config.readOnly}
              onCheckedChange={onReadOnly}
              aria-label={`Read-only: ${server}`}
            />
          </label>
        )}
      </div>
      {open && (
        <div className="border-t bg-muted/20">
          <div className="flex gap-1 px-3 py-1.5">
            <Button
              variant="ghost"
              size="xs"
              onClick={() => void setDisabled([])}
            >
              All on
            </Button>
            <Button
              variant="ghost"
              size="xs"
              onClick={() => void setDisabled(tools.map((t) => t.original))}
            >
              All off
            </Button>
          </div>
          <ul className="max-h-72 divide-y overflow-y-auto">
            {tools.map((t) => (
              <li key={t.name} className="px-3 py-1.5">
                <label
                  className={`flex items-start gap-2 ${t.hidden ? "opacity-50" : ""}`}
                >
                  <Checkbox
                    className="mt-0.5"
                    checked={!t.disabled && !t.hidden}
                    disabled={t.hidden}
                    onCheckedChange={(c) => void toggle(t, c === true)}
                    aria-label={`Offer ${t.original}`}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-1.5">
                      <code className="font-mono text-[11px] font-medium">
                        {t.original}
                      </code>
                      <RiskBadge risk={t.risk} />
                      {t.hidden && (
                        <Badge
                          variant="outline"
                          className="h-4 py-0 text-[9px] font-normal"
                        >
                          hidden by read-only
                        </Badge>
                      )}
                    </span>
                    {t.description && (
                      <span className="line-clamp-2 text-[11px] text-muted-foreground">
                        {t.description}
                      </span>
                    )}
                  </span>
                </label>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/**
 * The tools of every running MCP server. `servers` is the status list, so the
 * tools reload when a server starts, stops or is edited; `onChanged` lets the
 * page refresh its own tool count.
 */
export function McpToolFilters({
  servers,
  configs,
  onReadOnly,
  onChanged,
}: {
  servers: McpServerStatus[];
  configs: McpServerConfig[];
  onReadOnly: (server: string, on: boolean) => void;
  onChanged: () => void;
}) {
  const [tools, setTools] = useState<McpToolInfo[]>([]);
  const key = servers
    .map((s) => `${s.name}:${s.state}:${s.toolCount}`)
    .join("|");

  useEffect(() => {
    let cancelled = false;
    mcpTools()
      .then((t) => !cancelled && setTools(t))
      .catch(() => !cancelled && setTools([]));
    return () => {
      cancelled = true;
    };
  }, [key]);

  const names = [...new Set(tools.map((t) => t.server))];
  if (names.length === 0) return null;
  return (
    <Card className="gap-0 py-0">
      <p className="px-3 pt-2.5 pb-1 text-[11px] text-muted-foreground">
        Choose which tools of each running server the assistant may use.
      </p>
      <ul className="divide-y">
        {names.map((name) => (
          <li key={name}>
            <ServerTools
              server={name}
              tools={tools.filter((t) => t.server === name)}
              config={configs.find((c) => c.name === name)}
              onReadOnly={(on) => onReadOnly(name, on)}
              onChange={(t) => {
                setTools(t);
                onChanged();
              }}
            />
          </li>
        ))}
      </ul>
    </Card>
  );
}
