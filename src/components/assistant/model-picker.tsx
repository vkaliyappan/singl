"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  IconAsterisk,
  IconBrandGithubCopilot,
  IconBrandOpenai,
  IconCheck,
  IconRocket,
  IconRoute,
} from "@tabler/icons-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import {
  assistantModels,
  assistantProviders,
  assistantSettingsGet,
  type ModelInfo,
  type ProviderInfo,
} from "@/lib/assistant/api";
import type { ChatChoice } from "./use-assistant-chat";

const STORE_KEY = "singl.assistant.choice";
const MAX_SHOWN = 100;

function readStored(): ChatChoice | null {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    return raw ? (JSON.parse(raw) as ChatChoice) : null;
  } catch {
    return null;
  }
}

function store(choice: ChatChoice) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(choice));
  } catch {}
}

/** Providers + the chosen provider/model. Defaults: last choice, else Settings, else first available. */
export function useModelChoice(active: boolean) {
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [choice, setChoiceState] = useState<ChatChoice | null>(null);
  const loaded = useRef(false);

  useEffect(() => {
    if (!active || loaded.current) return;
    loaded.current = true;
    void (async () => {
      try {
        const [list, settings] = await Promise.all([
          assistantProviders(),
          assistantSettingsGet(),
        ]);
        setProviders(list);
        const stored = readStored();
        const usable = (id: string) => list.some((p) => p.id === id);
        if (stored && usable(stored.provider)) setChoiceState(stored);
        else {
          const provider = usable(settings.defaultProvider)
            ? settings.defaultProvider
            : (list.find((p) => p.available) ?? list[0])?.id;
          if (provider)
            setChoiceState({
              provider,
              model:
                provider === settings.defaultProvider
                  ? settings.defaultModel
                  : "",
            });
        }
      } catch (e) {
        console.warn("assistant providers unavailable", e);
        loaded.current = false;
      }
    })();
  }, [active]);

  const setChoice = (c: ChatChoice) => {
    setChoiceState(c);
    store(c);
  };
  return { providers, choice, setChoice };
}

/** Provider glyphs: generic icons, tinted per provider. */
export function ProviderIcon({
  provider,
  className,
}: {
  provider?: string;
  className?: string;
}) {
  const cls = cn("size-3.5 shrink-0", className);
  switch (provider) {
    case "anthropic":
    case "claude":
      return <IconAsterisk className={cn(cls, "text-warning")} />;
    case "codex":
      return <IconBrandOpenai className={cls} />;
    case "openrouter":
      return <IconRoute className={cn(cls, "text-indigo-500")} />;
    case "copilot":
      return <IconBrandGithubCopilot className={cls} />;
    case "antigravity":
      return <IconRocket className={cn(cls, "text-info")} />;
    default:
      return <IconAsterisk className={cls} />;
  }
}

/** `xhigh` → `Extra high`, others capitalised. */
export function effortLabel(effort: string) {
  if (effort === "xhigh") return "Extra high";
  return effort.charAt(0).toUpperCase() + effort.slice(1);
}

/** A short label for a model: `claude-opus-5-5` → `Opus 5.5`, `anthropic/claude-sonnet-5.5` → `Sonnet 5.5`. */
export function shortModelName(id: string, known?: string) {
  const last = id.split("/").pop() ?? id;
  const m = last.match(
    /^claude-(opus|sonnet|haiku|fable)-(\d+)(?:[-.](\d+))?/i,
  );
  if (m)
    return `${m[1][0].toUpperCase()}${m[1].slice(1).toLowerCase()} ${m[2]}${m[3] ? `.${m[3]}` : ""}`;
  if (known && known !== id && known.length <= 28)
    return known.replace(/^[\w ]+:\s*/, "");
  return last;
}

/**
 * The composer's model button (provider glyph + model name). It opens one
 * popover: providers on the left, the browsed provider's models on the right.
 */
export function ModelPicker({
  providers,
  choice,
  onChange,
  disabled,
  open: openProp,
  onOpenChange,
}: {
  providers: ProviderInfo[];
  choice: ChatChoice | null;
  onChange: (c: ChatChoice) => void;
  disabled?: boolean;
  /** Optional control of the popover (e.g. the `/model` command). */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const [innerOpen, setInnerOpen] = useState(false);
  const open = openProp ?? innerOpen;
  const setOpen = (o: boolean) => {
    setInnerOpen(o);
    onOpenChange?.(o);
  };
  const [browse, setBrowse] = useState<string | null>(null);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");
  const cache = useRef(new Map<string, ModelInfo[]>());
  const [names, setNames] = useState<Record<string, string>>({});
  const shown = browse ?? choice?.provider;

  useEffect(() => {
    if (!shown) return;
    const cached = cache.current.get(shown);
    if (cached) {
      setModels(cached);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setModels([]);
    assistantModels(shown)
      .then((m) => {
        cache.current.set(shown, m);
        setNames((n) => ({
          ...n,
          ...Object.fromEntries(m.map((x) => [`${shown}:${x.id}`, x.name])),
        }));
        if (!cancelled) setModels(m);
      })
      .catch(() => !cancelled && setModels([]))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [shown]);

  const q = query.trim().toLowerCase();
  const filtered = useMemo(
    () =>
      (q
        ? models.filter(
            (m) =>
              m.id.toLowerCase().includes(q) ||
              m.name.toLowerCase().includes(q),
          )
        : models
      ).filter((m) => m.id),
    [models, q],
  );
  const pick = (model: string) => {
    if (!shown) return;
    const levels = providers.find((p) => p.id === shown)?.efforts ?? [];
    const effort =
      choice?.effort && levels.includes(choice.effort) ? choice.effort : "";
    onChange({ provider: shown, model, effort });
    setOpen(false);
    setQuery("");
    setBrowse(null);
  };

  if (!choice) return null;
  const current = providers.find((p) => p.id === choice.provider);
  const label = choice.model
    ? shortModelName(choice.model, names[`${choice.provider}:${choice.model}`])
    : (current?.title ?? choice.provider);
  const browsing = providers.find((p) => p.id === shown);

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) {
          setBrowse(null);
          setQuery("");
        }
      }}
    >
      <PopoverTrigger
        disabled={disabled}
        aria-label={`Model: ${current?.title ?? choice.provider}, ${label}`}
        title={
          current && !current.available
            ? (current.note ?? "Not available")
            : `${current?.title ?? choice.provider} · ${choice.model || "default model"}`
        }
        className="flex h-8 max-w-56 min-w-0 items-center gap-1.5 rounded-full px-2.5 text-[13px] font-medium text-foreground/75 transition-colors outline-none hover:bg-foreground/5 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/30 disabled:opacity-50 data-[popup-open]:bg-foreground/5"
      >
        <ProviderIcon provider={choice.provider} className="size-4" />
        <span className="truncate">{label}</span>
        {choice.effort && (
          <span className="shrink-0 font-normal text-muted-foreground">
            {effortLabel(choice.effort)}
          </span>
        )}
        {current && !current.available && (
          <span
            className="size-1.5 shrink-0 rounded-full bg-warning"
            aria-hidden
          />
        )}
      </PopoverTrigger>
      <PopoverContent
        align="end"
        side="top"
        className="w-[26rem] max-w-[90vw] flex-row gap-0 p-0"
      >
        <div
          role="listbox"
          aria-label="Providers"
          className="w-40 shrink-0 border-r p-1"
        >
          {(["api", "cli"] as const).map((kind) => (
            <div key={kind} className="mb-1">
              <p className="px-2 pt-1 pb-0.5 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
                {kind === "api" ? "API" : "Agent CLIs"}
              </p>
              {providers
                .filter((p) => p.kind === kind)
                .map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    role="option"
                    aria-selected={p.id === shown}
                    title={p.available ? p.title : (p.note ?? "Not available")}
                    onClick={() => {
                      setBrowse(p.id);
                      setQuery("");
                    }}
                    className={cn(
                      "flex h-7 w-full items-center gap-1.5 rounded-md px-2 text-left text-xs hover:bg-accent",
                      p.id === shown && "bg-accent",
                      !p.available && "text-muted-foreground",
                    )}
                  >
                    <ProviderIcon
                      provider={p.id}
                      className={cn(!p.available && "opacity-50")}
                    />
                    <span className="min-w-0 flex-1 truncate">{p.title}</span>
                    {p.id === choice.provider && (
                      <IconCheck className="size-3 shrink-0" />
                    )}
                  </button>
                ))}
            </div>
          ))}
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-1 p-1">
          {browsing && !browsing.available && (
            <p className="m-1 rounded-md bg-warning/10 p-2 text-[11px] text-warning">
              {browsing.note ?? "Not available."}
            </p>
          )}
          <Input
            autoFocus
            value={query}
            placeholder={
              loading ? "Loading models…" : "Search or type a model id"
            }
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                if (filtered.length === 1) pick(filtered[0].id);
                else if (q)
                  pick(
                    filtered.find((m) => m.id.toLowerCase() === q)?.id ??
                      query.trim(),
                  );
              }
            }}
            className="h-7"
          />
          <div
            role="listbox"
            aria-label="Models"
            className="max-h-72 min-h-40 overflow-y-auto"
          >
            <ModelRow
              active={shown === choice.provider && !choice.model}
              onClick={() => pick("")}
            >
              <span className="text-muted-foreground">Default</span>
            </ModelRow>
            {filtered.slice(0, MAX_SHOWN).map((m) => (
              <ModelRow
                key={m.id}
                active={shown === choice.provider && m.id === choice.model}
                onClick={() => pick(m.id)}
              >
                <span className="min-w-0 flex-1 truncate" title={m.id}>
                  {m.name}
                </span>
              </ModelRow>
            ))}
            {filtered.length > MAX_SHOWN && (
              <p className="px-2 py-1 text-[10px] text-muted-foreground">
                {filtered.length - MAX_SHOWN} more — keep typing.
              </p>
            )}
            {q && !filtered.some((m) => m.id.toLowerCase() === q) && (
              <ModelRow active={false} onClick={() => pick(query.trim())}>
                Use “{query.trim()}”
              </ModelRow>
            )}
          </div>
          {current &&
            current.efforts.length > 0 &&
            shown === choice.provider && (
              <div className="border-t px-1 pt-1.5 pb-0.5">
                <p className="px-1 pb-1 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
                  Effort
                </p>
                <div
                  role="radiogroup"
                  aria-label="Reasoning effort"
                  className="flex flex-wrap gap-1"
                >
                  {["", ...current.efforts].map((e) => (
                    <button
                      key={e || "default"}
                      type="button"
                      role="radio"
                      aria-checked={(choice.effort ?? "") === e}
                      onClick={() => onChange({ ...choice, effort: e })}
                      className={cn(
                        "h-6 rounded-full border px-2 text-[11px] transition-colors hover:bg-accent",
                        (choice.effort ?? "") === e &&
                          "border-primary/50 bg-primary/10 text-foreground",
                      )}
                    >
                      {e ? effortLabel(e) : "Default"}
                    </button>
                  ))}
                </div>
              </div>
            )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function ModelRow({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={active}
      onClick={onClick}
      className="flex min-h-7 w-full items-center gap-2 rounded-md px-2 py-1 text-left text-xs hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
    >
      {children}
      {active && <IconCheck className="size-3.5 shrink-0" />}
    </button>
  );
}
