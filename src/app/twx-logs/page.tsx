"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { IconRefresh } from "@tabler/icons-react"
import { PageHeader } from "@/components/page-header"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { Switch } from "@/components/ui/switch"
import { isTauri } from "@/lib/clock-widget"
import { useAssistantAction, useAssistantContext } from "@/lib/assistant/context"
import { usePinnables } from "@/lib/assistant/pins"
import { errorMessage, listEnvironments } from "@/lib/settings"
import { LEVELS, LOGS, queryLogs, type LogName, type LogQuery, type LogRow } from "@/lib/twx-logs"
import { LogTable, rowKey } from "./log-table"

const MAX_ROWS = 1000
const LIMIT = 200
const POLL_MS = 5000
const PRESETS = { "15m": 15, "1h": 60, "24h": 1440 } as const
type Preset = keyof typeof PRESETS | "custom"

type Filters = {
  env: string
  log: LogName
  search: string
  level: string
  origin: string
  user: string
  preset: Preset
  from: string
  to: string
}

const dateMs = (s: string) => (s ? new Date(s).getTime() : undefined)

function toQuery(f: Filters): LogQuery {
  return {
    log: f.log,
    search: f.search,
    level: f.level || undefined,
    origin: f.origin,
    user: f.user,
    since: f.preset === "custom" ? dateMs(f.from) : Date.now() - PRESETS[f.preset] * 60_000,
    until: f.preset === "custom" ? dateMs(f.to) : undefined,
    limit: LIMIT,
  }
}

export default function TwxLogsPage() {
  const [envs, setEnvs] = useState<string[]>([])
  const [f, setF] = useState<Filters>({
    env: "",
    log: "ApplicationLog",
    search: "",
    level: "",
    origin: "",
    user: "",
    preset: "1h",
    from: "",
    to: "",
  })
  const [rows, setRows] = useState<LogRow[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")
  const [live, setLive] = useState(false)
  const [searched, setSearched] = useState(false)
  const rowsRef = useRef(rows)
  const filtersRef = useRef(f)
  const busy = useRef(false)

  useEffect(() => {
    rowsRef.current = rows
    filtersRef.current = f
  })

  const load = useCallback(async (next: Filters) => {
    if (!next.env) return
    setLoading(true)
    setError("")
    try {
      setRows(await queryLogs(next.env, toQuery(next)))
      setSearched(true)
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setLoading(false)
    }
  }, [])

  // Applies a change, and by default runs the query with it.
  const update = (patch: Partial<Filters>, run = true) => {
    const next = { ...f, ...patch }
    setF(next)
    if (run) void load(next)
  }

  useEffect(() => {
    if (!isTauri()) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setError("Logs run in the desktop app. Open Singl through Tauri to use them.")
      return
    }
    listEnvironments()
      .then((envRows) => {
        const names = envRows.filter((e) => e.enabled).map((e) => e.environment)
        setEnvs(names)
        if (names[0]) {
          const next = { ...filtersRef.current, env: names[0] }
          setF(next)
          void load(next)
        }
      })
      .catch((err) => setError(errorMessage(err)))
  }, [load])

  // Live tail: every 5s fetch what is newer than the newest row on screen,
  // paused while the window is hidden and stopped on unmount.
  useEffect(() => {
    if (!live) return
    const tick = async () => {
      if (document.hidden || busy.current) return
      const cur = filtersRef.current
      if (!cur.env) return
      busy.current = true
      try {
        const q = toQuery(cur)
        q.until = undefined
        q.since = rowsRef.current[0]?.timestamp ?? q.since
        const fresh = await queryLogs(cur.env, q)
        const seen = new Set(rowsRef.current.map(rowKey))
        const add = fresh.filter((r) => !seen.has(rowKey(r)))
        if (add.length) setRows((old) => [...add, ...old].slice(0, MAX_ROWS))
        setError("")
      } catch (err) {
        setError(errorMessage(err))
      } finally {
        busy.current = false
      }
    }
    const id = setInterval(tick, POLL_MS)
    return () => clearInterval(id)
  }, [live])

  const trimmed = (r: LogRow) => ({
    time: new Date(r.timestamp).toISOString(),
    level: r.level,
    origin: r.origin,
    user: r.user,
    message: r.message.slice(0, 160),
  })
  const levelCounts: Record<string, number> = {}
  for (const r of rows) levelCounts[r.level] = (levelCounts[r.level] ?? 0) + 1
  useAssistantContext({
    screen: "twx-logs",
    title: "ThingWorx logs",
    summary: `${f.log} on ${f.env || "no environment"} · ${rows.length} entries${live ? " · live" : ""}`,
    data: {
      env: f.env,
      log: f.log,
      level: f.level,
      search: f.search,
      origin: f.origin,
      user: f.user,
      range: f.preset === "custom" ? { from: f.from, to: f.to } : f.preset,
      live,
      loading,
      error,
      count: rows.length,
      levelCounts,
      rows: rows.slice(0, 12).map(trimmed),
    },
  })
  usePinnables(
    rows.length
      ? [
          {
            kind: "log",
            label: `${f.log} · ${f.env}`,
            detail: `${rows.length} entries`,
            content: () => JSON.stringify(rows.slice(0, 40).map(trimmed), null, 1).slice(0, 6000),
          },
        ]
      : [],
  )
  useAssistantAction(
    "set_log_filters",
    {
      description:
        "Set the log filters and run the search. Fields are all optional: env, log (ApplicationLog|ScriptLog|ErrorLog|SecurityLog|CommunicationLog|ConfigurationLog), level (minimum: TRACE|DEBUG|INFO|WARN|ERROR or empty), search, origin, user, range (15m|1h|24h).",
      inputSchema: {
        type: "object",
        properties: {
          env: { type: "string" },
          log: { type: "string", enum: [...LOGS] },
          level: { type: "string" },
          search: { type: "string" },
          origin: { type: "string" },
          user: { type: "string" },
          range: { type: "string", enum: ["15m", "1h", "24h"] },
        },
      },
    },
    async (args) => {
      const a = args as Record<string, string | undefined>
      const patch: Partial<Filters> = {}
      if (a.env !== undefined) {
        if (!envs.includes(a.env)) throw new Error(`Unknown environment "${a.env}".`)
        patch.env = a.env
      }
      if (a.log !== undefined) {
        if (!(LOGS as readonly string[]).includes(a.log)) throw new Error(`Unknown log "${a.log}".`)
        patch.log = a.log as LogName
      }
      if (a.level !== undefined) patch.level = a.level.toUpperCase()
      if (a.search !== undefined) patch.search = a.search
      if (a.origin !== undefined) patch.origin = a.origin
      if (a.user !== undefined) patch.user = a.user
      if (a.range !== undefined) {
        if (!(a.range in PRESETS)) throw new Error("range must be 15m, 1h or 24h.")
        patch.preset = a.range as Preset
      }
      const next = { ...f, ...patch }
      setF(next)
      if (!next.env) throw new Error("No environment selected.")
      setLoading(true)
      setError("")
      try {
        const got = await queryLogs(next.env, toQuery(next))
        setRows(got)
        setSearched(true)
        return { count: got.length, filters: { log: next.log, level: next.level, search: next.search, range: next.preset } }
      } finally {
        setLoading(false)
      }
    },
  )
  useAssistantAction(
    "toggle_live_tail",
    {
      description: "Turn live tail on or off (omit `on` to toggle).",
      inputSchema: { type: "object", properties: { on: { type: "boolean" } } },
    },
    (args) => {
      const on = (args as { on?: boolean }).on
      const next = typeof on === "boolean" ? on : !live
      setLive(next)
      return { live: next }
    },
  )

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    void load(f)
  }

  const note =
    rows.length >= MAX_ROWS
      ? ` (showing the newest ${MAX_ROWS})`
      : rows.length >= LIMIT && !live
        ? " (first page; narrow the filters for more)"
        : ""

  return (
    <div className="flex flex-col gap-5 p-8">
      <PageHeader
        title="ThingWorx logs"
        description="Search a server's logs, or tail them live."
        actions={
          <>
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <Switch checked={live} onCheckedChange={setLive} />
              Live tail
            </label>
            <Button size="sm" variant="outline" onClick={() => void load(f)} disabled={loading || !f.env}>
              <IconRefresh data-icon="inline-start" />
              Refresh
            </Button>
          </>
        }
      />

      <form onSubmit={onSubmit} className="flex flex-wrap items-center gap-2">
        <NativeSelect value={f.env} onChange={(e) => update({ env: e.target.value })} aria-label="Environment">
          {envs.length === 0 && <NativeSelectOption value="">No environment</NativeSelectOption>}
          {envs.map((e) => (
            <NativeSelectOption key={e} value={e}>
              {e}
            </NativeSelectOption>
          ))}
        </NativeSelect>
        <NativeSelect value={f.log} onChange={(e) => update({ log: e.target.value as LogName })} aria-label="Log">
          {LOGS.map((l) => (
            <NativeSelectOption key={l} value={l}>
              {l}
            </NativeSelectOption>
          ))}
        </NativeSelect>
        <NativeSelect value={f.level} onChange={(e) => update({ level: e.target.value })} aria-label="Minimum level">
          <NativeSelectOption value="">Any level</NativeSelectOption>
          {LEVELS.map((l) => (
            <NativeSelectOption key={l} value={l}>
              {l} and above
            </NativeSelectOption>
          ))}
        </NativeSelect>
        <NativeSelect
          value={f.preset}
          onChange={(e) => update({ preset: e.target.value as Preset }, e.target.value !== "custom")}
          aria-label="Time range"
        >
          <NativeSelectOption value="15m">Last 15 minutes</NativeSelectOption>
          <NativeSelectOption value="1h">Last hour</NativeSelectOption>
          <NativeSelectOption value="24h">Last 24 hours</NativeSelectOption>
          <NativeSelectOption value="custom">Custom range</NativeSelectOption>
        </NativeSelect>
        {f.preset === "custom" && (
          <>
            <Input
              type="datetime-local"
              className="w-48"
              value={f.from}
              onChange={(e) => update({ from: e.target.value }, false)}
              aria-label="From"
            />
            <Input
              type="datetime-local"
              className="w-48"
              value={f.to}
              onChange={(e) => update({ to: e.target.value }, false)}
              aria-label="To"
            />
          </>
        )}
        <Input
          className="w-56"
          placeholder="Search message…"
          value={f.search}
          onChange={(e) => update({ search: e.target.value }, false)}
        />
        <Input
          className="w-44"
          placeholder="Origin / thing"
          value={f.origin}
          onChange={(e) => update({ origin: e.target.value }, false)}
        />
        <Input
          className="w-36"
          placeholder="User"
          value={f.user}
          onChange={(e) => update({ user: e.target.value }, false)}
        />
        <Button type="submit" size="sm" disabled={loading || !f.env}>
          Search
        </Button>
      </form>

      {error && (
        <p className="rounded-xl border border-destructive/20 bg-destructive/10 px-4 py-3 text-xs text-destructive">
          {error}
        </p>
      )}

      {rows.length > 0 ? (
        <>
          <p className="text-xs text-muted-foreground">
            {rows.length} {rows.length === 1 ? "entry" : "entries"}
            {note}
            {live && " · live"}
          </p>
          <LogTable rows={rows} />
        </>
      ) : (
        !error &&
        searched &&
        !loading && (
          <p className="rounded-xl border bg-card px-4 py-8 text-center text-xs text-muted-foreground">
            No log entries match these filters.
          </p>
        )
      )}
    </div>
  )
}
