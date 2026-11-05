"use client"

// Ported from singl-web's /twx-entities page. Environments come from the
// settings commands, and deep links from the query string, read on the client.

import { Suspense, useEffect, useState } from "react"
import { useSearchParams } from "next/navigation"
import { isTauri } from "@/lib/clock-widget"
import { errorMessage, getSettings, listEnvironments, type EnvSetting } from "@/lib/settings"
import { parseEntityLink } from "@/lib/twx/links"
import { TwxExplorer } from "./twx-explorer"

function TwxEntities() {
  const searchParams = useSearchParams()
  const [envs, setEnvs] = useState<EnvSetting[] | null>(null)
  const [error, setError] = useState("")

  useEffect(() => {
    if (!isTauri()) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setError("TWX Entities runs in the desktop app. Open Singl through Tauri to use it.")
      return
    }
    Promise.all([listEnvironments(), getSettings()])
      .then(([envRows, app]) => {
        if (!app.workspaceRoot) {
          setError("Choose a workspace folder in Settings first. Exports are kept under its twx-entities folder.")
          return
        }
        setEnvs(envRows.filter((e) => e.enabled))
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

  const params = Object.fromEntries(searchParams.entries())
  const link = parseEntityLink(params)
  // A file to open, e.g. from another page: `<env folder>/…`.
  const rawFile = params.file
  const fileLink = rawFile && !rawFile.split("/").includes("..") ? rawFile : null

  return (
    <TwxExplorer
      key={link ? JSON.stringify(link) : (fileLink ?? "default")}
      initialEnvs={envs}
      link={link}
      fileLink={fileLink}
    />
  )
}

export default function TwxEntitiesPage() {
  return (
    <Suspense>
      <TwxEntities />
    </Suspense>
  )
}
