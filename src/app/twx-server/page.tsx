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
import { DataTablesTab } from "./datatables-tab"
import { HealthTab } from "./health-tab"
import { SchedulersTab } from "./schedulers-tab"
import { StreamsTab } from "./streams-tab"
import { SubscriptionsTab } from "./subscriptions-tab"

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

  const env = wanted && envs.includes(wanted) ? wanted : envs[0]

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
