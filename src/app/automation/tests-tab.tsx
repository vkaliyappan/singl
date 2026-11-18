"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { IconLoader2, IconPlayerPlay, IconPlus, IconTrash } from "@tabler/icons-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import {
  deleteSuite, formatTime, getRun, listRuns, listSuites, newCase, newSuite, runSuite, saveSuite,
  type CaseResult, type RunRow, type Suite, type SuiteRun,
} from "@/lib/automation"
import { listServicePresets, type ServicePreset } from "@/lib/services"
import { errorMessage } from "@/lib/settings"
import { cn } from "@/lib/utils"
import { CaseEditor } from "./case-editor"
import { EnvPicker, ErrorNote, Field, PassIcon, RunHistory, seconds } from "./shared"
import { DataGrid, type GridColumn } from "@/components/data-grid"

type CaseRow = { id: string; name: string }

/** Pass/fail per case (rows) and environment (columns). */
function ResultsGrid({ run }: { run: SuiteRun }) {
  const cases = useMemo<CaseRow[]>(() => {
    const seen = new Map<string, string>()
    for (const r of run.results) if (!seen.has(r.caseId)) seen.set(r.caseId, r.caseName)
    return [...seen].map(([id, name]) => ({ id, name }))
  }, [run])

  const columns = useMemo<GridColumn<CaseRow>[]>(() => {
    const cell = (caseId: string, env: string): CaseResult | undefined =>
      run.results.find((r) => r.caseId === caseId && r.env === env)
    return [
      { key: "name", label: "Case", kind: "text", width: 240, truncate: false, render: (c) => <span className="font-medium">{c.name}</span> },
      ...run.envs.map<GridColumn<CaseRow>>((env) => ({
        key: `env:${env}`,
        label: env,
        kind: "text",
        width: 260,
        truncate: false,
        value: (c) => {
          const r = cell(c.id, env)
          return r ? (r.passed ? "Pass" : "Fail") : "—"
        },
        render: (c) => {
          const r = cell(c.id, env)
          if (!r) return <span className="text-muted-foreground">—</span>
          return (
            <div>
              <div className="flex items-center gap-1.5">
                <PassIcon passed={r.passed} />
                <span className="text-muted-foreground">{seconds(r.durationMs)}</span>
              </div>
              {r.error && <p className="mt-1 max-w-xs break-words text-destructive">{r.error}</p>}
              {r.checks
                .filter((k) => !k.passed)
                .map((k, i) => (
                  <p key={i} className="mt-1 max-w-xs break-words text-red-700 dark:text-red-300">
                    {k.label}: expected {k.expected}, got {k.actual}
                  </p>
                ))}
              {r.passed && r.checks.length > 1 && <p className="mt-1 text-muted-foreground">{r.checks.length} checks</p>}
            </div>
          )
        },
      })),
    ]
  }, [run])

  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs text-muted-foreground">
        {run.passed}/{run.total} passed on {run.envs.join(", ")} · {seconds(run.durationMs)} · {formatTime(run.startedAt)}
      </p>
      <DataGrid
        id="automation-results"
        columns={columns}
        rows={cases}
        rowKey={(c) => c.id}
        searchable={cases.length > 8}
        csvName="test-results"
      />
    </div>
  )
}

export function TestsTab({ envs }: { envs: string[] }) {
  const [suites, setSuites] = useState<Suite[] | null>(null)
  const [presets, setPresets] = useState<ServicePreset[]>([])
  const [draft, setDraft] = useState<Suite | null>(null)
  const [dirty, setDirty] = useState(false)
  const [runEnvs, setRunEnvs] = useState<string[]>([])
  const [running, setRunning] = useState(false)
  const [run, setRun] = useState<SuiteRun | null>(null)
  const [history, setHistory] = useState<RunRow[]>([])
  const [error, setError] = useState("")

  const loadHistory = useCallback((id: string) => {
    if (!id) return setHistory([])
    listRuns("suite", id).then(setHistory).catch((e) => setError(errorMessage(e)))
  }, [])

  useEffect(() => {
    listSuites().then(setSuites).catch((e) => setError(errorMessage(e)))
    listServicePresets().then(setPresets).catch(() => {})
  }, [])

  const open = (s: Suite) => {
    setDraft(structuredClone(s))
    setDirty(false)
    setRunEnvs(s.envs)
    setRun(null)
    setError("")
    loadHistory(s.id)
  }

  const edit = (next: Suite) => {
    setDraft(next)
    setDirty(true)
  }

  const save = async (): Promise<Suite | null> => {
    if (!draft) return null
    try {
      const saved = await saveSuite({ ...draft, envs: runEnvs })
      setSuites(await listSuites())
      setDraft(saved)
      setDirty(false)
      setError("")
      return saved
    } catch (e) {
      setError(errorMessage(e))
      return null
    }
  }

  const runIt = async () => {
    const saved = dirty || !draft?.id ? await save() : draft
    if (!saved) return
    setRunning(true)
    setError("")
    try {
      const result = await runSuite(saved.id, runEnvs)
      setRun(result)
      loadHistory(saved.id)
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setRunning(false)
    }
  }

  const remove = async () => {
    if (!draft?.id) return setDraft(null)
    if (!window.confirm(`Delete the suite "${draft.name}" and its history?`)) return
    try {
      await deleteSuite(draft.id)
      setSuites(await listSuites())
      setDraft(null)
    } catch (e) {
      setError(errorMessage(e))
    }
  }

  const openRun = async (row: RunRow) => {
    try {
      setRun((await getRun<SuiteRun>(row.id)).result)
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }

  if (!suites) return error ? <ErrorNote message={error} /> : <Spinner />

  return (
    <div className="grid gap-4 lg:grid-cols-[14rem_1fr]">
      <div className="flex flex-col gap-1">
        <Button variant="outline" size="sm" onClick={() => open({ ...newSuite(), envs })}>
          <IconPlus /> New suite
        </Button>
        {suites.map((s) => (
          <button
            key={s.id}
            type="button"
            onClick={() => open(s)}
            className={cn(
              "rounded-md px-2 py-1.5 text-left text-xs hover:bg-muted",
              draft?.id === s.id && "bg-muted font-medium",
            )}
          >
            <span className="block truncate">{s.name}</span>
            <span className="text-[11px] text-muted-foreground">{s.cases.length} cases</span>
          </button>
        ))}
        {suites.length === 0 && <p className="px-2 py-1 text-xs text-muted-foreground">No suites yet.</p>}
      </div>

      {!draft ? (
        <p className="rounded-xl border bg-card px-4 py-3.5 text-xs text-muted-foreground">
          Pick a suite, or create one. A suite is a list of service calls with assertions, run on one or more
          environments. Services really execute, so choose read-only ones.
        </p>
      ) : (
        <div className="flex min-w-0 flex-col gap-4">
          <ErrorNote message={error} />
          <div className="flex flex-col gap-3 rounded-xl border bg-card p-3">
            <div className="grid gap-2 sm:grid-cols-2">
              <Field label="Suite name">
                <Input value={draft.name} onChange={(e) => edit({ ...draft, name: e.target.value })} />
              </Field>
              <Field label="Description">
                <Input value={draft.description} onChange={(e) => edit({ ...draft, description: e.target.value })} />
              </Field>
            </div>
            <div className="flex flex-col gap-1">
              <span className="text-[11px] font-medium text-muted-foreground">Run on environments</span>
              <EnvPicker
                envs={envs}
                value={runEnvs}
                onChange={(next) => {
                  setRunEnvs(next)
                  setDirty(true)
                }}
              />
            </div>
            <div className="flex items-center gap-2">
              <Button size="sm" onClick={runIt} disabled={running || runEnvs.length === 0 || draft.cases.length === 0}>
                {running ? <IconLoader2 className="animate-spin" /> : <IconPlayerPlay />} Run
              </Button>
              <Button size="sm" variant="outline" onClick={save} disabled={!dirty}>
                Save
              </Button>
              <Button size="sm" variant="ghost" onClick={remove}>
                <IconTrash /> Delete
              </Button>
              {dirty && <span className="text-xs text-muted-foreground">Unsaved changes</span>}
            </div>
          </div>

          {draft.cases.map((c, i) => (
            <CaseEditor
              key={c.id}
              value={c}
              envs={envs}
              presets={presets}
              onChange={(next) => edit({ ...draft, cases: draft.cases.map((x, j) => (j === i ? next : x)) })}
              onRemove={() => edit({ ...draft, cases: draft.cases.filter((_, j) => j !== i) })}
            />
          ))}
          <Button variant="outline" size="sm" className="w-fit" onClick={() => edit({ ...draft, cases: [...draft.cases, newCase()] })}>
            <IconPlus /> Add case
          </Button>

          {run && <ResultsGrid run={run} />}

          {history.length > 0 && (
            <div className="flex flex-col gap-1">
              <h3 className="text-xs font-medium">History (last 50)</h3>
              <RunHistory id="automation-suite-runs" rows={history} onOpen={openRun} />
            </div>
          )}
        </div>
      )}
    </div>
  )
}
