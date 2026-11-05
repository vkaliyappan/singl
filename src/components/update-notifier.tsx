"use client"

import { useEffect } from "react"
import { getCurrentWindow } from "@tauri-apps/api/window"
import { toast } from "sonner"
import { isTauri } from "@/lib/clock-widget"
import { checkForUpdate, errorMessage, installUpdate } from "@/lib/settings"

/** Checks the update folder once at startup and offers the new version in a toast. */
export function UpdateNotifier() {
  useEffect(() => {
    // The clock widget window shares this layout; only the main window asks.
    if (!isTauri() || getCurrentWindow().label !== "main") return
    // No folder set or the share is offline: stay quiet, Settings → Updates shows why.
    checkForUpdate()
      .then((update) => {
        if (!update) return
        toast.info(`singl ${update.version} is available`, {
          id: "singl-update",
          description: update.notes || `You have ${update.currentVersion}.`,
          duration: Infinity,
          action: {
            label: "Install",
            onClick: () => installUpdate().catch((err) => toast.error("Update failed", { description: errorMessage(err) })),
          },
        })
      })
      .catch(() => {})
  }, [])

  return null
}
