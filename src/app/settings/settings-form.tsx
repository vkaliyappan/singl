"use client";

import { useState, useEffect } from "react";
import { useActionState } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  saveEnvironmentSettings,
  deleteEnvironmentSettings,
  saveAzurePatToken,
  saveProjectConfig,
  deleteProjectConfig,
  saveComparePaths,
  type SettingsActionState,
} from "./actions";

export type ProjectConfig = {
  id: number;
  projectName: string;
  folderName: string;
  alias: string;
  exports: string[];
};

export type EnvSetting = {
  environment: string;
  twxBaseUrl: string;
  hasAppKey: boolean;
  projects: ProjectConfig[];
};

// ── Project cards ──────────────────────────────────────────────────────────

function ProjectCard({
  project,
  environment,
  onSuccess,
}: {
  project: ProjectConfig;
  environment: string;
  onSuccess?: () => void;
}) {
  const [saveState, saveAction, savePending] = useActionState<SettingsActionState, FormData>(
    saveProjectConfig,
    {}
  );
  const [deleteState, deleteAction, deletePending] = useActionState<SettingsActionState, FormData>(
    deleteProjectConfig,
    {}
  );

  useEffect(() => {
    if (saveState.success || deleteState.success) onSuccess?.();
  }, [saveState.success, deleteState.success, onSuccess]);

  const exportsDisplay = project.exports.join(", ");

  return (
    <div className="border rounded p-3 flex flex-col gap-2 bg-muted/20">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium font-mono">{project.projectName}</span>
        <form action={deleteAction}>
          <input type="hidden" name="id" value={project.id} />
          <Button
            variant="ghost"
            size="sm"
            type="submit"
            disabled={deletePending}
            className="h-6 text-xs text-destructive hover:text-destructive px-2"
          >
            {deletePending ? "Deleting…" : "Delete"}
          </Button>
        </form>
      </div>

      <form action={saveAction} className="flex flex-col gap-2">
        <input type="hidden" name="id" value={project.id} />
        <input type="hidden" name="environment" value={environment} />

        <div className="grid grid-cols-2 gap-2">
          <div className="flex flex-col gap-1">
            <Label className="text-[11px] text-muted-foreground">TWX Project Name</Label>
            <Input
              name="projectName"
              defaultValue={project.projectName}
              placeholder="ActualTWXProjectName"
              className="h-7 text-xs"
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label className="text-[11px] text-muted-foreground">Alias (output folder)</Label>
            <Input
              name="alias"
              defaultValue={project.alias}
              placeholder={project.projectName}
              className="h-7 text-xs"
            />
          </div>
        </div>

        <div className="flex flex-col gap-1">
          <Label className="text-[11px] text-muted-foreground">
            Folder Name{" "}
            <span className="text-muted-foreground/60">(overrides project name in export path)</span>
          </Label>
          <Input
            name="folderName"
            defaultValue={project.folderName}
            placeholder={project.projectName}
            className="h-7 text-xs font-mono"
          />
        </div>

        <div className="flex flex-col gap-1">
          <Label className="text-[11px] text-muted-foreground">
            Export types{" "}
            <span className="text-muted-foreground/60">(comma-separated, or &quot;all&quot;)</span>
          </Label>
          <Input
            name="exports"
            defaultValue={exportsDisplay}
            placeholder="all"
            className="h-7 text-xs font-mono"
          />
        </div>

        {(saveState.error || deleteState.error) && (
          <p className="text-xs text-destructive">{saveState.error ?? deleteState.error}</p>
        )}
        {saveState.success && (
          <p className="text-xs text-green-600 dark:text-green-400">Saved.</p>
        )}
        <div>
          <Button type="submit" size="sm" disabled={savePending} className="h-6 text-xs">
            {savePending ? "Saving…" : "Save"}
          </Button>
        </div>
      </form>
    </div>
  );
}

function NewProjectCard({
  environment,
  onCancel,
  onSuccess,
}: {
  environment: string;
  onCancel: () => void;
  onSuccess?: () => void;
}) {
  const [saveState, saveAction, savePending] = useActionState<SettingsActionState, FormData>(
    saveProjectConfig,
    {}
  );

  useEffect(() => {
    if (saveState.success) {
      onSuccess?.();
      onCancel();
    }
  }, [saveState.success, onCancel, onSuccess]);

  return (
    <div className="border border-dashed rounded p-3 flex flex-col gap-2">
      <span className="text-xs font-medium text-muted-foreground">New Project</span>
      <form action={saveAction} className="flex flex-col gap-2">
        <input type="hidden" name="environment" value={environment} />

        <div className="grid grid-cols-2 gap-2">
          <div className="flex flex-col gap-1">
            <Label className="text-[11px] text-muted-foreground">TWX Project Name</Label>
            <Input
              name="projectName"
              placeholder="ActualTWXProjectName"
              required
              autoFocus
              className="h-7 text-xs"
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label className="text-[11px] text-muted-foreground">Alias (output folder)</Label>
            <Input
              name="alias"
              placeholder="optional"
              className="h-7 text-xs"
            />
          </div>
        </div>

        <div className="flex flex-col gap-1">
          <Label className="text-[11px] text-muted-foreground">
            Folder Name{" "}
            <span className="text-muted-foreground/60">(overrides project name in export path)</span>
          </Label>
          <Input
            name="folderName"
            placeholder="optional"
            className="h-7 text-xs font-mono"
          />
        </div>

        <div className="flex flex-col gap-1">
          <Label className="text-[11px] text-muted-foreground">
            Export types{" "}
            <span className="text-muted-foreground/60">(comma-separated, or &quot;all&quot;)</span>
          </Label>
          <Input
            name="exports"
            defaultValue="all"
            placeholder="all"
            className="h-7 text-xs font-mono"
          />
        </div>

        {saveState.error && (
          <p className="text-xs text-destructive">{saveState.error}</p>
        )}
        <div className="flex gap-2">
          <Button type="submit" size="sm" disabled={savePending} className="h-6 text-xs">
            {savePending ? "Adding…" : "Add"}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onCancel}
            className="h-6 text-xs"
          >
            Cancel
          </Button>
        </div>
      </form>
    </div>
  );
}

// ── Env cards ──────────────────────────────────────────────────────────────

export function ExistingEnvCard({
  setting,
  onSuccess,
}: {
  setting: EnvSetting;
  onSuccess?: () => void;
}) {
  const [saveState, saveAction, savePending] = useActionState<SettingsActionState, FormData>(
    saveEnvironmentSettings,
    {}
  );
  const [deleteState, deleteAction, deletePending] = useActionState<SettingsActionState, FormData>(
    deleteEnvironmentSettings,
    {}
  );
  const [showProjects, setShowProjects] = useState(false);
  const [showNewProject, setShowNewProject] = useState(false);

  useEffect(() => {
    if (saveState.success || deleteState.success) onSuccess?.();
  }, [saveState.success, deleteState.success, onSuccess]);

  return (
    <div className="border rounded-lg p-4 flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium">{setting.environment}</span>
        <form action={deleteAction}>
          <input type="hidden" name="environment" value={setting.environment} />
          <Button
            variant="ghost"
            size="sm"
            type="submit"
            disabled={deletePending}
            className="h-7 text-xs text-destructive hover:text-destructive"
          >
            {deletePending ? "Deleting…" : "Delete"}
          </Button>
        </form>
      </div>

      <form action={saveAction} className="flex flex-col gap-3">
        <input type="hidden" name="environment" value={setting.environment} />
        <div className="flex flex-col gap-1.5">
          <Label className="text-xs font-medium">TWX Base URL</Label>
          <Input
            name="twxBaseUrl"
            defaultValue={setting.twxBaseUrl}
            placeholder="https://your-thingworx-host/Thingworx"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label className="text-xs font-medium">TWX App Key</Label>
          <Input
            name="twxAppKey"
            type="password"
            autoComplete="new-password"
            placeholder={
              setting.hasAppKey
                ? "Leave blank to keep existing key"
                : "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
            }
          />
        </div>
        {saveState.error && (
          <p className="text-xs text-destructive">{saveState.error}</p>
        )}
        {deleteState.error && (
          <p className="text-xs text-destructive">{deleteState.error}</p>
        )}
        {saveState.success && (
          <p className="text-xs text-green-600 dark:text-green-400">Saved.</p>
        )}
        <div>
          <Button type="submit" size="sm" disabled={savePending} className="h-7 text-xs">
            {savePending ? "Saving…" : "Save"}
          </Button>
        </div>
      </form>

      {/* Projects section */}
      <div className="border-t pt-2 flex flex-col gap-2">
        <button
          type="button"
          onClick={() => setShowProjects((v) => !v)}
          className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors self-start"
        >
          <span
            className="inline-block transition-transform duration-100"
            style={{ transform: showProjects ? "rotate(90deg)" : "rotate(0deg)" }}
          >
            ›
          </span>
          Projects
          {setting.projects.length > 0 && (
            <span className="text-[10px] bg-muted rounded px-1.5 py-0.5">
              {setting.projects.length}
            </span>
          )}
        </button>

        {showProjects && (
          <div className="flex flex-col gap-2 pl-3">
            {setting.projects.map((p) => (
              <ProjectCard
                key={p.id}
                project={p}
                environment={setting.environment}
                onSuccess={onSuccess}
              />
            ))}

            {showNewProject ? (
              <NewProjectCard
                environment={setting.environment}
                onCancel={() => setShowNewProject(false)}
                onSuccess={onSuccess}
              />
            ) : (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setShowNewProject(true)}
                className="self-start h-6 text-xs"
              >
                + Add Project
              </Button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export function NewEnvCard({
  onCancel,
  onSuccess,
}: {
  onCancel: () => void;
  onSuccess?: () => void;
}) {
  const [saveState, saveAction, savePending] = useActionState<SettingsActionState, FormData>(
    saveEnvironmentSettings,
    {}
  );

  useEffect(() => {
    if (saveState.success) {
      onSuccess?.();
      onCancel();
    }
  }, [saveState.success, onCancel, onSuccess]);

  return (
    <div className="border border-dashed rounded-lg p-4 flex flex-col gap-3">
      <span className="text-sm font-medium text-muted-foreground">New Configuration</span>
      <form action={saveAction} className="flex flex-col gap-3">
        <div className="flex flex-col gap-1.5">
          <Label className="text-xs font-medium">Name</Label>
          <Input name="environment" placeholder="e.g. staging" required autoFocus />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label className="text-xs font-medium">TWX Base URL</Label>
          <Input name="twxBaseUrl" placeholder="https://your-thingworx-host/Thingworx" />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label className="text-xs font-medium">TWX App Key</Label>
          <Input
            name="twxAppKey"
            type="password"
            autoComplete="new-password"
            placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
          />
        </div>
        {saveState.error && (
          <p className="text-xs text-destructive">{saveState.error}</p>
        )}
        <div className="flex gap-2">
          <Button type="submit" size="sm" disabled={savePending} className="h-7 text-xs">
            {savePending ? "Adding…" : "Add"}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onCancel}
            className="h-7 text-xs"
          >
            Cancel
          </Button>
        </div>
      </form>
    </div>
  );
}

type AzurePatProps = { hasToken: boolean };

export function AzurePatForm({ hasToken }: AzurePatProps) {
  const [state, action, pending] = useActionState<SettingsActionState, FormData>(
    saveAzurePatToken,
    {}
  );

  return (
    <form action={action} className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <Label className="text-xs font-medium">Azure PAT Token</Label>
        <Input
          name="azurePatToken"
          type="password"
          autoComplete="new-password"
          placeholder={
            hasToken
              ? "Leave blank to keep existing token"
              : "Enter your Azure Personal Access Token"
          }
        />
      </div>
      {state.error && <p className="text-xs text-destructive">{state.error}</p>}
      {state.success && (
        <p className="text-xs text-green-600 dark:text-green-400">Saved.</p>
      )}
      <div>
        <Button type="submit" size="sm" disabled={pending} className="h-7 text-xs">
          {pending ? "Saving…" : "Save"}
        </Button>
      </div>
    </form>
  );
}

type ComparePathsProps = { twxRootPrefix: string; repoRootSubpath: string };

export function ComparePathsForm({ twxRootPrefix, repoRootSubpath }: ComparePathsProps) {
  const [state, action, pending] = useActionState<SettingsActionState, FormData>(
    saveComparePaths,
    {}
  );
  const [prefix, setPrefix] = useState(twxRootPrefix);
  const [subpath, setSubpath] = useState(repoRootSubpath);

  return (
    <form action={action} className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <Label className="text-xs font-medium">TWX Root Prefix</Label>
        <Input
          name="twxRootPrefix"
          value={prefix}
          onChange={(e) => setPrefix(e.target.value)}
          placeholder="WindchillClients/Thingworx"
          className="font-mono text-xs"
        />
        <p className="text-[11px] text-muted-foreground">
          Path under <code className="font-mono">twx-entities/&#123;env&#125;/</code> used as the TWX root.
          Files are compared by relative path from this point.
          e.g. <code className="font-mono">WindchillClients/Thingworx</code>
        </p>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label className="text-xs font-medium">Repo Root Subpath</Label>
        <Input
          name="repoRootSubpath"
          value={subpath}
          onChange={(e) => setSubpath(e.target.value)}
          placeholder="(repo root)"
          className="font-mono text-xs"
        />
        <p className="text-[11px] text-muted-foreground">
          Subfolder inside the cloned repo that mirrors the TWX root above.
          Both roots must produce the same relative paths for files to match.
          e.g. if TWX root ends at <code className="font-mono">Thingworx/</code> and your repo has a <code className="font-mono">Thingworx/</code> folder, set this to <code className="font-mono">Thingworx</code>.
        </p>
      </div>
      {state.error && <p className="text-xs text-destructive">{state.error}</p>}
      {state.success && (
        <p className="text-xs text-green-600 dark:text-green-400">Saved.</p>
      )}
      <div>
        <Button type="submit" size="sm" disabled={pending} className="h-7 text-xs">
          {pending ? "Saving…" : "Save"}
        </Button>
      </div>
    </form>
  );
}

type Props = { settings: EnvSetting[] };

export function SettingsForm({ settings }: Props) {
  const [showNew, setShowNew] = useState(false);

  return (
    <div className="flex flex-col gap-3">
      {settings.map((s) => (
        <ExistingEnvCard key={s.environment} setting={s} />
      ))}

      {showNew && <NewEnvCard onCancel={() => setShowNew(false)} />}

      {!showNew && (
        <Button
          variant="outline"
          size="sm"
          onClick={() => setShowNew(true)}
          className="self-start h-7 text-xs"
        >
          + Add Configuration
        </Button>
      )}
    </div>
  );
}
