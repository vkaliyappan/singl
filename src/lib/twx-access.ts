import { invoke } from "@tauri-apps/api/core"
import { WebviewWindow } from "@tauri-apps/api/webviewWindow"
import { isTauri } from "@/lib/clock-widget"

// Typed wrappers over src-tauri/src/commands/twx_access.rs. Errors reject with
// `{ code, message }`; read them with errorMessage from @/lib/settings.

export type PermissionRule = {
  /** "*" for the whole entity, else the service/property/event overridden. Empty for design-time and visibility. */
  resource: string
  action: string
  principal: string
  /** User, Group or Organization. */
  kind: string
  permitted: boolean
}

export type EntityPermissions = {
  entityType: string
  name: string
  runTime: PermissionRule[]
  designTime: PermissionRule[]
  visibility: PermissionRule[]
}

export type PermissionDecision = {
  allowed: boolean
  user: string
  action: string
  member: string | null
  rule: PermissionRule | null
  /** member, entity or none. */
  level: string
  explanation: string
  userGroups: string[]
  notes: string[]
}

export type MashupInfo = {
  name: string
  description: string
  project: string
  /** Epoch milliseconds or a date string, as the server sent it. */
  lastModified: number | string | null
}

export const RUNTIME_ACTIONS = ["ServiceInvoke", "PropertyRead", "PropertyWrite", "EventInvoke", "EventSubscribe"] as const

export const getEntityPermissions = (env: string, entityType: string, entityName: string) =>
  invoke<EntityPermissions>("twx_entity_permissions", { env, entityType, entityName })

export const checkPermission = (args: {
  env: string
  entityType: string
  entityName: string
  user: string
  action: string
  member?: string
}) => invoke<PermissionDecision>("twx_check_permission", args)

export const listMashups = (env: string, nameMask = "*") => invoke<MashupInfo[]>("twx_list_mashups", { env, nameMask })

/**
 * Where a mashup runs. The appKey is never part of it; the user signs in in
 * the window that opens it.
 */
export const mashupRuntimeUrl = (twxBaseUrl: string, name: string) =>
  `${twxBaseUrl.replace(/\/+$/, "")}/Runtime/index.html#mashup=${encodeURIComponent(name)}`

/** Opens the mashup in its own window. */
export async function previewMashup(twxBaseUrl: string, name: string): Promise<void> {
  const url = mashupRuntimeUrl(twxBaseUrl, name)
  if (!isTauri()) {
    window.open(url, "_blank")
    return
  }
  const label = `mashup-${name.replace(/[^a-zA-Z0-9_-]/g, "_")}`
  const existing = await WebviewWindow.getByLabel(label)
  if (existing) {
    await existing.show()
    await existing.setFocus()
    return
  }
  const win = new WebviewWindow(label, { url, title: `Mashup: ${name}`, width: 1280, height: 800, center: true })
  win.once("tauri://error", (e) => console.error("Mashup preview failed to open", e))
}
