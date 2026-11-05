"use client"

import { useRef } from "react"
import { open as openDialog, type DialogFilter } from "@tauri-apps/plugin-dialog"
import { IconFile, IconFolder } from "@tabler/icons-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"

type PathInputProps = Omit<React.ComponentProps<typeof Input>, "type"> & {
  /** Pick a folder rather than a file. */
  directory?: boolean
  filters?: DialogFilter[]
  dialogTitle?: string
  /** A pick inside this folder is written as "./sub/path", the way relative settings are stored. */
  baseDir?: string
  /** Called with the picked path. Required when the input is controlled. */
  onPick?: (path: string) => void
}

function relativeTo(baseDir: string | undefined, path: string) {
  if (!baseDir) return path
  const base = baseDir.replace(/[\\/]+$/, "")
  // Windows paths compare case-insensitively.
  if (path.toLowerCase() === base.toLowerCase()) return "."
  if (!path.toLowerCase().startsWith(`${base.toLowerCase()}\\`) && !path.toLowerCase().startsWith(`${base.toLowerCase()}/`)) {
    return path
  }
  return `./${path.slice(base.length + 1).replace(/\\/g, "/")}`
}

function absoluteFrom(baseDir: string | undefined, path: string) {
  if (!path || !baseDir || /^([a-zA-Z]:|[\\/])/.test(path)) return path || baseDir || undefined
  return `${baseDir.replace(/[\\/]+$/, "")}\\${path.replace(/^\.[\\/]?/, "").replace(/\//g, "\\")}`
}

/** A text input for a path with a Browse… button that opens the native file or folder picker. */
export function PathInput({ directory, filters, dialogTitle, baseDir, onPick, className, ...props }: PathInputProps) {
  const inputRef = useRef<HTMLInputElement>(null)

  async function browse() {
    const current = inputRef.current?.value.trim() ?? ""
    const picked = await openDialog({
      directory,
      filters,
      title: dialogTitle ?? (directory ? "Choose a folder" : "Choose a file"),
      defaultPath: absoluteFrom(baseDir, current),
    })
    if (typeof picked !== "string") return
    const path = relativeTo(baseDir, picked)
    if (onPick) {
      onPick(path)
    } else if (inputRef.current) {
      inputRef.current.value = path
    }
  }

  const Icon = directory ? IconFolder : IconFile
  return (
    <div className="flex gap-2">
      {/* Base UI warns when an uncontrolled input's defaultValue changes, as it does
          when settings reload after a save, so a new default gets a fresh input. */}
      <Input
        key={props.value === undefined ? String(props.defaultValue ?? "") : undefined}
        ref={inputRef}
        className={cn("h-8 font-mono text-xs", className)}
        {...props}
      />
      <Button type="button" variant="outline" size="lg" onClick={browse} disabled={props.disabled}>
        <Icon className="size-3.5" />
        Browse…
      </Button>
    </div>
  )
}
