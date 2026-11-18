import { invoke } from "@tauri-apps/api/core"

// Typed wrappers over src-tauri/src/commands/twx_events.rs (subscriptions,
// events, and the Scheduler and Timer Things). Entity search is searchEntities
// in @/lib/services. Errors reject with `{ code, message }`; read them with
// errorMessage from @/lib/settings.

export type SubscriptionEvent = {
  eventName: string
  source: string
  sourceType: string
}

export type Subscription = {
  name: string
  /** "<thing>:Thing" for the Thing's own, otherwise the template or shape that declares it. */
  owner: string
  enabled: boolean
  inherited: boolean
  events: SubscriptionEvent[]
}

export type ScheduledThing = {
  name: string
  /** "Scheduler" or "Timer". */
  template: string
  enabled: boolean | null
  /** Quartz-style cron string, Scheduler Things only. */
  schedule: string | null
  /** Milliseconds between runs, Timer Things only. */
  intervalMs: number | null
  /** The event a run fires: "ScheduledEvent" or "Timer". */
  event: string
}

export const getThingSubscriptions = (env: string, thing: string) =>
  invoke<Subscription[]>("twx_thing_subscriptions", { env, thing })

export const setSubscriptionEnabled = (env: string, thing: string, subscription: string, enabled: boolean) =>
  invoke<void>("twx_set_subscription_enabled", { env, thing, subscription, enabled })

/** Fires `event` on `thing` with a JSON object as its input. Resolves with the server's reply text. */
export const fireEvent = (env: string, thing: string, event: string, inputs: Record<string, unknown> = {}) =>
  invoke<string>("twx_fire_event", { env, thing, event, inputs })

export const getScheduledThings = (env: string) => invoke<ScheduledThing[]>("twx_scheduled_things", { env })

export const setThingEnabled = (env: string, thing: string, enabled: boolean) =>
  invoke<void>("twx_set_thing_enabled", { env, thing, enabled })

const DAYS: Record<string, string> = {
  SUN: "Sunday",
  MON: "Monday",
  TUE: "Tuesday",
  WED: "Wednesday",
  THU: "Thursday",
  FRI: "Friday",
  SAT: "Saturday",
}

const pad = (n: number) => String(n).padStart(2, "0")

/** Days-of-week field to words: "MON-FRI" to "on weekdays", "SAT,SUN" to "on weekends". */
function describeDays(dow: string): string | null {
  if (dow === "?" || dow === "*") return null
  const upper = dow.toUpperCase()
  if (upper === "MON-FRI" || upper === "2-6") return "on weekdays"
  if (upper === "SAT,SUN" || upper === "1,7" || upper === "SUN,SAT") return "on weekends"
  const names = upper.split(",").map((d) => DAYS[d] ?? d)
  return `on ${names.join(", ")}`
}

/**
 * A plain-English reading of a Quartz cron string (sec min hour day-of-month
 * month day-of-week). Covers the shapes ThingWorx schedules use; anything
 * else comes back unchanged.
 */
export function describeCron(expr: string): string {
  const f = expr.trim().split(/\s+/)
  if (f.length < 6 || f[0] !== "0") return expr.trim()
  const [, min, hour, dom, , dow] = f

  // Every N minutes: "0 0/5 * * * ?" or "0 */5 * * * ?"
  const minStep = /^(?:\*|0)\/(\d+)$/.exec(min)
  if (minStep && hour === "*") {
    const n = Number(minStep[1])
    return n === 1 ? "Every minute" : `Every ${n} minutes`
  }

  // Every N hours at a fixed minute: "0 0 0/2 * * ?"
  const hourStep = /^(?:\*|0)\/(\d+)$/.exec(hour)
  if (/^\d+$/.test(min) && hourStep) {
    const n = Number(hourStep[1])
    return `Every ${n === 1 ? "hour" : `${n} hours`} at :${pad(Number(min))}`
  }

  if (/^\d+$/.test(min) && hour === "*") return `Every hour at :${pad(Number(min))}`

  if (/^\d+$/.test(min) && /^\d+$/.test(hour)) {
    const time = `${pad(Number(hour))}:${pad(Number(min))}`
    const days = describeDays(dow)
    if (dom === "?" || dom === "*" || /^1\/1$/.test(dom)) {
      return days ? `${days.charAt(0).toUpperCase()}${days.slice(1)} at ${time}` : `Daily at ${time}`
    }
    if (/^\d+$/.test(dom) && dow === "?") return `On day ${dom} of each month at ${time}`
  }

  return expr.trim()
}

/** Milliseconds as "every 5 min", "every 2 h" or "every 30 s". */
export function describeInterval(ms: number): string {
  if (ms % 3_600_000 === 0) return `every ${ms / 3_600_000} h`
  if (ms % 60_000 === 0) return `every ${ms / 60_000} min`
  if (ms % 1000 === 0) return `every ${ms / 1000} s`
  return `every ${ms} ms`
}
