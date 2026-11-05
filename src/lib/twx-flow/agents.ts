/**
 * The coding-agent CLIs an Agent node can drive, in data.
 *
 * One entry per provider: the binary to look for, the argv that puts it in
 * headless mode, and how to read what it printed back. Deliberately free of
 * `node:` imports so the palette and the settings panel can share it with the
 * runner — the spawning itself lives in `agent-run.ts`.
 */

import type { AgentNode, AgentProvider } from "./types";

export const AGENT_PROVIDERS: AgentProvider[] = ["claude", "codex", "copilot", "antigravity"];

/** Default budget for one agent run. Long, because agents are. */
export const DEFAULT_AGENT_TIMEOUT_MS = 300_000;
/** Ceiling on that budget, matching the run route's `maxDuration`. */
export const MAX_AGENT_TIMEOUT_MS = 3_600_000;
/** Most stdout an agent may hand back, so a runaway CLI cannot fill the heap. */
export const MAX_AGENT_OUTPUT_BYTES = 4_000_000;
/**
 * How much prompt may travel on a command line.
 *
 * Windows caps a whole command line at 32,767 characters and fails the spawn
 * with ENAMETOOLONG, so a prompt that carries a ThingWorx result in it cannot
 * go there. Every CLI here takes the prompt on stdin instead — except `agy`,
 * which wants it as a flag value until the prompt gets long, at which point it
 * switches to its streaming stdin mode. This is where "long" starts.
 */
export const MAX_PROMPT_ARG_CHARS = 8_000;

/** The parts of an Agent node the command line is built from. */
export type AgentInvocation = {
  provider: AgentProvider;
  prompt: string;
  model?: string;
  outputMode: "text" | "json";
  autoApprove?: boolean;
  /**
   * Tool rules the CLI may use without asking, in its own syntax — the
   * narrow alternative to `autoApprove`. Ignored by providers without
   * `allowToolArgs`, and redundant when `autoApprove` is on.
   */
  allowedTools?: string[];
  extraArgs?: string;
  /**
   * The project's `.mcp.json`, for CLIs that do not read it themselves. Claude
   * does; Copilot is handed it so both see the same MCP servers.
   */
  mcpConfig?: string;
  /**
   * Take the provider's streaming route even for a short prompt, for the live
   * progress it reports. Only matters for providers that have one.
   */
  stream?: boolean;
  /** Carry on an earlier session, or start one under a known id. */
  session?: AgentSession;
};

/**
 * Which of the CLI's own saved sessions a run belongs to.
 *
 * `resume` continues session `id`. Otherwise a new session starts, under `id`
 * when the CLI lets the caller pick one (`SessionMode.presetId`).
 */
export type AgentSession = { id?: string; resume: boolean };

/**
 * How a provider keeps a conversation going between runs. Every CLI here saves
 * its sessions on disk and can pick one up again by id.
 */
export type SessionMode = {
  /** Whether a new session can be given its id up front, rather than read back afterwards. */
  presetId: boolean;
  /**
   * Finds the id of the session a run ended up in, in what it printed. A
   * resume that quietly started over reports a different one.
   */
  pattern: RegExp;
};

/** One entry in a provider's model dropdown. */
export type AgentModel = {
  value: string;
  label?: string;
  /** Heading the entry is listed under — where it was found. */
  group?: string;
};

/**
 * How a provider's models are asked of the CLI itself.
 *
 * `args` is a fixed command — nothing from the flow reaches it — and `parse`
 * turns what it printed into the dropdown.
 */
export type ModelListing = { args: string[]; parse: (stdout: string) => AgentModel[] };

/**
 * How a provider takes a prompt too long for a command line.
 *
 * Only needed by the CLIs that want the prompt as a flag value; the rest read
 * stdin already.
 */
export type LongPromptMode = {
  /** argv for the streaming form — the prompt is not on it. */
  args: (invocation: AgentInvocation) => string[];
  /** What goes to stdin instead. */
  stdin: (prompt: string) => string;
  /** Longest prompt this route carries. Past it the CLI answers nothing at all. */
  maxChars: number;
  /** One event as a progress line for people; null to leave it out. */
  describeEvent?: (event: Record<string, unknown>) => string | null;
  /** Why a run that ended without an answer did, when the events say. */
  emptyReason?: (events: unknown[]) => string | undefined;
};

/**
 * How a provider reports progress while it works.
 *
 * In plain text mode `claude` and `copilot` print nothing until they are done,
 * so a chat waiting on them has nothing to show for minutes. Their event-stream
 * output says what the agent is doing as it happens; the answer is then read
 * out of the events.
 */
export type StreamMode = {
  /** argv for the streaming form. The prompt still goes in on stdin. */
  args: (invocation: AgentInvocation) => string[];
  /** One event as a progress line for people; null to leave it out. */
  describeEvent: (event: Record<string, unknown>) => string | null;
  /** The agent's answer, out of every event the run printed. */
  answer: (events: unknown[]) => string;
  /**
   * Tools the CLI refused to run because nothing allowed them. A headless run
   * cannot ask, so it denies — and the agent tends to explain that as the tool
   * being missing or unauthorised.
   */
  deniedTools?: (events: unknown[]) => string[];
};

/**
 * A process that stays up across the turns of a chat, messages in on stdin.
 *
 *   * `claude`: stream-json both ways, a `result` event ends each turn, and
 *     tool permissions come as `can_use_tool` control requests.
 *   * `acp`: the Agent Client Protocol — JSON-RPC, a `session/prompt` call per
 *     turn, and `session/request_permission` calls for tool permissions.
 *   * `codex`: `codex app-server`'s JSON-RPC — threads and turns, with
 *     approval requests for commands, file changes and MCP elicitations.
 *   * `agy`: stream-json both ways, a `result` event per turn. Nothing is
 *     asked: a tool no rule allows is denied.
 */
export type LiveMode = {
  protocol: "claude" | "acp" | "codex" | "agy";
  /** argv for the process. The session and model may be set up over the protocol instead. */
  args: (invocation: AgentInvocation) => string[];
  /** Whether `autoApprove` is fixed when the process starts, rather than answered per call. */
  approveAtStart?: boolean;
  /** Longest message the process takes; see `LongPromptMode.maxChars`. */
  maxChars?: number;
};

export type AgentProviderDef = {
  provider: AgentProvider;
  title: string;
  /** Palette one-liner. */
  hint: string;
  /**
   * A command that prints the CLI's models. Absent when the CLI has none —
   * `agent-models.ts` then looks where that CLI keeps its own list. Nothing is
   * hard-coded: providers change their line-up faster than this app ships.
   */
  listModels?: ModelListing[];
  /** Executable name looked up on PATH. */
  bin: string;
  /** Env var that points at the binary when it is not on PATH. */
  binEnv: string;
  /** Where the prompt goes. stdin has no length limit; a command line does. */
  promptVia: "stdin" | "arg";
  /** Used instead of `args` when the prompt is too long for `promptVia: "arg"`. */
  longPrompt?: LongPromptMode;
  /** Used instead of `args` for a text run that asked for live progress. */
  stream?: StreamMode;
  /** How the CLI holds a chat in one process across turns; see `agent-live.ts`. */
  live?: LiveMode;
  /** What `Output: JSON` asks the CLI for, and how to read it. */
  jsonKind: "object" | "jsonl";
  /** Environment the CLI needs for a headless run, over the server's own. */
  env?: Record<string, string>;
  /** Flag that lets the agent run its tools without asking. */
  approveArgs: string[];
  /** What that flag actually means for this CLI, said plainly. */
  approveHint: string;
  /**
   * argv that lets these tool rules run without asking. Absent when the CLI
   * has no per-tool switch — only `approveArgs` then.
   */
  allowToolArgs?: (rules: string[]) => string[];
  /** Example rules in this CLI's syntax, for the settings panel. */
  allowToolExample?: string;
  /** Everything but the prompt. `prompt` is included when `promptVia` is "arg". */
  args: (invocation: AgentInvocation) => string[];
  /** How runs pick up a session again. The argv for it is the `args` functions' job. */
  session: SessionMode;
  /** Where the flags come from, for the settings panel. */
  docs: string;
};

const flag = (name: string, value: string | undefined) =>
  value?.trim() ? [name, value.trim()] : [];

/**
 * The flag that continues a session (`resume`) or names a new one (`preset`).
 * `joined` writes `--flag=id`, for flags whose value is optional and would not
 * bind otherwise.
 */
const sessionFlags = (
  session: AgentSession | undefined,
  resume: string,
  preset?: string,
  joined = false
) => {
  const name = session?.resume ? resume : preset;
  if (!session?.id || !name) return [];
  return joined ? [`${name}=${session.id}`] : [name, session.id];
};

/** Copilot reads MCP servers from its own config only; the project's are added to them. */
const copilotMcpFlags = (mcpConfig: string | undefined) =>
  mcpConfig ? [`--additional-mcp-config=@${mcpConfig}`] : [];

/* ------------------------------------------------------ agy stream events -- */

type AgyStep = {
  state?: string;
  step_type?: string;
  tool_name?: string;
  duration_seconds?: number;
  usage?: { output_tokens?: number };
  tool_info?: {
    name?: string;
    parameters?: Record<string, unknown>;
    error?: { message?: string };
  };
};

type AgyResult = {
  duration_seconds?: number;
  denied_actions?: { action?: string; display_name?: string }[];
};

const oneLine = (text: string, max = 100) => {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

const seconds = (value: number | undefined) =>
  typeof value === "number" ? ` (${value.toFixed(1)}s)` : "";

const deniedNames = (result: AgyResult | undefined) =>
  (result?.denied_actions ?? []).map((d) => d.display_name || d.action || "a tool");

/** `agy`'s NDJSON events, as the progress a person would want to see. */
function describeAgyEvent(event: Record<string, unknown>): string | null {
  switch (event.event) {
    case "init": {
      const init = event.init as { permission_mode?: string } | undefined;
      return `Session started${init?.permission_mode ? ` · permissions: ${init.permission_mode}` : ""}`;
    }
    case "step_update": {
      const step = (event.step_update ?? {}) as AgyStep;
      if (step.step_type === "agent_response") {
        if (step.state === "ACTIVE") return "Writing…";
        if (step.state !== "DONE") return null;
        const tokens = step.usage?.output_tokens;
        return `Thought${seconds(step.duration_seconds)}${tokens ? ` · ${tokens} tokens` : ""}`;
      }
      if (step.step_type !== "tool") return null;
      const name = step.tool_name || step.tool_info?.name || "tool";
      if (step.state === "ACTIVE") {
        const first = Object.values(step.tool_info?.parameters ?? {}).find((v) => typeof v === "string");
        return `Running ${name}${first ? `: ${oneLine(first as string, 80)}` : ""}`;
      }
      if (step.state === "ERROR") {
        return `✗ ${name}: ${oneLine(step.tool_info?.error?.message ?? "failed", 160)}`;
      }
      if (step.state === "DONE") return `✓ ${name}${seconds(step.duration_seconds)}`;
      return null;
    }
    case "result": {
      const result = event.result as AgyResult | undefined;
      const denied = deniedNames(result);
      return `Finished${seconds(result?.duration_seconds)}${denied.length ? ` · denied: ${denied.join(", ")}` : ""}`;
    }
    default:
      return null;
  }
}

function agyEmptyReason(events: unknown[]): string | undefined {
  const result = events
    .map((e) => (e as { event?: unknown; result?: AgyResult } | null))
    .findLast((e) => e?.event === "result")?.result;
  const denied = deniedNames(result);
  if (!denied.length) return undefined;
  return (
    `Antigravity tried to use tools it is not allowed to (${[...new Set(denied)].join(", ")}) ` +
    "and stopped without an answer. Turn on “Allow agent tools”, or give it what it was looking for " +
    "in the prompt."
  );
}

/* --------------------------------------------------- claude stream events -- */

type Obj = Record<string, unknown>;

const asObj = (value: unknown): Obj =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Obj) : {};

const str = (value: unknown) => (typeof value === "string" ? value : "");

/** The first string argument of a tool call — usually the path, command or query. */
const firstArg = (input: unknown) => {
  const first = Object.values(asObj(input)).find((v) => typeof v === "string") as string | undefined;
  return first ? `: ${oneLine(first, 80)}` : "";
};

/** `claude --output-format stream-json`: one line per whole message, then a `result`. */
function describeClaudeEvent(event: Obj): string | null {
  switch (event.type) {
    case "system": {
      if (event.subtype !== "init") return null;
      const model = str(event.model);
      return `Session started${model ? ` · ${model}` : ""}`;
    }
    case "assistant": {
      const lines = (asObj(event.message).content as unknown[] | undefined ?? []).flatMap((raw) => {
        const block = asObj(raw);
        if (block.type === "tool_use") return [`Running ${str(block.name) || "tool"}${firstArg(block.input)}`];
        if (block.type === "thinking") return ["Thinking…"];
        if (block.type === "text" && str(block.text).trim()) return [oneLine(str(block.text))];
        return [];
      });
      return lines.length ? lines.join(" · ") : null;
    }
    case "user": {
      // Tool results. Only failures are worth a line; a success follows its "Running".
      const failed = (asObj(event.message).content as unknown[] | undefined ?? [])
        .map(asObj)
        .find((block) => block.type === "tool_result" && block.is_error);
      if (!failed) return null;
      const content = typeof failed.content === "string" ? failed.content : JSON.stringify(failed.content);
      return `✗ ${oneLine(content ?? "tool failed", 160)}`;
    }
    case "result": {
      if (event.is_error) return `✗ ${oneLine(str(event.result) || str(event.subtype) || "failed", 200)}`;
      const ms = typeof event.duration_ms === "number" ? event.duration_ms / 1000 : undefined;
      const denied = (event.permission_denials as unknown[] | undefined ?? []).map(
        (d) => str(asObj(d).tool_name) || "a tool"
      );
      return `Finished${seconds(ms)}${denied.length ? ` · denied: ${[...new Set(denied)].join(", ")}` : ""}`;
    }
    default:
      return null;
  }
}

function claudeDenied(events: unknown[]): string[] {
  const result = events.map(asObj).findLast((e) => e.type === "result");
  const denied = (result?.permission_denials as unknown[] | undefined) ?? [];
  return [...new Set(denied.map((d) => str(asObj(d).tool_name)).filter(Boolean))];
}

function claudeAnswer(events: unknown[]): string {
  const result = events.map(asObj).findLast((e) => e.type === "result");
  if (result && typeof result.result === "string") return result.result.trim();
  // No result event (the run was cut short): the last thing it wrote.
  for (const event of events.map(asObj).reverse()) {
    if (event.type !== "assistant") continue;
    const text = ((asObj(event.message).content as unknown[] | undefined) ?? [])
      .map(asObj)
      .filter((b) => b.type === "text")
      .map((b) => str(b.text))
      .join("")
      .trim();
    if (text) return text;
  }
  return "";
}

/* -------------------------------------------------- copilot stream events -- */

/**
 * `copilot --output-format json`: session events, one per line. The `*_delta`
 * ones arrive a token at a time and are left out; the whole message follows.
 */
function describeCopilotEvent(event: Obj): string | null {
  const type = str(event.type);
  const data = asObj(event.data);
  switch (type) {
    case "session.mcp_server_status_changed":
      return `MCP ${str(data.serverName) || "server"}: ${str(data.status)}`;
    case "session.tools_updated":
      return `Session started${str(data.model) ? ` · ${str(data.model)}` : ""}`;
    case "assistant.reasoning":
      return str(data.content).trim() ? `Thought: ${oneLine(str(data.content))}` : "Thinking…";
    case "assistant.message":
      return str(data.content).trim() ? oneLine(str(data.content)) : null;
    case "tool.execution_start":
      return `Running ${str(data.toolName) || "tool"}${firstArg(data.arguments)}`;
    case "tool.execution_complete": {
      if (data.success !== false) return null;
      const why = str(asObj(data.error).message) || str(asObj(data.result).content) || "failed";
      return `✗ ${oneLine(why, 160)}`;
    }
    case "result": {
      const usage = asObj(event.usage);
      const ms = typeof usage.sessionDurationMs === "number" ? usage.sessionDurationMs / 1000 : undefined;
      return typeof event.exitCode === "number" && event.exitCode !== 0
        ? `✗ Exited with code ${event.exitCode}`
        : `Finished${seconds(ms)}`;
    }
    default:
      return type.endsWith(".error") || type.endsWith("_error")
        ? `✗ ${oneLine(str(data.message) || type, 200)}`
        : null;
  }
}

/** The last message the agent wrote; earlier ones were said on the way to it. */
function copilotAnswer(events: unknown[]): string {
  for (const event of events.map(asObj).reverse()) {
    if (event.type !== "assistant.message") continue;
    const content = str(asObj(event.data).content).trim();
    if (content) return content;
  }
  return "";
}

/**
 * `agy models` prints one model per line as `id<TAB>Human name`, after a line
 * of its own about fetching them.
 */
function parseTabbedModels(stdout: string): AgentModel[] {
  const models: AgentModel[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const [value, label] = line.split("\t");
    if (!value?.trim() || !value.includes("-")) continue;
    models.push({ value: value.trim(), label: label?.trim() || undefined });
  }
  return models;
}

/**
 * `--help` documents `--model` with quoted examples. For `claude` those are
 * aliases that always point at the newest model of a family plus a full model
 * name; for `copilot` it is `auto`.
 */
function parseModelFlagHelp(stdout: string): AgentModel[] {
  const lines = stdout.split(/\r?\n/);
  const start = lines.findIndex((line) => /^\s*--model\b/.test(line));
  if (start < 0) return [];
  const block = [lines[start]];
  for (const line of lines.slice(start + 1)) {
    // The description is indented; the next option starts at the flag column.
    if (/^\s{0,4}-/.test(line)) break;
    block.push(line);
  }
  const models: AgentModel[] = [];
  for (const match of block.join(" ").matchAll(/'([A-Za-z0-9][\w.\-\[\]]*)'/g)) {
    const value = match[1];
    if (models.some((m) => m.value === value)) continue;
    const alias = !value.includes("-");
    models.push({
      value,
      group: alias ? "Aliases" : "Models",
    });
  }
  return models;
}

/**
 * `copilot help config` documents its models as a quoted bullet list under the
 * `model` setting. Reading it beats hard-coding a list that GitHub keeps
 * changing, and costs nothing — the help text is local.
 */
function parseCopilotConfigModels(stdout: string): AgentModel[] {
  const section = stdout.split(/`model`:/)[1];
  if (!section) return [];
  const models: AgentModel[] = [];
  for (const line of section.split(/\r?\n/)) {
    const match = line.match(/^\s*-\s*"([^"]+)"\s*$/);
    // The bullets run until the next setting's paragraph.
    if (!match) {
      if (models.length && line.trim() && !line.trim().startsWith("-")) break;
      continue;
    }
    models.push({ value: match[1] });
  }
  return models;
}

export const AGENT_DEFS: Record<AgentProvider, AgentProviderDef> = {
  claude: {
    provider: "claude",
    // The help text names the aliases that always mean "the latest of" a family.
    listModels: [{ args: ["--help"], parse: parseModelFlagHelp }],
    title: "Claude Code CLI",
    hint: "Run a prompt through Anthropic's `claude` CLI in print mode",
    bin: "claude",
    binEnv: "TWX_FLOW_AGENT_CLAUDE_BIN",
    promptVia: "stdin",
    jsonKind: "object",
    // In print mode MCP servers connect in the background, and the agent
    // starts without waiting. A server that takes a few seconds to boot — any
    // `npx` one — is still "pending" when the agent looks for its tools, finds
    // none, and reports the server as unauthorised. This makes it wait.
    env: { MCP_CONNECTION_NONBLOCKING: "0" },
    approveArgs: ["--dangerously-skip-permissions"],
    approveHint: "bypasses every permission check",
    // `=` keeps each rule one value: the flag is variadic, and a rule such as
    // `Bash(git log *)` has spaces in it.
    allowToolArgs: (rules) => rules.map((rule) => `--allowedTools=${rule}`),
    allowToolExample: "mcp__twx\nmcp__ado_with_filtered_domains__wit_work_item\nBash(git log *)",
    args: ({ model, outputMode, autoApprove, session }) => [
      "-p",
      "--output-format",
      outputMode === "json" ? "json" : "text",
      ...flag("--model", model),
      ...sessionFlags(session, "--resume", "--session-id"),
      ...(autoApprove ? ["--dangerously-skip-permissions"] : []),
    ],
    // A resume keeps the session's id; one that is gone fails the run.
    session: { presetId: true, pattern: /"session_id"\s*:\s*"([^"]+)"/g },
    stream: {
      args: ({ model, autoApprove, session }) => [
        "-p",
        "--output-format",
        "stream-json",
        // `stream-json` refuses to run in print mode without it.
        "--verbose",
        ...flag("--model", model),
        ...sessionFlags(session, "--resume", "--session-id"),
        ...(autoApprove ? ["--dangerously-skip-permissions"] : []),
      ],
      describeEvent: describeClaudeEvent,
      answer: claudeAnswer,
      deniedTools: claudeDenied,
    },
    live: {
      protocol: "claude",
      args: ({ model, session, allowedTools }) => [
        "-p",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--verbose",
        // Tool calls nothing allows yet come to us as `can_use_tool` requests
        // instead of being denied outright.
        "--permission-prompt-tool",
        "stdio",
        ...flag("--model", model),
        ...sessionFlags(session, "--resume", "--session-id"),
        ...(allowedTools ?? []).map((rule) => `--allowedTools=${rule}`),
      ],
    },
    docs: "claude --help",
  },
  codex: {
    provider: "codex",
    title: "Codex CLI",
    hint: "Run a prompt through OpenAI's `codex exec`",
    bin: "codex",
    binEnv: "TWX_FLOW_AGENT_CODEX_BIN",
    promptVia: "stdin",
    jsonKind: "jsonl",
    approveArgs: ["--dangerously-bypass-approvals-and-sandbox"],
    approveHint: "runs without approvals and without the sandbox",
    args: ({ model, outputMode, autoApprove, session }) => [
      "exec",
      ...(outputMode === "json" ? ["--json"] : []),
      ...flag("--model", model),
      "--skip-git-repo-check",
      ...(autoApprove ? ["--dangerously-bypass-approvals-and-sandbox"] : []),
      // `exec resume <id>` takes the same options, ahead of the subcommand.
      ...(session?.resume && session.id ? ["resume", session.id] : []),
      // A lone dash tells `codex exec` to read the prompt from stdin.
      "-",
    ],
    // No way to name a new session: the id is read from the `session id:`
    // line of the run's header, or from `thread.started` in JSON mode.
    session: {
      presetId: false,
      pattern: /(?:"thread_id"\s*:\s*"|\bsession id:\s*)([0-9a-f][0-9a-f-]{7,})/gi,
    },
    // Model, session and approvals are all set over the protocol.
    live: { protocol: "codex", args: () => ["app-server"] },
    docs: "codex exec --help",
  },
  copilot: {
    provider: "copilot",
    title: "GitHub Copilot CLI",
    hint: "Run a prompt through GitHub's `copilot` CLI non-interactively",
    bin: "copilot",
    binEnv: "TWX_FLOW_AGENT_COPILOT_BIN",
    listModels: [
      { args: ["--help"], parse: parseModelFlagHelp },
      { args: ["help", "config"], parse: parseCopilotConfigModels },
    ],
    // `-p` also accepts an empty value and reads the prompt from stdin, which
    // is the only way a long prompt survives Windows' command-line limit.
    promptVia: "stdin",
    jsonKind: "jsonl",
    approveArgs: ["--allow-all-tools"],
    approveHint: "lets every tool run unattended — the CLI needs this to finish a headless run that touches anything",
    allowToolArgs: (rules) => rules.map((rule) => `--allow-tool=${rule}`),
    allowToolExample: "twx\nshell(git:*)\nwrite",
    args: ({ model, outputMode, autoApprove, session, mcpConfig }) => [
      "-p",
      "",
      "--no-color",
      "--log-level",
      "none",
      "--output-format",
      outputMode === "json" ? "json" : "text",
      ...flag("--model", model),
      // `--session-id` would resume too, but quietly starts over when the
      // session is gone; `--resume` fails instead.
      ...sessionFlags(session, "--resume", "--session-id", true),
      ...copilotMcpFlags(mcpConfig),
      ...(autoApprove ? ["--allow-all-tools"] : []),
    ],
    session: { presetId: true, pattern: /"sessionId"\s*:\s*"([^"]+)"/g },
    // Session and model are picked over ACP (`session/new`, `session/load`,
    // `session/set_model`): `--model` goes unheard in this mode.
    live: {
      protocol: "acp",
      args: ({ allowedTools, mcpConfig }) => [
        "--acp",
        "--no-color",
        ...copilotMcpFlags(mcpConfig),
        ...(allowedTools ?? []).map((rule) => `--allow-tool=${rule}`),
      ],
    },
    stream: {
      // The JSON output is already the event stream.
      args: (invocation) => AGENT_DEFS.copilot.args({ ...invocation, outputMode: "json" }),
      describeEvent: describeCopilotEvent,
      answer: copilotAnswer,
    },
    docs: "copilot --help",
  },
  antigravity: {
    provider: "antigravity",
    title: "Antigravity CLI",
    hint: "Run a prompt through Google's `agy` CLI in print mode",
    bin: "agy",
    binEnv: "TWX_FLOW_AGENT_ANTIGRAVITY_BIN",
    listModels: [{ args: ["models"], parse: parseTabbedModels }],
    promptVia: "arg",
    jsonKind: "object",
    approveArgs: ["--dangerously-skip-permissions"],
    approveHint: "approves the agent's own tool calls unattended",
    args: ({ prompt, model, outputMode, autoApprove, session }) => [
      "-p",
      prompt,
      "--output-format",
      outputMode === "json" ? "json" : "text",
      ...flag("--model", model),
      ...sessionFlags(session, "--conversation"),
      ...(autoApprove ? ["--dangerously-skip-permissions"] : []),
    ],
    // A new conversation's id is only known once it starts. An unknown one
    // prints a warning and starts afresh under a new id rather than failing.
    session: { presetId: false, pattern: /"conversation_id"\s*:\s*"([^"]+)"/g },
    /**
     * `agy` has no plain stdin mode, but its streaming one reads NDJSON there —
     * so a prompt that will not fit on a command line goes in as one `user`
     * event, and the answer comes back as a `result` event.
     */
    longPrompt: {
      args: ({ model, autoApprove, session }) => [
        // The flag has to carry its (empty) value, or `agy` reads the next
        // argument as the prompt.
        "-p=",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        ...flag("--model", model),
        ...sessionFlags(session, "--conversation"),
        ...(autoApprove ? ["--dangerously-skip-permissions"] : []),
      ],
      stdin: (prompt) => `${JSON.stringify({ event: "user", message: { content: prompt } })}\n`,
      /**
       * `agy` drops an NDJSON line somewhere past 20kB — and reports SUCCESS
       * with an empty response and no tokens used rather than an error.
       * Measured: a 16kB line answers, a 25kB one comes back silently empty.
       * Refusing above a size known to work beats returning a blank answer.
       */
      maxChars: 16_000,
      describeEvent: describeAgyEvent,
      emptyReason: agyEmptyReason,
    },
    // The same streaming mode, kept open: it runs a turn per line on stdin.
    live: {
      protocol: "agy",
      args: (invocation) => AGENT_DEFS.antigravity.longPrompt!.args(invocation),
      approveAtStart: true,
      maxChars: 16_000,
    },
    docs: "agy --help",
  },
};

export const agentDef = (provider: AgentProvider): AgentProviderDef =>
  AGENT_DEFS[provider] ?? AGENT_DEFS.claude;

/**
 * Splits an extra-argument string the way a shell would, minus the shell:
 * spaces separate, quotes group. Nothing is expanded or executed.
 */
export function splitArgs(raw: string | undefined): string[] {
  if (!raw?.trim()) return [];
  const out: string[] = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(raw))) {
    // A quoted empty string is an argument — dropping it would hand the flag
    // before it the next word as its value.
    out.push(match[1] ?? match[2] ?? match[3] ?? "");
  }
  return out;
}

/** Whether this prompt has to take the provider's streaming stdin route. */
export function needsLongPrompt(invocation: AgentInvocation): boolean {
  const def = agentDef(invocation.provider);
  return (
    def.promptVia === "arg" &&
    def.longPrompt !== undefined &&
    (invocation.stream === true || invocation.prompt.length > MAX_PROMPT_ARG_CHARS)
  );
}

/**
 * Whether this run takes the provider's progress-reporting route. Only text
 * runs do: JSON mode already hands back the provider's own output shape.
 */
export function usesStreamMode(invocation: AgentInvocation): boolean {
  return (
    invocation.stream === true &&
    invocation.outputMode === "text" &&
    agentDef(invocation.provider).stream !== undefined &&
    !needsLongPrompt(invocation)
  );
}

/** The full argv for a run, prompt included where the CLI wants it on the line. */
export function buildAgentArgs(invocation: AgentInvocation): string[] {
  const def = agentDef(invocation.provider);
  const base = needsLongPrompt(invocation)
    ? def.longPrompt!.args(invocation)
    : usesStreamMode(invocation)
      ? def.stream!.args(invocation)
      : def.args(invocation);
  const allow =
    !invocation.autoApprove && invocation.allowedTools?.length && def.allowToolArgs
      ? def.allowToolArgs(invocation.allowedTools)
      : [];
  return [...base, ...allow, ...splitArgs(invocation.extraArgs)];
}

/** Most tool rules one run takes, and the longest one. */
const MAX_TOOL_RULES = 100;
const MAX_TOOL_RULE_CHARS = 200;

/**
 * Tool rules from a request, made safe for argv: strings only, one line each,
 * none that could read as a flag of its own, no duplicates.
 */
export function cleanToolRules(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const rules = raw
    .filter((r): r is string => typeof r === "string")
    .map((r) => r.trim())
    .filter((r) => r && r.length <= MAX_TOOL_RULE_CHARS && !r.startsWith("-") && !/[\u0000-\u001f]/.test(r));
  return [...new Set(rules)].slice(0, MAX_TOOL_RULES);
}

/** One rule per line, as typed in the settings panel. Commas stay: a rule may have one. */
export const parseToolRules = (text: string): string[] => cleanToolRules(text.split("\n"));

/**
 * Turns what the CLI printed into the node's result.
 *
 * Text mode keeps stdout verbatim, since that is what the user asked for. JSON
 * mode parses either the single object Claude and `agy` print or the NDJSON
 * event stream Codex and Copilot print — and, for a stream, also pulls out the
 * agent's last message so `{{ $json.text }}` says something useful.
 */
export function parseAgentOutput(
  stdout: string,
  provider: AgentProvider,
  outputMode: "text" | "json",
  /** True when the run took a provider's streaming route, whatever its usual shape. */
  streamed = false
): unknown {
  const text = stdout.trim();
  if (!text) return text;

  // A streamed run always prints events, so text mode means "the answer out of
  // those events" rather than the raw stream.
  if (streamed) {
    const events = parseEvents(text);
    if (!events.length) return text;
    const message = (agentDef(provider).stream?.answer ?? lastMessage)(events);
    return outputMode === "json" ? { events, text: message } : message;
  }

  if (outputMode === "text") return text;

  if (agentDef(provider).jsonKind === "object") {
    try {
      return JSON.parse(text);
    } catch {
      // A CLI that ignored --output-format still gave us something to show.
      return text;
    }
  }

  const events = parseEvents(text);
  if (!events.length) return text;
  return { events, text: lastMessage(events) };
}

/** The JSON objects in an NDJSON stream, skipping any prose printed alongside. */
function parseEvents(text: string): unknown[] {
  const events: unknown[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(JSON.parse(trimmed));
    } catch {
      // Progress chatter the CLI printed alongside the stream. Not an event.
    }
  }
  return events;
}

/** The last thing the agent itself said in an NDJSON event stream. */
function lastMessage(events: unknown[]): string {
  for (let i = events.length - 1; i >= 0; i--) {
    const found = messageOf(events[i]);
    if (found) return found;
  }
  return "";
}

/**
 * Digs the assistant's text out of one event.
 *
 * The two streaming CLIs disagree about shape — Codex nests it under
 * `msg`/`item`, Copilot under `data` — so this looks for the handful of places
 * a message is known to sit rather than pretending there is one schema.
 */
function messageOf(event: unknown): string {
  if (!event || typeof event !== "object") return "";
  const record = event as Record<string, unknown>;
  const nested = ["msg", "item", "data", "message", "result", "step_update"] as const;

  for (const key of ["text", "message", "content", "result", "response"] as const) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  for (const key of nested) {
    const value = record[key];
    if (value && typeof value === "object") {
      const found = messageOf(value);
      if (found) return found;
    }
  }
  return "";
}

/** The session a run ended up in, going by what it printed; the last id mentioned wins. */
export function sessionIdFrom(provider: AgentProvider, output: string): string | undefined {
  const { pattern } = agentDef(provider).session;
  let found: string | undefined;
  for (const match of output.matchAll(new RegExp(pattern.source, pattern.flags))) found = match[1];
  return found;
}

/** Card and panel summary: what this node will actually do. */
export function describeAgent(node: AgentNode): string {
  const def = agentDef(node.provider);
  const model = node.model?.trim();
  return model ? `${def.bin} · ${model}` : def.bin;
}
