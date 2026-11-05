import { invoke } from "@tauri-apps/api/core"

// Typed wrappers over the Teams Presence Keeper commands in
// src-tauri/src/commands/presence.rs. Errors reject with `{ code, message }`;
// read them with errorMessage from @/lib/settings.

export type KeeperStatus = {
  supported: boolean
  running: boolean
  pid: number | null
  startedAt: string | null
  lastTickAt: string | null
  intervalSeconds: number
}

export const presenceStatus = () => invoke<KeeperStatus>("presence_status")

/** `intervalSeconds` is clamped to 15–240; omitted means 60. */
export const presenceStart = (intervalSeconds?: number) =>
  invoke<KeeperStatus>("presence_start", { intervalSeconds })

export const presenceStop = () => invoke<KeeperStatus>("presence_stop")
