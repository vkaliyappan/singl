import { invoke } from "@tauri-apps/api/core"

// Typed wrappers over src-tauri/src/commands/twx_admin.rs: read-only server
// health, connectors, and Stream / DataTable queries. Errors reject with `{ code, message }`; read
// them with errorMessage from @/lib/settings.

export type Ping = {
  ok: boolean
  latencyMs: number
  version: string | null
  memoryUsed: number | null
  memoryTotal: number | null
  error: string | null
}

export type Platform = {
  softwareVersion: string | null
  build: string | null
  schemaVersion: string | null
  /** Epoch ms. */
  startTime: number | null
  uptimeMs: number | null
  runTime: string | null
  /** Bytes. */
  memoryUsed: number | null
  /** Bytes allocated to the application server. */
  memoryTotal: number | null
  eventQueue: number | null
  streamQueue: number | null
  valueStreamQueue: number | null
  namedUsers: number | null
  licenseEvaluation: boolean | null
  licenseDaysLeft: number | null
}

export type SubsystemStatus = { name: string; description: string; state: string; running: boolean }
export type Extension = { name: string; version: string; vendor: string }

export type Counts = {
  things: number | null
  thingTemplates: number | null
  thingShapes: number | null
  projects: number | null
  mashups: number | null
  dataShapes: number | null
  extensionPackages: number | null
  boundThings: number | null
  connectedThings: number | null
}

/** Every section may be missing; `errors` says why. */
export type ServerHealth = {
  platform: Platform | null
  subsystems: SubsystemStatus[] | null
  extensions: Extension[] | null
  counts: Counts | null
  errors: string[]
}

export type StreamInfo = { name: string; description: string; system: boolean }
export type StreamList = { streams: StreamInfo[]; valueStreams: StreamInfo[] }
export type LoggedProperty = { name: string; baseType: string }

export type StreamQuery = {
  /** A Stream: its entries are read. */
  stream?: string
  /** A Thing and one of its logged properties: Value Stream history. */
  thing?: string
  property?: string
  /** ISO 8601, epoch ms, or relative like "24h", "7d". */
  since?: string
  until?: string
  maxItems?: number
  oldestFirst?: boolean
}

export type QueryColumn = { name: string; baseType: string }
export type QueryResult = {
  source: string
  columns: QueryColumn[]
  rows: Record<string, unknown>[]
  maybeMore: boolean
}

export const pingServer = (env: string) => invoke<Ping>("twx_server_ping", { env })
export const getServerHealth = (env: string) => invoke<ServerHealth>("twx_server_health", { env })
export const listStreams = (env: string) => invoke<StreamList>("twx_streams_list", { env })
export const listLoggedProperties = (env: string, thing: string) =>
  invoke<LoggedProperty[]>("twx_logged_properties", { env, thing })
export const queryStream = (env: string, query: StreamQuery) => invoke<QueryResult>("twx_stream_query", { env, query })

export type Setting = { name: string; value: string }
export type ConnectorInfo = {
  name: string
  description: string
  template: string | null
  /** "OData", "Swagger", or the template name. */
  kind: string
  enabled: boolean | null
  baseUrl: string | null
  authType: string | null
  /** Connection settings that are not credentials. */
  settings: Setting[]
  error: string | null
}
export type ConnectorTest = { state: "ok" | "failed" | "unknown"; status: string | null; message: string | null; latencyMs: number }

export type DataTableInfo = { dataShape: string | null; entryCount: number | null; fields: QueryColumn[] }
export type DataTableQuery = {
  table: string
  /** Plain text matches as *text*; a ThingWorx search expression is passed as written. */
  search?: string
  /** A ThingWorx query as JSON text. */
  query?: string
  maxItems?: number
}

export const listConnectors = (env: string) => invoke<ConnectorInfo[]>("twx_connectors_list", { env })
/** Runs the connector's own ValidateConnection; call only on a click. */
export const testConnector = (env: string, thing: string) => invoke<ConnectorTest>("twx_connector_test", { env, thing })
export const listDataTables = (env: string) => invoke<StreamInfo[]>("twx_datatables_list", { env })
export const getDataTableInfo = (env: string, table: string) => invoke<DataTableInfo>("twx_datatable_info", { env, table })
export const queryDataTable = (env: string, query: DataTableQuery) => invoke<QueryResult>("twx_datatable_query", { env, query })

export function formatBytes(bytes: number | null | undefined) {
  if (bytes == null) return "-"
  const units = ["B", "KB", "MB", "GB", "TB"]
  let v = bytes
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(i > 1 ? 1 : 0)} ${units[i]}`
}

export function formatDuration(ms: number | null | undefined) {
  if (ms == null) return "-"
  const mins = Math.floor(ms / 60000)
  const days = Math.floor(mins / 1440)
  const hours = Math.floor((mins % 1440) / 60)
  if (days > 0) return `${days}d ${hours}h`
  return hours > 0 ? `${hours}h ${mins % 60}m` : `${mins}m`
}
