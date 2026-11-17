"use client";

// Settings → AI: keys, defaults, agent CLIs, approvals, the app's MCP server,
// MCP servers the assistant connects to, and the tool list. Logic is in Rust
// (src-tauri/src/commands/assistant.rs); this only edits settings.

import { useCallback, useEffect, useState } from "react";
import {
  IconCheck,
  IconChevronRight,
  IconCopy,
  IconEdit,
  IconEye,
  IconEyeOff,
  IconPlus,
  IconRefresh,
  IconTrash,
} from "@tabler/icons-react";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { RiskBadge } from "@/components/assistant/messages";
import { errorMessage } from "@/lib/settings";
import {
  type ApprovalMode,
  assistantMcpInfo,
  assistantMcpRestart,
  assistantMcpServers,
  assistantModels,
  assistantProviders,
  assistantSettingsGet,
  assistantSettingsSet,
  assistantTools,
  type AssistantSettingsPatch,
  type AssistantSettingsView,
  type McpInfo,
  type McpServerConfig,
  type McpServerStatus,
  type ProviderInfo,
  type ToolSpec,
} from "@/lib/assistant/api";
import { AgentSettings } from "./agent-settings";

function SectionCard({
  title,
  description,
  children,
  actions,
}: {
  title: string;
  description?: React.ReactNode;
  children: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <Card className="gap-0 py-0">
      <CardHeader className="border-b px-3.5 py-2.5">
        <div className="flex items-center gap-2">
          <CardTitle className="text-xs font-semibold">{title}</CardTitle>
          {actions && <div className="ml-auto">{actions}</div>}
        </div>
        {description && (
          <CardDescription className="text-[11px]">
            {description}
          </CardDescription>
        )}
      </CardHeader>
      <CardContent className="space-y-3 p-3.5">{children}</CardContent>
    </Card>
  );
}

function copy(text: string, what: string) {
  void navigator.clipboard
    .writeText(text)
    .then(() => toast.success(`${what} copied`));
}

// ── API keys ────────────────────────────────────────────────────────────────

function KeyRow({
  label,
  has,
  field,
  save,
}: {
  label: string;
  has: boolean;
  field: "anthropicApiKey" | "openrouterApiKey";
  save: (patch: AssistantSettingsPatch) => Promise<void>;
}) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const run = async (key: string) => {
    setBusy(true);
    await save({ [field]: key });
    setValue("");
    setBusy(false);
  };
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Label htmlFor={field} className="w-24 text-xs">
        {label}
      </Label>
      <Input
        id={field}
        type="password"
        autoComplete="off"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={
          has ? "Saved — enter a new key to replace" : "Paste API key"
        }
        className="min-w-48 flex-1"
      />
      {has && (
        <Badge
          variant="secondary"
          className="h-4 border-green-500/20 bg-green-500/10 py-0 text-[9px] font-normal text-green-600 dark:text-green-400"
        >
          Saved
        </Badge>
      )}
      <Button
        size="sm"
        disabled={!value.trim() || busy}
        onClick={() => void run(value)}
      >
        Save
      </Button>
      <Button
        size="sm"
        variant="outline"
        disabled={!has || busy}
        onClick={() => void run("")}
      >
        Clear
      </Button>
    </div>
  );
}

// ── MCP server editor ───────────────────────────────────────────────────────

const toLines = (m: Record<string, string>) =>
  Object.entries(m)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
const fromLines = (text: string) =>
  Object.fromEntries(
    text
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.includes("="))
      .map((l) => [
        l.slice(0, l.indexOf("=")).trim(),
        l.slice(l.indexOf("=") + 1).trim(),
      ]),
  );

function ServerDialog({
  server,
  onClose,
  onSave,
}: {
  server: McpServerConfig | null;
  onClose: () => void;
  onSave: (s: McpServerConfig) => void;
}) {
  const [mode, setMode] = useState<"stdio" | "url">("stdio");
  const [name, setName] = useState("");
  const [command, setCommand] = useState("");
  const [args, setArgs] = useState("");
  const [env, setEnv] = useState("");
  const [url, setUrl] = useState("");
  const [headers, setHeaders] = useState("");
  const [readOnly, setReadOnly] = useState(false);

  useEffect(() => {
    if (!server) return;
    /* eslint-disable react-hooks/set-state-in-effect */
    setMode(server.url ? "url" : "stdio");
    setName(server.name);
    setCommand(server.command);
    setArgs(server.args.join("\n"));
    setEnv(toLines(server.env));
    setUrl(server.url);
    setHeaders(toLines(server.headers));
    setReadOnly(server.readOnly);
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [server]);

  const valid = name.trim() && (mode === "stdio" ? command.trim() : url.trim());
  return (
    <Dialog open={!!server} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {server?.name ? `Edit ${server.name}` : "Add MCP server"}
          </DialogTitle>
          <DialogDescription>
            Its tools become available to the assistant, prefixed with the
            server name.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <Label htmlFor="mcp-name" className="text-xs">
              Name
            </Label>
            <Input
              id="mcp-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="github"
            />
          </div>
          <div
            className="flex gap-1.5"
            role="radiogroup"
            aria-label="Transport"
          >
            {(["stdio", "url"] as const).map((m) => (
              <Button
                key={m}
                type="button"
                size="sm"
                variant={mode === m ? "default" : "outline"}
                role="radio"
                aria-checked={mode === m}
                onClick={() => setMode(m)}
              >
                {m === "stdio" ? "Command (stdio)" : "URL (HTTP)"}
              </Button>
            ))}
          </div>
          {mode === "stdio" ? (
            <>
              <div className="flex flex-col gap-1">
                <Label htmlFor="mcp-cmd" className="text-xs">
                  Command
                </Label>
                <Input
                  id="mcp-cmd"
                  value={command}
                  onChange={(e) => setCommand(e.target.value)}
                  placeholder="npx"
                  className="font-mono"
                />
              </div>
              <div className="flex flex-col gap-1">
                <Label htmlFor="mcp-args" className="text-xs">
                  Arguments (one per line)
                </Label>
                <Textarea
                  id="mcp-args"
                  value={args}
                  onChange={(e) => setArgs(e.target.value)}
                  rows={3}
                  className="min-h-16 font-mono"
                />
              </div>
              <div className="flex flex-col gap-1">
                <Label htmlFor="mcp-env" className="text-xs">
                  Environment (KEY=VALUE per line)
                </Label>
                <Textarea
                  id="mcp-env"
                  value={env}
                  onChange={(e) => setEnv(e.target.value)}
                  rows={3}
                  className="min-h-16 font-mono"
                />
              </div>
            </>
          ) : (
            <>
              <div className="flex flex-col gap-1">
                <Label htmlFor="mcp-url" className="text-xs">
                  URL
                </Label>
                <Input
                  id="mcp-url"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="https://host/mcp"
                  className="font-mono"
                />
              </div>
              <div className="flex flex-col gap-1">
                <Label htmlFor="mcp-headers" className="text-xs">
                  Headers (Name=value per line)
                </Label>
                <Textarea
                  id="mcp-headers"
                  value={headers}
                  onChange={(e) => setHeaders(e.target.value)}
                  rows={3}
                  className="min-h-16 font-mono"
                />
              </div>
            </>
          )}
          <label className="flex items-center gap-2 text-xs">
            <Checkbox
              checked={readOnly}
              onCheckedChange={(c) => setReadOnly(c === true)}
            />
            Read-only: its tools only read, so they run without approval
          </label>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={!valid}
            onClick={() =>
              onSave({
                name: name.trim(),
                enabled: server?.enabled ?? true,
                command: mode === "stdio" ? command.trim() : "",
                args:
                  mode === "stdio"
                    ? args
                        .split("\n")
                        .map((a) => a.trim())
                        .filter(Boolean)
                    : [],
                env: mode === "stdio" ? fromLines(env) : {},
                url: mode === "url" ? url.trim() : "",
                headers: mode === "url" ? fromLines(headers) : {},
                readOnly,
              })
            }
          >
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Main ────────────────────────────────────────────────────────────────────

const STATE_CLS: Record<string, string> = {
  running:
    "border-green-500/20 bg-green-500/10 text-green-600 dark:text-green-400",
  starting:
    "border-amber-500/20 bg-amber-500/10 text-amber-600 dark:text-amber-400",
  error: "border-red-500/20 bg-red-500/10 text-red-600 dark:text-red-400",
};

export function AiSettings() {
  const [s, setS] = useState<AssistantSettingsView | null>(null);
  const [error, setError] = useState("");
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [models, setModels] = useState<string[]>([]);
  const [mcp, setMcp] = useState<McpInfo | null>(null);
  const [servers, setServers] = useState<McpServerStatus[]>([]);
  const [tools, setTools] = useState<ToolSpec[]>([]);
  const [toolsOpen, setToolsOpen] = useState(false);
  const [showToken, setShowToken] = useState(false);
  const [confirmRegen, setConfirmRegen] = useState(false);
  const [editing, setEditing] = useState<McpServerConfig | null>(null);
  const [editingIndex, setEditingIndex] = useState(-1);
  const [model, setModel] = useState("");
  const [port, setPort] = useState("");

  const refreshMcp = useCallback(() => {
    assistantMcpInfo()
      .then(setMcp)
      .catch(() => {});
    assistantMcpServers()
      .then(setServers)
      .catch(() => {});
  }, []);

  const apply = useCallback((view: AssistantSettingsView) => {
    setS(view);
    setModel(view.defaultModel);
    setPort(String(view.mcpPort));
  }, []);

  useEffect(() => {
    assistantSettingsGet()
      .then(apply)
      .catch((e) => setError(errorMessage(e)));
    assistantProviders()
      .then(setProviders)
      .catch(() => {});
    assistantTools(false)
      .then(setTools)
      .catch(() => {});
    refreshMcp();
  }, [apply, refreshMcp]);

  const provider = s?.defaultProvider;
  useEffect(() => {
    if (!provider) return;
    let cancelled = false;
    assistantModels(provider)
      .then((m) => !cancelled && setModels(m.map((x) => x.id)))
      .catch(() => !cancelled && setModels([]));
    return () => {
      cancelled = true;
    };
  }, [provider]);

  const save = useCallback(
    async (patch: AssistantSettingsPatch) => {
      setError("");
      try {
        apply(await assistantSettingsSet(patch));
        if (
          "mcpEnabled" in patch ||
          "mcpPort" in patch ||
          "regenerateMcpToken" in patch ||
          "mcpServers" in patch ||
          "useProjectMcp" in patch ||
          "disabledProjectServers" in patch
        )
          refreshMcp();
        assistantProviders()
          .then(setProviders)
          .catch(() => {});
      } catch (e) {
        setError(errorMessage(e));
        toast.error(errorMessage(e));
      }
    },
    [apply, refreshMcp],
  );

  if (!s)
    return (
      <p className="text-xs text-muted-foreground">{error || "Loading…"}</p>
    );

  const setServerEnabled = (st: McpServerStatus, on: boolean) => {
    if (st.source === "project") {
      const off = new Set(s.disabledProjectServers);
      if (on) off.delete(st.name);
      else off.add(st.name);
      void save({ disabledProjectServers: [...off] });
    } else {
      void save({
        mcpServers: s.mcpServers.map((m) =>
          m.name === st.name ? { ...m, enabled: on } : m,
        ),
      });
    }
  };

  const saveServer = (server: McpServerConfig) => {
    const list = [...s.mcpServers];
    if (editingIndex >= 0) list[editingIndex] = server;
    else list.push(server);
    setEditing(null);
    void save({ mcpServers: list });
  };

  return (
    <div className="flex flex-col gap-3.5">
      {error && (
        <p className="text-[11px] font-medium text-destructive">{error}</p>
      )}

      <SectionCard
        title="API keys"
        description="Stored by the desktop app. Keys are never shown again after saving; environment variables are used when no key is saved."
      >
        <KeyRow
          label="Anthropic"
          has={s.hasAnthropicApiKey}
          field="anthropicApiKey"
          save={save}
        />
        <KeyRow
          label="OpenRouter"
          has={s.hasOpenrouterApiKey}
          field="openrouterApiKey"
          save={save}
        />
      </SectionCard>

      <SectionCard
        title="Defaults"
        description="Used for new chats until you pick something else in the assistant panel."
      >
        <div className="flex flex-wrap items-center gap-2">
          <Label htmlFor="ai-provider" className="w-24 text-xs">
            Provider
          </Label>
          <NativeSelect
            id="ai-provider"
            value={s.defaultProvider}
            onChange={(e) =>
              void save({ defaultProvider: e.target.value, defaultModel: "" })
            }
          >
            {providers.map((p) => (
              <NativeSelectOption key={p.id} value={p.id}>
                {p.title}
                {!p.available && p.note ? ` — ${p.note}` : ""}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Label htmlFor="ai-model" className="w-24 text-xs">
            Model
          </Label>
          <Input
            id="ai-model"
            list="ai-model-list"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder="Provider default"
            className="min-w-48 flex-1 font-mono"
          />
          <datalist id="ai-model-list">
            {models.slice(0, 400).map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
          <Button
            size="sm"
            disabled={model.trim() === s.defaultModel}
            onClick={() => void save({ defaultModel: model })}
          >
            Save
          </Button>
        </div>
      </SectionCard>

      <AgentSettings />

      <SectionCard
        title="Approvals"
        description="Each message picks Ask, Auto or Read-only in the composer. In Ask mode, read tools run and destructive tools (delete, deploy, push, run a service) always ask."
      >
        <label className="flex items-center gap-3 text-xs">
          <Switch
            checked={s.autoApproveWrites}
            onCheckedChange={(on) => void save({ autoApproveWrites: on })}
            aria-label="Auto-approve write actions"
          />
          In Ask mode, run write actions (changes that can be undone) without
          asking
        </label>
        <div className="mt-3 flex flex-wrap items-center gap-3 text-xs">
          <Label htmlFor="ai-external-mode" className="text-xs">
            Outside MCP clients (Claude Desktop, other agents)
          </Label>
          <NativeSelect
            id="ai-external-mode"
            size="sm"
            value={s.externalMcpMode}
            onChange={(e) =>
              void save({ externalMcpMode: e.target.value as ApprovalMode })
            }
          >
            <NativeSelectOption value="ask">
              Ask before changes
            </NativeSelectOption>
            <NativeSelectOption value="readOnly">Read-only</NativeSelectOption>
            <NativeSelectOption value="auto">
              Auto-approve everything
            </NativeSelectOption>
          </NativeSelect>
          {s.externalMcpMode === "auto" && (
            <span className="text-red-600 dark:text-red-400">
              Outside clients can deploy, delete and run services without
              asking.
            </span>
          )}
        </div>
      </SectionCard>

      <SectionCard
        title="App MCP server"
        description="Lets outside MCP clients (Claude Code, Claude Desktop…) use this app's tools. Listens on localhost only."
        actions={
          mcp && (
            <Badge
              variant="secondary"
              className={mcp.running ? STATE_CLS.running : ""}
            >
              {mcp.running ? "Running" : mcp.enabled ? "Stopped" : "Off"}
            </Badge>
          )
        }
      >
        <label className="flex items-center gap-3 text-xs">
          <Switch
            checked={s.mcpEnabled}
            onCheckedChange={(on) => void save({ mcpEnabled: on })}
            aria-label="Enable app MCP server"
          />
          Enabled
        </label>
        <div className="flex flex-wrap items-center gap-2">
          <Label htmlFor="mcp-port" className="w-24 text-xs">
            Port
          </Label>
          <Input
            id="mcp-port"
            inputMode="numeric"
            value={port}
            onChange={(e) => setPort(e.target.value.replace(/\D/g, ""))}
            className="w-24 font-mono"
          />
          <Button
            size="sm"
            disabled={!port || Number(port) === s.mcpPort}
            onClick={() => void save({ mcpPort: Number(port) })}
          >
            Apply
          </Button>
        </div>
        {mcp && (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <Label className="w-24 text-xs">URL</Label>
              <code className="selectable font-mono text-[11px]">
                {mcp.url ?? "not running"}
              </code>
              {mcp.url && (
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label="Copy URL"
                  onClick={() => copy(mcp.url!, "URL")}
                >
                  <IconCopy />
                </Button>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Label className="w-24 text-xs">Token</Label>
              <code className="selectable min-w-0 flex-1 truncate font-mono text-[11px]">
                {showToken ? mcp.token : "•".repeat(24)}
              </code>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={showToken ? "Hide token" : "Reveal token"}
                onClick={() => setShowToken((v) => !v)}
              >
                {showToken ? <IconEyeOff /> : <IconEye />}
              </Button>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label="Copy token"
                onClick={() => copy(mcp.token, "Token")}
              >
                <IconCopy />
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setConfirmRegen(true)}
              >
                <IconRefresh /> Regenerate
              </Button>
            </div>
            <div className="flex flex-col gap-1">
              <div className="flex items-center gap-1">
                <span className="text-[11px] font-medium">
                  Config (.mcp.json / Claude Desktop)
                </span>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label="Copy config"
                  onClick={() => copy(mcp.configSnippet, "Config")}
                >
                  <IconCopy />
                </Button>
              </div>
              <pre className="selectable max-h-48 overflow-auto rounded-md border bg-muted/40 p-2 font-mono text-[10.5px]">
                {showToken
                  ? mcp.configSnippet
                  : mcp.configSnippet.replaceAll(mcp.token, "••••••••")}
              </pre>
            </div>
            <div className="flex flex-col gap-1">
              <div className="flex items-center gap-1">
                <span className="text-[11px] font-medium">Claude Code</span>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label="Copy command"
                  onClick={() => copy(mcp.claudeCommand, "Command")}
                >
                  <IconCopy />
                </Button>
              </div>
              <pre className="selectable overflow-auto rounded-md border bg-muted/40 p-2 font-mono text-[10.5px] whitespace-pre-wrap">
                {showToken
                  ? mcp.claudeCommand
                  : mcp.claudeCommand.replaceAll(mcp.token, "••••••••")}
              </pre>
              <p className="text-[10px] text-muted-foreground">
                Copy buttons always copy the real values, even while masked.
              </p>
            </div>
          </>
        )}
      </SectionCard>

      <SectionCard
        title="MCP servers the assistant uses"
        description="Extra tools from other MCP servers. Project servers come from the workspace .mcp.json."
        actions={
          <div className="flex gap-1">
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Refresh status"
              onClick={refreshMcp}
            >
              <IconRefresh />
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setEditingIndex(-1);
                setEditing({
                  name: "",
                  enabled: true,
                  command: "",
                  args: [],
                  env: {},
                  url: "",
                  headers: {},
                  readOnly: false,
                });
              }}
            >
              <IconPlus /> Add server
            </Button>
          </div>
        }
      >
        <label className="flex items-center gap-3 text-xs">
          <Switch
            checked={s.useProjectMcp}
            onCheckedChange={(on) => void save({ useProjectMcp: on })}
            aria-label="Use workspace .mcp.json"
          />
          Use workspace <code className="font-mono">.mcp.json</code>
        </label>
        {servers.length === 0 ? (
          <p className="text-[11px] text-muted-foreground">
            No servers configured.
          </p>
        ) : (
          <ul className="divide-y rounded-md border">
            {servers.map((st) => {
              const idx = s.mcpServers.findIndex((m) => m.name === st.name);
              const isApp = st.source === "app" && idx >= 0;
              return (
                <li
                  key={`${st.source}:${st.name}`}
                  className="flex items-center gap-2 px-3 py-2"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="text-xs font-medium">{st.name}</span>
                      <Badge
                        variant="outline"
                        className="h-4 py-0 text-[9px] font-normal"
                      >
                        {st.source}
                      </Badge>
                      <Badge
                        variant="secondary"
                        className={`h-4 py-0 text-[9px] font-normal ${STATE_CLS[st.state] ?? ""}`}
                      >
                        {st.state}
                      </Badge>
                      <span className="text-[10px] text-muted-foreground">
                        {st.toolCount} tools
                      </span>
                    </div>
                    {st.error && (
                      <p className="mt-0.5 text-[10px] break-words text-destructive">
                        {st.error}
                      </p>
                    )}
                  </div>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label={`Restart ${st.name}`}
                    title="Restart"
                    onClick={() =>
                      void assistantMcpRestart(st.name)
                        .then(setServers)
                        .catch((e) => toast.error(errorMessage(e)))
                    }
                  >
                    <IconRefresh />
                  </Button>
                  {isApp && (
                    <>
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        aria-label={`Edit ${st.name}`}
                        onClick={() => {
                          setEditingIndex(idx);
                          setEditing(s.mcpServers[idx]);
                        }}
                      >
                        <IconEdit />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        aria-label={`Delete ${st.name}`}
                        onClick={() =>
                          void save({
                            mcpServers: s.mcpServers.filter(
                              (_, i) => i !== idx,
                            ),
                          })
                        }
                      >
                        <IconTrash />
                      </Button>
                    </>
                  )}
                  <Switch
                    checked={st.enabled}
                    onCheckedChange={(on) => setServerEnabled(st, on)}
                    aria-label={`Enable ${st.name}`}
                  />
                </li>
              );
            })}
          </ul>
        )}
      </SectionCard>

      <Card className="gap-0 py-0">
        <button
          type="button"
          aria-expanded={toolsOpen}
          onClick={() => setToolsOpen((o) => !o)}
          className="flex items-center gap-2 px-3.5 py-2.5 text-left"
        >
          <IconChevronRight
            className={`size-3.5 transition-transform ${toolsOpen ? "rotate-90" : ""}`}
          />
          <span className="text-xs font-semibold">Tools</span>
          <span className="text-[11px] text-muted-foreground">
            {tools.length} available to the assistant
          </span>
        </button>
        {toolsOpen && (
          <ul className="max-h-96 divide-y overflow-y-auto border-t">
            {tools.map((t) => (
              <li key={t.name} className="px-3.5 py-2">
                <div className="flex items-center gap-2">
                  <code className="font-mono text-[11px] font-medium">
                    {t.name}
                  </code>
                  <RiskBadge risk={t.risk} />
                </div>
                <p className="text-[11px] text-muted-foreground">
                  {t.description}
                </p>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <ServerDialog
        server={editing}
        onClose={() => setEditing(null)}
        onSave={saveServer}
      />

      <AlertDialog open={confirmRegen} onOpenChange={setConfirmRegen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Regenerate the MCP token?</AlertDialogTitle>
            <AlertDialogDescription>
              Every client that uses the current token (Claude Code, Claude
              Desktop, scripts) loses access until you give it the new one.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() =>
                void save({ regenerateMcpToken: true }).then(() =>
                  toast.success("New token created"),
                )
              }
            >
              <IconCheck /> Regenerate
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
