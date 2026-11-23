"use client";

import { useMemo, useState } from "react";
import { diffLines } from "diff";
import { IconCheck, IconCopy } from "@tabler/icons-react";
import { cn } from "@/lib/utils";

type Kind = "add" | "del" | "ctx";
type Row = { kind: Kind; text: string; o?: number; n?: number };
type Fold = { kind: "fold"; id: number; rows: Row[] };
type Item = Row | Fold;
type SetOpen = (f: (s: Set<number>) => Set<number>) => void;

const MAX_BYTES = 400 * 1024;
const MAX_LINES = 20000;
const COLLAPSE_OVER = 6;
const CONTEXT = 3;

const ROW_BG: Record<Kind, string> = {
  add: "bg-success/15",
  del: "bg-destructive/15",
  ctx: "",
};
const MARK: Record<Kind, string> = { add: "+", del: "−", ctx: " " };

const lineCount = (s: string) => (s ? s.split("\n").length : 0);

function toRows(original: string, modified: string): Row[] {
  const rows: Row[] = [];
  let o = 1;
  let n = 1;
  for (const part of diffLines(original, modified)) {
    const lines = part.value.split("\n");
    if (lines[lines.length - 1] === "") lines.pop();
    for (const text of lines) {
      if (part.added) rows.push({ kind: "add", text, n: n++ });
      else if (part.removed) rows.push({ kind: "del", text, o: o++ });
      else rows.push({ kind: "ctx", text, o: o++, n: n++ });
    }
  }
  return rows;
}

/** Fold long unchanged runs, keeping CONTEXT lines either side. */
function fold(rows: Row[]): Item[] {
  const out: Item[] = [];
  let i = 0;
  let id = 0;
  while (i < rows.length) {
    if (rows[i].kind !== "ctx") {
      out.push(rows[i++]);
      continue;
    }
    let j = i;
    while (j < rows.length && rows[j].kind === "ctx") j++;
    const run = rows.slice(i, j);
    if (run.length > COLLAPSE_OVER) {
      const head = i === 0 ? 0 : CONTEXT;
      const tail = j === rows.length ? 0 : CONTEXT;
      out.push(...run.slice(0, head));
      out.push({ kind: "fold", id: id++, rows: run.slice(head, run.length - tail) });
      out.push(...run.slice(run.length - tail));
    } else out.push(...run);
    i = j;
  }
  return out;
}

function FoldRow({ n, onClick }: { n: number; onClick: () => void }) {
  return (
    <tr>
      <td colSpan={4}>
        <button
          type="button"
          onClick={onClick}
          className="w-full bg-muted/50 px-2 py-0.5 text-left text-[10.5px] text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          ⋯ {n} unchanged lines
        </button>
      </td>
    </tr>
  );
}

const Num = ({ v }: { v?: number }) => (
  <td className="w-9 min-w-9 px-1 text-right text-muted-foreground/70 select-none">{v ?? ""}</td>
);

function Unified({ items, open, setOpen }: { items: Item[]; open: Set<number>; setOpen: SetOpen }) {
  const renderRow = (r: Row, key: string) => (
    <tr key={key} className={ROW_BG[r.kind]}>
      <Num v={r.o} />
      <Num v={r.n} />
      <td className="w-3 text-center text-muted-foreground select-none">{MARK[r.kind]}</td>
      <td className="pr-3 whitespace-pre">{r.text || " "}</td>
    </tr>
  );
  return (
    <table className="w-full border-collapse">
      <tbody>
        {items.map((it, idx) =>
          it.kind !== "fold" ? (
            renderRow(it, String(idx))
          ) : open.has(it.id) ? (
            it.rows.map((r, k) => renderRow(r, `${idx}-${k}`))
          ) : (
            <FoldRow key={idx} n={it.rows.length} onClick={() => setOpen((s) => new Set(s).add(it.id))} />
          ),
        )}
      </tbody>
    </table>
  );
}

type Pair = { l?: Row; r?: Row } | { fold: Fold };

function Split({ items, open, setOpen }: { items: Item[]; open: Set<number>; setOpen: SetOpen }) {
  const pairs: Pair[] = [];
  let dels: Row[] = [];
  let adds: Row[] = [];
  const flush = () => {
    for (let k = 0; k < Math.max(dels.length, adds.length); k++) pairs.push({ l: dels[k], r: adds[k] });
    dels = [];
    adds = [];
  };
  const ctx = (r: Row) => pairs.push({ l: r, r });
  for (const it of items) {
    if (it.kind === "del") dels.push(it);
    else if (it.kind === "add") adds.push(it);
    else {
      flush();
      if (it.kind === "fold") {
        if (open.has(it.id)) it.rows.forEach(ctx);
        else pairs.push({ fold: it });
      } else ctx(it);
    }
  }
  flush();
  const cell = (r: Row | undefined, num?: number) => (
    <>
      <Num v={r ? num : undefined} />
      <td className={cn("pr-3 whitespace-pre", r && ROW_BG[r.kind])}>{r ? r.text || " " : ""}</td>
    </>
  );
  return (
    <table className="w-full table-fixed border-collapse">
      <colgroup>
        <col className="w-9" />
        <col />
        <col className="w-9" />
        <col />
      </colgroup>
      <tbody>
        {pairs.map((p, i) =>
          "fold" in p ? (
            <FoldRow key={i} n={p.fold.rows.length} onClick={() => setOpen((s) => new Set(s).add(p.fold.id))} />
          ) : (
            <tr key={i}>
              {cell(p.l, p.l?.o)}
              {cell(p.r, p.r?.n)}
            </tr>
          ),
        )}
      </tbody>
    </table>
  );
}

export function DiffView({
  original: originalProp,
  modified: modifiedProp,
  path,
  maxHeight = "24rem",
}: {
  original: string;
  modified: string;
  path?: string;
  maxHeight?: string;
}) {
  const [split, setSplit] = useState(false);
  const [open, setOpen] = useState<Set<number>>(() => new Set());
  const [copied, setCopied] = useState(false);
  const original = typeof originalProp === "string" ? originalProp : "";
  const modified = typeof modifiedProp === "string" ? modifiedProp : "";

  const huge =
    original.length > MAX_BYTES ||
    modified.length > MAX_BYTES ||
    lineCount(original) > MAX_LINES ||
    lineCount(modified) > MAX_LINES;
  const same = original === modified;

  const data = useMemo(() => {
    if (huge || same) return null;
    try {
      const rows = toRows(original, modified);
      return {
        items: fold(rows),
        add: rows.filter((r) => r.kind === "add").length,
        del: rows.filter((r) => r.kind === "del").length,
      };
    } catch {
      return null;
    }
  }, [original, modified, huge, same]);

  const label = !original ? "new file" : !modified ? "deleted" : null;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(modified);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable */
    }
  };

  return (
    <div className="my-2 overflow-hidden rounded-md border bg-card text-xs">
      <div className="flex items-center gap-2 border-b bg-muted/40 px-2 py-1">
        <span className="min-w-0 flex-1 truncate font-mono text-[11px]" title={path}>
          {path ?? "diff"}
        </span>
        {label && <span className="rounded bg-muted px-1 text-[10px] text-muted-foreground">{label}</span>}
        {data && (
          <span className="shrink-0 font-mono text-[10.5px]">
            <span className="text-success">+{data.add}</span>{" "}
            <span className="text-destructive">−{data.del}</span>
          </span>
        )}
        {data && (
          <button
            type="button"
            aria-pressed={split}
            onClick={() => setSplit((v) => !v)}
            className={cn(
              "rounded px-1.5 py-0.5 text-[10.5px] text-muted-foreground hover:text-foreground",
              split && "bg-muted text-foreground",
            )}
          >
            Split
          </button>
        )}
        <button
          type="button"
          aria-label="Copy modified text"
          title="Copy modified"
          onClick={copy}
          className="rounded p-0.5 text-muted-foreground hover:text-foreground"
        >
          {copied ? <IconCheck className="size-3.5" /> : <IconCopy className="size-3.5" />}
        </button>
      </div>
      {same ? (
        <div className="px-2 py-2 text-muted-foreground">No changes</div>
      ) : huge || !data ? (
        <div className="px-2 py-2 text-muted-foreground">
          {huge ? "Too large to diff" : "Could not compute diff"}: {lineCount(original)} lines (
          {(original.length / 1024).toFixed(0)} KB) → {lineCount(modified)} lines (
          {(modified.length / 1024).toFixed(0)} KB).
        </div>
      ) : (
        <div className="overflow-auto font-mono text-[11px] leading-[1.45]" style={{ maxHeight }}>
          {split ? (
            <Split items={data.items} open={open} setOpen={setOpen} />
          ) : (
            <Unified items={data.items} open={open} setOpen={setOpen} />
          )}
        </div>
      )}
    </div>
  );
}

function patchClass(line: string): string {
  if (/^(diff |index |--- |\+\+\+ )/.test(line)) return "font-semibold text-muted-foreground";
  if (line.startsWith("@@")) return "bg-info/10 text-info";
  if (line.startsWith("+")) return ROW_BG.add;
  if (line.startsWith("-") || line.startsWith("−")) return ROW_BG.del;
  return "";
}

export function PatchView({ source }: { source: string }) {
  const lines = (source ?? "").replace(/\n$/, "").split("\n");
  return (
    <div className="my-2 overflow-auto rounded-md border bg-card font-mono text-[11px] leading-[1.45]">
      {lines.map((l, i) => (
        <div key={i} className={cn("px-2 whitespace-pre", patchClass(l))}>
          {l || " "}
        </div>
      ))}
    </div>
  );
}
