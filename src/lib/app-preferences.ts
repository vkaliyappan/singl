import { disable, enable, isEnabled } from "@tauri-apps/plugin-autostart"
import { invoke } from "@tauri-apps/api/core"
import { listen } from "@tauri-apps/api/event"
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow"
import { isTauri, openClockWidget } from "@/lib/clock-widget"

// ── Launch at sign-in ────────────────────────────────────────────────────────
// The autostart plugin writes singl's exe path into HKCU\…\Run, so the entry
// points at whichever build turned it on: toggle it from the installed app,
// not from `tauri dev`.

export async function getLaunchAtStartup(): Promise<boolean> {
  if (!isTauri()) return false
  return isEnabled()
}

export async function setLaunchAtStartup(on: boolean): Promise<void> {
  await (on ? enable() : disable())
}

// ── Clock widget on launch ───────────────────────────────────────────────────
// Kept apart from the widget's own settings key: the widget window rewrites
// that whole object whenever it saves, which would undo a change made here.

const WIDGET_ON_LAUNCH_KEY = "singl:clock-widget-on-launch"
const WIDGET_LAUNCHED_KEY = "singl:clock-widget-launched"

export function getOpenWidgetOnLaunch(): boolean {
  if (typeof window === "undefined") return false
  return localStorage.getItem(WIDGET_ON_LAUNCH_KEY) === "1"
}

export function setOpenWidgetOnLaunch(on: boolean): void {
  try {
    if (on) localStorage.setItem(WIDGET_ON_LAUNCH_KEY, "1")
    else localStorage.removeItem(WIDGET_ON_LAUNCH_KEY)
  } catch {}
}

// ── Minimize to tray ─────────────────────────────────────────────────────────
// Rust does the hiding (src-tauri/src/tray.rs) so every way of minimizing is
// covered — title-bar button, taskbar click, Win+D. It only needs the switches.

export interface TrayPrefs {
  /** Main singl window. */
  main: boolean
  /** Desktop clock widget. */
  widget: boolean
}

const TRAY_PREFS_KEY = "singl:minimize-to-tray"

export function getTrayPrefs(): TrayPrefs {
  const fallback = { main: false, widget: false }
  if (typeof window === "undefined") return fallback
  try {
    const raw = localStorage.getItem(TRAY_PREFS_KEY)
    if (raw) return { ...fallback, ...JSON.parse(raw) }
  } catch {}
  return fallback
}

export async function setTrayPrefs(prefs: TrayPrefs): Promise<void> {
  try {
    localStorage.setItem(TRAY_PREFS_KEY, JSON.stringify(prefs))
  } catch {}
  await syncTrayPrefs(prefs)
}

function syncTrayPrefs(prefs: TrayPrefs): Promise<void> {
  if (!isTauri()) return Promise.resolve()
  return invoke("tray_prefs_set", { main: prefs.main, widget: prefs.widget })
}

// ── Main window start-up ─────────────────────────────────────────────────────

/**
 * Runs once in the main window: hands the tray switches to Rust, answers the
 * tray's "Show Clock Widget" when no widget window exists yet, and opens the
 * widget if that switch is on. Returns a cleanup for the tray listener.
 */
export async function initMainWindow(): Promise<() => void> {
  if (!isTauri() || getCurrentWebviewWindow().label !== "main") return () => {}
  await syncTrayPrefs(getTrayPrefs())
  const unlisten = await listen("tray://open-clock-widget", () => {
    openClockWidget().catch((e) => console.error("Clock widget failed to open from tray", e))
  })
  await openWidgetIfWanted()
  return unlisten
}

/**
 * Opens the clock widget once per app run, from the main window only.
 * sessionStorage lives as long as the window, so reloads don't reopen it.
 */
export async function openWidgetIfWanted(): Promise<void> {
  if (!isTauri() || !getOpenWidgetOnLaunch()) return
  if (getCurrentWebviewWindow().label !== "main") return
  if (sessionStorage.getItem(WIDGET_LAUNCHED_KEY)) return
  sessionStorage.setItem(WIDGET_LAUNCHED_KEY, "1")
  await openClockWidget()
}
