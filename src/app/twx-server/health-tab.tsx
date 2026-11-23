"use client"

import { useCallback, useEffect, useState } from "react"
import { IconPlugConnected, IconRefresh } from "@tabler/icons-react"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { DataGrid, type GridColumn } from "@/components/data-grid"
import { errorMessage } from "@/lib/settings"
import { useAssistantContext } from "@/lib/assistant/context"
import { usePinnables } from "@/lib/assistant/pins"
import {
  formatBytes,
  formatDuration,
  getServerHealth,
  listConnectors,
  pingServer,
  testConnector,
  type ConnectorInfo,
  type ConnectorTest,
  type Ping,
  type ServerHealth,
} from "@/lib/twx-admin"
import { cn } from "@/lib/utils"

type Level = "ok" | "warn" | "bad" | "none"

const LEVEL: Record<Level, string> = {
  ok: "border-success/30 bg-success/10",
  warn: "border-warning/30 bg-warning/10",
  bad: "border-destructive/30 bg-destructive/10",
  none: "border-border bg-card",
}

function Stat({ label, value, sub, level = "none" }: { label: string; value: string; sub?: string; level?: Level }) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-0.5 rounded-xl border px-3.5 py-2.5", LEVEL[level])}>
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="truncate text-base font-semibold tracking-tight">{value}</span>
      {sub && <span className="truncate text-xs text-muted-foreground">{sub}</span>}
    </div>
  )
}

const n = (v: number | null | undefined) => (v == null ? "-" : v.toLocaleString())

type Tests = Record<string, ConnectorTest | "running">

const DOT = { ok: "bg-success", bad: "bg-destructive", warn: "bg-warning", none: "bg-muted-foreground/40" }

/** What a connector's dot and label say: its test if run, else whether it is enabled. */
function connectorStatus(c: ConnectorInfo, test: Tests[string] | undefined): { dot: keyof typeof DOT; label: string; title?: string } {
  if (test === "running") return { dot: "none", label: "Testing..." }
  if (test) {
    const detail = [test.status, test.message].filter(Boolean).join(": ") || undefined
    return test.state === "ok"
      ? { dot: "ok", label: `Connected (${test.latencyMs} ms)`, title: detail }
      : test.state === "failed"
        ? { dot: "bad", label: "Failed", title: detail }
        : { dot: "none", label: test.status ?? "Unknown", title: detail }
  }
  if (c.enabled === false) return { dot: "warn", label: "Disabled" }
  return { dot: "none", label: "Not tested" }
}

type Subsystem = NonNullable<ServerHealth["subsystems"]>[number]
type Extension = NonNullable<ServerHealth["extensions"]>[number]

const SUBSYSTEM_COLS: GridColumn<Subsystem>[] = [
  { key: "name", label: "Name", kind: "text", width: 220, render: (s) => <span className="font-medium">{s.name}</span> },
  {
    key: "state",
    label: "State",
    kind: "text",
    width: 140,
    render: (s) => (
      <span className="inline-flex items-center gap-1.5">
        <span className={cn("size-1.5 rounded-full", s.running ? "bg-success" : "bg-destructive")} />
        {s.state}
      </span>
    ),
  },
  { key: "description", label: "Description", kind: "text", width: 420, truncate: false },
]

const EXTENSION_COLS: GridColumn<Extension>[] = [
  { key: "name", label: "Name", kind: "text", width: 280, render: (e) => <span className="font-medium">{e.name}</span> },
  { key: "version", label: "Version", kind: "text", width: 120 },
  { key: "vendor", label: "Vendor", kind: "text", width: 200 },
]

/** Integration connectors. Loaded on its own so the page does not wait for it; the state comes only from a Test click. */
function Connectors({ env }: { env: string }) {
  const [list, setList] = useState<ConnectorInfo[] | null>(null)
  const [error, setError] = useState("")
  const [tests, setTests] = useState<Tests>({})

  useEffect(() => {
    listConnectors(env)
      .then(setList)
      .catch((err) => setError(errorMessage(err)))
  }, [env])

  function test(name: string) {
    setTests((t) => ({ ...t, [name]: "running" }))
    testConnector(env, name)
      .then((r) => setTests((t) => ({ ...t, [name]: r })))
      .catch((err) => setTests((t) => ({ ...t, [name]: { state: "failed", status: null, message: errorMessage(err), latencyMs: 0 } })))
  }

  if (error) return <p className="rounded-xl border border-warning/30 bg-warning/10 px-4 py-3 text-xs">Connectors: {error}</p>
  if (!list) return <p className="flex items-center gap-2 text-xs text-muted-foreground"><Spinner className="size-3.5" /> Loading connectors…</p>
  if (!list.length) return null

  const enabled = list.filter((c) => c.enabled !== false)
  const results = Object.values(tests).filter((t) => t !== "running")
  const connected = results.filter((t) => t.state === "ok").length
  const failed = results.filter((t) => t.state === "failed").length
  const level: Level = failed ? "bad" : results.length && connected === results.length ? "ok" : "none"

  const columns: GridColumn<ConnectorInfo>[] = [
    {
      key: "name",
      label: "Name",
      kind: "text",
      width: 240,
      render: (c) => (
        <span className="font-medium" title={c.error ?? c.template ?? undefined}>
          {c.name}
          {c.error && <span className="ml-1.5 text-xs font-normal text-warning">partial</span>}
        </span>
      ),
    },
    { key: "kind", label: "Type", kind: "text", width: 140, value: (c) => c.kind || "-" },
    {
      key: "status",
      label: "Status",
      kind: "text",
      width: 180,
      value: (c) => connectorStatus(c, tests[c.name]).label,
      render: (c) => {
        const st = connectorStatus(c, tests[c.name])
        return (
          <span className="inline-flex items-center gap-1.5" title={st.title}>
            <span className={cn("size-1.5 rounded-full", DOT[st.dot])} />
            {st.label}
          </span>
        )
      },
    },
    { key: "baseUrl", label: "Endpoint", kind: "text", width: 320, value: (c) => c.baseUrl ?? "-" },
    { key: "authType", label: "Auth", kind: "text", width: 120, value: (c) => c.authType ?? "-" },
    {
      key: "test",
      label: "Test",
      kind: "none",
      width: 72,
      render: (c) => (
        <Button variant="ghost" size="xs" disabled={tests[c.name] === "running"} onClick={() => test(c.name)}>
          Test
        </Button>
      ),
    },
  ]

  return (
    <section className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-medium">Integration connectors ({list.length})</h2>
        <Button
          variant="outline"
          size="sm"
          title="Runs each enabled connector's ValidateConnection service"
          onClick={() => enabled.forEach((c) => test(c.name))}
        >
          <IconPlugConnected /> Test all enabled
        </Button>
      </div>
      <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
        <Stat label="Enabled" value={`${enabled.length} of ${list.length}`} sub="the platform keeps no connected flag" />
        <Stat
          label="Connected"
          value={results.length ? `${connected} of ${results.length} tested` : "Not tested"}
          sub={failed ? `${failed} failed` : undefined}
          level={level}
        />
      </div>
      <DataGrid
        id="twx-server-connectors"
        columns={columns}
        rows={list}
        rowKey={(c) => c.name}
        searchable={list.length > 8}
        pageSize={50}
        csvName="connectors"
      />
    </section>
  )
}

export function HealthTab({ env }: { env: string }) {
  const [data, setData] = useState<{ health: ServerHealth; ping: Ping } | null>(null)
  const [error, setError] = useState("")
  const [loading, setLoading] = useState(true)

  const load = useCallback(() => {
    setLoading(true)
    setError("")
    Promise.all([pingServer(env), getServerHealth(env)])
      .then(([ping, health]) => setData({ ping, health }))
      .catch((err) => setError(errorMessage(err)))
      .finally(() => setLoading(false))
  }, [env])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load()
  }, [load])

  const p = data?.health.platform
  const c = data?.health.counts
  const ping = data?.ping
  const mem = p?.memoryUsed != null && p.memoryTotal ? p.memoryUsed / p.memoryTotal : null
  const queue = Math.max(p?.eventQueue ?? 0, p?.streamQueue ?? 0, p?.valueStreamQueue ?? 0)
  const down = data?.health.subsystems?.filter((s) => !s.running) ?? []
  useAssistantContext({
    screen: "twx-server",
    data: {
      health: {
        loading,
        error,
        up: ping?.ok ?? null,
        latencyMs: ping?.latencyMs ?? null,
        pingError: ping?.error ?? null,
        version: p?.softwareVersion ?? null,
        memoryUsedMb: p?.memoryUsed != null ? Math.round(p.memoryUsed / 1048576) : null,
        memoryTotalMb: p?.memoryTotal != null ? Math.round(p.memoryTotal / 1048576) : null,
        queues: { event: p?.eventQueue ?? null, stream: p?.streamQueue ?? null, valueStream: p?.valueStreamQueue ?? null },
        counts: c ?? null,
        subsystemsDown: down.map((s) => `${s.name}: ${s.state}`).slice(0, 20),
        errors: data?.health.errors.slice(0, 5),
      },
    },
  })
  usePinnables(
    data
      ? [
          {
            kind: "server-health",
            label: `Server health · ${env}`,
            detail: ping?.ok ? "up" : "down",
            content: () =>
              JSON.stringify({ ping: data.ping, platform: p, counts: c, subsystemsDown: down, errors: data.health.errors }).slice(0, 6000),
          },
        ]
      : [],
  )

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">Read-only. Memory is the heap the server has allocated, not its limit.</p>
        <Button variant="outline" size="sm" onClick={load} disabled={loading}>
          <IconRefresh className={cn(loading && "animate-spin")} /> Refresh
        </Button>
      </div>

      {error && <p className="rounded-xl border border-destructive/20 bg-destructive/10 px-4 py-3 text-xs text-destructive">{error}</p>}
      {!data && !error && <p className="text-xs text-muted-foreground">Checking the server...</p>}

      {data && (
        <>
          {ping && !ping.ok && (
            <p className="rounded-xl border border-destructive/20 bg-destructive/10 px-4 py-3 text-xs text-destructive">
              The server did not answer: {ping.error}
            </p>
          )}
          {data.health.errors.length > 0 && (
            <ul className="rounded-xl border border-warning/30 bg-warning/10 px-4 py-3 text-xs">
              {data.health.errors.map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
          )}

          <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
            <Stat
              label="Status"
              value={ping?.ok ? "Up" : "Down"}
              sub={ping ? `${ping.latencyMs} ms` : undefined}
              level={!ping?.ok ? "bad" : ping.latencyMs > 2000 ? "warn" : "ok"}
            />
            <Stat
              label="Version"
              value={p?.softwareVersion ?? "-"}
              sub={[p?.build, p?.schemaVersion && `schema ${p.schemaVersion}`].filter(Boolean).join(" · ") || undefined}
            />
            <Stat
              label="Uptime"
              value={formatDuration(p?.uptimeMs)}
              sub={p?.startTime ? `since ${new Date(p.startTime).toLocaleString()}` : (p?.runTime ?? undefined)}
            />
            <Stat
              label="Memory"
              value={mem != null ? `${Math.round(mem * 100)}%` : "-"}
              sub={`${formatBytes(p?.memoryUsed)} of ${formatBytes(p?.memoryTotal)}`}
              level={mem == null ? "none" : mem > 0.9 ? "bad" : mem > 0.8 ? "warn" : "ok"}
            />
            <Stat
              label="Subsystems"
              value={
                data.health.subsystems
                  ? `${data.health.subsystems.length - down.length} / ${data.health.subsystems.length} running`
                  : "-"
              }
              level={!data.health.subsystems ? "none" : down.length ? "bad" : "ok"}
              sub={down.length ? down.map((s) => s.name).join(", ") : undefined}
            />
            <Stat
              label="Queues"
              value={n(queue)}
              sub={`event ${n(p?.eventQueue)} · stream ${n(p?.streamQueue)} · value stream ${n(p?.valueStreamQueue)}`}
              level={!p ? "none" : queue > 1000 ? "bad" : queue > 100 ? "warn" : "ok"}
            />
            <Stat
              label="Things"
              value={n(c?.things)}
              sub={c?.connectedThings != null ? `${n(c.connectedThings)} of ${n(c.boundThings)} bound connected` : undefined}
            />
            <Stat
              label="License"
              value={p?.licenseEvaluation ? "Evaluation" : p?.licenseDaysLeft != null ? `${Math.round(p.licenseDaysLeft)} days left` : "-"}
              sub={p?.namedUsers != null ? `${n(p.namedUsers)} named users` : undefined}
              level={p?.licenseDaysLeft == null ? "none" : p.licenseDaysLeft < 14 ? "bad" : p.licenseDaysLeft < 60 ? "warn" : "ok"}
            />
          </div>

          {c && (
            <p className="text-xs text-muted-foreground">
              {n(c.projects)} projects · {n(c.mashups)} mashups · {n(c.thingTemplates)} thing templates · {n(c.thingShapes)} thing
              shapes · {n(c.dataShapes)} data shapes
            </p>
          )}

          <Connectors env={env} />

          {data.health.subsystems && (
            <section className="flex flex-col gap-1.5">
              <h2 className="text-sm font-medium">Subsystems</h2>
              <DataGrid id="twx-server-subsystems" columns={SUBSYSTEM_COLS} rows={data.health.subsystems} rowKey={(r) => r.name} searchable={false} csvName="subsystems" />
            </section>
          )}

          {data.health.extensions && (
            <section className="flex flex-col gap-1.5">
              <h2 className="text-sm font-medium">Extensions ({data.health.extensions.length})</h2>
              <DataGrid
                id="twx-server-extensions"
                columns={EXTENSION_COLS}
                rows={data.health.extensions}
                rowKey={(e) => `${e.name}@${e.version}`}
                pageSize={50}
                csvName="extensions"
              />
            </section>
          )}
        </>
      )}
    </div>
  )
}
