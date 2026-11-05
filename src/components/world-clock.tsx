"use client"

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react"
import {
  IconWorld,
  IconX,
  IconSun,
  IconMoon,
  IconSunrise,
  IconSunset,
  IconCopy,
  IconArrowsSort,
  IconSparkles,
  IconPencil,
  IconCheck,
  IconArrowBackUp,
  IconGripVertical,
  IconPlus,
  IconDots,
  IconPictureInPicture,
} from "@tabler/icons-react"
import {
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from "@dnd-kit/core"
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable"
import { CSS } from "@dnd-kit/utilities"
import { Combobox as ComboboxPrimitive } from "@base-ui/react"
import {
  Combobox,
  ComboboxContent,
  ComboboxGroup,
  ComboboxInput,
  ComboboxItem,
  ComboboxLabel,
  ComboboxList,
  ComboboxSeparator,
} from "@/components/ui/combobox"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { toast } from "sonner"
import { cn } from "@/lib/utils"
import { WORLD_CITIES, searchCities } from "@/lib/world-cities"
import { openClockWidget } from "@/lib/clock-widget"

export const STORAGE_KEY = "singl:world-clock"

export interface ClockItem {
  id?: string
  zone: string
  label?: string
  /** Set when added from the city search, overriding the zone-derived name. */
  city?: string
  country?: string
}

export interface ClockConfig {
  clocks: ClockItem[]
  hour12: boolean
  showSeconds: boolean
}

export interface PopularZone {
  zone: string
  city: string
  country: string
  code: string
  label: string
}

export const POPULAR_ZONES: PopularZone[] = [
  { zone: "UTC", city: "UTC", country: "Universal", code: "UTC", label: "UTC – Universal Time" },
  { zone: "Etc/GMT", city: "GMT", country: "Greenwich", code: "GMT", label: "GMT – Greenwich Mean Time" },
  { zone: "America/Los_Angeles", city: "Los Angeles", country: "USA (Pacific)", code: "PT", label: "Los Angeles / San Francisco (Pacific)" },
  { zone: "America/Denver", city: "Denver", country: "USA (Mountain)", code: "MT", label: "Denver / Salt Lake City (Mountain)" },
  { zone: "America/Chicago", city: "Chicago", country: "USA (Central)", code: "CT", label: "Chicago / Dallas / Austin (Central)" },
  { zone: "America/New_York", city: "New York", country: "USA (Eastern)", code: "ET", label: "New York / Boston / Miami (Eastern)" },
  { zone: "America/Toronto", city: "Toronto", country: "Canada", code: "ET", label: "Toronto / Montreal" },
  { zone: "America/Vancouver", city: "Vancouver", country: "Canada", code: "PT", label: "Vancouver" },
  { zone: "America/Sao_Paulo", city: "São Paulo", country: "Brazil", code: "BRT", label: "São Paulo / Rio de Janeiro" },
  { zone: "Europe/London", city: "London", country: "United Kingdom", code: "GMT/BST", label: "London / Dublin" },
  { zone: "Europe/Paris", city: "Paris", country: "France", code: "CET", label: "Paris / Amsterdam / Brussels" },
  { zone: "Europe/Berlin", city: "Berlin", country: "Germany", code: "CET", label: "Berlin / Frankfurt / Munich" },
  { zone: "Europe/Zurich", city: "Zurich", country: "Switzerland", code: "CET", label: "Zurich / Geneva" },
  { zone: "Europe/Madrid", city: "Madrid", country: "Spain", code: "CET", label: "Madrid / Barcelona" },
  { zone: "Asia/Dubai", city: "Dubai", country: "UAE", code: "GST", label: "Dubai / Abu Dhabi" },
  { zone: "Asia/Kolkata", city: "Bengaluru", country: "India", code: "IST", label: "Bengaluru / Mumbai / Delhi (IST)" },
  { zone: "Asia/Singapore", city: "Singapore", country: "Singapore", code: "SGT", label: "Singapore / Kuala Lumpur" },
  { zone: "Asia/Shanghai", city: "Shanghai", country: "China", code: "CST", label: "Shanghai / Beijing / Shenzhen" },
  { zone: "Asia/Hong_Kong", city: "Hong Kong", country: "Hong Kong", code: "HKT", label: "Hong Kong" },
  { zone: "Asia/Tokyo", city: "Tokyo", country: "Japan", code: "JST", label: "Tokyo / Osaka" },
  { zone: "Asia/Seoul", city: "Seoul", country: "South Korea", code: "KST", label: "Seoul" },
  { zone: "Australia/Sydney", city: "Sydney", country: "Australia (Eastern)", code: "AEST", label: "Sydney / Melbourne" },
  { zone: "Australia/Perth", city: "Perth", country: "Australia (Western)", code: "AWST", label: "Perth" },
  { zone: "Pacific/Auckland", city: "Auckland", country: "New Zealand", code: "NZST", label: "Auckland / Wellington" },
  { zone: "Pacific/Honolulu", city: "Honolulu", country: "USA (Hawaii)", code: "HST", label: "Honolulu (Hawaii)" },
]

const POPULAR_ZONE_IDS = new Set(POPULAR_ZONES.map((p) => p.zone))

interface Preset {
  id: string
  name: string
  description: string
  clocks: ClockItem[]
}

const PRESETS: Preset[] = [
  {
    id: "tech-hubs",
    name: "Global Tech Hubs",
    description: "SF, London, Bengaluru, Tokyo & Sydney",
    clocks: [
      { zone: "America/Los_Angeles", label: "Silicon Valley" },
      { zone: "Europe/London", label: "London HQ" },
      { zone: "Asia/Kolkata", label: "Bengaluru Dev" },
      { zone: "Asia/Tokyo", label: "Tokyo" },
      { zone: "Australia/Sydney", label: "Sydney" },
    ],
  },
  {
    id: "us-zones",
    name: "US Coast-to-Coast",
    description: "Pacific, Mountain, Central & Eastern",
    clocks: [
      { zone: "America/Los_Angeles", label: "Pacific (PT)" },
      { zone: "America/Denver", label: "Mountain (MT)" },
      { zone: "America/Chicago", label: "Central (CT)" },
      { zone: "America/New_York", label: "Eastern (ET)" },
    ],
  },
  {
    id: "europe",
    name: "European Hubs",
    description: "London, Paris, Berlin & Zurich",
    clocks: [
      { zone: "Europe/London", label: "London" },
      { zone: "Europe/Paris", label: "Paris" },
      { zone: "Europe/Berlin", label: "Berlin" },
      { zone: "Europe/Zurich", label: "Zurich" },
    ],
  },
  {
    id: "apac",
    name: "Asia-Pacific",
    description: "Singapore, Tokyo, Sydney & Auckland",
    clocks: [
      { zone: "Asia/Singapore", label: "Singapore" },
      { zone: "Asia/Tokyo", label: "Tokyo" },
      { zone: "Australia/Sydney", label: "Sydney" },
      { zone: "Pacific/Auckland", label: "Auckland" },
    ],
  },
]

const DAY_MINUTES = 24 * 60
/** Scrubbing moves in steps of this many minutes. */
const SCRUB_STEP = 15
/** Lower bound announced for the keyboard time slider. */
const SCRUB_MIN = -DAY_MINUTES

export function getLocalZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone
  } catch {
    return "UTC"
  }
}

export function loadConfig(): ClockConfig {
  const local = getLocalZone()
  const fallback: ClockConfig = {
    clocks: [{ zone: local, label: "Local" }],
    hour12: false,
    showSeconds: true,
  }

  if (typeof window === "undefined") return fallback

  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw)
      // Older configs stored a plain `timezones` list.
      const list = Array.isArray(parsed.clocks) ? parsed.clocks : parsed.timezones
      if (Array.isArray(list)) {
        return {
          clocks: list.map((tz: string | ClockItem) => (typeof tz === "string" ? { zone: tz } : tz)),
          hour12: Boolean(parsed.hour12),
          showSeconds: parsed.showSeconds ?? true,
        }
      }
    }
  } catch {}
  return fallback
}

export function saveConfig(config: ClockConfig): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(config))
  } catch {}
}

export function cityFromZone(zone: string): string {
  const popular = POPULAR_ZONES.find((p) => p.zone === zone)
  if (popular) return popular.city
  const parts = zone.split("/")
  return (parts[parts.length - 1] ?? zone).replace(/_/g, " ")
}

export function getUtcOffset(zone: string, date: Date): string {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      timeZoneName: "shortOffset",
    }).formatToParts(date)
    const tz = parts.find((p) => p.type === "timeZoneName")?.value ?? ""
    return tz.replace("GMT", "UTC")
  } catch {
    return ""
  }
}

export function getZoneMinutesOffset(zone: string, date: Date): number {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
      hour12: false,
    }).formatToParts(date)
    const get = (t: string) => parseInt(parts.find((p) => p.type === t)?.value ?? "0", 10)
    const h = get("hour") % 24
    const utcMs = Date.UTC(get("year"), get("month") - 1, get("day"), h, get("minute"), get("second"))
    return Math.round((utcMs - date.getTime()) / 60000)
  } catch {
    return 0
  }
}

/** How far `zone` is ahead of `localZone`, in minutes. */
function diffFromLocal(zone: string, localZone: string, date: Date): number {
  return getZoneMinutesOffset(zone, date) - getZoneMinutesOffset(localZone, date)
}

function formatDuration(minutes: number): string {
  const abs = Math.abs(minutes)
  const h = Math.floor(abs / 60)
  const m = abs % 60
  return m ? (h ? `${h}h ${m}m` : `${m}m`) : `${h}h`
}

function formatOffset(diffMinutes: number): string {
  if (diffMinutes === 0) return "Same time"
  return `${diffMinutes > 0 ? "+" : "−"}${formatDuration(diffMinutes)}`
}

export function formatTimeParts(date: Date, zone: string, hour12: boolean) {
  try {
    const parts = new Intl.DateTimeFormat(undefined, {
      timeZone: zone,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12,
    }).formatToParts(date)
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? ""
    return { hm: `${get("hour")}:${get("minute")}`, s: get("second"), period: get("dayPeriod") }
  } catch {
    return { hm: "--:--", s: "", period: "" }
  }
}

function formatTime(date: Date, zone: string, hour12: boolean): string {
  const { hm, period } = formatTimeParts(date, zone, hour12)
  return period ? `${hm} ${period}` : hm
}

/** Local minute-of-day as a clock label, e.g. 870 → "14:30". */
function formatLocalMinute(minute: number, hour12: boolean): string {
  const d = new Date(2000, 0, 1, Math.floor(minute / 60) % 24, minute % 60)
  return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", hour12 }).format(d)
}

export function formatDate(date: Date, zone: string): string {
  try {
    return new Intl.DateTimeFormat(undefined, {
      timeZone: zone,
      weekday: "short",
      month: "short",
      day: "numeric",
    }).format(date)
  } catch {
    return ""
  }
}

export function getDayDiff(date: Date, localZone: string, targetZone: string): number {
  try {
    const fmt = (z: string) =>
      new Intl.DateTimeFormat("en-CA", { timeZone: z, year: "numeric", month: "2-digit", day: "2-digit" }).format(date)
    const localDay = fmt(localZone)
    const targetDay = fmt(targetZone)
    if (localDay === targetDay) return 0
    return Math.round((new Date(`${targetDay}T00:00:00Z`).getTime() - new Date(`${localDay}T00:00:00Z`).getTime()) / 86400000)
  } catch {
    return 0
  }
}

export function zoneClock(zone: string, date: Date): { hour: number; isWeekend: boolean } {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hour: "numeric",
      hour12: false,
      weekday: "short",
    }).formatToParts(date)
    const weekday = parts.find((p) => p.type === "weekday")?.value
    return {
      hour: parseInt(parts.find((p) => p.type === "hour")?.value ?? "12", 10) % 24,
      isWeekend: weekday === "Sat" || weekday === "Sun",
    }
  } catch {
    return { hour: 12, isWeekend: false }
  }
}

export function solarIcon(hour: number) {
  if (hour >= 5 && hour < 8) return { Icon: IconSunrise, className: "text-amber-500", label: "Dawn" }
  if (hour >= 8 && hour < 17) return { Icon: IconSun, className: "text-amber-500", label: "Day" }
  if (hour >= 17 && hour < 20) return { Icon: IconSunset, className: "text-rose-500", label: "Dusk" }
  return { Icon: IconMoon, className: "text-indigo-400", label: "Night" }
}

// ── Day bands ────────────────────────────────────────────────────────────────

type Band = "work" | "edge" | "night"

/** Work 9–18, edge hours 7–9 and 18–22, night otherwise. */
function bandAt(zoneMinute: number): Band {
  const hour = zoneMinute / 60
  if (hour >= 9 && hour < 18) return "work"
  if ((hour >= 7 && hour < 9) || (hour >= 18 && hour < 22)) return "edge"
  return "night"
}

const BAND_EDGES = [7, 9, 18, 22]

const BAND_CLASS: Record<Band, string> = {
  work: "bg-emerald-500/75 dark:bg-emerald-400/60",
  edge: "bg-amber-400/45 dark:bg-amber-300/45",
  night: "",
}

const mod = (n: number, m: number) => ((n % m) + m) % m

/** A zone's day bands laid across the local day, as [start, end) local minutes. */
function daySegments(diffMinutes: number): { start: number; end: number; band: Band }[] {
  const cuts = new Set([0, DAY_MINUTES, ...BAND_EDGES.map((h) => mod(h * 60 - diffMinutes, DAY_MINUTES))])
  const sorted = [...cuts].sort((a, b) => a - b)
  const segments: { start: number; end: number; band: Band }[] = []
  for (let i = 0; i < sorted.length - 1; i++) {
    const [start, end] = [sorted[i], sorted[i + 1]]
    const band = bandAt(mod((start + end) / 2 + diffMinutes, DAY_MINUTES))
    const last = segments[segments.length - 1]
    if (last && last.band === band) last.end = end
    else segments.push({ start, end, band })
  }
  return segments
}

/** Longest stretch of the local day where the most clocks are inside work hours. */
function bestOverlap(diffs: number[]): { start: number; end: number; count: number } | null {
  if (diffs.length < 2) return null
  const slots = DAY_MINUTES / SCRUB_STEP
  const counts = Array.from({ length: slots }, (_, i) =>
    diffs.filter((d) => bandAt(mod(i * SCRUB_STEP + d, DAY_MINUTES)) === "work").length,
  )
  const max = Math.max(...counts)
  if (max === 0) return { start: 0, end: 0, count: 0 }
  let best = { start: 0, end: 0 }
  for (let i = 0; i < slots; ) {
    if (counts[i] !== max) {
      i++
      continue
    }
    let j = i
    while (j < slots && counts[j] === max) j++
    if (j - i > best.end - best.start) best = { start: i, end: j }
    i = j
  }
  return { start: best.start * SCRUB_STEP, end: best.end * SCRUB_STEP, count: max }
}

// ── Row ──────────────────────────────────────────────────────────────────────

interface ClockRowProps {
  id: string
  clock: ClockItem
  index: number
  effectiveDate: Date
  localZone: string
  localMinute: number
  scrubbing: boolean
  hour12: boolean
  showSeconds: boolean
  editing: boolean
  editingLabelValue: string
  startEditing: () => void
  setEditingLabelValue: (val: string) => void
  cancelEditing: () => void
  saveLabel: (idx: number) => void
  removeClock: (idx: number) => void
  onScrubPointer: (e: ReactPointerEvent<HTMLDivElement>) => void
}

function ClockRow({
  id,
  clock,
  index,
  effectiveDate,
  localZone,
  localMinute,
  scrubbing,
  hour12,
  showSeconds,
  editing,
  editingLabelValue,
  startEditing,
  setEditingLabelValue,
  cancelEditing,
  saveLabel,
  removeClock,
  onScrubPointer,
}: ClockRowProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id })
  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    zIndex: isDragging ? 50 : undefined,
  }

  const city = clock.city ?? cityFromZone(clock.zone)
  const isLocal = clock.zone === localZone
  const diff = diffFromLocal(clock.zone, localZone, effectiveDate)
  const dayDiff = getDayDiff(effectiveDate, localZone, clock.zone)
  const { hour, isWeekend } = zoneClock(clock.zone, effectiveDate)
  const solar = solarIcon(hour)
  const time = formatTimeParts(effectiveDate, clock.zone, hour12)
  const segments = useMemo(() => daySegments(diff), [diff])
  const name = clock.label || city

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn(
        "group/row relative flex flex-col gap-1.5 rounded-xl px-4 py-2.5 transition-colors hover:bg-muted/50",
        isDragging && "bg-card shadow-lg ring-1 ring-border",
      )}
    >
      <button
        type="button"
        {...attributes}
        {...listeners}
        className="absolute top-3 left-0.5 cursor-grab touch-none rounded p-0.5 text-muted-foreground/50 opacity-0 transition-opacity group-hover/row:opacity-100 hover:text-foreground focus-visible:opacity-100 active:cursor-grabbing"
        aria-label={`Reorder ${name}`}
      >
        <IconGripVertical size={13} />
      </button>

      <div className="flex items-end justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-0.5">
          {editing ? (
            <div className="flex items-center gap-1">
              <input
                type="text"
                value={editingLabelValue}
                onChange={(e) => setEditingLabelValue(e.target.value)}
                placeholder={city}
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === "Enter") saveLabel(index)
                  if (e.key === "Escape") cancelEditing()
                }}
                className="h-6 w-32 rounded-md border bg-background px-1.5 text-sm font-medium focus:ring-1 focus:ring-primary focus:outline-none"
              />
              <Button size="icon-xs" variant="ghost" onClick={() => saveLabel(index)} aria-label="Save label">
                <IconCheck className="text-emerald-500" />
              </Button>
            </div>
          ) : (
            <div className="flex min-w-0 items-center gap-1">
              <span className="truncate text-sm font-medium text-foreground">{name}</span>
              <div className="flex shrink-0 items-center opacity-0 transition-opacity group-hover/row:opacity-100 focus-within:opacity-100">
                <Button
                  size="icon-xs"
                  variant="ghost"
                  className="size-5 text-muted-foreground"
                  onClick={startEditing}
                  aria-label={`Rename ${name}`}
                >
                  <IconPencil className="size-3" />
                </Button>
                <Button
                  size="icon-xs"
                  variant="ghost"
                  className="size-5 text-muted-foreground hover:text-destructive"
                  onClick={() => removeClock(index)}
                  aria-label={`Remove ${name}`}
                >
                  <IconX className="size-3" />
                </Button>
              </div>
            </div>
          )}
          <div className="flex min-w-0 items-center gap-1 text-[11px] text-muted-foreground">
            <span className={cn("shrink-0", isLocal && "font-medium text-primary")}>
              {isLocal ? "Local" : formatOffset(diff)}
            </span>
            <span aria-hidden>·</span>
            <span className={cn("truncate", dayDiff !== 0 && "font-medium text-foreground")}>
              {formatDate(effectiveDate, clock.zone)}
            </span>
            {isWeekend && (
              <>
                <span aria-hidden>·</span>
                <span className="shrink-0">Weekend</span>
              </>
            )}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-1.5" title={`${solar.label} in ${city} · ${getUtcOffset(clock.zone, effectiveDate)}`}>
          <solar.Icon size={14} className={solar.className} aria-label={solar.label} />
          <span className="font-mono text-xl leading-none font-semibold tracking-tight tabular-nums text-foreground">
            {time.hm}
            {showSeconds && <span className="text-sm font-medium text-muted-foreground/70">:{time.s}</span>}
          </span>
          {time.period && <span className="text-[11px] font-medium text-muted-foreground">{time.period}</span>}
        </div>
      </div>

      {/* The zone's day laid over the local day; drag to scrub */}
      <div
        className="relative -my-1 cursor-ew-resize touch-none py-1"
        onPointerDown={onScrubPointer}
        onPointerMove={onScrubPointer}
        aria-hidden
      >
        <div className="relative h-1.5 overflow-hidden rounded-full bg-muted">
          {segments
            .filter((s) => s.band !== "night")
            .map((s) => (
              <div
                key={s.start}
                className={cn("absolute inset-y-0", BAND_CLASS[s.band], isWeekend && "opacity-40")}
                style={{ left: `${(s.start / DAY_MINUTES) * 100}%`, width: `${((s.end - s.start) / DAY_MINUTES) * 100}%` }}
              />
            ))}
        </div>
        <div
          className={cn(
            "pointer-events-none absolute top-0 bottom-0 w-0.5 -translate-x-1/2 rounded-full",
            scrubbing ? "bg-primary" : "bg-foreground",
          )}
          style={{ left: `${(localMinute / DAY_MINUTES) * 100}%` }}
        />
      </div>
    </div>
  )
}

// ── World clock ──────────────────────────────────────────────────────────────

export function WorldClock() {
  const [mounted, setMounted] = useState(false)
  const [config, setConfig] = useState<ClockConfig>({ clocks: [], hour12: false, showSeconds: true })
  const [now, setNow] = useState<Date>(new Date())
  const [scrubberMinutes, setScrubberMinutes] = useState<number>(0)
  const [comboboxKey, setComboboxKey] = useState(0)
  const [inputQuery, setInputQuery] = useState("")
  const [editingIndex, setEditingIndex] = useState<number | null>(null)
  const [editingLabelValue, setEditingLabelValue] = useState("")

  const localZone = useMemo(() => getLocalZone(), [])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setConfig(loadConfig())
    setMounted(true)

    // The pop-out widget edits the same config from its own window
    const onStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY) setConfig(loadConfig())
    }
    window.addEventListener("storage", onStorage)
    return () => window.removeEventListener("storage", onStorage)
  }, [])

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(id)
  }, [])

  const effectiveDate = useMemo(
    () => (scrubberMinutes === 0 ? now : new Date(now.getTime() + scrubberMinutes * 60000)),
    [now, scrubberMinutes],
  )
  const localMinute = effectiveDate.getHours() * 60 + effectiveDate.getMinutes()
  const scrubbing = scrubberMinutes !== 0

  const allSupportedZones = useMemo<string[]>(() => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (Intl as any).supportedValuesOf("timeZone") as string[]
    } catch {
      return []
    }
  }, [])

  const existingZoneIds = useMemo(() => new Set(config.clocks.map((c) => c.zone)), [config.clocks])

  const availablePopularZones = useMemo(() => {
    const base = POPULAR_ZONES.filter((p) => !existingZoneIds.has(p.zone))
    const q = inputQuery.toLowerCase().trim()
    if (!q) return base
    return base.filter((p) =>
      [p.city, p.country, p.code, p.label, p.zone].some((field) => field.toLowerCase().includes(q)),
    )
  }, [existingZoneIds, inputQuery])

  const availableOtherZones = useMemo(() => {
    const base = allSupportedZones.filter((z) => !existingZoneIds.has(z) && !POPULAR_ZONE_IDS.has(z))
    const q = inputQuery.toLowerCase().trim()
    if (!q) return base
    return base.filter((z) => z.toLowerCase().replace(/_/g, " ").includes(q))
  }, [allSupportedZones, existingZoneIds, inputQuery])

  const matchingCities = useMemo(() => {
    const taken = new Set(config.clocks.filter((c) => c.city).map((c) => `${c.zone}|${c.city}`))
    return searchCities(inputQuery, 20)
      .map((city) => ({ city, index: WORLD_CITIES.indexOf(city) }))
      .filter(({ city }) => !taken.has(`${city.zone}|${city.name}`))
  }, [config.clocks, inputQuery])

  const hasResults = matchingCities.length > 0 || availablePopularZones.length > 0 || availableOtherZones.length > 0

  const overlap = useMemo(
    () => bestOverlap(config.clocks.map((c) => diffFromLocal(c.zone, localZone, effectiveDate))),
    [config.clocks, localZone, effectiveDate],
  )

  const updateConfig = useCallback((updater: (prev: ClockConfig) => ClockConfig) => {
    setConfig((prev) => {
      const next = updater(prev)
      saveConfig(next)
      return next
    })
  }, [])

  function addZone(value: string) {
    let item: ClockItem
    if (value.startsWith("city:")) {
      const city = WORLD_CITIES[Number(value.slice(5))]
      if (!city) return
      item = { zone: city.zone, city: city.name, country: city.country }
    } else {
      if (!value || existingZoneIds.has(value)) return
      item = { zone: value }
    }
    updateConfig((prev) => ({ ...prev, clocks: [...prev.clocks, item] }))
    setComboboxKey((k) => k + 1)
    setInputQuery("")
  }

  function removeClock(index: number) {
    updateConfig((prev) => ({ ...prev, clocks: prev.clocks.filter((_, i) => i !== index) }))
  }

  function sortClocksByOffset() {
    updateConfig((prev) => ({
      ...prev,
      clocks: [...prev.clocks].sort(
        (a, b) => getZoneMinutesOffset(a.zone, effectiveDate) - getZoneMinutesOffset(b.zone, effectiveDate),
      ),
    }))
    toast.success("Sorted clocks from west to east")
  }

  function saveLabel(index: number) {
    updateConfig((prev) => ({
      ...prev,
      clocks: prev.clocks.map((item, i) => (i === index ? { ...item, label: editingLabelValue.trim() || undefined } : item)),
    }))
    setEditingIndex(null)
    setEditingLabelValue("")
  }

  function loadPreset(preset: Preset) {
    updateConfig((prev) => ({ ...prev, clocks: preset.clocks }))
    toast.success(`Loaded "${preset.name}"`)
  }

  function copyTimes() {
    if (config.clocks.length === 0) return
    const lines = [
      `Times for ${formatDate(effectiveDate, localZone)}:`,
      ...config.clocks.map((c) => {
        const city = c.city ?? cityFromZone(c.zone)
        const name = c.label ? `${c.label} (${city})` : city
        const dayDiff = getDayDiff(effectiveDate, localZone, c.zone)
        const rel = c.zone === localZone ? "local" : formatOffset(diffFromLocal(c.zone, localZone, effectiveDate))
        return `• ${formatTime(effectiveDate, c.zone, config.hour12)} — ${name} [${rel}${dayDiff ? `, ${dayDiff > 0 ? "+" : ""}${dayDiff}d` : ""}]`
      }),
    ]
    navigator.clipboard.writeText(lines.join("\n"))
    toast.success("Times copied to clipboard")
  }

  /** Moves the shown time so the local clock reads `targetMinute` on the shown day. */
  function scrubToLocalMinute(targetMinute: number) {
    const snapped = Math.round(targetMinute / SCRUB_STEP) * SCRUB_STEP
    setScrubberMinutes((m) => {
      const next = m + (snapped - localMinute)
      // Within one step of now counts as live.
      return Math.abs(next) < SCRUB_STEP ? 0 : next
    })
  }

  function onScrubPointer(e: ReactPointerEvent<HTMLDivElement>) {
    if (e.type === "pointermove" && !(e.buttons & 1)) return
    if (e.type === "pointerdown") e.currentTarget.setPointerCapture(e.pointerId)
    const rect = e.currentTarget.getBoundingClientRect()
    const fraction = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width))
    scrubToLocalMinute(Math.min(DAY_MINUTES - SCRUB_STEP, fraction * DAY_MINUTES))
  }

  function onScrubKey(e: ReactKeyboardEvent<HTMLDivElement>) {
    const step = e.shiftKey ? 60 : SCRUB_STEP
    if (e.key === "ArrowRight" || e.key === "ArrowUp") setScrubberMinutes((m) => m + step)
    else if (e.key === "ArrowLeft" || e.key === "ArrowDown") setScrubberMinutes((m) => m - step)
    else if (e.key === "Home" || e.key === "Escape") setScrubberMinutes(0)
    else return
    e.preventDefault()
  }

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  const clockItemIds = useMemo(() => config.clocks.map((c, i) => c.id || `${c.zone}-${i}`), [config.clocks])

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event
    if (!over || active.id === over.id) return
    const oldIndex = clockItemIds.indexOf(active.id as string)
    const newIndex = clockItemIds.indexOf(over.id as string)
    if (oldIndex !== -1 && newIndex !== -1) {
      updateConfig((prev) => ({ ...prev, clocks: arrayMove(prev.clocks, oldIndex, newIndex) }))
    }
  }

  const scrubLabel = scrubbing
    ? `${formatDate(effectiveDate, localZone)}, ${formatTime(effectiveDate, localZone, config.hour12)} · ${scrubberMinutes > 0 ? "+" : "−"}${formatDuration(scrubberMinutes)}`
    : "Live"

  return (
    <div className="flex flex-col overflow-hidden rounded-2xl border bg-card/90 shadow-sm backdrop-blur-md">
      {/* Header */}
      <div className="flex items-center justify-between gap-2 py-2.5 pr-2.5 pl-4">
        <span className="text-sm font-semibold tracking-tight text-foreground">World clock</span>

        <div className="flex items-center gap-1">
          <Combobox<string>
            key={comboboxKey}
            onValueChange={(v) => {
              if (v) addZone(v)
            }}
            onInputValueChange={(v) => setInputQuery(v)}
            filter={null}
          >
            <ComboboxPrimitive.Trigger render={<Button variant="ghost" size="sm" className="h-7 gap-1 px-2 text-xs" />}>
              <IconPlus size={14} />
              Add
            </ComboboxPrimitive.Trigger>
            <ComboboxContent align="end" className="w-72">
              <ComboboxInput placeholder="Search city or timezone…" showTrigger={false} className="text-xs" />
              <ComboboxList className="max-h-72">
                {matchingCities.length > 0 && (
                  <ComboboxGroup>
                    <ComboboxLabel className="text-[10px] font-semibold tracking-wider text-muted-foreground uppercase">
                      Cities
                    </ComboboxLabel>
                    {matchingCities.map(({ city, index }) => (
                      <ComboboxItem key={index} value={`city:${index}`} className="flex items-center justify-between py-1.5 text-xs">
                        <div className="flex flex-col">
                          <span className="font-medium text-foreground">{city.name}</span>
                          <span className="text-[10px] text-muted-foreground">{city.country}</span>
                        </div>
                        <span className="ml-2 shrink-0 font-mono text-[10px] text-muted-foreground">
                          {getUtcOffset(city.zone, now)}
                        </span>
                      </ComboboxItem>
                    ))}
                  </ComboboxGroup>
                )}
                {matchingCities.length > 0 && (availablePopularZones.length > 0 || availableOtherZones.length > 0) && (
                  <ComboboxSeparator />
                )}
                {availablePopularZones.length > 0 && (
                  <ComboboxGroup>
                    <ComboboxLabel className="text-[10px] font-semibold tracking-wider text-muted-foreground uppercase">
                      Popular
                    </ComboboxLabel>
                    {availablePopularZones.map((p) => (
                      <ComboboxItem key={p.zone} value={p.zone} className="flex items-center justify-between py-1.5 text-xs">
                        <div className="flex flex-col">
                          <span className="font-medium text-foreground">{p.city}</span>
                          <span className="text-[10px] text-muted-foreground">{p.country}</span>
                        </div>
                        <span className="ml-2 shrink-0 font-mono text-[10px] text-muted-foreground">{p.code}</span>
                      </ComboboxItem>
                    ))}
                  </ComboboxGroup>
                )}
                {availablePopularZones.length > 0 && availableOtherZones.length > 0 && <ComboboxSeparator />}
                {availableOtherZones.length > 0 && (
                  <ComboboxGroup>
                    <ComboboxLabel className="text-[10px] font-semibold tracking-wider text-muted-foreground uppercase">
                      All timezones
                    </ComboboxLabel>
                    {availableOtherZones.slice(0, 40).map((zone) => (
                      <ComboboxItem key={zone} value={zone} className="text-xs">
                        {zone.replace(/_/g, " ")}
                      </ComboboxItem>
                    ))}
                  </ComboboxGroup>
                )}
                {!hasResults && <div className="py-4 text-center text-xs text-muted-foreground">No matches</div>}
              </ComboboxList>
            </ComboboxContent>
          </Combobox>

          <Button
            variant="ghost"
            size="icon-sm"
            className="size-7 text-muted-foreground"
            onClick={() => openClockWidget().catch(() => toast.error("Couldn't open the desktop widget"))}
            aria-label="Pop out as desktop widget"
            title="Pop out as desktop widget"
          >
            <IconPictureInPicture size={15} />
          </Button>

          <DropdownMenu>
            <DropdownMenuTrigger
              render={<Button variant="ghost" size="icon-sm" className="size-7 text-muted-foreground" aria-label="World clock options" />}
            >
              <IconDots size={15} />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52">
              <DropdownMenuGroup>
                <DropdownMenuLabel className="text-xs">Display</DropdownMenuLabel>
                <DropdownMenuCheckboxItem
                  checked={!config.hour12}
                  onCheckedChange={(checked) => updateConfig((p) => ({ ...p, hour12: !checked }))}
                >
                  24-hour time
                </DropdownMenuCheckboxItem>
                <DropdownMenuCheckboxItem
                  checked={config.showSeconds}
                  onCheckedChange={(checked) => updateConfig((p) => ({ ...p, showSeconds: checked }))}
                >
                  Show seconds
                </DropdownMenuCheckboxItem>
              </DropdownMenuGroup>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={sortClocksByOffset} disabled={config.clocks.length < 2}>
                <IconArrowsSort />
                Sort west to east
              </DropdownMenuItem>
              <DropdownMenuItem onClick={copyTimes} disabled={config.clocks.length === 0}>
                <IconCopy />
                Copy times
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>
                  <IconSparkles />
                  Load preset
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="w-56">
                  {PRESETS.map((preset) => (
                    <DropdownMenuItem key={preset.id} onClick={() => loadPreset(preset)} className="flex flex-col items-start gap-0.5">
                      <span className="font-medium text-foreground">{preset.name}</span>
                      <span className="text-[10px] text-muted-foreground">{preset.description}</span>
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {/* Body */}
      {!mounted ? (
        <div className="flex flex-col gap-2 px-4 pb-4">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-14 animate-pulse rounded-xl bg-muted/40" />
          ))}
        </div>
      ) : config.clocks.length === 0 ? (
        <div className="flex flex-col items-center gap-3 px-6 pt-4 pb-8 text-center">
          <div className="flex size-10 items-center justify-center rounded-xl bg-muted text-muted-foreground">
            <IconWorld size={22} />
          </div>
          <div className="flex max-w-xs flex-col gap-1">
            <p className="text-sm font-medium text-foreground">No clocks yet</p>
            <p className="text-xs text-muted-foreground">Add a city to compare times and see when working hours overlap.</p>
          </div>
          <Button size="sm" variant="outline" onClick={() => loadPreset(PRESETS[0])} className="gap-1.5 text-xs">
            <IconSparkles size={13} className="text-primary" />
            Load tech hubs
          </Button>
        </div>
      ) : (
        <>
          {/* Hour axis, aligned with the day bars */}
          <div className="relative mx-4 h-3.5 text-[10px] text-muted-foreground tabular-nums" aria-hidden>
            {[0, 6, 12, 18].map((h) => (
              <span key={h} className="absolute -translate-x-1/2 first:translate-x-0" style={{ left: `${(h / 24) * 100}%` }}>
                {formatLocalMinute(h * 60, config.hour12).replace(/:00/, "")}
              </span>
            ))}
          </div>

          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
            <SortableContext items={clockItemIds} strategy={verticalListSortingStrategy}>
              <div className="flex flex-col px-0 pb-1">
                {config.clocks.map((clock, index) => (
                  <ClockRow
                    key={clockItemIds[index]}
                    id={clockItemIds[index]}
                    clock={clock}
                    index={index}
                    effectiveDate={effectiveDate}
                    localZone={localZone}
                    localMinute={localMinute}
                    scrubbing={scrubbing}
                    hour12={config.hour12}
                    showSeconds={config.showSeconds && !scrubbing}
                    editing={editingIndex === index}
                    editingLabelValue={editingLabelValue}
                    startEditing={() => {
                      setEditingIndex(index)
                      setEditingLabelValue(clock.label || "")
                    }}
                    setEditingLabelValue={setEditingLabelValue}
                    cancelEditing={() => setEditingIndex(null)}
                    saveLabel={saveLabel}
                    removeClock={removeClock}
                    onScrubPointer={onScrubPointer}
                  />
                ))}
              </div>
            </SortableContext>
          </DndContext>

          {/* Footer: scrub state (keyboard slider) + best overlap */}
          <div className="flex min-h-10 items-center justify-between gap-2 border-t bg-muted/20 py-1.5 pr-2 pl-4 text-[11px] text-muted-foreground">
            <div
              role="slider"
              tabIndex={0}
              aria-label="Shown time"
              aria-valuemin={SCRUB_MIN}
              aria-valuemax={DAY_MINUTES}
              aria-valuenow={scrubberMinutes}
              aria-valuetext={scrubLabel}
              onKeyDown={onScrubKey}
              className="flex min-w-0 items-center gap-1.5 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring"
              title="Drag a bar or use the arrow keys to look at another time"
            >
              <span
                className={cn("size-1.5 shrink-0 rounded-full", scrubbing ? "bg-primary" : "bg-emerald-500")}
                aria-hidden
              />
              <span className={cn("truncate", scrubbing && "font-medium text-foreground")}>{scrubLabel}</span>
              {!scrubbing && <span className="hidden truncate sm:inline">· drag a bar to look ahead</span>}
            </div>

            <div className="flex shrink-0 items-center gap-1">
              {overlap && !scrubbing && (
                <button
                  type="button"
                  onClick={() => overlap.count > 0 && scrubToLocalMinute(overlap.start)}
                  className="truncate rounded-md px-1.5 py-0.5 hover:bg-muted hover:text-foreground"
                  title="Show the start of this window"
                >
                  {overlap.count === 0
                    ? "No shared work hours"
                    : `${overlap.count === config.clocks.length ? "All" : `${overlap.count}/${config.clocks.length}`} at work ${formatLocalMinute(overlap.start, config.hour12)}–${formatLocalMinute(overlap.end, config.hour12)}`}
                </button>
              )}
              {scrubbing && (
                <Button
                  variant="ghost"
                  size="xs"
                  className="h-6 gap-1 px-1.5 text-[11px] text-primary hover:bg-primary/10"
                  onClick={() => setScrubberMinutes(0)}
                >
                  <IconArrowBackUp size={12} />
                  Now
                </Button>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  )
}
