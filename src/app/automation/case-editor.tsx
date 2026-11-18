"use client"

import { useState } from "react"
import { IconPlus, IconTrash } from "@tabler/icons-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { Textarea } from "@/components/ui/textarea"
import type { Assertion, TestCase } from "@/lib/automation"
import type { ServicePreset } from "@/lib/services"
import { EnvPicker, Field } from "./shared"

const COLLECTIONS = ["Things", "ThingTemplates", "ThingShapes", "Resources", "Subsystems", "Networks", "Users"]
const COUNT_OPS = [
  ["eq", "="],
  ["ne", "≠"],
  ["gt", ">"],
  ["gte", "≥"],
  ["lt", "<"],
  ["lte", "≤"],
]
const PATH_OPS = [
  ["equals", "equals"],
  ["notEquals", "does not equal"],
  ["contains", "contains"],
  ["exists", "exists"],
]
const KINDS: [Assertion["type"], string][] = [
  ["succeeds", "Succeeds"],
  ["maxMs", "Takes at most (ms)"],
  ["rowCount", "Row count"],
  ["jsonPath", "JSON path"],
  ["textContains", "Result contains"],
]

const blank: Record<Assertion["type"], Assertion> = {
  succeeds: { type: "succeeds" },
  maxMs: { type: "maxMs", ms: 5000 },
  rowCount: { type: "rowCount", op: "gt", value: 0 },
  jsonPath: { type: "jsonPath", path: "rows[0].name", op: "exists", value: "" },
  textContains: { type: "textContains", text: "" },
}

/** The expected value as typed: JSON when it parses (5, true, "x"), else the text itself. */
const parseValue = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}
const showValue = (v: unknown) => (typeof v === "string" ? v : v === undefined || v === null ? "" : JSON.stringify(v))

function AssertionRow({ a, onChange, onRemove }: { a: Assertion; onChange: (a: Assertion) => void; onRemove: () => void }) {
  const num = (v: string) => Number(v) || 0
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <NativeSelect value={a.type} onChange={(e) => onChange(blank[e.target.value as Assertion["type"]])}>
        {KINDS.map(([k, label]) => (
          <NativeSelectOption key={k} value={k}>
            {label}
          </NativeSelectOption>
        ))}
      </NativeSelect>
      {a.type === "maxMs" && (
        <Input type="number" className="w-28" value={a.ms} onChange={(e) => onChange({ ...a, ms: num(e.target.value) })} />
      )}
      {a.type === "rowCount" && (
        <>
          <NativeSelect value={a.op} onChange={(e) => onChange({ ...a, op: e.target.value })}>
            {COUNT_OPS.map(([k, label]) => (
              <NativeSelectOption key={k} value={k}>
                {label}
              </NativeSelectOption>
            ))}
          </NativeSelect>
          <Input type="number" className="w-24" value={a.value} onChange={(e) => onChange({ ...a, value: num(e.target.value) })} />
        </>
      )}
      {a.type === "jsonPath" && (
        <>
          <Input className="w-48 font-mono" placeholder="rows[0].name" value={a.path} onChange={(e) => onChange({ ...a, path: e.target.value })} />
          <NativeSelect value={a.op} onChange={(e) => onChange({ ...a, op: e.target.value })}>
            {PATH_OPS.map(([k, label]) => (
              <NativeSelectOption key={k} value={k}>
                {label}
              </NativeSelectOption>
            ))}
          </NativeSelect>
          {a.op !== "exists" && (
            <Input
              className="w-44"
              placeholder="value"
              value={showValue(a.value)}
              onChange={(e) => onChange({ ...a, value: parseValue(e.target.value) })}
            />
          )}
        </>
      )}
      {a.type === "textContains" && (
        <Input className="w-64" placeholder="text" value={a.text} onChange={(e) => onChange({ ...a, text: e.target.value })} />
      )}
      <Button variant="ghost" size="icon-sm" onClick={onRemove} aria-label="Remove assertion">
        <IconTrash />
      </Button>
    </div>
  )
}

export function CaseEditor({
  value,
  envs,
  presets,
  onChange,
  onRemove,
}: {
  value: TestCase
  envs: string[]
  presets: ServicePreset[]
  onChange: (c: TestCase) => void
  onRemove: () => void
}) {
  const [inputText, setInputText] = useState(() => JSON.stringify(value.inputs, null, 2))
  const [inputError, setInputError] = useState("")

  const editInputs = (text: string) => {
    setInputText(text)
    try {
      const parsed = JSON.parse(text.trim() || "{}")
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Inputs must be a JSON object.")
      setInputError("")
      onChange({ ...value, inputs: parsed })
    } catch (e) {
      setInputError(e instanceof Error ? e.message : "Not valid JSON.")
    }
  }

  const importPreset = (id: string) => {
    const p = presets.find((x) => String(x.id) === id)
    if (!p) return
    let inputs: Record<string, unknown> = {}
    try {
      inputs = JSON.parse(p.inputs || "{}")
    } catch {}
    setInputText(JSON.stringify(inputs, null, 2))
    setInputError("")
    onChange({ ...value, name: p.name, collection: p.entityType, entity: p.entityName, service: p.serviceName, inputs })
  }

  const setAssertion = (i: number, a: Assertion) => onChange({ ...value, assertions: value.assertions.map((x, j) => (j === i ? a : x)) })

  return (
    <div className="flex flex-col gap-3 rounded-xl border bg-card p-3">
      <div className="flex items-end gap-2">
        <Field label="Case name" className="flex-1">
          <Input value={value.name} onChange={(e) => onChange({ ...value, name: e.target.value })} />
        </Field>
        {presets.length > 0 && (
          <Field label="Import from service preset">
            <NativeSelect value="" onChange={(e) => importPreset(e.target.value)}>
              <NativeSelectOption value="">Choose…</NativeSelectOption>
              {presets.map((p) => (
                <NativeSelectOption key={p.id} value={String(p.id)}>
                  {p.name}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </Field>
        )}
        <Button variant="ghost" size="icon" onClick={onRemove} aria-label="Remove case">
          <IconTrash />
        </Button>
      </div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        <Field label="Collection">
          <NativeSelect className="w-full" value={COLLECTIONS.includes(value.collection) ? value.collection : "Things"} onChange={(e) => onChange({ ...value, collection: e.target.value })}>
            {COLLECTIONS.map((c) => (
              <NativeSelectOption key={c} value={c}>
                {c}
              </NativeSelectOption>
            ))}
            {!COLLECTIONS.includes(value.collection) && <NativeSelectOption value={value.collection}>{value.collection}</NativeSelectOption>}
          </NativeSelect>
        </Field>
        <Field label="Entity">
          <Input value={value.entity} onChange={(e) => onChange({ ...value, entity: e.target.value })} />
        </Field>
        <Field label="Service">
          <Input value={value.service} onChange={(e) => onChange({ ...value, service: e.target.value })} />
        </Field>
      </div>
      <Field label="Inputs (JSON object)">
        <Textarea
          className="min-h-16 font-mono text-xs"
          spellCheck={false}
          value={inputText}
          onChange={(e) => editInputs(e.target.value)}
          aria-invalid={!!inputError}
        />
        {inputError && <span className="text-destructive">{inputError}</span>}
      </Field>
      <div className="flex flex-col gap-1.5">
        <span className="text-[11px] font-medium text-muted-foreground">Assertions (all must pass; none means “succeeds”)</span>
        {value.assertions.map((a, i) => (
          <AssertionRow
            key={i}
            a={a}
            onChange={(next) => setAssertion(i, next)}
            onRemove={() => onChange({ ...value, assertions: value.assertions.filter((_, j) => j !== i) })}
          />
        ))}
        <Button
          variant="outline"
          size="sm"
          className="w-fit"
          onClick={() => onChange({ ...value, assertions: [...value.assertions, { type: "succeeds" }] })}
        >
          <IconPlus /> Add assertion
        </Button>
      </div>
      <div className="flex flex-col gap-1">
        <span className="text-[11px] font-medium text-muted-foreground">Only on environments (none = all the suite runs on)</span>
        <EnvPicker envs={envs} value={value.envs} onChange={(next) => onChange({ ...value, envs: next })} />
      </div>
    </div>
  )
}
