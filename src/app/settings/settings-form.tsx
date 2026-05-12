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
  type SettingsActionState,
} from "./actions";

type EnvSetting = {
  environment: string;
  twxBaseUrl: string;
  hasAppKey: boolean;
};

function ExistingEnvCard({ setting }: { setting: EnvSetting }) {
  const [saveState, saveAction, savePending] = useActionState<
    SettingsActionState,
    FormData
  >(saveEnvironmentSettings, {});
  const [deleteState, deleteAction, deletePending] = useActionState<
    SettingsActionState,
    FormData
  >(deleteEnvironmentSettings, {});

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
            placeholder={setting.hasAppKey ? "Leave blank to keep existing key" : "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"}
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
          <Button
            type="submit"
            size="sm"
            disabled={savePending}
            className="h-7 text-xs"
          >
            {savePending ? "Saving…" : "Save"}
          </Button>
        </div>
      </form>
    </div>
  );
}

function NewEnvCard({ onCancel }: { onCancel: () => void }) {
  const [saveState, saveAction, savePending] = useActionState<
    SettingsActionState,
    FormData
  >(saveEnvironmentSettings, {});

  useEffect(() => {
    if (saveState.success) onCancel();
  }, [saveState.success, onCancel]);

  return (
    <div className="border border-dashed rounded-lg p-4 flex flex-col gap-3">
      <span className="text-sm font-medium text-muted-foreground">
        New Configuration
      </span>
      <form action={saveAction} className="flex flex-col gap-3">
        <div className="flex flex-col gap-1.5">
          <Label className="text-xs font-medium">Name</Label>
          <Input
            name="environment"
            placeholder="e.g. staging"
            required
            autoFocus
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label className="text-xs font-medium">TWX Base URL</Label>
          <Input
            name="twxBaseUrl"
            placeholder="https://your-thingworx-host/Thingworx"
          />
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
          <Button
            type="submit"
            size="sm"
            disabled={savePending}
            className="h-7 text-xs"
          >
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

type AzurePatProps = {
  hasToken: boolean;
};

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
          placeholder={hasToken ? "Leave blank to keep existing token" : "Enter your Azure Personal Access Token"}
        />
      </div>
      {state.error && (
        <p className="text-xs text-destructive">{state.error}</p>
      )}
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

type Props = {
  settings: EnvSetting[];
};

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
