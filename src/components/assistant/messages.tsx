"use client";

import { PinIcon } from "./pin-icon";
import { ImagePreview } from "./image-preview";
import { createContext, memo, use, useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import rehypeHighlight from "rehype-highlight";
import "katex/dist/katex.min.css";
import { Callout, remarkCallouts } from "./rich/callouts";
import { ChoiceContext, ChoicesBlock } from "./rich/choices";
import { EntityChip, urlTransform } from "./rich/entity-chip";
import { PatchView } from "./rich/diff-view";
import { StepsBlock, StepTracker, toolSteps } from "./rich/steps";
import { ApprovalPreview } from "./rich/approval-preview";
import { PropsBlock } from "./rich/tool-views/property-panel";
import { ToolResultView } from "./rich/tool-views";
import {
  IconAlertTriangle,
  IconCheck,
  IconChevronRight,
  IconBook2,
  IconBulb,
  IconCopy,
  IconLoader2,
  IconFolder,
  IconHierarchy2,
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

// Heavy renderers load on first use, so chats without them stay light.
const richFallback = () => (
  <div className="my-2 h-24 animate-pulse rounded-md border bg-muted/40" />
);
const MermaidBlock = dynamic(
  () => import("./rich/mermaid-block").then((m) => m.MermaidBlock),
  { ssr: false, loading: richFallback },
);
const ChartBlock = dynamic(
  () => import("./rich/chart-block").then((m) => m.ChartBlock),
  { ssr: false, loading: richFallback },
);
const TilesBlock = dynamic(
  () => import("./rich/tiles-block").then((m) => m.TilesBlock),
  { ssr: false, loading: richFallback },
);

/** Fenced languages drawn as visuals instead of highlighted code. */
const RICH_FENCES = [
  "mermaid",
  "chart",
  "tiles",
  "kpi",
  "choices",
  "steps",
  "props",
  "diff",
];

/** The language of a fenced block: `language-xyz` on its <code> child. */
function fenceLang(children: React.ReactNode): string {
  const child = Array.isArray(children) ? children[0] : children;
  const cls =
    child && typeof child === "object" && "props" in child
      ? (child as React.ReactElement<{ className?: string }>).props.className
      : undefined;
  return /language-([\w-]+)/.exec(cls ?? "")?.[1]?.toLowerCase() ?? "";
}

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

/**
 * Inline code naming an exported entity script or XML, optionally with a line
 * (`SyncEndItems.js:37`, `…/Things/X.xml:12-20`): a link that opens it in TWX
 * Entities there. Only the file name is sent; the page finds it in the
 * environment shown last.
 */
function entityFileRef(text: string): { href: string; name: string; line?: number } | null {
  const m = /^(?:[\w .\-]+[\\/])*([\w.\-]+\.(?:js|xml))(?::(\d+)(?:[-–]\d+)?)?$/i.exec(text.trim());
  if (!m) return null;
  const [, name, line] = m;
  const q = new URLSearchParams({ file: name });
  if (line) q.set("line", line);
  return { href: `/twx-entities?${q}`, name, line: line ? Number(line) : undefined };
}

const markdownComponents: Components = {
  pre({ children }) {
    const code = textOf(children).replace(/\n$/, "");
    const lang = fenceLang(children);
    if (lang === "mermaid") return <MermaidBlock source={code} />;
    if (lang === "chart") return <ChartBlock source={code} />;
    if (lang === "tiles" || lang === "kpi") return <TilesBlock source={code} />;
    if (lang === "choices") return <ChoicesBlock source={code} />;
    if (lang === "steps") return <StepsBlock source={code} />;
    if (lang === "props") return <PropsBlock source={code} />;
    if (lang === "diff" || lang === "patch") return <PatchView source={code} />;
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
    if (className?.includes("language-"))
      return (
        <code className={className} {...rest}>
          {children}
        </code>
      );
    const code = (
      <code
        className="rounded bg-muted px-1 py-0.5 font-mono text-[11px]"
        {...rest}
      >
        {children}
      </code>
    );
    const ref = typeof children === "string" ? entityFileRef(children) : null;
    return ref ? (
      <Link
        href={ref.href}
        title={`Open ${ref.name}${ref.line ? ` at line ${ref.line}` : ""} in TWX Entities`}
        className="rounded underline decoration-primary/40 underline-offset-2 hover:decoration-primary [&>code]:text-primary"
      >
        {code}
      </Link>
    ) : (
      code
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
  h4: ({ children }) => (
    <h5 className="mt-2 mb-1 text-xs font-medium">{children}</h5>
  ),
  h5: ({ children }) => (
    <h6 className="mt-2 mb-1 text-xs font-medium text-muted-foreground">
      {children}
    </h6>
  ),
  h6: ({ children }) => (
    <h6 className="mt-2 mb-1 text-[11px] font-medium text-muted-foreground uppercase">
      {children}
    </h6>
  ),
  hr: () => <hr className="my-3 border-border" />,
  img: ({ src, alt }) =>
    typeof src === "string" ? (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={src}
        alt={alt ?? ""}
        className="my-2 max-h-80 max-w-full rounded-md border"
      />
    ) : null,
  input: ({ type, checked }) =>
    type === "checkbox" ? (
      <input
        type="checkbox"
        checked={!!checked}
        readOnly
        className="mr-1.5 size-3 translate-y-px accent-primary"
      />
    ) : null,
  aside: ({ children, ...rest }) => {
    const props = rest as Record<string, unknown>;
    const type = props["data-callout"];
    if (typeof type !== "string") return <aside>{children}</aside>;
    const title = props["data-title"];
    return (
      <Callout
        type={type}
        title={typeof title === "string" && title ? title : undefined}
      >
        {children}
      </Callout>
    );
  },
  a: ({ children, href }) =>
    href?.startsWith("mention:") ? (
      <span className={MENTION_BADGE}>{children}</span>
    ) : href?.startsWith("twx:") ? (
      <EntityChip href={href}>{children}</EntityChip>
    ) : (
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
  table: ({ children }) => <MdTable>{children}</MdTable>,
  tr: ({ children }) => (
    <tr className="even:bg-muted/25 hover:bg-muted/40">{children}</tr>
  ),
  th: ({ children, style }) => (
    <th
      style={style}
      className="border-b bg-muted/60 px-2 py-1 text-left font-medium whitespace-nowrap"
    >
      {children}
    </th>
  ),
  td: ({ children, style }) => (
    <td style={style} className="border-t px-2 py-1 align-top tabular-nums">
      {children}
    </td>
  ),
};

/** A table in a scroll box, with a hover button to copy it as TSV (pastes into Excel). */
function MdTable({ children }: { children: React.ReactNode }) {
  const [el, setEl] = useState<HTMLTableElement | null>(null);
  return (
    <div className="group/table relative my-2 overflow-hidden rounded-md border">
      <div className="max-h-[28rem] overflow-auto">
        <table ref={setEl} className="w-full border-collapse text-[11px]">
          {children}
        </table>
      </div>
      {el && <TableCopy table={el} />}
    </div>
  );
}

function TableCopy({ table }: { table: HTMLTableElement }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      aria-label="Copy table"
      title="Copy table (TSV)"
      className="absolute top-1 right-1 flex size-5 items-center justify-center rounded bg-background/80 text-muted-foreground opacity-0 transition-opacity group-hover/table:opacity-100 hover:text-foreground focus-visible:opacity-100"
      onClick={() => {
        const tsv = Array.from(table.rows)
          .map((r) =>
            Array.from(r.cells)
              .map((c) => c.innerText.replace(/\s+/g, " ").trim())
              .join("\t"),
          )
          .join("\n");
        void navigator.clipboard.writeText(tsv).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1200);
        });
      }}
    >
      {done ? <IconCheck className="size-3" /> : <IconCopy className="size-3" />}
    </button>
  );
}

type MdProps = React.ComponentProps<typeof ReactMarkdown>;
const remarkPlugins: MdProps["remarkPlugins"] = [
  remarkGfm,
  // `$5 and $10` is money here, not math: inline math needs $$…$$.
  [remarkMath, { singleDollarTextMath: false }],
  remarkCallouts,
];
const rehypePlugins: MdProps["rehypePlugins"] = [
  [rehypeKatex, { throwOnError: false, strict: "ignore" }],
  [rehypeHighlight, { plainText: RICH_FENCES }],
];

export const Markdown = memo(function Markdown({
  text,
  className,
}: {
  text: string;
  className?: string;
}) {
  return (
    <div className={cn("md-rich selectable text-[13px]/relaxed break-words", className)}>
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        rehypePlugins={rehypePlugins}
        components={markdownComponents}
        urlTransform={urlTransform}
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

/** Same look as the composer's @name badge (composer-editor.tsx). */
const MENTION_BADGE =
  "mx-px inline-block rounded-md bg-primary/10 px-1.5 font-medium whitespace-nowrap text-primary";

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * A user message's text with each `@name` of something it carried (attached
 * file or folder, dropped file, pinned item) turned into a `mention:` link,
 * which the markdown renders as a badge. Code spans and fences are left alone.
 */
function withMentions(text: string, message: Message): string {
  if (!text.includes("@")) return text;
  const names = message.blocks
    .flatMap((b) =>
      b.type === "attachment" ? [b.name] : b.type === "reference" ? [b.label] : [],
    )
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  if (!names.length) return text;
  const re = new RegExp(
    `(^|[\\s(\\[])@(${names.map(escapeRe).join("|")})(?=$|[\\s,;:!?)\\]]|\\.(?:\\s|$))`,
    "g",
  );
  const link = (_: string, pre: string, name: string) =>
    `${pre}[@${name.replace(/[[\]\\]/g, "\\$&")}](mention:${encodeURIComponent(name)})`;
  // Odd parts are code (fenced or inline); only the text between gets badges.
  return text
    .split(/(```[\s\S]*?```|`[^`\n]*`)/g)
    .map((part, i) => (i % 2 ? part : part.replace(re, link)))
    .join("");
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
        <div className="mt-1 max-h-64 overflow-auto border-l-2 pl-2.5 text-muted-foreground">
          <Markdown text={text} className="text-[12px]/relaxed" />
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

/** Sub-agent tool calls carry this source plus the `agent_task` call id (subagents.rs). */
const SUB_AGENT_SOURCE = "sub-agent:";
const SUB_AGENT_TOOL = "agent_task";
/** Live tool calls of running sub-agents, by the `agent_task` call that started them. */
const SubAgentCalls = createContext<Map<string, LiveCall[]>>(new Map());

/** The parent call id of a sub-agent's tool call, or null for the turn's own. */
function subAgentParent(source: string | undefined) {
  return source?.startsWith(SUB_AGENT_SOURCE) ? source.slice(SUB_AGENT_SOURCE.length) : null;
}

/** One sub-agent: what it was asked, on which model, what it is doing, then its answer. */
function SubAgentCard({
  callId,
  input,
  content,
  isError,
  running,
}: {
  callId?: string;
  input: unknown;
  content?: string;
  isError?: boolean;
  running?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const children = use(SubAgentCalls).get(callId ?? "") ?? [];
  const inp = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const description = typeof inp.description === "string" && inp.description ? inp.description : "Sub-agent";
  const prompt = typeof inp.prompt === "string" ? inp.prompt : "";
  const model = typeof inp.model === "string" ? inp.model : "";
  const recent = children.slice(-6);
  return (
    <div
      className={cn(
        "my-1.5 rounded-md border border-violet-500/30 bg-violet-500/[0.03] text-xs",
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
          className={cn("size-3 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")}
        />
        {running ? (
          <IconLoader2 className="size-3.5 shrink-0 animate-spin text-violet-600 dark:text-violet-400" />
        ) : isError ? (
          <IconAlertTriangle className="size-3.5 shrink-0 text-destructive" />
        ) : (
          <IconHierarchy2 className="size-3.5 shrink-0 text-violet-600 dark:text-violet-400" />
        )}
        <span className="min-w-0 flex-1 truncate text-[12px] font-medium">{description}</span>
        {model && (
          <span className="shrink-0 rounded-full border px-1.5 py-px text-[10px] text-muted-foreground" title={model}>
            {shortModelName(model)}
          </span>
        )}
        {running && children.length > 0 && (
          <span className="shrink-0 text-[10px] text-muted-foreground tabular-nums">
            {children.length} tool call{children.length > 1 ? "s" : ""}
          </span>
        )}
        {isError && <span className="text-[10px] text-destructive">failed</span>}
      </button>
      {running && recent.length > 0 && (
        <ul className="space-y-0.5 border-t px-2 py-1.5" aria-label="What the sub-agent is doing">
          {recent.map((c) => (
            <li key={c.callId} className="flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
              {c.done ? (
                c.isError ? (
                  <IconAlertTriangle className="size-3 shrink-0 text-destructive" />
                ) : (
                  <IconCheck className="size-3 shrink-0" />
                )
              ) : (
                <IconLoader2 className="size-3 shrink-0 animate-spin" />
              )}
              <span className="truncate font-mono">{c.name}</span>
            </li>
          ))}
        </ul>
      )}
      {content && !running && (
        <div className="max-h-80 overflow-auto border-t px-2.5 py-2">
          {isError ? (
            <p className="text-[11.5px] text-destructive">{content}</p>
          ) : (
            <Markdown text={content} className="text-[12px]/relaxed" />
          )}
        </div>
      )}
      {open && prompt && (
        <div className="border-t px-2 py-2">
          <p className="mb-0.5 text-[10px] font-medium text-muted-foreground">Task</p>
          <pre className="selectable max-h-48 overflow-auto rounded bg-muted/50 p-1.5 font-mono text-[10.5px] whitespace-pre-wrap">
            {prompt}
          </pre>
        </div>
      )}
    </div>
  );
}

export function ToolCard({
  name,
  input,
  content,
  isError,
  running,
  source,
  callId,
}: {
  name: string;
  input: unknown;
  content?: string;
  isError?: boolean;
  running?: boolean;
  source?: string;
  /** Lets a sub-agent card find its live tool calls. */
  callId?: string;
}) {
  const [open, setOpen] = useState(false);
  if (name === SUB_AGENT_TOOL)
    return <SubAgentCard callId={callId} input={input} content={content} isError={isError} running={running} />;
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
      {/* A readable view of the result (InfoTable, properties, …); raw JSON stays one click away. */}
      {content && !isError && !running && (
        <div className="border-t px-2 py-2 empty:hidden">
          <ToolResultView name={name} input={input} content={content} />
        </div>
      )}
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
        {approval.scope === "server" && (
          <span
            className="rounded-full border px-1.5 py-px text-[10px] text-muted-foreground"
            title="Follows the ThingWorx server approval mode"
          >
            ThingWorx server
          </span>
        )}
        <RiskBadge risk={approval.risk} />
      </div>
      {approval.chatId === null && (
        <p className="mb-1 text-[10px] text-muted-foreground">
          Requested by an external client ({approval.source}).
        </p>
      )}
      <div className="mb-2">
        <ApprovalPreview tool={approval.tool} input={approval.input} />
      </div>
      <details className="mb-2">
        <summary className="cursor-pointer text-[10px] text-muted-foreground">
          Raw input
        </summary>
        <pre className="selectable mt-1 max-h-40 overflow-auto rounded bg-background/60 p-1.5 font-mono text-[10.5px]">
          {pretty(approval.input)}
        </pre>
      </details>
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

type Call = { id: string; name: string; input: unknown; source?: string };
type Results = Map<string, { content: string; isError: boolean }>;
/** Runs of deploy steps: first call id → the run, and the ids shown inside a run. */
type Runs = { first: Map<string, Call[]>; inside: Set<string> };

const isDeploy = (name: string) => name.startsWith("deploy_");

/** Group consecutive deploy calls (no user message between them) into runs of two or more. */
function deployRuns(calls: (Call | null)[]): Runs {
  const first = new Map<string, Call[]>();
  const inside = new Set<string>();
  let run: Call[] = [];
  const flush = () => {
    if (run.length >= 2) {
      first.set(run[0].id, run);
      for (const c of run.slice(1)) inside.add(c.id);
    }
    run = [];
  };
  for (const c of calls) {
    if (c && isDeploy(c.name)) run.push(c);
    else flush();
  }
  flush();
  return { first, inside };
}

/** A deploy run as one step tracker; each step's raw call stays expandable below. */
function DeployRun({
  calls,
  results,
  running,
}: {
  calls: Call[];
  results: Results;
  running: boolean;
}) {
  const items = calls.map((c) => {
    const r = results.get(c.id);
    return {
      ...c,
      content: r?.content,
      isError: r?.isError,
      running: !r && running,
    };
  });
  return (
    <div className="my-1.5">
      <StepTracker title="Deployment" steps={toolSteps(items)} />
      <details className="mt-1">
        <summary className="cursor-pointer text-[10px] text-muted-foreground">
          {calls.length} tool calls
        </summary>
        {items.map((c) => (
          <ToolCard
            key={c.id}
            name={c.name}
            input={c.input}
            content={c.content}
            isError={c.isError}
            running={c.running}
            source={c.source}
          />
        ))}
      </details>
    </div>
  );
}

function AssistantBlocks({
  blocks,
  results,
  running,
  runs,
}: {
  blocks: Block[];
  results: Results;
  running: boolean;
  runs: Runs;
}) {
  return (
    <>
      {blocks.map((b, i) => {
        if (b.type === "text")
          return b.text.trim() ? <Markdown key={i} text={b.text} /> : null;
        const thought = thinkingText(b);
        if (thought) return <ThinkingBlock key={i} text={thought} />;
        if (b.type === "tool_use" && runs.inside.has(b.id)) return null;
        if (b.type === "tool_use" && runs.first.has(b.id))
          return (
            <DeployRun
              key={b.id}
              calls={runs.first.get(b.id)!}
              results={results}
              running={running}
            />
          );
        if (b.type === "tool_use") {
          const r = results.get(b.id);
          return (
            <ToolCard
              key={b.id}
              callId={b.id}
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

/** "Working…" plus what the agent is doing, if it said, and for how long.
 * Keyed by status, so the clock counts time spent on *this* step. */
function Activity({ status }: { status: string }) {
  const [secs, setSecs] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setSecs((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, []);
  return (
    <div
      className="flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground"
      role="status"
    >
      <IconLoader2 className="size-3 shrink-0 animate-spin" />
      <span className="min-w-0 truncate" title={status || undefined}>
        {status ? `${status}…` : "Working…"}
      </span>
      {secs >= 3 && <span className="shrink-0 tabular-nums opacity-70">{secs}s</span>}
    </div>
  );
}

export function MessageList({
  messages,
  streaming,
  thinking = "",
  status = "",
  running,
  runningProvider,
  liveCalls,
  onChoose,
}: {
  messages: Message[];
  streaming: string;
  /** Reasoning streamed for the reply being written. */
  thinking?: string;
  /** What an agent CLI is doing between visible output. */
  status?: string;
  running: boolean;
  runningProvider: { provider: string; model: string; effort?: string } | null;
  liveCalls: Record<string, LiveCall>;
  /** Send a reply for the user (a clicked choice). */
  onChoose?: (text: string) => void;
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

  // Sub-agents' own calls show inside their card, not as cards of the turn.
  const subAgentCalls = useMemo(() => {
    const m = new Map<string, LiveCall[]>();
    for (const c of Object.values(liveCalls)) {
      const parent = subAgentParent(c.source);
      if (parent) m.set(parent, [...(m.get(parent) ?? []), c]);
    }
    return m;
  }, [liveCalls]);
  const pending = Object.values(liveCalls).filter(
    (c) => !savedToolIds.has(c.callId) && !subAgentParent(c.source),
  );
  // A saved tool_use whose result has not been saved yet may have a live result.
  const merged = useMemo(() => {
    const m = new Map(results);
    for (const c of Object.values(liveCalls))
      if (c.done && !m.has(c.callId))
        m.set(c.callId, { content: c.content ?? "", isError: !!c.isError });
    return m;
  }, [results, liveCalls]);

  const pendingKey = pending.map((c) => c.callId).join(",");
  const runs = useMemo(() => {
    const calls: (Call | null)[] = [];
    for (const m of visible) {
      if (m.role === "user") calls.push(null);
      else
        for (const b of m.blocks)
          if (b.type === "tool_use")
            calls.push({ id: b.id, name: b.name, input: b.input });
    }
    for (const c of pending)
      calls.push({ id: c.callId, name: c.name, input: c.input, source: c.source });
    return deployRuns(calls);
    // pendingKey stands in for `pending`, which is rebuilt every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, pendingKey]);
  const lastAssistant = visible.length - 1;
  const choice = (i: number) => ({
    send: onChoose ?? null,
    active: !running && i === lastAssistant,
  });

  return (
    <SubAgentCalls value={subAgentCalls}>
    <div className="flex flex-col gap-5">
      {visible.map((m, i) =>
        m.role === "user" ? (
          <div key={m.id} className="flex flex-col items-end gap-1">
            <UserImages message={m} />
            <UserChips message={m} />
            {m.blocks.some((b) => b.type === "text" && b.text) && (
              <div className="max-w-[85%] min-w-0 rounded-2xl rounded-br-md border bg-muted/60 px-3.5 py-2">
                <Markdown
                  text={withMentions(
                    m.blocks.map((b) => (b.type === "text" ? b.text : "")).join("\n\n"),
                    m,
                  )}
                />
              </div>
            )}
          </div>
        ) : (
          <div key={m.id} className="min-w-0">
            <ChoiceContext value={choice(i)}>
              <AssistantBlocks
                blocks={m.blocks}
                results={merged}
                running={running}
                runs={runs}
              />
            </ChoiceContext>
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
          {pending.map((c) =>
            runs.inside.has(c.callId) ? null : runs.first.has(c.callId) ? (
              <DeployRun
                key={c.callId}
                calls={runs.first.get(c.callId)!}
                results={merged}
                running={running}
              />
            ) : (
              <ToolCard
                key={c.callId}
                callId={c.callId}
                name={c.name}
                input={c.input}
                content={c.content}
                isError={c.isError}
                running={!c.done}
                source={c.source}
              />
            ),
          )}
          {/* Text clears the status, so one set after it is newer work
              (e.g. writing a big tool call) and shows under the text. */}
          {running &&
            pending.every((c) => c.done) &&
            (status || (!streaming && !thinking.trim())) && (
              <Activity key={status} status={status} />
            )}
          <ProviderLabel
            provider={runningProvider?.provider}
            model={runningProvider?.model}
            effort={runningProvider?.effort}
          />
        </div>
      )}
    </div>
    </SubAgentCalls>
  );
}
