import Link from "next/link"
import { IconArrowRight, IconSparkles } from "@tabler/icons-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { WorldClock } from "@/components/world-clock"
import { TeamsPresenceKeeper } from "@/components/teams-presence-keeper"
import { ServerHealthTiles } from "@/components/server-health-tiles"

export default function Home() {
  return (
    <div className="relative flex h-full flex-1 flex-col overflow-y-auto">
      {/* Ambient backdrop */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-[400px]"
        style={{
          background:
            "radial-gradient(60% 100% at 20% 0%, color-mix(in oklch, var(--primary) 12%, transparent) 0%, transparent 70%)",
        }}
      />

      <div className="relative mx-auto flex w-full max-w-6xl flex-1 flex-col justify-start gap-4 px-6 py-4 lg:px-8 lg:py-5">
        {/* Hero + world clock */}
        <div className="grid items-center gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)]">
          <div className="flex flex-col items-start gap-3.5">
            <div className="flex items-center gap-2.5">
              <div
                className="flex size-9 shrink-0 items-center justify-center rounded-xl shadow-md shadow-primary/20"
                style={{
                  background: "linear-gradient(135deg, var(--primary) 0%, oklch(0.5 0.22 260) 100%)",
                }}
              >
                <span className="text-sm font-bold tracking-tight text-white">S</span>
              </div>
              <Badge variant="secondary" className="gap-1 rounded-full px-2.5 py-0.5 text-[11px] font-medium tracking-wide">
                <IconSparkles size={11} className="text-primary" />
                WORKSPACE
              </Badge>
            </div>

            <div className="flex flex-col gap-1.5">
              <h1 className="font-heading text-3xl font-extrabold leading-tight tracking-tight sm:text-4xl lg:text-[2.5rem]">
                Singl{" "}
                <span className="bg-gradient-to-r from-primary via-indigo-500 to-violet-500 bg-clip-text text-transparent">
                  Workspace
                </span>
              </h1>
              <p className="max-w-lg text-sm leading-relaxed text-muted-foreground">
                Sync ThingWorx entities with Git. Manage environments, explore
                definitions, and track changes across versions with ease.
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-2 pt-0.5">
              <Button
                render={<Link href="/repo" />}
                nativeButton={false}
                size="default"
                className="h-8.5 gap-2 rounded-full px-4.5 text-xs font-semibold shadow-xs transition-all hover:-translate-y-0.5 hover:shadow-md"
              >
                Get started <IconArrowRight size={13} />
              </Button>
              <Button
                render={<Link href="/settings" />}
                nativeButton={false}
                size="default"
                variant="outline"
                className="h-8.5 gap-2 rounded-full px-4.5 text-xs font-semibold transition-all hover:-translate-y-0.5 hover:bg-muted/60"
              >
                Settings
              </Button>
            </div>
          </div>

          <WorldClock />
        </div>

        <ServerHealthTiles />

        <TeamsPresenceKeeper />
      </div>
    </div>
  )
}
