"use client"

// The test agent's inputs: instructions added to every case of the next run
// (remembered per suite), and, while a case runs, a box to guide it live.

import { useState } from "react"
import { IconChevronDown, IconChevronRight, IconMessage, IconSend } from "@tabler/icons-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { assistantSteer } from "@/lib/assistant/api"
import type { UiTestCase } from "@/lib/ui-tests"

const key = (suiteId: string) => `appTests.instructions.${suiteId}`

/** The saved run instructions of a suite ("" if none). */
export function runInstructions(suiteId: string): string {
  try {
    return localStorage.getItem(key(suiteId)) ?? ""
  } catch {
    return ""
  }
}

function saveInstructions(suiteId: string, text: string) {
  try {
    if (text.trim()) localStorage.setItem(key(suiteId), text)
    else localStorage.removeItem(key(suiteId))
  } catch {}
}

export function AgentPanel({ suiteId, runningHere, cases }: { suiteId: string; runningHere: boolean; cases: UiTestCase[] }) {
  const [text, setText] = useState(() => runInstructions(suiteId))
  const [open, setOpen] = useState(() => !!runInstructions(suiteId))
  const [guide, setGuide] = useState("")
  const current = runningHere ? cases.find((c) => c.status === "running" && c.chatId) : undefined

  const send = async () => {
    const msg = guide.trim()
    if (!msg || !current) return
    try {
      if (await assistantSteer(current.chatId, msg)) {
        setGuide("")
        toast.success(`Sent to "${current.title}"`, { description: "The agent reads it before its next action." })
      } else {
        toast.error("The case is not taking messages right now. Try again in a moment.")
      }
    } catch (e) {
      toast.error(String(e))
    }
  }

  return (
    <div className="flex flex-col gap-1.5 border-b px-3 py-1.5 text-xs">
      <div className="flex items-center gap-2">
        <button type="button" className="flex items-center gap-1 font-medium text-muted-foreground hover:text-foreground rounded-sm focus-visible:ring-2 focus-visible:ring-ring/30 focus-visible:outline-none" onClick={() => setOpen(!open)}>
          {open ? <IconChevronDown className="size-3.5" /> : <IconChevronRight className="size-3.5" />}
          Instructions for the test agent
        </button>
        {!open && text.trim() && <span className="truncate text-muted-foreground">{text.trim().split("\n")[0]}</span>}
      </div>
      {open && (
        <textarea
          rows={3}
          value={text}
          placeholder={"Added to every case of the next run. For example:\n- Use container Dresden\n- Wait for the grid spinner to finish before checking results"}
          onChange={(e) => {
            setText(e.target.value)
            saveInstructions(suiteId, e.target.value)
          }}
          className="w-full resize-y rounded-md border border-input bg-input/20 px-2 py-1 text-xs outline-none focus:border-ring dark:bg-input/30"
        />
      )}
      {current && (
        <div className="flex items-center gap-2 rounded-md border border-primary/40 bg-primary/5 px-2 py-1">
          <IconMessage className="size-3.5 shrink-0 text-primary" />
          <span className="shrink-0 font-medium">Guide &ldquo;{current.title}&rdquo;</span>
          <Input
            className="h-6 flex-1 text-xs"
            placeholder="e.g. The tile is under the More menu, click that first"
            value={guide}
            onChange={(e) => setGuide(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void send()
            }}
          />
          <Button size="xs" onClick={() => void send()} disabled={!guide.trim()}>
            <IconSend /> Send
          </Button>
        </div>
      )}
    </div>
  )
}
