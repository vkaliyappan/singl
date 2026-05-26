"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import {
  IconHome,
  IconSettings,
  IconGitBranch,
  IconGitCompare,
  IconSun,
  IconMoon,
  IconBoxMultiple,
} from "@tabler/icons-react"
import { useTheme } from "@/components/providers"

import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from "@/components/ui/sidebar"

const navItems = [
  { title: "Home", href: "/", icon: IconHome },
  { title: "Repository", href: "/repo", icon: IconGitBranch },
  { title: "TWX Entities", href: "/twx-entities", icon: IconBoxMultiple },
{ title: "Compare", href: "/compare", icon: IconGitCompare },
  { title: "Settings", href: "/settings", icon: IconSettings },
]

export function AppSidebar() {
  const pathname = usePathname()
  const { resolvedTheme, setTheme } = useTheme()

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <div className="flex items-center gap-3 px-2 py-2 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:gap-0 group-data-[collapsible=icon]:px-0">
          <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-violet-500 to-indigo-600 shadow-sm">
            <span className="text-sm font-bold text-white tracking-tight">S</span>
          </div>
          <div className="flex flex-col gap-0 group-data-[collapsible=icon]:hidden">
            <span className="font-semibold text-sm leading-none tracking-tight">Singl</span>
            <span className="text-[11px] text-muted-foreground leading-none mt-1">Workspace</span>
          </div>
        </div>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Navigation</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {navItems.map((item) => (
                <SidebarMenuItem key={item.href}>
                  <SidebarMenuButton
                    render={<Link href={item.href} />}
                    isActive={pathname === item.href}
                    tooltip={item.title}
                  >
                    <item.icon />
                    <span>{item.title}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}
              tooltip={resolvedTheme === "dark" ? "Switch to light" : "Switch to dark"}
            >
              {resolvedTheme === "dark" ? <IconSun /> : <IconMoon />}
              <span>{resolvedTheme === "dark" ? "Light mode" : "Dark mode"}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  )
}
