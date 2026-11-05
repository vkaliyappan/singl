"use client"

// Ported from singl-web's /twx-migrate page. Its API routes run in the webview
// over the entity file commands (src/lib/migrate.ts).

import { useSyncExternalStore } from "react"
import { isTauri } from "@/lib/clock-widget"
import { TwxMigrateExplorer } from "./twx-migrate-explorer"

const subscribe = () => () => {}

export default function TwxMigratePage() {
  // null during the static prerender, where Tauri is never present.
  const inTauri = useSyncExternalStore(subscribe, isTauri, () => null)
  if (inTauri === null) return null
  if (!inTauri) {
    return (
      <div className="p-6 text-sm text-muted-foreground">
        TWX Migrate runs in the desktop app. Open Singl through Tauri to use it.
      </div>
    )
  }
  return <TwxMigrateExplorer />
}
