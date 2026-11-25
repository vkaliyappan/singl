import { invoke } from "@tauri-apps/api/core"
import { listen, type UnlistenFn } from "@tauri-apps/api/event"

// Typed wrappers over the uitest_* Tauri commands (AI-driven ThingWorx UI tests).
// Errors reject with `{ code, message }`; read them with errorMessage from @/lib/settings.

export type UiTestMode = "headless" | "headed"
export type UiCaseStatus = "notRun" | "running" | "passed" | "failed" | "needsReview" | "error"

export interface UiTestStep {
  action: string
  expected: string
}
export interface UiStepResult {
  step: number
  status: "passed" | "failed" | "skipped"
  note: string
  screenshot?: string
}

export interface UiTestSuite {
  id: string
  name: string
  description: string
  envId: string
  provider: string
  model: string
  mode: UiTestMode
  caseCount: number
  createdAt: number
  updatedAt: number
}

export interface UiTestCase {
  id: string
  suiteId: string
  position: number
  adoId: number | null
  title: string
  areaPath: string
  assignedTo: string
  state: string
  tags: string
  mode: "" | UiTestMode
  steps: UiTestStep[]
  status: UiCaseStatus
  reason: string
  stepResults: UiStepResult[]
  chatId: string
  lastRunAt: number | null
  durationMs: number | null
  updatedAt: number
}

export interface UiSessionStatus {
  envId: string
  exists: boolean
  savedAt: number | null
  verifiedAt: number | null
  valid: boolean | null
  loginOpen: boolean
  message: string
}

export interface UiRunProgress {
  runId: string
  suiteId: string
  caseId: string
  status: UiCaseStatus
  reason: string
  stepResults: UiStepResult[]
  chatId: string
  index: number
  total: number
}
export interface UiRunDone {
  runId: string
  suiteId: string
  passed: number
  failed: number
  total: number
  cancelled: boolean
  error: string
}

export type UiReportFormat = "docx" | "pdf" | "md"
export type UiReportScreenshots = "all" | "failed" | "none"
export interface UiReportArgs {
  suiteId: string
  /** null = the latest run. */
  runId: string | null
  /** null = all cases in the run. */
  caseIds: string[] | null
  format: UiReportFormat
  /** Absolute file path of the document to write. */
  path: string
  title: string
  preparedBy: string
  screenshots: UiReportScreenshots
  /** Optional ThingWorx user story reference, e.g. "US 27432 - Feature Group Column". "" = none. */
  userStory: string
  /** Optional iteration label, e.g. "1.18". "" = none. */
  iteration: string
  /** Optional .docx whose fonts and styles the document reuses (Word only). "" = built-in styles. */
  templatePath: string
}
export interface UiReportResult {
  path: string
  files: string[]
}
export interface UiReportProgress {
  stage: string
  message: string
}

export const listUiSuites = () => invoke<UiTestSuite[]>("uitest_suites_list")
export const getUiSuite = (id: string) =>
  invoke<{ suite: UiTestSuite; cases: UiTestCase[] }>("uitest_suite_get", { id })
export const saveUiSuite = (suite: UiTestSuite) => invoke<UiTestSuite>("uitest_suite_save", { suite })
export const deleteUiSuite = (id: string) => invoke<void>("uitest_suite_delete", { id })
/** Full replacement of the suite's cases; position = array index. */
export const saveUiCases = (suiteId: string, cases: UiTestCase[]) =>
  invoke<UiTestCase[]>("uitest_cases_save", { suiteId, cases })
export const importUiCsv = (suiteId: string, csv: string, replace: boolean) =>
  invoke<UiTestCase[]>("uitest_import_csv", { suiteId, csv, replace })
export const exportUiCsv = (suiteId: string, caseIds: string[] | null) =>
  invoke<string>("uitest_export_csv", { suiteId, caseIds })

export const uiSessionStatus = (envId: string) => invoke<UiSessionStatus>("uitest_session_status", { envId })
export const uiSessionLoginStart = (envId: string) => invoke<UiSessionStatus>("uitest_session_login_start", { envId })
export const uiSessionLoginFinish = (envId: string) => invoke<UiSessionStatus>("uitest_session_login_finish", { envId })
export const uiSessionLoginCancel = (envId: string) => invoke<UiSessionStatus>("uitest_session_login_cancel", { envId })
export const uiSessionCheck = (envId: string) => invoke<UiSessionStatus>("uitest_session_check", { envId })
export const uiSessionClear = (envId: string) => invoke<UiSessionStatus>("uitest_session_clear", { envId })

/** Starts a background run; resolves to the runId. `mode` overrides per-case/suite mode. */
export const runUiTests = (suiteId: string, caseIds: string[] | null, mode: UiTestMode | null, instructions = "") =>
  invoke<string>("uitest_run", { suiteId, caseIds, mode, instructions })
export const cancelUiRun = (runId: string) => invoke<void>("uitest_run_cancel", { runId })
export const activeUiRun = () => invoke<{ runId: string; suiteId: string } | null>("uitest_run_active")

/** Writes a test document (docx, pdf or md) for a run; resolves to the written path and any side files. */
export const generateUiReport = (args: UiReportArgs) => invoke<UiReportResult>("uitest_report_generate", { ...args })

export const onUiProgress = (cb: (p: UiRunProgress) => void): Promise<UnlistenFn> =>
  listen<UiRunProgress>("uitest://progress", (e) => cb(e.payload))
export const onUiDone = (cb: (d: UiRunDone) => void): Promise<UnlistenFn> =>
  listen<UiRunDone>("uitest://done", (e) => cb(e.payload))
export const onUiReport = (cb: (p: UiReportProgress) => void): Promise<UnlistenFn> =>
  listen<UiReportProgress>("uitest://report", (e) => cb(e.payload))

/** A suite (or, with an empty suiteId, the suite list) was changed by the assistant or an MCP client. */
export const onUiChanged = (cb: (suiteId: string) => void): Promise<UnlistenFn> =>
  listen<{ suiteId: string }>("uitest://changed", (e) => cb(e.payload.suiteId))

export const newUiSuite = (envId = ""): UiTestSuite => ({
  id: "",
  name: "",
  description: "",
  envId,
  provider: "",
  model: "",
  mode: "headless",
  caseCount: 0,
  createdAt: 0,
  updatedAt: 0,
})

export const newUiCase = (suiteId: string): UiTestCase => ({
  id: "",
  suiteId,
  position: 0,
  adoId: null,
  title: "New test case",
  areaPath: "",
  assignedTo: "",
  state: "Design",
  tags: "",
  mode: "",
  steps: [{ action: "", expected: "" }],
  status: "notRun",
  reason: "",
  stepResults: [],
  chatId: "",
  lastRunAt: null,
  durationMs: null,
  updatedAt: 0,
})

/** A chat a test run left: the case conversation, tied back to its suite, case and run. */
export interface UiTestChat {
  chatId: string
  title: string
  messageCount: number
  createdAt: number | null
  updatedAt: number | null
  /** Empty when no run or case points at the chat any more. */
  suiteId: string
  suiteName: string
  caseId: string
  caseTitle: string
  /** History row of the run; empty while the run is still going. */
  runId: string
  runStartedAt: number | null
  status: UiCaseStatus | ""
  reason: string
  durationMs: number | null
}

/** Test chats, newest first; `suiteId` null = every suite. They are not in the assistant's chat list. */
export const listUiChats = (suiteId: string | null) => invoke<UiTestChat[]>("uitest_chats", { suiteId })
/** Deletes test chats; resolves to how many went. */
export const deleteUiChats = (chatIds: string[]) => invoke<number>("uitest_chats_delete", { chatIds })
