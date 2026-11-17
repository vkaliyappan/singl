"use client";

import { createContext, useContext, useMemo, useState } from "react";
import { IconCheck } from "@tabler/icons-react";
import { cn } from "@/lib/utils";
import { isRecord, parseJson, Placeholder } from "./shared";

export const ChoiceContext = createContext<{
  send: ((text: string) => void) | null;
  active: boolean;
}>({ send: null, active: false });

interface Option {
  label: string;
  value: string;
  description?: string;
}
interface Spec {
  question?: string;
  options: Option[];
  multi: boolean;
}

function toOption(o: unknown): Option | null {
  if (typeof o === "string" && o.trim()) return { label: o, value: o };
  if (isRecord(o) && typeof o.label === "string" && o.label.trim())
    return {
      label: o.label,
      value: typeof o.value === "string" && o.value ? o.value : o.label,
      description: typeof o.description === "string" ? o.description : undefined,
    };
  return null;
}

export function ChoicesBlock({ source }: { source: string }) {
  const { send, active } = useContext(ChoiceContext);
  const [picked, setPicked] = useState<string[] | null>(null); // sent labels
  const [draft, setDraft] = useState<string[]>([]);

  const parsed = useMemo(() => {
    const p = parseJson(source);
    if (!p.ok) return p;
    const raw = p.value;
    const list = Array.isArray(raw) ? raw : isRecord(raw) ? raw.options : undefined;
    const options = Array.isArray(list)
      ? list.map(toOption).filter((o): o is Option => o !== null)
      : [];
    if (!options.length)
      return { ok: false, message: "expected a non-empty options list", complete: true } as const;
    return {
      ok: true,
      value: {
        question: isRecord(raw) && typeof raw.question === "string" ? raw.question : undefined,
        options,
        multi: isRecord(raw) && raw.multi === true,
      } satisfies Spec,
    } as const;
  }, [source]);

  if (!parsed.ok)
    return <Placeholder kind="Choices" message={parsed.message} complete={parsed.complete} source={source} />;

  const { question, options, multi } = parsed.value;
  const done = picked !== null;
  const disabled = done || !active || !send;

  const submit = (labels: string[], text: string) => {
    if (disabled || !send || !text) return;
    setPicked(labels);
    send(text);
  };

  return (
    <div className="my-2 rounded-md border bg-card p-2.5 text-xs">
      {question && <div className="mb-1.5 text-[12px] font-medium">{question}</div>}
      <div role={multi ? "group" : "radiogroup"} aria-label={question ?? "Choices"} className="flex flex-wrap gap-1.5">
        {options.map((o) => {
          const selected = done ? picked.includes(o.label) : draft.includes(o.label);
          return (
            <button
              key={o.label}
              type="button"
              role={multi ? "checkbox" : "radio"}
              aria-checked={selected}
              disabled={disabled}
              title={o.description}
              onClick={() =>
                multi
                  ? setDraft((d) => (d.includes(o.label) ? d.filter((x) => x !== o.label) : [...d, o.label]))
                  : submit([o.label], o.value)
              }
              className={cn(
                "inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-left text-[12px] transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:cursor-not-allowed",
                selected
                  ? "border-primary bg-primary/10 text-foreground"
                  : "bg-background hover:bg-muted disabled:opacity-50 disabled:hover:bg-background",
              )}
            >
              {selected && <IconCheck className="size-3 shrink-0 text-primary" />}
              <span>
                {o.label}
                {o.description && (
                  <span className="ml-1.5 text-[11px] text-muted-foreground">{o.description}</span>
                )}
              </span>
            </button>
          );
        })}
      </div>
      {multi && (
        <div className="mt-2 flex justify-end">
          <button
            type="button"
            disabled={disabled || !draft.length}
            onClick={() => submit(draft, draft.join(", "))}
            className="rounded-md bg-primary px-2.5 py-1 text-[11px] font-medium text-primary-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:opacity-50"
          >
            Send
          </button>
        </div>
      )}
    </div>
  );
}
