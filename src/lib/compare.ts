import { invoke } from "@tauri-apps/api/core"
import type { SearchFileResult, SearchOptions } from "@/components/search-panel"

// Typed wrappers over src-tauri/src/commands/compare.rs, singl-web's /api/compare/*
// routes. Left is the repository clone, right an environment's exported entities;
// paths are relative to both. Errors reject with `{ code, message }`; read them
// with errorMessage from @/lib/settings.

export type NodeStatus = "added" | "removed" | "modified" | "identical"

export interface DiffNode {
  path: string
  name: string
  type: "file" | "dir"
  status: NodeStatus
  leftExists: boolean
  rightExists: boolean
  leftSize?: number
  rightSize?: number
  children?: string[]
}

export type CompareTree = {
  /** Both relative to the workspace folder. */
  leftRoot: string
  rightRoot: string
  nodes: DiffNode[]
  summary: { added: number; removed: number; modified: number; identical: number }
}

/** One side of a file; `content` is null when it is missing, a folder, or too large. */
export type CompareSide = { content: string | null; size: number | null; tooLarge: boolean }

export const getCompareTree = (env: string) => invoke<CompareTree>("compare_tree", { env })
export const getCompareContent = (env: string, path: string) =>
  invoke<{ left: CompareSide; right: CompareSide }>("compare_content", { env, path })
/** `warnings` name a side whose folder is missing. */
export const searchCompare = (env: string, query: string, options: SearchOptions) =>
  invoke<{ results: SearchFileResult[]; warnings: string[] }>("compare_search", { env, query, options })
