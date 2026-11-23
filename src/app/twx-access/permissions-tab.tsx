"use client"

import { useState } from "react"
import { IconCheck, IconSearch, IconShieldCheck, IconX } from "@tabler/icons-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { NativeSelect } from "@/components/ui/native-select"
import { Spinner } from "@/components/ui/spinner"
import { errorMessage } from "@/lib/settings"
import { useAssistantAction, useAssistantContext } from "@/lib/assistant/context"
import { usePinnables } from "@/lib/assistant/pins"
import {
  RUNTIME_ACTIONS,
  checkPermission,
  getEntityPermissions,
  type EntityPermissions,
  type PermissionDecision,
  type PermissionRule,
} from "@/lib/twx-access"
import { cn } from "@/lib/utils"
import { DataGrid, type GridColumn } from "@/components/data-grid"
import { useEntityNames } from "./shared"

const TYPES = ["Thing", "ThingTemplate", "ThingShape", "Mashup", "DataShape", "Group", "Organization", "Project", "Resource"]

function Access({ permitted }: { permitted: boolean }) {
  return (
    <Badge
      variant="outline"
      className={cn(
        permitted
          ? "border-success/30 bg-success/10 text-success"
          : "border-destructive/30 bg-destructive/10 text-destructive",
      )}
    >
      {permitted ? <IconCheck /> : <IconX />}
      {permitted ? "Allow" : "Deny"}
    </Badge>
  )
}

const ACTION_COL: GridColumn<PermissionRule> = { key: "action", label: "Action", kind: "text", width: 160 }
const PRINCIPAL_COL: GridColumn<PermissionRule> = {
  key: "principal",
  label: "Principal",
  kind: "text",
  width: 280,
  render: (r) => (
    <span>
      <span className="font-mono">{r.principal}</span> <span className="text-muted-foreground">{r.kind}</span>
    </span>
  ),
}
const ACCESS_COL: GridColumn<PermissionRule> = {
  key: "access",
  label: "Access",
  kind: "text",
  width: 110,
  value: (r) => (r.permitted ? "Allow" : "Deny"),
  render: (r) => <Access permitted={r.permitted} />,
}
const APPLIES_COL: GridColumn<PermissionRule> = {
  key: "resource",
  label: "Applies to",
  kind: "text",
  width: 240,
  value: (r) => (r.resource === "*" ? "Inherited" : r.resource),
  render: (r) =>
    r.resource === "*" ? (
      <Badge
        variant="secondary"
        title="Entity-wide rule, inherited by every service, property and event without its own override"
      >
        Inherited
      </Badge>
    ) : (
      <span className="font-mono">{r.resource}</span>
    ),
}
const RUNTIME_COLS = [APPLIES_COL, ACTION_COL, PRINCIPAL_COL, ACCESS_COL]
const DESIGN_COLS = [ACTION_COL, PRINCIPAL_COL, ACCESS_COL]

function RuleTable({ id, title, rules, runtime }: { id: string; title: string; rules: PermissionRule[]; runtime?: boolean }) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-sm font-medium">
        {title} <span className="text-muted-foreground">({rules.length})</span>
      </h2>
      {rules.length === 0 ? (
        <p className="text-xs text-muted-foreground">No rules.</p>
      ) : (
        <DataGrid
          id={id}
          columns={runtime ? RUNTIME_COLS : DESIGN_COLS}
          rows={rules}
          searchPlaceholder="Filter by user, group or member"
          csvName={id}
          searchable={rules.length > 5}
          pageSize={50}
        />
      )}
    </section>
  )
}

function Verdict({ d }: { d: PermissionDecision }) {
  return (
    <div
      className={cn(
        "flex flex-col gap-2 rounded-xl border p-4",
        d.allowed ? "border-success/30 bg-success/10" : "border-destructive/30 bg-destructive/10",
      )}
    >
      <div
        className={cn(
          "flex items-center gap-2 text-base font-semibold",
          d.allowed ? "text-success" : "text-destructive",
        )}
      >
        {d.allowed ? <IconShieldCheck className="size-5" /> : <IconX className="size-5" />}
        {d.allowed ? "Allowed" : "Denied"}
      </div>
      <p className="text-sm">{d.explanation}</p>
      <p className="text-xs text-muted-foreground">
        Groups involved: {d.userGroups.length ? d.userGroups.join(", ") : "none of the groups named in the rules"}
      </p>
      {d.notes.map((n) => (
        <p key={n} className="text-xs text-muted-foreground">
          {n}
        </p>
      ))}
    </div>
  )
}

export function PermissionsTab({ env }: { env: string }) {
  const [type, setType] = useState("Thing")
  const [name, setName] = useState("")
  const [perms, setPerms] = useState<EntityPermissions | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")

  const [user, setUser] = useState("")
  const [action, setAction] = useState<string>(RUNTIME_ACTIONS[0])
  const [member, setMember] = useState("")
  const [checking, setChecking] = useState(false)
  const [decision, setDecision] = useState<PermissionDecision | null>(null)
  const [checkError, setCheckError] = useState("")

  const entityNames = useEntityNames(env, type, name)
  const userNames = useEntityNames(env, "User", user)

  async function load(over?: { type: string; name: string }) {
    const t = over?.type ?? type
    const n = (over?.name ?? name).trim()
    if (!n) return
    setLoading(true)
    setError("")
    setDecision(null)
    try {
      const got = await getEntityPermissions(env, t, n)
      setPerms(got)
      return got
    } catch (err) {
      setPerms(null)
      setError(errorMessage(err))
      throw err
    } finally {
      setLoading(false)
    }
  }

  async function check(over?: { entityType: string; entityName: string; user: string; action: string; member?: string }) {
    const o = over ?? (perms && user.trim() ? { entityType: type, entityName: perms.name, user: user.trim(), action, member: member.trim() || undefined } : null)
    if (!o) return
    setChecking(true)
    setCheckError("")
    try {
      const d = await checkPermission({ env, ...o })
      setDecision(d)
      return d
    } catch (err) {
      setDecision(null)
      setCheckError(errorMessage(err))
      throw err
    } finally {
      setChecking(false)
    }
  }

  useAssistantContext({
    screen: "twx-access",
    data: {
      permissions: {
        type,
        name,
        loaded: perms ? { entityType: perms.entityType, name: perms.name } : null,
        counts: perms && { runTime: perms.runTime.length, designTime: perms.designTime.length, visibility: perms.visibility.length },
        runTime: perms?.runTime.slice(0, 20),
        designTime: perms?.designTime.slice(0, 10),
        visibility: perms?.visibility.slice(0, 10),
        check: { user, action, member },
        verdict: decision && {
          allowed: decision.allowed,
          user: decision.user,
          action: decision.action,
          member: decision.member,
          level: decision.level,
          explanation: decision.explanation.slice(0, 300),
        },
        error: error || checkError,
      },
    },
    selection: perms ? { entity: [`${perms.entityType}:${perms.name}`] } : {},
  })
  usePinnables([
    ...(perms
      ? [
          {
            kind: "permissions",
            label: `Permissions · ${perms.entityType}:${perms.name}`,
            detail: `${perms.runTime.length} run-time rules`,
            content: () => JSON.stringify(perms).slice(0, 8000),
          },
        ]
      : []),
    ...(decision
      ? [
          {
            kind: "permission-verdict",
            label: `${decision.allowed ? "Allowed" : "Denied"} · ${decision.user} ${decision.action}`,
            detail: perms?.name,
            content: () => JSON.stringify({ entity: perms && `${perms.entityType}:${perms.name}`, ...decision }).slice(0, 4000),
          },
        ]
      : []),
  ])
  useAssistantAction(
    "load_permissions",
    {
      description: "On the Permissions tab, load an entity's run-time, design-time and visibility permissions and show them.",
      inputSchema: {
        type: "object",
        properties: { type: { type: "string", enum: TYPES }, name: { type: "string" } },
        required: ["type", "name"],
      },
    },
    async (args) => {
      const a = args as { type?: string; name?: string }
      if (!a.type || !a.name) throw new Error("type and name are required")
      setType(a.type)
      setName(a.name)
      const got = await load({ type: a.type, name: a.name })
      return got && { entity: `${got.entityType}:${got.name}`, runTime: got.runTime.length, designTime: got.designTime.length, visibility: got.visibility.length }
    },
  )
  useAssistantAction(
    "check_permission",
    {
      description:
        "Answer 'can this user do this?' for the entity loaded on the Permissions tab (load it first with load_permissions). action is e.g. ServiceExecute, PropertyRead; member optionally names a service/property/event. Read-only.",
      inputSchema: {
        type: "object",
        properties: { user: { type: "string" }, action: { type: "string" }, member: { type: "string" } },
        required: ["user", "action"],
      },
    },
    async (args) => {
      const a = args as { user?: string; action?: string; member?: string }
      if (!perms) throw new Error("Load an entity's permissions first (load_permissions).")
      if (!a.user || !a.action) throw new Error("user and action are required")
      setUser(a.user)
      setAction(a.action)
      setMember(a.member ?? "")
      const d = await check({ entityType: type, entityName: perms.name, user: a.user, action: a.action, member: a.member || undefined })
      return d && { allowed: d.allowed, level: d.level, explanation: d.explanation, userGroups: d.userGroups }
    },
  )

  return (
    <div className="flex flex-col gap-5 pt-2">
      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          void load().catch(() => {})
        }}
      >
        <NativeSelect
          value={type}
          onChange={(e) => {
            setType(e.target.value)
            setName("")
          }}
          aria-label="Entity type"
        >
          {TYPES.map((t) => (
            <option key={t}>{t}</option>
          ))}
        </NativeSelect>
        <Input
          className="w-72"
          list="access-entity-names"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Entity name"
          aria-label="Entity name"
        />
        <datalist id="access-entity-names">
          {entityNames.map((n) => (
            <option key={n} value={n} />
          ))}
        </datalist>
        <Button type="submit" disabled={loading || !name.trim()}>
          {loading ? <Spinner /> : <IconSearch />}
          Load permissions
        </Button>
      </form>

      {error && (
        <p className="rounded-xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-xs text-destructive">{error}</p>
      )}

      {perms && (
        <>
          <div className="flex flex-col gap-3 rounded-xl border bg-card p-4">
            <h2 className="text-sm font-medium">Can a user do this?</h2>
            <form
              className="flex flex-wrap items-center gap-2"
              onSubmit={(e) => {
                e.preventDefault()
                void check().catch(() => {})
              }}
            >
              <Input
                className="w-56"
                list="access-user-names"
                value={user}
                onChange={(e) => setUser(e.target.value)}
                placeholder="User name"
                aria-label="User"
              />
              <datalist id="access-user-names">
                {userNames.map((n) => (
                  <option key={n} value={n} />
                ))}
              </datalist>
              <NativeSelect value={action} onChange={(e) => setAction(e.target.value)} aria-label="Action">
                {RUNTIME_ACTIONS.map((a) => (
                  <option key={a}>{a}</option>
                ))}
              </NativeSelect>
              <Input
                className="w-64"
                value={member}
                onChange={(e) => setMember(e.target.value)}
                placeholder="Service / property / event (optional)"
                aria-label="Member"
              />
              <Button type="submit" disabled={checking || !user.trim()}>
                {checking && <Spinner />}
                Check
              </Button>
            </form>
            {checkError && <p className="text-xs text-destructive">{checkError}</p>}
            {decision && <Verdict d={decision} />}
          </div>

          <RuleTable id="access-runtime" title="Run-time permissions" rules={perms.runTime} runtime />
          <RuleTable id="access-design" title="Design-time permissions" rules={perms.designTime} />
          <RuleTable id="access-visibility" title="Visibility" rules={perms.visibility} />
        </>
      )}
    </div>
  )
}
