import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

// Typed wrappers over src-tauri/src/commands/assistant.rs. Tauri maps these
// camelCase argument names to the commands' snake_case ones.

export type Risk = "read" | "write" | "destructive";

/** Message fields are camelCase, Block fields snake_case (Rust serde). */
export type Block =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | {
      type: "tool_result";
      tool_use_id: string;
      content: string;
      is_error?: boolean;
    }
  /** Provider data kept for the next request (e.g. thinking); never shown. */
  | { type: "opaque"; provider: string; data: unknown }
  /** A file attached to a user message; `content` is not shown in the UI. */
  | {
      type: "attachment";
      name: string;
      path: string;
      content: string;
      directory?: boolean;
    }
  /** An image sent with a user message (base64, no data: prefix). */
  | { type: "image"; name: string; media_type: string; data: string }
  /** Something pinned from a screen with "Add to chat". */
  | {
      type: "reference";
      kind: string;
      label: string;
      screen?: string;
      content: string;
    };

export type Message = {
  id: string;
  role: "user" | "assistant";
  blocks: Block[];
  provider?: string;
  model?: string;
  effort?: string;
  context?: unknown;
  /** Names of the skills attached to a user message. */
  skills?: string[];
  createdAt: number;
};

export type ChatSummary = {
  id: string;
  title: string;
  messageCount: number;
  createdAt: number | null;
  updatedAt: number | null;
};

export type Chat = {
  id: string;
  title: string;
  messages: Message[];
  createdAt: number | null;
  updatedAt: number | null;
};

export type ModelInfo = { id: string; name: string };

export type ProviderInfo = {
  id: string;
  title: string;
  kind: "api" | "cli";
  available: boolean;
  note: string | null;
  /** Reasoning effort levels, lowest first; empty when the provider has none. */
  efforts: string[];
};

export type Suggestion = { label: string; prompt: string };

export type UiActionSpec = {
  name: string;
  description: string;
  inputSchema: unknown;
  risk: Risk;
};

export type ScreenContext = {
  route: string;
  screen: string;
  title?: string | null;
  summary?: string | null;
  data?: unknown;
  selection?: unknown;
  actions: UiActionSpec[];
};

export type ToolSpec = {
  name: string;
  description: string;
  inputSchema: unknown;
  risk: Risk;
  externalOnly?: boolean;
};

export type McpServerConfig = {
  name: string;
  enabled: boolean;
  command: string;
  args: string[];
  env: Record<string, string>;
  url: string;
  headers: Record<string, string>;
  readOnly: boolean;
  /** The server's own names of tools switched off. */
  disabledTools?: string[];
  source?: string;
};

export type McpServerStatus = {
  name: string;
  source: string;
  enabled: boolean;
  state: "stopped" | "starting" | "running" | "error" | string;
  error: string | null;
  toolCount: number;
  /** An HTTP server, so it can take an OAuth sign-in. */
  http: boolean;
  signedIn: boolean;
};

export type McpInfo = {
  enabled: boolean;
  running: boolean;
  url: string | null;
  token: string;
  configSnippet: string;
  claudeCommand: string;
};

export type AssistantSettingsView = {
  hasAnthropicApiKey: boolean;
  hasOpenrouterApiKey: boolean;
  defaultProvider: string;
  defaultModel: string;
  mcpEnabled: boolean;
  mcpPort: number;
  autoApproveWrites: boolean;
  /** How calls from outside MCP clients are approved. */
  externalMcpMode: ApprovalMode;
  /** The same for their ThingWorx server calls. */
  externalMcpServerMode: ApprovalMode;
  mcpServers: McpServerConfig[];
  useProjectMcp: boolean;
  /** Folder the project MCP files are read from; empty means the workspace root. */
  projectMcpRoot: string;
  disabledProjectServers: string[];
  /** How long one MCP tool call may take, approval wait included. */
  toolTimeoutMinutes: number;
};

export type AssistantSettingsPatch = Partial<{
  anthropicApiKey: string;
  openrouterApiKey: string;
  defaultProvider: string;
  defaultModel: string;
  mcpEnabled: boolean;
  mcpPort: number;
  autoApproveWrites: boolean;
  externalMcpMode: ApprovalMode;
  externalMcpServerMode: ApprovalMode;
  mcpServers: McpServerConfig[];
  useProjectMcp: boolean;
  projectMcpRoot: string;
  disabledProjectServers: string[];
  toolTimeoutMinutes: number;
  regenerateMcpToken: boolean;
}>;

export type AssistantEvent =
  | { type: "turnStarted"; chatId: string; provider: string; model: string }
  | { type: "text"; chatId: string; text: string }
  | { type: "thinking"; chatId: string; text: string }
  | { type: "status"; chatId: string; text: string }
  | {
      type: "toolCall";
      chatId: string | null;
      callId: string;
      name: string;
      input: unknown;
      source: string;
    }
  | {
      type: "toolResult";
      chatId: string | null;
      callId: string;
      content: string;
      isError: boolean;
    }
  | { type: "messageSaved"; chatId: string; message: Message }
  | {
      type: "turnEnded";
      chatId: string;
      error: string | null;
      cancelled: boolean;
      /** Steered messages the turn ended before reading; they become queued. */
      unread?: string[];
    }
  | {
      type: "approvalRequest";
      requestId: string;
      chatId: string | null;
      tool: string;
      input: unknown;
      risk: Risk;
      scope: ToolScope;
      source: string;
    }
  | { type: "approvalResolved"; requestId: string; approved: boolean }
  | { type: "uiRequest"; requestId: string; action: string; args: unknown }
  /** An MCP server asks for input; answered with `mcpElicitReply`. */
  | {
      type: "elicitationRequest";
      requestId: string;
      chatId: string | null;
      server: string;
      message: string;
      schema: unknown;
    }
  | { type: "elicitationResolved"; requestId: string }
  | { type: "usageUpdated"; chatId: string }
  | { type: "chatsChanged" };

export type ApprovalMode = "ask" | "auto" | "readOnly";
/** Which approval mode governs a tool: local changes or the ThingWorx server. */
export type ToolScope = "local" | "server";

export type SendRequest = {
  chatId?: string;
  provider: string;
  model: string;
  effort?: string;
  text: string;
  /** Absolute paths of text files. */
  attachments?: string[];
  /** Tool allowlist for this turn; null/omitted = all tools. */
  tools?: string[] | null;
  /** Skill ids. */
  skills?: string[];
  approval?: ApprovalMode;
  /** The same for ThingWorx server calls; unset follows `approval`. */
  serverApproval?: ApprovalMode;
  /** Files dropped from outside the app (no path), read by the page. */
  inlineAttachments?: InlineAttachment[];
  /** Items pinned from screens (max 20). */
  references?: ReferenceInput[];
  /** Images (max 8, base64 without the data: prefix, <= 5 MB each). */
  images?: { name: string; mediaType: string; data: string }[];
  /** Sub-agent controls; omitted = off (Claude Code keeps its own default). */
  subAgents?: SubAgentSettings;
};

/** Composer sub-agent controls, sent with each message. */
export type SubAgentSettings = {
  enabled: boolean;
  /** Model ids of the message's provider; empty = the backend default. */
  models: string[];
  maxParallel: number;
  maxPerTurn: number;
  maxSteps: number;
  /** Empty = the message's own effort. */
  effort: string;
  /** Nudge the model to split broad work across sub-agents. */
  prefer: boolean;
};

export type ReferenceInput = {
  kind: string;
  label: string;
  screen?: string;
  content: string;
};

export type InlineAttachment = { name: string; content: string };

export type SkillInfo = {
  id: string;
  name: string;
  description: string;
  source: "user" | "project";
};

export type FileHit = {
  path: string;
  relative: string;
  name: string;
  isDir: boolean;
};

export const assistantFilesSearch = (query: string, limit = 30) =>
  invoke<FileHit[]>("assistant_files_search", { query, limit });
export const assistantSkills = () => invoke<SkillInfo[]>("assistant_skills");
export const assistantSend = (request: SendRequest) =>
  invoke<string>("assistant_send", { request });
/** Changes a running turn's approval mode; false when nothing is running. */
export const assistantTurnMode = (chatId: string, mode: ApprovalMode, serverMode: ApprovalMode) =>
  invoke<boolean>("assistant_turn_mode", { chatId, mode, serverMode });
export const assistantCancel = (chatId: string) =>
  invoke<boolean>("assistant_cancel", { chatId });
/** True = the running turn took the message; false = queue it instead. */
export const assistantSteer = (chatId: string, text: string) =>
  invoke<boolean>("assistant_steer", { chatId, text });
export const assistantChats = (limit = 200) =>
  invoke<ChatSummary[]>("assistant_chats", { limit });
export const assistantChatsSearch = (query: string, limit = 200) =>
  invoke<ChatSummary[]>("assistant_chats_search", { query, limit });
export const assistantChatGet = (chatId: string) =>
  invoke<Chat>("assistant_chat_get", { chatId });
export const assistantChatRename = (chatId: string, title: string) =>
  invoke<void>("assistant_chat_rename", { chatId, title });
export const assistantChatDelete = (chatId: string) =>
  invoke<void>("assistant_chat_delete", { chatId });
export const assistantRunningChats = () =>
  invoke<string[]>("assistant_running_chats");
export const assistantChatRunning = (chatId: string) =>
  invoke<boolean>("assistant_chat_running", { chatId });
export const assistantContextSet = (context: ScreenContext) =>
  invoke<void>("assistant_context_set", { context });
export const assistantSuggestions = () =>
  invoke<Suggestion[]>("assistant_suggestions");
export const assistantUiReply = (
  requestId: string,
  ok: boolean,
  result?: unknown,
  error?: string,
) =>
  invoke<boolean>("assistant_ui_reply", {
    requestId,
    ok,
    result: result ?? null,
    error: error ?? null,
  });
export const assistantApprove = (
  requestId: string,
  approved: boolean,
  always = false,
) => invoke<boolean>("assistant_approve", { requestId, approved, always });
export const assistantSettingsGet = () =>
  invoke<AssistantSettingsView>("assistant_settings_get");
export const assistantSettingsSet = (patch: AssistantSettingsPatch) =>
  invoke<AssistantSettingsView>("assistant_settings_set", { patch });
export const assistantProviders = () =>
  invoke<ProviderInfo[]>("assistant_providers");
export const assistantModels = (provider: string) =>
  invoke<ModelInfo[]>("assistant_models", { provider });
export const assistantTools = (external = false) =>
  invoke<ToolSpec[]>("assistant_tools", { external });
export const assistantMcpInfo = () => invoke<McpInfo>("assistant_mcp_info");
export const assistantMcpServers = () =>
  invoke<McpServerStatus[]>("assistant_mcp_servers");
export const assistantMcpRestart = (name: string) =>
  invoke<McpServerStatus[]>("assistant_mcp_restart", { name });
/** Opens the browser to sign in; resolves once the login finished (up to 5 minutes). */
export const assistantMcpSignIn = (
  name: string,
  clientId?: string,
  clientSecret?: string,
) =>
  invoke<McpServerStatus[]>("assistant_mcp_sign_in", {
    name,
    clientId: clientId || null,
    clientSecret: clientSecret || null,
  });
export const assistantMcpSignOut = (name: string) =>
  invoke<McpServerStatus[]>("assistant_mcp_sign_out", { name });

/** Token use and cost of a set of model calls. */
export type UsageTotals = {
  calls: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** Sum over the calls that have a cost. */
  costUsd: number;
  /** Calls with no cost (unknown model, or a provider that reports none). */
  unpricedCalls: number;
};
export type ModelUsage = UsageTotals & { provider: string; model: string };
export type DayUsage = UsageTotals & { day: string };
export type UsageSummary = {
  total: UsageTotals;
  byModel: ModelUsage[];
  byDay: DayUsage[];
};
export const assistantUsageChat = (chatId: string) =>
  invoke<UsageTotals>("assistant_usage_chat", { chatId });
export const assistantUsageSummary = (days = 30) =>
  invoke<UsageSummary>("assistant_usage_summary", { days });

/** Subscribes to `assistant://event`; resolves to the unlisten function. */
export async function onAssistantEvent(
  cb: (event: AssistantEvent) => void,
): Promise<() => void> {
  return listen<AssistantEvent>("assistant://event", (e) => cb(e.payload));
}
