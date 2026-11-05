"use client"

import { useEffect, useState } from "react"
import { isTauri } from "@/lib/clock-widget"
import { getRepo, type RepoState } from "@/lib/repo"
import { errorMessage, getSettings } from "@/lib/settings"
import { RepoExplorer } from "./repo-explorer"

type Loaded = RepoState & { hasPatToken: boolean }

export default function RepoPage() {
  const [data, setData] = useState<Loaded | null>(null)
  const [error, setError] = useState("")

  useEffect(() => {
    if (!isTauri()) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setError("The repository lives in the desktop app. Open Singl through Tauri to use it.")
      return
    }
    Promise.all([getRepo(), getSettings()])
      .then(([repo, app]) => {
        if (!app.workspaceRoot) {
          setError("Choose a workspace folder in Settings first. Clones go in its repo folder.")
          return
        }
        setData({ ...repo, hasPatToken: app.hasAzurePatToken })
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

  return (
    <RepoExplorer
      hasPatToken={data.hasPatToken}
      savedRepoUrl={data.repoUrl}
      savedBranch={data.clonedBranch}
      savedSlug={data.repoSlug}
    />
  )
}
