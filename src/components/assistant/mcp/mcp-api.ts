import { invoke } from "@tauri-apps/api/core";
import type { Risk } from "@/lib/assistant/api";

// Typed wrappers over the assistant_mcp_* commands for MCP tool filters,
// resources, prompts and the call log (src-tauri/src/commands/assistant.rs).

export type McpToolInfo = {
  server: string;
  /** What the assistant sees: `<server>__<tool>`. */
  name: string;
  /** The server's own name; what is stored as disabled. */
  original: string;
  description: string;
  risk: Risk;
  /** Switched off in Settings. */
  disabled: boolean;
  /** Not offered: the server is read-only and this tool is not a read. */
  hidden: boolean;
};

export type McpResource = {
  server: string;
  /** The URI, or the URI template when `template`. */
  uri: string;
  name: string;
  title: string | null;
  description: string | null;
  mimeType: string | null;
  size: number | null;
  template: boolean;
};

export type McpPromptArg = {
  name: string;
  description: string | null;
  required: boolean;
};

export type McpPrompt = {
  server: string;
  name: string;
  title: string | null;
  description: string | null;
  arguments: McpPromptArg[];
};

export type McpPromptResult = {
  description: string | null;
  messages: { role: string; text: string }[];
};

export type McpResourceText = {
  server: string;
  uri: string;
  mimeType: string | null;
  text: string;
};

export type McpCallLogEntry = {
  id: number;
  kind: "tool" | "resource";
  server: string;
  tool: string;
  args: string;
  /** Unix milliseconds. */
  startedAt: number;
  durationMs: number;
  resultBytes: number;
  error: string | null;
};

export type ElicitAction = "accept" | "decline" | "cancel";

export const mcpTools = () => invoke<McpToolInfo[]>("assistant_mcp_tools");
/** Switches off exactly these tools (the server's own names). */
export const mcpSetDisabledTools = (server: string, tools: string[]) =>
  invoke<McpToolInfo[]>("assistant_mcp_set_disabled_tools", { server, tools });
export const mcpResources = (templates = false) =>
  invoke<McpResource[]>("assistant_mcp_resources", { templates });
export const mcpResourceRead = (server: string, uri: string) =>
  invoke<McpResourceText>("assistant_mcp_resource_read", { server, uri });
export const mcpPrompts = () => invoke<McpPrompt[]>("assistant_mcp_prompts");
export const mcpPromptGet = (
  server: string,
  name: string,
  args: Record<string, string>,
) =>
  invoke<McpPromptResult>("assistant_mcp_prompt_get", {
    server,
    name,
    arguments: args,
  });
export const mcpElicitReply = (
  requestId: string,
  action: ElicitAction,
  content?: Record<string, unknown>,
) =>
  invoke<boolean>("assistant_mcp_elicit_reply", {
    requestId,
    action,
    content: content ?? null,
  });
export const mcpCallLog = () =>
  invoke<McpCallLogEntry[]>("assistant_mcp_call_log");
export const mcpCallLogClear = () =>
  invoke<void>("assistant_mcp_call_log_clear");

/** The variables of an RFC 6570 URI template: `{a}`, `{+a}`, `{?a,b}`. */
export function templateVars(template: string): string[] {
  const out: string[] = [];
  for (const m of template.matchAll(/\{([^}]+)\}/g)) {
    for (const raw of m[1].split(",")) {
      const name = raw.replace(/^[+#./;?&]/, "").replace(/[*]$|:\d+$/, "");
      if (name && !out.includes(name)) out.push(name);
    }
  }
  return out;
}

/** Fills a URI template (simple, reserved, label, path and query forms). */
export function expandTemplate(
  template: string,
  values: Record<string, string>,
): string {
  return template.replace(/\{([^}]+)\}/g, (_, expr: string) => {
    const op = /^[+#./;?&]/.test(expr) ? expr[0] : "";
    const names = expr
      .slice(op.length)
      .split(",")
      .map((n) => n.replace(/[*]$|:\d+$/, ""));
    const enc = (v: string) =>
      op === "+" || op === "#" ? encodeURI(v) : encodeURIComponent(v);
    const given = names.filter((n) => values[n]);
    if (op === "?" || op === "&")
      return given.length
        ? (op === "?" ? "?" : "&") +
            given.map((n) => `${n}=${enc(values[n])}`).join("&")
        : "";
    if (op === ";") return given.map((n) => `;${n}=${enc(values[n])}`).join("");
    const joined = given.map((n) => enc(values[n])).join(",");
    if (!joined) return "";
    return op === "#" ? `#${joined}` : op === "." ? `.${joined}` : op === "/" ? `/${joined}` : joined;
  });
}
