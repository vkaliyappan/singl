"use client"

import { useEffect, useRef, useSyncExternalStore } from "react"
import { errorMessage } from "@/lib/settings"

// Long runs (exports, deploys, git operations, flow runs) kept at module level
// instead of in a page, so a run keeps going, with its log, while the user is
// on another page. Pages read a job by key ("deploy:upload", "repo", …);
// anything a page must do when a run ends goes in useJobFinished, which fires
// in whichever copy of the page is open at that moment.

export type JobStatus = "idle" | "running" | "done" | "error"
export type JobLine = { at: number; text: string }

export type Job<M = unknown, R = unknown> = {
  status: JobStatus
  log: JobLine[]
  /** What the page passed to runJob, e.g. which environment or operation. */
  meta: M | undefined
  /** The run's result, once it succeeded. */
  result: R | undefined
  error: string | null
  /** Bumped each time a run ends; how useJobFinished spots a finish. */
  seq: number
}

const IDLE: Job = { status: "idle", log: [], meta: undefined, result: undefined, error: null, seq: 0 }

let jobs: Record<string, Job> = {}
let seq = 0
const listeners = new Set<() => void>()

function update(key: string, patch: Partial<Job> | ((job: Job) => Partial<Job>)) {
  const job = jobs[key] ?? IDLE
  jobs = { ...jobs, [key]: { ...job, ...(typeof patch === "function" ? patch(job) : patch) } }
  listeners.forEach((l) => l())
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export const getJob = <M = unknown, R = unknown>(key: string) => (jobs[key] ?? IDLE) as Job<M, R>
export const isJobRunning = (key: string) => getJob(key).status === "running"

export function useJob<M = unknown, R = unknown>(key: string): Job<M, R> {
  return useSyncExternalStore(subscribe, () => getJob<M, R>(key), () => IDLE as Job<M, R>)
}

/** Whether any job whose key starts with `prefix` is running. */
export function useJobsRunning(prefix: string): boolean {
  return useSyncExternalStore(
    subscribe,
    () => Object.entries(jobs).some(([k, j]) => k.startsWith(prefix) && j.status === "running"),
    () => false
  )
}

export const appendJobLog = (key: string, text: string) =>
  update(key, (job) => ({ log: [...job.log, { at: Date.now(), text }] }))

/** Empties the log; a finished job also goes back to idle. A running one keeps running. */
export function clearJob(key: string) {
  update(key, (job) =>
    job.status === "running" ? { log: [] } : { log: [], status: "idle", result: undefined, error: null, meta: undefined }
  )
}

/** Drops a finished job; for one-off keys that would otherwise pile up. */
export function forgetJob(key: string) {
  if (!(key in jobs) || isJobRunning(key)) return
  jobs = Object.fromEntries(Object.entries(jobs).filter(([k]) => k !== key))
  listeners.forEach((l) => l())
}

export type JobOutcome<R> = { ok: true; result: R } | { ok: false; error: string }

/**
 * Runs `run` as job `key`, streaming its lines into the job's log (after the
 * starting `log` lines). Resolves with the outcome, or null when `key` is
 * already running. Code after the await runs even if the page has closed, so
 * keep it to toasts and app-wide state; page state belongs in useJobFinished.
 */
export async function runJob<R, M = unknown>(
  key: string,
  run: (onLine: (line: string) => void) => Promise<R>,
  opts: { meta?: M; log?: string[] } = {}
): Promise<JobOutcome<R> | null> {
  if (isJobRunning(key)) return null
  const now = Date.now()
  update(key, {
    status: "running",
    log: (opts.log ?? []).map((text) => ({ at: now, text })),
    meta: opts.meta,
    result: undefined,
    error: null,
  })
  try {
    const result = await run((line) => appendJobLog(key, line))
    update(key, { status: "done", result, seq: ++seq })
    return { ok: true, result }
  } catch (err) {
    const error = errorMessage(err)
    update(key, { status: "error", error, seq: ++seq })
    return { ok: false, error }
  }
}

/** Calls `onFinish` when job `key` ends while this component is mounted. */
export function useJobFinished<M = unknown, R = unknown>(key: string, onFinish: (job: Job<M, R>) => void) {
  const job = useJob<M, R>(key)
  const seen = useRef(job.seq)
  useEffect(() => {
    if (job.seq === seen.current) return
    seen.current = job.seq
    onFinish(job)
  }, [job, onFinish])
}

// ── Shared state ──────────────────────────────────────────────────────────────
// useState / useRef whose value lives at module level under `key`, for pages
// whose run updates more than a log (e.g. a flow run's per-node states). The
// setter is the same function for every copy of the page, so a run started on
// one keeps updating what the next one shows.

const shared = new Map<string, unknown>()
const sharedSetters = new Map<string, (action: unknown) => void>()

function sharedSetter<T>(key: string) {
  let setter = sharedSetters.get(key)
  if (!setter) {
    setter = (action: unknown) => {
      const prev = shared.get(key) as T
      const next = typeof action === "function" ? (action as (p: T) => T)(prev) : (action as T)
      if (Object.is(next, prev)) return
      shared.set(key, next)
      listeners.forEach((l) => l())
    }
    sharedSetters.set(key, setter)
  }
  return setter as (action: T | ((prev: T) => T)) => void
}

export function useSharedState<T>(key: string, initial: T) {
  // The first value is kept, so a fresh `initial` object each render is fine.
  if (!shared.has(key)) shared.set(key, initial)
  const get = () => shared.get(key) as T
  const value = useSyncExternalStore(subscribe, get, get)
  return [value, sharedSetter<T>(key)] as const
}

export const getShared = <T>(key: string, fallback: T) => (shared.has(key) ? (shared.get(key) as T) : fallback)

/** A ref that outlives the component, under `key`. */
export function sharedRef<T>(key: string, initial: T): { current: T } {
  const refKey = `ref:${key}`
  if (!shared.has(refKey)) shared.set(refKey, { current: initial })
  return shared.get(refKey) as { current: T }
}
