"use client"

import { useEffect, useState } from "react"
import { usePathname } from "next/navigation"
import {
  IconSun,
  IconMoon,
  IconChevronRight,
  IconHome,
  IconSparkles,
} from "@tabler/icons-react"
import { getCurrentWindow } from "@tauri-apps/api/window"
import { useTheme } from "@/components/providers"
import { BrandMark, BrandWordmark } from "@/components/brand"
import { findNavItem } from "@/components/nav-config"
import { cn } from "@/lib/utils"
import { toggleAssistant, useAssistantOpen } from "@/components/assistant/dock"

function isTauri() {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window
}

function useMaximized() {
  const [maximized, setMaximized] = useState(false)

  useEffect(() => {
    if (!isTauri()) return
    const win = getCurrentWindow()
    let unlisten: (() => void) | undefined
    const sync = () => win.isMaximized().then(setMaximized).catch(() => {})
    sync()
    win.onResized(sync).then((fn) => { unlisten = fn })
    return () => unlisten?.()
  }, [])

  return maximized
}

function ChromeButton({ className, ...props }: React.ComponentProps<"button">) {
  return (
    <button
      type="button"
      className={cn(
        "flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors",
        "hover:bg-sidebar-accent hover:text-foreground focus-visible:outline-2 [&_svg]:size-4",
        className
      )}
      {...props}
    />
  )
}

// 10px glyphs drawn to match native Windows caption buttons
const glyph = { width: 10, height: 10, viewBox: "0 0 10 10", fill: "none", stroke: "currentColor", strokeWidth: 1 }

const MinimizeGlyph = () => <svg {...glyph}><path d="M0 5h10" /></svg>
const MaximizeGlyph = () => <svg {...glyph}><rect x="0.5" y="0.5" width="9" height="9" rx="1" /></svg>
const RestoreGlyph = () => (
  <svg {...glyph}>
    <rect x="0.5" y="2.5" width="7" height="7" rx="1" />
    <path d="M2.5 2.5V1.5a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1h-1" />
  </svg>
)
const CloseGlyph = () => <svg {...glyph}><path d="M0.5 0.5l9 9M9.5 0.5l-9 9" /></svg>

function WindowControls() {
  const maximized = useMaximized()
  const run = (fn: (w: ReturnType<typeof getCurrentWindow>) => Promise<void>) => {
    if (isTauri()) fn(getCurrentWindow()).catch(() => {})
  }

  const base =
    "flex h-full w-11.5 items-center justify-center text-foreground/75 transition-colors duration-100 hover:text-foreground"

  return (
    <div className="flex h-full items-stretch">
      <button type="button" aria-label="Minimize" className={cn(base, "hover:bg-foreground/8")} onClick={() => run((w) => w.minimize())}>
        <MinimizeGlyph />
      </button>
      <button type="button" aria-label={maximized ? "Restore" : "Maximize"} className={cn(base, "hover:bg-foreground/8")} onClick={() => run((w) => w.toggleMaximize())}>
        {maximized ? <RestoreGlyph /> : <MaximizeGlyph />}
      </button>
      <button type="button" aria-label="Close" className={cn(base, "hover:bg-[#e81123] hover:text-white")} onClick={() => run((w) => w.close())}>
        <CloseGlyph />
      </button>
    </div>
  )
}

export function TitleBar() {
  const pathname = usePathname()
  const { resolvedTheme, setTheme } = useTheme()
  const assistantOpen = useAssistantOpen()
  const match = findNavItem(pathname)
  const sectionTitle = match?.section.title ?? "Workspace"
  const pageTitle = match?.item.title ?? "singl"
  const PageIcon = match?.item.icon ?? IconHome

  return (
    <header
      data-tauri-drag-region
      className="relative z-20 flex h-10 shrink-0 select-none items-center bg-chrome pl-3 text-sm"
    >
      <div data-tauri-drag-region className="flex items-center gap-2 pr-1">
        <BrandMark className="size-6 rounded-[7px] shadow-sm shadow-indigo-500/30 [&>span:first-child]:text-[11px] [&>span:last-child]:hidden" />
        <BrandWordmark className="text-[14px] text-foreground" />
      </div>

      <div className="mr-1.5 ml-3 h-4 w-px bg-sidebar-border" />

      <nav
        data-tauri-drag-region
        aria-label="Breadcrumb"
        className="flex min-w-0 items-center gap-1 text-[12.5px] text-muted-foreground"
      >
        <span data-tauri-drag-region className="px-1">{sectionTitle}</span>
        <IconChevronRight data-tauri-drag-region className="size-3.5 shrink-0 opacity-40" />
        <span
          data-tauri-drag-region
          className="flex min-w-0 items-center gap-1.5 rounded-md bg-background/80 py-0.5 pr-2 pl-1.5 font-medium text-foreground ring-1 ring-sidebar-border dark:bg-sidebar-accent"
        >
          <PageIcon className="size-3.5 shrink-0 text-primary dark:text-sidebar-primary" />
          <span data-tauri-drag-region className="truncate">{pageTitle}</span>
        </span>
      </nav>

      <div data-tauri-drag-region className="h-full flex-1" />

      <div className="flex items-center gap-0.5 pr-2">
        <ChromeButton
          aria-label="Toggle assistant"
          aria-pressed={assistantOpen}
          title="Assistant (Ctrl+J)"
          className={cn(assistantOpen && "bg-sidebar-accent text-primary")}
          onClick={toggleAssistant}
        >
          <IconSparkles />
        </ChromeButton>
        <ChromeButton
          aria-label={resolvedTheme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
          title={resolvedTheme === "dark" ? "Light theme" : "Dark theme"}
          onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}
        >
          {resolvedTheme === "dark" ? <IconSun /> : <IconMoon />}
        </ChromeButton>
      </div>

      <WindowControls />
    </header>
  )
}
