import { invoke } from "@tauri-apps/api/core"

// Typed wrappers over src-tauri/src/commands/automation.rs.
// Errors reject with `{ code, message }`; read them with errorMessage from @/lib/settings.

export type Assertion =
  | { type: "succeeds" }
  | { type: "maxMs"; ms: number }
  | { type: "rowCount"; op: string; value: number }
  | { type: "jsonPath"; path: string; op: string; value?: unknown }
  | { type: "textContains"; text: string }

export type TestCase = {
  id: string
  name: string
  /** Empty = every environment the suite runs on. */
  envs: string[]
  collection: string
  entity: string
  service: string
  inputs: Record<string, unknown>
  assertions: Assertion[]
}

export type Suite = {
  id: string
  name: string
  description: string
  envs: string[]
  cases: TestCase[]
  createdAt: number
  updatedAt: number
}

export type Check = { label: string; passed: boolean; expected: string; actual: string }

export type CaseResult = {
  caseId: string
  caseName: string
  env: string
  passed: boolean
  durationMs: number
  error: string | null
  checks: Check[]
  output: string
}

export type SuiteRun = {
  runId: string
  suiteId: string
  suiteName: string
  startedAt: number
  durationMs: number
  envs: string[]
  total: number
  passed: number
  failed: number
  results: CaseResult[]
}

export type RunRow = {
  id: string
  kind: "suite" | "drift"
  refId: string
  name: string
  status: string
  summary: string
  startedAt: number
  durationMs: number
}

export type RunDetail<T> = RunRow & { result: T }

export type DriftRequest = { envA: string; envB: string; projects: string[]; compareXml: boolean }

export type DriftEntity = { project: string; entityType: string; name: string }

export type DriftReport = {
  runId: string
  envA: string
  envB: string
  projects: string[]
  compareXml: boolean
  startedAt: number
  durationMs: number
  onlyA: DriftEntity[]
  onlyB: DriftEntity[]
  different: DriftEntity[]
  same: DriftEntity[]
  unchecked: DriftEntity[]
  warnings: string[]
}

export type Repeat =
  | { type: "interval"; minutes: number }
  | { type: "daily"; time: string }
  | { type: "weekly"; days: number[]; time: string }

export type Target =
  | { type: "suite"; suiteId: string }
  | { type: "drift"; envA: string; envB: string; projects: string[]; compareXml: boolean }
  | { type: "flow"; flowId: string; env: string }
  | { type: "assistant"; prompt: string }

export type Schedule = {
  id: string
  name: string
  enabled: boolean
  repeat: Repeat
  target: Target
  utcOffsetMin: number
  lastRunAt: number | null
  lastStatus: "ok" | "failed" | "error" | null
  lastMessage: string | null
  nextRunAt: number | null
  createdAt: number
  updatedAt: number
}

export type ScheduleInput = {
  id?: string | null
  name: string
  enabled: boolean
  repeat: Repeat
  target: Target
  utcOffsetMin?: number
}

export type FlowRef = { id: string; name: string; environment: string }

/** Minutes ahead of UTC in this browser's zone, for daily and weekly schedules. */
export const localUtcOffsetMin = () => -new Date().getTimezoneOffset()

export const listSuites = () => invoke<Suite[]>("automation_suites_list")
export const saveSuite = (suite: Suite) => invoke<Suite>("automation_suite_save", { suite })
export const deleteSuite = (id: string) => invoke<void>("automation_suite_delete", { id })
/** Runs the suite's services for real on each environment. */
export const runSuite = (id: string, envs?: string[]) => invoke<SuiteRun>("automation_suite_run", { id, envs })

export const listRuns = (kind: "suite" | "drift", refId?: string) =>
  invoke<RunRow[]>("automation_runs_list", { kind, refId })
export const getRun = <T>(id: string) => invoke<RunDetail<T>>("automation_run_get", { id })
export const deleteRun = (id: string) => invoke<void>("automation_run_delete", { id })

export const runDrift = (request: DriftRequest) => invoke<DriftReport>("automation_drift_run", { request })
/** Both environments' normalised XML of one entity (empty where it is missing). */
export const driftEntityXml = (envA: string, envB: string, entityType: string, name: string) =>
  invoke<[string, string]>("automation_drift_entity_xml", { envA, envB, entityType, name })

export const listSchedules = () => invoke<Schedule[]>("automation_schedules_list")
export const saveSchedule = (input: ScheduleInput) => invoke<Schedule>("automation_schedule_save", { input })
export const setScheduleEnabled = (id: string, enabled: boolean) =>
  invoke<Schedule>("automation_schedule_enable", { id, enabled })
export const deleteSchedule = (id: string) => invoke<void>("automation_schedule_delete", { id })
export const runScheduleNow = (id: string) => invoke<Schedule>("automation_schedule_run", { id })

export const listFlows = () => invoke<FlowRef[]>("flow_list")

export const newCase = (): TestCase => ({
  id: crypto.randomUUID(),
  name: "New case",
  envs: [],
  collection: "Things",
  entity: "",
  service: "",
  inputs: {},
  assertions: [{ type: "succeeds" }],
})

export const newSuite = (): Suite => ({
  id: "",
  name: "",
  description: "",
  envs: [],
  cases: [],
  createdAt: 0,
  updatedAt: 0,
})

export const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]

export function describeRepeat(r: Repeat): string {
  if (r.type === "interval") return r.minutes % 60 === 0 ? `Every ${r.minutes / 60} h` : `Every ${r.minutes} min`
  if (r.type === "daily") return `Daily at ${r.time}`
  return `${r.days.map((d) => DAY_NAMES[d]).join(", ")} at ${r.time}`
}

export const formatTime = (secs: number | null | undefined) =>
  secs ? new Date(secs * 1000).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "—"
