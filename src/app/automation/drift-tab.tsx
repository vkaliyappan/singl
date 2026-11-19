"use client"

import { useEffect, useState } from "react"
import { IconGitCompare, IconLoader2 } from "@tabler/icons-react"
import { toast } from "sonner"
import { DiffView } from "@/components/assistant/rich/diff-view"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import {
  driftEntityXml, formatTime, getRun, listRuns, runDrift,
  type DriftEntity, type DriftReport, type RunRow,
} from "@/lib/automation"
import { searchEntities } from "@/lib/services"
import { errorMessage } from "@/lib/settings"
import { useAssistantContext } from "@/lib/assistant/context"
import { usePinnables } from "@/lib/assistant/pins"
import { ErrorNote, Field, RunHistory, seconds } from "./shared"
import { DataGrid, type GridColumn } from "@/components/data-grid"

type Group = { key: string; title: string; items: DriftEntity[]; tone: string; diff?: boolean }

function DriftList({ id, items, onDiff }: { id: string; items: DriftEntity[]; onDiff?: (e: DriftEntity) => void }) {
  const columns: GridColumn<DriftEntity>[] = [
    { key: "name", label: "Entity", kind: "text", width: 320 },
    { key: "entityType", label: "Type", kind: "text", width: 150 },
    { key: "project", label: "Project", kind: "text", width: 200 },
    ...(onDiff
      ? [
          {
            key: "diff",
            label: "Diff",
            kind: "none",
            width: 80,
            render: (e: DriftEntity) => (
              <Button size="xs" variant="outline" onClick={() => onDiff(e)}>
                Diff
              </Button>
            ),
          } as GridColumn<DriftEntity>,
        ]
      : []),
  ]
  return (
    <div className="border-t p-2">
      <DataGrid
        id={id}
        columns={columns}
        rows={items}
        rowKey={(e) => `${e.project}/${e.entityType}/${e.name}`}
        searchable={items.length > 8}
        pageSize={50}
        csvName={id}
      />
    </div>
  )
}

function Groups({ report, onDiff }: { report: DriftReport; onDiff: (e: DriftEntity) => void }) {
  const groups: Group[] = [
    { key: "a", title: `Only in ${report.envA}`, items: report.onlyA, tone: "text-amber-700 dark:text-amber-300" },
    { key: "b", title: `Only in ${report.envB}`, items: report.onlyB, tone: "text-amber-700 dark:text-amber-300" },
    { key: "d", title: "Different", items: report.different, tone: "text-red-700 dark:text-red-300", diff: true },
    { key: "s", title: "Same", items: report.same, tone: "text-emerald-700 dark:text-emerald-300" },
    { key: "u", title: "Not compared", items: report.unchecked, tone: "text-muted-foreground" },
  ]
  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-muted-foreground">
        {report.envA} vs {report.envB} · {seconds(report.durationMs)} · {formatTime(report.startedAt)}
        {report.projects.length > 0 ? ` · ${report.projects.join(", ")}` : " · all projects"}
      </p>
      <div className="flex flex-wrap gap-2">
        {groups.filter((g) => g.key !== "u" || g.items.length > 0).map((g) => (
          <div key={g.key} className="min-w-28 rounded-xl border bg-card px-3 py-2">
            <div className={`text-lg font-semibold ${g.tone}`}>{g.items.length}</div>
            <div className="text-[11px] text-muted-foreground">{g.title}</div>
          </div>
        ))}
      </div>
      {report.warnings.length > 0 && (
        <details className="rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-200">
          <summary className="cursor-pointer">{report.warnings.length} warnings</summary>
          {report.warnings.map((w, i) => (
            <p key={i} className="mt-1 break-words">
              {w}
            </p>
          ))}
        </details>
      )}
      {groups.map(
        (g) =>
          g.items.length > 0 && (
            <details key={g.key} open={g.key !== "s" && g.key !== "u"} className="rounded-xl border bg-card">
              <summary className="cursor-pointer px-3 py-2 text-xs font-medium">
                {g.title} <span className="text-muted-foreground">({g.items.length})</span>
              </summary>
              <DriftList id={`automation-drift-${g.key}`} items={g.items} onDiff={g.diff ? onDiff : undefined} />
            </details>
          ),
      )}
    </div>
  )
}

export function DriftTab({ envs }: { envs: string[] }) {
  const [envA, setEnvA] = useState(envs[0] ?? "")
  const [envB, setEnvB] = useState(envs[1] ?? "")
  const [available, setAvailable] = useState<string[]>([])
  const [filter, setFilter] = useState("")
  const [projects, setProjects] = useState<string[]>([])
  const [compareXml, setCompareXml] = useState(false)
  const [running, setRunning] = useState(false)
  const [report, setReport] = useState<DriftReport | null>(null)
  const [history, setHistory] = useState<RunRow[]>([])
  const [error, setError] = useState("")
  const [diff, setDiff] = useState<{ entity: DriftEntity; a: string; b: string } | null>(null)

  useEffect(() => {
    if (!envA) return
    let live = true
    searchEntities(envA, "Project")
      .then((rows) => live && setAvailable(rows.map((r) => r.name).sort((x, y) => x.localeCompare(y))))
      .catch(() => live && setAvailable([]))
    return () => {
      live = false
    }
  }, [envA])

  useEffect(() => {
    listRuns("drift").then(setHistory).catch(() => {})
  }, [])

  const run = async () => {
    setRunning(true)
    setError("")
    try {
      const result = await runDrift({ envA, envB, projects, compareXml })
      setReport(result)
      setHistory(await listRuns("drift"))
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setRunning(false)
    }
  }

  const openDiff = async (entity: DriftEntity) => {
    if (!report) return
    try {
      const [a, b] = await driftEntityXml(report.envA, report.envB, entity.entityType, entity.name)
      setDiff({ entity, a, b })
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }

  const openRun = async (row: RunRow) => {
    try {
      setReport((await getRun<DriftReport>(row.id)).result)
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }

  useAssistantContext({
    screen: "automation",
    data: {
      env: envA,
      drift: {
        envA,
        envB,
        projects,
        compareXml,
        running,
        error,
        report: report && {
          envA: report.envA,
          envB: report.envB,
          onlyA: report.onlyA.length,
          onlyB: report.onlyB.length,
          different: report.different.length,
          same: report.same.length,
          unchecked: report.unchecked.length,
          warnings: report.warnings.length,
          differentList: report.different.slice(0, 15).map((e) => `${e.entityType}:${e.name}`),
          onlyAList: report.onlyA.slice(0, 10).map((e) => `${e.entityType}:${e.name}`),
          onlyBList: report.onlyB.slice(0, 10).map((e) => `${e.entityType}:${e.name}`),
        },
      },
    },
  })
  usePinnables(
    report
      ? [
          {
            kind: "drift-report",
            label: `Drift · ${report.envA} vs ${report.envB}`,
            detail: `${report.different.length} different`,
            content: () => {
              const f = (l: DriftEntity[]) => l.slice(0, 60).map((e) => `${e.entityType}:${e.name}`)
              return JSON.stringify({ envA: report.envA, envB: report.envB, onlyA: f(report.onlyA), onlyB: f(report.onlyB), different: f(report.different), same: report.same.length }).slice(0, 8000)
            },
          },
        ]
      : [],
  )

  const shown = available.filter((p) => p.toLowerCase().includes(filter.toLowerCase()))
  const envSelect = (value: string, set: (v: string) => void) => (
    <NativeSelect value={value} onChange={(e) => set(e.target.value)}>
      <NativeSelectOption value="">Choose…</NativeSelectOption>
      {envs.map((e) => (
        <NativeSelectOption key={e} value={e}>
          {e}
        </NativeSelectOption>
      ))}
    </NativeSelect>
  )

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3 rounded-xl border bg-card p-3">
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Environment A">{envSelect(envA, setEnvA)}</Field>
          <Field label="Environment B">{envSelect(envB, setEnvB)}</Field>
          <label className="flex items-center gap-1.5 pb-1.5 text-xs">
            <Checkbox checked={compareXml} onCheckedChange={(on) => setCompareXml(!!on)} />
            Compare exported XML (slower)
          </label>
          <Button size="sm" onClick={run} disabled={running || !envA || !envB || envA === envB}>
            {running ? <IconLoader2 className="animate-spin" /> : <IconGitCompare />} Run report
          </Button>
        </div>
        <div className="flex flex-col gap-1.5">
          <span className="text-[11px] font-medium text-muted-foreground">
            Projects on {envA || "A"} ({projects.length === 0 ? "none selected = all projects" : `${projects.length} selected`})
          </span>
          <Input className="max-w-64" placeholder="Filter projects" value={filter} onChange={(e) => setFilter(e.target.value)} />
          <div className="flex max-h-32 flex-wrap gap-x-4 gap-y-1 overflow-y-auto">
            {[...projects.filter((p) => !available.includes(p)), ...shown].map((p) => (
              <label key={p} className="flex items-center gap-1.5 text-xs">
                <Checkbox
                  checked={projects.includes(p)}
                  onCheckedChange={(on) => setProjects(on ? [...projects, p] : projects.filter((x) => x !== p))}
                />
                {p}
              </label>
            ))}
            {available.length === 0 && <span className="text-xs text-muted-foreground">No project list for this environment.</span>}
          </div>
        </div>
      </div>
      <ErrorNote message={error} />
      {report && <Groups report={report} onDiff={openDiff} />}
      {history.length > 0 && (
        <div className="flex flex-col gap-1">
          <h3 className="text-xs font-medium">Earlier reports</h3>
          <RunHistory id="automation-drift-runs" rows={history} onOpen={openRun} showName />
        </div>
      )}
      <Dialog open={!!diff} onOpenChange={(o) => !o && setDiff(null)}>
        <DialogContent className="sm:max-w-4xl">
          <DialogHeader>
            <DialogTitle>
              {diff?.entity.name}: {report?.envA} → {report?.envB}
            </DialogTitle>
          </DialogHeader>
          {diff && <DiffView original={diff.a} modified={diff.b} path={`${diff.entity.name}.xml`} maxHeight="60vh" />}
        </DialogContent>
      </Dialog>
    </div>
  )
}
