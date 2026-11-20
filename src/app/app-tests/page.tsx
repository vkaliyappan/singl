"use client"

// App Tests: AI-driven browser tests of ThingWorx mashups, run through Playwright with a saved SSO login.

import { useEffect, useState } from "react"
import { PageHeader } from "@/components/page-header"
import { isTauri } from "@/lib/clock-widget"
import { errorMessage, listEnvironments } from "@/lib/settings"
import { AppTests } from "./app-tests"

export default function AppTestsPage() {
  const [envs, setEnvs] = useState<string[] | null>(null)
  const [error, setError] = useState("")

  useEffect(() => {
    if (!isTauri()) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setError("App Tests run in the desktop app. Open Singl through Tauri to use them.")
      return
    }
    listEnvironments()
      .then((rows) => setEnvs(rows.filter((e) => e.enabled).map((e) => e.environment)))
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

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 px-6 pt-6 pb-4">
      <PageHeader
        title="App Tests"
        description="AI-driven browser tests of ThingWorx mashups, written as Azure test cases."
      />
      <div className="min-h-0 flex-1 overflow-hidden rounded-xl border bg-card">
        <AppTests envs={envs} />
      </div>
    </div>
  )
}
