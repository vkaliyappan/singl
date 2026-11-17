import { invoke } from "@tauri-apps/api/core"
import { logChannel } from "@/lib/jobs"
import type { SearchFileResult, SearchOptions } from "@/components/search-panel"

// Typed wrappers over src-tauri/src/commands/repo.rs. Errors reject with
// `{ code, message }`; read them with errorMessage from @/lib/settings.

/** Which Repository page: 1 is "TWX Repository", 2 is "Windchill Repository". Each keeps its own clone. */
export type RepoSlot = 1 | 2

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

export const getRepo = (slot: RepoSlot) => invoke<RepoState>("repo_get", { slot })
export const listBranches = (repoUrl: string) => invoke<string[]>("repo_branches", { repoUrl })

/** Resolves with the clone's slug once git finishes. */
export const cloneRepo = (slot: RepoSlot, repoUrl: string, branch: string, onLine: (line: string) => void) =>
  invoke<string>("repo_clone", { slot, repoUrl, branch, onEvent: logChannel(onLine) })
export const checkoutBranch = (slot: RepoSlot, branch: string, onLine: (line: string) => void) =>
  invoke<void>("repo_checkout", { slot, branch, onEvent: logChannel(onLine) })
export const fetchRepo = (slot: RepoSlot, onLine: (line: string) => void) =>
  invoke<void>("repo_fetch", { slot, onEvent: logChannel(onLine) })
/** Resolves with git's summary, e.g. "Already up to date." */
export const pullRepo = (slot: RepoSlot, onLine: (line: string) => void) =>
  invoke<string>("repo_pull", { slot, onEvent: logChannel(onLine) })

export const getRepoStatus = (slot: RepoSlot) => invoke<ChangedFile[]>("repo_status", { slot })
/** `file` is relative to the clone. */
export const getRepoDiff = (slot: RepoSlot, file: string) => invoke<FileDiff>("repo_diff", { slot, file })
/** Every path in the clone, relative to it; folders end in "/". */
export const listRepoFiles = (slot: RepoSlot) => invoke<string[]>("repo_files", { slot })
/** `path` is relative to the clone. */
export const readRepoFile = (slot: RepoSlot, path: string) => invoke<string>("repo_file_content", { slot, path })
export const searchRepo = (slot: RepoSlot, query: string, options: SearchOptions) =>
  invoke<SearchFileResult[]>("repo_search", { slot, query, options })
/** Removes the Code/ folders Extract generated; resolves with how many projects were cleared. */
export const clearExtracted = (slot: RepoSlot) => invoke<number>("repo_clean", { slot })
