"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { IconCopy, IconMessagePlus } from "@tabler/icons-react"
import { toast } from "sonner"
import { cn } from "@/lib/utils"
import { DataGrid, type GridColumn } from "@/components/data-grid"
import type { LogRow } from "@/lib/twx-logs"
import { addPins } from "@/lib/assistant/pins"

const LEVEL_STYLE: Record<string, string> = {
  ERROR: "bg-destructive/15 text-destructive",
  WARN: "bg-warning/15 text-warning",
  INFO: "bg-info/15 text-info",
}

export function LevelBadge({ level }: { level: string }) {
  return (
    <span
      className={cn(
        "inline-block w-12 rounded px-1.5 py-0.5 text-center text-xs font-semibold",
        LEVEL_STYLE[level] ?? "bg-muted text-muted-foreground",
      )}
    >
      {level || "?"}
    </span>
  )
}

export function rowKey(r: LogRow) {
  return `${r.timestamp}|${r.level}|${r.thread}|${r.origin}|${r.message}`
}

const time = (ms: number) => {
  const d = new Date(ms)
  const p = (n: number, w = 2) => String(n).padStart(w, "0")
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`
}

function copyRow(r: LogRow) {
  const head = [time(r.timestamp), r.level, r.origin, r.thread, r.user].filter(Boolean).join(" | ")
  navigator.clipboard.writeText(`${head}\n${r.message}`).then(
    () => toast.success("Copied log entry"),
    () => toast.error("Could not copy"),
  )
}

const COLUMNS: GridColumn<LogRow>[] = [
  {
    key: "timestamp",
    label: "Time",
    kind: "date",
    width: 220,
    render: (r) => <span className="tabular font-mono text-xs whitespace-nowrap text-muted-foreground">{time(r.timestamp)}</span>,
  },
  { key: "level", label: "Level", kind: "text", width: 112, value: (r) => r.level || "?", render: (r) => <LevelBadge level={r.level} /> },
  { key: "message", label: "Message", kind: "text", width: 520, maxWidthRem: 40, render: (r) => <span className="block truncate font-mono text-xs">{firstLine(r.message)}</span> },
  { key: "origin", label: "Origin", kind: "text", width: 200 },
  { key: "thread", label: "Thread", kind: "text", width: 140, hidden: true },
  { key: "user", label: "User", kind: "text", width: 110 },
  { key: "instance", label: "Instance", kind: "text", width: 110, hidden: true },
]

const firstLine = (m: string) => {
  const i = m.indexOf("\n")
  return i < 0 ? m : `${m.slice(0, i)} …`
}

function Detail({ r }: { r: LogRow }) {
  return (
    <div className="flex items-start gap-2 px-3 py-2">
      <pre
        className={cn(
          "min-w-0 flex-1 font-mono text-xs break-words whitespace-pre-wrap",
          (r.level === "DEBUG" || r.level === "TRACE") && "text-muted-foreground",
        )}
      >
        {r.message}
      </pre>
      <button
        type="button"
        aria-label="Add to chat"
        title="Add to chat"
        onClick={() =>
          addPins([
            {
              kind: "log",
              label: `${r.level} · ${r.origin || "log"} · ${time(r.timestamp)}`,
              screen: "twx-logs",
              detail: r.message.slice(0, 40),
              content: `${[time(r.timestamp), r.level, r.origin, r.thread, r.user].filter(Boolean).join(" | ")}
${r.message.slice(0, 4000)}`,
            },
          ])
        }
        className="shrink-0 rounded text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/30 focus-visible:outline-none"
      >
        <IconMessagePlus className="size-3.5" />
      </button>
      <button
        type="button"
        aria-label="Copy entry"
        onClick={() => copyRow(r)}
        className="shrink-0 rounded text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/30 focus-visible:outline-none"
      >
        <IconCopy className="size-3.5" />
      </button>
    </div>
  )
}

export function LogTable({ rows }: { rows: LogRow[] }) {
  // Identical lines can repeat, so a counter keeps each key unique without
  // tying it to the row's position (live tail prepends rows).
  const keys = useMemo(() => {
    const seen = new Map<string, number>()
    const out = new Map<LogRow, string>()
    for (const r of rows) {
      const base = rowKey(r)
      const n = seen.get(base) ?? 0
      seen.set(base, n + 1)
      out.set(r, `${base}|${n}`)
    }
    return out
  }, [rows])

  // Fit the table to the window so it scrolls in its own box: the sideways
  // scrollbar then sits on screen instead of below hundreds of rows.
  const boxRef = useRef<HTMLDivElement>(null)
  const [maxHeight, setMaxHeight] = useState<number>()
  useEffect(() => {
    const fit = () => {
      const top = boxRef.current?.getBoundingClientRect().top ?? 0
      // Leaves room for the toolbar, the pager and the page's bottom padding.
      setMaxHeight(Math.max(320, Math.round(window.innerHeight - Math.max(top, 0) - 150)))
    }
    fit()
    window.addEventListener("resize", fit)
    return () => window.removeEventListener("resize", fit)
  }, [])

  return (
    <div ref={boxRef}>
      <DataGrid
        id="twx-logs"
        columns={COLUMNS}
        rows={rows}
        rowKey={(r) => keys.get(r) ?? ""}
        renderRowDetail={(r) => <Detail r={r} />}
        initialSort={{ key: "timestamp", dir: "desc" }}
        pageSize={100}
        csvName="twx-logs"
        searchPlaceholder="Search entries…"
        emptyText="No log entries"
        maxHeight={maxHeight}
      />
    </div>
  )
}
