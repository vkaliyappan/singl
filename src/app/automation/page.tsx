"use client"

// Automation: service test suites, environment drift reports and schedules.

import { useEffect, useState } from "react"
import { PageHeader } from "@/components/page-header"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { isTauri } from "@/lib/clock-widget"
import { errorMessage, listEnvironments } from "@/lib/settings"
import { DriftTab } from "./drift-tab"
import { SchedulesTab } from "./schedules-tab"
import { TestsTab } from "./tests-tab"

export default function AutomationPage() {
  const [envs, setEnvs] = useState<string[] | null>(null)
  const [error, setError] = useState("")

  useEffect(() => {
    if (!isTauri()) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setError("Automation runs in the desktop app. Open Singl through Tauri to use it.")
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
    <div className="flex flex-col gap-5 p-8">
      <PageHeader
        title="Automation"
        description="Test ThingWorx services, spot drift between environments, and run any of it on a schedule."
      />
      <Tabs defaultValue="tests">
        <TabsList>
          <TabsTrigger value="tests">Tests</TabsTrigger>
          <TabsTrigger value="drift">Drift</TabsTrigger>
          <TabsTrigger value="schedules">Schedules</TabsTrigger>
        </TabsList>
        <TabsContent value="tests" className="pt-3">
          <TestsTab envs={envs} />
        </TabsContent>
        <TabsContent value="drift" className="pt-3">
          <DriftTab envs={envs} />
        </TabsContent>
        <TabsContent value="schedules" className="pt-3">
          <SchedulesTab envs={envs} />
        </TabsContent>
      </Tabs>
    </div>
  )
}
