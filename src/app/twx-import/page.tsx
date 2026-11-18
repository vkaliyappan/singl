"use client"

// Imports entity XML from twx-entities into a ThingWorx server. Environments
// come from the settings commands, loaded on mount.

import { useEffect, useState } from "react"
import { isTauri } from "@/lib/clock-widget"
import { errorMessage, getSettings, listEnvironments } from "@/lib/settings"
import { TwxImport } from "./twx-import"

export default function TwxImportPage() {
  const [data, setData] = useState<{ envs: string[]; root: string } | null>(null)
  const [error, setError] = useState("")

  useEffect(() => {
    if (!isTauri()) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setError("TWX Import runs in the desktop app. Open Singl through Tauri to use it.")
      return
    }
    Promise.all([listEnvironments(), getSettings()])
      .then(([envRows, app]) => {
        if (!app.workspaceRoot) {
          setError("Choose a workspace folder in Settings first. Import reads its twx-entities folder.")
          return
        }
        setData({ envs: envRows.filter((e) => e.enabled).map((e) => e.environment), root: app.workspaceRoot })
      })
      .catch((err) => setError(errorMessage(err)))
  }, [])

  if (error) {
    return (
      <div className="p-8">
        <p className="rounded-xl border bg-card px-4 py-3.5 text-xs text-muted-foreground">{error}</p>
      </div>
    )
  }
  if (!data) return null
  return <TwxImport envs={data.envs} workspaceRoot={data.root} />
}
