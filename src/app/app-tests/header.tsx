"use client"

import { IconAlertTriangle, IconFileText, IconLoader2, IconPlayerPlay, IconPlayerStop, IconServer } from "@tabler/icons-react"
import { Button } from "@/components/ui/button"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import type { UiTestMode, UiTestSuite } from "@/lib/ui-tests"
import { SessionChip, useSession } from "./session"

export type RunState = { runId: string; suiteId: string; index: number; total: number }

/** Suite title bar: name, environment, session, run controls and live progress. */
export function SuiteHeader({
  suite,
  suiteDirty,
  savingSuite,
  onName,
  onSaveSuite,
  onOpenSettings,
  run,
  runningHere,
  counts,
  runMode,
  onRunMode,
  onStart,
  onStop,
  selectedCount,
  canRun,
  hasFailed,
  caseCount,
  hasRuns,
  onOpenReport,
}: {
  suite: UiTestSuite
  suiteDirty: boolean
  savingSuite: boolean
  onName: (name: string) => void
  onSaveSuite: () => void
  onOpenSettings: () => void
  run: RunState | null
  runningHere: boolean
  counts: { passed: number; failed: number }
  runMode: "" | UiTestMode
  onRunMode: (m: "" | UiTestMode) => void
  onStart: (which: "selected" | "all" | "failed") => void
  onStop: () => void
  selectedCount: number
  canRun: boolean
  hasFailed: boolean
  caseCount: number
  hasRuns: boolean
  onOpenReport: () => void
}) {
  const session = useSession(suite.envId)
  const running = !!run
  const shown = run ? Math.min(run.index + 1, run.total) : 0
  const pct = run && run.total > 0 ? (shown / run.total) * 100 : 0

  return (
    <div className="flex flex-col gap-2 border-b px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <input
          value={suite.name}
          placeholder="Suite name"
          aria-label="Suite name"
          onChange={(e) => onName(e.target.value)}
          className="h-7 min-w-40 max-w-80 flex-1 rounded-md border border-transparent bg-transparent px-1.5 font-heading text-sm font-semibold outline-none hover:border-input focus:border-ring"
        />
        {suite.envId ? (
          <button
            type="button"
            onClick={onOpenSettings}
            title="Change environment"
            className="inline-flex h-6 items-center gap-1 rounded-full bg-muted px-2.5 text-[11px] font-medium hover:bg-muted/70 focus-visible:ring-2 focus-visible:ring-ring/30 focus-visible:outline-none"
          >
            <IconServer className="size-3" /> {suite.envId}
          </button>
        ) : (
          <button
            type="button"
            onClick={onOpenSettings}
            className="inline-flex h-6 items-center gap-1 rounded-full bg-warning/15 px-2.5 text-[11px] font-medium text-warning hover:bg-warning/25 focus-visible:ring-2 focus-visible:ring-ring/30 focus-visible:outline-none"
          >
            <IconAlertTriangle className="size-3" /> Select an environment
          </button>
        )}
        {suite.envId && suite.id && <SessionChip envId={suite.envId} session={session} />}
        {suiteDirty && (
          <Button size="xs" variant="outline" onClick={onSaveSuite} disabled={savingSuite}>
            {suite.id ? "Save settings" : "Create suite"}
          </Button>
        )}

        {suite.id && (
          <div className="ml-auto flex flex-wrap items-center gap-1.5">
            <NativeSelect
              size="sm"
              className="w-32"
              value={runMode}
              onChange={(e) => onRunMode(e.target.value as "" | UiTestMode)}
              aria-label="Run mode"
            >
              <NativeSelectOption value="">Mode: per case</NativeSelectOption>
              <NativeSelectOption value="headed">Run headed</NativeSelectOption>
              <NativeSelectOption value="headless">Run headless</NativeSelectOption>
            </NativeSelect>
            <Button size="sm" variant="outline" onClick={onOpenReport} disabled={!hasRuns} title="Generate a test document from the latest run">
              <IconFileText /> Document
            </Button>
            <Button size="sm" variant="outline" onClick={() => onStart("failed")} disabled={!canRun || !hasFailed}>
              Run failed
            </Button>
            <Button size="sm" variant="outline" onClick={() => onStart("selected")} disabled={!canRun || selectedCount === 0}>
              <IconPlayerPlay /> Run selected{selectedCount > 0 ? ` (${selectedCount})` : ""}
            </Button>
            <Button size="sm" onClick={() => onStart("all")} disabled={!canRun || caseCount === 0}>
              <IconPlayerPlay /> Run all
            </Button>
            {running && (
              <Button size="sm" variant="destructive" onClick={onStop}>
                <IconPlayerStop /> Stop
              </Button>
            )}
          </div>
        )}
      </div>
      {running && (
        <div className="flex items-center gap-3 text-xs">
          <IconLoader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
          <div className="h-1.5 min-w-24 flex-1 overflow-hidden rounded-full bg-muted">
            <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${runningHere ? pct : 0}%` }} />
          </div>
          <span className="whitespace-nowrap tabular-nums">
            {run.total > 0 ? `${shown} / ${run.total}` : "Starting"}
          </span>
          {runningHere ? (
            <>
              <span className="text-success">{counts.passed} passed</span>
              <span className="text-destructive">{counts.failed} failed</span>
            </>
          ) : (
            <span className="text-muted-foreground">running another suite</span>
          )}
        </div>
      )}
    </div>
  )
}
