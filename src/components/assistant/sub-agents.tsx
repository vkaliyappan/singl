"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { IconCheck, IconHierarchy2 } from "@tabler/icons-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import {
  assistantModels,
  type ModelInfo,
  type ProviderInfo,
  type SubAgentSettings,
} from "@/lib/assistant/api";
import { effortLabel, shortModelName } from "./model-picker";
import type { ChatChoice } from "./use-assistant-chat";

/** What the composer remembers: the limits, plus picked models per provider. */
export type SubAgentPrefs = Omit<SubAgentSettings, "models"> & {
  models: Record<string, string[]>;
};

const STORE_KEY = "singl.assistant.subAgents";
/** Sonnet for real work, Haiku for quick lookups; the model picks per task. */
const CLAUDE_DEFAULTS = ["claude-sonnet-5-5", "claude-haiku-5-5"];
const DEFAULTS: SubAgentPrefs = {
  enabled: true,
  models: { anthropic: CLAUDE_DEFAULTS, claude: CLAUDE_DEFAULTS },
  maxParallel: 3,
  maxPerTurn: 5,
  maxSteps: 15,
  effort: "",
  prefer: false,
};
/** Same ranges as the backend clamps to (subagents.rs). */
const RANGES = {
  maxParallel: [1, 8],
  maxPerTurn: [1, 20],
  maxSteps: [3, 40],
} as const;
const MAX_SHOWN = 60;

/** Providers whose sub-agents these settings control, and how far. */
function support(provider: string | undefined) {
  switch (provider) {
    case "anthropic":
    case "openrouter":
      return { on: true, counts: "enforced", steps: true } as const;
    case "claude":
      return { on: true, counts: "asked", steps: false } as const;
    default:
      return { on: false, counts: "none", steps: false } as const;
  }
}

function read(): SubAgentPrefs {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return DEFAULTS;
    const v = JSON.parse(raw) as Partial<SubAgentPrefs>;
    return {
      ...DEFAULTS,
      ...v,
      models: { ...DEFAULTS.models, ...(v.models ?? {}) },
    };
  } catch {
    return DEFAULTS;
  }
}

/** Sub-agent settings, remembered across messages and restarts. */
export function useSubAgents() {
  const [prefs, setPrefsState] = useState<SubAgentPrefs>(DEFAULTS);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- read after mount to avoid SSR mismatch
    setPrefsState(read());
  }, []);
  const setPrefs = useCallback((p: SubAgentPrefs) => {
    setPrefsState(p);
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(p));
    } catch {}
  }, []);
  return { prefs, setPrefs };
}

/** What one message sends for its provider. */
export function subAgentsFor(
  prefs: SubAgentPrefs,
  provider: string | undefined,
): SubAgentSettings | undefined {
  if (!provider || !support(provider).on) return undefined;
  const { models, ...rest } = prefs;
  return { ...rest, models: models[provider] ?? [] };
}

function Stepper({
  label,
  hint,
  value,
  range,
  disabled,
  onChange,
}: {
  label: string;
  hint: string;
  value: number;
  range: readonly [number, number];
  disabled?: boolean;
  onChange: (v: number) => void;
}) {
  const [lo, hi] = range;
  const set = (v: number) => onChange(Math.min(hi, Math.max(lo, v)));
  const btn =
    "flex size-6 items-center justify-center rounded text-[13px] text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/30 disabled:opacity-40";
  return (
    <div
      className={cn(
        "flex items-center gap-2 px-2 py-1",
        disabled && "opacity-50",
      )}
    >
      <span className="min-w-0 flex-1">
        <span className="block text-[12.5px] font-medium">{label}</span>
        <span
          className="block truncate text-[11px] text-muted-foreground"
          title={hint}
        >
          {hint}
        </span>
      </span>
      <div className="flex shrink-0 items-center rounded-md border bg-muted/40">
        <button
          type="button"
          aria-label={`Fewer: ${label}`}
          disabled={disabled || value <= lo}
          onClick={() => set(value - 1)}
          className={btn}
        >
          −
        </button>
        <span
          className="w-6 text-center text-[12px] tabular-nums"
          aria-live="polite"
        >
          {value}
        </span>
        <button
          type="button"
          aria-label={`More: ${label}`}
          disabled={disabled || value >= hi}
          onClick={() => set(value + 1)}
          className={btn}
        >
          +
        </button>
      </div>
    </div>
  );
}

/** Composer button + popover: on/off, models, limits, effort. */
export function SubAgentPicker({
  prefs,
  onChange,
  choice,
  providers,
  disabled,
}: {
  prefs: SubAgentPrefs;
  onChange: (p: SubAgentPrefs) => void;
  choice: ChatChoice | null;
  providers: ProviderInfo[];
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [query, setQuery] = useState("");
  const provider = choice?.provider;
  const sup = support(provider);
  const info = providers.find((p) => p.id === provider);
  const picked = useMemo(
    () => (provider ? (prefs.models[provider] ?? []) : []),
    [prefs.models, provider],
  );
  const active = prefs.enabled && sup.on;

  useEffect(() => {
    if (!open || !provider || !sup.on) return;
    let stale = false;
    assistantModels(provider)
      .then((list) => {
        if (!stale) setModels(list);
      })
      .catch(() => {
        if (!stale) setModels([]);
      });
    return () => {
      stale = true;
    };
  }, [open, provider, sup.on]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const known = new Map(models.map((m) => [m.id, m]));
    // Picked ones first (even if the live list lacks them), then the rest.
    const first = picked.map((id) => known.get(id) ?? { id, name: id });
    const rest = models.filter((m) => !picked.includes(m.id));
    return [...first, ...rest]
      .filter(
        (m) =>
          !q ||
          m.id.toLowerCase().includes(q) ||
          m.name.toLowerCase().includes(q),
      )
      .slice(0, MAX_SHOWN);
  }, [models, picked, query]);

  const set = (patch: Partial<SubAgentPrefs>) =>
    onChange({ ...prefs, ...patch });
  const toggleModel = (id: string) => {
    if (!provider) return;
    const next = picked.includes(id)
      ? picked.filter((m) => m !== id)
      : [...picked, id];
    set({ models: { ...prefs.models, [provider]: next } });
  };

  const label = active
    ? picked.length
      ? `Sub-agents · ${picked.map((m) => shortModelName(m)).join(", ")}`
      : "Sub-agents"
    : "Sub-agents off";
  const efforts = info?.efforts ?? [];

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        disabled={disabled}
        aria-label={label}
        title={
          sup.on
            ? label
            : `${info?.title ?? "This provider"} uses its own sub-agent behaviour`
        }
        className={cn(
          "flex h-8 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-[13px] font-medium text-foreground/75 transition-colors outline-none hover:bg-foreground/5 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/30 disabled:opacity-50 data-[popup-open]:bg-foreground/5",
          active && "text-violet-600 dark:text-violet-400",
          !sup.on && "opacity-60",
        )}
      >
        <IconHierarchy2 className="size-4 shrink-0" />
        {active && (
          <span className="hidden max-w-32 truncate @lg:inline">
            {picked.length
              ? `${picked.length} model${picked.length > 1 ? "s" : ""}`
              : "On"}
          </span>
        )}
      </PopoverTrigger>
      <PopoverContent align="end" side="top" className="w-88 gap-0.5 p-1.5">
        <label className="flex cursor-pointer items-center gap-2 px-2 py-1.5">
          <span className="min-w-0 flex-1">
            <span className="block text-[13px] font-medium">
              Use sub-agents
            </span>
            <span className="block text-[11.5px] text-muted-foreground">
              Hand independent parts of the work to separate agents
            </span>
          </span>
          <Switch
            checked={prefs.enabled}
            disabled={!sup.on}
            onCheckedChange={(v) => set({ enabled: v })}
            aria-label="Use sub-agents"
          />
        </label>

        {!sup.on && (
          <p className="px-2 pb-1.5 text-[11.5px] text-muted-foreground">
            {info?.title ?? "This provider"} runs sub-agents its own way; these
            settings apply to the Anthropic API, OpenRouter and Claude Code.
          </p>
        )}

        {sup.on && (
          <div
            className={cn(!prefs.enabled && "pointer-events-none opacity-50")}
            aria-disabled={!prefs.enabled}
          >
            <label className="flex cursor-pointer items-center gap-2 px-2 py-1">
              <span className="min-w-0 flex-1">
                <span className="block text-[12.5px] font-medium">
                  Prefer sub-agents
                </span>
                <span className="block text-[11px] text-muted-foreground">
                  Split broad searches and independent work by default
                </span>
              </span>
              <Switch
                size="sm"
                checked={prefs.prefer}
                onCheckedChange={(v) => set({ prefer: v })}
                aria-label="Prefer sub-agents"
              />
            </label>

            <div className="mx-2 my-1 border-t" />
            <p className="px-2 pt-0.5 text-[11px] font-medium text-muted-foreground">
              Models · the assistant picks one per task
            </p>
            {models.length > 12 && (
              <div className="px-2 py-1">
                <Input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Filter models…"
                  className="h-7 text-[12px]"
                />
              </div>
            )}
            <div
              role="group"
              aria-label="Sub-agent models"
              className="max-h-44 overflow-y-auto"
            >
              {shown.map((m) => {
                const on = picked.includes(m.id);
                return (
                  <button
                    key={m.id}
                    type="button"
                    role="checkbox"
                    aria-checked={on}
                    onClick={() => toggleModel(m.id)}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left outline-none hover:bg-muted focus-visible:bg-muted focus-visible:ring-2 focus-visible:ring-ring/30"
                  >
                    <span
                      className={cn(
                        "flex size-4 shrink-0 items-center justify-center rounded-[4px] border",
                        on &&
                          "border-primary bg-primary text-primary-foreground",
                      )}
                    >
                      {on && <IconCheck className="size-3" />}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-[12.5px]">
                      {m.name}
                    </span>
                    <span className="max-w-32 shrink-0 truncate font-mono text-[10.5px] text-muted-foreground">
                      {m.id}
                    </span>
                  </button>
                );
              })}
              {!shown.length && (
                <p className="px-2 py-1 text-[11.5px] text-muted-foreground">
                  {models.length ? "No model matches." : "Loading models…"}
                </p>
              )}
            </div>
            {!picked.length && (
              <p className="px-2 py-1 text-[11px] text-muted-foreground">
                None picked:{" "}
                {provider === "openrouter"
                  ? "sub-agents use the chat's model"
                  : "Sonnet 5.5 and Haiku 5.5"}
                .
              </p>
            )}

            <div className="mx-2 my-1 border-t" />
            <Stepper
              label="At the same time"
              hint="Sub-agents running in parallel"
              value={prefs.maxParallel}
              range={RANGES.maxParallel}
              onChange={(v) =>
                set({
                  maxParallel: v,
                  maxPerTurn: Math.max(prefs.maxPerTurn, v),
                })
              }
            />
            <Stepper
              label="Per message"
              hint="Most sub-agents one message may start"
              value={prefs.maxPerTurn}
              range={RANGES.maxPerTurn}
              onChange={(v) =>
                set({
                  maxPerTurn: v,
                  maxParallel: Math.min(prefs.maxParallel, v),
                })
              }
            />
            <Stepper
              label="Steps each"
              hint={
                sup.steps
                  ? "Model calls one sub-agent may make"
                  : "Claude Code sets this itself"
              }
              value={prefs.maxSteps}
              range={RANGES.maxSteps}
              disabled={!sup.steps}
              onChange={(v) => set({ maxSteps: v })}
            />
            {sup.counts === "asked" && (
              <p className="px-2 py-1 text-[11px] text-muted-foreground">
                Claude Code has no limit flag: the counts are asked for in its
                instructions.
              </p>
            )}

            {sup.steps && efforts.length > 0 && (
              <div className="flex items-center gap-2 px-2 py-1">
                <span className="min-w-0 flex-1 text-[12.5px] font-medium">
                  Effort
                </span>
                <div
                  role="radiogroup"
                  aria-label="Sub-agent effort"
                  className="flex shrink-0 rounded-md border bg-muted/40 p-0.5"
                >
                  {["", ...efforts].map((e) => {
                    const on = prefs.effort === e;
                    return (
                      <button
                        key={e || "inherit"}
                        type="button"
                        role="radio"
                        aria-checked={on}
                        onClick={() => set({ effort: e })}
                        className={cn(
                          "rounded px-1.5 py-0.5 text-[11px] outline-none focus-visible:ring-2 focus-visible:ring-ring/30",
                          on
                            ? "bg-background font-medium shadow-sm"
                            : "text-muted-foreground hover:text-foreground",
                        )}
                      >
                        {e ? effortLabel(e) : "Same"}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
