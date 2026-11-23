"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { IconLayoutSidebarLeftCollapse, IconLayoutSidebarLeftExpand } from "@tabler/icons-react"
import { cn } from "@/lib/utils"
import { navSections, isNavActive } from "@/components/nav-config"
import { Spinner } from "@/components/ui/spinner"
import { useJobsRunning } from "@/lib/background-jobs"
import { useEffect, useState } from "react"
import { getVersion } from "@tauri-apps/api/app"

/** Installed app version from tauri.conf.json; blank until Tauri answers. */
function useAppVersion() {
  const [version, setVersion] = useState("")
  useEffect(() => {
    getVersion().then(setVersion).catch(() => {})
  }, [])
  return version
}

/** Background-job key prefix of each page that runs jobs (see @/lib/background-jobs). */
const JOB_PREFIX: Record<string, string> = {
  "/twx-entities": "entities:",
  "/deploy": "deploy:",
  "/repo": "repo:",
  "/repo2": "repo2:",
  "/twx-flow": "flow:",
}

/** Spins while a job of the page runs, so it shows from any page. */
function JobSpinner({ prefix }: { prefix: string }) {
  if (!useJobsRunning(prefix)) return null
  return <Spinner aria-label="Running in the background" className="ml-auto size-3.5 text-primary" />
}

import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  useSidebar,
} from "@/components/ui/sidebar"

export function AppSidebar() {
  const pathname = usePathname()
  const { state, toggleSidebar } = useSidebar()
  const collapsed = state === "collapsed"
  const version = useAppVersion()
  const ToggleIcon = collapsed ? IconLayoutSidebarLeftExpand : IconLayoutSidebarLeftCollapse

  return (
    <Sidebar
      variant="inset"
      collapsible="icon"
      // Sits under the custom title bar instead of spanning the full window height
      className="top-10 h-[calc(100svh-2.5rem)] pt-0 select-none"
    >
      <SidebarHeader className="relative z-10 gap-2 p-0 pt-1 items-end group-data-[collapsible=icon]:items-start">
        <button
          type="button"
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          title={`${collapsed ? "Expand" : "Collapse"} sidebar (Ctrl+B)`}
          onClick={toggleSidebar}
          className="flex size-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring outline-none"
        >
          <ToggleIcon className="size-4 stroke-[1.75]" />
        </button>
        <span aria-hidden className="hidden h-px w-5 bg-sidebar-border group-data-[collapsible=icon]:mx-1.5 group-data-[collapsible=icon]:block" />
      </SidebarHeader>

      {/* Expanded: first group label shares the toggle row. Collapsed: group labels shrink via -mt-8, so pt-4 keeps the first item inside the scroll box */}
      <SidebarContent className="-mt-7 gap-3 pt-0 group-data-[collapsible=icon]:mt-0 group-data-[collapsible=icon]:pt-4">
        {navSections.map((section) => (
          <SidebarGroup key={section.title} className="p-0">
            <SidebarGroupLabel className="h-6 px-2.5 text-[10.5px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">
              {section.title}
            </SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu className="gap-px">
                {section.items.map((item) => {
                  const active = isNavActive(pathname, item.href)
                  const Icon = item.icon
                  return (
                    <SidebarMenuItem key={item.href}>
                      <SidebarMenuButton
                        render={<Link href={item.href} />}
                        isActive={active}
                        tooltip={item.title}
                        className={cn(
                          "h-8 gap-2.5 rounded-lg px-2.5 text-[13px] font-normal transition-[background-color,color] duration-150",
                          "text-sidebar-foreground/85 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
                          "data-active:bg-primary/10 data-active:font-medium data-active:text-primary hover:data-active:bg-primary/12",
                          "dark:data-active:bg-sidebar-primary/15 dark:data-active:text-sidebar-accent-foreground"
                        )}
                      >
                        <Icon
                          className={cn(
                            "size-4 stroke-[1.75] text-muted-foreground transition-colors group-hover/menu-button:text-foreground",
                            active && "stroke-2 text-primary group-hover/menu-button:text-primary dark:text-sidebar-primary"
                          )}
                        />
                        <span className="truncate">{item.title}</span>
                        {JOB_PREFIX[item.href] && <JobSpinner prefix={JOB_PREFIX[item.href]} />}
                        {item.badge && (
                          <span className="ml-auto rounded-md bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                            {item.badge}
                          </span>
                        )}
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  )
                })}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ))}
      </SidebarContent>

      <SidebarFooter className="px-0 pb-2 group-data-[collapsible=icon]:hidden">
        <div className="flex items-center gap-2.5 rounded-lg bg-background/60 px-2.5 py-2 ring-1 ring-sidebar-border dark:bg-sidebar-accent">
          <span className="relative flex size-2">
            <span className="absolute inline-flex size-full animate-ping rounded-full bg-success/50 [animation-duration:2.5s]" />
            <span className="relative inline-flex size-2 rounded-full bg-success" />
          </span>
          <div className="flex min-w-0 flex-col leading-tight">
            <span className="text-[12px] font-medium text-foreground/90">Local workspace</span>
            <span className="text-[10.5px] text-muted-foreground">{version ? `v${version}` : "…"}</span>
          </div>
        </div>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  )
}
