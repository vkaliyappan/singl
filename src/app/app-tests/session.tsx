"use client"

import { useCallback, useEffect, useState } from "react"
import { IconAlertTriangle, IconCircleCheck, IconLoader2, IconLock, IconLockOpen } from "@tabler/icons-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { errorMessage } from "@/lib/settings"
import {
  uiSessionCheck, uiSessionClear, uiSessionLoginCancel, uiSessionLoginFinish, uiSessionLoginStart, uiSessionStatus,
  type UiSessionStatus,
} from "@/lib/ui-tests"
import { cn } from "@/lib/utils"
import { formatMs } from "./shared"
import { askConfirm } from "@/lib/confirm"

type Act = (name: string, fn: (env: string) => Promise<UiSessionStatus>, okMessage?: string) => Promise<void>

/** Saved ThingWorx SSO session of an environment: status plus login / check / sign-out actions. */
export function useSession(envId: string) {
  const [status, setStatus] = useState<UiSessionStatus | null>(null)
  const [busy, setBusy] = useState("")

  const refresh = useCallback(() => {
    if (!envId) return setStatus(null)
    uiSessionStatus(envId).then(setStatus).catch((e) => toast.error(errorMessage(e)))
  }, [envId])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setStatus(null)
    refresh()
  }, [refresh])

  const act: Act = async (name, fn, okMessage) => {
    setBusy(name)
    try {
      const next = await fn(envId)
      setStatus(next)
      if (okMessage) toast.success(okMessage)
      else if (next.message && name === "check") toast(next.message)
    } catch (e) {
      toast.error(errorMessage(e))
      refresh()
    } finally {
      setBusy("")
    }
  }

  return { status, busy, act }
}

type SessionState = ReturnType<typeof useSession>

function chipLook(status: UiSessionStatus | null): { label: string; tone: string; icon: React.ReactNode } {
  if (!status) return { label: "Session…", tone: "bg-muted text-muted-foreground", icon: <IconLock className="size-3" /> }
  if (status.loginOpen)
    return { label: "Logging in", tone: "bg-info/15 text-info", icon: <IconLockOpen className="size-3" /> }
  if (!status.exists)
    return { label: "Log in", tone: "bg-warning/15 text-warning", icon: <IconAlertTriangle className="size-3" /> }
  if (status.valid === false)
    return { label: "Session expired", tone: "bg-warning/15 text-warning", icon: <IconAlertTriangle className="size-3" /> }
  if (status.valid)
    return { label: "Session valid", tone: "bg-success/15 text-success", icon: <IconCircleCheck className="size-3" /> }
  return { label: "Session saved", tone: "bg-muted text-foreground", icon: <IconLock className="size-3" /> }
}

/** Compact session status chip; the popover holds the login actions. */
export function SessionChip({ envId, session }: { envId: string; session: SessionState }) {
  const { status, busy, act } = session
  const look = chipLook(status)
  const loginOpen = !!status?.loginOpen

  return (
    <Popover>
      <PopoverTrigger
        render={<button type="button" />}
        title="ThingWorx login session"
        className={cn(
          "inline-flex h-6 items-center gap-1 rounded-full px-2.5 text-[11px] font-medium whitespace-nowrap",
          look.tone,
        )}
      >
        {busy ? <IconLoader2 className="size-3 animate-spin" /> : look.icon}
        {look.label}
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 gap-2.5 p-3">
        <div className="flex flex-col gap-0.5">
          <span className="font-medium">ThingWorx session · {envId}</span>
          <span className="text-muted-foreground">
            {status?.exists
              ? `Saved ${formatMs(status.savedAt)} · verified ${formatMs(status.verifiedAt)}`
              : "No saved session. Log in once; tests reuse it."}
          </span>
          {status?.message && <span className="text-muted-foreground">{status.message}</span>}
        </div>
        {loginOpen && <p className="text-muted-foreground">Complete SSO in the opened browser window, then click Finish.</p>}
        <div className="flex flex-wrap gap-1.5">
          {loginOpen ? (
            <>
              <Button size="sm" disabled={!!busy} onClick={() => act("finish", uiSessionLoginFinish, "Session saved")}>
                {busy === "finish" && <IconLoader2 className="animate-spin" />} Finish login
              </Button>
              <Button size="sm" variant="outline" disabled={!!busy} onClick={() => act("cancel", uiSessionLoginCancel)}>
                Cancel
              </Button>
            </>
          ) : (
            <Button size="sm" variant="outline" disabled={!!busy} onClick={() => act("login", uiSessionLoginStart)}>
              {busy === "login" && <IconLoader2 className="animate-spin" />} Log in
            </Button>
          )}
          <Button size="sm" variant="outline" disabled={!!busy || loginOpen || !status?.exists} onClick={() => act("check", uiSessionCheck)}>
            {busy === "check" && <IconLoader2 className="animate-spin" />} Check
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={!!busy || loginOpen || !status?.exists}
            onClick={async () => {
              if (await askConfirm(`Sign out of ${envId}? The saved session is deleted.`)) void act("clear", uiSessionClear, "Signed out")
            }}
          >
            Sign out
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}
