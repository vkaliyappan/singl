"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import { isTauri } from "@/lib/clock-widget"
import { errorMessage, listEnvironments } from "@/lib/settings"
import { pingServer, type Ping } from "@/lib/twx-admin"
import { cn } from "@/lib/utils"

type Tile = { env: string; ping: Ping | null }

/** Memory use above this reads as a warning. */
const WARN_MEMORY = 0.85
const SLOW_MS = 2000

function tone(ping: Ping | null) {
  if (!ping) return "border-border"
  if (!ping.ok) return "border-destructive/40 bg-destructive/5"
  const mem = ping.memoryUsed != null && ping.memoryTotal ? ping.memoryUsed / ping.memoryTotal : 0
  if (mem > WARN_MEMORY || ping.latencyMs > SLOW_MS) return "border-warning/40 bg-warning/5"
  return "border-success/30 bg-success/5"
}

function dot(ping: Ping | null) {
  if (!ping) return "bg-muted-foreground/40 animate-pulse"
  if (!ping.ok) return "bg-destructive"
  return tone(ping).includes("warning") ? "bg-warning" : "bg-success"
}

/** One compact tile per enabled environment, each pinged on its own so a slow server does not hold the others. */
export function ServerHealthTiles() {
  const [tiles, setTiles] = useState<Tile[]>([])

  useEffect(() => {
    if (!isTauri()) return
    let live = true
    listEnvironments()
      .then((envs) => {
        const names = envs.filter((e) => e.enabled).map((e) => e.environment)
        if (!live) return
        setTiles(names.map((env) => ({ env, ping: null })))
        for (const env of names) {
          pingServer(env)
            .catch((err): Ping => ({ ok: false, latencyMs: 0, version: null, memoryUsed: null, memoryTotal: null, error: errorMessage(err) }))
            .then((ping) => live && setTiles((t) => t.map((x) => (x.env === env ? { env, ping } : x))))
        }
      })
      .catch(() => {})
    return () => {
      live = false
    }
  }, [])

  if (!tiles.length) return null

  return (
    <div className="flex flex-col gap-2">
      <h2 className="text-sm font-medium text-foreground">Servers</h2>
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        {tiles.map(({ env, ping }) => {
          const mem = ping?.memoryUsed != null && ping.memoryTotal ? Math.round((ping.memoryUsed / ping.memoryTotal) * 100) : null
          return (
            <Link
              key={env}
              href={`/twx-server?env=${encodeURIComponent(env)}`}
              title={ping && !ping.ok ? (ping.error ?? "Unreachable") : undefined}
              className={cn("flex flex-col gap-1 rounded-xl border px-3 py-2 text-xs transition-colors hover:bg-muted/50 outline-none focus-visible:ring-2 focus-visible:ring-ring/40", tone(ping))}
            >
              <div className="flex items-center gap-2">
                <span className={cn("size-2 shrink-0 rounded-full", dot(ping))} />
                <span className="truncate font-medium">{env}</span>
              </div>
              <div className="truncate text-[11px] text-muted-foreground">
                {!ping
                  ? "Checking..."
                  : !ping.ok
                    ? "Unreachable"
                    : `${ping.version ?? "?"} · ${ping.latencyMs} ms${mem != null ? ` · mem ${mem}%` : ""}`}
              </div>
            </Link>
          )
        })}
      </div>
    </div>
  )
}
