"use client";

// MCP resources and prompts in the composer: `@` also lists resources of the
// connected servers (picking one attaches its text as a pinned chip) and `/`
// also lists their prompts (`/server:prompt`; picking one asks for its
// arguments and puts the text it expands to into the box).

import { useCallback, useEffect, useRef, useState } from "react";
import type { Editor } from "@tiptap/react";
import { IconPlugConnected, IconMessage2 } from "@tabler/icons-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { addPins } from "@/lib/assistant/pins";
import { isTauri } from "@/lib/clock-widget";
import { errorMessage } from "@/lib/settings";
import {
  expandTemplate,
  mcpPromptGet,
  mcpPrompts,
  mcpResourceRead,
  mcpResources,
  templateVars,
  type McpPrompt,
  type McpResource,
} from "./mcp-api";

/** Lists are fetched again once they are this old (servers start lazily and change). */
const FRESH_MS = 30_000;

type Lists = {
  at: number;
  resources: McpResource[];
  templates: McpResource[];
  prompts: McpPrompt[];
};

/** An argument form the user fills before a prompt or resource template is used. */
export type ArgsForm = {
  title: string;
  fields: { name: string; description?: string | null; required: boolean }[];
  submit: (values: Record<string, string>) => void;
};

/** `server › name`, the chip label of an attached resource. */
export const resourceLabel = (r: McpResource) =>
  `${r.server} › ${r.title ?? r.name}`;

export function useMcpComposer(
  editor: Editor | null,
  want: { resources: boolean; prompts: boolean },
) {
  const [lists, setLists] = useState<Lists | null>(null);
  const [form, setForm] = useState<ArgsForm | null>(null);
  const loading = useRef(false);
  const needed = want.resources || want.prompts;

  useEffect(() => {
    if (!needed || !isTauri() || loading.current) return;
    if (lists && Date.now() - lists.at < FRESH_MS) return;
    loading.current = true;
    Promise.all([
      mcpResources().catch(() => [] as McpResource[]),
      mcpResources(true).catch(() => [] as McpResource[]),
      mcpPrompts().catch(() => [] as McpPrompt[]),
    ])
      .then(([resources, templates, prompts]) =>
        setLists({ at: Date.now(), resources, templates, prompts }),
      )
      .finally(() => {
        loading.current = false;
      });
  }, [needed, lists]);

  /** Reads a resource and pins its text to the next message. */
  const attach = useCallback(async (r: McpResource, uri = r.uri) => {
    try {
      const got = await mcpResourceRead(r.server, uri);
      addPins([
        {
          kind: "mcp-resource",
          label: resourceLabel(r),
          detail: uri,
          content: `URI: ${uri}${got.mimeType ? ` (${got.mimeType})` : ""}\n\n${got.text}`,
        },
      ]);
    } catch (e) {
      toast.error(errorMessage(e));
    }
  }, []);

  /** A resource picked in the list: templates ask for their variables first. */
  const pickResource = useCallback(
    (r: McpResource) => {
      if (!r.template) return void attach(r);
      setForm({
        title: resourceLabel(r),
        fields: templateVars(r.uri).map((name) => ({
          name,
          required: false,
        })),
        submit: (values) => void attach(r, expandTemplate(r.uri, values)),
      });
    },
    [attach],
  );

  /** A prompt picked in the list: asks for its arguments, then inserts its text. */
  const pickPrompt = useCallback(
    (p: McpPrompt) => {
      const run = async (values: Record<string, string>) => {
        try {
          const args = Object.fromEntries(
            Object.entries(values).filter(([, v]) => v !== ""),
          );
          const got = await mcpPromptGet(p.server, p.name, args);
          const text = got.messages
            .map((m) => m.text)
            .filter(Boolean)
            .join("\n\n");
          if (!text) return void toast.info("The prompt returned no text.");
          editor
            ?.chain()
            .focus()
            .insertContent(text, { contentType: "markdown" })
            .run();
        } catch (e) {
          toast.error(errorMessage(e));
        }
      };
      if (!p.arguments.length) return void run({});
      setForm({
        title: `/${p.server}:${p.name}`,
        fields: p.arguments,
        submit: run,
      });
    },
    [editor],
  );

  return {
    resources: lists?.resources ?? [],
    templates: lists?.templates ?? [],
    prompts: lists?.prompts ?? [],
    loaded: lists !== null,
    form,
    closeForm: () => setForm(null),
    pickResource,
    pickPrompt,
  };
}

export type McpComposer = ReturnType<typeof useMcpComposer>;

export const McpResourceIcon = () => (
  <IconPlugConnected className="size-3.5 text-primary" />
);
export const McpPromptIcon = () => (
  <IconMessage2 className="size-3.5 text-primary" />
);

/** The argument form, anchored above the composer card like the mention list. */
export function McpArgsForm({
  form,
  onClose,
}: {
  form: ArgsForm | null;
  onClose: () => void;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const first = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!form) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- a new form starts empty
    setValues({});
    first.current?.focus();
  }, [form]);

  if (!form) return null;
  const missing = form.fields.some((f) => f.required && !values[f.name]?.trim());
  const submit = () => {
    if (missing) return;
    form.submit(Object.fromEntries(
      form.fields.map((f) => [f.name, (values[f.name] ?? "").trim()]),
    ));
    onClose();
  };

  return (
    <div
      role="dialog"
      aria-label={form.title}
      className="absolute inset-x-0 bottom-full z-30 mb-1.5 max-h-72 overflow-y-auto rounded-xl border bg-popover p-3 text-popover-foreground shadow-md"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <p className="mb-2 font-mono text-[11px] font-medium">{form.title}</p>
      <div className="flex flex-col gap-2">
        {form.fields.map((f, i) => (
          <div key={f.name} className="flex flex-col gap-1">
            <Label htmlFor={`mcp-arg-${f.name}`} className="text-[11px]">
              {f.name}
              {f.required && <span className="text-destructive"> *</span>}
            </Label>
            <Input
              id={`mcp-arg-${f.name}`}
              ref={i === 0 ? first : undefined}
              className="h-7 text-xs"
              value={values[f.name] ?? ""}
              onChange={(e) =>
                setValues((v) => ({ ...v, [f.name]: e.target.value }))
              }
              onKeyDown={(e) => e.key === "Enter" && submit()}
            />
            {f.description && (
              <p className="text-[10px] text-muted-foreground">
                {f.description}
              </p>
            )}
          </div>
        ))}
      </div>
      <div className="mt-2.5 flex gap-1.5">
        <Button size="xs" disabled={missing} onClick={submit}>
          Use
        </Button>
        <Button size="xs" variant="ghost" onClick={onClose}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
