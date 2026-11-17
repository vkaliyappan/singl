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
  source?: string;
};

export type McpServerStatus = {
  name: string;
  source: string;
  enabled: boolean;
  state: "stopped" | "starting" | "running" | "error" | string;
  error: string | null;
  toolCount: number;
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
  mcpServers: McpServerConfig[];
  useProjectMcp: boolean;
  disabledProjectServers: string[];
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
  mcpServers: McpServerConfig[];
  useProjectMcp: boolean;
  disabledProjectServers: string[];
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
    }
  | {
      type: "approvalRequest";
      requestId: string;
      chatId: string | null;
      tool: string;
      input: unknown;
      risk: Risk;
      source: string;
    }
  | { type: "approvalResolved"; requestId: string; approved: boolean }
  | { type: "uiRequest"; requestId: string; action: string; args: unknown }
  | { type: "chatsChanged" };

export type ApprovalMode = "ask" | "auto" | "readOnly";

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
  /** Files dropped from outside the app (no path), read by the page. */
  inlineAttachments?: InlineAttachment[];
  /** Items pinned from screens (max 20). */
  references?: ReferenceInput[];
  /** Images (max 8, base64 without the data: prefix, <= 5 MB each). */
  images?: { name: string; mediaType: string; data: string }[];
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
export const assistantTurnMode = (chatId: string, mode: ApprovalMode) =>
  invoke<boolean>("assistant_turn_mode", { chatId, mode });
export const assistantCancel = (chatId: string) =>
  invoke<boolean>("assistant_cancel", { chatId });
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

/** Subscribes to `assistant://event`; resolves to the unlisten function. */
export async function onAssistantEvent(
  cb: (event: AssistantEvent) => void,
): Promise<() => void> {
  return listen<AssistantEvent>("assistant://event", (e) => cb(e.payload));
}
