import { Channel } from "@tauri-apps/api/core"

/** singl-core's JobEvent (src-tauri/crates/singl-core/src/jobs.rs). */
export type JobEvent =
  | { type: "log"; line: string }
  | { type: "progress"; done: number; total: number }
  | { type: "item"; value: unknown }
  | { type: "done"; summary: unknown }
  | { type: "error"; message: string }

/** A Channel for a long-running command that hands each log line to `onLine`. */
export function logChannel(onLine: (line: string) => void) {
  const channel = new Channel<JobEvent>()
  channel.onmessage = (event) => {
    if (event.type === "log") onLine(event.line)
  }
  return channel
}
