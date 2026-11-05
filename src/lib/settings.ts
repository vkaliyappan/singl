import { invoke } from "@tauri-apps/api/core"

// Typed wrappers over the settings commands in src-tauri/src/commands/settings.rs.
// Tauri maps these camelCase argument names to the commands' snake_case ones.

export type ProjectConfig = {
  id: number
  projectName: string
  folderName: string
  alias: string
  exports: string[]
}

export type EnvSetting = {
  environment: string
  twxBaseUrl: string
  hasAppKey: boolean
  enabled: boolean
  projects: ProjectConfig[]
}

export type AppSettings = {
  hasAzurePatToken: boolean
  twxRootPrefix: string
  repoRootSubpath: string
  bundleSrcDir: string
  bundleDestDir: string
  workspaceRoot: string
  updateDir: string
}

export type UpdateInfo = {
  currentVersion: string
  version: string
  notes: string
}

export type ProjectInput = {
  id?: number
  environment: string
  projectName: string
  folderName: string
  alias: string
  /** Comma-separated, as typed; blank means "all". */
  exports: string
}

/** Commands reject with `{ code, message }` (see src-tauri/src/error.rs). */
export function errorMessage(err: unknown) {
  if (err && typeof err === "object" && "message" in err) return String(err.message)
  return String(err)
}

export const getSettings = () => invoke<AppSettings>("settings_get")
export const listEnvironments = () => invoke<EnvSetting[]>("environments_list")

export const setAzurePatToken = (token: string) => invoke<void>("settings_azure_pat_set", { token })
export const setComparePaths = (twxRootPrefix: string, repoRootSubpath: string) =>
  invoke<void>("settings_compare_paths_set", { twxRootPrefix, repoRootSubpath })
export const setBundleDirs = (bundleSrcDir: string, bundleDestDir: string) =>
  invoke<void>("settings_bundle_dirs_set", { bundleSrcDir, bundleDestDir })
export const setWorkspaceRoot = (root: string) => invoke<void>("workspace_root_set", { root })

// src-tauri/src/commands/updater.rs
export const setUpdateDir = (dir: string) => invoke<void>("update_dir_set", { dir })
/** `null` when no newer version is in the update folder. */
export const checkForUpdate = () => invoke<UpdateInfo | null>("update_check")
/** Starts the installer and quits; singl relaunches when it finishes. */
export const installUpdate = () => invoke<void>("update_install")

export const saveEnvironment = (environment: string, twxBaseUrl: string, appKey: string) =>
  invoke<void>("environment_save", { environment, twxBaseUrl, appKey })
export const setEnvironmentEnabled = (environment: string, enabled: boolean) =>
  invoke<void>("environment_set_enabled", { environment, enabled })
export const cloneEnvironment = (source: string, newEnvironment: string) =>
  invoke<void>("environment_clone", { source, newEnvironment })
export const deleteEnvironment = (environment: string) => invoke<void>("environment_delete", { environment })

export const saveProject = (project: ProjectInput) => invoke<void>("project_save", { project })
export const deleteProject = (id: number) => invoke<void>("project_delete", { id })

/** Replaces the database with singl-web's `local.db`; the old file is kept as a backup. */
export const importWebDatabase = (source: string) => invoke<{ stamped: number }>("db_import", { source })
