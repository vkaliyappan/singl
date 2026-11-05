import { invoke } from "@tauri-apps/api/core"
import { logChannel } from "@/lib/jobs"
import type { SearchFileResult, SearchOptions } from "@/components/search-panel"

// Typed wrappers over src-tauri/src/commands/entities.rs, singl-web's
// /api/twx-entities/* routes. Paths are relative to <workspace>/twx-entities,
// "/"-separated, starting with the environment folder.
// Errors reject with `{ code, message }`; read them with errorMessage from @/lib/settings.

/** Where an entity's files live; each field only when it exists. */
export type LocatedEntity = { path?: string; codeDir?: string; code?: string }

export type FoundEntry = { path: string; name: string; type: "file" | "dir" }

export type RunTimes = { lastExported?: string; lastExtracted?: string }

export type EntityExportResult = {
  exported: number
  skipped: number
  errors: string[]
  /** The environment folder the entities went to. */
  outputDir: string
  exportedAt: string | null
}

/** Every file under `path`, relative to it; empty folders end in "/". */
export const listEntityFiles = (path: string) => invoke<string[]>("entity_files", { path })
export const readEntityFile = (path: string) => invoke<string>("entity_read", { path })
/** Saves an existing file. */
export const writeEntityFile = (path: string, content: string) => invoke<void>("entity_write", { path, content })
/** Resolves with the new entry's path. */
export const createEntityEntry = (parent: string, name: string, type: "file" | "dir") =>
  invoke<string>("entity_create", { parent, name, dir: type === "dir" })
/** Resolves with the new path. */
export const renameEntityEntry = (path: string, name: string) => invoke<string>("entity_rename", { path, name })
/** A file, or a folder with everything in it. */
export const deleteEntityEntry = (path: string) => invoke<void>("entity_delete", { path })

/** Result paths are relative to `root`. */
export const searchEntities = (root: string, query: string, options: SearchOptions) =>
  invoke<SearchFileResult[]>("entity_search", { root, query, options })
/** Files and folders under the environment folder `root` matching `query`, best first. */
export const findEntities = (root: string, query: string, limit?: number) =>
  invoke<FoundEntry[]>("entity_find", { root, query, limit })

/** `collection` is the REST collection, e.g. "Things"; rejects with code "not_found" when not exported. */
export const locateEntity = (query: { env: string; entity: string; collection?: string; service?: string }) =>
  invoke<LocatedEntity>("entity_locate", query)

export const getRunTimes = (env: string) => invoke<RunTimes>("entity_run_times", { env })

/** `project` alone, or every project configured for `env` (all on the server when none is). */
export const exportEnvEntities = (env: string, project: string | undefined, onLine: (line: string) => void) =>
  invoke<EntityExportResult>("entity_export", { env, project, onEvent: logChannel(onLine) })
