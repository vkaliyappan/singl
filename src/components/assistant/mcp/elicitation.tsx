"use client";

// An MCP server asked the user for input (`elicitation/create`): a form drawn
// from its JSON schema, shown in the chat like an approval card. The store
// listens to the assistant event stream itself, so the chat hook stays as it is.

import { useEffect, useState, useSyncExternalStore } from "react";
import { IconForms } from "@tabler/icons-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import { setAssistantOpen } from "@/components/assistant/dock";
import { onAssistantEvent } from "@/lib/assistant/api";
import { isTauri } from "@/lib/clock-widget";
import { errorMessage } from "@/lib/settings";
import { mcpElicitReply, type ElicitAction } from "./mcp-api";

export type ElicitRequest = {
  requestId: string;
  chatId: string | null;
  server: string;
  message: string;
  schema: unknown;
};

// ---- store ----

const NONE: ElicitRequest[] = [];
let requests = NONE;
const listeners = new Set<() => void>();
let listening = false;

function publish(next: ElicitRequest[]) {
  requests = next.length ? next : NONE;
  listeners.forEach((l) => l());
}

function listen() {
  if (listening || !isTauri()) return;
  listening = true;
  onAssistantEvent((e) => {
    if (e.type === "elicitationRequest") {
      if (requests.some((r) => r.requestId === e.requestId)) return;
      publish([
        ...requests,
        {
          requestId: e.requestId,
          chatId: e.chatId,
          server: e.server,
          message: e.message,
          schema: e.schema,
        },
      ]);
      setAssistantOpen(true);
      toast(`${e.server} needs your input`, {
        id: e.requestId,
        description: e.message || "Answer in the assistant panel.",
        duration: Infinity,
      });
    } else if (e.type === "elicitationResolved") {
      publish(requests.filter((r) => r.requestId !== e.requestId));
      toast.dismiss(e.requestId);
    }
  }).catch(() => {
    listening = false;
  });
}

function useElicitations(): ElicitRequest[] {
  useEffect(listen, []);
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => {
        listeners.delete(l);
      };
    },
    () => requests,
    () => NONE,
  );
}

// ---- schema ----

type Option = { value: string; label: string };
export type Field = {
  key: string;
  kind: "string" | "number" | "integer" | "boolean" | "enum";
  title: string;
  description: string;
  required: boolean;
  options: Option[];
  initial: string | boolean;
  format?: string;
  min?: number;
  max?: number;
};

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** The fields a requested schema asks for (the spec allows flat primitives only). */
export function fieldsOf(schema: unknown): Field[] {
  if (!isObject(schema) || !isObject(schema.properties)) return [];
  const required = Array.isArray(schema.required)
    ? schema.required.filter((r): r is string => typeof r === "string")
    : [];
  const fields: Field[] = [];
  for (const [key, raw] of Object.entries(schema.properties)) {
    if (!isObject(raw)) continue;
    const str = (v: unknown) => (typeof v === "string" ? v : "");
    const base = {
      key,
      title: str(raw.title) || key,
      description: str(raw.description),
      required: required.includes(key),
    };
    const type = str(raw.type);
    if (Array.isArray(raw.enum)) {
      const names = Array.isArray(raw.enumNames) ? raw.enumNames : [];
      const options = raw.enum.map((v, i) => ({
        value: String(v),
        label: typeof names[i] === "string" ? names[i] : String(v),
      }));
      fields.push({
        ...base,
        kind: "enum",
        options,
        initial: raw.default !== undefined ? String(raw.default) : "",
      });
    } else if (type === "boolean") {
      fields.push({
        ...base,
        kind: "boolean",
        options: [],
        initial: raw.default === true,
      });
    } else if (type === "number" || type === "integer") {
      fields.push({
        ...base,
        kind: type,
        options: [],
        initial: raw.default !== undefined ? String(raw.default) : "",
        min: typeof raw.minimum === "number" ? raw.minimum : undefined,
        max: typeof raw.maximum === "number" ? raw.maximum : undefined,
      });
    } else {
      fields.push({
        ...base,
        kind: "string",
        options: [],
        initial: raw.default !== undefined ? String(raw.default) : "",
        format: str(raw.format) || undefined,
        min: typeof raw.minLength === "number" ? raw.minLength : undefined,
        max: typeof raw.maxLength === "number" ? raw.maxLength : undefined,
      });
    }
  }
  return fields;
}

/** The value to send for a field, or an error to show next to it. */
export function readField(
  f: Field,
  value: string | boolean | undefined,
): { value?: string | number | boolean; error?: string } {
  if (f.kind === "boolean") return { value: value === true };
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return f.required ? { error: "Required" } : {};
  if (f.kind === "number" || f.kind === "integer") {
    const n = Number(text);
    if (!Number.isFinite(n)) return { error: "Enter a number" };
    if (f.kind === "integer" && !Number.isInteger(n))
      return { error: "Enter a whole number" };
    if (f.min !== undefined && n < f.min) return { error: `At least ${f.min}` };
    if (f.max !== undefined && n > f.max) return { error: `At most ${f.max}` };
    return { value: n };
  }
  if (f.kind === "string") {
    if (f.min !== undefined && text.length < f.min)
      return { error: `At least ${f.min} characters` };
    if (f.max !== undefined && text.length > f.max)
      return { error: `At most ${f.max} characters` };
    if (f.format === "email" && !/^[^\s@]+@[^\s@]+$/.test(text))
      return { error: "Enter an email address" };
    if (f.format === "uri" && !/^[a-z][a-z0-9+.-]*:/i.test(text))
      return { error: "Enter a URL" };
  }
  return { value: text };
}

// ---- UI ----

function ElicitationCard({ request }: { request: ElicitRequest }) {
  const fields = fieldsOf(request.schema);
  const [values, setValues] = useState<Record<string, string | boolean>>(() =>
    Object.fromEntries(fields.map((f) => [f.key, f.initial])),
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  const answer = async (
    action: ElicitAction,
    content?: Record<string, unknown>,
  ) => {
    setBusy(true);
    try {
      await mcpElicitReply(request.requestId, action, content);
    } catch (e) {
      toast.error(errorMessage(e));
      setBusy(false);
      return;
    }
    publish(requests.filter((r) => r.requestId !== request.requestId));
    toast.dismiss(request.requestId);
  };

  const accept = () => {
    const content: Record<string, unknown> = {};
    const found: Record<string, string> = {};
    for (const f of fields) {
      const r = readField(f, values[f.key]);
      if (r.error) found[f.key] = r.error;
      else if (r.value !== undefined) content[f.key] = r.value;
    }
    setErrors(found);
    if (Object.keys(found).length === 0) void answer("accept", content);
  };

  const set = (key: string, v: string | boolean) =>
    setValues((x) => ({ ...x, [key]: v }));
  const id = (key: string) => `elicit-${request.requestId}-${key}`;

  return (
    <div
      role="group"
      aria-label={`${request.server} asks for input`}
      className="my-1.5 rounded-md border border-primary/30 bg-primary/5 p-2 text-xs"
    >
      <div className="mb-1.5 flex items-center gap-1.5">
        <IconForms className="size-3.5 text-primary" />
        <span className="min-w-0 flex-1 truncate text-[11px] font-medium">
          {request.server} asks for input
        </span>
      </div>
      {request.message && (
        <p className="mb-2 break-words whitespace-pre-wrap">{request.message}</p>
      )}
      <div className="mb-2 flex flex-col gap-2">
        {fields.map((f) => (
          <div key={f.key} className="flex flex-col gap-1">
            {f.kind === "boolean" ? (
              <label className="flex items-center gap-2">
                <Switch
                  checked={values[f.key] === true}
                  onCheckedChange={(c) => set(f.key, c)}
                  aria-label={f.title}
                />
                {f.title}
              </label>
            ) : (
              <Label htmlFor={id(f.key)} className="text-[11px]">
                {f.title}
                {f.required && <span className="text-destructive"> *</span>}
              </Label>
            )}
            {f.kind === "enum" ? (
              <NativeSelect
                id={id(f.key)}
                className="w-full"
                value={String(values[f.key] ?? "")}
                onChange={(e) => set(f.key, e.target.value)}
              >
                <NativeSelectOption value="">Choose…</NativeSelectOption>
                {f.options.map((o) => (
                  <NativeSelectOption key={o.value} value={o.value}>
                    {o.label}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            ) : f.kind !== "boolean" ? (
              <Input
                id={id(f.key)}
                className="h-7 text-xs"
                type={
                  f.kind === "string"
                    ? f.format === "email"
                      ? "email"
                      : "text"
                    : "number"
                }
                value={String(values[f.key] ?? "")}
                onChange={(e) => set(f.key, e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && accept()}
              />
            ) : null}
            {f.description && (
              <p className="text-[10px] text-muted-foreground">
                {f.description}
              </p>
            )}
            {errors[f.key] && (
              <p role="alert" className="text-[10px] text-destructive">
                {errors[f.key]}
              </p>
            )}
          </div>
        ))}
      </div>
      <div className="flex flex-wrap gap-1.5">
        <Button size="xs" disabled={busy} onClick={accept}>
          Accept
        </Button>
        <Button
          size="xs"
          variant="outline"
          disabled={busy}
          onClick={() => void answer("decline")}
        >
          Decline
        </Button>
        <Button
          size="xs"
          variant="ghost"
          disabled={busy}
          onClick={() => void answer("cancel")}
        >
          Cancel
        </Button>
      </div>
    </div>
  );
}

/** The open forms that belong to this chat (or to no chat in particular). */
export function ElicitationCards({ chatId }: { chatId: string | null }) {
  const all = useElicitations();
  return (
    <>
      {all
        .filter((r) => r.chatId === null || r.chatId === chatId)
        .map((r) => (
          <ElicitationCard key={r.requestId} request={r} />
        ))}
    </>
  );
}
