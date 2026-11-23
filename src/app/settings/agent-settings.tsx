"use client"

// Ported from singl-web's settings/agent-settings.tsx. Each toggle saves on
// its own; a failed save puts the switch back.

import { useEffect, useState } from "react"
import { IconRefresh, IconRobot } from "@tabler/icons-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Switch } from "@/components/ui/switch"
import { errorMessage } from "@/lib/settings"
import { listAgentAvailability, setDisabledAgents, type AgentAvailability } from "@/lib/twx-flow/agent-models"
import type { AgentProvider } from "@/lib/twx-flow/types"

export function AgentSettings() {
  const [agents, setAgents] = useState<AgentAvailability[] | null>(null)
  const [error, setError] = useState("")
  const [pending, setPending] = useState(false)

  const load = () =>
    listAgentAvailability()
      .then(setAgents)
      .catch((e) => setError(errorMessage(e)))

  useEffect(() => {
    void load()
  }, [])

  const toggle = async (provider: AgentProvider, on: boolean) => {
    if (!agents) return
    const previous = agents
    const next = agents.map((a) => (a.provider === provider ? { ...a, enabled: on } : a))
    setAgents(next)
    setError("")
    setPending(true)
    try {
      await setDisabledAgents(next.filter((a) => !a.enabled).map((a) => a.provider))
    } catch (e) {
      setAgents(previous)
      setError(errorMessage(e))
    } finally {
      setPending(false)
    }
  }

  return (
    <Card className="gap-0 py-0">
      <CardHeader className="border-b px-3.5 py-2.5">
        <div className="flex items-center gap-2">
          <IconRobot className="size-4 text-primary" />
          <CardTitle className="text-xs font-semibold">Coding-agent CLIs</CardTitle>
          <Button variant="ghost" size="icon-xs" className="ml-auto" onClick={() => void load()} title="Look again">
            <IconRefresh />
          </Button>
        </div>
        <CardDescription className="text-[11px]">
          Which agents Service Flow Agent nodes can run. The CLIs run on this computer, signed in as you, in your
          workspace folder (or <code className="font-mono">TWX_FLOW_AGENT_ROOT</code> when set).
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 p-3.5">
        {!agents && !error && <p className="text-[11px] text-muted-foreground">Looking for installed CLIs…</p>}
        {agents && (
          <ul className="divide-y rounded-md border">
            {agents.map((agent) => (
              <li key={agent.provider} className="flex items-center gap-3 px-3 py-2">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-medium">{agent.title}</span>
                    {agent.installed ? (
                      <Badge
                        variant="success" className="h-4 py-0 text-[10px] font-normal"
                      >
                        Installed
                      </Badge>
                    ) : (
                      <Badge
                        variant="warning" className="h-4 py-0 text-[10px] font-normal"
                      >
                        Not found
                      </Badge>
                    )}
                  </div>
                  <p className="text-[10px] text-muted-foreground">
                    <code className="font-mono">{agent.bin}</code>
                    {!agent.installed && " is not on PATH"}
                  </p>
                </div>
                <Switch
                  checked={agent.enabled}
                  disabled={pending}
                  onCheckedChange={(on) => void toggle(agent.provider, on)}
                  aria-label={`Enable ${agent.title}`}
                />
              </li>
            ))}
          </ul>
        )}
        {error && <p className="text-[10px] font-medium text-destructive">{error}</p>}
      </CardContent>
    </Card>
  )
}
