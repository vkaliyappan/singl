import { invoke } from "@tauri-apps/api/core"
import { logChannel } from "@/lib/jobs"

// Typed wrappers over src-tauri/src/commands/twx.rs, singl-web's /api/twx/* and
// /api/twx-cli/* routes. Relative paths resolve against the workspace folder.
// Long runs stream log lines to `onLine` and resolve with the run's result.
// Errors reject with `{ code, message }`; read them with errorMessage from @/lib/settings.

type OnLine = (line: string) => void

export type ExportResult = {
  projectsProcessed: number
  entitiesExported: number
  entitiesSkipped: number
  errors: string[]
}

export type DeploymentExportResult = {
  projectsProcessed: number
  zipsSaved: number
  savedFiles: string[]
  exportedDir: string
  errors: string[]
}

export type DeploymentExtractResult = {
  zipFilesProcessed: number
  entitiesExtracted: number
  entitiesSkipped: number
  errors: string[]
}

export type DeploymentBackupResult = {
  projectsProcessed: number
  projectsBackedUp: number
  /** Repository folder holding the backup, e.g. "/Backup_20261009-101500". */
  backupDir: string
  errors: string[]
}

export type DeploymentUploadResult = {
  filesUploaded: number
  zipsExtracted: number
  /** Repository folder the files went to, e.g. "/Deploy/RC1". */
  targetDir: string
  errors: string[]
}

export type RepositoryDir = { name: string; path: string }

export type ConnectorInfo = {
  name: string
  thingTemplate: string
  /** Relative to the source folder, forward slashes. */
  relPath: string
  urls: { origin: string; occurrences: number }[]
  baseUrl: string | null
  /** null when the connector has no AuthUsername field. */
  username: string | null
}

export type ConnectorUpdate = {
  relPath: string
  /** Old origin → new origin. */
  urlMap: Record<string, string>
  /** New AuthUsername; null or omitted leaves it unchanged. */
  username?: string | null
}

export type ConnectorUpdateResult = {
  connectorsFound: number
  connectorsUpdated: number
  urlsReplaced: number
  usernamesUpdated: number
  filesCopied: number
  destDir: string
  errors: string[]
}

export type BundleResult = {
  projectsProcessed: number
  zipsCreated: number
  errors: string[]
}

/** Every configured project's entities as formatted XML files. */
export const exportEntities = (
  args: { env: string; project?: string; output?: string; backup?: boolean; dryRun?: boolean },
  onLine: OnLine,
) => invoke<ExportResult>("twx_export", { args, onEvent: logChannel(onLine) })

/** Each project as a ZIP from SystemRepository, saved under `output/<parent>/`. */
export const exportDeploymentFiles = (
  args: { env: string; project?: string; output?: string; parent?: string; suffix?: string; dryRun?: boolean },
  onLine: OnLine,
) => invoke<DeploymentExportResult>("twx_export_deployment_files", { args, onEvent: logChannel(onLine) })

/** Downloaded deployment ZIPs into formatted entity XML. */
export const extractDeploymentFiles = (
  args: { env?: string; project?: string; input?: string; output?: string; dryRun?: boolean },
  onLine: OnLine,
) => invoke<DeploymentExtractResult>("twx_extract_deployment_files", { args, onEvent: logChannel(onLine) })

/** Backs projects up on the server itself, under SystemRepository/<parent>. */
export const backupDeploymentFiles = (
  args: {
    env: string
    project?: string
    parent: string
    suffix?: string
    format?: "entities" | "zip"
    dryRun?: boolean
  },
  onLine: OnLine,
) => invoke<DeploymentBackupResult>("twx_backup_deployment_files", { args, onEvent: logChannel(onLine) })

/** A local folder into SystemRepository/<target>, optionally extracting uploaded ZIPs. */
export const uploadDeploymentFiles = (
  args: {
    env: string
    source: string
    target: string
    extract?: boolean
    extractSubfolder?: boolean
    deleteZip?: boolean
    dryRun?: boolean
  },
  onLine: OnLine,
) => invoke<DeploymentUploadResult>("twx_upload_deployment_files", { args, onEvent: logChannel(onLine) })

/** Folders of SystemRepository at `path`. */
export const listRepositoryDirs = (env: string, path = "/") =>
  invoke<{ entries: RepositoryDir[]; currentPath: string }>("twx_repo_dirs", { env, path })

/** Integration connectors in a local entity folder. */
export const listConnectors = (source: string) => invoke<ConnectorInfo[]>("twx_connectors", { source })

/** Copies `source` to `dest` and rewrites connector endpoints in the copy (in place when equal). */
export const updateConnectors = (
  args: { source: string; dest: string; updates: ConnectorUpdate[]; cleanDest?: boolean; dryRun?: boolean },
  onLine: OnLine,
) => invoke<ConnectorUpdateResult>("twx_update_connectors", { args, onEvent: logChannel(onLine) })

/** One ZIP per project alias folder; src/dest default to Settings' bundle directories. */
export const bundleProjects = (
  args: { env?: string; project?: string; src?: string; dest?: string; dryRun?: boolean },
  onLine: OnLine,
) => invoke<BundleResult>("twx_cli_bundle", { args, onEvent: logChannel(onLine) })

/** Service code, mashup scripts and DataShape types into each project's Code/ folder. */
export const extractCode = (args: { envName?: string; repoSlug?: string }, onLine: OnLine) =>
  invoke<{ projects: number; extractedAt: string | null }>("twx_cli_extract", { args, onEvent: logChannel(onLine) })
