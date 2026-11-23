"use client";

import { invoke } from "@tauri-apps/api/core";

import { useEffect, useState } from "react";
import { IconPlus, IconTrash } from "@tabler/icons-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import {
  AGENT_DEFS,
  AGENT_PROVIDERS,
  DEFAULT_AGENT_TIMEOUT_MS,
  MAX_AGENT_TIMEOUT_MS,
  buildAgentArgs,
} from "@/lib/twx-flow/agents";
import { OPERATORS, OPERATOR_GROUPS, operatorDef } from "@/lib/twx-flow/conditions";
import { newId } from "@/lib/twx-flow/ids";
import { newCondition } from "@/lib/twx-flow/nodes";
import { toRows } from "@/lib/twx-flow/schema";
import type { ExprContext } from "@/lib/twx-flow/expression";
import type {
  AgentProvider,
  FieldDef,
  FilterCondition,
  FilterOperator,
  FlowNode,
  NodePatch,
  NodeRunState,
  SwitchRule,
} from "@/lib/twx-flow/types";
import type { ServiceParam } from "@/lib/twx/types";
import { ExpressionField } from "./expression-field";
import { ModelPicker } from "./model-picker";

/**
 * The condition fields reuse the parameter editor, so they need descriptors.
 *
 * A condition is text, not a BOOLEAN: typing it in Fixed mode has to give a
 * field to type in, not a true/false dropdown.
 */
const param = (name: string, description: string, baseType = "STRING"): ServiceParam => ({
  name,
  description,
  baseType,
  ordinal: 0,
  aspects: { isRequired: true },
});

export const CONDITION_PARAM = param(
  "Condition",
  "True sends the flow down the top branch, false down the bottom one. An empty infotable or array counts as false."
);

const FILTER_PARAM = param(
  "Condition",
  "Evaluated once per row. `$item` is the row under test and `$index` its position — e.g. {{ $item.enabled }}. Rows it is true for are kept."
);

const STOP_PARAM = param(
  "Error message",
  "Text the run fails with. Expressions are allowed, so the message can name what went wrong.",
  "STRING"
);

const UNTIL_PARAM = param(
  "Resume at",
  "A date or ISO timestamp to wait for, e.g. {{ $json.rows[0].dueAt }}. Anything in the past resumes immediately.",
  "DATETIME"
);

/** Label above a plain (non-expression) control. */
function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1 border-b pb-2.5 last:border-b-0">
      <p className="text-xs font-medium">{label}</p>
      {children}
      {hint && <p className="text-[10px] leading-snug text-muted-foreground">{hint}</p>}
    </div>
  );
}

/** Wire-order reminder for the nodes that read more than one input. */
function InputOrder({ node, parents }: { node: FlowNode; parents: string[] }) {
  const names = node.kind === "compare" ? ["Input A", "Input B"] : ["Input 1", "Input 2"];
  return (
    <div className="flex flex-col gap-1 rounded-md border border-dashed p-2">
      <p className="text-[10px] text-muted-foreground">
        Inputs are taken in wire order. Use “Make $json” on the left to swap them round.
      </p>
      {names.map((name, index) => (
        <p key={name} className="flex items-center gap-1.5 text-xs">
          <Badge variant="outline" className="text-[9px]">
            {name}
          </Badge>
          <span className={cn("truncate", !parents[index] && "text-muted-foreground")}>
            {parents[index] ?? "nothing wired in"}
          </span>
        </p>
      ))}
    </div>
  );
}

/* ----------------------------------------------------- the Filter builder -- */

const LEFT_PARAM = param(
  "Value 1",
  "A column of the incoming rows, or an expression. Drop a field from the Input panel to build one."
);
const RIGHT_PARAM = param("Value 2", "What that value is compared with.");

/** One `column · operator · value` row. Both sides take Fixed or Expression. */
function ConditionRow({
  condition,
  fields,
  ctx,
  onChange,
  onRemove,
}: {
  condition: FilterCondition;
  fields: FieldDef[];
  /** Already carries `$item` — the first incoming row — so previews show data. */
  ctx: ExprContext;
  onChange: (change: Partial<FilterCondition>) => void;
  onRemove: () => void;
}) {
  const op = operatorDef(condition.operator);
  const column = fields.find((f) => f.name === condition.left?.trim());
  const columnNames = fields.map((f) => f.name);

  return (
    <div className="flex flex-col gap-2 rounded-md border p-2">
      <div className="flex items-start gap-1.5">
        <div className="min-w-0 flex-1">
          <ExpressionField
            compact
            param={LEFT_PARAM}
            label={column ? `Value 1 · ${column.baseType}` : "Value 1"}
            value={condition.left}
            ctx={ctx}
            suggestions={columnNames}
            onChange={(left) => onChange({ left })}
          />
        </div>
        <Button
          variant="ghost"
          size="icon-xs"
          className="mt-0.5 shrink-0 text-muted-foreground hover:text-destructive"
          aria-label="Delete condition"
          onClick={onRemove}
        >
          <IconTrash />
        </Button>
      </div>

      <NativeSelect
        className="w-full"
        value={condition.operator}
        onChange={(e) => onChange({ operator: e.target.value as FilterOperator })}
        aria-label="Operator"
      >
        {OPERATOR_GROUPS.map((group) => (
          <optgroup key={group} label={group}>
            {OPERATORS.filter((o) => o.group === group).map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </optgroup>
        ))}
      </NativeSelect>

      {!op.unary && (
        <ExpressionField
          compact
          param={RIGHT_PARAM}
          label={op.as === "number" ? "Value 2 · number" : op.as === "date" ? "Value 2 · date" : "Value 2"}
          value={condition.right}
          ctx={ctx}
          onChange={(right) => onChange({ right })}
        />
      )}
    </div>
  );
}

/**
 * The Filter node's conditions: one test per row, combined with AND or OR.
 *
 * Rows here are infotable rows, so the left-hand side is a column name — the
 * incoming DataShape fills the list — and `{{ … }}` is there for the rest.
 */
function ConditionBuilder({
  node,
  fields,
  ctx,
  onChange,
}: {
  node: FlowNode & { kind: "filter" };
  fields: FieldDef[];
  ctx: ExprContext;
  onChange: (patch: NodePatch) => void;
}) {
  const conditions = node.conditions ?? [];

  // Expressions here run per row, so previews are shown against the first row
  // of whatever is coming in rather than against the whole table.
  const rowCtx: ExprContext = {
    ...ctx,
    $item: toRows(ctx.$json)[0],
    $index: 0,
  };

  const patch = (id: string, change: Partial<FilterCondition>) =>
    onChange({ conditions: conditions.map((c) => (c.id === id ? { ...c, ...change } : c)) });

  return (
    <div className="flex flex-col gap-2">
      {conditions.map((condition, index) => (
        <div key={condition.id} className="flex flex-col gap-2">
          {index > 0 && (
            <div className="flex items-center gap-2">
              <NativeSelect
                size="sm"
                className="w-20"
                value={node.combinator}
                onChange={(e) => onChange({ combinator: e.target.value as "and" | "or" })}
                aria-label="How the conditions combine"
              >
                <option value="and">AND</option>
                <option value="or">OR</option>
              </NativeSelect>
              <span className="h-px flex-1 bg-border" />
            </div>
          )}
          <ConditionRow
            condition={condition}
            fields={fields}
            ctx={rowCtx}
            onChange={(change) => patch(condition.id, change)}
            onRemove={() =>
              onChange({ conditions: conditions.filter((c) => c.id !== condition.id) })
            }
          />
        </div>
      ))}

      <Button
        size="xs"
        variant="outline"
        className="self-start"
        onClick={() => onChange({ conditions: [...conditions, newCondition()] })}
      >
        <IconPlus />
        Add condition
      </Button>

      <label className="mt-1 flex items-center gap-2 text-xs">
        <Switch
          checked={node.convertTypes}
          onCheckedChange={(checked) => onChange({ convertTypes: checked === true })}
        />
        Convert types where required
      </label>
      <p className="text-[10px] leading-snug text-muted-foreground">
        Off, a column holding the text <span className="font-mono">&quot;12&quot;</span> is not the
        number 12. On, it is.
      </p>
    </div>
  );
}

function SwitchRules({
  rules,
  ctx,
  onChange,
}: {
  rules: SwitchRule[];
  ctx: ExprContext;
  onChange: (rules: SwitchRule[]) => void;
}) {
  const patch = (id: string, change: Partial<SwitchRule>) =>
    onChange(rules.map((rule) => (rule.id === id ? { ...rule, ...change } : rule)));

  return (
    <div className="flex flex-col gap-2">
      {rules.map((rule, index) => (
        <div key={rule.id} className="flex flex-col gap-1.5 rounded-md border p-2">
          <div className="flex items-center gap-1.5">
            <Badge variant="outline" className="shrink-0 text-[9px]">
              output {index + 1}
            </Badge>
            <Input
              value={rule.name}
              onChange={(e) => patch(rule.id, { name: e.target.value })}
              placeholder={`rule ${index + 1}`}
              className="h-6 flex-1 text-xs"
              aria-label={`Name of rule ${index + 1}`}
            />
            <Button
              variant="ghost"
              size="icon-xs"
              className="text-muted-foreground hover:text-destructive"
              aria-label={`Delete rule ${index + 1}`}
              onClick={() => onChange(rules.filter((r) => r.id !== rule.id))}
            >
              <IconTrash />
            </Button>
          </div>
          <ExpressionField
            param={param(
              "When",
              "The first rule that is true wins. An empty infotable or array counts as false."
            )}
            value={rule.condition}
            ctx={ctx}
            onChange={(condition) => patch(rule.id, { condition })}
          />
        </div>
      ))}
      <Button
        size="xs"
        variant="outline"
        className="self-start"
        onClick={() =>
          onChange([...rules, { id: newId(), name: `rule ${rules.length + 1}`, condition: "" }])
        }
      >
        <IconPlus />
        Add rule
      </Button>
    </div>
  );
}

type FlowOption = { id: string; name: string };

function SubflowPicker({
  node,
  onChange,
}: {
  node: FlowNode & { kind: "subflow" };
  onChange: (patch: NodePatch) => void;
}) {
  const [flows, setFlows] = useState<FlowOption[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const rows = await invoke<FlowOption[]>("flow_list");
        if (!cancelled) setFlows(rows.map(({ id, name }) => ({ id, name })));
      } catch {
        if (!cancelled) setFlows([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <Field
      label="Flow to run"
      hint="Whatever is wired into this node arrives as $json in the sub-flow's first nodes, and the sub-flow's last node becomes this node's output. A flow cannot call itself."
    >
      <NativeSelect
        className="w-full"
        value={node.flowId}
        onChange={(e) => {
          const flowId = e.target.value;
          onChange({ flowId, flowName: flows?.find((f) => f.id === flowId)?.name ?? "" });
        }}
      >
        <option value="">{flows === null ? "Loading…" : "Pick a flow…"}</option>
        {(flows ?? []).map((flow) => (
          <option key={flow.id} value={flow.id}>
            {flow.name}
          </option>
        ))}
      </NativeSelect>
    </Field>
  );
}

const AGENT_PROMPT_PARAM = param(
  "Prompt",
  "What the agent is asked to do. Expressions are allowed, so a row from an earlier node can become part of the instruction — e.g. {{ $json.rows[0].description }}."
);

/**
 * The Agent node's settings: which CLI, what to ask it, and the few switches
 * that decide how far it is allowed to go.
 *
 * The command line is shown as it will be run — the CLIs disagree about their
 * flags, and seeing the real argv is faster than guessing which one this is.
 */
function AgentSettings({
  node,
  ctx,
  state,
  onChange,
}: {
  node: FlowNode & { kind: "agent" };
  ctx: ExprContext;
  state?: NodeRunState;
  onChange: (patch: NodePatch) => void;
}) {
  const def = AGENT_DEFS[node.provider] ?? AGENT_DEFS.claude;
  const preview = [
    def.bin,
    ...buildAgentArgs({
      provider: node.provider,
      prompt: "<prompt>",
      model: node.model,
      outputMode: node.outputMode === "json" ? "json" : "text",
      autoApprove: node.autoApprove,
      extraArgs: node.extraArgs,
    }),
  ].join(" ");

  return (
    <div className="flex flex-col gap-2.5">
      <Field
        label="Agent"
        hint={`Runs on this computer. The ${def.bin} CLI has to be installed and on PATH, and switched on under Settings → AI Agents.`}
      >
        <NativeSelect
          className="w-full"
          value={node.provider}
          onChange={(e) => onChange({ provider: e.target.value as AgentProvider })}
        >
          {AGENT_PROVIDERS.map((provider) => (
            <option key={provider} value={provider}>
              {AGENT_DEFS[provider].title}
            </option>
          ))}
        </NativeSelect>
      </Field>

      {/* A prompt is prose, not a value — it gets a box rather than a line. */}
      <ExpressionField
        param={AGENT_PROMPT_PARAM}
        value={node.prompt ?? ""}
        ctx={ctx}
        multiline
        runError={state?.status === "error" ? state.error : undefined}
        onChange={(prompt) => onChange({ prompt })}
      />

      {/* Keyed so switching CLI starts the picker clean rather than keeping the
          previous one's custom-entry state. */}
      <Field label="Model">
        <ModelPicker
          key={`${node.id}:${node.provider}`}
          provider={node.provider}
          value={node.model ?? ""}
          onChange={(model) => onChange({ model })}
        />
      </Field>

      <Field
        label="Working directory"
        hint="Where the agent runs, relative to the agent root (your workspace folder, or TWX_FLOW_AGENT_ROOT). Empty means the root itself. Anything outside it is refused."
      >
        <Input
          value={node.cwd ?? ""}
          onChange={(e) => onChange({ cwd: e.target.value })}
          placeholder="."
          className="h-7 text-xs"
        />
      </Field>

      <Field
        label="Output"
        hint={
          node.outputMode === "json"
            ? "Asks the CLI for machine-readable output and parses it, so downstream nodes can read fields off it."
            : "Keeps what the CLI printed, as text."
        }
      >
        <NativeSelect
          className="w-full"
          value={node.outputMode}
          onChange={(e) => onChange({ outputMode: e.target.value as "text" | "json" })}
        >
          <option value="text">Text — whatever it printed</option>
          <option value="json">JSON — parsed</option>
        </NativeSelect>
      </Field>

      <Field
        label="Timeout"
        hint="Milliseconds before the process is killed. An hour is the ceiling; the run route allows the same."
      >
        <Input
          type="number"
          min={1000}
          step={1000}
          value={node.timeoutMs ?? DEFAULT_AGENT_TIMEOUT_MS}
          onChange={(e) =>
            onChange({
              timeoutMs: Math.min(
                MAX_AGENT_TIMEOUT_MS,
                Math.max(1_000, Number(e.target.value) || DEFAULT_AGENT_TIMEOUT_MS)
              ),
            })
          }
          className="h-7 w-32 text-xs"
        />
      </Field>

      <Field label="Extra arguments" hint="Appended to the command as written. Quotes group; nothing is expanded.">
        <Input
          value={node.extraArgs ?? ""}
          onChange={(e) => onChange({ extraArgs: e.target.value })}
          placeholder="--add-dir ./src"
          className="h-7 text-xs"
        />
      </Field>

      <div className="flex flex-col gap-1 border-b pb-2.5">
        <label className="flex items-center gap-2 text-xs">
          <Checkbox
            checked={node.autoApprove === true}
            onCheckedChange={(checked) => onChange({ autoApprove: checked === true })}
          />
          Let the agent run its own tools unattended
        </label>
        <p className="text-[10px] leading-snug text-muted-foreground">
          Adds <span className="font-mono">{def.approveArgs.join(" ")}</span>, which{" "}
          {def.approveHint}. The agent can then edit files and run commands in its working
          directory with nobody watching — leave this off unless that is the point.
        </p>
      </div>

      <div className="flex flex-col gap-1">
        <p className="text-xs font-medium">Command</p>
        <pre className="overflow-x-auto rounded-md border bg-muted/40 p-2 text-[10px] leading-snug">
          {preview}
        </pre>
        {def.promptVia === "stdin" && (
          <p className="text-[10px] leading-snug text-muted-foreground">
            The prompt goes in on standard input — no shell ever sees it.
          </p>
        )}
      </div>
    </div>
  );
}

/**
 * The middle column of the node panel for everything that is not a service
 * call or a code snippet: the settings each flow-control node needs.
 */
export function NodeSettings({
  node,
  ctx,
  state,
  parents,
  fields,
  onChange,
}: {
  node: FlowNode;
  ctx: ExprContext;
  state?: NodeRunState;
  /** Labels of the nodes wired in, in wire order. */
  parents: string[];
  /** Columns of the incoming infotable, offered as the left side of a test. */
  fields: FieldDef[];
  onChange: (patch: NodePatch) => void;
}) {
  switch (node.kind) {
    case "agent":
      return <AgentSettings node={node} ctx={ctx} state={state} onChange={onChange} />;

    case "if":
      return (
        <ExpressionField
          param={CONDITION_PARAM}
          value={node.condition ?? ""}
          ctx={ctx}
          runError={state?.status === "error" ? state.error : undefined}
          onChange={(condition) => onChange({ condition })}
        />
      );

    case "filter":
      return (
        <div className="flex flex-col gap-2.5">
          {/* Two ways to say the same thing, as in n8n: the builder, or one
              expression over the whole row. */}
          <div className="flex items-center gap-1.5">
            <span className="text-xs font-medium">Conditions</span>
            <div className="ml-auto flex overflow-hidden rounded-md border">
              {(["rules", "expression"] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() =>
                    onChange({
                      mode,
                      // Land in the expression editor rather than in an empty
                      // literal field that looks like nothing happened.
                      ...(mode === "expression" && !node.condition?.trim()
                        ? { condition: "{{  }}" }
                        : {}),
                    })
                  }
                  className={cn(
                    "px-2 py-0.5 text-[10px] capitalize",
                    node.mode === mode
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:bg-accent"
                  )}
                >
                  {mode === "rules" ? "Builder" : "Expression"}
                </button>
              ))}
            </div>
          </div>

          {node.mode === "expression" ? (
            <ExpressionField
              param={FILTER_PARAM}
              value={node.condition ?? ""}
              ctx={ctx}
              runError={state?.status === "error" ? state.error : undefined}
              onChange={(condition) => onChange({ condition })}
            />
          ) : (
            <ConditionBuilder node={node} fields={fields} ctx={ctx} onChange={onChange} />
          )}
        </div>
      );

    case "switch":
      return (
        <div className="flex flex-col gap-2.5">
          <SwitchRules
            rules={node.rules ?? []}
            ctx={ctx}
            onChange={(rules) => onChange({ rules })}
          />
          <label className="flex items-center gap-2 text-xs">
            <Checkbox
              checked={node.fallback}
              onCheckedChange={(checked) => onChange({ fallback: checked === true })}
            />
            Add a fallback output for input that matches no rule
          </label>
        </div>
      );

    case "loop":
      return (
        <div className="flex flex-col gap-2.5">
          <Field
            label="Batch size"
            hint="Rows handed out per pass. Wire the end of the loop body back into this node — that return wire is what asks for the next batch."
          >
            <Input
              type="number"
              min={1}
              value={node.batchSize}
              onChange={(e) => onChange({ batchSize: Math.max(1, Number(e.target.value) || 1) })}
              className="h-7 w-28 text-xs"
            />
          </Field>
          <p className="text-[10px] leading-snug text-muted-foreground">
            The <span className="font-mono">loop</span> output carries one batch at a time. Once the
            rows run out, everything the body sent back leaves by{" "}
            <span className="font-mono">done</span>.
          </p>
        </div>
      );

    case "merge":
      return (
        <div className="flex flex-col gap-2.5">
          <InputOrder node={node} parents={parents} />
          <Field label="Mode">
            <NativeSelect
              className="w-full"
              value={node.mode}
              onChange={(e) => onChange({ mode: e.target.value as typeof node.mode })}
            >
              <option value="append">Append — all rows, one input after another</option>
              <option value="position">Combine by position — row n with row n</option>
              <option value="field">Combine by field — join on a matching value</option>
              <option value="branch">Wait for both — then pass input 1 on</option>
            </NativeSelect>
          </Field>
          {node.mode === "field" && (
            <Field
              label="Field to match on"
              hint="A column name present in both inputs. Comma-separate for a compound key. Rows without a match on the other side are dropped."
            >
              <Input
                value={node.field}
                onChange={(e) => onChange({ field: e.target.value })}
                placeholder="id"
                className="h-7 text-xs"
              />
            </Field>
          )}
        </div>
      );

    case "compare":
      return (
        <div className="flex flex-col gap-2.5">
          <InputOrder node={node} parents={parents} />
          <Field
            label="Key field in A"
            hint="How a row in one input is matched to a row in the other. Comma-separate for a compound key; leave empty to compare whole rows."
          >
            <Input
              value={node.keyA}
              onChange={(e) => onChange({ keyA: e.target.value })}
              placeholder="id"
              className="h-7 text-xs"
            />
          </Field>
          <Field label="Key field in B" hint="Leave empty when both inputs use the same names.">
            <Input
              value={node.keyB}
              onChange={(e) => onChange({ keyB: e.target.value })}
              placeholder="same as A"
              className="h-7 text-xs"
            />
          </Field>
          <Field
            label="Rows that differ"
            hint="Which side's version leaves by the “different” output."
          >
            <NativeSelect
              className="w-full"
              value={node.resolve}
              onChange={(e) => onChange({ resolve: e.target.value as "a" | "b" })}
            >
              <option value="b">Prefer input B</option>
              <option value="a">Prefer input A</option>
            </NativeSelect>
          </Field>
        </div>
      );

    case "subflow":
      return <SubflowPicker node={node} onChange={onChange} />;

    case "stop":
      return (
        <div className="flex flex-col gap-2.5">
          <ExpressionField
            param={STOP_PARAM}
            value={node.message ?? ""}
            ctx={ctx}
            runError={state?.status === "error" ? state.error : undefined}
            onChange={(message) => onChange({ message })}
          />
          <p className="text-[10px] leading-snug text-muted-foreground">
            Reaching this node fails the run outright — nothing after it executes, in this flow or
            in whatever called it.
          </p>
        </div>
      );

    case "wait":
      return (
        <div className="flex flex-col gap-2.5">
          <Field label="Wait for">
            <NativeSelect
              className="w-full"
              value={node.mode}
              onChange={(e) => onChange({ mode: e.target.value as "interval" | "until" })}
            >
              <option value="interval">A fixed pause</option>
              <option value="until">A moment in time</option>
            </NativeSelect>
          </Field>
          {node.mode === "interval" ? (
            <Field label="Pause" hint="Milliseconds. Two minutes is the most one node may hold a run.">
              <Input
                type="number"
                min={0}
                step={100}
                value={node.waitMs}
                onChange={(e) => onChange({ waitMs: Math.max(0, Number(e.target.value) || 0) })}
                className="h-7 w-32 text-xs"
              />
            </Field>
          ) : (
            <ExpressionField
              param={UNTIL_PARAM}
              value={node.until ?? ""}
              ctx={ctx}
              runError={state?.status === "error" ? state.error : undefined}
              onChange={(until) => onChange({ until })}
            />
          )}
        </div>
      );

    default:
      return null;
  }
}
