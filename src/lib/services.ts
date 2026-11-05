import { invoke } from "@tauri-apps/api/core"
import type { EntitySearchResult, ServiceDef } from "@/lib/twx/types"

// Typed wrappers over src-tauri/src/commands/services.rs, singl-web's
// /api/twx-services/* routes and its preset server actions.
// Errors reject with `{ code, message }`; read them with errorMessage from @/lib/settings.

export type ServicePreset = {
  id: number
  name: string
  environment: string
  entityType: string
  entityName: string
  serviceName: string
  /** JSON object of input values. */
  inputs: string
  output: string
  outputType: string
  /** Unix seconds. */
  createdAt: number | null
  updatedAt: number | null
}

export type ServicePresetInput = {
  /** Updates this preset when set, otherwise creates one. */
  id?: number | null
  name: string
  environment: string
  entityType: string
  entityName: string
  serviceName: string
  inputs?: string
  output?: string
  outputType?: string
}

/** Entities of `type` (a collection such as "Things") whose names match `nameMask`. */
export const searchEntities = (env: string, type: string, nameMask = "*") =>
  invoke<EntitySearchResult[]>("service_search", { env, entityType: type, nameMask })

/** Every service of one entity, in ThingWorx's order. */
export const getServiceDefinitions = (env: string, collection: string, entityName: string) =>
  invoke<ServiceDef[]>("service_definitions", { env, collection, entityName })

/**
 * Runs a service and resolves with its parsed JSON reply. Pass `requestId`
 * to be able to stop it with {@link cancelServiceExecution}; a stopped call
 * rejects with code "cancelled".
 */
export async function executeService(args: {
  env: string
  collection: string
  entityName: string
  serviceName: string
  inputs: Record<string, unknown>
  requestId?: string
}): Promise<unknown> {
  const text = await invoke<string>("service_execute", args)
  return JSON.parse(text)
}

export const cancelServiceExecution = (requestId: string) => invoke<boolean>("job_cancel", { id: requestId })

export const listServicePresets = () => invoke<ServicePreset[]>("service_presets_list")

/** Creates or updates a preset; resolves with its id. */
export const saveServicePreset = (preset: ServicePresetInput) => invoke<number>("service_preset_save", { preset })

export const deleteServicePreset = (id: number) => invoke<void>("service_preset_delete", { id })
