"use client"

import { useRef, useState } from "react"
import { IconRefresh, IconSearch } from "@tabler/icons-react"
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
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { errorMessage } from "@/lib/settings"
import { useAssistantAction, useAssistantContext } from "@/lib/assistant/context"
import { searchEntities } from "@/lib/services"
import type { EntitySearchResult } from "@/lib/twx/types"
import { fireEvent, getThingSubscriptions, setSubscriptionEnabled, type Subscription } from "@/lib/twx-events"

type Pending =
  | { kind: "subscription"; subscription: Subscription; enabled: boolean }
  | { kind: "fire"; event: string; inputs: Record<string, unknown> }

/** The loaded subscriptions, tagged with the environment and Thing they belong to. */
type Loaded = { env: string; thing: string; items: Subscription[] }

const MAX_MATCHES = 50

export function SubscriptionsTab({ env }: { env: string }) {
  const [query, setQuery] = useState("")
  const [searching, setSearching] = useState(false)
  const [matches, setMatches] = useState<{ env: string; items: EntitySearchResult[] } | null>(null)
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [pending, setPending] = useState<Pending | null>(null)
  const [running, setRunning] = useState(false)
  const [eventName, setEventName] = useState("")
  const [inputsText, setInputsText] = useState("{}")
  const [fireReply, setFireReply] = useState<string | null>(null)
  const [fireError, setFireError] = useState<string | null>(null)
  // Only the latest Thing click may land, so a slow earlier load cannot overwrite it.
  const latest = useRef(0)

  // Results and the loaded Thing count only for the environment they came from.
  const shownMatches = matches?.env === env ? matches.items : null
  const shownLoaded = loaded?.env === env ? loaded : null

  async function search() {
    const q = query.trim()
    if (!q) return
    setSearching(true)
    try {
      const items = await searchEntities(env, "Things", `*${q}*`)
      setMatches({ env, items })
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setSearching(false)
    }
  }

  async function openThing(thing: string) {
    const ticket = ++latest.current
    setLoading(true)
    setLoadError(null)
    setFireReply(null)
    setFireError(null)
    try {
      const items = await getThingSubscriptions(env, thing)
      if (ticket === latest.current) setLoaded({ env, thing, items })
    } catch (e) {
      if (ticket === latest.current) {
        setLoaded({ env, thing, items: [] })
        setLoadError(errorMessage(e))
      }
    } finally {
      if (ticket === latest.current) setLoading(false)
    }
  }

  async function reload() {
    if (shownLoaded) await openThing(shownLoaded.thing)
  }

  useAssistantContext({
    screen: "twx-server",
    data: {
      subscriptions: {
        query,
        thing: shownLoaded?.thing ?? null,
        count: shownLoaded?.items.length ?? null,
        loadError,
        matches: shownMatches?.slice(0, 15).map((m) => m.name),
        items: shownLoaded?.items.slice(0, 15).map((i) => ({ name: i.name, enabled: i.enabled, owner: i.owner })),
      },
    },
  })
  useAssistantAction(
    "select_thing_subscriptions",
    {
      description: "On the Subscriptions tab, load the subscriptions of a Thing so the user sees them.",
      inputSchema: { type: "object", properties: { thing: { type: "string" } }, required: ["thing"] },
    },
    async (args) => {
      const thing = String((args as { thing?: string }).thing ?? "")
      if (!thing) throw new Error("thing is required")
      setQuery(thing)
      await openThing(thing)
      return { thing }
    },
  )

  async function confirm() {
    if (!pending || !shownLoaded) return
    const thing = shownLoaded.thing
    setRunning(true)
    try {
      if (pending.kind === "subscription") {
        const { subscription, enabled } = pending
        await setSubscriptionEnabled(env, thing, subscription.name, enabled)
        toast.success(`${enabled ? "Enabled" : "Disabled"} ${subscription.name} on ${thing}`)
        await reload()
      } else {
        const reply = await fireEvent(env, thing, pending.event, pending.inputs)
        setFireReply(reply)
        setFireError(null)
        toast.success(`Fired ${pending.event} on ${thing}`)
      }
      setPending(null)
    } catch (e) {
      const message = errorMessage(e)
      toast.error(message)
      if (pending.kind === "fire") setFireError(message)
      setPending(null)
    } finally {
      setRunning(false)
    }
  }

  function askFire() {
    const event = eventName.trim()
    if (!event) {
      setFireError("Enter an event name.")
      return
    }
    let inputs: unknown
    try {
      inputs = JSON.parse(inputsText.trim() || "{}")
    } catch {
      setFireError("Inputs must be valid JSON.")
      return
    }
    if (!inputs || typeof inputs !== "object" || Array.isArray(inputs)) {
      setFireError("Inputs must be a JSON object, e.g. {\"name\": \"value\"}.")
      return
    }
    setFireError(null)
    setPending({ kind: "fire", event, inputs: inputs as Record<string, unknown> })
  }

  const subs = shownLoaded?.items ?? []

  const columns: GridColumn<(typeof subs)[number]>[] = [
    { key: "name", label: "Subscription", kind: "text", width: 240, render: (s) => <span className="font-mono text-xs">{s.name}</span> },
    {
      key: "events",
      label: "Source and event",
      kind: "text",
      width: 340,
      truncate: false,
      value: (s) => s.events.map((ev) => `${ev.source || "?"} · ${ev.eventName}`).join("; "),
      render: (s) =>
        s.events.length === 0 ? (
          <span className="text-muted-foreground">none</span>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {s.events.map((ev, i) => (
              <li key={i} className="text-xs">
                <span className="font-mono">{ev.source || "?"}</span>
                <span className="text-muted-foreground"> · {ev.eventName}</span>
              </li>
            ))}
          </ul>
        ),
    },
    { key: "owner", label: "Owner", kind: "text", width: 220, render: (s) => <span className="text-xs text-muted-foreground">{s.owner}</span> },
    {
      key: "inherited",
      label: "Inherited",
      kind: "boolean",
      width: 100,
      render: (s) => (s.inherited ? <Badge variant="secondary">Inherited</Badge> : <span className="text-muted-foreground">No</span>),
    },
    {
      key: "enabled",
      label: "Enabled",
      kind: "boolean",
      width: 110,
      render: (s) => (
        <div className="flex items-center gap-2">
          <Switch
            checked={s.enabled}
            disabled={running}
            aria-label={`${s.enabled ? "Disable" : "Enable"} ${s.name}`}
            onCheckedChange={(enabled) => setPending({ kind: "subscription", subscription: s, enabled })}
          />
          <span className="text-xs">{s.enabled ? "On" : "Off"}</span>
        </div>
      ),
    },
  ]

  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-medium">Thing</h2>
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            void search()
          }}
        >
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search Things by name"
            aria-label="Search Things by name"
            className="max-w-md"
          />
          <Button type="submit" variant="outline" disabled={searching || !query.trim()}>
            <IconSearch data-icon="inline-start" />
            {searching ? "Searching…" : "Search"}
          </Button>
        </form>
        {shownMatches && (
          <div className="flex flex-col gap-1">
            {shownMatches.length === 0 && <p className="text-sm text-muted-foreground">No Things match.</p>}
            <div className="flex flex-wrap gap-2">
              {shownMatches.slice(0, MAX_MATCHES).map((m) => (
                <Button
                  key={m.name}
                  size="sm"
                  variant={shownLoaded?.thing === m.name ? "default" : "outline"}
                  onClick={() => void openThing(m.name)}
                >
                  {m.name}
                </Button>
              ))}
            </div>
            {shownMatches.length > MAX_MATCHES && (
              <p className="text-xs text-muted-foreground">
                Showing {MAX_MATCHES} of {shownMatches.length}. Narrow the search to see the rest.
              </p>
            )}
          </div>
        )}
      </section>

      {shownLoaded && (
        <section className="flex flex-col gap-3">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-sm font-medium">
              Subscriptions on <span className="font-mono">{shownLoaded.thing}</span>
            </h2>
            <Button size="sm" variant="ghost" onClick={() => void reload()} disabled={loading}>
              <IconRefresh data-icon="inline-start" />
              Refresh
            </Button>
          </div>
          {loadError && <p className="text-sm text-destructive">{loadError}</p>}
          {!loadError && !loading && subs.length === 0 && (
            <p className="text-sm text-muted-foreground">This Thing has no subscriptions.</p>
          )}
          {subs.length > 0 && (
            <DataGrid
              id="twx-server-subscriptions"
              columns={columns}
              rows={subs}
              rowKey={(s) => `${s.owner}/${s.name}`}
              searchable={subs.length > 8}
              pageSize={50}
              csvName="subscriptions"
            />
          )}

          <div className="flex flex-col gap-2 rounded-md border p-4">
            <h3 className="text-sm font-medium">Fire an event</h3>
            <p className="text-xs text-muted-foreground">
              Runs the event&apos;s subscribers on the live server. The inputs are sent as the event&apos;s JSON body.
            </p>
            <Input
              value={eventName}
              onChange={(e) => setEventName(e.target.value)}
              placeholder="Event name, e.g. ScheduledEvent"
              aria-label="Event name"
              className="max-w-md font-mono"
            />
            <Textarea
              value={inputsText}
              onChange={(e) => setInputsText(e.target.value)}
              aria-label="Event inputs as JSON"
              rows={4}
              className="max-w-xl font-mono text-xs"
            />
            <div>
              <Button variant="outline" onClick={askFire} disabled={running || loading}>
                Fire event…
              </Button>
            </div>
            {fireError && <p className="text-sm text-destructive">{fireError}</p>}
            {fireReply !== null && (
              <pre className="max-h-64 overflow-auto rounded-md bg-muted p-3 text-xs">{fireReply}</pre>
            )}
          </div>
        </section>
      )}

      <AlertDialog open={pending !== null} onOpenChange={(open) => !open && !running && setPending(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{pending ? confirmTitle(pending) : ""}</AlertDialogTitle>
            <AlertDialogDescription>{pending ? confirmBody(pending, shownLoaded?.thing ?? "") : ""}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={running}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant={pending?.kind === "subscription" && pending.enabled ? "default" : "destructive"}
              disabled={running}
              onClick={(e) => {
                e.preventDefault()
                void confirm()
              }}
            >
              {running ? "Working…" : pending ? confirmLabel(pending) : ""}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

function confirmTitle(p: Pending) {
  if (p.kind === "fire") return `Fire ${p.event}?`
  return `${p.enabled ? "Enable" : "Disable"} subscription?`
}

function confirmBody(p: Pending, thing: string) {
  if (p.kind === "fire") return `This fires ${p.event} on ${thing} on the live ThingWorx server, with the inputs you entered.`
  const action = p.enabled ? "start handling" : "stop handling"
  return `${p.subscription.name} will ${action} its events on ${thing} on the live ThingWorx server.`
}

function confirmLabel(p: Pending) {
  if (p.kind === "fire") return "Fire event"
  return p.enabled ? "Enable" : "Disable"
}
