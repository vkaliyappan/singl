// What the assistant changed, so open screens can show it. A tool call that
// succeeds becomes one window event; each screen reloads what it shows.

export type ChangeScope = "entities" | "flows" | "repo" | "presets";

export type AssistantChange = {
  scope: ChangeScope;
  tool: string;
  input: Record<string, unknown>;
};

const EVENT = "singl:assistant-changed";

// The tools that change local data (Risk::Write / Destructive in
// singl-core/src/assistant/tools), by the screens that show it.
const SCOPES: Record<ChangeScope, string[]> = {
  entities: [
    "entity_write",
    "entity_create",
    "entity_rename",
    "entity_delete",
    "entity_export",
    "entity_reexport",
    "deploy_export_entities",
    "deploy_extract_services",
  ],
  flows: [
    "flow_create",
    "flow_rename",
    "flow_delete",
    "flow_duplicate",
    "flow_save",
    "flow_move",
    "flow_folder_create",
    "flow_folder_rename",
    "flow_folder_move",
    "flow_folder_delete",
  ],
  repo: ["repo_clone", "repo_checkout", "repo_fetch", "repo_pull", "repo_clean"],
  presets: ["service_preset_save", "service_preset_delete"],
};

/** Which screens a tool's success touches; null for read-only or unrelated tools. */
export function scopeOf(tool: string): ChangeScope | null {
  for (const [scope, tools] of Object.entries(SCOPES) as [ChangeScope, string[]][]) {
    if (tools.includes(tool)) return scope;
  }
  return null;
}

export function emitAssistantChange(tool: string, input: unknown) {
  const scope = scopeOf(tool);
  if (!scope || typeof window === "undefined") return;
  const detail: AssistantChange = {
    scope,
    tool,
    input: input && typeof input === "object" ? (input as Record<string, unknown>) : {},
  };
  window.dispatchEvent(new CustomEvent(EVENT, { detail }));
}

/** Calls `listener` after the assistant changes something in `scope`. Returns an unsubscribe. */
export function onAssistantChange(scope: ChangeScope, listener: (change: AssistantChange) => void) {
  const handle = (e: Event) => {
    const change = (e as CustomEvent<AssistantChange>).detail;
    if (change?.scope === scope) listener(change);
  };
  window.addEventListener(EVENT, handle);
  return () => window.removeEventListener(EVENT, handle);
}
