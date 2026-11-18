import { invoke } from "@tauri-apps/api/core"

// Typed wrappers over src-tauri/src/commands/twx_logs.rs. Errors reject with
// `{ code, message }`; read them with errorMessage from @/lib/settings.

export const LOGS = [
  "ApplicationLog",
  "ScriptLog",
  "ErrorLog",
  "SecurityLog",
  "CommunicationLog",
  "ConfigurationLog",
] as const
export type LogName = (typeof LOGS)[number]

export const LEVELS = ["TRACE", "DEBUG", "INFO", "WARN", "ERROR"] as const

export type LogRow = {
  /** Epoch milliseconds. */
  timestamp: number
  level: string
  origin: string
  thread: string
  user: string
  instance: string
  session: string
  message: string
}

export type LogQuery = {
  log?: LogName
  search?: string
  /** Minimum level. */
  level?: string
  /** Epoch milliseconds. */
  since?: number
  until?: number
  origin?: string
  instance?: string
  thread?: string
  user?: string
  limit?: number
  oldestFirst?: boolean
}

export const queryLogs = (env: string, query: LogQuery) => invoke<LogRow[]>("twx_logs_query", { env, query })
