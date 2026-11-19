"use client"

// ThingWorx server page: health, subscriptions, schedulers, streams and data tables of one
// environment. The environment is chosen here or by `?env=` (the home tiles link to it).

import { Suspense, useEffect, useState } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { PageHeader } from "@/components/page-header"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { isTauri } from "@/lib/clock-widget"
import { errorMessage, listEnvironments } from "@/lib/settings"
import { useAssistantAction, useAssistantContext } from "@/lib/assistant/context"
import { DataTablesTab } from "./datatables-tab"
import { HealthTab } from "./health-tab"
import { SchedulersTab } from "./schedulers-tab"
import { StreamsTab } from "./streams-tab"
import { SubscriptionsTab } from "./subscriptions-tab"

const TABS = ["health", "subscriptions", "schedulers", "streams", "datatables"]

function TwxServer() {
  const router = useRouter()
  const wanted = useSearchParams().get("env")
  const [envs, setEnvs] = useState<string[] | null>(null)
  const [error, setError] = useState("")
  const [tab, setTab] = useState("health")

  useEffect(() => {
    if (!isTauri()) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setError("The ThingWorx server page runs in the desktop app. Open Singl through Tauri to use it.")
      return
    }
    listEnvironments()
      .then((rows) => setEnvs(rows.filter((e) => e.enabled).map((e) => e.environment)))
      .catch((err) => setError(errorMessage(err)))
  }, [])

  const env = envs ? (wanted && envs.includes(wanted) ? wanted : envs[0]) : ""
  useAssistantContext({
    screen: "twx-server",
    title: "ThingWorx server",
    summary: `${tab} on ${env || "no environment"}`,
    data: { env, tab, environments: envs ?? [], error },
  })
  useAssistantAction(
    "open_server_tab",
    {
      description: "Open a tab of the ThingWorx server page: health, subscriptions, schedulers, streams or datatables. Optionally switch env.",
      inputSchema: {
        type: "object",
        properties: { tab: { type: "string", enum: TABS }, env: { type: "string" } },
        required: ["tab"],
      },
    },
    async (args) => {
      const a = args as { tab?: string; env?: string }
      if (!a.tab || !TABS.includes(a.tab)) throw new Error(`tab must be one of ${TABS.join(", ")}.`)
      if (a.env && a.env !== env) {
        if (!envs?.includes(a.env)) throw new Error(`Unknown environment "${a.env}".`)
        router.replace(`/twx-server?env=${encodeURIComponent(a.env)}`)
      }
      setTab(a.tab)
      await new Promise((r) => setTimeout(r, 300)) // let the tab mount and register its actions
      return { tab: a.tab, env: a.env ?? env }
    },
  )

  if (error) {
    return (
      <div className="p-8">
        <p className="rounded-xl border bg-card px-4 py-3.5 text-xs text-muted-foreground">{error}</p>
      </div>
    )
  }
  if (!envs) return null
  if (!envs.length) {
    return (
      <div className="p-8">
        <p className="rounded-xl border bg-card px-4 py-3.5 text-xs text-muted-foreground">
          No ThingWorx environment is enabled. Add one in Settings.
        </p>
      </div>
    )
  }

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 p-6 lg:p-8">
      <PageHeader
        title="ThingWorx server"
        description="Health, subscriptions, schedulers, streams and data tables of one environment."
        actions={
          <NativeSelect
            aria-label="Environment"
            value={env}
            onChange={(e) => router.replace(`/twx-server?env=${encodeURIComponent(e.target.value)}`)}
          >
            {envs.map((e) => (
              <NativeSelectOption key={e} value={e}>
                {e}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        }
      />
      <Tabs value={tab} onValueChange={(v) => setTab(String(v))}>
        <TabsList>
          <TabsTrigger value="health">Health</TabsTrigger>
          <TabsTrigger value="subscriptions">Subscriptions</TabsTrigger>
          <TabsTrigger value="schedulers">Schedulers</TabsTrigger>
          <TabsTrigger value="streams">Streams</TabsTrigger>
          <TabsTrigger value="datatables">Data tables</TabsTrigger>
        </TabsList>
        {/* key: switching environment starts each tab afresh. */}
        <TabsContent value="health" className="pt-2">
          <HealthTab key={env} env={env} />
        </TabsContent>
        <TabsContent value="subscriptions" className="pt-2">
          <SubscriptionsTab key={env} env={env} />
        </TabsContent>
        <TabsContent value="schedulers" className="pt-2">
          <SchedulersTab key={env} env={env} />
        </TabsContent>
        <TabsContent value="streams" className="pt-2">
          <StreamsTab key={env} env={env} />
        </TabsContent>
        <TabsContent value="datatables" className="pt-2">
          <DataTablesTab key={env} env={env} />
        </TabsContent>
      </Tabs>
    </div>
  )
}

export default function TwxServerPage() {
  return (
    <Suspense>
      <TwxServer />
    </Suspense>
  )
}
