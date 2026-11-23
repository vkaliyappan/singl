"use client"

import { useCallback, useEffect, useState } from "react"
import {
  IconBrandTeams,
  IconPlayerPlay,
  IconPlayerStop,
  IconAlertTriangle,
} from "@tabler/icons-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Spinner } from "@/components/ui/spinner"
import { presenceStart, presenceStatus, presenceStop, type KeeperStatus } from "@/lib/presence"
import { errorMessage } from "@/lib/settings"
import { cn } from "@/lib/utils"

const POLL_MS = 5000

function formatDuration(fromIso: string | null): string {
  if (!fromIso) return "—"
  const ms = Date.now() - new Date(fromIso).getTime()
  if (!Number.isFinite(ms) || ms < 0) return "—"
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  const h = Math.floor(m / 60)
  return `${h}h ${m % 60}m`
}

function formatAgo(iso: string | null): string {
  if (!iso) return "waiting for first nudge"
  return `last nudge ${formatDuration(iso)} ago`
}

export function TeamsPresenceKeeper() {
  const [status, setStatus] = useState<KeeperStatus | null>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [, setTick] = useState(0)

  const refresh = useCallback(async () => {
    try {
      setStatus(await presenceStatus())
      setError(null)
    } catch (err) {
      setError(errorMessage(err) || "Failed to read status")
    }
  }, [])

  useEffect(() => {
    // refresh() only setStates after an awaited invoke, never synchronously.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh()
    const id = setInterval(() => void refresh(), POLL_MS)
    return () => clearInterval(id)
  }, [refresh])

  // Keeps the "running for" / "last nudge" labels counting between polls.
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000)
    return () => clearInterval(id)
  }, [])

  async function toggle() {
    if (!status || pending) return
    setPending(true)
    setError(null)
    try {
      setStatus(status.running ? await presenceStop() : await presenceStart())
    } catch (err) {
      setError(errorMessage(err) || "Action failed")
    } finally {
      setPending(false)
    }
  }

  const loading = status === null && error === null
  const running = status?.running ?? false
  const unsupported = status !== null && !status.supported

  return (
    <div
      className={cn(
        "flex items-center justify-between gap-4 rounded-xl border bg-card/80 px-4 py-2.5 backdrop-blur-xs transition-all shadow-xs shrink-0",
        running ? "border-success/30 bg-success/5" : "border-border"
      )}
    >
      <div className="flex items-center gap-3.5 min-w-0">
        <div
          className="flex size-9 shrink-0 items-center justify-center rounded-xl shadow-xs"
          style={{
            backgroundColor: running
              ? "color-mix(in oklch, var(--chart-1) 18%, transparent)"
              : "color-mix(in oklch, var(--chart-1) 12%, transparent)",
            color: "var(--chart-1)",
          }}
        >
          <IconBrandTeams size={19} />
        </div>

        <div className="flex min-w-0 flex-col gap-0.5">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-semibold leading-none text-foreground">Teams Presence Keeper</span>
            {loading ? (
              <Badge variant="outline" className="text-[11px] px-2 py-0.5 font-medium">Checking…</Badge>
            ) : unsupported ? (
              <Badge variant="outline" className="text-[11px] px-2 py-0.5 font-medium">Windows only</Badge>
            ) : running ? (
              <Badge className="gap-1.5 bg-success/15 text-success border-success/20 text-[11px] px-2 py-0.5 font-semibold">
                <span className="size-1.5 rounded-full bg-success animate-pulse" />
                Active
              </Badge>
            ) : (
              <Badge variant="secondary" className="text-[11px] px-2 py-0.5 font-medium">Stopped</Badge>
            )}
          </div>
          <p className="text-xs leading-normal text-muted-foreground truncate">
            {running && status
              ? `Nudging every ${status.intervalSeconds}s · PID ${status.pid} · running for ${formatDuration(status.startedAt)} · ${formatAgo(status.lastTickAt)}`
              : "Blocks the Windows idle timer so Teams stays Available instead of going Away."}
          </p>
        </div>
      </div>

      <div className="flex items-center gap-2 shrink-0">
        {error && (
          <span className="flex items-center gap-1 text-xs text-destructive">
            <IconAlertTriangle size={13} className="shrink-0" />
            {error}
          </span>
        )}
        <Button
          onClick={toggle}
          disabled={pending || loading || unsupported}
          variant={running ? "outline" : "default"}
          className={cn(
            "h-8 shrink-0 gap-1.5 rounded-full px-4 text-xs font-semibold shadow-xs hover:shadow transition-all",
            running ? "hover:bg-destructive/10 hover:text-destructive hover:border-destructive/30" : ""
          )}
        >
          {pending ? (
            <Spinner className="size-3.5" />
          ) : running ? (
            <IconPlayerStop size={14} />
          ) : (
            <IconPlayerPlay size={14} />
          )}
          {running ? "Stop" : "Start"}
        </Button>
      </div>
    </div>
  )
}
