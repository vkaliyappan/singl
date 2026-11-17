"use client";

import { isRecord } from "../shared";

export function relTime(t: string | number | undefined): string {
  if (t === undefined || t === "") return "";
  const ms = typeof t === "number" ? t : Date.parse(t);
  if (Number.isNaN(ms)) return "";
  const s = Math.round((Date.now() - ms) / 1000);
  const abs = Math.abs(s);
  const fmt = (n: number, u: string) => (s >= 0 ? `${n}${u} ago` : `in ${n}${u}`);
  if (abs < 45) return "just now";
  if (abs < 3600) return fmt(Math.round(abs / 60), "m");
  if (abs < 86400) return fmt(Math.round(abs / 3600), "h");
  if (abs < 86400 * 60) return fmt(Math.round(abs / 86400), "d");
  return fmt(Math.round(abs / 86400 / 30), "mo");
}

export function absTime(t: string | number | undefined): string {
  if (t === undefined) return "";
  const d = new Date(t);
  return Number.isNaN(d.getTime()) ? String(t) : d.toLocaleString();
}

function Tile({ label, at }: { label: string; at: unknown }) {
  const v = typeof at === "string" || typeof at === "number" ? at : undefined;
  const rel = relTime(v);
  return (
    <div
      className="min-w-0 rounded-md border bg-background/50 px-2.5 py-1.5"
      title={v !== undefined ? absTime(v) : undefined}
    >
      <div className="text-[10.5px] text-muted-foreground">{label}</div>
      <div className={rel ? "text-sm font-semibold" : "text-sm text-muted-foreground italic"}>{rel || "never"}</div>
    </div>
  );
}

export function RunTimesView({ value }: { value: unknown }) {
  if (!isRecord(value)) return null;
  return (
    <div className="grid grid-cols-2 gap-2 rounded-md border bg-card p-2 text-xs">
      <Tile label="Last export" at={value.lastExported} />
      <Tile label="Last extract" at={value.lastExtracted} />
    </div>
  );
}
