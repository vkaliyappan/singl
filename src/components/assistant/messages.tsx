"use client";

import { PinIcon } from "./pin-icon";
import { ImagePreview } from "./image-preview";
import { memo, useMemo, useState } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  IconAlertTriangle,
  IconCheck,
  IconChevronRight,
  IconBook2,
  IconBulb,
  IconCopy,
  IconLoader2,
  IconFolder,
  IconPaperclip,
  IconTool,
} from "@tabler/icons-react";
import { Badge } from "@/components/ui/badge";
import { effortLabel, ProviderIcon, shortModelName } from "./model-picker";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { Block, Message, Risk } from "@/lib/assistant/api";
import type { Approval, LiveCall } from "./use-assistant-chat";

const RESULT_LIMIT = 6000;

export function CopyButton({
  text,
  className,
}: {
  text: string;
  className?: string;
}) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      aria-label="Copy"
      title="Copy"
      className={cn(
        "flex size-5 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
        className,
      )}
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1200);
        });
      }}
    >
      {done ? (
        <IconCheck className="size-3" />
      ) : (
        <IconCopy className="size-3" />
      )}
    </button>
  );
}

function textOf(node: React.ReactNode): string {
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (node && typeof node === "object" && "props" in node)
    return textOf(
      (node as React.ReactElement<{ children?: React.ReactNode }>).props
        .children,
    );
  return "";
}

const markdownComponents: Components = {
  pre({ children }) {
    const code = textOf(children).replace(/\n$/, "");
    return (
      <div className="group/code relative my-2 overflow-hidden rounded-md border bg-muted/50">
        <CopyButton
          text={code}
          className="absolute top-1 right-1 bg-background/80 opacity-0 transition-opacity group-hover/code:opacity-100 focus-visible:opacity-100"
        />
        <pre className="selectable overflow-x-auto p-2.5 font-mono text-[11px] leading-relaxed">
          {children}
        </pre>
      </div>
    );
  },
  code({ className, children, ...rest }) {
    if (className?.startsWith("language-"))
      return (
        <code className={className} {...rest}>
          {children}
        </code>
      );
    return (
      <code
        className="rounded bg-muted px-1 py-0.5 font-mono text-[11px]"
        {...rest}
      >
        {children}
      </code>
    );
  },
  p: ({ children }) => (
    <p className="my-1.5 first:mt-0 last:mb-0">{children}</p>
  ),
  ul: ({ children }) => (
    <ul className="my-1.5 list-disc space-y-0.5 pl-4">{children}</ul>
  ),
  ol: ({ children }) => (
    <ol className="my-1.5 list-decimal space-y-0.5 pl-4">{children}</ol>
  ),
  h1: ({ children }) => (
    <h3 className="mt-3 mb-1 text-[13px] font-semibold">{children}</h3>
  ),
  h2: ({ children }) => (
    <h3 className="mt-3 mb-1 text-[13px] font-semibold">{children}</h3>
  ),
  h3: ({ children }) => (
    <h4 className="mt-2 mb-1 text-xs font-semibold">{children}</h4>
  ),
  a: ({ children, href }) => (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="text-primary underline underline-offset-2"
    >
      {children}
    </a>
  ),
  blockquote: ({ children }) => (
    <blockquote className="my-1.5 border-l-2 pl-2.5 text-muted-foreground">
      {children}
    </blockquote>
  ),
  table: ({ children }) => (
    <div className="my-2 overflow-x-auto">
      <table className="w-full border-collapse text-[11px]">{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th className="border bg-muted/50 px-2 py-1 text-left font-medium">
      {children}
    </th>
  ),
  td: ({ children }) => <td className="border px-2 py-1">{children}</td>,
};

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="selectable text-[13px]/relaxed break-words">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={markdownComponents}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});

export function RiskBadge({ risk }: { risk: Risk }) {
  const cls =
    risk === "destructive"
      ? "border-red-500/20 bg-red-500/10 text-red-600 dark:text-red-400"
      : risk === "write"
        ? "border-amber-500/20 bg-amber-500/10 text-amber-600 dark:text-amber-400"
        : "border-green-500/20 bg-green-500/10 text-green-600 dark:text-green-400";
  return (
    <Badge
      variant="secondary"
      className={cn("h-4 py-0 text-[9px] font-normal", cls)}
    >
      {risk}
    </Badge>
  );
}

function UserImages({ message }: { message: Message }) {
  const [big, setBig] = useState<{ src: string; name: string } | null>(null);
  const images = message.blocks.filter(
    (b): b is Extract<Block, { type: "image" }> => b.type === "image",
  );
  if (!images.length) return null;
  return (
    <div className="flex max-w-[85%] flex-wrap justify-end gap-1.5">
      {images.map((im, i) => {
        const src = `data:${im.media_type};base64,${im.data}`;
        return (
          <button
            key={`${im.name}-${i}`}
            type="button"
            title={im.name}
            aria-label={`View ${im.name}`}
            onClick={() => setBig({ src, name: im.name })}
            className="overflow-hidden rounded-lg border"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={src}
              alt={im.name}
              className="max-h-40 max-w-40 object-cover"
            />
          </button>
        );
      })}
      <ImagePreview image={big} onClose={() => setBig(null)} />
    </div>
  );
}

function UserChips({ message }: { message: Message }) {
  const files = message.blocks.filter(
    (b): b is Extract<Block, { type: "attachment" }> => b.type === "attachment",
  );
  const refs = message.blocks.filter(
    (b): b is Extract<Block, { type: "reference" }> => b.type === "reference",
  );
  const skills = message.skills ?? [];
  if (!files.length && !skills.length && !refs.length) return null;
  const chip =
    "flex max-w-48 items-center gap-1 rounded-full border bg-muted/60 px-2 py-0.5 text-[11px] text-muted-foreground";
  return (
    <div className="flex max-w-[85%] flex-wrap justify-end gap-1">
      {files.map((f, i) => (
        <span key={`${f.path}-${i}`} className={chip} title={f.path}>
          {f.directory ? (
            <IconFolder className="size-3 shrink-0" />
          ) : (
            <IconPaperclip className="size-3 shrink-0" />
          )}
          <span className="truncate">{f.name}</span>
        </span>
      ))}
      {refs.map((r, i) => (
        <span
          key={`${r.kind}-${r.label}-${i}`}
          className={chip}
          title={`${r.label}
${r.content.slice(0, 300)}`}
        >
          <PinIcon kind={r.kind} className="size-3 shrink-0" />
          <span className="truncate">{r.label}</span>
        </span>
      ))}
      {skills.map((s) => (
        <span key={s} className={chip} title={`Skill: ${s}`}>
          <IconBook2 className="size-3 shrink-0" />
          <span className="truncate">{s}</span>
        </span>
      ))}
    </div>
  );
}

function pretty(v: unknown) {
  try {
    return typeof v === "string" ? v : JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

function clip(s: string) {
  return s.length > RESULT_LIMIT
    ? `${s.slice(0, RESULT_LIMIT)}\n… (${s.length - RESULT_LIMIT} more characters)`
    : s;
}

/** The model's reasoning: open while it streams, folded once saved. */
function ThinkingBlock({ text, live }: { text: string; live?: boolean }) {
  const [open, setOpen] = useState<boolean | null>(null);
  const shown = open ?? !!live;
  return (
    <div className="my-1.5 text-xs">
      <button
        type="button"
        aria-expanded={shown}
        onClick={() => setOpen(!shown)}
        className="flex items-center gap-1.5 text-muted-foreground hover:text-foreground"
      >
        <IconChevronRight
          className={cn("size-3 shrink-0 transition-transform", shown && "rotate-90")}
        />
        {live ? (
          <IconLoader2 className="size-3.5 shrink-0 animate-spin" />
        ) : (
          <IconBulb className="size-3.5 shrink-0" />
        )}
        <span>{live ? "Thinking…" : "Thought"}</span>
      </button>
      {shown && (
        <div className="selectable mt-1 max-h-64 overflow-auto border-l-2 pl-2.5 text-[12px]/relaxed whitespace-pre-wrap text-muted-foreground">
          {text}
        </div>
      )}
    </div>
  );
}

/** Reasoning text a stored block carries, if it is one with any. */
function thinkingText(b: Block): string {
  if (b.type !== "opaque") return "";
  const d = b.data as { type?: unknown; thinking?: unknown } | null;
  return d?.type === "thinking" && typeof d.thinking === "string"
    ? d.thinking.trim()
    : "";
}

export function ToolCard({
  name,
  input,
  content,
  isError,
  running,
  source,
}: {
  name: string;
  input: unknown;
  content?: string;
  isError?: boolean;
  running?: boolean;
  source?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div
      className={cn(
        "my-1.5 rounded-md border bg-card text-xs",
        isError && "border-destructive/40",
      )}
    >
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-1.5 px-2 py-1.5 text-left"
      >
        <IconChevronRight
          className={cn(
            "size-3 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-90",
          )}
        />
        {running ? (
          <IconLoader2 className="size-3.5 shrink-0 animate-spin text-primary" />
        ) : isError ? (
          <IconAlertTriangle className="size-3.5 shrink-0 text-destructive" />
        ) : (
          <IconTool className="size-3.5 shrink-0 text-muted-foreground" />
        )}
        <span className="min-w-0 flex-1 truncate font-mono text-[11px]">
          {name}
        </span>
        {source && source !== "assistant" && (
          <span className="text-[10px] text-muted-foreground">{source}</span>
        )}
        {isError && (
          <span className="text-[10px] text-destructive">failed</span>
        )}
      </button>
      {open && (
        <div className="space-y-2 border-t px-2 py-2">
          <div>
            <p className="mb-0.5 text-[10px] font-medium text-muted-foreground">
              Input
            </p>
            <pre className="selectable max-h-48 overflow-auto rounded bg-muted/50 p-1.5 font-mono text-[10.5px]">
              {pretty(input)}
            </pre>
          </div>
          {content !== undefined && (
            <div>
              <p className="mb-0.5 text-[10px] font-medium text-muted-foreground">
                {isError ? "Error" : "Result"}
              </p>
              <pre className="selectable max-h-64 overflow-auto rounded bg-muted/50 p-1.5 font-mono text-[10.5px] whitespace-pre-wrap">
                {clip(content)}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function ApprovalCard({
  approval,
  onResolve,
  showAlways,
}: {
  approval: Approval;
  onResolve: (requestId: string, approved: boolean, always?: boolean) => void;
  showAlways: boolean;
}) {
  return (
    <div
      role="group"
      aria-label={`Approval needed for ${approval.tool}`}
      className="my-1.5 rounded-md border border-amber-500/40 bg-amber-500/5 p-2 text-xs"
    >
      <div className="mb-1.5 flex items-center gap-1.5">
        <IconAlertTriangle className="size-3.5 text-amber-600 dark:text-amber-400" />
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] font-medium">
          {approval.tool}
        </span>
        <RiskBadge risk={approval.risk} />
      </div>
      {approval.chatId === null && (
        <p className="mb-1 text-[10px] text-muted-foreground">
          Requested by an external client ({approval.source}).
        </p>
      )}
      <pre className="selectable mb-2 max-h-40 overflow-auto rounded bg-background/60 p-1.5 font-mono text-[10.5px]">
        {pretty(approval.input)}
      </pre>
      <div className="flex flex-wrap gap-1.5">
        <Button size="xs" onClick={() => onResolve(approval.requestId, true)}>
          Approve
        </Button>
        <Button
          size="xs"
          variant="outline"
          onClick={() => onResolve(approval.requestId, false)}
        >
          Deny
        </Button>
        {showAlways && approval.risk !== "destructive" && (
          <Button
            size="xs"
            variant="ghost"
            onClick={() => onResolve(approval.requestId, true, true)}
          >
            Always for this chat
          </Button>
        )}
      </div>
    </div>
  );
}

/** Who answered, under the answer: provider glyph + short model name. */
function ProviderLabel({
  provider,
  model,
  effort,
}: {
  provider?: string;
  model?: string;
  effort?: string;
}) {
  if (!provider && !model) return null;
  return (
    <p
      className="mt-1 flex items-center gap-1 text-[10.5px] text-muted-foreground/80"
      title={[provider, model].filter(Boolean).join(" · ")}
    >
      <ProviderIcon provider={provider} className="size-3" />
      {model ? shortModelName(model) : provider}
      {effort && (
        <span className="capitalize opacity-80">{effortLabel(effort)}</span>
      )}
    </p>
  );
}

function AssistantBlocks({
  blocks,
  results,
  running,
}: {
  blocks: Block[];
  results: Map<string, { content: string; isError: boolean }>;
  running: boolean;
}) {
  return (
    <>
      {blocks.map((b, i) => {
        if (b.type === "text")
          return b.text.trim() ? <Markdown key={i} text={b.text} /> : null;
        const thought = thinkingText(b);
        if (thought) return <ThinkingBlock key={i} text={thought} />;
        if (b.type === "tool_use") {
          const r = results.get(b.id);
          return (
            <ToolCard
              key={b.id}
              name={b.name}
              input={b.input}
              content={r?.content}
              isError={r?.isError}
              running={!r && running}
            />
          );
        }
        return null;
      })}
    </>
  );
}

export function MessageList({
  messages,
  streaming,
  thinking = "",
  running,
  runningProvider,
  liveCalls,
}: {
  messages: Message[];
  streaming: string;
  /** Reasoning streamed for the reply being written. */
  thinking?: string;
  running: boolean;
  runningProvider: { provider: string; model: string; effort?: string } | null;
  liveCalls: Record<string, LiveCall>;
}) {
  const { visible, results, savedToolIds } = useMemo(() => {
    const results = new Map<string, { content: string; isError: boolean }>();
    const ids = new Set<string>();
    const visible: Message[] = [];
    for (const m of messages) {
      const onlyResults =
        m.role === "user" &&
        m.blocks.length > 0 &&
        m.blocks.every((b) => b.type === "tool_result");
      if (onlyResults) {
        for (const b of m.blocks)
          if (b.type === "tool_result")
            results.set(b.tool_use_id, {
              content: b.content,
              isError: !!b.is_error,
            });
        continue;
      }
      for (const b of m.blocks) if (b.type === "tool_use") ids.add(b.id);
      visible.push(m);
    }
    return { visible, results, savedToolIds: ids };
  }, [messages]);

  const pending = Object.values(liveCalls).filter(
    (c) => !savedToolIds.has(c.callId),
  );
  // A saved tool_use whose result has not been saved yet may have a live result.
  const merged = useMemo(() => {
    const m = new Map(results);
    for (const c of Object.values(liveCalls))
      if (c.done && !m.has(c.callId))
        m.set(c.callId, { content: c.content ?? "", isError: !!c.isError });
    return m;
  }, [results, liveCalls]);

  return (
    <div className="flex flex-col gap-5">
      {visible.map((m, i) =>
        m.role === "user" ? (
          <div key={m.id} className="flex flex-col items-end gap-1">
            <UserImages message={m} />
            <UserChips message={m} />
            {m.blocks.some((b) => b.type === "text" && b.text) && (
              <div className="selectable max-w-[85%] rounded-2xl rounded-br-md border bg-muted/60 px-3.5 py-2 text-[13px]/relaxed whitespace-pre-wrap">
                {m.blocks
                  .map((b) => (b.type === "text" ? b.text : ""))
                  .join("\n")}
              </div>
            )}
          </div>
        ) : (
          <div key={m.id} className="min-w-0">
            <AssistantBlocks
              blocks={m.blocks}
              results={merged}
              running={running}
            />
            {/* One label per answer: under the last assistant message before the next user message. */}
            {visible[i + 1]?.role !== "assistant" &&
              !(running && i === visible.length - 1) && (
                <ProviderLabel
                  provider={m.provider}
                  model={m.model}
                  effort={m.effort}
                />
              )}
          </div>
        ),
      )}
      {(streaming || pending.length > 0 || running) && (
        <div className="min-w-0">
          {thinking.trim() && (
            <ThinkingBlock text={thinking.trim()} live={running && !streaming} />
          )}
          {streaming && <Markdown text={streaming} />}
          {pending.map((c) => (
            <ToolCard
              key={c.callId}
              name={c.name}
              input={c.input}
              content={c.content}
              isError={c.isError}
              running={!c.done}
              source={c.source}
            />
          ))}
          {running && !streaming && !thinking.trim() && pending.every((c) => c.done) && (
            <div
              className="flex items-center gap-1.5 text-[11px] text-muted-foreground"
              role="status"
            >
              <IconLoader2 className="size-3 animate-spin" /> Working…
            </div>
          )}
          <ProviderLabel
            provider={runningProvider?.provider}
            model={runningProvider?.model}
            effort={runningProvider?.effort}
          />
        </div>
      )}
    </div>
  );
}
