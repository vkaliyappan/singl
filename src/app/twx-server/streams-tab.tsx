"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { IconPlayerPlay } from "@tabler/icons-react"
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { DataGrid, columnsFromFields } from "@/components/data-grid"
import { searchEntities } from "@/lib/services"
import { useAssistantAction, useAssistantContext } from "@/lib/assistant/context"
import { usePinnables } from "@/lib/assistant/pins"
import { errorMessage } from "@/lib/settings"
import {
  listLoggedProperties,
  listStreams,
  queryStream,
  type LoggedProperty,
  type QueryResult,
  type StreamList,
} from "@/lib/twx-admin"

const RANGES = [
  { value: "1h", label: "Last hour" },
  { value: "24h", label: "Last 24 hours" },
  { value: "7d", label: "Last 7 days" },
  { value: "30d", label: "Last 30 days" },
  { value: "", label: "Any time" },
  { value: "custom", label: "Custom" },
]
const COLORS = ["#3b82f6", "#f59e0b", "#10b981", "#ef4444", "#8b5cf6", "#06b6d4", "#ec4899", "#84cc16"]
const TIME_COLUMNS = ["timestamp", "time"]

type Mode = "stream" | "history"

function ResultTable({ result }: { result: QueryResult }) {
  const columns = useMemo(() => columnsFromFields<Record<string, unknown>>(result.columns), [result.columns])
  return (
    <DataGrid
      id={`twx-server-stream:${result.columns.map((c) => c.name).join("|").slice(0, 120)}`}
      columns={columns}
      rows={result.rows as Record<string, unknown>[]}
      maxHeight={448}
      pageSize={100}
      csvName="stream"
    />
  )
}

/** `datetime-local` text as an ISO instant. */
const toIso = (local: string) => (local ? new Date(local).toISOString() : undefined)

function numericColumns(result: QueryResult) {
  return result.columns
    .filter((c) => c.baseType !== "DATETIME" && !TIME_COLUMNS.includes(c.name))
    .filter((c) => {
      const values = result.rows.map((r) => r[c.name]).filter((v) => v != null && v !== "")
      return values.length > 0 && values.every((v) => typeof v === "number")
    })
    .map((c) => c.name)
}

function ResultChart({ result }: { result: QueryResult }) {
  const time = result.columns.find((c) => TIME_COLUMNS.includes(c.name))?.name
  const ys = useMemo(() => numericColumns(result), [result])
  const data = useMemo(
    () => (time ? [...result.rows].sort((a, b) => Number(a[time]) - Number(b[time])) : result.rows),
    [result, time],
  )
  if (!time || !ys.length || data.length < 2) return null
  return (
    <div className="h-64 rounded-xl border bg-card p-3">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data}>
          <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" />
          <XAxis
            dataKey={time}
            type="number"
            scale="time"
            domain={["dataMin", "dataMax"]}
            tickFormatter={(v) => new Date(v).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
            tick={{ fontSize: 10, fill: "var(--muted-foreground)" }}
          />
          <YAxis tick={{ fontSize: 10, fill: "var(--muted-foreground)" }} width={48} />
          <Tooltip
            labelFormatter={(v) => new Date(Number(v)).toLocaleString()}
            contentStyle={{ background: "var(--popover)", border: "1px solid var(--border)", borderRadius: 8, fontSize: 11 }}
          />
          {ys.length > 1 && <Legend wrapperStyle={{ fontSize: 11 }} />}
          {ys.map((y, i) => (
            <Line key={y} dataKey={y} stroke={COLORS[i % COLORS.length]} dot={data.length < 60} strokeWidth={1.5} isAnimationActive={false} />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}

export function StreamsTab({ env }: { env: string }) {
  const [mode, setMode] = useState<Mode>("stream")
  const [streams, setStreams] = useState<StreamList | null>(null)
  const [things, setThings] = useState<string[]>([])
  const [stream, setStream] = useState("")
  const [thing, setThing] = useState("")
  const [properties, setProperties] = useState<LoggedProperty[]>([])
  const [property, setProperty] = useState("")
  const [range, setRange] = useState("24h")
  const [from, setFrom] = useState("")
  const [to, setTo] = useState("")
  const [maxItems, setMaxItems] = useState("200")
  const [oldestFirst, setOldestFirst] = useState(false)
  const [result, setResult] = useState<QueryResult | null>(null)
  const [error, setError] = useState("")
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    listStreams(env)
      .then((list) => {
        setStreams(list)
        const first = list.streams.find((s) => !s.system) ?? list.streams[0]
        if (first) setStream(first.name)
      })
      .catch((err) => setError(errorMessage(err)))
    searchEntities(env, "Things")
      .then((rows) => setThings(rows.map((r) => r.name)))
      .catch(() => {})
  }, [env])

  function pickThing(name: string) {
    setThing(name)
    setProperty("")
    setProperties([])
    if (!things.includes(name)) return
    listLoggedProperties(env, name)
      .then((props) => {
        setProperties(props)
        if (props[0]) setProperty(props[0].name)
      })
      .catch((err) => setError(errorMessage(err)))
  }

  function run(over?: { mode: Mode; stream?: string; thing?: string; property?: string; range?: string; maxItems?: number }) {
    setLoading(true)
    setError("")
    const m = over?.mode ?? mode
    const r = over?.range ?? range
    const custom = r === "custom"
    return queryStream(env, {
      ...(m === "stream" ? { stream: over?.stream ?? stream } : { thing: over?.thing ?? thing, property: over?.property ?? property }),
      since: custom ? toIso(from) : r || undefined,
      until: custom ? toIso(to) : undefined,
      maxItems: Math.max(1, over?.maxItems ?? (Number(maxItems) || 200)),
      oldestFirst,
    })
      .then((res) => {
        setResult(res)
        return res
      })
      .catch((err) => {
        setResult(null)
        setError(errorMessage(err))
        throw err
      })
      .finally(() => setLoading(false))
  }

  const streamsRef = useRef(streams)
  useEffect(() => {
    streamsRef.current = streams
  })
  useAssistantContext({
    screen: "twx-server",
    data: {
      streams: {
        mode,
        stream,
        thing,
        property,
        range,
        maxItems,
        streamCount: streams?.streams.length ?? null,
        error,
        resultRows: result?.rows.length ?? null,
        columns: result?.columns.map((c) => c.name).slice(0, 30),
        rows: result?.rows.slice(0, 10).map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === "string" ? v.slice(0, 80) : v]))) ?? [],
      },
    },
  })
  usePinnables(
    result
      ? [
          {
            kind: "stream",
            label: `Stream · ${mode === "stream" ? stream : `${thing}.${property}`}`,
            detail: `${result.rows.length} rows`,
            content: () => JSON.stringify({ source: result.source, columns: result.columns.map((c) => c.name), rows: result.rows.slice(0, 50) }).slice(0, 8000),
          },
        ]
      : [],
  )
  useAssistantAction(
    "select_stream",
    {
      description:
        "On the Streams tab, query a stream's entries (`stream`) or a logged property's value-stream history (`thing` + `property`) and show the result. range: 1h|24h|7d|30d or empty for any time (default 24h).",
      inputSchema: {
        type: "object",
        properties: {
          stream: { type: "string" },
          thing: { type: "string" },
          property: { type: "string" },
          range: { type: "string" },
          maxItems: { type: "number" },
        },
      },
    },
    async (args) => {
      const a = args as { stream?: string; thing?: string; property?: string; range?: string; maxItems?: number }
      const r = a.range ?? "24h"
      setRange(r)
      if (a.maxItems) setMaxItems(String(a.maxItems))
      let res: QueryResult
      if (a.stream) {
        for (let i = 0; i < 30 && !streamsRef.current; i++) await new Promise((x) => setTimeout(x, 100))
        if (!streamsRef.current?.streams.some((s) => s.name === a.stream)) throw new Error(`No stream "${a.stream}" on ${env}.`)
        setMode("stream")
        setStream(a.stream)
        res = await run({ mode: "stream", stream: a.stream, range: r, maxItems: a.maxItems })
      } else if (a.thing && a.property) {
        setMode("history")
        pickThing(a.thing)
        setProperty(a.property)
        res = await run({ mode: "history", thing: a.thing, property: a.property, range: r, maxItems: a.maxItems })
      } else throw new Error("Give a stream, or a thing and property.")
      return { source: res.source, rows: res.rows.length, maybeMore: res.maybeMore, columns: res.columns.map((c) => c.name), sample: res.rows.slice(0, 5) }
    },
  )

  const ready = mode === "stream" ? !!stream : !!thing && !!property
  const userStreams = streams?.streams.filter((s) => !s.system) ?? []
  const systemStreams = streams?.streams.filter((s) => s.system) ?? []

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-3 rounded-xl border bg-card p-3">
        <label className="flex flex-col gap-1 text-[11px] text-muted-foreground">
          Source
          <NativeSelect value={mode} onChange={(e) => setMode(e.target.value as Mode)}>
            <NativeSelectOption value="stream">Stream entries</NativeSelectOption>
            <NativeSelectOption value="history">Value stream history</NativeSelectOption>
          </NativeSelect>
        </label>

        {mode === "stream" ? (
          <label className="flex flex-col gap-1 text-[11px] text-muted-foreground">
            Stream
            <NativeSelect value={stream} onChange={(e) => setStream(e.target.value)}>
              {!streams && <NativeSelectOption value="">Loading...</NativeSelectOption>}
              {userStreams.length > 0 && (
                <optgroup label="Streams">
                  {userStreams.map((s) => (
                    <NativeSelectOption key={s.name} value={s.name}>
                      {s.name}
                    </NativeSelectOption>
                  ))}
                </optgroup>
              )}
              {systemStreams.length > 0 && (
                <optgroup label="System streams">
                  {systemStreams.map((s) => (
                    <NativeSelectOption key={s.name} value={s.name}>
                      {s.name}
                    </NativeSelectOption>
                  ))}
                </optgroup>
              )}
            </NativeSelect>
          </label>
        ) : (
          <>
            <label className="flex flex-col gap-1 text-[11px] text-muted-foreground">
              Thing
              <Input className="w-56" list="twx-things" placeholder="Thing name" value={thing} onChange={(e) => pickThing(e.target.value)} />
              <datalist id="twx-things">
                {things.map((t) => (
                  <option key={t} value={t} />
                ))}
              </datalist>
            </label>
            <label className="flex flex-col gap-1 text-[11px] text-muted-foreground">
              Logged property
              <NativeSelect value={property} onChange={(e) => setProperty(e.target.value)} disabled={!properties.length}>
                {!properties.length && <NativeSelectOption value="">{thing ? "No logged properties" : "Pick a thing"}</NativeSelectOption>}
                {properties.map((p) => (
                  <NativeSelectOption key={p.name} value={p.name}>
                    {p.name} ({p.baseType})
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </label>
          </>
        )}

        <label className="flex flex-col gap-1 text-[11px] text-muted-foreground">
          Time range
          <NativeSelect value={range} onChange={(e) => setRange(e.target.value)}>
            {RANGES.map((r) => (
              <NativeSelectOption key={r.value} value={r.value}>
                {r.label}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </label>
        {range === "custom" && (
          <>
            <label className="flex flex-col gap-1 text-[11px] text-muted-foreground">
              From
              <Input type="datetime-local" value={from} onChange={(e) => setFrom(e.target.value)} />
            </label>
            <label className="flex flex-col gap-1 text-[11px] text-muted-foreground">
              To
              <Input type="datetime-local" value={to} onChange={(e) => setTo(e.target.value)} />
            </label>
          </>
        )}
        <label className="flex flex-col gap-1 text-[11px] text-muted-foreground">
          Max items
          <Input className="w-24" type="number" min={1} max={5000} value={maxItems} onChange={(e) => setMaxItems(e.target.value)} />
        </label>
        <label className="flex items-center gap-1.5 pb-1.5 text-xs">
          <input type="checkbox" checked={oldestFirst} onChange={(e) => setOldestFirst(e.target.checked)} /> Oldest first
        </label>
        <Button size="sm" onClick={() => void run().catch(() => {})} disabled={!ready || loading}>
          <IconPlayerPlay /> {loading ? "Querying..." : "Query"}
        </Button>
      </div>

      {error && <p className="rounded-xl border border-red-500/40 bg-red-500/5 px-4 py-3 text-xs">{error}</p>}

      {result && (
        <>
          <p className="text-xs text-muted-foreground">
            {result.source}: {result.rows.length.toLocaleString()} rows
            {result.maybeMore && " (there may be more, raise Max items or narrow the time range)"}
          </p>
          <ResultChart result={result} />
          {result.rows.length > 0 && (
            <ResultTable result={result} />
          )}
        </>
      )}
    </div>
  )
}
