"use client"

import * as React from "react"
import { useTheme } from "@/components/providers"
import { useRouter } from "next/navigation"
import { Toaster as Sonner, toast, useSonner, type ToasterProps, type ToastT } from "sonner"
import { IconCircleCheck, IconInfoCircle, IconAlertTriangle, IconAlertOctagon, IconLoader } from "@tabler/icons-react"
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification"
import { isTauri } from "@/lib/clock-widget"

function extractText(node: unknown): string {
  if (!node) return ""
  if (typeof node === "string") return node
  if (typeof node === "number") return String(node)
  if (typeof node === "function") {
    try {
      return extractText(node())
    } catch {
      return ""
    }
  }
  if (typeof node === "object") {
    if (Array.isArray(node)) {
      return node.map(extractText).filter(Boolean).join(" ")
    }
    if ("props" in node && node.props && typeof node.props === "object") {
      const props = node.props as { children?: unknown }
      if (props.children) {
        return extractText(props.children)
      }
    }
  }
  return ""
}

function getNotificationTitle(type?: string): string {
  switch (type) {
    case "error":
      return "Singl • Error"
    case "warning":
      return "Singl • Warning"
    case "success":
      return "Singl • Success"
    case "info":
      return "Singl • Info"
    default:
      return "Singl"
  }
}

// Toast ids map to notification tags with this prefix, so a toast and a push
// for the same thing (e.g. a todo reminder) replace each other.
const TOAST_TAG_PREFIX = "singl-toast-"

// Kept in sync with PUSH_MESSAGE_TYPE in src/app/sw.ts.
const PUSH_MESSAGE_TYPE = "singl-push"

type RelayedPush = {
  title?: string
  body?: string
  url: string
  tag?: string
  requireInteraction?: boolean
}

// Asked once per session; the OS remembers the answer after that.
let permissionPromise: Promise<boolean> | null = null

function ensureNotificationPermission(): Promise<boolean> {
  permissionPromise ??= (async () => {
    if (await isPermissionGranted()) return true
    return (await requestPermission()) === "granted"
  })().catch(() => false)
  return permissionPromise
}

async function dispatchSystemNotification(toast: ToastT) {
  // Someone is looking at the toast; a system notification is only needed
  // when the app is not in focus (minimised, or another app in front of it).
  if (document.visibilityState === "visible" && document.hasFocus()) return

  const titleText = extractText(toast.title)
  const descText = extractText(toast.description)
  const body = descText ? `${titleText}\n${descText}` : titleText
  if (!body) return

  try {
    if (!(await ensureNotificationPermission())) return
    sendNotification({ title: getNotificationTitle(toast.type), body })
  } catch (err) {
    console.warn("[toast] Failed to display system notification:", err)
  }
}

function SystemToastBridge() {
  const { toasts } = useSonner()
  const notifiedIdsRef = React.useRef(new Set<string | number>())

  React.useEffect(() => {
    if (!isTauri()) return
    void ensureNotificationPermission()
  }, [])

  React.useEffect(() => {
    if (!isTauri()) return
    toasts.forEach((t) => {
      // Skip loading spinners until they resolve to success/error/etc.
      if (t.type === "loading") return
      if (notifiedIdsRef.current.has(t.id)) return

      notifiedIdsRef.current.add(t.id)
      void dispatchSystemNotification(t)
    })

    // Clean up IDs that are no longer active to keep memory small
    if (notifiedIdsRef.current.size > 80) {
      const activeIds = new Set(toasts.map((t) => t.id))
      notifiedIdsRef.current.forEach((id) => {
        if (!activeIds.has(id)) {
          notifiedIdsRef.current.delete(id)
        }
      })
    }
  }, [toasts])

  return null
}

/**
 * Shows server pushes that the service worker held back because this window
 * was visible. Pushes pointing at the current page are skipped, since that
 * page already toasts its own results — except toast-tagged ones (reminders),
 * which reuse the page's toast id and so merge into it instead of stacking.
 */
function PushToastBridge() {
  const router = useRouter()

  React.useEffect(() => {
    if (!("serviceWorker" in navigator)) return
    const container = navigator.serviceWorker

    const onMessage = (event: MessageEvent) => {
      const data = event.data as { type?: string; payload?: RelayedPush } | null
      if (data?.type !== PUSH_MESSAGE_TYPE || !data.payload) return

      const { title, body, url, tag, requireInteraction } = data.payload
      const toastId = tag?.startsWith(TOAST_TAG_PREFIX) ? tag.slice(TOAST_TAG_PREFIX.length) : undefined
      const target = new URL(url, window.location.origin)
      const samePage = target.pathname === window.location.pathname
      if (samePage && !toastId) return

      toast(title ?? "Singl", {
        id: toastId ?? tag,
        description: body || undefined,
        ...(requireInteraction && { duration: Infinity }),
        ...(!samePage && {
          action: {
            label: "Open",
            onClick: () => router.push(target.pathname + target.search + target.hash),
          },
        }),
      })
    }

    container.addEventListener("message", onMessage)
    container.startMessages()
    return () => container.removeEventListener("message", onMessage)
  }, [router])

  return null
}

const Toaster = ({ closeButton = true, ...props }: ToasterProps) => {
  const { theme = "system" } = useTheme()

  return (
    <>
      <Sonner
        theme={theme as ToasterProps["theme"]}
        className="toaster group"
        closeButton={closeButton}
        icons={{
          success: (
            <IconCircleCheck className="size-4" />
          ),
          info: (
            <IconInfoCircle className="size-4" />
          ),
          warning: (
            <IconAlertTriangle className="size-4" />
          ),
          error: (
            <IconAlertOctagon className="size-4" />
          ),
          loading: (
            <IconLoader className="size-4 animate-spin" />
          ),
        }}
        style={
          {
            "--normal-bg": "var(--popover)",
            "--normal-text": "var(--popover-foreground)",
            "--normal-border": "var(--border)",
            "--border-radius": "var(--radius)",
          } as React.CSSProperties
        }
        toastOptions={{
          classNames: {
            toast: "cn-toast",
          },
        }}
        {...props}
      />
      <SystemToastBridge />
      <PushToastBridge />
    </>
  )
}

export { Toaster }
