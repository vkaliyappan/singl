"use client"

import { useEffect, useMemo, useState, type FormEvent } from "react"
import Link from "next/link"
import { IconExternalLink, IconSearch } from "@tabler/icons-react"
import { PageHeader } from "@/components/page-header"
import { MermaidBlock } from "@/components/assistant/rich/mermaid-block"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  DEP_KINDS,
  MAX_GRAPH_NODES,
  depsCallers,
  depsGraph,
  depsSearch,
  depsSummary,
  depsUnused,
  entitiesHref,
  mermaidSource,
  type DepCallers,
  type DepDirection,
  type DepGraph,
  type DepKind,
  type DepNode,
  type DepSummary,
  type DepUnused,
} from "@/lib/deps"
import { errorMessage } from "@/lib/settings"
import { useAssistantAction, useAssistantContext } from "@/lib/assistant/context"
import { usePinnables } from "@/lib/assistant/pins"
import { DataGrid, type GridColumn } from "@/components/data-grid"

type Center = { name: string; type?: string }
/** A result tagged with the request that produced it; stale until it matches the current key. */
type Keyed<T> = { key: string; value?: T; error?: string }

function EntityLink({ node }: { node: DepNode }) {
  if (!node.file) return null
  return (
    <Link
      href={entitiesHref(node.file)}
      title="Open in Entities"
      aria-label={`Open ${node.name} in Entities`}
      className="text-muted-foreground hover:text-foreground"
    >
      <IconExternalLink className="size-3.5" />
    </Link>
  )
}

type NodeEntry = { key: string; node: DepNode; detail: string; extra?: React.ReactNode }

/** Sortable, filterable list of entities; the name re-centres the graph. */
function NodeTable({
  id,
  rows,
  onPick,
  detailLabel = "Used as",
}: {
  id: string
  rows: NodeEntry[]
  onPick: (n: DepNode) => void
  detailLabel?: string
}) {
  const columns = useMemo<GridColumn<NodeEntry>[]>(
    () => [
      {
        key: "name",
        label: "Entity",
        kind: "text",
        width: 260,
        value: (r) => r.node.name,
        render: (r) => (
          <button
            type="button"
            className="max-w-full truncate text-left font-medium hover:underline"
            title="Centre the graph on this entity"
            onClick={() => onPick(r.node)}
          >
            {r.node.name}
          </button>
        ),
      },
      {
        key: "type",
        label: "Type",
        kind: "text",
        width: 130,
        value: (r) => r.node.type,
        render: (r) => <Badge variant="outline">{r.node.type}</Badge>,
      },
      {
        key: "detail",
        label: detailLabel,
        kind: "text",
        width: 320,
        truncate: false,
        render: (r) => r.extra ?? <span className="break-words text-muted-foreground">{r.detail}</span>,
      },
      {
        key: "external",
        label: "Exported",
        kind: "boolean",
        width: 90,
        hidden: true,
        value: (r) => !r.node.external,
      },
      {
        key: "open",
        label: "Open",
        kind: "none",
        width: 56,
        render: (r) => <EntityLink node={r.node} />,
      },
    ],
    [onPick, detailLabel]
  )
  return (
    <DataGrid
      id={id}
      columns={columns}
      rows={rows}
      rowKey={(r) => r.key}
      searchable={rows.length > 8}
      pageSize={50}
      csvName={id}
      emptyText="None"
    />
  )
}

type Group = { node: DepNode; kinds: Map<DepKind, Set<string>> }

/** The centre's direct edges on one side, grouped by the entity on the other. */
function groupEdges(graph: DepGraph, side: "in" | "out"): Group[] {
  const byKey = new Map(graph.nodes.map((n) => [n.key, n]))
  const groups = new Map<string, Group>()
  for (const e of graph.edges) {
    const mine = side === "out" ? e.from : e.to
    if (mine !== graph.center) continue
    const node = byKey.get(side === "out" ? e.to : e.from)
    if (!node) continue
    const g = groups.get(node.key) ?? { node, kinds: new Map() }
    const items = g.kinds.get(e.kind) ?? new Set<string>()
    // Outgoing: the member of the target used. Incoming: what the other side
    // used of the centre, and the service it did so from.
    const label = side === "out" ? e.member : [e.member, e.fromMember && `from ${e.fromMember}`].filter(Boolean).join(" ")
    if (label) items.add(label)
    g.kinds.set(e.kind, items)
    groups.set(node.key, g)
  }
  return [...groups.values()]
}

function KindList({ kinds }: { kinds: Map<DepKind, Set<string>> }) {
  return (
    <div className="flex flex-col text-muted-foreground">
      {[...kinds].map(([kind, items]) => {
        const list = [...items]
        const shown = list.slice(0, 8).join(", ")
        return (
          <span key={kind} className="break-words">
            <span className="text-foreground/80">{kind}</span>
            {list.length > 0 && `: ${shown}${list.length > 8 ? ` +${list.length - 8} more` : ""}`}
          </span>
        )
      })}
    </div>
  )
}

function kindsText(kinds: Map<DepKind, Set<string>>): string {
  return [...kinds]
    .map(([kind, items]) => {
      const list = [...items]
      return list.length ? `${kind}: ${list.slice(0, 8).join(", ")}${list.length > 8 ? ` +${list.length - 8} more` : ""}` : kind
    })
    .join("; ")
}

function EdgeList({ id, title, groups, onPick }: { id: string; title: string; groups: Group[]; onPick: (n: DepNode) => void }) {
  const rows = useMemo<NodeEntry[]>(
    () =>
      groups.map((g) => ({
        key: g.node.key,
        node: g.node,
        detail: kindsText(g.kinds),
        extra: <KindList kinds={g.kinds} />,
      })),
    [groups]
  )
  return (
    <section className="flex min-w-0 flex-col gap-1.5">
      <h3 className="text-xs font-medium">
        {title} <span className="text-muted-foreground">({groups.length})</span>
      </h3>
      <NodeTable id={id} rows={rows} onPick={onPick} />
    </section>
  )
}

export function DepsExplorer({ envs }: { envs: string[] }) {
  const [env, setEnv] = useState(envs[0])
  const [tab, setTab] = useState("graph")
  const [summary, setSummary] = useState<Keyed<DepSummary> | null>(null)

  const [query, setQuery] = useState("")
  const [hits, setHits] = useState<DepNode[]>([])
  const [center, setCenter] = useState<Center | null>(null)
  const [direction, setDirection] = useState<DepDirection>("both")
  const [depth, setDepth] = useState(1)
  const [kinds, setKinds] = useState<DepKind[]>([])
  const [graph, setGraph] = useState<Keyed<DepGraph> | null>(null)

  const [service, setService] = useState("")
  const [callers, setCallers] = useState<Keyed<DepCallers> | null>(null)

  const [unusedType, setUnusedType] = useState("Thing")
  const [unused, setUnused] = useState<Keyed<DepUnused> | null>(null)

  const changeEnv = (next: string) => {
    setEnv(next)
    setCenter(null)
    setQuery("")
    setHits([])
    setGraph(null)
    setCallers(null)
  }

  const pick = (node: DepNode) => {
    setCenter({ name: node.name, type: node.type })
    setQuery("")
    setHits([])
    setCallers(null)
    setTab("graph")
  }

  useEffect(() => {
    let live = true
    depsSummary(env)
      .then((value) => live && setSummary({ key: env, value }))
      .catch((e) => live && setSummary({ key: env, error: errorMessage(e) }))
    return () => {
      live = false
    }
  }, [env])

  useEffect(() => {
    let live = true
    const timer = setTimeout(() => {
      if (!query.trim()) return setHits([])
      depsSearch(env, query, 12)
        .then((rows) => live && setHits(rows))
        .catch(() => live && setHits([]))
    }, 200)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [env, query])

  const graphKey = center ? JSON.stringify([env, center, direction, depth, kinds]) : ""
  useEffect(() => {
    if (!center) return
    let live = true
    depsGraph({ env, entity: center.name, entityType: center.type, direction, depth, kinds, limit: 500 })
      .then((value) => live && setGraph({ key: graphKey, value }))
      .catch((e) => live && setGraph({ key: graphKey, error: errorMessage(e) }))
    return () => {
      live = false
    }
  }, [env, center, direction, depth, kinds, graphKey])

  const unusedKey = `${env}|${unusedType}`
  useEffect(() => {
    if (tab !== "unused") return
    let live = true
    depsUnused(env, unusedType === "All" ? "" : unusedType, 500)
      .then((value) => live && setUnused({ key: unusedKey, value }))
      .catch((e) => live && setUnused({ key: unusedKey, error: errorMessage(e) }))
    return () => {
      live = false
    }
  }, [env, tab, unusedType, unusedKey])

  const current = graph?.key === graphKey ? graph : null
  const diagram = useMemo(() => (current?.value ? mermaidSource(current.value) : null), [current])
  const centerNode = current?.value?.nodes[0]
  const types = summary?.key === env ? summary.value?.types : undefined

  const toggleKind = (kind: DepKind) =>
    setKinds((all) => (all.includes(kind) ? all.filter((k) => k !== kind) : [...all, kind]))

  const findCallers = (e: FormEvent) => {
    e.preventDefault()
    if (!center || !service.trim()) return
    const key = JSON.stringify([env, center, service])
    setCallers(null)
    depsCallers({ env, entity: center.name, entityType: center.type, service })
      .then((value) => setCallers({ key, value }))
      .catch((err) => setCallers({ key, error: errorMessage(err) }))
  }

  const gv = current?.value
  useAssistantContext({
    screen: "twx-deps",
    title: "Dependencies",
    summary: center ? `${center.type ?? ""}${center.type ? ":" : ""}${center.name} (${direction}, depth ${depth}) on ${env}` : `Dependencies on ${env}`,
    data: {
      env,
      tab,
      indexed: summary?.key === env ? { entities: summary.value?.entities, edges: summary.value?.edges } : null,
      center,
      direction,
      depth,
      kinds,
      graph: gv && {
        nodes: gv.nodes.length,
        edges: gv.edges.length,
        truncated: gv.truncated,
        nodeList: gv.nodes.slice(0, 20).map((n) => `${n.type}:${n.name}${n.external ? " (external)" : ""}`),
        edgeList: gv.edges.slice(0, 20).map((e) => `${e.from} -${e.kind}${e.member ? `(${e.member})` : ""}-> ${e.to}`),
      },
      graphError: current?.error,
      callers: callers?.value && {
        service: callers.value.service,
        count: callers.value.callers.length,
        list: callers.value.callers.slice(0, 15).map((c) => `${c.caller.type}:${c.caller.name}`),
      },
      unused: tab === "unused" && unused?.value ? { type: unusedType, total: unused.value.total, list: unused.value.nodes.slice(0, 20).map((n) => `${n.type}:${n.name}`) } : undefined,
    },
    selection: center ? { entity: [`${center.type ?? "Entity"}:${center.name}`] } : {},
  })
  usePinnables(
    gv && center
      ? [
          {
            kind: "dependencies",
            label: `Dependencies · ${center.name}`,
            detail: `${gv.nodes.length} entities, ${gv.edges.length} references`,
            content: () =>
              JSON.stringify({
                center,
                direction,
                depth,
                nodes: gv.nodes.slice(0, 60).map((n) => `${n.type}:${n.name}`),
                edges: gv.edges.slice(0, 100).map((e) => ({ from: e.from, to: e.to, kind: e.kind, member: e.member })),
              }).slice(0, 8000),
          },
        ]
      : [],
  )
  useAssistantAction(
    "show_dependencies",
    {
      description:
        "Centre the dependency graph on an entity (name, or Type:Name) and show it. direction: in (what uses it), out (what it uses) or both; depth 1-4; kinds optionally limits to " +
        DEP_KINDS.join("|") +
        ". Reads the local XML export only.",
      inputSchema: {
        type: "object",
        properties: {
          entity: { type: "string" },
          direction: { type: "string", enum: ["in", "out", "both"] },
          depth: { type: "number" },
          kinds: { type: "array", items: { type: "string", enum: [...DEP_KINDS] } },
        },
        required: ["entity"],
      },
    },
    async (args) => {
      const a = args as { entity?: string; direction?: string; depth?: number; kinds?: string[] }
      const raw = String(a.entity ?? "").trim()
      if (!raw) throw new Error("entity is required")
      const colon = raw.indexOf(":")
      const wantType = colon > 0 ? raw.slice(0, colon) : undefined
      const wantName = colon > 0 ? raw.slice(colon + 1) : raw
      const found = await depsSearch(env, wantName, 20)
      const hit =
        found.find((n) => n.name.toLowerCase() === wantName.toLowerCase() && (!wantType || n.type.toLowerCase() === wantType.toLowerCase())) ??
        (wantType ? undefined : found[0])
      if (!hit) throw new Error(`No exported entity matches "${raw}" in ${env}.`)
      const dir = a.direction === "in" || a.direction === "out" || a.direction === "both" ? a.direction : "both"
      const d = Math.min(4, Math.max(1, Math.round(a.depth ?? 1)))
      const ks = (a.kinds ?? []).filter((k): k is DepKind => (DEP_KINDS as readonly string[]).includes(k))
      setCenter({ name: hit.name, type: hit.type })
      setDirection(dir)
      setDepth(d)
      setKinds(ks)
      setQuery("")
      setHits([])
      setCallers(null)
      setTab("graph")
      const g = await depsGraph({ env, entity: hit.name, entityType: hit.type, direction: dir, depth: d, kinds: ks, limit: 500 })
      return {
        center: `${hit.type}:${hit.name}`,
        nodes: g.nodes.length,
        edges: g.edges.length,
        truncated: g.truncated,
        entities: g.nodes.slice(1, 25).map((n) => `${n.type}:${n.name}`),
      }
    },
  )

  return (
    <div className="flex flex-col gap-5 p-8">
      <PageHeader
        title="Dependencies"
        description="What each exported entity uses and what uses it, read from the local XML. Dynamic lookups are not seen."
        actions={
          <NativeSelect value={env} onChange={(e) => changeEnv(e.target.value)} aria-label="Environment">
            {envs.map((e) => (
              <NativeSelectOption key={e} value={e}>
                {e}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        }
      />
      {summary?.key === env && summary.error && (
        <p className="rounded-xl border bg-card px-4 py-3.5 text-xs text-muted-foreground">{summary.error}</p>
      )}
      {summary?.key === env && summary.value && (
        <p className="text-xs text-muted-foreground">
          {summary.value.entities} entities and {summary.value.edges} references indexed.
        </p>
      )}

      <Tabs value={tab} onValueChange={(v) => setTab(String(v))}>
        <TabsList>
          <TabsTrigger value="graph">Graph</TabsTrigger>
          <TabsTrigger value="unused">Unused entities</TabsTrigger>
        </TabsList>

        <TabsContent value="graph" className="flex flex-col gap-4 pt-3">
          <div className="flex flex-wrap items-start gap-3">
            <div className="relative w-80">
              <IconSearch className="pointer-events-none absolute top-1.5 left-2 size-3.5 text-muted-foreground" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search entities by name"
                aria-label="Search entities"
                className="pl-7"
              />
              {hits.length > 0 && (
                <ul className="absolute z-20 mt-1 max-h-72 w-full overflow-y-auto rounded-md border bg-popover shadow-md">
                  {hits.map((n) => (
                    <li key={n.key}>
                      <button
                        type="button"
                        className="flex w-full items-center justify-between gap-2 px-2.5 py-1.5 text-left text-xs hover:bg-muted"
                        onClick={() => pick(n)}
                      >
                        <span className="truncate">{n.name}</span>
                        <span className="shrink-0 text-muted-foreground">{n.type}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <NativeSelect
              value={direction}
              onChange={(e) => setDirection(e.target.value as DepDirection)}
              aria-label="Direction"
            >
              <NativeSelectOption value="both">Uses and used by</NativeSelectOption>
              <NativeSelectOption value="out">Uses (outgoing)</NativeSelectOption>
              <NativeSelectOption value="in">Used by (incoming)</NativeSelectOption>
            </NativeSelect>
            <NativeSelect value={depth} onChange={(e) => setDepth(Number(e.target.value))} aria-label="Depth">
              {[1, 2, 3, 4, 5].map((d) => (
                <NativeSelectOption key={d} value={d}>
                  Depth {d}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-xs text-muted-foreground">Kinds</span>
            {DEP_KINDS.map((k) => (
              <Button
                key={k}
                size="xs"
                variant={kinds.includes(k) ? "default" : "outline"}
                aria-pressed={kinds.includes(k)}
                onClick={() => toggleKind(k)}
              >
                {k}
              </Button>
            ))}
            {kinds.length > 0 && (
              <Button size="xs" variant="ghost" onClick={() => setKinds([])}>
                All kinds
              </Button>
            )}
          </div>

          {!center && (
            <p className="text-xs text-muted-foreground">Search for an entity to see what it uses and what uses it.</p>
          )}
          {center && !current && <p className="text-xs text-muted-foreground">Reading…</p>}
          {current?.error && (
            <p className="rounded-xl border bg-card px-4 py-3.5 text-xs text-muted-foreground">{current.error}</p>
          )}
          {current?.value && centerNode && diagram && (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-sm font-medium">{centerNode.name}</h2>
                <Badge variant="outline">{centerNode.type}</Badge>
                <EntityLink node={centerNode} />
              </div>
              {(current.value.truncated || diagram.total > MAX_GRAPH_NODES) && (
                <p className="text-xs text-muted-foreground">
                  Showing the nearest {diagram.shown} of {current.value.truncated ? "more than " : ""}
                  {diagram.total} entities. Lower the depth or pick kinds to narrow it.
                </p>
              )}
              {current.value.edges.length === 0 ? (
                <p className="text-xs text-muted-foreground">Nothing found for these filters.</p>
              ) : (
                <MermaidBlock source={diagram.source} />
              )}
              <div className="grid gap-4 lg:grid-cols-2">
                <EdgeList id="deps-uses" title="Uses" groups={groupEdges(current.value, "out")} onPick={pick} />
                <EdgeList id="deps-used-by" title="Used by" groups={groupEdges(current.value, "in")} onPick={pick} />
              </div>
              {current.value.nodes.length > 1 && (
                <details className="text-xs">
                  <summary className="cursor-pointer text-muted-foreground">
                    All {current.value.nodes.length} entities in this graph
                  </summary>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {current.value.nodes.map((n) => (
                      <Button key={n.key} size="xs" variant="outline" onClick={() => pick(n)}>
                        {n.name}
                      </Button>
                    ))}
                  </div>
                </details>
              )}
            </>
          )}

          <section className="flex flex-col gap-2 rounded-xl border bg-card p-3.5">
            <h3 className="text-xs font-medium">Who calls this service?</h3>
            {!center ? (
              <p className="text-xs text-muted-foreground">Pick an entity first.</p>
            ) : (
              <form className="flex flex-wrap items-center gap-2" onSubmit={findCallers}>
                <span className="text-xs text-muted-foreground">{center.name} .</span>
                <Input
                  value={service}
                  onChange={(e) => setService(e.target.value)}
                  placeholder="Service name"
                  aria-label="Service name"
                  className="w-56"
                />
                <Button type="submit" size="sm" disabled={!service.trim()}>
                  Find callers
                </Button>
              </form>
            )}
            {callers?.error && <p className="text-xs text-destructive">{callers.error}</p>}
            {callers?.value && (
              callers.value.callers.length === 0 ? (
                <p className="rounded-md border px-3 py-2 text-xs text-muted-foreground">
                  No script or mashup calls {callers.value.service} on {callers.value.entity.name}.
                </p>
              ) : (
                <NodeTable
                  id="deps-callers"
                  detailLabel="How"
                  onPick={pick}
                  rows={callers.value.callers.map((c, i) => ({
                    key: `${c.caller.key}${c.fromMember}${i}`,
                    node: c.caller,
                    detail: `${c.kind}${c.fromMember ? ` from ${c.fromMember}` : ""}${c.via ? ` (through ${c.via})` : ""}`,
                  }))}
                />
              )
            )}
          </section>
        </TabsContent>

        <TabsContent value="unused" className="flex flex-col gap-3 pt-3">
          <div className="flex flex-wrap items-center gap-2">
            <NativeSelect value={unusedType} onChange={(e) => setUnusedType(e.target.value)} aria-label="Entity type">
              <NativeSelectOption value="All">All types</NativeSelectOption>
              {(types ?? []).map((t) => (
                <NativeSelectOption key={t.type} value={t.type}>
                  {t.type} ({t.count})
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </div>
          <p className="text-xs text-muted-foreground">
            A guide, not proof: entities used by dynamic lookups, REST calls, schedulers or as entry points (mashups,
            services called from outside) are listed too.
          </p>
          {unused?.key !== unusedKey && <p className="text-xs text-muted-foreground">Reading…</p>}
          {unused?.key === unusedKey && unused.error && (
            <p className="rounded-xl border bg-card px-4 py-3.5 text-xs text-muted-foreground">{unused.error}</p>
          )}
          {unused?.key === unusedKey && unused.value && (
            <>
              <p className="text-xs text-muted-foreground">
                {unused.value.total} entities nothing references
                {unused.value.nodes.length < unused.value.total && `; showing the first ${unused.value.nodes.length}`}.
              </p>
              <NodeTable
                id="deps-unused"
                detailLabel="Note"
                onPick={pick}
                rows={unused.value.nodes.map((n) => ({ key: n.key, node: n, detail: n.external ? "not exported" : "" }))}
              />
            </>
          )}
        </TabsContent>
      </Tabs>
    </div>
  )
}
