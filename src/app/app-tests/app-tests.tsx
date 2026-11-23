"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useRouter } from "next/navigation"
import { IconBrowserCheck, IconDownload, IconLoader2, IconPlus, IconSearch, IconUpload, IconLayoutSidebarRight } from "@tabler/icons-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable"
import { Spinner } from "@/components/ui/spinner"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { useDockChat } from "@/components/assistant/dock"
import { assistantModels, assistantProviders, type ModelInfo, type ProviderInfo } from "@/lib/assistant/api"
import { useAssistantContext } from "@/lib/assistant/context"
import { listRuns, type RunRow } from "@/lib/automation"
import { saveEntityAs } from "@/lib/entities"
import { errorMessage } from "@/lib/settings"
import {
  activeUiRun, cancelUiRun, deleteUiSuite, exportUiCsv, getUiSuite, importUiCsv, listUiSuites, newUiCase, newUiSuite,
  onUiChanged, onUiDone, onUiProgress, runUiTests, saveUiCases, saveUiSuite,
  type UiRunProgress, type UiTestCase, type UiTestMode, type UiTestSuite,
} from "@/lib/ui-tests"
import { ErrorNote } from "../automation/shared"
import { CaseDetail } from "./case-detail"
import { AgentPanel, runInstructions } from "./agent-panel"
import { UiTestsGrid } from "./cases-grid"
import { SuiteHeader, type RunState } from "./header"
import { ReportDialog } from "./report-dialog"
import { RunsTab } from "./runs-tab"
import { SettingsTab } from "./settings-tab"
import { countStatuses, formatMs, TMP } from "./shared"
import { SuiteList, type SuiteStats } from "./suite-list"
import { askConfirm } from "@/lib/confirm"

const DETAIL_PANEL_KEY = "appTests.detailPanel"

const FILTERS = [
  ["all", "All statuses"],
  ["passed", "Passed"],
  ["failed", "Failed"],
  ["needsReview", "Needs review"],
  ["notRun", "Not run"],
] as const

/** App Tests: AI-driven ThingWorx browser tests with Azure-layout cases, a saved login and live runs. */
export function AppTests({ envs }: { envs: string[] }) {
  const router = useRouter()
  const chat = useDockChat()
  const [suites, setSuites] = useState<UiTestSuite[] | null>(null)
  const [suite, setSuite] = useState<UiTestSuite | null>(null)
  const [suiteDirty, setSuiteDirty] = useState(false)
  const [cases, setCases] = useState<UiTestCase[]>([])
  const [casesDirty, setCasesDirty] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [activeId, setActiveId] = useState("")
  // Side detail panel is opt-in; the grid alone is the default.
  const [showDetail, setShowDetail] = useState(() => {
    try {
      return localStorage.getItem(DETAIL_PANEL_KEY) === "1"
    } catch {
      return false
    }
  })
  const toggleDetail = () => {
    const next = !showDetail
    setShowDetail(next)
    try {
      localStorage.setItem(DETAIL_PANEL_KEY, next ? "1" : "0")
    } catch {}
  }
  const [tab, setTab] = useState("cases")
  const [search, setSearch] = useState("")
  const [filter, setFilter] = useState<string>("all")
  const [stats, setStats] = useState<Record<string, SuiteStats>>({})
  const [providers, setProviders] = useState<ProviderInfo[]>([])
  const [models, setModels] = useState<ModelInfo[]>([])
  const suiteProvider = suite?.provider ?? ""
  useEffect(() => {
    if (!suiteProvider) return
    let cancelled = false
    assistantModels(suiteProvider)
      .then((m) => !cancelled && setModels(m))
      .catch(() => !cancelled && setModels([]))
    return () => {
      cancelled = true
    }
  }, [suiteProvider])
  const [runMode, setRunMode] = useState<"" | UiTestMode>("")
  const [run, setRun] = useState<RunState | null>(null)
  const [history, setHistory] = useState<RunRow[]>([])
  const [pendingCsv, setPendingCsv] = useState<{ name: string; text: string } | null>(null)
  const [busy, setBusy] = useState("")
  const [error, setError] = useState("")
  /** Open "Generate test document" dialog; runId null = the latest run. */
  const [report, setReport] = useState<{ runId: string | null } | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const newFileRef = useRef<HTMLInputElement>(null)

  const suiteIdRef = useRef("")
  const casesDirtyRef = useRef(false)
  useEffect(() => {
    suiteIdRef.current = suite?.id ?? ""
    casesDirtyRef.current = casesDirty
  })

  const fail = (e: unknown) => toast.error(errorMessage(e))

  const loadHistory = useCallback((id: string) => {
    if (!id) return setHistory([])
    listRuns("uitest", id).then(setHistory).catch(() => setHistory([]))
  }, [])

  const openSuite = useCallback(
    async (id: string) => {
      try {
        const r = await getUiSuite(id)
        setSuite(r.suite)
        setCases(r.cases)
        setSuiteDirty(false)
        setCasesDirty(false)
        setSelected(new Set())
        setActiveId("")
        setPendingCsv(null)
        setError("")
        loadHistory(id)
      } catch (e) {
        fail(e)
      }
    },
    [loadHistory],
  )

  const refreshList = useCallback(() => listUiSuites().then(setSuites).catch((e) => setError(errorMessage(e))), [])

  useEffect(() => {
    void refreshList()
    assistantProviders().then(setProviders).catch(() => {})
    // Reattach to a run that was started before this page mounted.
    activeUiRun()
      .then((a) => {
        if (!a) return
        setRun({ runId: a.runId, suiteId: a.suiteId, index: 0, total: 0 })
        void openSuite(a.suiteId)
      })
      .catch(() => {})
  }, [refreshList, openSuite])

  // Live progress: update the case rows in place.
  useEffect(() => {
    const offs: Promise<() => void>[] = []
    offs.push(
      onUiProgress((p: UiRunProgress) => {
        setRun((r) => (r && r.runId !== p.runId ? r : { runId: p.runId, suiteId: p.suiteId, index: p.index, total: p.total }))
        if (p.suiteId !== suiteIdRef.current) return
        setCases((cs) =>
          cs.map((c) =>
            c.id === p.caseId
              ? { ...c, status: p.status, reason: p.reason, stepResults: p.stepResults, chatId: p.chatId || c.chatId }
              : c,
          ),
        )
      }),
    )
    offs.push(
      onUiDone((d) => {
        setRun(null)
        if (d.error) toast.error(d.error)
        else if (d.cancelled) toast(`Run stopped: ${d.passed} passed, ${d.failed} failed of ${d.total}`)
        else toast.success(`Run finished: ${d.passed} passed, ${d.failed} failed of ${d.total}`)
        if (d.suiteId === suiteIdRef.current) {
          loadHistory(d.suiteId)
          // Pull final durations and timestamps, unless the user has unsaved edits.
          if (!casesDirtyRef.current) {
            getUiSuite(d.suiteId).then((r) => setCases(r.cases)).catch(() => {})
          }
        }
        void refreshList()
      }),
    )
    return () => {
      offs.forEach((p) => p.then((off) => off()).catch(() => {}))
    }
  }, [loadHistory, refreshList])

  // The assistant (or an MCP client) changed a suite: reload it, unless that would clobber unsaved edits.
  const suiteDirtyRef = useRef(false)
  useEffect(() => {
    suiteDirtyRef.current = suiteDirty
  })
  useEffect(() => {
    const off = onUiChanged((changedId) => {
      void refreshList()
      if (!changedId || changedId !== suiteIdRef.current) return
      const reload = () =>
        getUiSuite(changedId)
          .then((r) => {
            setSuite(r.suite)
            setCases(r.cases)
            setSuiteDirty(false)
            setCasesDirty(false)
            setSelected(new Set())
            setActiveId("")
            loadHistory(changedId)
          })
          .catch(() => {})
      if (casesDirtyRef.current || suiteDirtyRef.current) {
        toast("Assistant changed this suite", { id: "uitest-changed", action: { label: "Reload", onClick: reload } })
      } else {
        void reload()
      }
    })
    return () => {
      off.then((f) => f()).catch(() => {})
    }
  }, [loadHistory, refreshList])

  // Remember the latest verdict counts of the open suite for the suite list.
  const openId = suite?.id ?? ""
  useEffect(() => {
    if (!openId) return
    const n = countStatuses(cases)
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setStats((s) => ({ ...s, [openId]: { passed: n.passed, failed: n.failed, total: n.total } }))
  }, [openId, cases])

  const confirmDiscard = async () => !(suiteDirty || casesDirty) || (await askConfirm("You have unsaved changes. Discard them?"))

  const pick = async (id: string) => {
    if (id === suite?.id || !(await confirmDiscard())) return
    setTab("cases")
    void openSuite(id)
  }

  const startNew = async () => {
    if (!(await confirmDiscard())) return
    setSuite(newUiSuite(envs[0] ?? ""))
    setSuiteDirty(true)
    setCases([])
    setCasesDirty(false)
    setSelected(new Set())
    setActiveId("")
    setHistory([])
    setTab("settings")
  }

  const editSuite = (part: Partial<UiTestSuite>) => {
    if (!suite) return
    setSuite({ ...suite, ...part })
    setSuiteDirty(true)
  }

  const saveSuite = async () => {
    if (!suite) return
    if (!suite.name.trim()) return toast.error("Give the suite a name.")
    setBusy("suite")
    try {
      const saved = await saveUiSuite(suite)
      const isNew = !suite.id
      setSuite(saved)
      setSuiteDirty(false)
      await refreshList()
      if (isNew) {
        loadHistory(saved.id)
        setTab("cases")
      }
      toast.success("Suite saved")
    } catch (e) {
      fail(e)
    } finally {
      setBusy("")
    }
  }

  const removeSuite = async (target: UiTestSuite | null = suite) => {
    if (!target) return
    if (!target.id) {
      setSuite(null)
      setSuiteDirty(false)
      return
    }
    if (!(await askConfirm(`Delete the suite "${target.name}" and all its cases?`))) return
    try {
      await deleteUiSuite(target.id)
      if (target.id === suite?.id) {
        setSuite(null)
        setCases([])
        setSuiteDirty(false)
        setCasesDirty(false)
        setActiveId("")
      }
      await refreshList()
    } catch (e) {
      fail(e)
    }
  }

  const duplicateSuite = async (id: string) => {
    if (!(await confirmDiscard())) return
    try {
      const src = await getUiSuite(id)
      const copy = await saveUiSuite({ ...src.suite, id: "", name: `${src.suite.name} copy` })
      await saveUiCases(
        copy.id,
        src.cases.map((c, i) => ({
          ...c, id: "", suiteId: copy.id, position: i, status: "notRun", reason: "", stepResults: [],
          chatId: "", lastRunAt: null, durationMs: null,
        })),
      )
      await refreshList()
      await openSuite(copy.id)
      toast.success("Suite duplicated")
    } catch (e) {
      fail(e)
    }
  }

  const editCases = (next: UiTestCase[]) => {
    setCases(next)
    setCasesDirty(true)
  }

  const saveCases = async (): Promise<boolean> => {
    if (!suite?.id) return false
    setBusy("cases")
    try {
      const keepSelected = new Set([...selected].filter((id) => !id.startsWith(TMP)))
      const activeIndex = cases.findIndex((c) => c.id === activeId)
      const saved = await saveUiCases(
        suite.id,
        cases.map((c, i) => ({ ...c, id: c.id.startsWith(TMP) ? "" : c.id, position: i })),
      )
      setCases(saved)
      setCasesDirty(false)
      setSelected(keepSelected)
      setActiveId(saved[activeIndex]?.id ?? "")
      void refreshList()
      return true
    } catch (e) {
      fail(e)
      return false
    } finally {
      setBusy("")
    }
  }

  const addCase = () => {
    if (!suite?.id) return
    const c = { ...newUiCase(suite.id), id: `${TMP}${crypto.randomUUID()}` }
    editCases([...cases, c])
    setActiveId(c.id)
  }

  // Adds a step to the highlighted case (click a case row to pick it), else to the last case.
  const addStep = () => {
    const target = cases.find((c) => c.id === activeId) ?? cases[cases.length - 1]
    if (!target) return
    editCases(cases.map((c) => (c.id === target.id ? { ...c, steps: [...c.steps, { action: "", expected: "" }] } : c)))
    setActiveId(target.id)
  }

  const doImport = async (replace: boolean) => {
    if (!suite?.id || !pendingCsv) return
    if (casesDirty && !(await askConfirm("Importing reloads the cases and discards unsaved edits. Continue?"))) return
    setBusy("import")
    try {
      const all = await importUiCsv(suite.id, pendingCsv.text, replace)
      setCases(all)
      setCasesDirty(false)
      setSelected(new Set())
      setActiveId("")
      setPendingCsv(null)
      void refreshList()
      toast.success(`Imported ${pendingCsv.name}`)
    } catch (e) {
      fail(e)
    } finally {
      setBusy("")
    }
  }

  /** Empty state: create a suite named after the file and load the CSV into it. */
  const importAsNewSuite = async (file: File | undefined) => {
    if (!file) return
    setBusy("import")
    try {
      const text = await file.text()
      const created = await saveUiSuite({ ...newUiSuite(envs[0] ?? ""), name: file.name.replace(/\.csv$/i, "") || "Imported suite" })
      await importUiCsv(created.id, text, true)
      await refreshList()
      await openSuite(created.id)
      toast.success(`Imported ${file.name}`)
    } catch (e) {
      fail(e)
    } finally {
      setBusy("")
    }
  }

  const doExport = async () => {
    if (!suite?.id) return
    if (casesDirty && !(await saveCases())) return
    setBusy("export")
    try {
      const ids = selected.size > 0 ? [...selected] : null
      const csv = await exportUiCsv(suite.id, ids)
      const { save } = await import("@tauri-apps/plugin-dialog")
      const dest = await save({
        title: "Export test cases",
        defaultPath: `${suite.name || "app-tests"}.csv`,
        filters: [{ name: "CSV", extensions: ["csv"] }],
      })
      if (!dest) return
      await saveEntityAs(dest, csv)
      toast.success(`Saved to ${dest}`)
    } catch (e) {
      fail(e)
    } finally {
      setBusy("")
    }
  }

  const start = async (which: "selected" | "all" | "failed" | string[]) => {
    if (!suite?.id) return
    if (suiteDirty && !(await askConfirm("The suite settings have unsaved changes; the run uses the saved settings. Continue?"))) return
    // Resolve a single new case to its saved id (positions survive the save).
    const wantIndexes = Array.isArray(which) ? which.map((id) => cases.findIndex((c) => c.id === id)) : []
    if (casesDirty && !(await saveCases())) return
    // Resolve ids after the save, from the latest cases returned by the backend.
    const fresh = (await getUiSuite(suite.id)).cases
    setCases(fresh)
    let ids: string[] | null = null
    if (Array.isArray(which)) ids = wantIndexes.map((i) => fresh[i]?.id).filter((id): id is string => !!id)
    else if (which === "selected") ids = fresh.filter((c) => selected.has(c.id)).map((c) => c.id)
    else if (which === "failed") ids = fresh.filter((c) => c.status === "failed" || c.status === "error").map((c) => c.id)
    if (ids && ids.length === 0) return toast.error(which === "selected" ? "Select at least one case." : "No failed cases.")
    try {
      const runId = await runUiTests(suite.id, ids, runMode || null, runInstructions(suite.id))
      setRun({ runId, suiteId: suite.id, index: 0, total: ids?.length ?? fresh.length })
    } catch (e) {
      fail(e)
    }
  }

  const stop = () => {
    if (run) cancelUiRun(run.runId).catch(fail)
  }

  const openTranscript = (chatId: string) => {
    void chat.openChat(chatId)
    router.push("/assistant")
  }

  const onFile = async (file: File | undefined) => {
    if (!file) return
    try {
      setPendingCsv({ name: file.name, text: await file.text() })
    } catch (e) {
      fail(e)
    }
  }

  const counts = useMemo(() => countStatuses(cases), [cases])
  const lastRun = cases.reduce((m, c) => Math.max(m, c.lastRunAt ?? 0), 0)
  const needle = search.trim().toLowerCase()
  const visible = useCallback(
    (c: UiTestCase) => {
      const statusOk =
        filter === "all" ||
        (filter === "failed" ? c.status === "failed" || c.status === "error" : filter === "notRun" ? c.status === "notRun" || c.status === "running" : c.status === filter)
      if (!statusOk) return false
      if (!needle) return true
      return `${c.title} ${c.tags} ${c.adoId ?? ""} ${c.steps.map((s) => `${s.action} ${s.expected}`).join(" ")}`
        .toLowerCase()
        .includes(needle)
    },
    [filter, needle],
  )
  const active = cases.find((c) => c.id === activeId) ?? null

  useAssistantContext({
    screen: "app-tests",
    title: "App Tests",
    summary: suite ? `${suite.name || "New suite"}, ${tab} tab` : "no suite open",
    data: {
      suite: suite ? { id: suite.id, name: suite.name, environment: suite.envId, mode: suite.mode } : null,
      counts,
      running: !!run,
      selectedCase: active ? { title: active.title, status: active.status, reason: active.reason } : null,
      error,
    },
  })

  if (!suites) return error ? <div className="p-4"><ErrorNote message={error} /></div> : <Spinner />

  const running = !!run
  const runningHere = !!run && run.suiteId === suite?.id
  const nothing = busy !== "" || running
  const saved = !!suite?.id

  const fileInput = (ref: React.RefObject<HTMLInputElement | null>, handler: (f: File | undefined) => void) => (
    <input
      ref={ref}
      type="file"
      accept=".csv,text/csv"
      className="hidden"
      onChange={(e) => {
        handler(e.target.files?.[0])
        e.target.value = ""
      }}
    />
  )

  const empty = (
    <div className="flex h-full items-center justify-center p-6">
      <div className="flex max-w-md flex-col items-center gap-3 rounded-xl border bg-card px-6 py-7 text-center">
        <IconBrowserCheck className="size-8 text-primary" />
        <h2 className="font-heading text-base font-semibold">
          {suites.length === 0 ? "Create your first suite" : "Pick a suite"}
        </h2>
        <p className="text-xs text-muted-foreground">
          App Tests use the Azure DevOps test case layout (import and export CSV). An AI model drives a real browser through each
          case&apos;s steps using a saved ThingWorx login, then reports a verdict.
        </p>
        <div className="flex gap-2">
          <Button size="sm" onClick={startNew}>
            <IconPlus /> New suite
          </Button>
          <Button size="sm" variant="outline" disabled={busy === "import"} onClick={() => newFileRef.current?.click()}>
            {busy === "import" ? <IconLoader2 className="animate-spin" /> : <IconUpload />} Import Azure CSV
          </Button>
        </div>
      </div>
    </div>
  )

  return (
    <ResizablePanelGroup id="app-tests" className="h-full">
      {fileInput(newFileRef, importAsNewSuite)}
      <ResizablePanel id="suites" defaultSize="260px" minSize="200px" maxSize="420px" groupResizeBehavior="preserve-pixel-size">
        <SuiteList
          suites={suites}
          activeId={suite?.id ?? ""}
          unsaved={!!suite && !suite.id}
          stats={stats}
          onPick={pick}
          onNew={startNew}
          onDuplicate={duplicateSuite}
          onDelete={(s) => void removeSuite(s)}
          disabled={nothing}
        />
      </ResizablePanel>
      <ResizableHandle />
      <ResizablePanel id="main" minSize="40%" className="min-w-0">
        {!suite ? (
          empty
        ) : (
          <div className="flex h-full min-h-0 min-w-0 flex-col">
            <SuiteHeader
              suite={suite}
              suiteDirty={suiteDirty}
              savingSuite={busy === "suite"}
              onName={(name) => editSuite({ name })}
              onSaveSuite={saveSuite}
              onOpenSettings={() => setTab("settings")}
              run={run}
              runningHere={runningHere}
              counts={counts}
              runMode={runMode}
              onRunMode={setRunMode}
              onStart={(w) => void start(w)}
              onStop={stop}
              selectedCount={selected.size}
              canRun={saved && !nothing}
              hasFailed={counts.failed > 0}
              caseCount={cases.length}
              hasRuns={history.length > 0}
              onOpenReport={() => setReport({ runId: null })}
            />
            {saved && <AgentPanel key={suite.id} suiteId={suite.id} runningHere={runningHere} cases={cases} />}
            {saved && (
              <div className="flex flex-wrap items-center gap-x-5 gap-y-1 border-b bg-muted/30 px-3 py-1.5 text-xs">
                <span><b>{counts.total}</b> cases</span>
                <span className="text-success"><b>{counts.passed}</b> passed</span>
                <span className="text-destructive"><b>{counts.failed}</b> failed</span>
                <span className="text-warning"><b>{counts.review}</b> needs review</span>
                <span className="text-muted-foreground"><b>{counts.notRun}</b> not run</span>
                <span className="ml-auto text-muted-foreground">Last run {formatMs(lastRun || null)}</span>
              </div>
            )}
            <Tabs value={tab} onValueChange={(v) => setTab(String(v))} className="min-h-0 flex-1 gap-0">
              <div className="border-b px-3 py-1.5">
                <TabsList>
                  <TabsTrigger value="cases" disabled={!saved}>Cases</TabsTrigger>
                  <TabsTrigger value="runs" disabled={!saved}>Runs{history.length > 0 ? ` (${history.length})` : ""}</TabsTrigger>
                  <TabsTrigger value="settings">Settings</TabsTrigger>
                </TabsList>
              </div>

              <TabsContent value="cases" className="flex min-h-0 flex-1 flex-col">
                <div className="flex flex-wrap items-center gap-1.5 border-b px-3 py-1.5">
                  <Button size="sm" variant="outline" onClick={addCase} disabled={nothing}>
                    <IconPlus /> Add case
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={addStep}
                    disabled={nothing || cases.length === 0}
                    title="Add a step to the highlighted case (click a case row first), or to the last case"
                  >
                    <IconPlus /> Add step
                  </Button>
                  <Button
                    size="sm"
                    onClick={() => saveCases().then((ok) => ok && toast.success("Cases saved"))}
                    disabled={!casesDirty || nothing}
                  >
                    {busy === "cases" && <IconLoader2 className="animate-spin" />} Save
                  </Button>
                  {casesDirty && <span className="text-xs text-muted-foreground">Unsaved edits</span>}
                  <span className="mx-1 h-4 border-l" />
                  {fileInput(fileRef, onFile)}
                  <Button size="sm" variant="outline" onClick={() => fileRef.current?.click()} disabled={nothing}>
                    <IconUpload /> Import CSV
                  </Button>
                  <Button size="sm" variant="outline" onClick={doExport} disabled={nothing || cases.length === 0}>
                    <IconDownload /> Export CSV{selected.size > 0 ? ` (${selected.size})` : ""}
                  </Button>
                  <div className="ml-auto flex items-center gap-1.5">
                    <Button
                      size="sm"
                      variant={showDetail ? "secondary" : "ghost"}
                      onClick={toggleDetail}
                      title={showDetail ? "Hide the case detail panel" : "Show a detail panel for the selected case"}
                    >
                      <IconLayoutSidebarRight /> Details
                    </Button>
                    <div className="relative">
                      <IconSearch className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                      <Input className="h-6 w-44 pl-7 text-xs" placeholder="Search cases" value={search} onChange={(e) => setSearch(e.target.value)} />
                    </div>
                    <NativeSelect size="sm" className="w-32" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter by status">
                      {FILTERS.map(([v, l]) => (
                        <NativeSelectOption key={v} value={v}>{l}</NativeSelectOption>
                      ))}
                    </NativeSelect>
                  </div>
                </div>

                {pendingCsv && (
                  <div className="flex flex-wrap items-center gap-2 border-b bg-muted/30 px-3 py-1.5 text-xs">
                    <span>
                      Import <b>{pendingCsv.name}</b>:
                    </span>
                    <Button size="sm" variant="outline" disabled={busy === "import"} onClick={() => doImport(false)}>
                      Append
                    </Button>
                    <Button size="sm" variant="outline" disabled={busy === "import"} onClick={() => doImport(true)}>
                      Replace all
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setPendingCsv(null)}>
                      Cancel
                    </Button>
                    <span className="text-muted-foreground">Append updates cases whose ID already exists.</span>
                  </div>
                )}

                <ResizablePanelGroup id="app-tests-cases" className="min-h-0 flex-1">
                  <ResizablePanel id="grid" minSize="30%" className="min-w-0">
                    <UiTestsGrid
                      cases={cases}
                      onChange={editCases}
                      selected={selected}
                      onSelect={setSelected}
                      suiteMode={suite.mode}
                      onOpenTranscript={openTranscript}
                      activeId={activeId}
                      onActivate={setActiveId}
                      visible={visible}
                    />
                  </ResizablePanel>
                  {showDetail && active && <ResizableHandle />}
                  {showDetail && active && (
                    <ResizablePanel id="detail" defaultSize="380px" minSize="280px" maxSize="60%" groupResizeBehavior="preserve-pixel-size">
                      <CaseDetail
                        c={active}
                        suiteMode={suite.mode}
                        onPatch={(part) => editCases(cases.map((c) => (c.id === active.id ? { ...c, ...part } : c)))}
                        onClose={() => setActiveId("")}
                        onRun={() => void start([active.id])}
                        canRun={saved && !nothing}
                        onOpenTranscript={openTranscript}
                      />
                    </ResizablePanel>
                  )}
                </ResizablePanelGroup>
              </TabsContent>

              <TabsContent value="runs" className="min-h-0 flex-1">
                <RunsTab
                  history={history}
                  onReload={() => loadHistory(suite.id)}
                  onOpenTranscript={openTranscript}
                  onGenerate={(runId) => setReport({ runId })}
                />
              </TabsContent>

              <TabsContent value="settings" className="min-h-0 flex-1">
                <SettingsTab
                  suite={suite}
                  envs={envs}
                  providers={providers}
                  models={models}
                  dirty={suiteDirty}
                  busy={busy === "suite"}
                  locked={runningHere}
                  onEdit={editSuite}
                  onSave={saveSuite}
                  onDelete={() => void removeSuite()}
                />
              </TabsContent>
            </Tabs>
            {report && suite.id && (
              <ReportDialog
                suite={suite}
                runId={report.runId}
                selectedCaseIds={[...selected].filter((id) => !id.startsWith(TMP))}
                onClose={() => setReport(null)}
              />
            )}
          </div>
        )}
      </ResizablePanel>
    </ResizablePanelGroup>
  )
}
