"use client"

import { DataGrid, type GridColumn } from "@/components/data-grid"
import { useEffect, useState } from "react"
import { IconLoader2, IconPencil, IconPlayerPlay, IconPlus, IconTrash } from "@tabler/icons-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { Spinner } from "@/components/ui/spinner"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import {
  DAY_NAMES, deleteSchedule, describeRepeat, formatTime, listFlows, listSchedules, listSuites, localUtcOffsetMin,
  runScheduleNow, saveSchedule, setScheduleEnabled,
  type FlowRef, type Repeat, type Schedule, type Suite, type Target,
} from "@/lib/automation"
import { errorMessage } from "@/lib/settings"
import { ErrorNote, Field, StatusPill } from "./shared"

type Draft = { id: string | null; name: string; enabled: boolean; repeat: Repeat; target: Target }

const blank = (): Draft => ({
  id: null,
  name: "",
  enabled: true,
  repeat: { type: "daily", time: "08:00" },
  target: { type: "suite", suiteId: "" },
})

const REPEATS: Record<Repeat["type"], Repeat> = {
  interval: { type: "interval", minutes: 60 },
  daily: { type: "daily", time: "08:00" },
  weekly: { type: "weekly", days: [1, 2, 3, 4, 5], time: "08:00" },
}

function describeTarget(t: Target, suites: Suite[], flows: FlowRef[]): string {
  switch (t.type) {
    case "suite":
      return `Test suite: ${suites.find((s) => s.id === t.suiteId)?.name ?? "(deleted)"}`
    case "drift":
      return `Drift: ${t.envA} vs ${t.envB}`
    case "flow":
      return `Flow: ${flows.find((f) => f.id === t.flowId)?.name ?? "(deleted)"}`
    case "assistant":
      return `Assistant: ${t.prompt.slice(0, 40)}${t.prompt.length > 40 ? "…" : ""}`
  }
}

function Editor({
  draft,
  setDraft,
  envs,
  suites,
  flows,
}: {
  draft: Draft
  setDraft: (d: Draft) => void
  envs: string[]
  suites: Suite[]
  flows: FlowRef[]
}) {
  const { repeat, target } = draft
  const envSelect = (value: string, set: (v: string) => void) => (
    <NativeSelect className="w-full" value={value} onChange={(e) => set(e.target.value)}>
      <NativeSelectOption value="">Choose…</NativeSelectOption>
      {envs.map((e) => (
        <NativeSelectOption key={e} value={e}>
          {e}
        </NativeSelectOption>
      ))}
    </NativeSelect>
  )
  return (
    <div className="flex flex-col gap-3">
      <Field label="Name">
        <Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
      </Field>

      <Field label="Repeat">
        <NativeSelect className="w-full" value={repeat.type} onChange={(e) => setDraft({ ...draft, repeat: REPEATS[e.target.value as Repeat["type"]] })}>
          <NativeSelectOption value="interval">Every N minutes</NativeSelectOption>
          <NativeSelectOption value="daily">Daily at a time</NativeSelectOption>
          <NativeSelectOption value="weekly">Weekly on days at a time</NativeSelectOption>
        </NativeSelect>
      </Field>
      {repeat.type === "interval" && (
        <Field label="Minutes">
          <Input
            type="number"
            min={1}
            value={repeat.minutes}
            onChange={(e) => setDraft({ ...draft, repeat: { type: "interval", minutes: Math.max(1, Number(e.target.value) || 1) } })}
          />
        </Field>
      )}
      {repeat.type !== "interval" && (
        <Field label="Time (your local time)">
          <Input type="time" value={repeat.time} onChange={(e) => setDraft({ ...draft, repeat: { ...repeat, time: e.target.value } })} />
        </Field>
      )}
      {repeat.type === "weekly" && (
        <div className="flex flex-wrap gap-x-3 gap-y-1">
          {DAY_NAMES.map((name, d) => (
            <label key={d} className="flex items-center gap-1.5 text-xs">
              <Checkbox
                checked={repeat.days.includes(d)}
                onCheckedChange={(on) =>
                  setDraft({ ...draft, repeat: { ...repeat, days: on ? [...repeat.days, d].sort() : repeat.days.filter((x) => x !== d) } })
                }
              />
              {name}
            </label>
          ))}
        </div>
      )}

      <Field label="Task">
        <NativeSelect
          className="w-full"
          value={target.type}
          onChange={(e) => {
            const type = e.target.value as Target["type"]
            setDraft({
              ...draft,
              target:
                type === "suite" ? { type, suiteId: "" }
                : type === "drift" ? { type, envA: "", envB: "", projects: [], compareXml: false }
                : type === "flow" ? { type, flowId: "", env: "" }
                : { type, prompt: "" },
            })
          }}
        >
          <NativeSelectOption value="suite">Run a test suite</NativeSelectOption>
          <NativeSelectOption value="drift">Run a drift report</NativeSelectOption>
          <NativeSelectOption value="flow">Run a flow</NativeSelectOption>
          <NativeSelectOption value="assistant">Send a prompt to the assistant</NativeSelectOption>
        </NativeSelect>
      </Field>
      {target.type === "suite" && (
        <Field label="Suite (runs on its own environments)">
          <NativeSelect className="w-full" value={target.suiteId} onChange={(e) => setDraft({ ...draft, target: { ...target, suiteId: e.target.value } })}>
            <NativeSelectOption value="">Choose…</NativeSelectOption>
            {suites.map((s) => (
              <NativeSelectOption key={s.id} value={s.id}>
                {s.name}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </Field>
      )}
      {target.type === "drift" && (
        <>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Environment A">{envSelect(target.envA, (v) => setDraft({ ...draft, target: { ...target, envA: v } }))}</Field>
            <Field label="Environment B">{envSelect(target.envB, (v) => setDraft({ ...draft, target: { ...target, envB: v } }))}</Field>
          </div>
          <Field label="Projects (comma separated; empty = all)">
            <Input
              value={target.projects.join(", ")}
              onChange={(e) =>
                setDraft({ ...draft, target: { ...target, projects: e.target.value.split(",").map((p) => p.trim()).filter(Boolean) } })
              }
            />
          </Field>
          <label className="flex items-center gap-1.5 text-xs">
            <Checkbox checked={target.compareXml} onCheckedChange={(on) => setDraft({ ...draft, target: { ...target, compareXml: !!on } })} />
            Compare exported XML
          </label>
        </>
      )}
      {target.type === "flow" && (
        <>
          <Field label="Flow">
            <NativeSelect className="w-full" value={target.flowId} onChange={(e) => setDraft({ ...draft, target: { ...target, flowId: e.target.value } })}>
              <NativeSelectOption value="">Choose…</NativeSelectOption>
              {flows.map((f) => (
                <NativeSelectOption key={f.id} value={f.id}>
                  {f.name}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </Field>
          <Field label="Environment (default: the flow's)">{envSelect(target.env, (v) => setDraft({ ...draft, target: { ...target, env: v } }))}</Field>
        </>
      )}
      {target.type === "assistant" && (
        <Field label="Prompt (starts a new chat that can only read)">
          <Textarea className="min-h-20" value={target.prompt} onChange={(e) => setDraft({ ...draft, target: { ...target, prompt: e.target.value } })} />
        </Field>
      )}

      <label className="flex items-center gap-2 text-xs">
        <Switch checked={draft.enabled} onCheckedChange={(on) => setDraft({ ...draft, enabled: on })} />
        Enabled
      </label>
    </div>
  )
}

export function SchedulesTab({ envs }: { envs: string[] }) {
  const [schedules, setSchedules] = useState<Schedule[] | null>(null)
  const [suites, setSuites] = useState<Suite[]>([])
  const [flows, setFlows] = useState<FlowRef[]>([])
  const [draft, setDraft] = useState<Draft | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState("")

  const reload = () => listSchedules().then(setSchedules).catch((e) => setError(errorMessage(e)))

  useEffect(() => {
    reload()
    listSuites().then(setSuites).catch(() => {})
    listFlows().then(setFlows).catch(() => {})
  }, [])

  const save = async () => {
    if (!draft) return
    try {
      await saveSchedule({ ...draft, utcOffsetMin: localUtcOffsetMin() })
      setDraft(null)
      setError("")
      await reload()
    } catch (e) {
      setError(errorMessage(e))
    }
  }

  const toggle = async (s: Schedule, on: boolean) => {
    try {
      await setScheduleEnabled(s.id, on)
      await reload()
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }

  const runNow = async (s: Schedule) => {
    setBusy(s.id)
    try {
      const done = await runScheduleNow(s.id)
      if (done.lastStatus === "ok") toast.success(done.lastMessage ?? "Done")
      else toast.error(done.lastMessage ?? "The run did not finish cleanly")
      await reload()
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(null)
    }
  }

  const remove = async (s: Schedule) => {
    if (!window.confirm(`Delete the schedule "${s.name}"?`)) return
    try {
      await deleteSchedule(s.id)
      await reload()
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }

  const columns: GridColumn<Schedule>[] = [
    {
      key: "enabled",
      label: "On",
      kind: "boolean",
      width: 70,
      render: (s) => <Switch size="sm" checked={s.enabled} onCheckedChange={(on) => toggle(s, on)} aria-label={`Enable ${s.name}`} />,
    },
    { key: "name", label: "Name", kind: "text", width: 200, render: (s) => <span className="font-medium">{s.name}</span> },
    { key: "repeat", label: "Repeat", kind: "text", width: 180, value: (s) => describeRepeat(s.repeat) },
    { key: "target", label: "Task", kind: "text", width: 220, value: (s) => describeTarget(s.target, suites, flows) },
    {
      key: "lastRunAt",
      label: "Last run",
      kind: "date",
      width: 280,
      truncate: false,
      render: (s) => (
        <div>
          <div className="flex items-center gap-2">
            <StatusPill status={s.lastStatus} />
            <span className="text-muted-foreground">{formatTime(s.lastRunAt)}</span>
          </div>
          {s.lastMessage && <p className="mt-1 max-w-xs break-words text-muted-foreground">{s.lastMessage}</p>}
        </div>
      ),
    },
    { key: "lastStatus", label: "Last status", kind: "text", width: 100, hidden: true, value: (s) => s.lastStatus ?? "" },
    {
      key: "nextRunAt",
      label: "Next run",
      kind: "date",
      width: 170,
      value: (s) => (s.enabled ? s.nextRunAt : null),
      render: (s) => (s.enabled ? formatTime(s.nextRunAt) : "—"),
    },
    {
      key: "actions",
      label: "Actions",
      kind: "none",
      width: 120,
      render: (s) => (
        <div className="flex gap-1">
          <Button variant="ghost" size="icon-sm" onClick={() => runNow(s)} disabled={busy === s.id} aria-label="Run now">
            {busy === s.id ? <IconLoader2 className="animate-spin" /> : <IconPlayerPlay />}
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Edit"
            onClick={() => setDraft({ id: s.id, name: s.name, enabled: s.enabled, repeat: s.repeat, target: s.target })}
          >
            <IconPencil />
          </Button>
          <Button variant="ghost" size="icon-sm" onClick={() => remove(s)} aria-label="Delete">
            <IconTrash />
          </Button>
        </div>
      ),
    },
  ]

  if (!schedules) return error ? <ErrorNote message={error} /> : <Spinner />

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <Button size="sm" onClick={() => setDraft(blank())}>
          <IconPlus /> New schedule
        </Button>
        <p className="text-xs text-muted-foreground">
          Schedules run only while singl is open. A run that fails or finds drift posts a notification.
        </p>
      </div>
      <ErrorNote message={draft ? "" : error} />
      {schedules.length === 0 ? (
        <p className="rounded-xl border bg-card px-4 py-3.5 text-xs text-muted-foreground">No schedules yet.</p>
      ) : (
        <DataGrid
          id="automation-schedules"
          columns={columns}
          rows={schedules}
          rowKey={(s) => s.id}
          searchable={schedules.length > 8}
          csvName="schedules"
        />
      )}

      <Dialog open={!!draft} onOpenChange={(o) => !o && setDraft(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{draft?.id ? "Edit schedule" : "New schedule"}</DialogTitle>
          </DialogHeader>
          {draft && <Editor draft={draft} setDraft={setDraft} envs={envs} suites={suites} flows={flows} />}
          <ErrorNote message={error} />
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setDraft(null)}>
              Cancel
            </Button>
            <Button size="sm" onClick={save}>
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
