"use client"

import { useEffect, useMemo, useState } from "react"
import { IconExternalLink, IconRefresh, IconSearch, IconTrash } from "@tabler/icons-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { Spinner } from "@/components/ui/spinner"
import { MessageList } from "@/components/assistant/messages"
import { assistantChatGet, type Chat } from "@/lib/assistant/api"
import { askConfirm } from "@/lib/confirm"
import { errorMessage } from "@/lib/settings"
import { deleteUiChats, listUiChats, type UiTestChat } from "@/lib/ui-tests"
import { cn } from "@/lib/utils"
import { CaseStatusChip, duration, formatMs } from "./shared"

const STATUSES = [
  ["all", "All statuses"],
  ["passed", "Passed"],
  ["failed", "Failed / error"],
  ["needsReview", "Needs review"],
  ["running", "Running"],
] as const

const matchesStatus = (c: UiTestChat, f: string) =>
  f === "all" || (f === "failed" ? c.status === "failed" || c.status === "error" : c.status === f)

/**
 * The chats test runs left (one per case per run), kept out of the assistant's
 * chat list. Filter by suite, run, status and text; read the transcript beside the list.
 */
export function ChatsTab({
  suiteId,
  version,
  picked,
  onPick,
  onOpenInAssistant,
}: {
  suiteId: string
  /** Changes when runs finish, to reload the list. */
  version: string
  /** Chat shown on the right ("Open transcript" elsewhere on the page sets it). */
  picked: string
  onPick: (chatId: string) => void
  onOpenInAssistant: (chatId: string) => void
}) {
  const [scope, setScope] = useState<"suite" | "all">("suite")
  const [chats, setChats] = useState<UiTestChat[] | null>(null)
  const [reload, setReload] = useState(0)
  const [search, setSearch] = useState("")
  const [status, setStatus] = useState("all")
  const [runId, setRunId] = useState("all")
  const [checked, setChecked] = useState<Set<string>>(new Set())
  const [deleting, setDeleting] = useState(false)
  const [transcript, setTranscript] = useState<Chat | null>(null)

  useEffect(() => {
    let cancelled = false
    listUiChats(scope === "suite" ? suiteId : null)
      .then((c) => !cancelled && setChats(c))
      .catch((e) => !cancelled && toast.error(errorMessage(e)))
    return () => {
      cancelled = true
    }
  }, [scope, suiteId, version, reload])

  // Runs to filter by: the ones the loaded chats belong to, newest first.
  const runs = useMemo(() => {
    const m = new Map<string, { id: string; at: number | null; suite: string }>()
    for (const c of chats ?? []) if (c.runId && !m.has(c.runId)) m.set(c.runId, { id: c.runId, at: c.runStartedAt, suite: c.suiteName })
    return [...m.values()].sort((a, b) => (b.at ?? 0) - (a.at ?? 0))
  }, [chats])
  const run = runs.some((r) => r.id === runId) || runId === "none" ? runId : "all"

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase()
    return (chats ?? []).filter(
      (c) =>
        matchesStatus(c, status) &&
        (run === "all" || (run === "none" ? !c.runId : c.runId === run)) &&
        (!q || [c.caseTitle, c.title, c.reason, c.suiteName].some((s) => s.toLowerCase().includes(q))),
    )
  }, [chats, search, status, run])

  const activeId = shown.some((c) => c.chatId === picked) ? picked : (shown[0]?.chatId ?? "")
  useEffect(() => {
    if (!activeId) return
    let cancelled = false
    assistantChatGet(activeId)
      .then((c) => !cancelled && setTranscript(c))
      .catch((e) => !cancelled && toast.error(errorMessage(e)))
    return () => {
      cancelled = true
    }
  }, [activeId, version])

  const marked = shown.filter((c) => checked.has(c.chatId))
  const allChecked = shown.length > 0 && marked.length === shown.length
  const toggle = (id: string, on: boolean) =>
    setChecked((s) => {
      const next = new Set(s)
      if (on) next.add(id)
      else next.delete(id)
      return next
    })

  const remove = async (ids: string[]) => {
    if (ids.length === 0) return
    if (ids.some((id) => chats?.find((c) => c.chatId === id)?.status === "running")) {
      toast.error("A chat of the run going now can't be deleted.")
      return
    }
    const what = ids.length === 1 ? "this chat" : `${ids.length} chats`
    if (!(await askConfirm(`Delete ${what}? Runs keep their results, but "Open transcript" stops working for them.`))) return
    setDeleting(true)
    try {
      const n = await deleteUiChats(ids)
      setChecked((s) => new Set([...s].filter((id) => !ids.includes(id))))
      toast.success(n === 1 ? "Chat deleted" : `${n} chats deleted`)
      setReload((r) => r + 1)
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setDeleting(false)
    }
  }

  if (chats === null) return <div className="p-6"><Spinner /></div>

  const current = shown.find((c) => c.chatId === activeId)
  const t = transcript?.id === activeId ? transcript : null
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b px-3 py-1.5">
        <div className="relative">
          <IconSearch className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input className="h-6 w-48 pl-7 text-xs" placeholder="Search case, title, reason" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <NativeSelect size="sm" className="w-32" value={scope} onChange={(e) => setScope(e.target.value as "suite" | "all")} aria-label="Suite">
          <NativeSelectOption value="suite">This suite</NativeSelectOption>
          <NativeSelectOption value="all">All suites</NativeSelectOption>
        </NativeSelect>
        <NativeSelect size="sm" className="w-48" value={run} onChange={(e) => setRunId(e.target.value)} aria-label="Run">
          <NativeSelectOption value="all">All runs</NativeSelectOption>
          {runs.map((r) => (
            <NativeSelectOption key={r.id} value={r.id}>
              {formatMs(r.at)}{scope === "all" && r.suite ? ` · ${r.suite}` : ""}
            </NativeSelectOption>
          ))}
          <NativeSelectOption value="none">Not in run history</NativeSelectOption>
        </NativeSelect>
        <NativeSelect size="sm" className="w-32" value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status">
          {STATUSES.map(([v, l]) => (
            <NativeSelectOption key={v} value={v}>{l}</NativeSelectOption>
          ))}
        </NativeSelect>
        <Button size="xs" variant="ghost" title="Reload" onClick={() => setReload((r) => r + 1)}>
          <IconRefresh />
        </Button>
      </div>

      {chats.length === 0 ? (
        <p className="p-6 text-center text-xs text-muted-foreground">No test chats yet. Each case of a run gets its own chat, listed here.</p>
      ) : (
        <div className="grid min-h-0 flex-1 grid-cols-[20rem_1fr]">
          <div className="flex min-h-0 flex-col border-r">
            <div className="flex items-center gap-2 border-b px-2.5 py-1.5 text-xs">
              <Checkbox
                checked={allChecked}
                onCheckedChange={(on) => setChecked(on ? new Set(shown.map((c) => c.chatId)) : new Set())}
                aria-label="Select all shown chats"
              />
              <span className="text-muted-foreground">
                {marked.length > 0 ? `${marked.length} selected` : `${shown.length} of ${chats.length} chats`}
              </span>
              <Button
                size="xs"
                variant="ghost"
                className="ml-auto text-destructive"
                disabled={marked.length === 0 || deleting}
                onClick={() => remove(marked.map((c) => c.chatId))}
              >
                <IconTrash /> Delete
              </Button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
              {shown.length === 0 && <p className="p-4 text-center text-xs text-muted-foreground">No chats match the filters.</p>}
              {shown.map((c) => (
                <div
                  key={c.chatId}
                  className={cn("group mb-0.5 flex items-start gap-2 rounded-md px-2 py-1.5 hover:bg-muted", c.chatId === activeId && "bg-muted")}
                >
                  <Checkbox className="mt-0.5" checked={checked.has(c.chatId)} onCheckedChange={(on) => toggle(c.chatId, !!on)} aria-label="Select chat" />
                  <button
                    type="button"
                    onClick={() => onPick(c.chatId)}
                    className="min-w-0 flex-1 rounded-sm text-left text-xs focus-visible:ring-2 focus-visible:ring-ring/30 focus-visible:outline-none"
                  >
                    <span className="flex items-center justify-between gap-2">
                      <span className="truncate font-medium">{c.caseTitle || c.title}</span>
                      {c.status && <CaseStatusChip status={c.status} />}
                    </span>
                    <span className="block truncate text-[11px] text-muted-foreground">
                      {formatMs(c.runStartedAt ?? c.createdAt)}
                      {scope === "all" && ` · ${c.suiteName || "No suite"}`} · {c.messageCount} msgs
                    </span>
                  </button>
                  <button
                    type="button"
                    title="Delete this chat"
                    disabled={deleting}
                    onClick={() => remove([c.chatId])}
                    className="invisible mt-0.5 rounded-sm text-muted-foreground group-hover:visible hover:text-destructive focus-visible:visible focus-visible:ring-2 focus-visible:ring-ring/30 focus-visible:outline-none"
                  >
                    <IconTrash className="size-3.5" />
                  </button>
                </div>
              ))}
            </div>
          </div>

          <div className="flex min-h-0 flex-col">
            {current && (
              <div className="flex flex-wrap items-center gap-2 border-b px-3 py-1.5 text-xs">
                <span className="min-w-0 flex-1 truncate font-medium">{current.caseTitle || current.title}</span>
                {current.status && <CaseStatusChip status={current.status} />}
                <span className="text-[11px] text-muted-foreground">{duration(current.durationMs)}</span>
                <Button size="xs" variant="outline" onClick={() => onOpenInAssistant(current.chatId)}>
                  <IconExternalLink /> Open in Assistant
                </Button>
              </div>
            )}
            {current?.reason && <p className="border-b px-3 py-1.5 text-xs text-muted-foreground">{current.reason}</p>}
            <div className="min-h-0 flex-1 overflow-y-auto p-3">
              {activeId && !t && <Spinner />}
              {t && (
                <MessageList messages={t.messages} streaming="" running={false} runningProvider={null} liveCalls={{}} />
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
