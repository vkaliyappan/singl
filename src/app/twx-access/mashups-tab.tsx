"use client"

import { useEffect, useState } from "react"
import { IconCopy, IconExternalLink } from "@tabler/icons-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { DataGrid, type GridColumn } from "@/components/data-grid"
import { Spinner } from "@/components/ui/spinner"
import { errorMessage } from "@/lib/settings"
import { useAssistantAction, useAssistantContext } from "@/lib/assistant/context"
import { listMashups, mashupRuntimeUrl, previewMashup, type MashupInfo } from "@/lib/twx-access"

function modified(v: MashupInfo["lastModified"]): string {
  if (v === null || v === "") return ""
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? String(v) : d.toLocaleString()
}

export function MashupsTab({ env, baseUrl }: { env: string; baseUrl: string }) {
  const [rows, setRows] = useState<MashupInfo[] | null>(null)
  const [error, setError] = useState("")

  useEffect(() => {
    listMashups(env)
      .then(setRows)
      .catch((err) => setError(errorMessage(err)))
  }, [env])

  async function copy(name: string) {
    try {
      await navigator.clipboard.writeText(mashupRuntimeUrl(baseUrl, name))
      toast.success("Runtime URL copied")
    } catch {
      toast.error("Could not copy to the clipboard")
    }
  }

  async function preview(name: string) {
    try {
      await previewMashup(baseUrl, name)
    } catch (err) {
      toast.error(errorMessage(err))
    }
  }

  useAssistantContext({
    screen: "twx-access",
    data: {
      mashups: {
        count: rows?.length ?? null,
        names: rows?.slice(0, 20).map((m) => m.name),
        error,
      },
    },
  })
  useAssistantAction(
    "open_mashup_preview",
    {
      description: "Open a mashup in its own window (runtime preview; the user signs in there). Read-only.",
      inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
    },
    async (args) => {
      const name = String((args as { name?: string }).name ?? "")
      if (rows && !rows.some((m) => m.name === name)) throw new Error(`No mashup "${name}" on ${env}.`)
      await previewMashup(baseUrl, name)
      return { opened: name }
    },
  )

  if (error) return <p className="pt-2 text-xs text-red-700 dark:text-red-400">{error}</p>
  if (!rows)
    return (
      <div className="flex items-center gap-2 pt-2 text-xs text-muted-foreground">
        <Spinner /> Loading mashups...
      </div>
    )

  const columns: GridColumn<MashupInfo>[] = [
    {
      key: "name",
      label: "Mashup",
      kind: "text",
      width: 320,
      render: (m) => (
        <div>
          <div className="font-mono">{m.name}</div>
          {m.description && <div className="max-w-md truncate text-muted-foreground">{m.description}</div>}
        </div>
      ),
    },
    { key: "description", label: "Description", kind: "text", width: 260, hidden: true },
    { key: "project", label: "Project", kind: "text", width: 180 },
    {
      key: "lastModified",
      label: "Modified",
      kind: "date",
      width: 170,
      render: (m) => <span className="whitespace-nowrap">{modified(m.lastModified)}</span>,
    },
    {
      key: "actions",
      label: "Actions",
      kind: "none",
      width: 250,
      render: (m) => (
        <div className="flex gap-1.5">
          <Button size="sm" onClick={() => void preview(m.name)}>
            <IconExternalLink /> Preview
          </Button>
          <Button size="sm" variant="outline" onClick={() => void copy(m.name)}>
            <IconCopy /> Copy runtime URL
          </Button>
        </div>
      ),
    },
  ]

  return (
    <div className="flex flex-col gap-3 pt-2">
      <p className="text-xs text-muted-foreground">
        Preview opens the mashup in a new window. You sign in there; singl never sends its app key.
      </p>
      <DataGrid
        id="access-mashups"
        columns={columns}
        rows={rows}
        rowKey={(m) => m.name}
        searchPlaceholder="Search by name, description or project"
        initialSort={{ key: "name" }}
        pageSize={50}
        csvName="mashups"
        emptyText="No mashups"
      />
    </div>
  )
}
