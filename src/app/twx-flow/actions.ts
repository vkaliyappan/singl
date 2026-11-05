import { invoke } from "@tauri-apps/api/core"

import { errorMessage } from "@/lib/settings"

// Client-side stand-ins for singl-web's twx-flow/actions.ts and
// folder-actions.ts server actions, over src-tauri/src/commands/flows.rs.
// Same names and result shapes, so the hub and editor read the same.
// Anything that changes the hub's data calls flowsChanged(), which the
// /twx-flow page listens for to reload (singl-web's revalidatePath).

export type FlowActionState = {
  success?: boolean
  error?: string
  id?: string
}

export type FolderActionState = FlowActionState

const FLOWS_CHANGED = "singl:flows-changed"

/** Tells the hub its flows or folders changed. */
export function flowsChanged() {
  window.dispatchEvent(new Event(FLOWS_CHANGED))
}

export function onFlowsChanged(listener: () => void) {
  window.addEventListener(FLOWS_CHANGED, listener)
  return () => window.removeEventListener(FLOWS_CHANGED, listener)
}

/** Where a flow opens. Static export cannot pre-render `/twx-flow/[id]`. */
export const flowHref = (id: string) => `/twx-flow/edit?id=${encodeURIComponent(id)}`

async function attempt(work: () => Promise<string | void>, fallback: string): Promise<FlowActionState> {
  try {
    const id = await work()
    flowsChanged()
    return { success: true, id: id || undefined }
  } catch (e) {
    return { error: errorMessage(e) || fallback }
  }
}

/** Creates a flow from the hub's "New flow" form; resolves with its id. */
export async function createFlow(formData: FormData): Promise<FlowActionState> {
  const name = ((formData.get("name") as string) ?? "").trim() || "Untitled flow"
  const environment = ((formData.get("environment") as string) ?? "").trim()
  const folderId = ((formData.get("folderId") as string) ?? "").trim() || null
  return attempt(() => invoke<string>("flow_create", { name, environment, folderId }), "Failed to create flow.")
}

export async function renameFlow(id: string, name: string): Promise<FlowActionState> {
  if (!name.trim()) return { error: "Name is required." }
  return attempt(async () => {
    await invoke("flow_rename", { id, name })
    return id
  }, "Failed to rename flow.")
}

export async function deleteFlow(formData: FormData): Promise<FlowActionState> {
  const id = ((formData.get("id") as string) ?? "").trim()
  if (!id) return {}
  return attempt(() => invoke("flow_delete", { id }), "Failed to delete flow.")
}

export async function duplicateFlow(id: string): Promise<FlowActionState> {
  return attempt(() => invoke<string>("flow_duplicate", { id }), "Failed to duplicate flow.")
}

export async function importFlow(
  name: string,
  environment: string,
  graph: string,
  folderId: string | null = null
): Promise<FlowActionState> {
  return attempt(
    () => invoke<string>("flow_create", { name: name.trim() || "Imported Flow", environment, folderId, graph }),
    "Failed to import flow."
  )
}

/** Full-document write; the editor debounces it. Does not reload the hub. */
export async function saveFlow(id: string, graph: string, environment: string): Promise<FlowActionState> {
  try {
    await invoke("flow_save", { id, graph, environment })
    return { success: true, id }
  } catch (e) {
    return { error: errorMessage(e) || "Failed to save flow." }
  }
}

export async function createFolder(name: string, parentId: string | null): Promise<FolderActionState> {
  if (!name.trim()) return { error: "Folder name is required." }
  return attempt(() => invoke<string>("flow_folder_create", { name, parentId }), "Failed to create folder.")
}

export async function renameFolder(id: string, name: string): Promise<FolderActionState> {
  if (!name.trim()) return { error: "Folder name is required." }
  return attempt(() => invoke("flow_folder_rename", { id, name }), "Failed to rename folder.")
}

export async function moveFolder(id: string, parentId: string | null): Promise<FolderActionState> {
  return attempt(() => invoke("flow_folder_move", { id, parentId }), "Failed to move folder.")
}

export async function deleteFolder(id: string, recursive = false): Promise<FolderActionState> {
  return attempt(() => invoke("flow_folder_delete", { id, recursive }), "Failed to delete folder.")
}

export async function moveFlow(flowId: string, folderId: string | null): Promise<FolderActionState> {
  return attempt(() => invoke("flow_move", { id: flowId, folderId }), "Failed to move flow.")
}
