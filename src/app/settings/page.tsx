"use client"

import { useCallback, useEffect, useState } from "react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { PageHeader } from "@/components/page-header"
import { isTauri } from "@/lib/clock-widget"
import { errorMessage, getSettings, listEnvironments, type AppSettings, type EnvSetting } from "@/lib/settings"
import { SettingsExplorer } from "./settings-form"

type Loaded = { settings: EnvSetting[]; app: AppSettings }

// The OS notification only fires while the window is unfocused, so the toast
// is delayed to give time to switch to another app.
function sendTestNotification() {
  toast.info("Test notification scheduled", { description: "Switch to another app within 5 seconds." })
  setTimeout(() => toast.success("Test notification", { description: "Notifications are working." }), 5000)
}

export default function SettingsPage() {
  const [data, setData] = useState<Loaded | null>(null)
  const [error, setError] = useState("")

  const refresh = useCallback(async () => {
    const [settings, app] = await Promise.all([listEnvironments(), getSettings()])
    setData({ settings, app })
  }, [])

  useEffect(() => {
    if (!isTauri()) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setError("Settings are stored by the desktop app. Open Singl through Tauri to edit them.")
      return
    }
    refresh().catch((err) => setError(errorMessage(err)))
  }, [refresh])

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto flex max-w-5xl flex-col gap-6 px-8 py-8">
        <PageHeader
          title="Settings"
          description="ThingWorx connections, credentials and path mappings."
          actions={
            // data only loads inside Tauri; checking isTauri() during render would
            // mismatch the prerendered HTML.
            data && (
              <Button variant="outline" size="sm" onClick={sendTestNotification}>
                Test notification
              </Button>
            )
          }
        />
        {error ? (
          <p className="rounded-xl border bg-card px-4 py-3.5 text-xs text-muted-foreground">{error}</p>
        ) : data ? (
          <SettingsExplorer settings={data.settings} app={data.app} refresh={refresh} />
        ) : (
          <div className="flex flex-col gap-3">
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-48 w-full" />
          </div>
        )}
      </div>
    </div>
  )
}
