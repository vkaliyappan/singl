"use client"

// Ported from singl-web's /compare page. Enabled environments come from the
// settings commands, loaded on mount.

import { useEffect, useState } from "react"
import { isTauri } from "@/lib/clock-widget"
import { errorMessage, getSettings, listEnvironments } from "@/lib/settings"
import { CompareExplorer } from "./compare-explorer"

export default function ComparePage() {
  const [envs, setEnvs] = useState<string[] | null>(null)
  const [error, setError] = useState("")

  useEffect(() => {
    if (!isTauri()) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setError("Compare runs in the desktop app. Open Singl through Tauri to use it.")
      return
    }
    Promise.all([listEnvironments(), getSettings()])
      .then(([envRows, app]) => {
        if (!app.workspaceRoot) {
          setError("Choose a workspace folder in Settings first. Compare reads its repo and twx-entities folders.")
          return
        }
        setEnvs(envRows.filter((e) => e.enabled).map((e) => e.environment))
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
  if (!envs) return null

  return <CompareExplorer envs={envs} />
}
