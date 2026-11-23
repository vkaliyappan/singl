"use client";

import { useId, useRef, useState } from "react";
import { IconChevronDown, IconChevronUp, IconHelpCircle, IconX } from "@tabler/icons-react";

import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { isObjectType } from "@/lib/twx-flow/graph";
import {
  EXPRESSION_HELP,
  evaluateTemplate,
  isExpression,
  type ExprContext,
} from "@/lib/twx-flow/expression";
import type { ServiceParam } from "@/lib/twx/types";
import { ExpressionEditor, type ExpressionEditorHandle } from "./expression-editor";
import { JsonView } from "./json-view";
import { EXPRESSION_MIME } from "./schema-tree";

/** Metrics for the plain textareas. The expression editor carries its own. */
const EDITOR_TEXT = "px-2 py-1.5 font-mono text-[11px] leading-[1.5] whitespace-pre-wrap break-words";

function typeName(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (Array.isArray(value)) return `array[${value.length}]`;
  if (typeof value === "object") {
    const rows = (value as { rows?: unknown[] }).rows;
    return Array.isArray(rows) ? `infotable[${rows.length}]` : "object";
  }
  return typeof value;
}

/**
 * One parameter, edited the n8n way: a Fixed / Expression switch over a single
 * field, the evaluated result underneath, and schema rows droppable onto it.
 */
export function ExpressionField({
  param,
  value,
  ctx,
  runError,
  compact,
  label,
  suggestions,
  multiline,
  onChange,
}: {
  param: ServiceParam;
  value: string;
  ctx: ExprContext;
  /** Expression failure recorded by the last run, if any. */
  runError?: string;
  /** Tighter chrome for fields that sit inside a row, e.g. a Filter condition. */
  compact?: boolean;
  /** Overrides the parameter name in the label row. */
  label?: string;
  /** Values offered as you type in Fixed mode — infotable columns, usually. */
  suggestions?: string[];
  /** Gives Fixed mode room to breathe, for fields that hold prose — a prompt. */
  multiline?: boolean;
  onChange: (value: string) => void;
}) {
  const [helpOpen, setHelpOpen] = useState(false);
  const [resultOpen, setResultOpen] = useState(false);
  const [dropping, setDropping] = useState(false);
  const fieldRef = useRef<HTMLTextAreaElement | HTMLInputElement | null>(null);
  const editorRef = useRef<ExpressionEditorHandle | null>(null);
  const listId = useId();

  const expression = isExpression(value);
  const evaluated = expression ? evaluateTemplate(value, ctx) : null;
  /** An object result gets the JSON tree; anything else is shown as its text. */
  const objectResult =
    !!evaluated && !evaluated.error && typeof evaluated.value === "object" && evaluated.value !== null;
  const resultText =
    evaluated && !objectResult
      ? evaluated.value === undefined || evaluated.value === ""
        ? "[empty]"
        : String(evaluated.value)
      : null;
  // Worth a taller box, and a control to ask for one.
  const resultIsLong =
    objectResult || (!!resultText && (resultText.length > 200 || /\r?\n/.test(resultText)));
  const required = !!param.aspects?.isRequired;
  const defaultValue = param.aspects?.defaultValue;

  /** Inserts at the caret, so a drop lands where the user is pointing. */
  const insert = (snippet: string) => {
    const wrapped = expression ? snippet : `{{ ${snippet} }}`;
    if (expression) {
      editorRef.current?.insert(wrapped);
      return;
    }
    const el = fieldRef.current;
    if (!el) {
      onChange(`${value}${wrapped}`);
      return;
    }
    const start = el.selectionStart ?? value.length;
    const end = el.selectionEnd ?? value.length;
    onChange(`${value.slice(0, start)}${wrapped}${value.slice(end)}`);
    requestAnimationFrame(() => {
      el.focus();
      const caret = start + wrapped.length;
      el.setSelectionRange(caret, caret);
    });
  };

  const setMode = (next: "fixed" | "expression") => {
    if (next === "expression" && !expression) {
      onChange(value.trim() ? `{{ ${JSON.stringify(value)} }}` : "{{  }}");
    } else if (next === "fixed" && expression) {
      // Leaving expression mode keeps the text, minus the braces.
      onChange(value.replace(/\{\{|\}\}/g, "").trim());
    }
  };

  const dropProps = {
    onDragOver: (e: React.DragEvent) => {
      if (!e.dataTransfer.types.includes(EXPRESSION_MIME)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy" as const;
      setDropping(true);
    },
    onDragLeave: () => setDropping(false),
    onDrop: (e: React.DragEvent) => {
      const snippet = e.dataTransfer.getData(EXPRESSION_MIME);
      if (!snippet) return;
      e.preventDefault();
      setDropping(false);
      // A drop onto a literal field promotes it to an expression.
      if (!expression) onChange(value.trim() ? `${value}{{ ${snippet} }}` : `{{ ${snippet} }}`);
      else insert(snippet);
    },
  };

  const tab = (mode: "fixed" | "expression", label: string) => {
    const active = mode === (expression ? "expression" : "fixed");
    return (
      <button
        key={mode}
        type="button"
        onClick={() => setMode(mode)}
        className={cn(
          "rounded-[5px] px-1.5 py-0.5 text-[10px] transition-colors",
          active
            ? "bg-background text-foreground shadow-sm"
            : "text-muted-foreground hover:text-foreground"
        )}
      >
        {label}
      </button>
    );
  };

  return (
    <div className="flex flex-col gap-1" {...dropProps}>
      {/* Label row */}
      <div className="flex items-center gap-1.5">
        <span
          className={cn("truncate font-medium", compact ? "text-[10px]" : "text-[11px]")}
          title={param.name}
        >
          {label ?? param.name}
          {required && !compact && <span className="ml-0.5 text-destructive">*</span>}
        </span>
        {!compact && (
          <span className="shrink-0 font-mono text-[9px] text-muted-foreground uppercase">
            {param.baseType}
          </span>
        )}

        <div className="ml-auto flex items-center gap-1">
          {value !== "" && (
            <button
              type="button"
              onClick={() => onChange("")}
              aria-label="Clear"
              title="Clear"
              className="text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/30 focus-visible:outline-none"
            >
              <IconX className="size-3" />
            </button>
          )}
          <button
            type="button"
            onClick={() => setHelpOpen((o) => !o)}
            aria-label="Expression help"
            title="Expression help"
            className={cn(
              "text-muted-foreground hover:text-foreground",
              helpOpen && "text-foreground"
            )}
          >
            <IconHelpCircle className="size-3.5" />
          </button>
          <div className="flex items-center gap-0.5 rounded-md bg-muted p-0.5">
            {tab("fixed", "Fixed")}
            {tab("expression", "Expression")}
          </div>
        </div>
      </div>

      {/* Field */}
      {expression ? (
        <div
          className={cn(
            "rounded-md border bg-input/20 transition-colors focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/30 dark:bg-input/30",
            dropping && "border-primary ring-2 ring-primary/30",
            runError && "border-destructive/60"
          )}
        >
          <ExpressionEditor
            ref={editorRef}
            value={value}
            ctx={ctx}
            placeholder="{{ $json.rows[0].name }}"
            onChange={onChange}
            onDropSnippet={() => setDropping(false)}
          />
        </div>
      ) : isObjectType(param.baseType) || multiline ? (
        <textarea
          ref={fieldRef as React.Ref<HTMLTextAreaElement>}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          spellCheck={false}
          placeholder={
            multiline && !isObjectType(param.baseType)
              ? "Plain text — or drop a field from Input"
              : "JSON value — or drop a field from Input"
          }
          className={cn(
            "field-sizing-content min-h-14 w-full resize-none rounded-md border border-input bg-input/20 outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30 dark:bg-input/30",
            EDITOR_TEXT,
            dropping && "border-primary ring-2 ring-primary/30"
          )}
        />
      ) : param.baseType === "BOOLEAN" ? (
        <select
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="h-7 w-full rounded-md border border-input bg-input/20 px-2 text-[11px] dark:bg-input/30"
        >
          <option value="">—</option>
          <option value="true">true</option>
          <option value="false">false</option>
        </select>
      ) : (
        <>
          <Input
            ref={fieldRef as React.Ref<HTMLInputElement>}
            value={value}
            list={suggestions?.length ? listId : undefined}
            onChange={(e) => onChange(e.target.value)}
            placeholder={defaultValue != null ? String(defaultValue) : "fixed value"}
            className={cn("h-7 text-[11px]", dropping && "border-primary ring-2 ring-primary/30")}
          />
          {suggestions?.length ? (
            <datalist id={listId}>
              {suggestions.map((s) => (
                <option key={s} value={s} />
              ))}
            </datalist>
          ) : null}
        </>
      )}

      {/* Hint */}
      {param.description && !compact && (
        <p className="text-[10px] leading-snug text-muted-foreground">{param.description}</p>
      )}

      {helpOpen && (
        <div className="rounded-md border bg-muted/40 p-1.5">
          <p className="mb-1 text-[10px] text-muted-foreground">
            Click a snippet to insert it — or drag a field from the Input panel.
          </p>
          <div className="flex flex-col gap-0.5">
            {EXPRESSION_HELP.map((h) => (
              <button
                key={h.snippet}
                type="button"
                onClick={() => insert(h.snippet)}
                className="flex items-baseline gap-2 rounded px-1 py-0.5 text-left hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/30 focus-visible:outline-none"
              >
                <code className="shrink-0 font-mono text-[10px]">{h.snippet}</code>
                <span className="truncate text-[10px] text-muted-foreground">{h.hint}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Evaluated result, the way n8n shows it under an expression */}
      {evaluated && (
        <div
          className={cn(
            "overflow-hidden rounded-md border",
            evaluated.error ? "border-destructive/50" : "border-border"
          )}
        >
          <div className="flex items-center gap-1.5 border-b bg-muted/50 px-2 py-0.5 text-[9px] tracking-wide text-muted-foreground uppercase">
            Result
            <span className="ml-auto truncate font-mono normal-case">
              {evaluated.error ? (
                <span className="text-destructive">{evaluated.error}</span>
              ) : (
                <>
                  {typeName(evaluated.value)}
                  {resultText && resultText.length > 60 && (
                    <span className="text-muted-foreground/70">
                      {" · "}
                      {resultText.length.toLocaleString()} chars
                    </span>
                  )}
                </>
              )}
            </span>
            {resultIsLong && (
              <button
                type="button"
                onClick={() => setResultOpen((open) => !open)}
                title={resultOpen ? "Show less" : "Show more"}
                className="shrink-0 text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/30 focus-visible:outline-none"
              >
                {resultOpen ? (
                  <IconChevronUp className="size-3" />
                ) : (
                  <IconChevronDown className="size-3" />
                )}
              </button>
            )}
          </div>
          {objectResult ? (
            <JsonView
              value={evaluated.value}
              className={cn(
                "overflow-auto rounded-none border-0 bg-transparent",
                resultOpen ? "max-h-96" : "max-h-40"
              )}
            />
          ) : (
            <p
              // `anywhere` rather than `break-all`: words stay whole, and only a
              // run with nowhere to break — a stringified object, usually — is cut.
              style={{ overflowWrap: "anywhere" }}
              className={cn(
                "overflow-auto px-2 py-1 font-mono text-[11px] leading-[1.5] whitespace-pre-wrap",
                resultOpen ? "max-h-96" : "max-h-32",
                evaluated.error ? "text-destructive" : "text-foreground"
              )}
            >
              {resultText}
            </p>
          )}
        </div>
      )}

      {runError && <p className="text-[10px] text-destructive">Last run: {runError}</p>}
    </div>
  );
}
