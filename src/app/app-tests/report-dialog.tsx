"use client"

import { useEffect, useId, useState } from "react"
import { IconLoader2, IconX } from "@tabler/icons-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { formatTime, listRuns, type RunRow } from "@/lib/automation"
import { errorMessage } from "@/lib/settings"
import {
  generateUiReport, onUiReport, type UiReportFormat, type UiReportScreenshots, type UiTestSuite,
} from "@/lib/ui-tests"
import { cn } from "@/lib/utils"
import { ErrorNote } from "../automation/shared"

const PREPARED_KEY = "appTests.report.preparedBy"
const DIR_KEY = "appTests.report.lastDir"
const ITERATION_KEY = "appTests.report.iteration"
const TEMPLATE_KEY = "appTests.report.template"

const FORMATS: { value: UiReportFormat; label: string; filterName: string }[] = [
  { value: "docx", label: "Word (.docx)", filterName: "Word document" },
  { value: "pdf", label: "PDF", filterName: "PDF" },
  { value: "md", label: "Markdown (.md)", filterName: "Markdown" },
]

const EXT_RE = /\.(docx|pdf|md)$/i

function readStorage(key: string) {
  try {
    return localStorage.getItem(key) ?? ""
  } catch {
    return ""
  }
}

function writeStorage(key: string, value: string) {
  try {
    localStorage.setItem(key, value)
  } catch {
    // Storage can be blocked; the remembered value is only a convenience.
  }
}

/** Strips characters Windows does not allow in file names. */
function sanitizeFileName(name: string) {
  const cleaned = Array.from(name)
    .filter((c) => c.charCodeAt(0) >= 32)
    .join("")
    .replace(/[<>:"/\\|?*]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/, "")
  return cleaned || "Unit Test Document"
}

const folderOf = (path: string) => path.replace(/[\\/][^\\/]*$/, "")

/** Swaps the extension of a path for the chosen format's extension. */
function withExtension(path: string, format: UiReportFormat) {
  return EXT_RE.test(path) ? path.replace(EXT_RE, `.${format}`) : `${path}.${format}`
}

function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string
  value: T
  options: { value: T; label: string; disabled?: boolean; title?: string }[]
  onChange: (v: T) => void
}) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex flex-wrap gap-0.5 rounded-lg bg-muted p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          disabled={o.disabled}
          title={o.title}
          onClick={() => onChange(o.value)}
          className={cn(
            "h-6 rounded-md px-2.5 text-xs font-medium transition-colors disabled:pointer-events-none disabled:opacity-50",
            value === o.value ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

/**
 * Generate-test-document dialog. Mounted only while open, so every open starts
 * from fresh fields (the run preset comes from the caller).
 */
export function ReportDialog({
  suite,
  runId: initialRunId,
  selectedCaseIds,
  onClose,
}: {
  suite: UiTestSuite
  /** null = the latest run. */
  runId: string | null
  /** Cases selected in the grid; empty disables the "Selected cases" choice. */
  selectedCaseIds: string[]
  onClose: () => void
}) {
  const ids = useId()
  const [runs, setRuns] = useState<RunRow[]>([])
  const [runId, setRunId] = useState(initialRunId ?? "")
  const [scope, setScope] = useState<"all" | "selected">("all")
  const [format, setFormat] = useState<UiReportFormat>("docx")
  const [userStory, setUserStory] = useState("")
  const [iteration, setIteration] = useState(() => readStorage(ITERATION_KEY))
  const [title, setTitle] = useState(`${suite.name || "Test suite"} – Unit Test Document`)
  const [titleTouched, setTitleTouched] = useState(false)
  const [templatePath, setTemplatePath] = useState(() => readStorage(TEMPLATE_KEY))
  const [preparedBy, setPreparedBy] = useState(() => readStorage(PREPARED_KEY))
  const [screenshots, setScreenshots] = useState<UiReportScreenshots>("all")
  const [path, setPath] = useState("")
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState("")
  const [error, setError] = useState("")

  useEffect(() => {
    let cancelled = false
    listRuns("uitest", suite.id)
      .then((r) => !cancelled && setRuns(r))
      .catch((e) => !cancelled && setError(errorMessage(e)))
    return () => {
      cancelled = true
    }
  }, [suite.id])

  useEffect(() => {
    let alive = true
    let off: (() => void) | undefined
    onUiReport((p) => alive && setProgress(p.message))
      .then((u) => (alive ? (off = u) : u()))
      .catch(() => {})
    return () => {
      alive = false
      off?.()
    }
  }, [])

  const pickFormat = (f: UiReportFormat) => {
    setFormat(f)
    setPath((p) => (p ? withExtension(p, f) : p))
  }

  // Title follows the user story until the user edits Title by hand.
  const storyTitle = userStory.trim()
  const titleValue = titleTouched || !storyTitle ? title : storyTitle

  const browse = async () => {
    try {
      const { save } = await import("@tauri-apps/plugin-dialog")
      const dir = readStorage(DIR_KEY)
      const file = `${sanitizeFileName(storyTitle || titleValue)}.${format}`
      const dest = await save({
        title: "Save test document",
        defaultPath: dir ? `${dir.replace(/[\\/]+$/, "")}\\${file}` : file,
        filters: [{ name: FORMATS.find((f) => f.value === format)?.filterName ?? format, extensions: [format] }],
      })
      if (dest) setPath(dest)
    } catch (e) {
      setError(errorMessage(e))
    }
  }

  const browseTemplate = async () => {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog")
      const picked = await open({
        title: "Choose style template",
        multiple: false,
        directory: false,
        filters: [{ name: "Word document", extensions: ["docx"] }],
      })
      if (typeof picked === "string") {
        setTemplatePath(picked)
        writeStorage(TEMPLATE_KEY, picked)
      }
    } catch (e) {
      setError(errorMessage(e))
    }
  }

  const clearTemplate = () => {
    setTemplatePath("")
    writeStorage(TEMPLATE_KEY, "")
  }

  const generate = async () => {
    setBusy(true)
    setError("")
    setProgress("Starting")
    writeStorage(PREPARED_KEY, preparedBy.trim())
    writeStorage(ITERATION_KEY, iteration.trim())
    try {
      const r = await generateUiReport({
        suiteId: suite.id,
        runId: runId || null,
        caseIds: scope === "selected" ? selectedCaseIds : null,
        format,
        path,
        title: titleValue.trim(),
        preparedBy: preparedBy.trim(),
        screenshots,
        userStory: storyTitle,
        iteration: iteration.trim(),
        // The template only applies to Word; a stale one is not sent for other formats.
        templatePath: format === "docx" ? templatePath : "",
      })
      writeStorage(DIR_KEY, folderOf(path))
      toast.success("Document created", { description: r.path })
      onClose()
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  const hasSelection = selectedCaseIds.length > 0

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose()
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Generate test document</DialogTitle>
          <DialogDescription>Write the run&apos;s results and step evidence to a document.</DialogDescription>
        </DialogHeader>

        <fieldset disabled={busy} className="contents">
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${ids}-run`}>Run</Label>
              <NativeSelect className="w-full" id={`${ids}-run`} value={runId} onChange={(e) => setRunId(e.target.value)}>
                <NativeSelectOption value="">Latest run</NativeSelectOption>
                {runs.map((r) => (
                  <NativeSelectOption key={r.id} value={r.id}>
                    {formatTime(r.startedAt)} · {r.summary}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label>Cases</Label>
              <Segmented
                label="Cases"
                value={scope}
                onChange={setScope}
                options={[
                  { value: "all", label: "All cases in the run" },
                  {
                    value: "selected",
                    label: `Selected cases${hasSelection ? ` (${selectedCaseIds.length})` : ""}`,
                    disabled: !hasSelection,
                    title: hasSelection ? undefined : "Select cases in the grid first",
                  },
                ]}
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label>Format</Label>
              <Segmented label="Format" value={format} onChange={pickFormat} options={FORMATS} />
            </div>

            {format === "docx" && (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={`${ids}-template`}>Style template (optional)</Label>
                <div className="flex items-center gap-1.5">
                  <Input
                    id={`${ids}-template`}
                    readOnly
                    className="min-w-0 flex-1 text-xs"
                    value={templatePath}
                    placeholder="Default styles"
                  />
                  <Button size="sm" variant="outline" onClick={browseTemplate}>
                    Browse…
                  </Button>
                  {templatePath && (
                    <Button size="icon-sm" variant="ghost" onClick={clearTemplate} aria-label="Clear style template" title="Clear style template">
                      <IconX />
                    </Button>
                  )}
                </div>
                <p className="text-[11px] text-muted-foreground">Uses the fonts and styles of an existing unit test document.</p>
              </div>
            )}

            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={`${ids}-story`}>User story</Label>
                <Input
                  id={`${ids}-story`}
                  className="text-xs"
                  value={userStory}
                  placeholder="e.g. US 27432 - Feature Group Column"
                  onChange={(e) => setUserStory(e.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={`${ids}-iteration`}>Iteration</Label>
                <Input
                  id={`${ids}-iteration`}
                  className="text-xs"
                  value={iteration}
                  placeholder="e.g. 1.18"
                  onChange={(e) => setIteration(e.target.value)}
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={`${ids}-title`}>Title</Label>
                <Input
                  id={`${ids}-title`}
                  className="text-xs"
                  value={titleValue}
                  onChange={(e) => {
                    setTitle(e.target.value)
                    setTitleTouched(true)
                  }}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={`${ids}-by`}>Prepared by</Label>
                <Input id={`${ids}-by`} className="text-xs" value={preparedBy} onChange={(e) => setPreparedBy(e.target.value)} />
              </div>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label>Screenshots</Label>
              <Segmented
                label="Screenshots"
                value={screenshots}
                onChange={setScreenshots}
                options={[
                  { value: "all", label: "All steps" },
                  { value: "failed", label: "Failed steps only" },
                  { value: "none", label: "None" },
                ]}
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${ids}-path`}>Location</Label>
              <div className="flex items-center gap-1.5">
                <Input
                  id={`${ids}-path`}
                  readOnly
                  className="min-w-0 flex-1 text-xs"
                  value={path}
                  placeholder="No location chosen"
                />
                <Button size="sm" variant="outline" onClick={browse}>
                  Browse…
                </Button>
              </div>
              {format === "md" && (
                <p className="text-[11px] text-muted-foreground">Screenshots are saved in a folder next to the file.</p>
              )}
            </div>
          </div>
        </fieldset>

        <ErrorNote message={error} />
        {busy && (
          <p className="flex items-center gap-2 text-xs text-muted-foreground" role="status">
            <IconLoader2 className="size-3.5 shrink-0 animate-spin" />
            <span className="truncate">{progress || "Working"}</span>
          </p>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={generate} disabled={busy || !path || !titleValue.trim()}>
            {busy && <IconLoader2 className="animate-spin" />} Generate
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
