"use client"

import { IconLoader2 } from "@tabler/icons-react"
import type { UiCaseStatus, UiStepResult } from "@/lib/ui-tests"
import { cn } from "@/lib/utils"

const CHIP = "inline-flex h-5 items-center gap-1 rounded-full px-2 text-[0.625rem] font-medium whitespace-nowrap"

const STATUS: Record<UiCaseStatus, { label: string; tone: string }> = {
  notRun: { label: "Not run", tone: "bg-muted text-muted-foreground" },
  running: { label: "Running", tone: "bg-info/15 text-info" },
  passed: { label: "Passed", tone: "bg-success/15 text-success" },
  failed: { label: "Failed", tone: "bg-destructive/15 text-destructive" },
  needsReview: { label: "Needs review", tone: "bg-warning/15 text-warning" },
  error: { label: "Error", tone: "bg-destructive/15 text-destructive" },
}

export function CaseStatusChip({ status }: { status: UiCaseStatus }) {
  const s = STATUS[status] ?? STATUS.notRun
  return (
    <span className={cn(CHIP, s.tone)}>
      {status === "running" && <IconLoader2 className="size-3 animate-spin" />}
      {s.label}
    </span>
  )
}

const STEP_TONE: Record<UiStepResult["status"], string> = {
  passed: "bg-success/15 text-success",
  failed: "bg-destructive/15 text-destructive",
  skipped: "bg-muted text-muted-foreground",
}

export function StepResultChip({ result }: { result: UiStepResult | undefined }) {
  if (!result) return <span className="text-muted-foreground">—</span>
  return (
    <span className={cn(CHIP, STEP_TONE[result.status])} title={result.note || undefined}>
      {result.status}
    </span>
  )
}

/** Epoch ms (values that look like seconds are scaled up). */
export const formatMs = (ms: number | null | undefined) =>
  ms ? new Date(ms < 1e11 ? ms * 1000 : ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "—"

export function countStatuses(cases: { status: UiCaseStatus }[]) {
  const n = { total: cases.length, passed: 0, failed: 0, review: 0, notRun: 0 }
  for (const c of cases) {
    if (c.status === "passed") n.passed++
    else if (c.status === "failed" || c.status === "error") n.failed++
    else if (c.status === "needsReview") n.review++
    else n.notRun++
  }
  return n
}

export const duration = (ms: number | null | undefined) =>
  ms == null ? "—" : ms < 1000 ? `${ms} ms` : ms < 60000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`

export const TMP = "tmp-"
