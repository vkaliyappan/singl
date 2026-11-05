"use client"

// Ported from singl-web's /twx-flow page. Flows, folders and environments come
// from commands; the page reloads them whenever an action reports a change.

import { useCallback, useEffect, useState } from "react"
import { invoke } from "@tauri-apps/api/core"
import { isTauri } from "@/lib/clock-widget"
import { errorMessage, listEnvironments } from "@/lib/settings"
import { onFlowsChanged } from "./actions"
import { FlowHub } from "./flow-hub"
import type { EnvRow, FlowRow, FolderRow } from "./hub-model"

/** singl-core's ServiceFlow / FlowFolder rows: timestamps in unix seconds. */
type Stamped = { createdAt: number | null; updatedAt: number | null }
type RawFlow = Omit<FlowRow, "createdAt" | "updatedAt"> & Stamped
type RawFolder = Omit<FolderRow, "createdAt" | "updatedAt"> & Stamped

const toDate = (seconds: number | null) => (seconds == null ? null : new Date(seconds * 1000))
const withDates = <T extends Stamped>(row: T) => ({
  ...row,
  createdAt: toDate(row.createdAt),
  updatedAt: toDate(row.updatedAt),
})

type HubData = { flows: FlowRow[]; folders: FolderRow[]; envs: EnvRow[] }

export default function ServiceFlowsPage() {
  const [data, setData] = useState<HubData | null>(null)
  const [error, setError] = useState("")

  const load = useCallback(() => {
    Promise.all([invoke<RawFlow[]>("flow_list"), invoke<RawFolder[]>("flow_folders_list"), listEnvironments()])
      .then(([flows, folders, envs]) =>
        setData({
          flows: flows.map(withDates),
          folders: folders.map(withDates),
          envs: envs.filter((e) => e.enabled).map(({ environment, twxBaseUrl }) => ({ environment, twxBaseUrl })),
        }),
      )
      .catch((err) => setError(errorMessage(err)))
  }, [])

  useEffect(() => {
    if (!isTauri()) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setError("Service Flows runs in the desktop app. Open Singl through Tauri to use it.")
      return
    }
    load()
    return onFlowsChanged(load)
  }, [load])

  if (error) {
    return (
      <div className="p-8">
        <p className="rounded-xl border bg-card px-4 py-3.5 text-xs text-muted-foreground">{error}</p>
      </div>
    )
  }
  if (!data) return null
  return <FlowHub flows={data.flows} folders={data.folders} envs={data.envs} />
}
