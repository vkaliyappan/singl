"use client"

import { IconTrash } from "@tabler/icons-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import type { ModelInfo, ProviderInfo } from "@/lib/assistant/api"
import type { UiTestMode, UiTestSuite } from "@/lib/ui-tests"
import { Field } from "../automation/shared"

/** Suite settings: identity, environment, browser mode and the model that drives the browser. */
export function SettingsTab({
  suite,
  envs,
  providers,
  models,
  dirty,
  busy,
  locked,
  onEdit,
  onSave,
  onDelete,
}: {
  suite: UiTestSuite
  envs: string[]
  providers: ProviderInfo[]
  models: ModelInfo[]
  dirty: boolean
  busy: boolean
  locked: boolean
  onEdit: (part: Partial<UiTestSuite>) => void
  onSave: () => void
  onDelete: () => void
}) {
  const modelList = suite.provider ? models : []
  return (
    <div className="h-full min-h-0 overflow-y-auto p-4">
      <div className="flex max-w-2xl flex-col gap-3">
        <Field label="Suite name">
          <Input value={suite.name} onChange={(e) => onEdit({ name: e.target.value })} />
        </Field>
        <Field label="Description">
          <Input value={suite.description} onChange={(e) => onEdit({ description: e.target.value })} />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Environment">
            <NativeSelect className="w-full" value={suite.envId} onChange={(e) => onEdit({ envId: e.target.value })}>
              <NativeSelectOption value="">None</NativeSelectOption>
              {suite.envId && !envs.includes(suite.envId) && <NativeSelectOption value={suite.envId}>{suite.envId}</NativeSelectOption>}
              {envs.map((e) => (
                <NativeSelectOption key={e} value={e}>{e}</NativeSelectOption>
              ))}
            </NativeSelect>
          </Field>
          <Field label="Browser mode">
            <NativeSelect className="w-full" value={suite.mode} onChange={(e) => onEdit({ mode: e.target.value as UiTestMode })}>
              <NativeSelectOption value="headless">Headless</NativeSelectOption>
              <NativeSelectOption value="headed">Headed</NativeSelectOption>
            </NativeSelect>
          </Field>
          <Field label="Provider (blank = app default)">
            <NativeSelect className="w-full" value={suite.provider} onChange={(e) => onEdit({ provider: e.target.value, model: "" })}>
              <NativeSelectOption value="">App default</NativeSelectOption>
              {suite.provider && !providers.some((p) => p.id === suite.provider) && (
                <NativeSelectOption value={suite.provider}>{suite.provider}</NativeSelectOption>
              )}
              {providers.map((p) => (
                <NativeSelectOption key={p.id} value={p.id}>{p.title}</NativeSelectOption>
              ))}
            </NativeSelect>
          </Field>
          <Field label="Model">
            <NativeSelect className="w-full" value={suite.model} disabled={!suite.provider} onChange={(e) => onEdit({ model: e.target.value })}>
              <NativeSelectOption value="">Default</NativeSelectOption>
              {suite.model && !modelList.some((m) => m.id === suite.model) && (
                <NativeSelectOption value={suite.model}>{suite.model}</NativeSelectOption>
              )}
              {modelList.map((m) => (
                <NativeSelectOption key={m.id} value={m.id}>{m.name || m.id}</NativeSelectOption>
              ))}
            </NativeSelect>
          </Field>
        </div>
        <div className="flex items-center gap-2 pt-1">
          <Button size="sm" onClick={onSave} disabled={!dirty || busy}>
            {suite.id ? "Save settings" : "Create suite"}
          </Button>
          <Button size="sm" variant="ghost" onClick={onDelete} disabled={locked}>
            <IconTrash /> {suite.id ? "Delete suite" : "Discard"}
          </Button>
          {dirty && <span className="text-xs text-muted-foreground">Unsaved settings</span>}
        </div>
      </div>
    </div>
  )
}
