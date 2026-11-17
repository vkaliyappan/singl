"use client"

// singl-web's /twx-flow/[id] page. Static export cannot pre-render unknown ids,
// so the flow id comes from `?id=` and the flow is read on the client.

import { Suspense, useEffect, useState } from "react"
import Link from "next/link"
import { useSearchParams } from "next/navigation"
import { invoke } from "@tauri-apps/api/core"
import { isTauri } from "@/lib/clock-widget"
import { errorMessage, listEnvironments } from "@/lib/settings"
import { FlowEditor } from "../flow-editor"
import { onAssistantChange } from "@/lib/assistant/changes"

type FlowRecord = { id: string; name: string; environment: string; graph: string }
type EditorEnv = { environment: string; twxBaseUrl: string; hasAppKey: boolean }

function Message({ children }: { children: React.ReactNode }) {
  return (
    <div className="p-8">
      <p className="rounded-xl border bg-card px-4 py-3.5 text-xs text-muted-foreground">{children}</p>
    </div>
  )
}

function ServiceFlow() {
  const id = useSearchParams().get("id") ?? ""
  const [data, setData] = useState<{ flow: FlowRecord | null; envs: EditorEnv[] } | null>(null)
  const [error, setError] = useState("")
  // Bumped when the assistant rewrites this flow, so the editor starts over from it.
  const [version, setVersion] = useState(0)

  useEffect(() => {
    if (!isTauri()) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setError("Service Flows runs in the desktop app. Open Singl through Tauri to use it.")
      return
    }
    if (!id) return
    Promise.all([invoke<FlowRecord | null>("flow_get", { id }), listEnvironments()])
      .then(([flow, envs]) =>
        setData({
          flow,
          envs: envs
            .filter((e) => e.enabled)
            .map(({ environment, twxBaseUrl, hasAppKey }) => ({ environment, twxBaseUrl, hasAppKey })),
        }),
      )
      .catch((err) => setError(errorMessage(err)))
  }, [id])

  useEffect(() => {
    if (data?.flow) document.title = data.flow.name
  }, [data])

  useEffect(() => {
    if (!id) return
    return onAssistantChange("flows", (change) => {
      if (change.input.id !== id) return
      invoke<FlowRecord | null>("flow_get", { id })
        .then((flow) => {
          setData((d) => (d ? { ...d, flow } : d))
          if (change.tool === "flow_save" || change.tool === "flow_rename") setVersion((v) => v + 1)
        })
        .catch(() => {})
    })
  }, [id])

  if (error) return <Message>{error}</Message>
  if (!id || (data && !data.flow)) {
    return (
      <Message>
        That flow does not exist.{" "}
        <Link href="/twx-flow" className="underline">
          Back to Service Flows
        </Link>
      </Message>
    )
  }
  if (!data?.flow) return null

  return (
    <FlowEditor
      // Opening another flow from inside the editor must start from scratch.
      key={`${data.flow.id}:${version}`}
      flowId={data.flow.id}
      flowName={data.flow.name}
      initialGraph={data.flow.graph}
      initialEnv={data.flow.environment}
      envs={data.envs}
    />
  )
}

export default function ServiceFlowPage() {
  return (
    <Suspense>
      <ServiceFlow />
    </Suspense>
  )
}
