"use client"

import { Fragment, useState } from "react"
import {
  IconArrowDown, IconArrowUp, IconChevronDown, IconChevronRight, IconLayoutRows, IconPlus, IconTrash,
} from "@tabler/icons-react"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import type { UiTestCase, UiTestStep } from "@/lib/ui-tests"
import { cn } from "@/lib/utils"
import { CaseStatusChip, formatMs, StepResultChip } from "./shared"
import { askConfirm } from "@/lib/confirm"

const CELL = "border-b px-1.5 py-1 align-top"
const EDIT =
  "w-full min-w-0 resize-none rounded-md border border-transparent bg-transparent px-1.5 py-1 text-xs outline-none hover:border-input focus:border-ring focus:bg-background"
const HEAD = "sticky top-0 z-10 border-b bg-muted px-1.5 py-1.5 text-left text-[11px] font-medium text-muted-foreground whitespace-nowrap"
const SINGL = "border-l-2 border-l-primary/40"

function Cell({
  value,
  onChange,
  multiline,
  placeholder,
  className,
}: {
  value: string
  onChange: (v: string) => void
  multiline?: boolean
  placeholder?: string
  className?: string
}) {
  if (multiline) {
    return (
      <textarea
        rows={Math.min(8, Math.max(2, value.split("\n").length))}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className={cn(EDIT, className)}
      />
    )
  }
  return (
    <input value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} className={cn(EDIT, className)} />
  )
}

const COMPACT_KEY = "appTests.compactRows"

const WIDTHS = [28, 70, 220, 90, 260, 260, 130, 120, 90, 110, 100, 100, 200, 130, 80, 70]

/** Azure Test Case layout: one group row per case, its steps beneath, singl-only columns on the right. */
export function UiTestsGrid({
  cases,
  onChange,
  selected,
  onSelect,
  suiteMode,
  onOpenTranscript,
  activeId,
  onActivate,
  visible,
}: {
  cases: UiTestCase[]
  onChange: (next: UiTestCase[]) => void
  selected: Set<string>
  onSelect: (next: Set<string>) => void
  suiteMode: string
  onOpenTranscript: (chatId: string) => void
  activeId: string
  onActivate: (id: string) => void
  /** Cases hidden by the search/status filter are skipped (edits still address the full list). */
  visible: (c: UiTestCase) => boolean
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  // Compact (default): step 1 shares the case row. Off = strict Azure layout (case row, then every step).
  const [compact, setCompact] = useState(() => {
    try {
      return localStorage.getItem(COMPACT_KEY) !== "0"
    } catch {
      return true
    }
  })
  const toggleCompact = () => {
    const next = !compact
    setCompact(next)
    try {
      localStorage.setItem(COMPACT_KEY, next ? "1" : "0")
    } catch {}
  }

  const patch = (i: number, part: Partial<UiTestCase>) =>
    onChange(cases.map((c, j) => (j === i ? { ...c, ...part } : c)))
  const setSteps = (i: number, steps: UiTestStep[]) => patch(i, { steps })
  const toggle = (set: Set<string>, id: string, on: boolean) => {
    const next = new Set(set)
    if (on) next.add(id)
    else next.delete(id)
    return next
  }
  const allSelected = cases.length > 0 && cases.every((c) => selected.has(c.id))

  return (
    <div className="h-full min-h-0 overflow-auto">
      <table className="w-full min-w-[1500px] table-fixed border-separate border-spacing-0 text-xs">
        <colgroup>
          {WIDTHS.map((w, i) => (
            <col key={i} style={{ width: w }} />
          ))}
        </colgroup>
        <thead>
          <tr>
            <th className={HEAD}>
              <Checkbox
                checked={allSelected}
                onCheckedChange={(on) => onSelect(on ? new Set(cases.map((c) => c.id)) : new Set())}
                aria-label="Select all"
              />
            </th>
            {["ID", "Title", "Test Step", "Step Action", "Step Expected", "Area Path", "Assigned To", "State", "Tags"].map((h) => (
              <th key={h} className={HEAD}>{h}</th>
            ))}
            {["Mode", "Status", "Reason", "Last run", "Transcript"].map((h, i) => (
              <th key={h} className={cn(HEAD, i === 0 && SINGL)}>{h}</th>
            ))}
            <th className={HEAD}>
              <Button
                variant={compact ? "secondary" : "ghost"}
                size="icon-xs"
                title={compact ? "Compact rows: step 1 on the case row. Click for the Azure layout." : "Azure layout: every step on its own row. Click for compact rows."}
                onClick={toggleCompact}
              >
                <IconLayoutRows />
              </Button>
            </th>
          </tr>
        </thead>
        <tbody>
          {cases.map((c, i) => {
            if (!visible(c)) return null
            const open = !collapsed.has(c.id)
            return (
              <Fragment key={c.id}>
                <tr
                  className={cn("cursor-default bg-muted/40", activeId === c.id && "bg-primary/10")}
                  onClick={() => onActivate(c.id)}
                >
                  <td className={CELL}>
                    <Checkbox
                      checked={selected.has(c.id)}
                      onCheckedChange={(on) => onSelect(toggle(selected, c.id, !!on))}
                      aria-label="Select case"
                    />
                  </td>
                  <td className={CELL}>
                    <Cell
                      value={c.adoId === null ? "" : String(c.adoId)}
                      placeholder="ID"
                      onChange={(v) => {
                        const n = parseInt(v.replace(/\D/g, ""), 10)
                        patch(i, { adoId: Number.isFinite(n) ? n : null })
                      }}
                    />
                  </td>
                  <td className={CELL}>
                    <div className="flex items-start gap-0.5">
                      <button
                        type="button"
                        className="mt-1 text-muted-foreground hover:text-foreground"
                        aria-label={open ? "Collapse steps" : "Expand steps"}
                        onClick={() => setCollapsed((s) => toggle(s, c.id, open))}
                      >
                        {open ? <IconChevronDown className="size-3.5" /> : <IconChevronRight className="size-3.5" />}
                      </button>
                      <Cell value={c.title} placeholder="Title" onChange={(v) => patch(i, { title: v })} className="font-medium" />
                    </div>
                  </td>
                  {compact && c.steps.length > 0 ? (
                    <>
                      <td className={cn(CELL, "pt-2 text-muted-foreground")}>
                        <div className="flex items-center gap-1">
                          1{c.steps.length > 1 && <span className="text-[10px]">/ {c.steps.length}</span>}
                          <StepResultChip result={c.stepResults.find((r) => r.step === 1)} />
                        </div>
                      </td>
                      <td className={CELL}>
                        <Cell multiline value={c.steps[0].action} placeholder="Step action" onChange={(v) => setSteps(i, c.steps.map((x, j) => (j === 0 ? { ...x, action: v } : x)))} />
                      </td>
                      <td className={CELL}>
                        <Cell multiline value={c.steps[0].expected} placeholder="Expected result" onChange={(v) => setSteps(i, c.steps.map((x, j) => (j === 0 ? { ...x, expected: v } : x)))} />
                      </td>
                    </>
                  ) : (
                    <>
                      <td className={cn(CELL, "pt-2 text-muted-foreground")}>{c.steps.length} steps</td>
                      <td className={CELL} />
                      <td className={CELL} />
                    </>
                  )}
                  <td className={CELL}><Cell value={c.areaPath} onChange={(v) => patch(i, { areaPath: v })} /></td>
                  <td className={CELL}><Cell value={c.assignedTo} onChange={(v) => patch(i, { assignedTo: v })} /></td>
                  <td className={CELL}><Cell value={c.state} onChange={(v) => patch(i, { state: v })} /></td>
                  <td className={CELL}><Cell value={c.tags} onChange={(v) => patch(i, { tags: v })} /></td>
                  <td className={cn(CELL, SINGL)}>
                    <NativeSelect
                      size="sm"
                      value={c.mode}
                      onChange={(e) => patch(i, { mode: e.target.value as UiTestCase["mode"] })}
                    >
                      <NativeSelectOption value="">Suite ({suiteMode})</NativeSelectOption>
                      <NativeSelectOption value="headless">Headless</NativeSelectOption>
                      <NativeSelectOption value="headed">Headed</NativeSelectOption>
                    </NativeSelect>
                  </td>
                  <td className={cn(CELL, "pt-2")}><CaseStatusChip status={c.status} /></td>
                  <td className={cn(CELL, "pt-2 break-words text-muted-foreground")}>{c.reason}</td>
                  <td className={cn(CELL, "pt-2 whitespace-nowrap text-muted-foreground")}>{formatMs(c.lastRunAt)}</td>
                  <td className={cn(CELL, "pt-2")}>
                    {c.chatId ? (
                      <button type="button" className="text-primary hover:underline" onClick={() => onOpenTranscript(c.chatId)}>
                        Open
                      </button>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </td>
                  <td className={CELL}>
                    <div className="flex">
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        title="Add step"
                        onClick={() => {
                          setSteps(i, [...c.steps, { action: "", expected: "" }])
                          setCollapsed((s) => toggle(s, c.id, false))
                        }}
                      >
                        <IconPlus />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        title="Delete case"
                        onClick={async () => {
                          if (!(await askConfirm(`Delete the case "${c.title}"?`))) return
                          onChange(cases.filter((_, j) => j !== i))
                          onSelect(toggle(selected, c.id, false))
                        }}
                      >
                        <IconTrash />
                      </Button>
                    </div>
                  </td>
                </tr>
                {open &&
                  c.steps.map((s, k) => {
                    if (compact && k === 0) return null
                    const res = c.stepResults.find((r) => r.step === k + 1)
                    const move = (to: number) => {
                      const next = [...c.steps]
                      const tmp = next[k]
                      next[k] = next[to]
                      next[to] = tmp
                      setSteps(i, next)
                    }
                    const edit = (part: Partial<UiTestStep>) =>
                      setSteps(i, c.steps.map((x, j) => (j === k ? { ...x, ...part } : x)))
                    return (
                      <tr key={k}>
                        <td className={CELL} />
                        <td className={CELL} />
                        <td className={CELL} />
                        <td className={cn(CELL, "pt-2 text-muted-foreground")}>{k + 1}</td>
                        <td className={CELL}>
                          <Cell multiline value={s.action} placeholder="Step action" onChange={(v) => edit({ action: v })} />
                        </td>
                        <td className={CELL}>
                          <Cell multiline value={s.expected} placeholder="Expected result" onChange={(v) => edit({ expected: v })} />
                        </td>
                        <td className={CELL} />
                        <td className={CELL} />
                        <td className={CELL} />
                        <td className={CELL} />
                        <td className={cn(CELL, SINGL)} />
                        <td className={cn(CELL, "pt-2")}><StepResultChip result={res} /></td>
                        <td className={cn(CELL, "pt-2 break-words text-muted-foreground")}>{res?.note}</td>
                        <td className={CELL} />
                        <td className={CELL} />
                        <td className={CELL}>
                          <div className="flex">
                            <Button variant="ghost" size="icon-xs" title="Move up" disabled={k === 0} onClick={() => move(k - 1)}>
                              <IconArrowUp />
                            </Button>
                            <Button variant="ghost" size="icon-xs" title="Move down" disabled={k === c.steps.length - 1} onClick={() => move(k + 1)}>
                              <IconArrowDown />
                            </Button>
                            <Button variant="ghost" size="icon-xs" title="Delete step" onClick={() => setSteps(i, c.steps.filter((_, j) => j !== k))}>
                              <IconTrash />
                            </Button>
                          </div>
                        </td>
                      </tr>
                    )
                  })}
              </Fragment>
            )
          })}
          {cases.length === 0 && (
            <tr>
              <td colSpan={16} className="px-3 py-6 text-center text-muted-foreground">
                No test cases yet. Add one or import an Azure CSV.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  )
}
