"use client";

import { useMemo, useState } from "react";
import { IconCheck, IconCircle, IconLoader2, IconPlayerSkipForward, IconX } from "@tabler/icons-react";
import { cn } from "@/lib/utils";
import { isRecord, parseJson, Placeholder, SourceToggle } from "./shared";

export type Step = {
  title: string;
  status: "done" | "running" | "pending" | "failed" | "skipped";
  detail?: string;
  duration?: string;
};

const STATUSES = ["done", "running", "pending", "failed", "skipped"];

function StatusIcon({ status }: { status: Step["status"] }) {
  const c = "size-3.5";
  switch (status) {
    case "done":
      return <IconCheck className={cn(c, "text-emerald-600 dark:text-emerald-400")} />;
    case "running":
      return <IconLoader2 className={cn(c, "animate-spin text-primary")} />;
    case "failed":
      return <IconX className={cn(c, "text-destructive")} />;
    case "skipped":
      return <IconPlayerSkipForward className={cn(c, "text-muted-foreground")} />;
    default:
      return <IconCircle className={cn(c, "text-muted-foreground")} />;
  }
}

function Detail({ step }: { step: Step }) {
  const [open, setOpen] = useState(false);
  if (!step.detail) return null;
  const long = step.detail.length > 140 || step.detail.split("\n").length > 2;
  const failed = step.status === "failed";
  return (
    <div className="mt-0.5">
      <div
        className={cn(
          "text-[11px] break-words whitespace-pre-wrap",
          failed ? "text-destructive" : "text-muted-foreground",
          long && !open && "line-clamp-2",
        )}
      >
        {step.detail}
      </div>
      {long && (
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className="text-[10px] text-muted-foreground hover:text-foreground"
        >
          {open ? "Show less" : "Show more"}
        </button>
      )}
    </div>
  );
}

export function StepTracker({ steps, title }: { steps: Step[]; title?: string }) {
  const done = steps.filter((s) => s.status === "done" || s.status === "skipped").length;
  const pct = steps.length ? (done / steps.length) * 100 : 0;
  return (
    <div className="my-2 rounded-md border bg-card p-2.5 text-xs">
      <div className="mb-2 flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-[12px] font-medium">{title ?? "Progress"}</span>
        <span className="text-[10.5px] text-muted-foreground">
          {done}/{steps.length} done
        </span>
      </div>
      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={steps.length}
        aria-valuenow={done}
        className="mb-2.5 h-1 overflow-hidden rounded-full bg-muted"
      >
        <div className="h-full bg-primary transition-all" style={{ width: `${pct}%` }} />
      </div>
      <ol>
        {steps.map((s, i) => (
          <li key={i} className="relative flex gap-2 pb-2.5 last:pb-0">
            {i < steps.length - 1 && (
              <span aria-hidden className="absolute top-5 bottom-0 left-[9px] w-px bg-border" />
            )}
            <span
              className="z-10 mt-px flex size-[19px] shrink-0 items-center justify-center rounded-full bg-card"
              role="img"
              aria-label={s.status}
            >
              <StatusIcon status={s.status} />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline gap-2">
                <span
                  className={cn(
                    "min-w-0 flex-1 text-[12px]",
                    (s.status === "pending" || s.status === "skipped") && "text-muted-foreground",
                    s.status === "failed" && "text-destructive",
                  )}
                >
                  {s.title}
                </span>
                {s.duration && (
                  <span className="shrink-0 text-[10.5px] text-muted-foreground tabular-nums">{s.duration}</span>
                )}
              </div>
              <Detail step={s} />
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

const str = (v: unknown) => (typeof v === "string" ? v : undefined);

function toStep(r: unknown): Step | null {
  if (typeof r === "string") return { title: r, status: "pending" };
  if (!isRecord(r)) return null;
  const title = str(r.title) ?? str(r.name);
  if (!title) return null;
  const status = STATUSES.includes(r.status as string) ? (r.status as Step["status"]) : "pending";
  return {
    title,
    status,
    detail: str(r.detail),
    duration: typeof r.duration === "string" || typeof r.duration === "number" ? String(r.duration) : undefined,
  };
}

export function StepsBlock({ source }: { source: string }) {
  const parsed = useMemo(() => {
    const p = parseJson(source);
    if (!p.ok) return p;
    const raw = p.value;
    const list = Array.isArray(raw) ? raw : isRecord(raw) ? raw.steps : undefined;
    if (!Array.isArray(list) || !list.length)
      return { ok: false, message: "expected an array of steps", complete: true } as const;
    const steps = list.map(toStep).filter((s): s is Step => s !== null);
    if (!steps.length) return { ok: false, message: "steps need a title", complete: true } as const;
    return { ok: true, value: { steps, title: isRecord(raw) ? str(raw.title) : undefined } } as const;
  }, [source]);

  if (!parsed.ok)
    return <Placeholder kind="Steps" message={parsed.message} complete={parsed.complete} source={source} />;
  return (
    <SourceToggle source={source}>
      <StepTracker steps={parsed.value.steps} title={parsed.value.title} />
    </SourceToggle>
  );
}

const TITLES: Record<string, string> = {
  deploy_export_entities: "Export entities",
  deploy_bundle_projects: "Bundle projects",
  deploy_export_deployment_files: "Export deployment files",
  deploy_backup_deployment_files: "Back up deployment files",
  deploy_upload_deployment_files: "Upload to SystemRepository",
  deploy_extract_deployment_files: "Extract deployment files",
  deploy_extract_services: "Extract services",
  deploy_update_connectors: "Update connectors",
};

function friendly(name: string): string {
  if (TITLES[name]) return TITLES[name];
  const n = name.replace(/^deploy_/, "").replace(/_/g, " ");
  return n.charAt(0).toUpperCase() + n.slice(1);
}

function hint(input: unknown): string {
  if (!isRecord(input)) return "";
  const parts: string[] = [];
  for (const k of ["env", "environment", "source", "target", "project", "projects", "path"]) {
    const v = input[k];
    const s = Array.isArray(v) ? v.filter((x) => typeof x === "string").join(", ") : str(v);
    if (s) parts.push(s);
    if (parts.length >= 2) break;
  }
  return parts.join(" → ");
}

function tailLines(content: string): string | undefined {
  try {
    const v: unknown = JSON.parse(content);
    if (!isRecord(v)) return undefined;
    const log = Array.isArray(v.log) ? v.log.map(String) : typeof v.log === "string" ? v.log.split("\n") : [];
    const out = log.map((l) => l.trim()).filter(Boolean).slice(-3);
    return out.length ? out.join("\n") : undefined;
  } catch {
    return undefined;
  }
}

export function toolSteps(
  calls: { name: string; input: unknown; content?: string; isError?: boolean; running?: boolean }[],
): Step[] {
  return calls.map((c) => {
    const dry = isRecord(c.input) && (c.input.dryRun === true || c.input.dry_run === true);
    const h = hint(c.input);
    const title = friendly(c.name) + (dry ? " (dry run)" : "") + (h ? `: ${h}` : "");
    const status: Step["status"] = c.running
      ? "running"
      : c.isError
        ? "failed"
        : c.content === undefined
          ? "pending"
          : "done";
    const detail =
      status === "failed"
        ? c.content?.trim() || undefined
        : status === "done" && c.content
          ? tailLines(c.content)
          : undefined;
    return { title, status, detail };
  });
}
