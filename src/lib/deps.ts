import { invoke } from "@tauri-apps/api/core"

// Typed wrappers over src-tauri/src/commands/deps.rs: the entity dependency
// graph built from the exported entity XML, no server calls. `env` is the
// environment name from Settings. Errors reject with `{ code, message }`; read
// them with errorMessage from @/lib/settings.

export const DEP_KINDS = [
  "template",
  "shape",
  "datashape",
  "calls",
  "mashup",
  "project",
  "valueStream",
  "persistenceProvider",
] as const
export type DepKind = (typeof DEP_KINDS)[number]
export type DepDirection = "in" | "out" | "both"

export type DepNode = {
  /** `Type:lowercase name`. */
  key: string
  type: string
  name: string
  /** The XML file relative to the entities folder; null when not exported. */
  file: string | null
  /** Referenced but not exported (a PTC template, a Resource...). */
  external: boolean
}

export type DepEdge = {
  from: string
  to: string
  kind: DepKind
  /** The member of `to` used: the service called, the property bound... */
  member: string | null
  /** The service or subscription of `from` the reference sits in. */
  fromMember: string | null
}

export type DepGraph = {
  center: string
  /** Centre first, then nearest first. */
  nodes: DepNode[]
  edges: DepEdge[]
  truncated: boolean
}

export type DepCaller = { caller: DepNode; fromMember: string | null; kind: DepKind; via: string | null }
export type DepCallers = { entity: DepNode; service: string; callers: DepCaller[] }
export type DepUnused = { nodes: DepNode[]; total: number }
export type DepSummary = { entities: number; edges: number; types: { type: string; count: number }[] }

export const depsSummary = (env: string) => invoke<DepSummary>("deps_summary", { env })
export const depsSearch = (env: string, query: string, limit?: number) =>
  invoke<DepNode[]>("deps_search", { env, query, limit })
/** `kinds` empty means every kind. */
export const depsGraph = (q: {
  env: string
  entity: string
  entityType?: string
  direction: DepDirection
  depth: number
  kinds: DepKind[]
  limit?: number
}) => invoke<DepGraph>("deps_graph", q)
export const depsCallers = (q: { env: string; entity: string; entityType?: string; service: string }) =>
  invoke<DepCallers>("deps_callers", q)
/** Entities nothing references; a heuristic. `entityType` empty means every type. */
export const depsUnused = (env: string, entityType?: string, limit?: number) =>
  invoke<DepUnused>("deps_unused", { env, entityType, limit })

/** Deep link to an exported file on the TWX Entities page. */
export const entitiesHref = (file: string) => `/twx-entities?file=${encodeURIComponent(file)}`

/** Most nodes the Mermaid graph draws. */
export const MAX_GRAPH_NODES = 60

const esc = (s: string) => s.replace(/"/g, "#quot;")

/**
 * Mermaid flowchart of the nearest `max` nodes of `graph` and the edges among
 * them. Parallel edges share one arrow whose label lists the kinds.
 */
export function mermaidSource(graph: DepGraph, max = MAX_GRAPH_NODES) {
  const nodes = graph.nodes.slice(0, max)
  const ids = new Map(nodes.map((n, i) => [n.key, `n${i}`]))
  const labels = new Map<string, string[]>()
  for (const e of graph.edges) {
    const from = ids.get(e.from)
    const to = ids.get(e.to)
    if (!from || !to) continue
    const text = e.member ? `${e.kind} ${e.member}` : e.kind
    const list = labels.get(`${from}>${to}`) ?? []
    if (!list.includes(text)) list.push(text)
    labels.set(`${from}>${to}`, list)
  }
  const lines = ["flowchart LR"]
  for (const n of nodes) {
    lines.push(`  ${ids.get(n.key)}["${esc(n.type)}<br/>${esc(n.name)}"]`)
  }
  for (const [pair, list] of labels) {
    const [from, to] = pair.split(">")
    const shown = list.length > 3 ? [...list.slice(0, 3), `+${list.length - 3}`] : list
    lines.push(`  ${from} -->|"${esc(shown.join(", "))}"| ${to}`)
  }
  const centre = ids.get(graph.center)
  if (centre) lines.push(`  style ${centre} stroke-width:3px`)
  for (const n of nodes) if (n.external) lines.push(`  style ${ids.get(n.key)} stroke-dasharray:4 3`)
  return { source: lines.join("\n"), shown: nodes.length, total: graph.nodes.length }
}
