"use client"

// Automation: service test suites, environment drift reports and schedules.

import { useEffect, useState } from "react"
import { PageHeader } from "@/components/page-header"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { isTauri } from "@/lib/clock-widget"
import { errorMessage, listEnvironments } from "@/lib/settings"
import { useAssistantAction, useAssistantContext } from "@/lib/assistant/context"
import { DriftTab } from "./drift-tab"
import { SchedulesTab } from "./schedules-tab"
import { TestsTab } from "./tests-tab"

const TABS = ["tests", "drift", "schedules"]

export default function AutomationPage() {
  const [envs, setEnvs] = useState<string[] | null>(null)
  const [error, setError] = useState("")
  const [tab, setTab] = useState("tests")
  useAssistantContext({
    screen: "automation",
    title: "Automation",
    summary: `${tab} tab`,
    data: { tab, environments: envs ?? [], error },
  })
  useAssistantAction(
    "open_automation_tab",
    {
      description: "Open the Tests, Drift or Schedules tab of the Automation page.",
      inputSchema: { type: "object", properties: { tab: { type: "string", enum: TABS } }, required: ["tab"] },
    },
    async (args) => {
      const t = String((args as { tab?: string }).tab ?? "")
      if (!TABS.includes(t)) throw new Error(`tab must be one of ${TABS.join(", ")}.`)
      setTab(t)
      await new Promise((r) => setTimeout(r, 300)) // let the tab mount and register its actions
      return { tab: t }
    },
  )

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
      <Tabs value={tab} onValueChange={(v) => setTab(String(v))}>
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
