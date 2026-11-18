import {
  IconHome,
  IconGitBranch,
  IconRocket,
  IconSettings,
  IconBoxMultiple,
  IconGitCompare,
  IconBolt,
  IconTable,
  IconArrowsExchange,
  IconSitemap,
  IconSparkles,
  IconFileText,
  IconServer,
  IconUpload,
  IconShieldLock,
  IconBinaryTree,
  IconClockPlay,
} from "@tabler/icons-react"

export interface NavItem {
  title: string
  href: string
  icon: React.ComponentType<{ className?: string }>
  badge?: string
}

export interface NavSection {
  title: string
  items: NavItem[]
}

/** Single source for sidebar groups and title-bar breadcrumbs. */
export const navSections: NavSection[] = [
  {
    title: "Workspace",
    items: [
      { title: "Home", href: "/", icon: IconHome },
      { title: "AI Assistant", href: "/assistant", icon: IconSparkles },
      { title: "TWX Repository", href: "/repo", icon: IconGitBranch },
      { title: "Windchill Repository", href: "/repo2", icon: IconGitBranch },
    ],
  },
  {
    title: "ThingWorx",
    items: [
      { title: "Entities", href: "/twx-entities", icon: IconBoxMultiple },
      { title: "Services", href: "/twx-services", icon: IconBolt },
      { title: "Flows", href: "/twx-flow", icon: IconSitemap },
      { title: "Migrate", href: "/twx-migrate", icon: IconArrowsExchange },
      { title: "Logs", href: "/twx-logs", icon: IconFileText },
      { title: "Server", href: "/twx-server", icon: IconServer },
      { title: "Import", href: "/twx-import", icon: IconUpload },
      { title: "Access & Mashups", href: "/twx-access", icon: IconShieldLock },
      { title: "Dependencies", href: "/twx-deps", icon: IconBinaryTree },
    ],
  },
  {
    title: "Tools",
    items: [
      { title: "JSON to Table", href: "/json-table", icon: IconTable },
      { title: "Compare", href: "/compare", icon: IconGitCompare },
      { title: "Deploy", href: "/deploy", icon: IconRocket },
      { title: "Automation", href: "/automation", icon: IconClockPlay },
    ],
  },
  {
    title: "System",
    items: [{ title: "Settings", href: "/settings", icon: IconSettings }],
  },
]

export function isNavActive(pathname: string, href: string) {
  if (href === "/") return pathname === "/"
  return pathname === href || pathname.startsWith(`${href}/`)
}

export function findNavItem(pathname: string) {
  for (const section of navSections) {
    const item = section.items.find((i) => isNavActive(pathname, i.href))
    if (item) return { section, item }
  }
  return undefined
}
