/**
 * Runs a coding-agent CLI for an Agent node: singl-web's `agent-run.ts`,
 * inside the flow engine.
 *
 * Starting, feeding, timing out and killing the process is Rust's job
 * (src-tauri/crates/singl-core/src/agents): it only starts the four known
 * binaries, never through a shell, and only in a working directory inside the
 * agent root. What goes on the command line and how the output reads is
 * agents.ts, shared with the editor.
 */

import {
  agentDef,
  buildAgentArgs,
  DEFAULT_AGENT_TIMEOUT_MS,
  MAX_AGENT_OUTPUT_BYTES,
  MAX_AGENT_TIMEOUT_MS,
  needsLongPrompt,
  parseAgentOutput,
  usesStreamMode,
  type AgentInvocation,
} from "../agents";
import type { AgentProvider } from "../types";

/** The Rust side of an agent run; see `Host::agent_*` in flow/mod.rs. */
export type AgentHost = {
  /** `{ ok, cwd, root, mcpConfig }`, `{ ok: false, disabled: true }`, or `{ ok: false, error }`. */
  agentPrepare(provider: string, cwd: string): string;
  /** `{ ok, id }` or `{ ok: false, error }`. */
  agentSpawn(specJson: string, cwd: string): Promise<string>;
  /** JSON array of ProcEvents; waits until there is at least one. */
  agentNext(id: string): Promise<string>;
  agentKill(id: string): boolean;
};

export type AgentRunOptions = {
  provider: AgentProvider;
  prompt: string;
  model?: string;
  cwd?: string;
  outputMode: "text" | "json";
  autoApprove?: boolean;
  extraArgs?: string;
  timeoutMs?: number;
  /** Called per line the CLI prints, so the canvas can show progress live. */
  onLine?: (line: string) => void;
  signal?: { readonly aborted: boolean };
};

export type AgentRunResult = {
  value: unknown;
  command: string;
  cwd: string;
  exitCode: number;
  logs: string[];
  ms: number;
};

type ProcEvent =
  | { type: "stdout"; line: string }
  | { type: "stderr"; line: string }
  | { type: "exit"; code: number | null; timedOut: boolean; killed: boolean };

/** Lines kept per run, so a chatty agent cannot fill the node state. */
const MAX_LOG_LINES = 400;

/** Windows' own limit is 32,767 characters for the whole command line. */
const MAX_COMMAND_LINE_CHARS = 30_000;

const errorWithLogs = (message: string, logs: string[], exitCode?: number) => {
  const error = new Error(message) as Error & { logs?: string[]; exitCode?: number };
  error.logs = logs;
  if (exitCode !== undefined) error.exitCode = exitCode;
  return error;
};

function unwrap<T>(raw: string): T & { ok: true } {
  const envelope = JSON.parse(raw) as ({ ok: true } & T) | { ok: false; error: string; disabled?: boolean };
  if (!envelope.ok) throw Object.assign(new Error(envelope.error), { disabled: envelope.disabled });
  return envelope;
}

export async function runAgent(host: AgentHost, options: AgentRunOptions): Promise<AgentRunResult> {
  const def = agentDef(options.provider);
  const prompt = options.prompt.trim();
  if (!prompt) throw new Error("The prompt is empty — there is nothing to ask the agent.");

  let prepared: { cwd: string; mcpConfig?: string | null };
  try {
    prepared = unwrap(host.agentPrepare(options.provider, options.cwd ?? ""));
  } catch (e) {
    if ((e as { disabled?: boolean }).disabled) {
      throw new Error(`${def.title} is switched off. Turn it on under Settings → AI Agents.`);
    }
    throw e;
  }

  const invocation: AgentInvocation = {
    provider: options.provider,
    prompt,
    model: options.model,
    outputMode: options.outputMode,
    autoApprove: options.autoApprove,
    extraArgs: options.extraArgs,
    mcpConfig: prepared.mcpConfig ?? undefined,
  };
  const args = buildAgentArgs(invocation);
  // Long prompts go in over stdin; `agy` needs its streaming form to accept one.
  const streamed = needsLongPrompt(invocation);
  const stdin = streamed ? def.longPrompt!.stdin(prompt) : def.promptVia === "stdin" ? prompt : "";
  if (streamed && prompt.length > def.longPrompt!.maxChars) {
    throw new Error(
      `This prompt is ${prompt.length} characters. ${def.title} takes at most ` +
        `${def.longPrompt!.maxChars} — past that it returns an empty answer instead of failing. ` +
        "Shorten the prompt, or use the Claude, Codex or Copilot node, which have no such limit."
    );
  }
  const length = def.bin.length + args.reduce((total, arg) => total + arg.length + 3, 0);
  if (length > MAX_COMMAND_LINE_CHARS) {
    throw new Error(
      `The command line for ${def.title} is ${length} characters, past the ${MAX_COMMAND_LINE_CHARS} ` +
        "this platform allows — if an extra argument is that long, shorten it."
    );
  }
  const budget = Math.min(
    MAX_AGENT_TIMEOUT_MS,
    Math.max(1_000, Math.round(options.timeoutMs || DEFAULT_AGENT_TIMEOUT_MS))
  );
  // The prompt never appears here: it is on stdin or one argv element.
  const command = [def.bin, ...buildAgentArgs({ ...invocation, prompt: "…" })].join(" ");
  const startedAt = Date.now();

  const spawned = unwrap<{ id: string }>(
    await host.agentSpawn(
      JSON.stringify({ provider: options.provider, args, stdin, env: def.env ?? {}, timeoutMs: budget }),
      prepared.cwd
    )
  );

  const logs: string[] = [];
  const note = (line: string) => {
    if (logs.length < MAX_LOG_LINES) logs.push(line);
    options.onLine?.(line);
  };
  const eventStream = usesStreamMode(invocation);
  const describeEvent = streamed
    ? def.longPrompt!.describeEvent
    : eventStream
      ? def.stream!.describeEvent
      : undefined;
  const onStdout = (line: string) => {
    // In JSON mode every line is machine output; as a log it would be the result twice.
    if (options.outputMode !== "text" || !line.trim()) return;
    if (!describeEvent) return note(line);
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      return note(line);
    }
    const described = event && typeof event === "object" ? describeEvent(event as Record<string, unknown>) : null;
    if (described) note(described);
  };

  let stdout = "";
  let truncated = false;
  let exit: Extract<ProcEvent, { type: "exit" }> | undefined;
  while (!exit) {
    const events = JSON.parse(await host.agentNext(spawned.id)) as ProcEvent[];
    if (!events.length) break;
    for (const event of events) {
      if (event.type === "exit") exit = event;
      else if (event.type === "stderr") {
        if (event.line.trim()) note(event.line);
      } else if (!truncated) {
        if (stdout.length + event.line.length + 1 > MAX_AGENT_OUTPUT_BYTES) {
          truncated = true;
          host.agentKill(spawned.id);
          continue;
        }
        stdout += `${event.line}\n`;
        onStdout(event.line);
      }
    }
  }

  if (options.signal?.aborted || (exit?.killed && !truncated)) throw new Error("Run cancelled");
  if (exit?.timedOut) throw errorWithLogs(`${def.title} timed out after ${budget}ms`, logs);
  if (truncated) {
    throw errorWithLogs(`${def.title} printed more than ${MAX_AGENT_OUTPUT_BYTES} bytes and was stopped`, logs);
  }
  const exitCode = exit?.code ?? 1;
  if (exitCode !== 0) {
    const tail = logs.slice(-8).join("\n").trim();
    throw errorWithLogs(`${def.title} exited with code ${exitCode}${tail ? `:\n${tail}` : "."}`, logs, exitCode);
  }

  const value = parseAgentOutput(stdout, options.provider, options.outputMode, streamed || eventStream);
  if (streamed && !(typeof value === "string" ? value.trim() : (value as { text?: string })?.text?.trim())) {
    const events = stdout.split("\n").flatMap((line) => {
      try {
        return [JSON.parse(line) as unknown];
      } catch {
        return [];
      }
    });
    throw errorWithLogs(
      def.longPrompt!.emptyReason?.(events) ??
        `${def.title} accepted the prompt but returned nothing. It is ${prompt.length} characters — try a shorter one.`,
      logs
    );
  }

  return { value, command, cwd: prepared.cwd, exitCode, logs, ms: Date.now() - startedAt };
}
