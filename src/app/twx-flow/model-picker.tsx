"use client";

import { useState } from "react";
import { IconRefresh } from "@tabler/icons-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { cn } from "@/lib/utils";
import type { AgentModel } from "@/lib/twx-flow/agents";
import type { AgentProvider } from "@/lib/twx-flow/types";

const CUSTOM = "__custom__";

/**
 * singl-web asks the agent CLI for its models; singl cannot run agent CLIs yet,
 * so the picker offers only the CLI default and a custom entry.
 */
function useAgentModels(provider: AgentProvider) {
  void provider;
  return {
    models: [] as AgentModel[],
    sources: [] as string[],
    problems: ["agent CLIs are not available in singl yet"],
    loading: false,
    refresh: () => {},
  };
}

/** Groups entries under their headings, keeping first-seen order. */
function grouped(models: AgentModel[]) {
  const groups = new Map<string, AgentModel[]>();
  for (const model of models) {
    const key = model.group ?? "Models";
    groups.set(key, [...(groups.get(key) ?? []), model]);
  }
  return [...groups];
}

/**
 * A model dropdown filled from the CLI itself, with a refresh button and a
 * "custom" entry for a model the list does not know yet. Empty means the CLI's
 * own default.
 */
export function ModelPicker({
  provider,
  value,
  onChange,
  compact,
  className,
}: {
  provider: AgentProvider;
  value: string;
  onChange: (model: string) => void;
  /** Smaller controls, for the chat panel. */
  compact?: boolean;
  className?: string;
}) {
  const { models, sources, problems, loading, refresh } = useAgentModels(provider);
  const model = value.trim();
  // A model the list has never heard of is still a real choice, so the field
  // stays in custom mode rather than silently snapping back to the default.
  const [custom, setCustom] = useState(false);
  const known = models.some((m) => m.value === model);
  const showCustom = custom || (model !== "" && !known && !loading);

  const hint = loading
    ? "Asking the CLI which models it offers…"
    : models.length
      ? `${models.length} models · from ${sources.join(", ")}`
      : problems.length
        ? `No models found: ${problems.join("; ")}`
        : "The CLI listed no models — type one, or leave empty for its default.";

  const size = compact ? "h-7 text-xs" : "";

  return (
    <div className={cn("flex flex-col gap-1", className)}>
      <div className="flex items-center gap-1">
        <NativeSelect
          className={cn("min-w-0 flex-1", size)}
          value={showCustom ? CUSTOM : model}
          onChange={(e) => {
            const picked = e.target.value;
            if (picked === CUSTOM) {
              setCustom(true);
              return;
            }
            setCustom(false);
            onChange(picked);
          }}
          aria-label="Model"
        >
          <option value="">CLI default</option>
          {/* Keep a saved model selectable while the list is still loading. */}
          {loading && model && !known && <option value={model}>{model}</option>}
          {grouped(models).map(([group, entries]) => (
            <optgroup key={group} label={group}>
              {entries.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label && m.label !== m.value ? `${m.label} (${m.value})` : m.value}
                </option>
              ))}
            </optgroup>
          ))}
          <option value={CUSTOM}>Other model…</option>
        </NativeSelect>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={refresh}
          disabled={loading}
          aria-label="Refresh model list"
          title="Ask the CLI again"
        >
          <IconRefresh className={cn(loading && "animate-spin")} />
        </Button>
      </div>
      {showCustom && (
        <Input
          autoFocus
          value={model}
          onChange={(e) => onChange(e.target.value)}
          placeholder="model name, as the CLI spells it"
          className="h-7 text-xs"
        />
      )}
      <p className="text-[10px] leading-tight text-muted-foreground">{hint}</p>
    </div>
  );
}
