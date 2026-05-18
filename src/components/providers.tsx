"use client"

import { createContext, useCallback, useContext, useEffect, useSyncExternalStore } from "react"

type Theme = "dark" | "light" | "system"
type ResolvedTheme = "dark" | "light"

interface ThemeContextValue {
  theme: Theme
  resolvedTheme: ResolvedTheme | undefined
  systemTheme: ResolvedTheme | undefined
  setTheme: (theme: Theme) => void
}

const ThemeContext = createContext<ThemeContextValue | undefined>(undefined)

export function useTheme(): ThemeContextValue {
  return useContext(ThemeContext) ?? { theme: "system", resolvedTheme: undefined, systemTheme: undefined, setTheme: () => {} }
}

function applyTheme(theme: Theme, system: ResolvedTheme | undefined) {
  const resolved: ResolvedTheme = theme === "system" ? (system ?? "light") : theme as ResolvedTheme
  document.documentElement.classList.toggle("dark", resolved === "dark")
  document.documentElement.style.colorScheme = resolved
}

function withTransitionsDisabled(fn: () => void) {
  const style = document.createElement("style")
  style.textContent = "*, *::before, *::after { transition: none !important; }"
  document.head.appendChild(style)
  fn()
  window.getComputedStyle(document.body)
  setTimeout(() => document.head.removeChild(style), 1)
}

// ── localStorage theme store ──────────────────────────────────────────────────

const themeListeners = new Set<() => void>()

function subscribeToTheme(callback: () => void) {
  themeListeners.add(callback)
  return () => { themeListeners.delete(callback) }
}

function getThemeSnapshot(): Theme {
  return (localStorage.getItem("theme") as Theme) || "system"
}

// ── System theme (matchMedia) store ──────────────────────────────────────────

function subscribeToSystemTheme(callback: () => void) {
  const mq = window.matchMedia("(prefers-color-scheme: dark)")
  mq.addEventListener("change", callback)
  return () => mq.removeEventListener("change", callback)
}

function getSystemThemeSnapshot(): ResolvedTheme | undefined {
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"
}

// ── Provider ─────────────────────────────────────────────────────────────────

export function Providers({ children }: { children: React.ReactNode }) {
  const theme = useSyncExternalStore(subscribeToTheme, getThemeSnapshot, () => "system" as Theme)
  const systemTheme = useSyncExternalStore<ResolvedTheme | undefined>(
    subscribeToSystemTheme,
    getSystemThemeSnapshot,
    () => undefined,
  )

  useEffect(() => {
    applyTheme(theme, systemTheme)
  }, [theme, systemTheme])

  const setTheme = useCallback((newTheme: Theme) => {
    try { localStorage.setItem("theme", newTheme) } catch {}
    themeListeners.forEach(cb => cb())
    const sys = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"
    withTransitionsDisabled(() => applyTheme(newTheme, sys))
  }, [])

  const resolvedTheme: ResolvedTheme | undefined = theme === "system" ? systemTheme : theme as ResolvedTheme

  return (
    <ThemeContext.Provider value={{ theme, resolvedTheme, systemTheme, setTheme }}>
      {children}
    </ThemeContext.Provider>
  )
}
