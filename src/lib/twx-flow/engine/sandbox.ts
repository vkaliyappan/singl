/**
 * The trusted half of a Code node run: wraps the snippet, hands it to the
 * sandbox and turns the envelope that comes back into a value or an error.
 *
 * The snippet itself runs in a separate QuickJS runtime that Rust creates per
 * call (src-tauri/crates/singl-core/src/flow/sandbox.rs), with its own memory
 * limit and an interrupt deadline. It has no host functions at all: no fetch,
 * no filesystem, no timers — the only way in is `__inputJson` and the only way
 * out is the JSON string the wrapper returns. That keeps a snippet away from
 * the ThingWorx app key the rest of the run holds.
 */

import { CODE_MEMORY_LIMIT_MB, DEFAULT_CODE_TIMEOUT_MS, MAX_CODE_TIMEOUT_MS } from "../code-node";

export type CodeRunResult = {
  value: unknown;
  logs: string[];
};

/** Runs `source` in a fresh sandbox; resolves with whatever string it returned. */
export type Sandbox = (source: string, inputJson: string, budgetMs: number) => Promise<string>;

/**
 * The snippet runs as the body of an async function, so `return` and `await`
 * both work. Everything the host needs back — value, logs, and any thrown
 * error — leaves as one JSON string.
 */
const PREAMBLE = `
(async () => {
  const __logs = [];
  const __render = (v) => {
    if (typeof v === "string") return v;
    try { return JSON.stringify(v); } catch { return String(v); }
  };
  const __push = (...args) => {
    // A runaway loop that logs must not exhaust the heap before the deadline.
    if (__logs.length < 200) __logs.push(args.map(__render).join(" "));
  };
  const console = { log: __push, info: __push, warn: __push, error: __push, debug: __push };
  const { $json, $node, $now } = JSON.parse(__inputJson);
  const $ = (name) => $node[name];

  try {
    const __value = await (async () => {
`;

const EPILOGUE = `
    })();
    return JSON.stringify({
      ok: true,
      defined: __value !== undefined,
      value: __value === undefined ? null : __value,
      logs: __logs,
    });
  } catch (e) {
    return JSON.stringify({
      ok: false,
      error: String((e && e.message) || e),
      stack: e && e.stack ? String(e.stack) : "",
      logs: __logs,
    });
  }
})()
`;

const wrap = (code: string) => `${PREAMBLE}${code}${EPILOGUE}`;

/** Lines the wrapper adds above the snippet, so reported lines match the editor. */
const PREAMBLE_LINES = PREAMBLE.split("\n").length - 1;

/** QuickJS reports positions in the wrapped source (`code.js:LINE:COL`); shift them back. */
function describeFailure(message: string, stack: string): string {
  const frame = stack.match(/code\.js:(\d+)/);
  if (!frame) return message;
  const line = Number(frame[1]) - PREAMBLE_LINES;
  return line > 0 ? `${message} (line ${line})` : message;
}

type Envelope =
  | { ok: true; defined: boolean; value: unknown; logs: string[] }
  | { ok: false; error: string; stack: string; logs: string[]; limit?: "timeout" | "memory" | "stalled" };

/** Values only cross the boundary as JSON; anything JSON cannot express is dropped. */
function toJson(value: unknown): string {
  try {
    return JSON.stringify(value ?? null) ?? "null";
  } catch {
    return "null";
  }
}

export async function runCode(
  code: string,
  ctx: { $json: unknown; $node: Record<string, unknown>; now: Date },
  timeoutMs = DEFAULT_CODE_TIMEOUT_MS,
  sandbox: Sandbox
): Promise<CodeRunResult> {
  const budget = Math.min(MAX_CODE_TIMEOUT_MS, Math.max(100, Math.round(timeoutMs)));
  const input = toJson({ $json: ctx.$json, $node: ctx.$node, $now: ctx.now.toISOString() });
  const envelope = JSON.parse(await sandbox(wrap(code), input, budget)) as Envelope;

  if (envelope.ok) {
    return { value: envelope.defined ? envelope.value : undefined, logs: envelope.logs };
  }

  const message =
    envelope.limit === "timeout"
      ? `Code timed out after ${budget}ms`
      : envelope.limit === "memory"
        ? `Code exceeded the ${CODE_MEMORY_LIMIT_MB}MB memory limit`
        : envelope.limit === "stalled"
          ? "Code is awaiting something that will never settle — there is no fetch and no timer in the sandbox."
          : describeFailure(envelope.error, envelope.stack);
  const error = new Error(message) as Error & { logs?: string[] };
  error.logs = envelope.logs;
  throw error;
}
