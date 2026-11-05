import { invoke } from "@tauri-apps/api/core";

import { errorMessage } from "@/lib/settings";
import { AGENT_DEFS, AGENT_PROVIDERS, agentDef, type AgentModel } from "./agents";
import type { AgentProvider } from "./types";

/**
 * Agent CLIs for Agent nodes, over src-tauri/src/commands/agents.rs:
 * singl-web's `agent-models.ts` and `agent-settings.ts`.
 *
 * Model lists are never hard-coded — providers change them every few weeks.
 * Each CLI is asked whatever way it can answer (its `--help`, `copilot help
 * config`), plus the caches Claude Code and Codex keep (`~/.claude.json`,
 * `~/.codex/models_cache.json`) and, with `ANTHROPIC_API_KEY` set, the
 * Anthropic Models API. A source that fails is skipped and reported.
 */

export type ModelDiscovery = {
  models: AgentModel[];
  /** Where the models came from, in words. */
  sources: string[];
  /** Why a source came back empty, for the panel's hint. */
  problems: string[];
};

/** One row of the Settings tab. */
export type AgentAvailability = {
  provider: AgentProvider;
  title: string;
  bin: string;
  /** Switched on in Settings. */
  enabled: boolean;
  /** The binary was found on PATH (or at its override). */
  installed: boolean;
};

type Status = { provider: AgentProvider; installed: boolean; enabled: boolean };

export async function listAgentAvailability(): Promise<AgentAvailability[]> {
  const rows = await invoke<Status[]>("agents_status");
  const byId = new Map(rows.map((r) => [r.provider, r]));
  return AGENT_PROVIDERS.map((provider) => ({
    provider,
    title: AGENT_DEFS[provider].title,
    bin: AGENT_DEFS[provider].bin,
    enabled: byId.get(provider)?.enabled ?? true,
    installed: byId.get(provider)?.installed ?? false,
  }));
}

export const setDisabledAgents = (providers: AgentProvider[]) =>
  invoke<void>("agents_disabled_set", { providers });

type Source = { name: string; load: () => Promise<AgentModel[]> };

const parseJson = (text: string | null): unknown => (text ? JSON.parse(text) : null);

async function claudeCachedOptions(): Promise<AgentModel[]> {
  const config = parseJson(await invoke<string | null>("agent_model_cache", { which: "claude" })) as {
    additionalModelOptionsCache?: { value?: unknown; label?: unknown; disabled?: unknown }[];
  } | null;
  return (config?.additionalModelOptionsCache ?? [])
    .filter((o) => typeof o.value === "string" && !o.disabled)
    .map((o) => ({
      value: o.value as string,
      label: typeof o.label === "string" ? o.label : undefined,
      group: "Offered to this account",
    }));
}

async function anthropicApiModels(): Promise<AgentModel[]> {
  const json = parseJson(await invoke<string | null>("agent_anthropic_models")) as {
    data?: { id?: string; display_name?: string }[];
  } | null;
  return (json?.data ?? [])
    .filter((m): m is { id: string; display_name?: string } => typeof m.id === "string")
    .map((m) => ({ value: m.id, label: m.display_name, group: "Anthropic API" }));
}

async function codexCachedModels(): Promise<AgentModel[]> {
  const cache = parseJson(await invoke<string | null>("agent_model_cache", { which: "codex" })) as {
    models?: { slug?: unknown; display_name?: unknown; visibility?: unknown; priority?: unknown }[];
  } | null;
  return (cache?.models ?? [])
    .filter((m) => typeof m.slug === "string" && m.visibility !== "hide")
    .sort((a, b) => Number(a.priority ?? 0) - Number(b.priority ?? 0))
    .map((m) => ({
      value: m.slug as string,
      label: typeof m.display_name === "string" ? m.display_name : undefined,
      group: "Models",
    }));
}

export async function discoverAgentModels(provider: AgentProvider): Promise<ModelDiscovery> {
  const def = agentDef(provider);
  const problems: string[] = [];
  const installed = (await invoke<Status[]>("agents_status")).find((s) => s.provider === provider)?.installed;
  if (!installed) problems.push(`${def.bin} is not installed`);

  const sources: Source[] = [];
  if (installed) {
    for (const listing of def.listModels ?? []) {
      sources.push({
        name: `${def.bin} ${listing.args.join(" ")}`,
        load: async () => {
          const out = await invoke<{ code: number | null; stdout: string }>("agent_list_models_run", {
            provider,
            args: listing.args,
          });
          if (out.code !== 0) throw new Error(`exited with code ${out.code ?? "?"}`);
          return listing.parse(out.stdout);
        },
      });
    }
  }
  if (provider === "claude") {
    sources.push({ name: "~/.claude.json", load: claudeCachedOptions });
    sources.push({ name: "Anthropic Models API", load: anthropicApiModels });
  }
  if (provider === "codex") sources.push({ name: "~/.codex/models_cache.json", load: codexCachedModels });

  const settled = await Promise.allSettled(sources.map((source) => source.load()));
  const models: AgentModel[] = [];
  const seen = new Set<string>();
  const used: string[] = [];
  settled.forEach((result, index) => {
    const name = sources[index].name;
    if (result.status === "rejected") {
      problems.push(`${name}: ${errorMessage(result.reason)}`);
      return;
    }
    if (!result.value.length) return;
    used.push(name);
    for (const model of result.value) {
      if (seen.has(model.value)) continue;
      seen.add(model.value);
      models.push(model);
    }
  });
  return { models, sources: used, problems };
}
