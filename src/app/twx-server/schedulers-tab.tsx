"use client"

import { useEffect, useState } from "react"
import { IconPlayerPlay, IconRefresh } from "@tabler/icons-react"
import { toast } from "sonner"

import { DataGrid, type GridColumn } from "@/components/data-grid"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Switch } from "@/components/ui/switch"
import { errorMessage } from "@/lib/settings"
import {
  describeCron,
  describeInterval,
  fireEvent,
  getScheduledThings,
  setThingEnabled,
  type ScheduledThing,
} from "@/lib/twx-events"

type Pending =
  | { kind: "enable"; thing: ScheduledThing; enabled: boolean }
  | { kind: "run"; thing: ScheduledThing }

/** The result of one load, tagged with the environment and refresh count it answers. */
type Loaded = { env: string; refresh: number; items: ScheduledThing[]; error: string | null }

export function SchedulersTab({ env }: { env: string }) {
  const [refresh, setRefresh] = useState(0)
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [pending, setPending] = useState<Pending | null>(null)
  const [running, setRunning] = useState(false)

  useEffect(() => {
    let stale = false
    getScheduledThings(env).then(
      (items) => {
        if (!stale) setLoaded({ env, refresh, items, error: null })
      },
      (e: unknown) => {
        if (!stale) setLoaded({ env, refresh, items: [], error: errorMessage(e) })
      },
    )
    return () => {
      stale = true
    }
  }, [env, refresh])

  // Until the current load lands, the table shows as loading.
  const current = loaded?.env === env && loaded.refresh === refresh
  const loading = !current
  const items = current ? loaded.items : null
  const loadError = current ? loaded.error : null

  async function confirm() {
    if (!pending) return
    setRunning(true)
    try {
      if (pending.kind === "enable") {
        const { thing, enabled } = pending
        await setThingEnabled(env, thing.name, enabled)
        toast.success(`${enabled ? "Enabled" : "Disabled"} ${thing.name}`)
        setRefresh((r) => r + 1)
      } else {
        const { thing } = pending
        await fireEvent(env, thing.name, thing.event, {})
        toast.success(`Ran ${thing.name} (${thing.event} fired)`)
      }
      setPending(null)
    } catch (e) {
      toast.error(errorMessage(e))
      setPending(null)
    } finally {
      setRunning(false)
    }
  }

  const columns: GridColumn<ScheduledThing>[] = [
    { key: "name", label: "Thing", kind: "text", width: 280, render: (t) => <span className="font-mono text-xs">{t.name}</span> },
    { key: "template", label: "Template", kind: "text", width: 160, render: (t) => <Badge variant="secondary">{t.template}</Badge> },
    {
      key: "enabled",
      label: "Enabled",
      kind: "boolean",
      width: 120,
      value: (t) => t.enabled,
      render: (t) =>
        t.enabled === null ? (
          <span className="text-xs text-muted-foreground">Unknown</span>
        ) : (
          <div className="flex items-center gap-2">
            <Switch
              checked={t.enabled}
              disabled={running}
              aria-label={`${t.enabled ? "Disable" : "Enable"} ${t.name}`}
              onCheckedChange={(enabled) => setPending({ kind: "enable", thing: t, enabled })}
            />
            <span className="text-xs">{t.enabled ? "On" : "Off"}</span>
          </div>
        ),
    },
    {
      key: "schedule",
      label: "Schedule",
      kind: "text",
      width: 260,
      truncate: false,
      value: (t) =>
        t.schedule ? describeCron(t.schedule) : t.intervalMs !== null ? describeInterval(t.intervalMs) : "No schedule set",
      render: (t) => <ScheduleText thing={t} />,
    },
    {
      key: "run",
      label: "Run",
      kind: "none",
      width: 120,
      render: (t) => (
        <Button size="sm" variant="outline" disabled={running} onClick={() => setPending({ kind: "run", thing: t })}>
          <IconPlayerPlay data-icon="inline-start" />
          Run now
        </Button>
      ),
    },
  ]

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          Things from the Scheduler and Timer templates. Disabling a Thing stops its runs until it is enabled again.
        </p>
        <Button size="sm" variant="ghost" onClick={() => setRefresh((r) => r + 1)} disabled={loading}>
          <IconRefresh data-icon="inline-start" />
          {loading ? "Loading…" : "Refresh"}
        </Button>
      </div>

      {loadError && <p className="text-sm text-destructive">{loadError}</p>}
      {items && items.length === 0 && !loadError && (
        <p className="text-sm text-muted-foreground">No Scheduler or Timer Things on this server.</p>
      )}

      {items && items.length > 0 && (
        <DataGrid
          id="twx-server-schedulers"
          columns={columns}
          rows={items}
          rowKey={(t) => t.name}
          searchable={items.length > 8}
          pageSize={50}
          csvName="schedulers"
        />
      )}

      <AlertDialog open={pending !== null} onOpenChange={(open) => !open && !running && setPending(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{pending ? titleOf(pending) : ""}</AlertDialogTitle>
            <AlertDialogDescription>{pending ? bodyOf(pending) : ""}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={running}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant={pending?.kind === "enable" && pending.enabled ? "default" : "destructive"}
              disabled={running}
              onClick={(e) => {
                e.preventDefault()
                void confirm()
              }}
            >
              {running ? "Working…" : pending ? labelOf(pending) : ""}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

function ScheduleText({ thing }: { thing: ScheduledThing }) {
  if (thing.schedule) {
    const human = describeCron(thing.schedule)
    return (
      <div className="flex flex-col">
        <span className="text-sm">{human}</span>
        {human !== thing.schedule && <span className="font-mono text-xs text-muted-foreground">{thing.schedule}</span>}
      </div>
    )
  }
  if (thing.intervalMs !== null) {
    return <span className="text-sm">{describeInterval(thing.intervalMs)}</span>
  }
  return <span className="text-xs text-muted-foreground">No schedule set</span>
}

function titleOf(p: Pending) {
  if (p.kind === "run") return `Run ${p.thing.name} now?`
  return `${p.enabled ? "Enable" : "Disable"} ${p.thing.name}?`
}

function bodyOf(p: Pending) {
  if (p.kind === "run") {
    return `This fires ${p.thing.event} on the live ThingWorx server, outside its schedule.`
  }
  return p.enabled
    ? `${p.thing.name} will resume its scheduled runs on the live ThingWorx server.`
    : `${p.thing.name} will stop its scheduled runs on the live ThingWorx server until it is enabled again.`
}

function labelOf(p: Pending) {
  if (p.kind === "run") return "Run now"
  return p.enabled ? "Enable" : "Disable"
}
