"use client";

import { useState, type ReactNode } from "react";

export type Parsed<T> =
  | { ok: true; value: T }
  | { ok: false; message: string; complete: boolean };

/** Parse streamed JSON; an unfinished block is "waiting", a finished-but-bad one is an error. */
export function parseJson(source: string): Parsed<unknown> {
  const s = source.trim();
  if (!s) return { ok: false, message: "waiting for data…", complete: false };
  try {
    return { ok: true, value: JSON.parse(s) };
  } catch (e) {
    const complete = balanced(s);
    return {
      ok: false,
      message: complete ? (e as Error).message : "waiting for data…",
      complete,
    };
  }
}

/** All brackets closed (outside strings): the JSON has finished streaming. */
function balanced(s: string): boolean {
  let depth = 0;
  let inStr = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (c === "\\") i++;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") depth--;
  }
  return depth <= 0 && !inStr && /[}\]]$/.test(s);
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function Placeholder({
  kind,
  message,
  complete,
  source,
}: {
  kind: string;
  message: string;
  complete: boolean;
  source: string;
}) {
  return (
    <div className="my-2 rounded-md border bg-card p-2.5 text-xs">
      <div className={complete ? "text-destructive" : "text-muted-foreground"}>
        {kind}: {message}
      </div>
      {source.trim() && (
        <pre className="mt-1.5 max-h-40 overflow-auto text-[11px] whitespace-pre-wrap text-muted-foreground">
          {source}
        </pre>
      )}
    </div>
  );
}

export function SourceToggle({
  source,
  children,
}: {
  source: string;
  children: ReactNode;
}) {
  const [show, setShow] = useState(false);
  return (
    <>
      {show ? (
        <pre className="max-h-60 overflow-auto rounded bg-muted/50 p-2 text-[11px] whitespace-pre-wrap">
          {source}
        </pre>
      ) : (
        children
      )}
      <div className="mt-1 flex justify-end">
        <button
          type="button"
          className="text-[10px] text-muted-foreground hover:text-foreground"
          onClick={() => setShow((v) => !v)}
        >
          {show ? "Hide source" : "View source"}
        </button>
      </div>
    </>
  );
}

export function compact(n: number): string {
  return new Intl.NumberFormat(undefined, {
    notation: Math.abs(n) >= 10000 ? "compact" : "standard",
    maximumFractionDigits: 2,
  }).format(n);
}
