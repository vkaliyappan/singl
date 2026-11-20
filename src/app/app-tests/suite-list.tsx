"use client"

import { useState } from "react"
import { IconCopy, IconPlus, IconSearch, IconTrash } from "@tabler/icons-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import type { UiTestSuite } from "@/lib/ui-tests"
import { cn } from "@/lib/utils"

export type SuiteStats = { passed: number; failed: number; total: number }

/** Left panel: every suite with its environment, size and last known verdict counts. */
export function SuiteList({
  suites,
  activeId,
  unsaved,
  stats,
  onPick,
  onNew,
  onDuplicate,
  onDelete,
  disabled,
}: {
  suites: UiTestSuite[]
  activeId: string
  /** A new, not yet created suite is open. */
  unsaved: boolean
  stats: Record<string, SuiteStats>
  onPick: (id: string) => void
  onNew: () => void
  onDuplicate: (id: string) => void
  onDelete: (s: UiTestSuite) => void
  disabled: boolean
}) {
  const [q, setQ] = useState("")
  const needle = q.trim().toLowerCase()
  const shown = suites.filter((s) => !needle || `${s.name} ${s.envId}`.toLowerCase().includes(needle))

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-col gap-1.5 border-b p-2">
        <Button size="sm" onClick={onNew}>
          <IconPlus /> New suite
        </Button>
        <div className="relative">
          <IconSearch className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input className="h-7 pl-7 text-xs" placeholder="Search suites" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
        {unsaved && (
          <div className="mb-0.5 rounded-md bg-muted px-2 py-1.5 text-xs font-medium">
            New suite <span className="font-normal text-muted-foreground">(not created)</span>
          </div>
        )}
        {shown.map((s) => {
          const st = stats[s.id]
          const active = s.id === activeId
          return (
            <div
              key={s.id}
              className={cn("group relative mb-0.5 rounded-md hover:bg-muted", active && "bg-muted")}
            >
              <button type="button" onClick={() => onPick(s.id)} className="block w-full min-w-0 px-2 py-1.5 text-left text-xs">
                <span className={cn("block truncate pr-12", active && "font-medium")}>{s.name || "Untitled suite"}</span>
                <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                  <span className="truncate">{s.envId || "no environment"}</span>
                  <span>·</span>
                  <span className="whitespace-nowrap">{s.caseCount} cases</span>
                </span>
                {st && st.total > 0 && (
                  <span className="mt-0.5 flex items-center gap-1.5 text-[11px]">
                    <span className="text-emerald-700 dark:text-emerald-300">{st.passed} passed</span>
                    {st.failed > 0 && <span className="text-red-700 dark:text-red-300">{st.failed} failed</span>}
                  </span>
                )}
              </button>
              <div className="absolute top-1 right-1 hidden group-hover:flex">
                <Button variant="ghost" size="icon-xs" title="Duplicate" disabled={disabled} onClick={() => onDuplicate(s.id)}>
                  <IconCopy />
                </Button>
                <Button variant="ghost" size="icon-xs" title="Delete" disabled={disabled} onClick={() => onDelete(s)}>
                  <IconTrash />
                </Button>
              </div>
            </div>
          )
        })}
        {shown.length === 0 && !unsaved && (
          <p className="px-2 py-2 text-xs text-muted-foreground">{suites.length ? "No suites match." : "No suites yet."}</p>
        )}
      </div>
    </div>
  )
}
