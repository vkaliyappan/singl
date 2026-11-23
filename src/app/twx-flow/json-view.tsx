"use client";

import { useMemo, useState } from "react";
import {
  IconChevronDown,
  IconChevronRight,
  IconCopy,
  IconFoldDown,
  IconFoldUp,
} from "@tabler/icons-react";

import { cn } from "@/lib/utils";
import { joinPath } from "@/lib/twx-flow/expression";
import { expressionDragProps } from "./schema-tree";

/** Branches deeper than this start collapsed, so big infotables stay readable. */
const AUTO_OPEN_DEPTH = 2;
/** Array items drawn before the rest are held back behind "show more". */
const ITEM_PAGE = 100;

const TOKEN = {
  key: "text-sky-700 dark:text-sky-300",
  string: "text-emerald-700 dark:text-emerald-400",
  number: "text-amber-700 dark:text-amber-400",
  boolean: "text-violet-700 dark:text-violet-400",
  null: "text-muted-foreground",
  punctuation: "text-muted-foreground/70",
};

/**
 * Which branches are open.
 *
 * `mode` is what a row falls back to when it has never been clicked: the depth
 * rule normally, everything open or everything shut after expand / collapse all.
 * A click writes an override for that one path, so expanding all and then
 * shutting a single branch does what it looks like it does.
 */
type OpenState = {
  isOpen: (path: string, depth: number) => boolean;
  toggle: (path: string, open: boolean) => void;
};

function Scalar({ value }: { value: unknown }) {
  if (value === null) return <span className={TOKEN.null}>null</span>;
  if (value === undefined) return <span className={TOKEN.null}>undefined</span>;
  if (typeof value === "string") return <span className={TOKEN.string}>&quot;{value}&quot;</span>;
  if (typeof value === "number") return <span className={TOKEN.number}>{value}</span>;
  if (typeof value === "boolean") return <span className={TOKEN.boolean}>{String(value)}</span>;
  return <span>{String(value)}</span>;
}

function summary(value: unknown): string {
  if (Array.isArray(value)) return `[ ${value.length} item${value.length === 1 ? "" : "s"} ]`;
  const keys = Object.keys(value as object);
  return `{ ${keys.length} key${keys.length === 1 ? "" : "s"} }`;
}

function Row({
  label,
  value,
  path,
  depth,
  isLast,
  openState,
  draggable,
  onInsert,
}: {
  label?: string;
  value: unknown;
  /** Expression this row's value sits at — also its identity in `openState`. */
  path: string;
  depth: number;
  isLast: boolean;
  openState: OpenState;
  /** Whether `path` is a real expression, and so worth dragging out. */
  draggable: boolean;
  onInsert?: (expression: string) => void;
}) {
  const isBranch = value !== null && typeof value === "object";
  const [copied, setCopied] = useState(false);
  const [shown, setShown] = useState(ITEM_PAGE);

  const open = isBranch && openState.isOpen(path, depth);

  const entries = isBranch
    ? Array.isArray(value)
      ? value.slice(0, shown).map((v, i) => ({ key: String(i), value: v, isIndex: true }))
      : Object.entries(value as Record<string, unknown>).map(([k, v]) => ({
          key: k,
          value: v,
          isIndex: false,
        }))
    : [];
  const hidden = Array.isArray(value) ? Math.max(0, value.length - shown) : 0;

  const copy = () => {
    void navigator.clipboard
      ?.writeText(typeof value === "string" ? value : JSON.stringify(value, null, 2))
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      });
  };

  const open_ = Array.isArray(value) ? "[" : "{";
  const close = Array.isArray(value) ? "]" : "}";

  // The key and its value drag as one — that is the thing a parameter wants.
  const dragProps = draggable
    ? { ...expressionDragProps(path), onClick: () => onInsert?.(path) }
    : {};

  return (
    <div>
      <div
        className="group/json flex items-start gap-1 rounded px-1 hover:bg-accent/60"
        style={{ paddingLeft: depth * 14 + 4 }}
      >
        {isBranch ? (
          <button
            type="button"
            onClick={() => openState.toggle(path, !open)}
            className="mt-[3px] text-muted-foreground"
            aria-label={open ? "Collapse" : "Expand"}
          >
            {open ? (
              <IconChevronDown className="size-3" />
            ) : (
              <IconChevronRight className="size-3" />
            )}
          </button>
        ) : (
          <span className="w-3 shrink-0" />
        )}

        <span
          {...dragProps}
          className={cn(
            "min-w-0 flex-1 break-all",
            draggable && "cursor-grab active:cursor-grabbing"
          )}
        >
          {label !== undefined && (
            <>
              <span className={TOKEN.key}>{label}</span>
              <span className={TOKEN.punctuation}>: </span>
            </>
          )}
          {isBranch ? (
            open ? (
              <span className={TOKEN.punctuation}>{open_}</span>
            ) : (
              <span className={TOKEN.punctuation}>
                {open_} <span className="text-muted-foreground">{summary(value)}</span> {close}
                {isLast ? "" : ","}
              </span>
            )
          ) : (
            <>
              <Scalar value={value} />
              <span className={TOKEN.punctuation}>{isLast ? "" : ","}</span>
            </>
          )}
        </span>

        <button
          type="button"
          onClick={copy}
          aria-label="Copy value"
          title="Copy value"
          className="shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover/json:opacity-100 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/30 focus-visible:outline-none"
        >
          <IconCopy className="size-3" />
        </button>
        {copied && <span className="shrink-0 text-[9px] text-muted-foreground">copied</span>}
      </div>

      {isBranch && open && (
        <>
          {entries.map((e, index) => (
            <Row
              key={e.key}
              label={e.isIndex ? e.key : `"${e.key}"`}
              value={e.value}
              path={joinPath(path, e.key, e.isIndex)}
              depth={depth + 1}
              isLast={index === entries.length - 1}
              openState={openState}
              draggable={draggable}
              onInsert={onInsert}
            />
          ))}
          {hidden > 0 && (
            <div
              className="flex items-center gap-2 px-1 text-[10px] text-muted-foreground"
              style={{ paddingLeft: (depth + 1) * 14 + 4 }}
            >
              <button
                type="button"
                onClick={() => setShown((n) => n + ITEM_PAGE)}
                className="rounded border px-1.5 py-0.5 hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/30 focus-visible:outline-none"
              >
                Show {Math.min(ITEM_PAGE, hidden)} more
              </button>
              <button
                type="button"
                onClick={() => setShown((value as unknown[]).length)}
                className="rounded border px-1.5 py-0.5 hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/30 focus-visible:outline-none"
              >
                Show all {(value as unknown[]).length}
              </button>
              <span>{hidden} hidden</span>
            </div>
          )}
          <div className={TOKEN.punctuation} style={{ paddingLeft: depth * 14 + 20 }}>
            {close}
            {isLast ? "" : ","}
          </div>
        </>
      )}
    </div>
  );
}

/**
 * Collapsible, syntax-highlighted JSON with per-row copy.
 *
 * Given a `root` expression every key also becomes draggable, so a value spotted
 * in the raw JSON can be dropped straight into a parameter without hunting for
 * the same field in the schema tree.
 */
export function JsonView({
  value,
  root,
  onInsert,
  className,
}: {
  value: unknown;
  /** Expression the whole document stands for, e.g. `$json`. Enables dragging. */
  root?: string;
  onInsert?: (expression: string) => void;
  className?: string;
}) {
  const [mode, setMode] = useState<"auto" | "all" | "none">("auto");
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});

  const openState = useMemo<OpenState>(
    () => ({
      isOpen: (path, depth) =>
        overrides[path] ??
        (mode === "all" ? true : mode === "none" ? false : depth < AUTO_OPEN_DEPTH),
      toggle: (path, open) => setOverrides((o) => ({ ...o, [path]: open })),
    }),
    [mode, overrides]
  );

  // Expand / collapse all is a new baseline, not a nudge — per-row overrides from
  // before it would only leave the tree half-obeying the button.
  const setAll = (next: "all" | "none") => {
    setMode(next);
    setOverrides({});
  };

  return (
    <div
      className={cn(
        "rounded-md border bg-muted/30 p-1.5 font-mono text-[10px] leading-relaxed",
        className
      )}
    >
      <div className="sticky top-0 z-10 -mx-1.5 -mt-1.5 mb-1 flex items-center gap-1 border-b bg-background/95 px-1.5 py-1">
        <button
          type="button"
          onClick={() => setAll("all")}
          className="flex items-center gap-1 rounded border px-1.5 py-0.5 text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/30 focus-visible:outline-none"
        >
          <IconFoldDown className="size-3" />
          Expand all
        </button>
        <button
          type="button"
          onClick={() => setAll("none")}
          className="flex items-center gap-1 rounded border px-1.5 py-0.5 text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/30 focus-visible:outline-none"
        >
          <IconFoldUp className="size-3" />
          Collapse all
        </button>
        {root && (
          <span className="ml-auto truncate text-muted-foreground/70">drag a key to use it</span>
        )}
      </div>

      <Row
        value={value}
        path={root ?? "$"}
        depth={0}
        isLast
        openState={openState}
        draggable={!!root}
        onInsert={onInsert}
      />
    </div>
  );
}
