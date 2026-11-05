"use client"

import { useCallback, useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react"
import {
  IconAdjustmentsHorizontal,
  IconChevronLeft,
  IconChevronRight,
  IconClockEdit,
  IconMinus,
  IconPin,
  IconPinFilled,
  IconWorld,
  IconX,
} from "@tabler/icons-react"
import { getCurrentWindow } from "@tauri-apps/api/window"
import { LogicalSize } from "@tauri-apps/api/dpi"
import { cn } from "@/lib/utils"
import {
  AUTO_THEME,
  DEFAULT_WIDGET_SETTINGS,
  WIDGET_STORAGE_KEY,
  WIDGET_THEMES,
  focusMainWindow,
  isTauri,
  loadWidgetSettings,
  resolveWidgetTheme,
  saveWidgetSettings,
  type WidgetMode,
  type WidgetSettings,
} from "@/lib/clock-widget"
import {
  STORAGE_KEY,
  cityFromZone,
  formatDate,
  formatTimeParts,
  getDayDiff,
  getLocalZone,
  getUtcOffset,
  getZoneMinutesOffset,
  loadConfig,
  saveConfig,
  solarIcon,
  type ClockConfig,
} from "@/components/world-clock"

// ── Look ─────────────────────────────────────────────────────────────────────

const PALETTES: Record<WidgetMode, Record<string, string>> = {
  light: {
    "--w-fg": "#1d1d1f",
    "--w-sub": "#6e6e73",
    "--w-vibe": "#3a3a3c",
    "--w-row": "rgba(255,255,255,0.62)",
    "--w-row-border": "rgba(255,255,255,0.9)",
    "--w-card-border": "rgba(255,255,255,0.95)",
    "--w-track": "rgba(0,0,0,0.07)",
    "--w-ctrl": "rgba(0,0,0,0.06)",
    "--w-ctrl-on": "#ffffff",
    "--w-hover": "rgba(128,128,128,0.16)",
    "--w-day-bg": "#fff1d6",
    "--w-day-fg": "#d98a00",
    "--w-dusk-bg": "#ffe4e6",
    "--w-dusk-fg": "#e11d48",
    "--w-night-bg": "#e6e8ff",
    "--w-night-fg": "#5b5fc7",
  },
  dark: {
    "--w-fg": "#f5f5f7",
    "--w-sub": "#a1a1a6",
    "--w-vibe": "#d1d1d6",
    "--w-row": "rgba(255,255,255,0.06)",
    "--w-row-border": "rgba(255,255,255,0.08)",
    "--w-card-border": "rgba(255,255,255,0.1)",
    "--w-track": "rgba(255,255,255,0.1)",
    "--w-ctrl": "rgba(255,255,255,0.08)",
    "--w-ctrl-on": "rgba(255,255,255,0.2)",
    "--w-hover": "rgba(255,255,255,0.1)",
    "--w-day-bg": "#4a3b1e",
    "--w-day-fg": "#fbc54a",
    "--w-dusk-bg": "#4a1f2a",
    "--w-dusk-fg": "#fda4af",
    "--w-night-bg": "#2e3160",
    "--w-night-fg": "#a5b4fc",
  },
}

/** Day-progress bar colour per city, cycled. */
const ACCENTS = ["#F5A524", "#17C27F", "#3B82F6", "#EC4899", "#8B5CF6", "#F97316"]

const SIZES = [
  { label: "S", value: 0.85 },
  { label: "M", value: 1 },
  { label: "L", value: 1.15 },
  { label: "XL", value: 1.3 },
]

function hexToRgba(hex: string, alpha: number): string {
  const n = parseInt(hex.slice(1), 16)
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`
}

function gradient(stops: string[], alpha = 1): string {
  return `linear-gradient(135deg, ${stops.map((s) => hexToRgba(s, alpha)).join(", ")})`
}

/** A playful status line for the local hour in that city. */
function vibe(hour: number): string {
  if (hour < 5) return "Zzz… snoozing"
  if (hour < 7) return "Early bird mode"
  if (hour < 9) return "Coffee o'clock"
  if (hour < 12) return "Crushing it"
  if (hour < 14) return "Lunch munch time"
  if (hour < 17) return "Hustle hours"
  if (hour < 19) return "Golden hour"
  if (hour < 22) return "Couch & chill"
  return "Winding down"
}

function badgeColors(hour: number): CSSProperties {
  const tone = hour >= 5 && hour < 17 ? "day" : hour >= 17 && hour < 20 ? "dusk" : "night"
  return { background: `var(--w-${tone}-bg)`, color: `var(--w-${tone}-fg)` }
}

function appIsDark(): boolean {
  try {
    const t = localStorage.getItem("theme") || "system"
    return t === "dark" || (t === "system" && matchMedia("(prefers-color-scheme: dark)").matches)
  } catch {
    return false
  }
}

// ── Time travel ──────────────────────────────────────────────────────────────

/** Snap for the slider and for dragging a day bar. */
const TRAVEL_STEP = 15
/** How far either way the slider reaches. */
const TRAVEL_RANGE = 24 * 60

function clampShift(minutes: number): number {
  const m = Math.max(-TRAVEL_RANGE, Math.min(TRAVEL_RANGE, minutes))
  // Within one step of now counts as live.
  return Math.abs(m) < TRAVEL_STEP ? 0 : m
}

function formatShift(minutes: number): string {
  const abs = Math.abs(minutes)
  const h = Math.floor(abs / 60)
  const m = abs % 60
  const text = h && m ? `${h}h ${m}m` : h ? `${h}h` : `${m}m`
  return `${minutes > 0 ? "+" : "−"}${text}`
}

/** "Today" / "Tomorrow" / "Yesterday" / a date, for `shown` against `now`, in local time. */
function localDayLabel(shown: Date, now: Date): string {
  const day = (d: Date) => Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86_400_000
  const diff = day(shown) - day(now)
  if (diff === 0) return "Today"
  if (diff === 1) return "Tomorrow"
  if (diff === -1) return "Yesterday"
  return shown.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" })
}

function TimeTravelBar({
  offset,
  shown,
  now,
  hour12,
  onChange,
}: {
  offset: number
  shown: Date
  now: Date
  hour12: boolean
  onChange: (minutes: number) => void
}) {
  const localTime = shown.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12 })
  return (
    <div data-no-drag className="mt-1 rounded-2xl border border-[var(--w-row-border)] bg-[var(--w-row)] px-3 py-2">
      <div className="flex items-center justify-between gap-2 text-[11.5px]">
        <span className="truncate">
          <span className="text-[var(--w-sub)]">Your time · </span>
          <span className="font-semibold">
            {localDayLabel(shown, now)}, {localTime}
          </span>
          {offset !== 0 && <span className="ml-1 text-[var(--w-sub)] tabular-nums">({formatShift(offset)})</span>}
        </span>
        <button
          type="button"
          onClick={() => onChange(0)}
          disabled={offset === 0}
          className="shrink-0 rounded-[7px] bg-[var(--w-ctrl)] px-2 py-0.5 text-[11px] font-semibold disabled:opacity-40"
        >
          Now
        </button>
      </div>
      <div className="mt-1.5 flex items-center gap-1">
        <HeaderButton title="1 hour earlier" aria-label="1 hour earlier" onClick={() => onChange(clampShift(offset - 60))}>
          <IconChevronLeft size={14} />
        </HeaderButton>
        <input
          type="range"
          min={-TRAVEL_RANGE}
          max={TRAVEL_RANGE}
          step={TRAVEL_STEP}
          value={offset}
          onChange={(e) => onChange(clampShift(Number(e.target.value)))}
          aria-label="Shift the shown time"
          aria-valuetext={offset === 0 ? "Now" : formatShift(offset)}
          className="min-w-0 flex-1 accent-[var(--w-fg)]"
        />
        <HeaderButton title="1 hour later" aria-label="1 hour later" onClick={() => onChange(clampShift(offset + 60))}>
          <IconChevronRight size={14} />
        </HeaderButton>
      </div>
      <div className="text-[10px] text-[var(--w-sub)]">Or drag a city&apos;s day bar to set its time.</div>
    </div>
  )
}

// ── Small controls ───────────────────────────────────────────────────────────

function HeaderButton({ className, ...props }: React.ComponentProps<"button">) {
  return (
    <button
      type="button"
      className={cn(
        "flex size-[26px] items-center justify-center rounded-full opacity-60 transition hover:bg-[var(--w-hover)] hover:opacity-100",
        className,
      )}
      {...props}
    />
  )
}

function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <label className="flex min-h-[30px] items-center justify-between gap-3">
      <span>{label}</span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={cn(
          "relative h-5 w-[34px] shrink-0 rounded-full transition-colors",
          checked ? "bg-[#34c759]" : "bg-[var(--w-ctrl)]",
        )}
      >
        <span
          className={cn(
            "absolute top-0.5 size-4 rounded-full bg-white shadow-sm transition-[left]",
            checked ? "left-4" : "left-0.5",
          )}
        />
      </button>
    </label>
  )
}

function Segmented<T extends string | number | boolean>({
  options,
  value,
  onChange,
}: {
  options: { label: string; value: T }[]
  value: T
  onChange: (v: T) => void
}) {
  return (
    <div className="inline-flex rounded-[9px] bg-[var(--w-ctrl)] p-0.5">
      {options.map((o) => (
        <button
          key={o.label}
          type="button"
          onClick={() => onChange(o.value)}
          className={cn(
            "rounded-[7px] px-2.5 py-0.5 text-xs",
            o.value === value && "bg-[var(--w-ctrl-on)] font-semibold shadow-sm",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mt-2 rounded-2xl border border-[var(--w-row-border)] bg-[var(--w-row)] px-3 py-2.5">
      <div className="mb-1.5 text-[11px] font-semibold tracking-wide text-[var(--w-sub)]">{title}</div>
      {children}
    </div>
  )
}

// ── Widget ───────────────────────────────────────────────────────────────────

/** The pop-out desktop widget: shared clocks, own look, native window controls. */

export function ClockWidget() {
  const [mounted, setMounted] = useState(false)
  const [clocks, setClocks] = useState<ClockConfig>({ clocks: [], hour12: false, showSeconds: true })
  const [settings, setSettings] = useState<WidgetSettings>(DEFAULT_WIDGET_SETTINGS)
  const [appDark, setAppDark] = useState(false)
  const [now, setNow] = useState(() => new Date())
  const [view, setView] = useState<"clocks" | "settings">("clocks")
  // Time travel: minutes the shown time is moved from now (0 = live).
  const [offset, setOffset] = useState(0)
  const [travelOpen, setTravelOpen] = useState(false)
  const shownDate = offset === 0 ? now : new Date(now.getTime() + offset * 60_000)
  const shellRef = useRef<HTMLDivElement>(null)
  const shown = useRef(false)

  const localZone = getLocalZone()
  const theme = resolveWidgetTheme(settings.theme, appDark)

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setClocks(loadConfig())
    setSettings(loadWidgetSettings())
    setAppDark(appIsDark())
    setMounted(true)
    document.documentElement.classList.add("widget-window")

    // Keep in step with the World clock card in the main window
    const onStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY) setClocks(loadConfig())
      if (e.key === WIDGET_STORAGE_KEY) setSettings(loadWidgetSettings())
      if (e.key === "theme") setAppDark(appIsDark())
    }
    window.addEventListener("storage", onStorage)
    return () => window.removeEventListener("storage", onStorage)
  }, [])

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(id)
  }, [])

  const updateSettings = useCallback((patch: Partial<WidgetSettings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch }
      saveWidgetSettings(next)
      return next
    })
  }, [])

  const updateClocks = useCallback((patch: Partial<ClockConfig>) => {
    setClocks((prev) => {
      const next = { ...prev, ...patch }
      saveConfig(next)
      return next
    })
  }, [])

  // Pin on top of other apps, or behave like a normal window
  useEffect(() => {
    if (mounted && isTauri()) getCurrentWindow().setAlwaysOnTop(settings.pinned).catch(() => {})
  }, [mounted, settings.pinned])

  // Size the native window to the card, then show it (it is created hidden)
  useEffect(() => {
    const shell = shellRef.current
    if (!mounted || !shell || !isTauri()) return
    const win = getCurrentWindow()
    const observer = new ResizeObserver(async () => {
      const { width, height } = shell.getBoundingClientRect()
      await win.setSize(new LogicalSize(Math.ceil(width), Math.ceil(height))).catch(() => {})
      if (!shown.current) {
        shown.current = true
        await win.show().catch(() => {})
      }
    })
    observer.observe(shell)
    return () => observer.disconnect()
  }, [mounted])

  // Remember where the widget was left
  useEffect(() => {
    if (!isTauri()) return
    const win = getCurrentWindow()
    let timer: ReturnType<typeof setTimeout> | undefined
    let unlisten: (() => void) | undefined
    win
      .onMoved(({ payload }) => {
        clearTimeout(timer)
        timer = setTimeout(async () => {
          const pos = payload.toLogical(await win.scaleFactor())
          updateSettings({ x: Math.round(pos.x), y: Math.round(pos.y) })
        }, 300)
      })
      .then((fn) => {
        unlisten = fn
      })
    return () => {
      clearTimeout(timer)
      unlisten?.()
    }
  }, [updateSettings])

  function onCardPointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    if (e.button !== 0 || settings.locked || !isTauri()) return
    if ((e.target as HTMLElement).closest("button, input, label, a, [data-no-drag]")) return
    getCurrentWindow().startDragging().catch(() => {})
  }

  const windowAction = (fn: (w: ReturnType<typeof getCurrentWindow>) => Promise<void>, fallback?: () => void) => {
    if (isTauri()) fn(getCurrentWindow()).catch(() => {})
    else fallback?.()
  }

  const vars = {
    ...PALETTES[theme.mode],
    color: "var(--w-fg)",
  } as CSSProperties

  return (
    <div ref={shellRef} className="inline-block px-5 pt-4 pb-7" style={vars}>
      <div
        onPointerDown={onCardPointerDown}
        onContextMenu={(e) => {
          e.preventDefault()
          setView("settings")
        }}
        className="w-[316px] rounded-[24px] border border-[var(--w-card-border)] px-3 pt-2.5 pb-3 shadow-[0_12px_32px_rgba(0,0,0,0.16),0_1px_3px_rgba(0,0,0,0.08)] transition-[background] duration-300"
        style={{ background: gradient(theme.stops, settings.opacity), zoom: settings.scale }}
      >
        {/* Header */}
        <div className="flex items-center gap-0.5 pt-0.5 pr-0.5 pb-1 pl-1">
          <IconWorld size={14} className="mr-2 opacity-70" />
          <span className="text-[13px] font-semibold opacity-85">
            {view === "settings" ? "Tweak the vibes" : "Around the world"}
          </span>
          <span className="flex-1" />
          {view === "clocks" && (
            <HeaderButton
              title={travelOpen ? "Back to live time" : "Check a different time"}
              aria-label="Check a different time"
              aria-pressed={travelOpen}
              onClick={() => {
                // Closing goes back to live time.
                if (travelOpen) setOffset(0)
                setTravelOpen(!travelOpen)
              }}
              className={cn(travelOpen && "bg-[var(--w-hover)] opacity-100")}
            >
              <IconClockEdit size={14} />
            </HeaderButton>
          )}
          <HeaderButton
            title="Settings"
            aria-label="Settings"
            onClick={() => setView((v) => (v === "settings" ? "clocks" : "settings"))}
            className={cn(view === "settings" && "bg-[var(--w-hover)] opacity-100")}
          >
            <IconAdjustmentsHorizontal size={14} />
          </HeaderButton>
          <HeaderButton
            title={settings.pinned ? "Unpin (stop staying on top)" : "Pin on top of other apps"}
            aria-label={settings.pinned ? "Unpin" : "Pin on top"}
            aria-pressed={settings.pinned}
            onClick={() => updateSettings({ pinned: !settings.pinned })}
          >
            {settings.pinned ? <IconPinFilled size={14} /> : <IconPin size={14} />}
          </HeaderButton>
          <HeaderButton title="Minimize" aria-label="Minimize" onClick={() => windowAction((w) => w.minimize())}>
            <IconMinus size={14} />
          </HeaderButton>
          <HeaderButton
            title="Close widget"
            aria-label="Close widget"
            onClick={() => windowAction((w) => w.close(), () => window.close())}
          >
            <IconX size={14} />
          </HeaderButton>
        </div>

        {view === "clocks" ? (
          <>
            {travelOpen && (
              <TimeTravelBar offset={offset} shown={shownDate} now={now} hour12={clocks.hour12} onChange={setOffset} />
            )}
            <ClockRows
              clocks={clocks}
              settings={settings}
              now={shownDate}
              localZone={localZone}
              mounted={mounted}
              travelling={offset !== 0}
              onShift={(delta) => {
                setTravelOpen(true)
                setOffset((o) => clampShift(o + delta))
              }}
            />
          </>
        ) : (
          <div data-no-drag className="pb-0.5 text-[13px]">
            <Group title="Pick a vibe">
              <div className="grid grid-cols-7 gap-x-1 gap-y-2">
                {[AUTO_THEME, ...Object.keys(WIDGET_THEMES)].map((name) => {
                  const active = settings.theme === name
                  const background =
                    name === AUTO_THEME
                      ? "linear-gradient(135deg, #F3F4F7 50%, #26282D 50%)"
                      : gradient(WIDGET_THEMES[name].stops)
                  return (
                    <button
                      key={name}
                      type="button"
                      onClick={() => updateSettings({ theme: name })}
                      className={cn(
                        "flex flex-col items-center gap-1 text-[9.5px] text-[var(--w-sub)]",
                        active && "font-semibold text-[var(--w-fg)]",
                      )}
                    >
                      <span
                        className={cn(
                          "size-7 rounded-full border border-black/10 transition-transform hover:scale-110",
                          active && "shadow-[0_0_0_2px_var(--w-fg)]",
                        )}
                        style={{ background }}
                      />
                      {name}
                    </button>
                  )
                })}
              </div>
            </Group>

            <Group title="Clock">
              <div className="flex min-h-[30px] items-center justify-between gap-3">
                <span>Time format</span>
                <Segmented
                  options={[
                    { label: "12h", value: true },
                    { label: "24h", value: false },
                  ]}
                  value={clocks.hour12}
                  onChange={(hour12) => updateClocks({ hour12 })}
                />
              </div>
              <Toggle label="Show seconds" checked={clocks.showSeconds} onChange={(showSeconds) => updateClocks({ showSeconds })} />
              <Toggle
                label="Date & day progress"
                checked={settings.showDetails}
                onChange={(showDetails) => updateSettings({ showDetails })}
              />
            </Group>

            <Group title="Size & glass">
              <div className="flex min-h-[30px] items-center justify-between gap-3">
                <span>Size</span>
                <Segmented options={SIZES} value={settings.scale} onChange={(scale) => updateSettings({ scale })} />
              </div>
              <div className="flex min-h-[30px] items-center justify-between gap-3">
                <span>Opacity</span>
                <input
                  type="range"
                  min={0.5}
                  max={1}
                  step={0.05}
                  value={settings.opacity}
                  onChange={(e) => updateSettings({ opacity: Number(e.target.value) })}
                  className="w-36 accent-[var(--w-fg)]"
                />
              </div>
            </Group>

            <Group title="Window">
              <Toggle label="Pin on top of other apps" checked={settings.pinned} onChange={(pinned) => updateSettings({ pinned })} />
              <Toggle label="Lock position" checked={settings.locked} onChange={(locked) => updateSettings({ locked })} />
            </Group>

            <Group title="Your crew around the globe">
              {clocks.clocks.length === 0 && <div className="py-1 text-xs text-[var(--w-sub)]">No cities yet.</div>}
              {clocks.clocks.map((c, i) => (
                <div
                  key={`${c.zone}-${i}`}
                  className="flex items-center gap-2 border-b border-[var(--w-track)] py-1.5 last:border-b-0"
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate">{c.label || c.city || cityFromZone(c.zone)}</div>
                    <div className="text-[10.5px] text-[var(--w-sub)]">{c.zone.replace(/_/g, " ")}</div>
                  </div>
                  <HeaderButton
                    title="Say bye"
                    aria-label={`Remove ${c.label || c.city || cityFromZone(c.zone)}`}
                    onClick={() => updateClocks({ clocks: clocks.clocks.filter((_, j) => j !== i) })}
                  >
                    <IconX size={13} />
                  </HeaderButton>
                </div>
              ))}
              <button
                type="button"
                onClick={() => focusMainWindow()}
                className="mt-1.5 text-xs font-semibold text-[var(--w-sub)] hover:text-[var(--w-fg)]"
              >
                + Add cities from the World clock in singl
              </button>
            </Group>

            <div className="mt-2.5 flex justify-end">
              <button
                type="button"
                onClick={() => setView("clocks")}
                className="rounded-[9px] bg-[var(--w-fg)] px-3.5 py-1.5 text-[13px] font-semibold"
                style={{ color: theme.mode === "light" ? "#ffffff" : "#1d1d1f" }}
              >
                Done
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// ── Rows ─────────────────────────────────────────────────────────────────────

function ClockRows({
  clocks,
  settings,
  now,
  localZone,
  mounted,
  travelling,
  onShift,
}: {
  clocks: ClockConfig
  settings: WidgetSettings
  /** The shown time: now, or the time-travelled one. */
  now: Date
  localZone: string
  mounted: boolean
  travelling: boolean
  /** Moves the shown time by this many minutes. */
  onShift: (minutes: number) => void
}) {
  if (!mounted) return <div className="h-40" />

  if (clocks.clocks.length === 0) {
    return (
      <div className="mt-1.5 rounded-2xl border border-[var(--w-row-border)] bg-[var(--w-row)] px-4 py-5 text-center">
        <div className="text-sm font-semibold">No cities yet</div>
        <button
          type="button"
          onClick={() => focusMainWindow()}
          className="mt-1 text-xs text-[var(--w-sub)] hover:text-[var(--w-fg)]"
        >
          Add some from the World clock in singl
        </button>
      </div>
    )
  }

  const utcMinute = now.getUTCHours() * 60 + now.getUTCMinutes()
  const showSeconds = clocks.showSeconds && !travelling

  /** Dragging a city's day bar sets that city's time to the spot under the pointer. */
  const onBarPointer = (zoneMinute: number) => (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.type === "pointermove" && !(e.buttons & 1)) return
    if (e.type === "pointerdown") e.currentTarget.setPointerCapture(e.pointerId)
    const rect = e.currentTarget.getBoundingClientRect()
    const fraction = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width))
    const target = Math.min(1440 - TRAVEL_STEP, Math.round((fraction * 1440) / TRAVEL_STEP) * TRAVEL_STEP)
    if (target !== zoneMinute) onShift(target - zoneMinute)
  }

  return (
    <div>
      {clocks.clocks.map((c, i) => {
        const name = c.label || c.city || cityFromZone(c.zone)
        const zoneMinute = (((utcMinute + getZoneMinutesOffset(c.zone, now)) % 1440) + 1440) % 1440
        const hour = Math.floor(zoneMinute / 60)
        const solar = solarIcon(hour)
        const time = formatTimeParts(now, c.zone, clocks.hour12)
        const dayDiff = getDayDiff(now, localZone, c.zone)
        const day = dayDiff === 0 ? "Today" : dayDiff > 0 ? "Tomorrow" : "Yesterday"

        return (
          <div
            key={`${c.zone}-${i}`}
            className="mt-1.5 grid grid-cols-[34px_1fr_auto] items-center gap-x-3 rounded-2xl border border-[var(--w-row-border)] bg-[var(--w-row)] py-2.5 pr-3.5 pl-3 transition-transform hover:-translate-y-px"
          >
            <div className="grid size-[34px] place-items-center rounded-full" style={badgeColors(hour)} title={solar.label}>
              <solar.Icon size={16} />
            </div>

            <div className="min-w-0">
              <div className="truncate text-[14.5px] font-semibold">{name}</div>
              <div className="text-[11.5px] text-[var(--w-vibe)]">{vibe(hour)}</div>
              {settings.showDetails && (
                <div className="text-[10.5px] whitespace-nowrap text-[var(--w-sub)]">
                  {day}, {formatDate(now, c.zone)} · {getUtcOffset(c.zone, now)}
                </div>
              )}
            </div>

            <div className="text-[30px] leading-none font-light tracking-tight whitespace-nowrap tabular-nums">
              {time.hm}
              {showSeconds && <span className="text-base text-[var(--w-sub)]">:{time.s}</span>}
              {time.period && <span className="ml-1 text-xs font-semibold text-[var(--w-sub)]">{time.period}</span>}
            </div>

            {settings.showDetails && (
              <div
                data-no-drag
                title="Drag to check a different time"
                className="col-start-2 col-end-4 mt-1 cursor-ew-resize touch-none py-1"
                onPointerDown={onBarPointer(zoneMinute)}
                onPointerMove={onBarPointer(zoneMinute)}
              >
                <div className="h-1 overflow-hidden rounded-full bg-[var(--w-track)]">
                  <div
                    className={cn("h-full rounded-full", !travelling && "transition-[width] duration-1000")}
                    style={{ width: `${(zoneMinute / 1440) * 100}%`, background: ACCENTS[i % ACCENTS.length] }}
                  />
                </div>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
