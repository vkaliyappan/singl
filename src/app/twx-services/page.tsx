"use client"

// Ported from singl-web's /twx-services page. Environments and presets come
// from commands, and deep links from the query string, read on the client.

import { Suspense, useEffect, useState } from "react"
import { useSearchParams } from "next/navigation"
import { isTauri } from "@/lib/clock-widget"
import { listServicePresets } from "@/lib/services"
import { errorMessage, listEnvironments } from "@/lib/settings"
import { parseServiceLink } from "@/lib/twx/links"
import { toPreset, TwxServicesExplorer, type Env, type Preset } from "./twx-services-explorer"

function TwxServices() {
  const searchParams = useSearchParams()
  const [data, setData] = useState<{ envs: Env[]; presets: Preset[] } | null>(null)
  const [error, setError] = useState("")

  useEffect(() => {
    if (!isTauri()) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setError("TWX Services runs in the desktop app. Open Singl through Tauri to use it.")
      return
    }
    Promise.all([listEnvironments(), listServicePresets()])
      .then(([envRows, presetRows]) =>
        setData({
          envs: envRows
            .filter((e) => e.enabled)
            .map(({ environment, twxBaseUrl, hasAppKey }) => ({ environment, twxBaseUrl, hasAppKey })),
          presets: presetRows.map(toPreset),
        }),
      )
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

  const link = parseServiceLink(Object.fromEntries(searchParams.entries()))

  return (
    <TwxServicesExplorer
      // A fresh link remounts the explorer, so it opens onto the new target.
      key={link ? JSON.stringify(link) : "default"}
      initialEnvs={data.envs}
      initialPresets={data.presets}
      link={link}
    />
  )
}

export default function TwxServicesPage() {
  return (
    <Suspense>
      <TwxServices />
    </Suspense>
  )
}
