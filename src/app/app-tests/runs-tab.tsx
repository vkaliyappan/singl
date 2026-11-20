"use client"

import { useEffect, useState } from "react"
import { IconFileText, IconTrash } from "@tabler/icons-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Spinner } from "@/components/ui/spinner"
import { deleteRun, formatTime, getRun, type RunRow } from "@/lib/automation"
import { errorMessage } from "@/lib/settings"
import type { UiCaseStatus, UiStepResult } from "@/lib/ui-tests"
import { cn } from "@/lib/utils"
import { CaseStatusChip, duration, StepResultChip } from "./shared"
import { askConfirm } from "@/lib/confirm"

type RunResult = {
  runId: string
  passed: number
  failed: number
  total: number
  cancelled: boolean
  error: string
  cases: {
    caseId: string
    title: string
    status: UiCaseStatus
    reason: string
    stepResults: UiStepResult[]
    chatId: string
    durationMs: number | null
  }[]
}

/** Run history of the suite: list on the left, per-case outcome of the selected run on the right. */
export function RunsTab({
  history,
  onReload,
  onOpenTranscript,
  onGenerate,
}: {
  history: RunRow[]
  onReload: () => void
  onOpenTranscript: (chatId: string) => void
  onGenerate: (runId: string) => void
}) {
  const [picked, setPicked] = useState("")
  const [detail, setDetail] = useState<{ id: string; result: RunResult } | null>(null)
  const [loading, setLoading] = useState(false)
  const [checked, setChecked] = useState<Set<string>>(new Set())
  const [deleting, setDeleting] = useState(false)
  const marked = history.filter((h) => checked.has(h.id))
  const allChecked = history.length > 0 && marked.length === history.length

  const activeId = history.some((h) => h.id === picked) ? picked : (history[0]?.id ?? "")
  useEffect(() => {
    if (!activeId) return
    let cancelled = false
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true)
    getRun<RunResult>(activeId)
      .then((d) => !cancelled && setDetail({ id: activeId, result: d.result }))
      .catch((e) => !cancelled && toast.error(errorMessage(e)))
      .finally(() => !cancelled && setLoading(false))
    return () => {
      cancelled = true
    }
  }, [activeId])

  const remove = async (ids: string[]) => {
    if (ids.length === 0) return
    const what = ids.length === 1 ? "this run" : `${ids.length} runs`
    if (!(await askConfirm(`Delete ${what} from the history? Their screenshots are removed after the next run.`))) return
    setDeleting(true)
    try {
      await Promise.all(ids.map((id) => deleteRun(id)))
      setChecked((s) => new Set([...s].filter((id) => !ids.includes(id))))
      toast.success(ids.length === 1 ? "Run deleted" : `${ids.length} runs deleted`)
      onReload()
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setDeleting(false)
    }
  }
  const toggle = (id: string, on: boolean) =>
    setChecked((s) => {
      const next = new Set(s)
      if (on) next.add(id)
      else next.delete(id)
      return next
    })

  if (history.length === 0) {
    return <p className="p-6 text-center text-xs text-muted-foreground">No runs yet. Run the suite to see its history here.</p>
  }

  const r = detail?.id === activeId ? detail.result : null
  return (
    <div className="grid h-full min-h-0 grid-cols-[16rem_1fr]">
      <div className="flex min-h-0 flex-col border-r">
        <div className="flex items-center gap-2 border-b px-2.5 py-1.5 text-xs">
          <Checkbox
            checked={allChecked}
            onCheckedChange={(on) => setChecked(on ? new Set(history.map((h) => h.id)) : new Set())}
            aria-label="Select all runs"
          />
          <span className="text-muted-foreground">{marked.length > 0 ? `${marked.length} selected` : `${history.length} runs`}</span>
          <Button
            size="xs"
            variant="ghost"
            className="ml-auto text-destructive"
            disabled={marked.length === 0 || deleting}
            onClick={() => remove(marked.map((h) => h.id))}
          >
            <IconTrash /> Delete
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
          {history.map((h) => (
            <div
              key={h.id}
              className={cn("group mb-0.5 flex items-start gap-2 rounded-md px-2 py-1.5 hover:bg-muted", h.id === activeId && "bg-muted")}
            >
              <Checkbox
                className="mt-0.5"
                checked={checked.has(h.id)}
                onCheckedChange={(on) => toggle(h.id, !!on)}
                aria-label="Select run"
              />
            <button type="button" onClick={() => setPicked(h.id)} className="min-w-0 flex-1 text-left text-xs">
              <span className="flex items-center justify-between gap-2">
                <span className="whitespace-nowrap font-medium">{formatTime(h.startedAt)}</span>
                <span className={cn("text-[11px]", h.status === "passed" ? "text-emerald-700 dark:text-emerald-300" : "text-red-700 dark:text-red-300")}>
                  {h.status}
                </span>
              </span>
              <span className="block truncate text-[11px] text-muted-foreground">
                {h.summary} · {duration(h.durationMs)}
              </span>
            </button>
              <button
                type="button"
                title="Delete this run"
                disabled={deleting}
                onClick={() => remove([h.id])}
                className="invisible mt-0.5 text-muted-foreground group-hover:visible hover:text-destructive"
              >
                <IconTrash className="size-3.5" />
              </button>
            </div>
          ))}
        </div>
      </div>

      <div className="min-h-0 overflow-y-auto p-3">
        {loading && !r && <Spinner />}
        {r && (
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-3 text-xs">
              <span className="text-emerald-700 dark:text-emerald-300">{r.passed} passed</span>
              <span className="text-red-700 dark:text-red-300">{r.failed} failed</span>
              <span className="text-muted-foreground">of {r.total}</span>
              {r.cancelled && <span className="text-amber-700 dark:text-amber-300">Stopped early</span>}
              <Button size="xs" variant="outline" className="ml-auto" onClick={() => onGenerate(activeId)}>
                <IconFileText /> Generate document
              </Button>
            </div>
            {r.error && <p className="rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive">{r.error}</p>}
            {(r.cases ?? []).map((c) => (
              <div key={c.caseId} className="flex flex-col gap-1.5 rounded-lg border p-2.5">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-xs font-medium">{c.title}</span>
                  <CaseStatusChip status={c.status} />
                  <span className="text-[11px] text-muted-foreground">{duration(c.durationMs)}</span>
                  {c.chatId && (
                    <button type="button" className="text-xs text-primary hover:underline" onClick={() => onOpenTranscript(c.chatId)}>
                      Open transcript
                    </button>
                  )}
                </div>
                {c.reason && <p className="text-xs text-muted-foreground">{c.reason}</p>}
                {(c.stepResults ?? []).length > 0 && (
                  <ul className="flex flex-col gap-1 border-t pt-1.5">
                    {c.stepResults.map((s) => (
                      <li key={s.step} className="flex items-start gap-2 text-xs">
                        <span className="w-12 shrink-0 text-muted-foreground">Step {s.step}</span>
                        <StepResultChip result={s} />
                        <span className="min-w-0 break-words text-muted-foreground">{s.note}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
