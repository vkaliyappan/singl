"use client"

import { toast } from "sonner"
import { exportEnvEntities, type EntityExportResult, type RemoteEntity } from "@/lib/entities"
import { extractCode } from "@/lib/twx"
import { appendJobLog, clearJob, isJobRunning, runJob } from "@/lib/background-jobs"

// The Entities page's Export / Extract runs, as background jobs.

export const ENTITY_EXPORT = "entities:export"
export const ENTITY_EXTRACT = "entities:extract"

export type EntityJobMeta = { env: string }
export type EntityExtractResult = { extractedAt: string | null }
export type { EntityExportResult }

export const entityJobBusy = () => isJobRunning(ENTITY_EXPORT) || isJobRunning(ENTITY_EXTRACT)

/** Exports `env`'s project(s), or just `only`; with `thenExtract`, extracts after a good export. */
export async function startExport(env: string, project: string | undefined, only?: RemoteEntity[], thenExtract = false) {
  if (entityJobBusy()) return
  clearJob(ENTITY_EXTRACT)
  const r = await runJob<EntityExportResult, EntityJobMeta>(
    ENTITY_EXPORT,
    (onLine) => exportEnvEntities(env, project, onLine, only),
    { meta: { env } }
  )
  if (!r) return
  if (!r.ok) {
    appendJobLog(ENTITY_EXPORT, `Error: ${r.error}`)
    toast.error("Export failed")
    return
  }
  toast.success(`Export complete: ${r.result.exported} entities`)
  if (thenExtract) await startExtract(env, true)
}

/** `afterExport`: chained from Export and Extract, so keep the export log above it. */
export async function startExtract(env: string, afterExport = false) {
  if (!afterExport) {
    if (entityJobBusy()) return
    clearJob(ENTITY_EXPORT)
  }
  const r = await runJob<EntityExtractResult, EntityJobMeta>(
    ENTITY_EXTRACT,
    (onLine) => extractCode({ envName: env }, onLine),
    { meta: { env } }
  )
  if (!r) return
  if (!r.ok) {
    appendJobLog(ENTITY_EXTRACT, `Error: ${r.error}`)
    toast.error("Extraction failed")
    return
  }
  toast.success("Extraction complete")
}

export function clearEntityJobs() {
  clearJob(ENTITY_EXPORT)
  clearJob(ENTITY_EXTRACT)
}
