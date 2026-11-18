"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { IconAlertTriangle, IconChevronDown, IconChevronRight, IconFolderOpen, IconHistory, IconUpload } from "@tabler/icons-react"
import { PageHeader } from "@/components/page-header"
import { DiffView } from "@/components/assistant/rich/diff-view"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { Spinner } from "@/components/ui/spinner"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { listEntityFiles } from "@/lib/entities"
import { errorMessage } from "@/lib/settings"
import {
  listImportBackups,
  openImportBackup,
  previewImport,
  restoreImportBackup,
  runImport,
  type ImportBackup,
  type ImportPreviewItem,
  type ImportResult,
} from "@/lib/twx-import"
import { cn } from "@/lib/utils"

const MAX_LISTED = 200

const isProd = (env: string) => env.toLowerCase().includes("prod")

function status(item: ImportPreviewItem) {
  if (item.error) return { label: "Error", variant: "destructive" as const }
  if (!item.existsOnServer) return { label: "New", variant: "default" as const }
  if (item.changed) return { label: "Changed", variant: "secondary" as const }
  return { label: "Unchanged", variant: "outline" as const }
}

type Confirm = { kind: "import"; files: string[] } | { kind: "restore"; backup: ImportBackup }

const toggle = (set: Set<string>, path: string, on: boolean) => {
  const next = new Set(set)
  if (on) next.add(path)
  else next.delete(path)
  return next
}

export function TwxImport({ envs, workspaceRoot }: { envs: string[]; workspaceRoot: string }) {
  const [env, setEnv] = useState(envs[0] ?? "")
  const [available, setAvailable] = useState<string[]>([])
  const [filter, setFilter] = useState("")
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [preview, setPreview] = useState<ImportPreviewItem[] | null>(null)
  const [chosen, setChosen] = useState<Set<string>>(new Set())
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState<"" | "preview" | "import">("")
  const [progress, setProgress] = useState<string[]>([])
  const [result, setResult] = useState<ImportResult | null>(null)
  const [backups, setBackups] = useState<ImportBackup[]>([])
  const [confirm, setConfirm] = useState<Confirm | null>(null)
  const [error, setError] = useState("")

  const reloadBackups = useCallback(() => listImportBackups(env).then(setBackups).catch(() => setBackups([])), [env])

  useEffect(() => {
    if (!env) return
    let live = true
    listEntityFiles(env)
      .then((all) => {
        if (live) setAvailable(all.filter((f) => f.toLowerCase().endsWith(".xml")).map((f) => `${env}/${f}`))
      })
      .catch(() => live && setAvailable([]))
    listImportBackups(env)
      .then((b) => live && setBackups(b))
      .catch(() => live && setBackups([]))
    return () => {
      live = false
    }
  }, [env])

  const changeEnv = (next: string) => {
    setEnv(next)
    setPicked(new Set())
    setPreview(null)
    setResult(null)
    setError("")
  }

  const rows = useMemo(() => {
    const q = filter.trim().toLowerCase()
    const matches = available.filter((f) => !picked.has(f) && (!q || f.toLowerCase().includes(q)))
    // Picked files first, so a selection stays visible while filtering.
    return { list: [...picked, ...matches.slice(0, MAX_LISTED)], more: matches.length > MAX_LISTED }
  }, [available, filter, picked])

  const browse = async () => {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog")
      const prefix = `${workspaceRoot.replace(/\\/g, "/")}/twx-entities/`
      const sel = await open({
        multiple: true,
        defaultPath: `${prefix}${env}`,
        filters: [{ name: "Entity XML", extensions: ["xml"] }],
      })
      if (!sel) return
      const rels: string[] = []
      for (const abs of Array.isArray(sel) ? sel : [sel]) {
        const norm = abs.replace(/\\/g, "/")
        if (norm.toLowerCase().startsWith(prefix.toLowerCase()) && norm.slice(prefix.length).startsWith(`${env}/`)) {
          rels.push(norm.slice(prefix.length))
        }
      }
      if (rels.length < (Array.isArray(sel) ? sel.length : 1)) {
        setError(`Only files inside twx-entities/${env} can be imported; the others were skipped.`)
      }
      setPicked((p) => new Set([...p, ...rels]))
    } catch (err) {
      setError(errorMessage(err))
    }
  }

  const runPreview = async () => {
    setBusy("preview")
    setError("")
    setResult(null)
    try {
      const items = await previewImport(env, [...picked])
      setPreview(items)
      setChosen(new Set(items.filter((i) => !i.error && (i.changed || !i.existsOnServer)).map((i) => i.path)))
      setExpanded(new Set())
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy("")
    }
  }

  const finish = async (run: Promise<ImportResult>) => {
    setBusy("import")
    setError("")
    setProgress([])
    try {
      setResult(await run)
      await reloadBackups()
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy("")
    }
  }

  const onConfirm = () => {
    const c = confirm
    setConfirm(null)
    if (!c) return
    const log = (line: string) => setProgress((p) => [...p, line])
    if (c.kind === "import") void finish(runImport(env, c.files, log))
    else void finish(restoreImportBackup(env, c.backup.dir, log))
  }

  const chosenFiles = preview?.filter((i) => chosen.has(i.path)).map((i) => i.path) ?? []
  const prod = isProd(env)
  const failed = result?.results.filter((r) => !r.ok).length ?? 0
  const count = (n: number) => `${n} ${n === 1 ? "entity" : "entities"}`

  return (
    <div className="flex flex-col gap-5 p-8">
      <PageHeader
        title="TWX Import"
        description="Import entity XML from twx-entities into a ThingWorx server. The server's current versions are backed up first."
      />

      <div className="flex items-center gap-2 text-xs">
        <span className="text-muted-foreground">Environment</span>
        <NativeSelect value={env} onChange={(e) => changeEnv(e.target.value)} disabled={busy !== ""}>
          {envs.map((e) => (
            <NativeSelectOption key={e} value={e}>
              {e}
            </NativeSelectOption>
          ))}
        </NativeSelect>
        {prod && <Badge variant="destructive">Production</Badge>}
      </div>

      <section className="flex flex-col gap-2 rounded-xl border bg-card p-4">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-medium">Entity files</h2>
          <span className="text-xs text-muted-foreground">{picked.size} selected</span>
          <div className="ml-auto flex items-center gap-2">
            <Input className="w-60" placeholder="Filter files" value={filter} onChange={(e) => setFilter(e.target.value)} />
            <Button size="sm" variant="outline" onClick={browse} disabled={busy !== ""}>
              Browse…
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setPicked(new Set())} disabled={picked.size === 0}>
              Clear
            </Button>
          </div>
        </div>
        <div className="max-h-56 overflow-auto rounded-md border">
          {rows.list.length === 0 && (
            <p className="p-3 text-xs text-muted-foreground">
              {available.length === 0 ? `No XML files under twx-entities/${env}.` : "No file matches."}
            </p>
          )}
          {rows.list.map((f) => (
            <label key={f} className="flex cursor-pointer items-center gap-2 px-3 py-1 text-xs hover:bg-muted/50">
              <Checkbox checked={picked.has(f)} onCheckedChange={(on) => setPicked((p) => toggle(p, f, on))} />
              <span className="truncate">{f.slice(env.length + 1)}</span>
            </label>
          ))}
        </div>
        {rows.more && <p className="text-[0.7rem] text-muted-foreground">Showing the first {MAX_LISTED} matches. Filter to narrow down.</p>}
        <div>
          <Button size="sm" onClick={runPreview} disabled={picked.size === 0 || busy !== ""}>
            {busy === "preview" ? <Spinner /> : null}
            Preview
          </Button>
        </div>
      </section>

      {error && <p className="rounded-xl border border-destructive/40 bg-destructive/10 px-4 py-3 text-xs text-destructive">{error}</p>}

      {preview && (
        <section className="flex flex-col gap-2 rounded-xl border bg-card p-4">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-medium">Preview</h2>
            <span className="text-xs text-muted-foreground">
              {preview.filter((i) => !i.error && !i.existsOnServer).length} new,{" "}
              {preview.filter((i) => !i.error && i.existsOnServer && i.changed).length} changed,{" "}
              {preview.filter((i) => !i.error && i.existsOnServer && !i.changed).length} unchanged
            </span>
            <Button
              size="sm"
              className="ml-auto"
              variant={prod ? "destructive" : "default"}
              disabled={chosenFiles.length === 0 || busy !== ""}
              onClick={() => setConfirm({ kind: "import", files: chosenFiles })}
            >
              <IconUpload />
              Import {chosenFiles.length} {chosenFiles.length === 1 ? "entity" : "entities"}
            </Button>
          </div>
          <div className="flex flex-col divide-y rounded-md border">
            {preview.map((item) => {
              const s = status(item)
              const open = expanded.has(item.path)
              const canDiff = !item.error && (item.changed || !item.existsOnServer)
              return (
                <div key={item.path}>
                  <div className="flex items-center gap-2 px-3 py-1.5 text-xs">
                    <Checkbox
                      checked={chosen.has(item.path)}
                      disabled={!!item.error}
                      onCheckedChange={(on) => setChosen((c) => toggle(c, item.path, on))}
                    />
                    <button
                      className={cn("flex min-w-0 flex-1 items-center gap-1 text-left", !canDiff && "cursor-default")}
                      onClick={() => canDiff && setExpanded((x) => toggle(x, item.path, !open))}
                    >
                      {canDiff && (open ? <IconChevronDown className="size-3.5" /> : <IconChevronRight className="size-3.5" />)}
                      <span className="truncate font-medium">{item.name || item.path}</span>
                      {item.type && <span className="text-muted-foreground">{item.type}</span>}
                    </button>
                    <Badge variant={s.variant}>{s.label}</Badge>
                  </div>
                  {item.error && <p className="px-3 pb-2 text-xs text-destructive">{item.error}</p>}
                  {open && canDiff && (
                    <div className="px-3 pb-3">
                      <DiffView original={item.original} modified={item.modified} path={item.path} />
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </section>
      )}

      {busy === "import" && (
        <section className="flex flex-col gap-1 rounded-xl border bg-card p-4 text-xs">
          <div className="flex items-center gap-2 font-medium">
            <Spinner /> Importing into {env}…
          </div>
          <p className="text-muted-foreground">{progress[progress.length - 1] ?? "Starting…"}</p>
        </section>
      )}

      {result && (
        <section className="flex flex-col gap-2 rounded-xl border bg-card p-4">
          <h2 className="text-sm font-medium">
            Result: {result.results.length - failed} imported{failed > 0 ? `, ${failed} failed` : ""}
          </h2>
          <div className="flex flex-col divide-y rounded-md border">
            {result.results.map((r) => (
              <div key={r.path} className="flex items-start gap-2 px-3 py-1.5 text-xs">
                <Badge variant={r.ok ? "secondary" : "destructive"}>{r.ok ? "Imported" : "Failed"}</Badge>
                <div className="min-w-0 flex-1">
                  <p className="truncate">{r.path.split("/").pop()}</p>
                  {r.error && <p className="text-destructive">{r.error}</p>}
                </div>
              </div>
            ))}
          </div>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            Backed up {count(result.backedUp)} to {result.backupDir}
            <Button size="sm" variant="outline" onClick={() => openImportBackup(result.backupDir).catch((e) => setError(errorMessage(e)))}>
              <IconFolderOpen />
              Open backup folder
            </Button>
          </div>
        </section>
      )}

      <section className="flex flex-col gap-2 rounded-xl border bg-card p-4">
        <h2 className="flex items-center gap-2 text-sm font-medium">
          <IconHistory className="size-4" /> Backups for {env}
        </h2>
        {backups.length === 0 ? (
          <p className="text-xs text-muted-foreground">No backups yet. One is made before every import.</p>
        ) : (
          <div className="flex flex-col divide-y rounded-md border">
            {backups.map((b) => (
              <div key={b.dir} className="flex items-center gap-2 px-3 py-1.5 text-xs">
                <span className="font-medium">{b.name}</span>
                <span className="text-muted-foreground">{count(b.files)}</span>
                <div className="ml-auto flex gap-2">
                  <Button size="sm" variant="ghost" onClick={() => openImportBackup(b.dir).catch((e) => setError(errorMessage(e)))}>
                    <IconFolderOpen />
                    Open
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy !== "" || b.files === 0}
                    onClick={() => setConfirm({ kind: "restore", backup: b })}
                  >
                    Restore
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <AlertDialog open={confirm !== null} onOpenChange={(open) => !open && setConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirm?.kind === "restore" ? "Restore backup" : "Import"} into {env}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirm?.kind === "restore"
                ? `This imports the ${count(confirm.backup.files)} saved in backup ${confirm.backup.name} into ${env}, overwriting their current versions. Entities created since are not removed.`
                : `This imports ${count(confirm?.files.length ?? 0)} into ${env}, overwriting their current versions.`}{" "}
              The current server versions are backed up first.
            </AlertDialogDescription>
            {prod && (
              <p className="flex items-center gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs font-medium text-destructive">
                <IconAlertTriangle className="size-4 shrink-0" />
                {env} looks like a production environment. Changes take effect on a live server.
              </p>
            )}
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant={prod ? "destructive" : "default"} onClick={onConfirm}>
              {confirm?.kind === "restore" ? "Restore" : "Import"} into {env}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
