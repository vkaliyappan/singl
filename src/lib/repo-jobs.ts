"use client"

import { toast } from "sonner"
import { checkoutBranch, clearExtracted, cloneRepo, fetchRepo, pullRepo, type RepoSlot } from "@/lib/repo"
import { extractCode } from "@/lib/twx"
import { appendJobLog, runJob } from "@/lib/background-jobs"

// Each Repository page's git / extract operations, as one background job per
// slot: they share that page's console and never run together. The two pages
// run independently.

/** Background-job key prefix of each slot (the sidebar spinner matches on it). */
export const repoJobPrefix = (slot: RepoSlot) => (slot === 1 ? "repo:" : `repo${slot}:`)
export const repoJobKey = (slot: RepoSlot) => `${repoJobPrefix(slot)}op`

export type RepoOp = "clone" | "extract" | "clear" | "checkout" | "pull" | "fetch"
export type RepoJobMeta = { op: RepoOp; title: string; runningLabel: string; branch?: string }

export type RepoTimes = { lastPulled?: string; lastUpdated?: string }
const timesKey = (slot: RepoSlot) => (slot === 1 ? "singl:repo:ts" : `singl:repo${slot}:ts`)

export function loadRepoTimes(slot: RepoSlot): RepoTimes {
  try {
    return JSON.parse(localStorage.getItem(timesKey(slot)) ?? "{}") as RepoTimes
  } catch {
    return {}
  }
}

function saveRepoTimes(slot: RepoSlot, patch: RepoTimes) {
  try {
    localStorage.setItem(timesKey(slot), JSON.stringify({ ...loadRepoTimes(slot), ...patch }))
  } catch {}
}

function start<R>(
  slot: RepoSlot,
  meta: RepoJobMeta,
  firstLine: string,
  run: (onLine: (line: string) => void) => Promise<R>
) {
  return runJob<R, RepoJobMeta>(repoJobKey(slot), run, { meta, log: [firstLine] })
}

/** Resolves with the clone's slug, or null when it failed or another operation is running. */
export async function startClone(slot: RepoSlot, repoUrl: string, branch: string) {
  const r = await start(
    slot,
    { op: "clone", title: "Clone Repository", runningLabel: "Cloning...", branch },
    `Cloning branch "${branch}" from ${repoUrl}...`,
    (onLine) => cloneRepo(slot, repoUrl, branch, onLine)
  )
  if (!r) return
  if (!r.ok) {
    appendJobLog(repoJobKey(slot), r.error)
    toast.error("Repository clone failed", { description: r.error })
    return
  }
  saveRepoTimes(slot, { lastUpdated: new Date().toISOString() })
  toast.success("Repository cloned successfully", { description: `Branch "${branch}" for ${r.result} is ready.` })
}

export async function startExtract(slot: RepoSlot, slug: string) {
  const r = await start(
    slot,
    { op: "extract", title: "TWX Package Extract", runningLabel: "Extracting packages..." },
    `Extracting packages for ${slug}...`,
    (onLine) => extractCode({ repoSlug: slug }, onLine)
  )
  if (!r) return
  if (!r.ok) {
    appendJobLog(repoJobKey(slot), `Error: ${r.error}`)
    toast.error(`Extract failed: ${r.error}`)
    return
  }
  toast.success("Package extraction complete")
}

export async function startClear(slot: RepoSlot) {
  const r = await start(
    slot,
    { op: "clear", title: "Clear Extracted Code", runningLabel: "Clearing..." },
    "Removing generated Code/ directories...",
    () => clearExtracted(slot)
  )
  if (!r) return
  if (!r.ok) {
    appendJobLog(repoJobKey(slot), `[ERROR] ${r.error}`)
    toast.error(r.error)
    return
  }
  appendJobLog(repoJobKey(slot), `[DONE] Removed ${r.result} extracted directories.`)
  toast.success(`Cleared ${r.result} extracted directories`)
}

export async function startCheckout(slot: RepoSlot, branch: string) {
  const r = await start(
    slot,
    { op: "checkout", title: `Switch Branch: ${branch}`, runningLabel: "Checking out...", branch },
    `Checking out branch "${branch}"...`,
    (onLine) => checkoutBranch(slot, branch, onLine)
  )
  if (!r) return
  if (!r.ok) {
    appendJobLog(repoJobKey(slot), r.error)
    toast.error(`Checkout failed: ${r.error}`)
    return
  }
  toast.success(`Switched to branch "${branch}"`)
}

export async function startPull(slot: RepoSlot, slug: string, branch: string) {
  const r = await start(
    slot,
    { op: "pull", title: "Git Pull", runningLabel: "Pulling latest changes..." },
    `Pulling latest changes for branch "${branch}"...`,
    // git's own output, summary line included, streams to the console.
    (onLine) => pullRepo(slot, onLine)
  )
  if (!r) return
  if (!r.ok) {
    appendJobLog(repoJobKey(slot), r.error)
    toast.error(`Git Pull Failed: ${slug}`, { description: r.error })
    return
  }
  const now = new Date().toISOString()
  saveRepoTimes(slot, { lastPulled: now, lastUpdated: now })
  toast.success(`Git Pull: ${slug}`, { description: r.result })
}

export async function startFetch(slot: RepoSlot) {
  const r = await start(
    slot,
    { op: "fetch", title: "Git Fetch", runningLabel: "Fetching origin..." },
    "Fetching remote branches and references...",
    (onLine) => fetchRepo(slot, onLine)
  )
  if (!r) return
  if (!r.ok) {
    appendJobLog(repoJobKey(slot), r.error)
    toast.error(`Fetch failed: ${r.error}`)
    return
  }
  toast.success("Fetched latest refs from remote")
}
