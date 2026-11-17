"use client"

import { useEffect } from "react"
import { usePathname } from "next/navigation"
import { SidebarProvider, SidebarInset } from "@/components/ui/sidebar"
import { TitleBar } from "@/components/title-bar"
import { AppSidebar } from "@/components/app-sidebar"
import { initMainWindow } from "@/lib/app-preferences"
import { AssistantProvider } from "@/lib/assistant/context"
import { AssistantDock } from "@/components/assistant/dock"

/** Window chrome around every page, except the bare pop-out widget window. */
export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()

  // Tray switches + "open clock widget when singl starts" (Settings → App Preferences).
  useEffect(() => {
    let cleanup: (() => void) | undefined
    let cancelled = false
    initMainWindow()
      .then((fn) => (cancelled ? fn() : (cleanup = fn)))
      .catch((e) => console.error("Main window start-up failed", e))
    return () => {
      cancelled = true
      cleanup?.()
    }
  }, [])

  if (pathname === "/widget") return children

  return (
    <AssistantProvider>
    <SidebarProvider
      className="h-full min-h-0 flex-col"
      // The nav groups have no padding, so the stock 3rem icon rail leaves dead
      // space right of the icons when collapsed; 2rem fits the 2rem buttons.
      style={{ "--sidebar-width-icon": "2rem" } as React.CSSProperties}
    >
      <TitleBar />
      <div className="flex min-h-0 flex-1">
        <AppSidebar />
        <SidebarInset className="min-w-0 overflow-hidden md:peer-data-[variant=inset]:peer-data-[state=collapsed]:ml-0 border border-sidebar-border md:peer-data-[variant=inset]:mt-0 md:peer-data-[variant=inset]:shadow-[0_1px_2px_oklch(0_0_0/4%),0_8px_24px_-12px_oklch(0_0_0/12%)] dark:md:peer-data-[variant=inset]:shadow-none">
          <AssistantDock>{children}</AssistantDock>
        </SidebarInset>
      </div>
    </SidebarProvider>
    </AssistantProvider>
  )
}
