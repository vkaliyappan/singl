// Shared helpers for building "Add to chat" pins.

/** Largest content a single pin carries. */
export const PIN_LIMIT = 40 * 1024;

/** Cuts text to `n` characters and says how much was dropped. */
export function clipText(s: string, n: number = PIN_LIMIT): string {
  return s.length > n ? `${s.slice(0, n)}\n… (${s.length - n} more characters cut)` : s;
}

/** Pretty JSON, clipped to the pin limit. */
export function clipJson(v: unknown, n: number = PIN_LIMIT): string {
  let text: string;
  try {
    text = JSON.stringify(v, null, 2) ?? "null";
  } catch {
    text = String(v);
  }
  return clipText(text, n);
}
