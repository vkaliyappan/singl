"use client"

// Ported from singl-web's /deploy page. Environments and projects come from the
// settings commands instead of the database, loaded on mount.

import { useEffect, useState } from "react"
import { isTauri } from "@/lib/clock-widget"
import { errorMessage, getSettings, listEnvironments, type ProjectConfig } from "@/lib/settings"
import { DeployExplorer, type DeployProject } from "./deploy-explorer"

type Loaded = {
  envs: string[]
  projects: DeployProject[]
  projectsByEnv: Record<string, DeployProject[]>
  bundleProjects: { alias: string; projectName: string }[]
  bundleSrcDir: string
  bundleDestDir: string
  workspaceRoot: string
}

/** singl-web's toDeployProject: folder / ZIP name, WindchillClients folder, TWX name. */
function toDeployProject(p: ProjectConfig): DeployProject {
  return {
    key: p.folderName || p.projectName.replace(/\./g, "_"),
    alias: p.alias || p.projectName,
    projectName: p.projectName,
  }
}

/** First project per key — the same project is usually configured in several environments. */
function uniqueByKey(projects: DeployProject[]) {
  const seen = new Set<string>()
  return projects.filter((p) => {
    if (seen.has(p.key)) return false
    seen.add(p.key)
    return true
  })
}

export default function DeployPage() {
  const [data, setData] = useState<Loaded | null>(null)
  const [error, setError] = useState("")

  useEffect(() => {
    if (!isTauri()) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setError("Deployment runs in the desktop app. Open Singl through Tauri to use it.")
      return
    }
    Promise.all([listEnvironments(), getSettings()])
      .then(([envRows, app]) => {
        if (!app.workspaceRoot) {
          setError("Choose a workspace folder in Settings first. Relative paths resolve against it.")
          return
        }
        const enabled = envRows.filter((e) => e.enabled)
        // Projects are configured per environment in Settings.
        const projectsByEnv: Record<string, DeployProject[]> = {}
        for (const env of enabled) projectsByEnv[env.environment] = uniqueByKey(env.projects.map(toDeployProject))
        const projects = uniqueByKey(enabled.flatMap((e) => e.projects.map(toDeployProject)))

        // One bundle per alias folder.
        const seen = new Set<string>()
        const bundleProjects = projects
          .map((p) => ({ alias: p.alias, projectName: p.projectName }))
          .filter((p) => {
            if (seen.has(p.alias)) return false
            seen.add(p.alias)
            return true
          })

        setData({
          envs: enabled.map((e) => e.environment),
          projects,
          projectsByEnv,
          bundleProjects,
          bundleSrcDir: app.bundleSrcDir || "./WindchillClients/Thingworx",
          bundleDestDir: app.bundleDestDir || "./bundles",
          workspaceRoot: app.workspaceRoot,
        })
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

  return <DeployExplorer {...data} />
}
