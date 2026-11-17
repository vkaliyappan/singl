"use client"

// Ported from singl-web's settings page. Server actions become Tauri commands
// (src/lib/settings.ts); after each save the page reloads its data inside the
// form action, which is what revalidatePath did there, so React's form reset
// lands on the saved values. Web push and the AI agent toggles are not
// ported: the desktop app has neither.

import { AiSettings } from "./ai-settings"
import { createContext, useActionState, useContext, useEffect, useState, useTransition } from "react"
import { getVersion } from "@tauri-apps/api/app"
import {
  IconServer,
  IconKey,
  IconFolders,
  IconDatabaseImport,
  IconPlus,
  IconCopy,
  IconTrash,
  IconEdit,
  IconEye,
  IconEyeOff,
  IconLoader2,
  IconFolder,
  IconShield,
  IconInfoCircle,
  IconHome,
  IconRefresh,
  IconAdjustments,
  IconPower,
  IconClock,
  IconLayoutBottombarCollapse,
  IconRobot,
  IconSearch,
  IconPlugConnected,
} from "@tabler/icons-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { Input } from "@/components/ui/input"
import { PathInput } from "@/components/path-input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Switch } from "@/components/ui/switch"
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog"
import {
  cloneEnvironment,
  deleteEnvironment,
  deleteProject,
  errorMessage,
  importWebDatabase,
  saveEnvironment,
  saveProject,
  setAzurePatToken,
  setBundleDirs,
  setComparePaths,
  setEnvironmentEnabled,
  setWorkspaceRoot,
  setUpdateDir,
  checkForUpdate,
  installUpdate,
  type UpdateInfo,
  type AppSettings,
  type EnvSetting,
  type ProjectConfig,
} from "@/lib/settings"
import {
  getLaunchAtStartup,
  getOpenWidgetOnLaunch,
  getTrayPrefs,
  setLaunchAtStartup,
  setOpenWidgetOnLaunch,
  setTrayPrefs,
  type TrayPrefs,
} from "@/lib/app-preferences"

type ActionState = { success?: boolean; error?: string; info?: string }

const RefreshContext = createContext<() => Promise<void>>(async () => {})
/** Bumps after an import swaps the database, remounting forms that hold stale values. */
const ResetContext = createContext<() => void>(() => {})

/**
 * useActionState over a Tauri call: reloads the page data on success and turns
 * a rejected command into `{ error }`, like the server actions did.
 */
function useSettingsAction(run: (formData: FormData) => Promise<string | void>) {
  const refresh = useContext(RefreshContext)
  return useActionState<ActionState, FormData>(async (_prev, formData) => {
    try {
      const info = await run(formData)
      await refresh()
      return { success: true, info: info || undefined }
    } catch (err) {
      return { error: errorMessage(err) }
    }
  }, {})
}

const field = (formData: FormData, name: string) => ((formData.get(name) as string | null) ?? "").trim()

function SaveStatus({ state, saved }: { state: ActionState; saved: string }) {
  return (
    <div className="text-[10px]">
      {state.error && <span className="font-medium text-destructive">{state.error}</span>}
      {state.success && <span className="font-medium text-green-600 dark:text-green-400">{state.info ?? saved}</span>}
    </div>
  )
}

function SubmitButton({ pending, label, pendingLabel = "Saving…" }: { pending: boolean; label: string; pendingLabel?: string }) {
  return (
    <Button type="submit" size="lg" disabled={pending} className="px-3">
      {pending ? (
        <>
          <IconLoader2 className="mr-1 size-3 animate-spin" />
          {pendingLabel}
        </>
      ) : (
        label
      )}
    </Button>
  )
}

function SecretToggle({ shown, onToggle }: { shown: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className="inline-flex cursor-pointer items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground"
    >
      {shown ? <IconEyeOff className="size-3" /> : <IconEye className="size-3" />}
      {shown ? "Hide" : "Show"}
    </button>
  )
}

function StatusBadge({ ok, okLabel, missingLabel }: { ok: boolean; okLabel: string; missingLabel: string }) {
  return ok ? (
    <Badge variant="secondary" className="h-4 border-green-500/20 bg-green-500/10 py-0 text-[9px] font-normal text-green-600 dark:text-green-400">
      {okLabel}
    </Badge>
  ) : (
    <Badge variant="secondary" className="h-4 border-amber-500/20 bg-amber-500/10 py-0 text-[9px] font-normal text-amber-600 dark:text-amber-400">
      {missingLabel}
    </Badge>
  )
}

// ── Project Modal / Form ───────────────────────────────────────────────────

function ProjectDialog({
  open,
  onOpenChange,
  environment,
  project,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  environment: string
  project?: ProjectConfig | null
}) {
  const [state, action, pending] = useSettingsAction(async (formData) => {
    await saveProject({
      id: project?.id,
      environment,
      projectName: field(formData, "projectName"),
      folderName: field(formData, "folderName"),
      alias: field(formData, "alias"),
      exports: field(formData, "exports"),
    })
    onOpenChange(false)
  })

  const isEditing = !!project

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-sm font-semibold">{isEditing ? "Edit Project Mapping" : "Add Project Mapping"}</DialogTitle>
          <DialogDescription className="text-xs">
            Configure how ThingWorx entities for this project map to local folders in{" "}
            <code className="font-mono text-[11px] font-semibold">{environment}</code>.
          </DialogDescription>
        </DialogHeader>

        {/* Keyed so reopening for another project starts from its values. */}
        <form key={project?.id ?? "new"} action={action} className="space-y-3 pt-1">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label className="text-xs font-medium">TWX Project Name</Label>
              <Input name="projectName" defaultValue={project?.projectName ?? ""} placeholder="ThingWorxProjectName" required className="h-8 text-xs" />
            </div>
            <div className="space-y-1">
              <Label className="text-xs font-medium">Alias (Output Folder)</Label>
              <Input name="alias" defaultValue={project?.alias ?? ""} placeholder="optional alias" className="h-8 text-xs" />
            </div>
          </div>

          <div className="space-y-1">
            <Label className="text-xs font-medium">
              Folder Name <span className="text-[10px] text-muted-foreground">(Optional override)</span>
            </Label>
            <Input name="folderName" defaultValue={project?.folderName ?? ""} placeholder="e.g. custom_folder" className="h-8 font-mono text-xs" />
          </div>

          <div className="space-y-1">
            <Label className="text-xs font-medium">Export Types</Label>
            <Input
              name="exports"
              defaultValue={project ? project.exports.join(", ") : "all"}
              placeholder="all, or Things, Mashups"
              className="h-8 font-mono text-xs"
            />
            <p className="text-[10px] text-muted-foreground">
              Comma-separated list (e.g. <code className="font-mono">Things, Mashups</code>) or <code className="font-mono">all</code>.
            </p>
          </div>

          {state.error && <p className="text-xs text-destructive">{state.error}</p>}

          <DialogFooter className="pt-2">
            <Button type="button" variant="outline" size="lg" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <SubmitButton pending={pending} label={isEditing ? "Save Changes" : "Add Project"} />
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

// ── Environments: list + detail ────────────────────────────────────────────

/** Host part of a base URL, for the compact list; falls back to the raw text. */
function hostOf(url: string) {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

function EnvironmentsPanel({ settings, generation }: { settings: EnvSetting[]; generation: number }) {
  const [selected, setSelected] = useState(settings[0]?.environment ?? "")
  const [query, setQuery] = useState("")
  const q = query.trim().toLowerCase()

  // An environment matches on its name, host, or any of its project names/aliases.
  const visible = q
    ? settings.filter(
        (s) =>
          s.environment.toLowerCase().includes(q) ||
          s.twxBaseUrl.toLowerCase().includes(q) ||
          s.projects.some((p) => p.projectName.toLowerCase().includes(q) || p.alias?.toLowerCase().includes(q))
      )
    : settings
  const current = settings.find((s) => s.environment === selected) ?? settings[0]

  return (
    <div className="grid items-start gap-4 lg:grid-cols-[240px_minmax(0,1fr)]">
      <div className="flex flex-col gap-2 lg:sticky lg:top-0">
        <div className="relative">
          <IconSearch className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search environments or projects"
            className="h-8 pl-8 text-xs"
          />
        </div>
        <div className="flex flex-col gap-1" role="listbox" aria-label="Environments">
          {visible.length === 0 && <p className="px-2 py-3 text-center text-[11px] text-muted-foreground">No matches.</p>}
          {visible.map((s) => {
            const active = s.environment === current?.environment
            return (
              <button
                key={s.environment}
                type="button"
                role="option"
                aria-selected={active}
                onClick={() => setSelected(s.environment)}
                className={cn(
                  "flex cursor-pointer flex-col gap-0.5 rounded-lg border px-2.5 py-2 text-left transition-colors",
                  active ? "border-primary/40 bg-primary/5 shadow-xs" : "border-transparent hover:bg-muted"
                )}
              >
                <span className="flex items-center gap-1.5">
                  <span
                    className={cn(
                      "size-1.5 shrink-0 rounded-full",
                      !s.enabled ? "bg-muted-foreground/40" : s.hasAppKey ? "bg-green-500" : "bg-amber-500"
                    )}
                    title={!s.enabled ? "Disabled" : s.hasAppKey ? "App key configured" : "App key missing"}
                  />
                  <span className={cn("truncate font-mono text-xs font-semibold", !s.enabled && "text-muted-foreground")}>{s.environment}</span>
                  <span className="ml-auto rounded-full bg-muted px-1.5 text-[10px] text-muted-foreground tabular-nums">{s.projects.length}</span>
                </span>
                <span className="truncate pl-3 text-[10px] text-muted-foreground">{s.twxBaseUrl ? hostOf(s.twxBaseUrl) : "No URL set"}</span>
              </button>
            )
          })}
        </div>
      </div>

      {current && <EnvironmentDetail key={`${generation}:${current.environment}`} setting={current} projectQuery={q} />}
    </div>
  )
}

function EnvironmentDetail({ setting, projectQuery }: { setting: EnvSetting; projectQuery: string }) {
  const refresh = useContext(RefreshContext)
  const [showCloneDialog, setShowCloneDialog] = useState(false)
  const [showDeleteDialog, setShowDeleteDialog] = useState(false)
  const [showAppKey, setShowAppKey] = useState(false)
  const [projectDialogOpen, setProjectDialogOpen] = useState(false)
  const [editingProject, setEditingProject] = useState<ProjectConfig | null>(null)
  const [enabled, setEnabled] = useState(setting.enabled)
  const [enabledError, setEnabledError] = useState("")
  const [enabledPending, startEnabledTransition] = useTransition()
  // Starts from the environment search so a project hit is already narrowed down.
  const [projectFilter, setProjectFilter] = useState(projectQuery)

  const [saveState, saveAction, savePending] = useSettingsAction((formData) =>
    saveEnvironment(setting.environment, field(formData, "twxBaseUrl"), field(formData, "twxAppKey"))
  )
  const [deleteState, deleteAction, deletePending] = useSettingsAction(() => deleteEnvironment(setting.environment))
  const [cloneState, cloneAction, clonePending] = useSettingsAction(async (formData) => {
    await cloneEnvironment(setting.environment, field(formData, "newEnvironment"))
    setShowCloneDialog(false)
  })

  // Flip the switch straight away; a failed save puts it back.
  const toggleEnabled = (on: boolean) => {
    setEnabled(on)
    setEnabledError("")
    startEnabledTransition(async () => {
      try {
        await setEnvironmentEnabled(setting.environment, on)
        await refresh()
      } catch (err) {
        setEnabled(!on)
        setEnabledError(errorMessage(err))
      }
    })
  }

  const pf = projectFilter.trim().toLowerCase()
  const projects = [...setting.projects]
    .filter(
      (p) =>
        !pf ||
        p.projectName.toLowerCase().includes(pf) ||
        p.alias?.toLowerCase().includes(pf) ||
        p.folderName?.toLowerCase().includes(pf)
    )
    .sort((a, b) => a.projectName.localeCompare(b.projectName))

  const openProject = (p: ProjectConfig | null) => {
    setEditingProject(p)
    setProjectDialogOpen(true)
  }

  return (
    <div className="flex min-w-0 flex-col gap-4">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <div className="rounded-lg bg-primary/10 p-2 text-primary">
            <IconServer className="size-4" />
          </div>
          <div className="flex min-w-0 flex-col gap-0.5">
            <div className="flex items-center gap-2">
              <span className="font-mono text-sm font-semibold">{setting.environment}</span>
              <StatusBadge ok={setting.hasAppKey} okLabel="AppKey Configured" missingLabel="Key Missing" />
            </div>
            <span className="truncate text-[11px] text-muted-foreground">{setting.twxBaseUrl ? hostOf(setting.twxBaseUrl) : "No base URL set"}</span>
          </div>
        </div>

        <div className="flex items-center gap-1">
          {enabledError && <span className="text-[10px] font-medium text-destructive">{enabledError}</span>}
          <label className="flex items-center gap-1.5 px-1.5 text-[11px] text-muted-foreground">
            <Switch checked={enabled} disabled={enabledPending} onCheckedChange={toggleEnabled} aria-label={`Enable ${setting.environment}`} />
            {enabled ? "Enabled" : "Disabled"}
          </label>
          <Button variant="ghost" size="sm" className="text-muted-foreground hover:text-foreground" onClick={() => setShowCloneDialog(true)}>
            <IconCopy className="size-3" />
            <span className="text-[11px]">Clone</span>
          </Button>
          <Button variant="ghost" size="sm" className="text-muted-foreground hover:text-destructive" onClick={() => setShowDeleteDialog(true)}>
            <IconTrash className="size-3" />
            <span className="text-[11px]">Delete</span>
          </Button>
        </div>
      </div>

      {/* Connection */}
      <Card className="gap-0 border-border/60 py-0 shadow-xs">
        <div className="flex items-center gap-1.5 border-b border-border/40 px-3.5 py-2 text-xs font-medium">
          <IconPlugConnected className="size-3.5 text-muted-foreground" />
          Connection
        </div>
        <CardContent className="p-3.5">
          <form action={saveAction} className="flex flex-col gap-2.5">
            <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
              <div className="space-y-1">
                <Label className="text-[11px] font-medium">TWX Base URL</Label>
                <Input
                  name="twxBaseUrl"
                  defaultValue={setting.twxBaseUrl}
                  title={setting.twxBaseUrl}
                  placeholder="https://your-thingworx-host/Thingworx"
                  className="h-8 font-mono text-xs"
                />
              </div>
              <div className="space-y-1">
                <div className="flex items-center justify-between">
                  <Label className="text-[11px] font-medium">TWX App Key</Label>
                  <SecretToggle shown={showAppKey} onToggle={() => setShowAppKey(!showAppKey)} />
                </div>
                <Input
                  name="twxAppKey"
                  type={showAppKey ? "text" : "password"}
                  autoComplete="new-password"
                  placeholder={setting.hasAppKey ? "•••••••• (blank keeps existing)" : "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"}
                  className="h-8 font-mono text-xs"
                />
              </div>
            </div>
            <div className="flex items-center justify-between">
              <SaveStatus state={saveState} saved="Saved." />
              <SubmitButton pending={savePending} label="Save Connection" />
            </div>
          </form>
        </CardContent>
      </Card>

      {/* Projects */}
      <Card className="gap-0 overflow-hidden border-border/60 py-0 shadow-xs">
        <div className="flex flex-wrap items-center gap-2 border-b border-border/40 px-3.5 py-2">
          <span className="flex items-center gap-1.5 text-xs font-medium">
            <IconFolders className="size-3.5 text-muted-foreground" />
            Projects
            <Badge variant="outline" className="h-4 py-0 text-[9px]">
              {pf ? `${projects.length} / ${setting.projects.length}` : setting.projects.length}
            </Badge>
          </span>
          <div className="relative ml-auto w-full sm:w-52">
            <IconSearch className="pointer-events-none absolute top-1/2 left-2 size-3 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={projectFilter}
              onChange={(e) => setProjectFilter(e.target.value)}
              placeholder="Filter projects"
              className="h-7 pl-6 text-xs"
            />
          </div>
          <Button variant="outline" size="sm" className="text-[11px]" onClick={() => openProject(null)}>
            <IconPlus className="size-3" />
            Add Project
          </Button>
        </div>

        {setting.projects.length === 0 ? (
          <div className="py-6 text-center text-[11px] text-muted-foreground">No projects configured for this environment yet.</div>
        ) : projects.length === 0 ? (
          <div className="py-6 text-center text-[11px] text-muted-foreground">No projects match “{projectFilter}”.</div>
        ) : (
          <table className="w-full text-xs">
            <thead className="bg-muted/30 text-[10px] tracking-wide text-muted-foreground uppercase">
              <tr>
                <th className="px-3.5 py-1.5 text-left font-medium">Project</th>
                <th className="px-2 py-1.5 text-left font-medium">Alias / Folder</th>
                <th className="px-2 py-1.5 text-left font-medium">Exports</th>
                <th className="w-16" />
              </tr>
            </thead>
            <tbody className="divide-y divide-border/40">
              {projects.map((proj) => (
                <ProjectRow key={proj.id} project={proj} onEdit={() => openProject(proj)} />
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {/* Clone Dialog */}
      <Dialog open={showCloneDialog} onOpenChange={setShowCloneDialog}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-sm font-semibold">Clone Environment</DialogTitle>
            <DialogDescription className="text-xs">
              Create a duplicate of <code className="font-mono">{setting.environment}</code> along with all its mapped projects. The app
              key is not copied.
            </DialogDescription>
          </DialogHeader>
          <form action={cloneAction} className="space-y-3 pt-1">
            <div className="space-y-1">
              <Label className="text-xs font-medium">New Environment Name</Label>
              <Input name="newEnvironment" placeholder="e.g. staging-2" required autoFocus className="h-8 text-xs" />
            </div>
            {cloneState.error && <p className="text-xs text-destructive">{cloneState.error}</p>}
            <DialogFooter className="pt-2">
              <Button type="button" variant="outline" size="lg" onClick={() => setShowCloneDialog(false)}>
                Cancel
              </Button>
              <SubmitButton pending={clonePending} label="Clone Environment" pendingLabel="Cloning…" />
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Delete Dialog */}
      <Dialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-sm font-semibold">Delete Environment</DialogTitle>
            <DialogDescription className="text-xs">
              Delete <code className="font-mono">{setting.environment}</code> and its {setting.projects.length} mapped project
              {setting.projects.length === 1 ? "" : "s"}? This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <form action={deleteAction}>
            {deleteState.error && <p className="pb-2 text-xs text-destructive">{deleteState.error}</p>}
            <DialogFooter>
              <Button type="button" variant="outline" size="lg" onClick={() => setShowDeleteDialog(false)}>
                Cancel
              </Button>
              <Button type="submit" variant="destructive" size="lg" disabled={deletePending}>
                {deletePending ? "Deleting…" : "Delete"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <ProjectDialog open={projectDialogOpen} onOpenChange={setProjectDialogOpen} environment={setting.environment} project={editingProject} />
    </div>
  )
}

function ProjectRow({ project, onEdit }: { project: ProjectConfig; onEdit: () => void }) {
  const [state, deleteAction, deletePending] = useSettingsAction(() => deleteProject(project.id))
  const alias = project.alias && project.alias !== project.projectName ? project.alias : ""

  return (
    <tr className="group hover:bg-muted/30">
      <td className="px-3.5 py-1.5">
        <button type="button" onClick={onEdit} className="cursor-pointer text-left font-semibold hover:text-primary">
          {project.projectName}
        </button>
        {state.error && <p className="text-[10px] text-destructive">{state.error}</p>}
      </td>
      <td className="px-2 py-1.5 font-mono text-[11px] text-muted-foreground">
        {alias || "—"}
        {project.folderName && <span className="ml-1 text-[10px]">→ {project.folderName}</span>}
      </td>
      <td className="max-w-40 truncate px-2 py-1.5 font-mono text-[11px] text-muted-foreground" title={project.exports.join(", ")}>
        {project.exports.join(", ")}
      </td>
      <td className="px-2 py-1">
        <div className="flex items-center justify-end gap-0.5">
          <Button variant="ghost" size="icon-sm" className="text-muted-foreground hover:text-foreground" onClick={onEdit} aria-label="Edit project">
            <IconEdit className="size-3" />
          </Button>
          <form action={deleteAction}>
            <Button
              variant="ghost"
              size="icon-sm"
              type="submit"
              disabled={deletePending}
              className="text-muted-foreground hover:text-destructive"
              aria-label="Delete project"
            >
              <IconTrash className="size-3" />
            </Button>
          </form>
        </div>
      </td>
    </tr>
  )
}

// ── New Environment Dialog ─────────────────────────────────────────────────

function NewEnvironmentDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [state, action, pending] = useSettingsAction(async (formData) => {
    await saveEnvironment(field(formData, "environment"), field(formData, "twxBaseUrl"), field(formData, "twxAppKey"))
    onOpenChange(false)
  })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-sm font-semibold">New ThingWorx Environment</DialogTitle>
          <DialogDescription className="text-xs">Add a new environment connection profile (e.g. dev, qa, staging, prod).</DialogDescription>
        </DialogHeader>

        <form action={action} className="space-y-3 pt-1">
          <div className="space-y-1">
            <Label className="text-xs font-medium">Environment Identifier</Label>
            <Input name="environment" placeholder="e.g. dev, staging, prod" required autoFocus className="h-8 text-xs" />
          </div>

          <div className="space-y-1">
            <Label className="text-xs font-medium">TWX Base URL</Label>
            <Input name="twxBaseUrl" placeholder="https://your-thingworx-host/Thingworx" className="h-8 font-mono text-xs" />
          </div>

          <div className="space-y-1">
            <Label className="text-xs font-medium">TWX App Key</Label>
            <Input
              name="twxAppKey"
              type="password"
              autoComplete="new-password"
              placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
              className="h-8 font-mono text-xs"
            />
          </div>

          {state.error && <p className="text-xs text-destructive">{state.error}</p>}

          <DialogFooter className="pt-2">
            <Button type="button" variant="outline" size="lg" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <SubmitButton pending={pending} label="Add Environment" pendingLabel="Adding…" />
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

// ── Integrations ───────────────────────────────────────────────────────────

function AzurePatCard({ hasAzurePatToken }: { hasAzurePatToken: boolean }) {
  const [showAzureToken, setShowAzureToken] = useState(false)
  // A blank field keeps the stored token, as the placeholder says; Remove clears it.
  const [state, action, pending] = useSettingsAction(async (formData) => {
    const token = field(formData, "azurePatToken")
    if (formData.get("intent") === "remove") {
      await setAzurePatToken("")
      return "Token removed."
    }
    if (!token) throw new Error("Enter a token to save.")
    await setAzurePatToken(token)
  })

  return (
    <Card className="gap-0 border-border/60 py-0 shadow-xs">
      <CardHeader className="border-b border-border/40 px-3.5 py-2.5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <IconShield className="size-4 text-primary" />
            <CardTitle className="text-xs font-semibold">Azure DevOps Personal Access Token (PAT)</CardTitle>
          </div>
          <StatusBadge ok={hasAzurePatToken} okLabel="Token Active" missingLabel="No Token Set" />
        </div>
        <CardDescription className="text-[11px] text-muted-foreground">
          Required for authenticated Git operations against Azure DevOps repositories. Stored in this app&apos;s local database.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-3 p-3.5">
        <form action={action} className="space-y-2.5">
          <div className="space-y-1">
            <div className="flex items-center justify-between">
              <Label className="text-[11px] font-medium">Azure PAT Token</Label>
              <SecretToggle shown={showAzureToken} onToggle={() => setShowAzureToken(!showAzureToken)} />
            </div>
            <Input
              name="azurePatToken"
              type={showAzureToken ? "text" : "password"}
              autoComplete="new-password"
              placeholder={hasAzurePatToken ? "•••••••••••••••• (Leave blank to keep existing token)" : "Enter your Azure Personal Access Token"}
              className="h-8 font-mono text-xs"
            />
          </div>

          <div className="flex items-start gap-2 rounded-md border bg-muted/20 p-2 text-[11px] text-muted-foreground">
            <IconInfoCircle className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <div>
              <span>Ensure your token has </span>
              <code className="rounded bg-muted px-1 py-0.5 font-mono text-[10px]">Code (Read & Write)</code>
              <span> permissions in Azure DevOps project settings.</span>
            </div>
          </div>

          <div className="flex items-center justify-between pt-1">
            <SaveStatus state={state} saved="Token saved successfully." />
            <div className="flex items-center gap-2">
              {hasAzurePatToken && (
                <Button type="submit" name="intent" value="remove" variant="outline" size="lg" disabled={pending} formNoValidate>
                  Remove
                </Button>
              )}
              <SubmitButton pending={pending} label="Save Token" />
            </div>
          </div>
        </form>
      </CardContent>
    </Card>
  )
}

// ── Path Mappings ──────────────────────────────────────────────────────────

function PathMappings({ app }: { app: AppSettings }) {
  const [compareState, compareAction, comparePending] = useSettingsAction((formData) =>
    setComparePaths(field(formData, "twxRootPrefix"), field(formData, "repoRootSubpath"))
  )
  const [bundleState, bundleAction, bundlePending] = useSettingsAction((formData) =>
    setBundleDirs(field(formData, "bundleSrcDir"), field(formData, "bundleDestDir"))
  )
  const [rootState, rootAction, rootPending] = useSettingsAction((formData) => setWorkspaceRoot(field(formData, "workspaceRoot")))

  return (
    <>
      {/* Workspace root: desktop-only, replaces singl-web's server working directory. */}
      <Card className="gap-0 border-border/60 py-0 shadow-xs">
        <CardHeader className="border-b border-border/40 px-3.5 py-2.5">
          <div className="flex items-center gap-2">
            <IconHome className="size-4 text-primary" />
            <CardTitle className="text-xs font-semibold">Workspace Folder</CardTitle>
          </div>
          <CardDescription className="text-[11px] text-muted-foreground">
            The folder that holds <code className="font-mono">repo/</code>, <code className="font-mono">bundles/</code>, <code className="font-mono">export/</code>, <code className="font-mono">backup/</code> and the ThingWorx
            sources. Relative paths below resolve against it.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 p-3.5">
          <form action={rootAction} className="space-y-2.5">
            <div className="space-y-1">
              <Label className="text-[11px] font-medium">Workspace Root</Label>
              <PathInput
                directory
                dialogTitle="Choose the workspace folder"
                name="workspaceRoot"
                defaultValue={app.workspaceRoot}
                placeholder="C:\path\to\workspace"
              />
            </div>
            <div className="flex items-center justify-between pt-1">
              <SaveStatus state={rootState} saved="Workspace folder saved." />
              <SubmitButton pending={rootPending} label="Save Workspace" />
            </div>
          </form>
        </CardContent>
      </Card>

      {/* Compare Paths */}
      <Card className="gap-0 border-border/60 py-0 shadow-xs">
        <CardHeader className="border-b border-border/40 px-3.5 py-2.5">
          <div className="flex items-center gap-2">
            <IconFolders className="size-4 text-primary" />
            <CardTitle className="text-xs font-semibold">Entity Compare Path Mappings</CardTitle>
          </div>
          <CardDescription className="text-[11px] text-muted-foreground">
            Controls how ThingWorx entity paths map to repository paths when comparing.
          </CardDescription>
        </CardHeader>

        <CardContent className="space-y-3 p-3.5">
          <form action={compareAction} className="space-y-2.5">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label className="text-[11px] font-medium">TWX Root Prefix</Label>
                <Input
                  key={app.twxRootPrefix}
                  name="twxRootPrefix"
                  defaultValue={app.twxRootPrefix}
                  placeholder="WindchillClients/Thingworx"
                  className="h-8 font-mono text-xs"
                />
                <p className="text-[10px] leading-tight text-muted-foreground">
                  Path under <code className="font-mono">twx-entities/&#123;env&#125;/</code> used as root.
                </p>
              </div>

              <div className="space-y-1">
                <Label className="text-[11px] font-medium">Repo Root Subpath</Label>
                <Input
                  key={app.repoRootSubpath}
                  name="repoRootSubpath"
                  defaultValue={app.repoRootSubpath}
                  placeholder="(repo root)"
                  className="h-8 font-mono text-xs"
                />
                <p className="text-[10px] leading-tight text-muted-foreground">Subfolder inside cloned repo that mirrors the TWX root above.</p>
              </div>
            </div>

            <div className="flex items-center justify-between pt-1">
              <SaveStatus state={compareState} saved="Compare paths saved." />
              <SubmitButton pending={comparePending} label="Save Compare Paths" />
            </div>
          </form>
        </CardContent>
      </Card>

      {/* Bundle Paths */}
      <Card className="gap-0 border-border/60 py-0 shadow-xs">
        <CardHeader className="border-b border-border/40 px-3.5 py-2.5">
          <div className="flex items-center gap-2">
            <IconFolder className="size-4 text-primary" />
            <CardTitle className="text-xs font-semibold">Deployment Bundle Directories</CardTitle>
          </div>
          <CardDescription className="text-[11px] text-muted-foreground">Default source and output directories used by the deploy bundler.</CardDescription>
        </CardHeader>

        <CardContent className="space-y-3 p-3.5">
          <form action={bundleAction} className="space-y-2.5">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label className="text-[11px] font-medium">Bundle Source Directory</Label>
                <PathInput
                  directory
                  baseDir={app.workspaceRoot}
                  dialogTitle="Choose the bundle source folder"
                  name="bundleSrcDir"
                  defaultValue={app.bundleSrcDir}
                  placeholder="./WindchillClients/Thingworx"
                />
                <p className="text-[10px] leading-tight text-muted-foreground">Folder containing unpacked project workspaces.</p>
              </div>

              <div className="space-y-1">
                <Label className="text-[11px] font-medium">Bundle Destination Directory</Label>
                <PathInput
                  directory
                  baseDir={app.workspaceRoot}
                  dialogTitle="Choose the bundle destination folder"
                  name="bundleDestDir"
                  defaultValue={app.bundleDestDir}
                  placeholder="./bundles"
                />
                <p className="text-[10px] leading-tight text-muted-foreground">Target directory where packaged release ZIPs are created.</p>
              </div>
            </div>

            <div className="flex items-center justify-between pt-1">
              <SaveStatus state={bundleState} saved="Bundle paths saved." />
              <SubmitButton pending={bundlePending} label="Save Bundle Paths" />
            </div>
          </form>
        </CardContent>
      </Card>
    </>
  )
}

// ── Updates ────────────────────────────────────────────────────────────────

function UpdatesCard({ app }: { app: AppSettings }) {
  const [dirState, dirAction, dirPending] = useSettingsAction((formData) => setUpdateDir(field(formData, "updateDir")))
  const [version, setVersion] = useState("")
  const [checking, startCheck] = useTransition()
  const [installing, startInstall] = useTransition()
  const [result, setResult] = useState<{ update?: UpdateInfo | null; error?: string }>({})

  useEffect(() => {
    getVersion().then(setVersion).catch(() => {})
  }, [])

  const check = () =>
    startCheck(async () => {
      try {
        setResult({ update: await checkForUpdate() })
      } catch (err) {
        setResult({ error: errorMessage(err) })
      }
    })

  const install = () =>
    startInstall(async () => {
      try {
        await installUpdate()
      } catch (err) {
        setResult({ error: errorMessage(err) })
      }
    })

  return (
    <Card className="gap-0 border-border/60 py-0 shadow-xs">
      <CardHeader className="border-b border-border/40 px-3.5 py-2.5">
        <div className="flex items-center gap-2">
          <IconRefresh className="size-4 text-primary" />
          <CardTitle className="text-xs font-semibold">App Updates</CardTitle>
        </div>
        <CardDescription className="text-[11px] text-muted-foreground">
          singl looks for <code className="font-mono">latest.json</code> and the installer in this folder. Run{" "}
          <code className="font-mono">pnpm release</code> to publish a new version there.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 p-3.5">
        <form action={dirAction} className="space-y-2.5">
          <div className="space-y-1">
            <Label className="text-[11px] font-medium">Update Folder</Label>
            <PathInput
              directory
              dialogTitle="Choose the update folder"
              name="updateDir"
              defaultValue={app.updateDir}
              placeholder="\\server\share\singl"
            />
          </div>
          <div className="flex items-center justify-between pt-1">
            <SaveStatus state={dirState} saved="Update folder saved." />
            <SubmitButton pending={dirPending} label="Save Folder" />
          </div>
        </form>

        <div className="flex items-center justify-between gap-3 border-t border-border/40 pt-3">
          <div className="min-w-0 text-[11px]">
            <p className="text-muted-foreground">
              Installed version <span className="font-mono text-foreground">{version || "…"}</span>
            </p>
            {result.error && <p className="text-destructive">{result.error}</p>}
            {result.update === null && <p className="text-muted-foreground">singl is up to date.</p>}
            {result.update && (
              <p>
                Version <span className="font-mono font-medium">{result.update.version}</span> is available.
                {result.update.notes && <span className="block whitespace-pre-line text-muted-foreground">{result.update.notes}</span>}
              </p>
            )}
          </div>
          <div className="flex shrink-0 gap-2">
            <Button type="button" variant="outline" size="sm" onClick={check} disabled={checking || installing}>
              {checking && <IconLoader2 className="size-3.5 animate-spin" />}
              Check for Updates
            </Button>
            {result.update && (
              <Button type="button" size="sm" onClick={install} disabled={installing}>
                {installing && <IconLoader2 className="size-3.5 animate-spin" />}
                Install &amp; Restart
              </Button>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

// ── Data ───────────────────────────────────────────────────────────────────

function ImportCard() {
  const reset = useContext(ResetContext)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [source, setSource] = useState("")
  const [state, action, pending] = useSettingsAction(async () => {
    setConfirmOpen(false)
    const report = await importWebDatabase(source.trim())
    reset()
    return `Imported (${report.stamped} migrations matched). The previous database was kept as a backup.`
  })

  return (
    <Card className="gap-0 border-border/60 py-0 shadow-xs">
      <CardHeader className="border-b border-border/40 px-3.5 py-2.5">
        <div className="flex items-center gap-2">
          <IconDatabaseImport className="size-4 text-primary" />
          <CardTitle className="text-xs font-semibold">Import from singl-web</CardTitle>
        </div>
        <CardDescription className="text-[11px] text-muted-foreground">
          Copy everything from singl-web&apos;s <code className="font-mono">local.db</code> — environments, projects, credentials and paths —
          into this app. This replaces the current database; the old file is kept next to it as a backup.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 p-3.5">
        <div className="space-y-1">
          <Label className="text-[11px] font-medium">Path to local.db</Label>
          <PathInput
            value={source}
            onChange={(e) => setSource(e.target.value)}
            onPick={setSource}
            dialogTitle="Choose singl-web's local.db"
            filters={[{ name: "SQLite database", extensions: ["db"] }]}
            placeholder="C:\path\to\singl-web\local.db"
          />
        </div>
        <div className="flex items-center justify-between pt-1">
          <SaveStatus state={state} saved="Imported." />
          <Button size="lg" disabled={pending || !source.trim()} onClick={() => setConfirmOpen(true)}>
            {pending ? (
              <>
                <IconLoader2 className="mr-1 size-3 animate-spin" />
                Importing…
              </>
            ) : (
              "Import…"
            )}
          </Button>
        </div>
      </CardContent>

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-sm font-semibold">Replace current data?</DialogTitle>
            <DialogDescription className="text-xs">
              Everything in this app&apos;s database is replaced by <code className="font-mono break-all">{source}</code>. The current file is
              kept as <code className="font-mono">singl.db.bak-…</code>.
            </DialogDescription>
          </DialogHeader>
          <form action={action}>
            <DialogFooter>
              <Button type="button" variant="outline" size="lg" onClick={() => setConfirmOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" variant="destructive" size="lg">
                Replace and import
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </Card>
  )
}

// ── App Preferences ────────────────────────────────────────────────────────

function PreferenceRow({
  icon: Icon,
  title,
  description,
  checked,
  disabled,
  onCheckedChange,
}: {
  icon: typeof IconPower
  title: string
  description: React.ReactNode
  checked: boolean
  disabled?: boolean
  onCheckedChange: (on: boolean) => void
}) {
  return (
    <label className="flex cursor-pointer items-start justify-between gap-4 py-3 first:pt-0 last:pb-0">
      <div className="flex min-w-0 gap-2.5">
        <Icon className="mt-0.5 size-4 shrink-0 stroke-[1.75] text-muted-foreground" />
        <div className="min-w-0">
          <p className="text-xs font-medium">{title}</p>
          <p className="text-[11px] text-muted-foreground">{description}</p>
        </div>
      </div>
      <Switch className="mt-0.5" checked={checked} disabled={disabled} onCheckedChange={onCheckedChange} aria-label={title} />
    </label>
  )
}

function AppPreferencesCard() {
  const [autostart, setAutostart] = useState(false)
  const [autostartLoaded, setAutostartLoaded] = useState(false)
  const [autostartPending, startAutostart] = useTransition()
  const [autostartError, setAutostartError] = useState("")
  // Only rendered client-side, once settings have loaded, so localStorage is safe here.
  const [widgetOnLaunch, setWidgetOnLaunch] = useState(getOpenWidgetOnLaunch)
  const [tray, setTray] = useState<TrayPrefs>(getTrayPrefs)
  const [trayError, setTrayError] = useState("")

  useEffect(() => {
    getLaunchAtStartup()
      .then(setAutostart)
      .catch((err) => setAutostartError(errorMessage(err)))
      .finally(() => setAutostartLoaded(true))
  }, [])

  // Flip the switch straight away; a failed change puts it back.
  const toggleAutostart = (on: boolean) => {
    setAutostart(on)
    setAutostartError("")
    startAutostart(async () => {
      try {
        await setLaunchAtStartup(on)
      } catch (err) {
        setAutostart(!on)
        setAutostartError(errorMessage(err))
      }
    })
  }

  const toggleWidgetOnLaunch = (on: boolean) => {
    setWidgetOnLaunch(on)
    setOpenWidgetOnLaunch(on)
  }

  const toggleTray = (key: keyof TrayPrefs) => (on: boolean) => {
    const next = { ...tray, [key]: on }
    setTray(next)
    setTrayError("")
    setTrayPrefs(next).catch((err) => setTrayError(errorMessage(err)))
  }

  return (
    <div className="flex flex-col gap-3.5">
    <Card className="gap-0 border-border/60 py-0 shadow-xs">
      <CardHeader className="border-b border-border/40 px-3.5 py-2.5">
        <div className="flex items-center gap-2">
          <IconAdjustments className="size-4 text-primary" />
          <CardTitle className="text-xs font-semibold">Startup</CardTitle>
        </div>
        <CardDescription className="text-[11px] text-muted-foreground">How singl behaves when it starts.</CardDescription>
      </CardHeader>
      <CardContent className="divide-y divide-border/40 p-3.5">
        <PreferenceRow
          icon={IconPower}
          title="Launch singl at sign-in"
          description={
            <>
              Starts minimized when you sign in to Windows (to the tray if &quot;Minimize singl to tray&quot; is on).
              {autostartError && <span className="block text-destructive">{autostartError}</span>}
            </>
          }
          checked={autostart}
          disabled={!autostartLoaded || autostartPending}
          onCheckedChange={toggleAutostart}
        />
        <PreferenceRow
          icon={IconClock}
          title="Open clock widget when singl starts"
          description="Pops out the desktop world clock every time singl opens, where you last left it."
          checked={widgetOnLaunch}
          onCheckedChange={toggleWidgetOnLaunch}
        />
      </CardContent>
    </Card>
    <TrayCard tray={tray} error={trayError} onToggle={toggleTray} />
    </div>
  )
}

function TrayCard({
  tray,
  error,
  onToggle,
}: {
  tray: TrayPrefs
  error: string
  onToggle: (key: keyof TrayPrefs) => (on: boolean) => void
}) {
  return (
    <Card className="gap-0 border-border/60 py-0 shadow-xs">
      <CardHeader className="border-b border-border/40 px-3.5 py-2.5">
        <div className="flex items-center gap-2">
          <IconLayoutBottombarCollapse className="size-4 text-primary" />
          <CardTitle className="text-xs font-semibold">System Tray</CardTitle>
        </div>
        <CardDescription className="text-[11px] text-muted-foreground">
          Minimized windows leave the taskbar and wait in the tray. Click the tray icon to bring singl back; right-click it for the
          clock widget or to quit.
          {error && <span className="block text-destructive">{error}</span>}
        </CardDescription>
      </CardHeader>
      <CardContent className="divide-y divide-border/40 p-3.5">
        <PreferenceRow
          icon={IconAdjustments}
          title="Minimize singl to tray"
          description="The main window hides in the tray instead of the taskbar when minimized."
          checked={tray.main}
          onCheckedChange={onToggle("main")}
        />
        <PreferenceRow
          icon={IconClock}
          title="Minimize clock widget to tray"
          description="The desktop clock hides in the tray instead of the taskbar when minimized."
          checked={tray.widget}
          onCheckedChange={onToggle("widget")}
        />
      </CardContent>
    </Card>
  )
}

// ── Main Settings Explorer ─────────────────────────────────────────────────

const SECTIONS = [
  {
    id: "environments",
    label: "Environments",
    title: "ThingWorx Environments",
    description: "Connection credentials and project mappings per environment.",
    icon: IconServer,
  },
  {
    id: "integrations",
    label: "Credentials",
    title: "Integrations & Credentials",
    description: "Tokens for services singl talks to.",
    icon: IconKey,
  },
  {
    id: "paths",
    label: "Path Mappings",
    title: "Path Mappings",
    description: "Where entities, repositories and bundles live on disk.",
    icon: IconFolders,
  },
  {
    id: "ai",
    label: "AI",
    title: "AI",
    description: "Assistant providers, agent CLIs, approvals and MCP.",
    icon: IconRobot,
  },
  {
    id: "preferences",
    label: "App Preferences",
    title: "App Preferences",
    description: "Startup and system tray behaviour of the desktop app.",
    icon: IconAdjustments,
  },
  {
    id: "updates",
    label: "Updates",
    title: "Updates",
    description: "Install new versions of singl from a shared folder.",
    icon: IconRefresh,
  },
  {
    id: "data",
    label: "Data",
    title: "Data",
    description: "Bring settings over from singl-web.",
    icon: IconDatabaseImport,
  },
] as const

type SectionId = (typeof SECTIONS)[number]["id"]

export function SettingsExplorer({
  settings,
  app,
  refresh,
}: {
  settings: EnvSetting[]
  app: AppSettings
  refresh: () => Promise<void>
}) {
  const [section, setSection] = useState<SectionId>("environments")
  const [newEnvOpen, setNewEnvOpen] = useState(false)
  const [generation, setGeneration] = useState(0)
  const current = SECTIONS.find((s) => s.id === section)!

  return (
    <RefreshContext value={refresh}>
    <ResetContext value={() => setGeneration((g) => g + 1)}>
      <div className="grid items-start gap-6 md:grid-cols-[200px_minmax(0,1fr)]">
        {/* Section nav: a column on desktop, a scrolling row on narrow windows. */}
        <nav aria-label="Settings sections" className="-mx-1 flex gap-1 overflow-x-auto px-1 md:sticky md:top-0 md:flex-col md:overflow-visible">
          {SECTIONS.map(({ id, label, icon: Icon }) => {
            const active = id === section
            return (
              <button
                key={id}
                type="button"
                onClick={() => setSection(id)}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex shrink-0 cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13px] transition-colors",
                  active ? "bg-card font-medium text-foreground shadow-xs ring-1 ring-border" : "text-muted-foreground hover:bg-muted hover:text-foreground"
                )}
              >
                <Icon className={cn("size-4 stroke-[1.75]", active && "text-primary")} />
                <span className="flex-1">{label}</span>
                {id === "environments" && settings.length > 0 && (
                  <span className="rounded-full bg-muted px-1.5 text-[10px] text-muted-foreground tabular-nums">{settings.length}</span>
                )}
              </button>
            )
          })}
        </nav>

        <section className="flex min-w-0 flex-col gap-4">
          <div className="flex items-end justify-between gap-4 border-b pb-3">
            <div className="flex flex-col gap-0.5">
              <h2 className="text-[15px] font-semibold tracking-[-0.01em]">{current.title}</h2>
              <p className="text-xs text-muted-foreground">{current.description}</p>
            </div>
            {section === "environments" && settings.length > 0 && (
              <Button onClick={() => setNewEnvOpen(true)}>
                <IconPlus className="size-3.5" />
                Add Environment
              </Button>
            )}
          </div>

          {section === "environments" &&
            (settings.length === 0 ? (
              <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed bg-muted/30 px-6 py-12 text-center">
                <div className="flex size-11 items-center justify-center rounded-xl border bg-card shadow-xs">
                  <IconServer className="size-5 stroke-[1.75] text-muted-foreground" />
                </div>
                <div className="flex flex-col gap-1">
                  <p className="text-sm font-medium">No environments yet</p>
                  <p className="max-w-sm text-xs text-muted-foreground">
                    Add a ThingWorx environment, or import your singl-web settings from{" "}
                    <button type="button" className="cursor-pointer underline underline-offset-2 hover:text-foreground" onClick={() => setSection("data")}>
                      Data
                    </button>
                    .
                  </p>
                </div>
                <Button onClick={() => setNewEnvOpen(true)}>
                  <IconPlus className="size-3.5" />
                  Add Environment
                </Button>
              </div>
            ) : (
              <EnvironmentsPanel settings={settings} generation={generation} />
            ))}

          {section === "integrations" && <AzurePatCard hasAzurePatToken={app.hasAzurePatToken} />}

          {section === "paths" && (
            <div className="flex flex-col gap-3.5">
              <PathMappings key={generation} app={app} />
            </div>
          )}

          {section === "ai" && <AiSettings />}

          {section === "preferences" && <AppPreferencesCard />}

          {section === "updates" && <UpdatesCard key={generation} app={app} />}

          {section === "data" && <ImportCard />}
        </section>
      </div>

      <NewEnvironmentDialog open={newEnvOpen} onOpenChange={setNewEnvOpen} />
    </ResetContext>
    </RefreshContext>
  )
}
