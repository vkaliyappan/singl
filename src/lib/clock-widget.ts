import { WebviewWindow } from "@tauri-apps/api/webviewWindow"

export const WIDGET_LABEL = "clock-widget"
export const WIDGET_STORAGE_KEY = "singl:clock-widget"

export function isTauri() {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window
}

// ── Themes ───────────────────────────────────────────────────────────────────

export type WidgetMode = "light" | "dark"

export interface WidgetTheme {
  mode: WidgetMode
  /** Card gradient, top-left → bottom-right. */
  stops: string[]
}

export const WIDGET_THEMES: Record<string, WidgetTheme> = {
  Pearl: { mode: "light", stops: ["#FFFFFF", "#F3F4F7", "#E7E9EF"] },
  Mist: { mode: "light", stops: ["#F2F6FF", "#E3ECFB", "#D6E2F5"] },
  Blush: { mode: "light", stops: ["#FFF4EE", "#FBE4EA", "#EEDDF6"] },
  Sage: { mode: "light", stops: ["#F4F7F1", "#E5EDE0", "#D6E3D0"] },
  Sand: { mode: "light", stops: ["#FBF7F1", "#F1E8DA", "#E6D8C3"] },
  Lilac: { mode: "light", stops: ["#F7F4FF", "#ECE6FC", "#DDD5F5"] },
  Graphite: { mode: "dark", stops: ["#34363C", "#26282D", "#1C1D21"] },
  Midnight: { mode: "dark", stops: ["#26304A", "#1B2236", "#131826"] },
  Aurora: { mode: "dark", stops: ["#1D2B36", "#1C3A40", "#22324A"] },
  Plum: { mode: "dark", stops: ["#382C44", "#2A2133", "#1E1825"] },
  Espresso: { mode: "dark", stops: ["#3A302A", "#2B2420", "#1F1A17"] },
  Forest: { mode: "dark", stops: ["#26392F", "#1D2C25", "#16201B"] },
}

/** "Auto" follows singl's own light/dark theme. */
export const AUTO_THEME = "Auto"

export function resolveWidgetTheme(name: string, appDark: boolean): WidgetTheme {
  if (name !== AUTO_THEME && WIDGET_THEMES[name]) return WIDGET_THEMES[name]
  return appDark ? WIDGET_THEMES.Graphite : WIDGET_THEMES.Pearl
}

// ── Settings ─────────────────────────────────────────────────────────────────

export interface WidgetSettings {
  theme: string
  opacity: number
  scale: number
  showDetails: boolean
  pinned: boolean
  locked: boolean
  /** Last logical position of the widget window. */
  x?: number
  y?: number
}

export const DEFAULT_WIDGET_SETTINGS: WidgetSettings = {
  theme: AUTO_THEME,
  opacity: 0.95,
  scale: 1,
  showDetails: true,
  pinned: true,
  locked: false,
}

export function loadWidgetSettings(): WidgetSettings {
  if (typeof window === "undefined") return DEFAULT_WIDGET_SETTINGS
  try {
    const raw = localStorage.getItem(WIDGET_STORAGE_KEY)
    if (raw) return { ...DEFAULT_WIDGET_SETTINGS, ...JSON.parse(raw) }
  } catch {}
  return DEFAULT_WIDGET_SETTINGS
}

export function saveWidgetSettings(settings: WidgetSettings): void {
  try {
    localStorage.setItem(WIDGET_STORAGE_KEY, JSON.stringify(settings))
  } catch {}
}

// ── Window ───────────────────────────────────────────────────────────────────

/** Opens the desktop clock widget, or brings it back if it is already open. */
export async function openClockWidget(): Promise<void> {
  if (!isTauri()) {
    // Plain browser (next dev without Tauri): a popup is the closest thing.
    window.open("/widget", "singl-clock-widget", "popup,width=380,height=620")
    return
  }

  const existing = await WebviewWindow.getByLabel(WIDGET_LABEL)
  if (existing) {
    await existing.unminimize()
    await existing.show()
    await existing.setFocus()
    return
  }

  const settings = loadWidgetSettings()
  const hasPosition = settings.x !== undefined && settings.y !== undefined
  const win = new WebviewWindow(WIDGET_LABEL, {
    url: "/widget",
    title: "World Clock",
    width: 360,
    height: 560,
    ...(hasPosition ? { x: settings.x, y: settings.y } : { center: true }),
    decorations: false,
    transparent: true,
    shadow: false,
    resizable: false,
    maximizable: false,
    alwaysOnTop: settings.pinned,
    // Shown by the widget once it has sized itself to its content
    visible: false,
  })
  win.once("tauri://error", (e) => console.error("Clock widget failed to open", e))
}

/** Brings the main singl window to the front. */
export async function focusMainWindow(): Promise<void> {
  if (!isTauri()) {
    window.opener?.focus()
    return
  }
  const main = await WebviewWindow.getByLabel("main")
  if (!main) return
  await main.unminimize()
  await main.show()
  await main.setFocus()
}
