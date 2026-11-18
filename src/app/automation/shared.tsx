"use client"

import { IconCheck, IconX } from "@tabler/icons-react"
import { Checkbox } from "@/components/ui/checkbox"
import { DataGrid, type GridColumn } from "@/components/data-grid"
import { formatTime, type RunRow } from "@/lib/automation"
import { cn } from "@/lib/utils"

export const FIELD = "flex flex-col gap-1 text-xs"
export const LABEL = "text-[11px] font-medium text-muted-foreground"

export function Field({ label, children, className }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <label className={cn(FIELD, className)}>
      <span className={LABEL}>{label}</span>
      {children}
    </label>
  )
}

export function ErrorNote({ message }: { message: string }) {
  if (!message) return null
  return <p className="rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive">{message}</p>
}

/** Check boxes for a set of environment names. */
export function EnvPicker({
  envs,
  value,
  onChange,
}: {
  envs: string[]
  value: string[]
  onChange: (next: string[]) => void
}) {
  if (envs.length === 0) return <p className="text-xs text-muted-foreground">No environments are enabled. Add one in Settings.</p>
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1.5">
      {envs.map((env) => (
        <label key={env} className="flex items-center gap-1.5 text-xs">
          <Checkbox
            checked={value.includes(env)}
            onCheckedChange={(on) => onChange(on ? [...value, env] : value.filter((e) => e !== env))}
          />
          {env}
        </label>
      ))}
    </div>
  )
}

export function PassIcon({ passed }: { passed: boolean }) {
  return passed ? (
    <IconCheck className="size-4 text-emerald-600 dark:text-emerald-400" aria-label="passed" />
  ) : (
    <IconX className="size-4 text-red-600 dark:text-red-400" aria-label="failed" />
  )
}

const TONES: Record<string, string> = {
  passed: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  ok: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  same: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  failed: "bg-red-500/15 text-red-700 dark:text-red-300",
  error: "bg-red-500/15 text-red-700 dark:text-red-300",
  drift: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
}

export function StatusPill({ status }: { status: string | null }) {
  if (!status) return <span className="text-muted-foreground">—</span>
  return (
    <span className={cn("inline-flex h-5 items-center rounded-full px-2 text-[0.625rem] font-medium", TONES[status] ?? "bg-muted")}>
      {status}
    </span>
  )
}

export const seconds = (ms: number) => (ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`)

const RUN_COLUMNS: GridColumn<RunRow>[] = [
  { key: "status", label: "Status", kind: "text", width: 100, value: (r) => r.status, render: (r) => <StatusPill status={r.status} /> },
  { key: "name", label: "Name", kind: "text", width: 200, hidden: true },
  { key: "summary", label: "Summary", kind: "text", width: 420 },
  { key: "startedAt", label: "Started", kind: "date", width: 170, render: (r) => <span className="whitespace-nowrap">{formatTime(r.startedAt)}</span> },
  { key: "durationMs", label: "Duration", kind: "number", width: 100, render: (r) => seconds(r.durationMs) },
]

/** Past runs; clicking a row reopens it. */
export function RunHistory({ id, rows, onOpen, showName }: { id: string; rows: RunRow[]; onOpen: (r: RunRow) => void; showName?: boolean }) {
  const columns = showName ? RUN_COLUMNS.map((c) => (c.key === "name" ? { ...c, hidden: false } : c)) : RUN_COLUMNS
  return (
    <DataGrid
      id={id}
      columns={columns}
      rows={rows}
      rowKey={(r) => r.id}
      onRowClick={onOpen}
      initialSort={{ key: "startedAt", dir: "desc" }}
      searchable={rows.length > 8}
      pageSize={25}
      csvName={id}
    />
  )
}
