import { invoke } from "@tauri-apps/api/core"
import { logChannel } from "@/lib/jobs"

// Typed wrappers over src-tauri/src/commands/twx_import.rs. File paths are
// relative to <workspace>/twx-entities; backup folders to the workspace.
// Errors reject with `{ code, message }`; read them with errorMessage from @/lib/settings.

export type ImportPreviewItem = {
  path: string
  type: string
  name: string
  existsOnServer: boolean
  /** The server's current export, normalised; empty when not on the server. */
  original: string
  /** The local file, normalised. */
  modified: string
  changed: boolean
  /** Why the file could not be compared. */
  error: string | null
}

export type ImportFileResult = { path: string; ok: boolean; error: string | null }

export type ImportResult = {
  /** Relative to the workspace. */
  backupDir: string
  backedUp: number
  results: ImportFileResult[]
}

export type ImportBackup = { dir: string; name: string; files: number }

export const previewImport = (env: string, files: string[]) =>
  invoke<ImportPreviewItem[]>("twx_import_preview", { args: { env, files } })

/** Backs up the server's current versions, then imports. `onLine` gets progress lines. */
export const runImport = (env: string, files: string[], onLine: (line: string) => void) =>
  invoke<ImportResult>("twx_import_run", { args: { env, files }, onEvent: logChannel(onLine) })

export const listImportBackups = (env: string) => invoke<ImportBackup[]>("twx_import_backups", { env })

/** Imports the files of backup folder `dir` (also backing up the current state first). */
export const restoreImportBackup = (env: string, dir: string, onLine: (line: string) => void) =>
  invoke<ImportResult>("twx_import_restore", { env, dir, onEvent: logChannel(onLine) })

export const openImportBackup = (dir: string) => invoke<void>("twx_import_open_backup", { dir })
