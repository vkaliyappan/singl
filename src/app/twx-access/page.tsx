"use client"

import { useEffect, useState } from "react"
import { PageHeader } from "@/components/page-header"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { isTauri } from "@/lib/clock-widget"
import { errorMessage, listEnvironments } from "@/lib/settings"
import { useAssistantAction, useAssistantContext } from "@/lib/assistant/context"
import { NativeSelect } from "@/components/ui/native-select"
import { MashupsTab } from "./mashups-tab"
import { PermissionsTab } from "./permissions-tab"
import type { Env } from "./shared"

export default function TwxAccessPage() {
  const [envs, setEnvs] = useState<Env[]>([])
  const [env, setEnv] = useState("")
  const [error, setError] = useState("")

  useEffect(() => {
    if (!isTauri()) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setError("Access & Mashups runs in the desktop app. Open Singl through Tauri to use it.")
      return
    }
    listEnvironments()
      .then((rows) => {
        const enabled = rows.filter((e) => e.enabled)
        setEnvs(enabled)
        setEnv(enabled[0]?.environment ?? "")
      })
      .catch((err) => setError(errorMessage(err)))
  }, [])

  const current = envs.find((e) => e.environment === env)
  const [tab, setTab] = useState("permissions")
  useAssistantContext({
    screen: "twx-access",
    title: "Access & Mashups",
    summary: `${tab} on ${env || "no environment"}`,
    data: { env, tab, environments: envs.map((e) => e.environment), error },
  })
  useAssistantAction(
    "open_access_tab",
    {
      description: "Open the Permissions or Mashups tab (optionally switching env).",
      inputSchema: {
        type: "object",
        properties: { tab: { type: "string", enum: ["permissions", "mashups"] }, env: { type: "string" } },
        required: ["tab"],
      },
    },
    async (args) => {
      const a = args as { tab?: string; env?: string }
      if (a.tab !== "permissions" && a.tab !== "mashups") throw new Error("tab must be permissions or mashups.")
      if (a.env) {
        if (!envs.some((e) => e.environment === a.env)) throw new Error(`Unknown environment "${a.env}".`)
        setEnv(a.env)
      }
      setTab(a.tab)
      await new Promise((r) => setTimeout(r, 300))
      return { tab: a.tab, env: a.env ?? env }
    },
  )

  return (
    <div className="flex flex-col gap-5 p-8">
      <PageHeader
        title="Access & Mashups"
        description="Who can do what on an entity, and a quick look at any mashup."
        actions={
          <NativeSelect value={env} onChange={(e) => setEnv(e.target.value)} aria-label="Environment">
            {envs.map((e) => (
              <option key={e.environment} value={e.environment}>
                {e.environment}
              </option>
            ))}
          </NativeSelect>
        }
      />
      {error ? (
        <p className="rounded-xl border bg-card px-4 py-3.5 text-xs text-muted-foreground">{error}</p>
      ) : !current ? (
        <p className="text-xs text-muted-foreground">No ThingWorx environment is enabled. Add one in Settings.</p>
      ) : (
        <Tabs value={tab} onValueChange={(v) => setTab(String(v))}>
          <TabsList>
            <TabsTrigger value="permissions">Permissions</TabsTrigger>
            <TabsTrigger value="mashups">Mashups</TabsTrigger>
          </TabsList>
          <TabsContent value="permissions">
            <PermissionsTab key={current.environment} env={current.environment} />
          </TabsContent>
          <TabsContent value="mashups">
            <MashupsTab key={current.environment} env={current.environment} baseUrl={current.twxBaseUrl} />
          </TabsContent>
        </Tabs>
      )}
    </div>
  )
}
