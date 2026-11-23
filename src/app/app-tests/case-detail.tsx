"use client"

import { IconArrowDown, IconArrowUp, IconPlayerPlay, IconPlus, IconTrash, IconX } from "@tabler/icons-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import type { UiTestCase, UiTestStep } from "@/lib/ui-tests"
import { Field } from "../automation/shared"
import { MdCell } from "./md-cell"
import { CaseStatusChip, duration, formatMs, StepResultChip, TMP } from "./shared"


/** Right panel: one case in full, its steps, and the outcome of its last run. */
export function CaseDetail({
  c,
  suiteMode,
  onPatch,
  onClose,
  onRun,
  canRun,
  onOpenTranscript,
}: {
  c: UiTestCase
  suiteMode: string
  onPatch: (part: Partial<UiTestCase>) => void
  onClose: () => void
  onRun: () => void
  canRun: boolean
  onOpenTranscript: (chatId: string) => void
}) {
  const setSteps = (steps: UiTestStep[]) => onPatch({ steps })
  const move = (k: number, to: number) => {
    const next = [...c.steps]
    ;[next[k], next[to]] = [next[to], next[k]]
    setSteps(next)
  }
  const edit = (k: number, part: Partial<UiTestStep>) => setSteps(c.steps.map((x, j) => (j === k ? { ...x, ...part } : x)))
  const unsaved = c.id.startsWith(TMP)

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <span className="min-w-0 flex-1 truncate text-xs font-medium">{c.title || "Untitled case"}</span>
        <Button size="xs" onClick={onRun} disabled={!canRun || unsaved} title={unsaved ? "Save the case first" : undefined}>
          <IconPlayerPlay /> Run this case
        </Button>
        <Button variant="ghost" size="icon-xs" onClick={onClose} aria-label="Close details">
          <IconX />
        </Button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-3">
        <section className="flex flex-col gap-2">
          <Field label="Title">
            <Input value={c.title} onChange={(e) => onPatch({ title: e.target.value })} />
          </Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Azure ID">
              <Input
                value={c.adoId === null ? "" : String(c.adoId)}
                onChange={(e) => {
                  const n = parseInt(e.target.value.replace(/\D/g, ""), 10)
                  onPatch({ adoId: Number.isFinite(n) ? n : null })
                }}
              />
            </Field>
            <Field label="State">
              <Input value={c.state} onChange={(e) => onPatch({ state: e.target.value })} />
            </Field>
            <Field label="Area path">
              <Input value={c.areaPath} onChange={(e) => onPatch({ areaPath: e.target.value })} />
            </Field>
            <Field label="Assigned to">
              <Input value={c.assignedTo} onChange={(e) => onPatch({ assignedTo: e.target.value })} />
            </Field>
            <Field label="Tags">
              <Input value={c.tags} onChange={(e) => onPatch({ tags: e.target.value })} />
            </Field>
            <Field label="Browser mode">
              <NativeSelect value={c.mode} onChange={(e) => onPatch({ mode: e.target.value as UiTestCase["mode"] })}>
                <NativeSelectOption value="">Suite ({suiteMode})</NativeSelectOption>
                <NativeSelectOption value="headless">Headless</NativeSelectOption>
                <NativeSelectOption value="headed">Headed</NativeSelectOption>
              </NativeSelect>
            </Field>
          </div>
        </section>

        <section className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-medium">Steps ({c.steps.length})</h3>
            <Button size="xs" variant="outline" onClick={() => setSteps([...c.steps, { action: "", expected: "" }])}>
              <IconPlus /> Add step
            </Button>
          </div>
          {c.steps.map((s, k) => {
            const res = c.stepResults.find((r) => r.step === k + 1)
            return (
              <div key={k} className="flex flex-col gap-1.5 rounded-lg border p-2">
                <div className="flex items-center gap-1.5">
                  <span className="text-[11px] font-medium text-muted-foreground">Step {k + 1}</span>
                  <StepResultChip result={res} />
                  <div className="ml-auto flex">
                    <Button variant="ghost" size="icon-xs" title="Move up" disabled={k === 0} onClick={() => move(k, k - 1)}>
                      <IconArrowUp />
                    </Button>
                    <Button variant="ghost" size="icon-xs" title="Move down" disabled={k === c.steps.length - 1} onClick={() => move(k, k + 1)}>
                      <IconArrowDown />
                    </Button>
                    <Button variant="ghost" size="icon-xs" title="Delete step" onClick={() => setSteps(c.steps.filter((_, j) => j !== k))}>
                      <IconTrash />
                    </Button>
                  </div>
                </div>
                <MdCell className="rounded-md border" placeholder="Action" value={s.action} onChange={(v) => edit(k, { action: v })} />
                <MdCell className="rounded-md border" placeholder="Expected result" value={s.expected} onChange={(v) => edit(k, { expected: v })} />
                {res?.note && <p className="text-[11px] text-muted-foreground">{res.note}</p>}
              </div>
            )
          })}
          {c.steps.length === 0 && <p className="text-xs text-muted-foreground">No steps yet.</p>}
        </section>

        <section className="flex flex-col gap-1.5">
          <h3 className="text-xs font-medium">Last result</h3>
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <CaseStatusChip status={c.status} />
            <span className="text-muted-foreground">
              {formatMs(c.lastRunAt)} · {duration(c.durationMs)}
            </span>
            {c.chatId && (
              <button type="button" className="rounded-sm text-primary hover:underline focus-visible:ring-2 focus-visible:ring-ring/30 focus-visible:outline-none" onClick={() => onOpenTranscript(c.chatId)}>
                Open transcript
              </button>
            )}
          </div>
          {c.reason && <p className="rounded-lg bg-muted/50 px-2.5 py-2 text-xs">{c.reason}</p>}
        </section>
      </div>
    </div>
  )
}
