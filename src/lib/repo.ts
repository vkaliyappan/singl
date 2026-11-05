import { invoke } from "@tauri-apps/api/core"
import { logChannel } from "@/lib/jobs"
import type { SearchFileResult, SearchOptions } from "@/components/search-panel"

// Typed wrappers over src-tauri/src/commands/repo.rs. Errors reject with
// `{ code, message }`; read them with errorMessage from @/lib/settings.

export type RepoState = {
  repoUrl: string
  clonedBranch: string
  repoSlug: string
}

export type ChangedFile = {
  path: string
  status: "M" | "A" | "D" | "?"
}

export type FileDiff = {
  original: string
  modified: string
  hasTextualChanges: boolean
}

export const getRepo = () => invoke<RepoState>("repo_get")
export const listBranches = (repoUrl: string) => invoke<string[]>("repo_branches", { repoUrl })

/** Resolves with the clone's slug once git finishes. */
export const cloneRepo = (repoUrl: string, branch: string, onLine: (line: string) => void) =>
  invoke<string>("repo_clone", { repoUrl, branch, onEvent: logChannel(onLine) })
export const checkoutBranch = (branch: string, onLine: (line: string) => void) =>
  invoke<void>("repo_checkout", { branch, onEvent: logChannel(onLine) })
export const fetchRepo = (onLine: (line: string) => void) => invoke<void>("repo_fetch", { onEvent: logChannel(onLine) })
/** Resolves with git's summary, e.g. "Already up to date." */
export const pullRepo = (onLine: (line: string) => void) => invoke<string>("repo_pull", { onEvent: logChannel(onLine) })

export const getRepoStatus = () => invoke<ChangedFile[]>("repo_status")
/** `file` is relative to the clone. */
export const getRepoDiff = (file: string) => invoke<FileDiff>("repo_diff", { file })
/** Every path in the clone, relative to it; folders end in "/". */
export const listRepoFiles = () => invoke<string[]>("repo_files")
/** `path` is relative to the clone. */
export const readRepoFile = (path: string) => invoke<string>("repo_file_content", { path })
export const searchRepo = (query: string, options: SearchOptions) =>
  invoke<SearchFileResult[]>("repo_search", { query, options })
/** Removes the Code/ folders Extract generated; resolves with how many projects were cleared. */
export const clearExtracted = () => invoke<number>("repo_clean")
