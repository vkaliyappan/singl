"use client";

import { useRef, useState } from "react";
import dynamic from "next/dynamic";
import { useTheme } from "@/components/providers";
import type { OnMount } from "@monaco-editor/react";

import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import {
  CODE_HELP,
  CODE_MEMORY_LIMIT_MB,
  DEFAULT_CODE_TIMEOUT_MS,
  MAX_CODE_TIMEOUT_MS,
} from "@/lib/twx-flow/code-node";
import { EXPRESSION_MIME } from "./schema-tree";

const MonacoEditor = dynamic(() => import("@monaco-editor/react"), {
  ssr: false,
  loading: () => (
    <div className="flex h-full items-center justify-center text-[11px] text-muted-foreground">
      Loading editor…
    </div>
  ),
});

/**
 * The Code node's body. Fields dragged out of the Input column land at the
 * caret as plain JavaScript — inside a snippet `$json` and `$node` are real
 * variables, so the `{{ }}` wrapper an expression field would add is wrong here.
 */
export function CodeEditor({
  code,
  timeoutMs,
  onChange,
  onTimeoutChange,
}: {
  code: string;
  timeoutMs?: number;
  onChange: (code: string) => void;
  onTimeoutChange: (ms: number | undefined) => void;
}) {
  const { resolvedTheme } = useTheme();
  const editorRef = useRef<Parameters<OnMount>[0] | null>(null);
  const [dropping, setDropping] = useState(false);

  const insert = (snippet: string) => {
    const ed = editorRef.current;
    if (!ed) {
      onChange(`${code}${snippet}`);
      return;
    }
    const selection = ed.getSelection();
    if (!selection) return;
    ed.executeEdits("twx-drop", [{ range: selection, text: snippet, forceMoveMarkers: true }]);
    ed.focus();
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div
        className={cn(
          "min-h-0 flex-1 overflow-hidden rounded-md border",
          dropping && "border-primary ring-2 ring-primary/30"
        )}
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes(EXPRESSION_MIME)) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "copy";
          setDropping(true);
        }}
        onDragLeave={() => setDropping(false)}
        onDrop={(e) => {
          const snippet = e.dataTransfer.getData(EXPRESSION_MIME);
          if (!snippet) return;
          e.preventDefault();
          setDropping(false);
          insert(snippet);
        }}
      >
        <MonacoEditor
          height="100%"
          language="javascript"
          value={code}
          theme={resolvedTheme === "dark" ? "vs-dark" : "vs"}
          onChange={(next) => onChange(next ?? "")}
          onMount={(ed) => {
            editorRef.current = ed;
          }}
          options={{
            minimap: { enabled: false },
            scrollBeyondLastLine: false,
            wordWrap: "on",
            fontSize: 12,
            lineNumbers: "on",
            folding: true,
            tabSize: 2,
            automaticLayout: true,
            renderLineHighlight: "line",
            scrollbar: { verticalScrollbarSize: 8, horizontalScrollbarSize: 8 },
          }}
        />
      </div>

      <div className="flex shrink-0 items-center gap-2">
        <label className="text-[10px] text-muted-foreground" htmlFor="twx-code-timeout">
          Timeout (ms)
        </label>
        <Input
          id="twx-code-timeout"
          type="number"
          min={100}
          max={MAX_CODE_TIMEOUT_MS}
          step={100}
          value={timeoutMs ?? ""}
          placeholder={String(DEFAULT_CODE_TIMEOUT_MS)}
          onChange={(e) => {
            const next = Number(e.target.value);
            onTimeoutChange(e.target.value.trim() && Number.isFinite(next) ? next : undefined);
          }}
          className="h-7 w-24 text-[11px]"
        />
        <span className="text-[10px] text-muted-foreground">
          {CODE_MEMORY_LIMIT_MB}MB isolate · no network, no filesystem
        </span>
      </div>

      <div className="shrink-0 rounded-md border bg-muted/40 p-1.5">
        <div className="flex flex-col gap-0.5">
          {CODE_HELP.map((h) => (
            <button
              key={h.snippet}
              type="button"
              onClick={() => insert(h.snippet)}
              className="flex items-baseline gap-2 rounded px-1 py-0.5 text-left hover:bg-accent"
            >
              <code className="shrink-0 font-mono text-[10px]">{h.snippet}</code>
              <span className="truncate text-[10px] text-muted-foreground">{h.hint}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
