import { parseGraph } from "@/lib/twx-flow/graph";

export type FlowRow = {
  id: string;
  name: string;
  environment: string;
  folderId: string | null;
  graph: string;
  createdAt: Date | null;
  updatedAt: Date | null;
};

export type FolderRow = {
  id: string;
  name: string;
  parentId: string | null;
  createdAt: Date | null;
  updatedAt: Date | null;
};

export type EnvRow = {
  environment: string;
  twxBaseUrl?: string | null;
};

/** A folder plus everything hanging off it, ready to render. */
export type FolderNode = {
  id: string;
  name: string;
  parentId: string | null;
  children: FolderNode[];
  flows: FlowRow[];
  /** Flows in this folder *and* every folder below it. */
  totalFlows: number;
};

/** Sentinel id for the synthetic root row in the sidebar. */
export const ROOT_ID = "__root__";

const byName = (a: { name: string }, b: { name: string }) =>
  a.name.localeCompare(b.name);

/**
 * Turns the flat adjacency list into a tree. Folders whose parent no longer
 * exists are lifted to the root so nothing becomes unreachable.
 */
export function buildFolderTree(
  folders: FolderRow[],
  flows: FlowRow[]
): { roots: FolderNode[]; rootFlows: FlowRow[]; byId: Map<string, FolderNode> } {
  const byId = new Map<string, FolderNode>();
  for (const f of folders) {
    byId.set(f.id, {
      id: f.id,
      name: f.name,
      parentId: f.parentId,
      children: [],
      flows: [],
      totalFlows: 0,
    });
  }

  const roots: FolderNode[] = [];
  for (const node of byId.values()) {
    const parent = node.parentId ? byId.get(node.parentId) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }

  const rootFlows: FlowRow[] = [];
  for (const flow of flows) {
    const node = flow.folderId ? byId.get(flow.folderId) : undefined;
    if (node) node.flows.push(flow);
    else rootFlows.push(flow);
  }

  const tally = (node: FolderNode): number => {
    node.children.sort(byName);
    node.flows.sort(byName);
    node.totalFlows =
      node.flows.length + node.children.reduce((sum, c) => sum + tally(c), 0);
    return node.totalFlows;
  };
  roots.sort(byName);
  rootFlows.sort(byName);
  for (const node of roots) tally(node);

  return { roots, rootFlows, byId };
}

/** Breadcrumb segments from the root down to `folderId`. */
export function folderPath(
  byId: Map<string, FolderNode>,
  folderId: string | null
): FolderNode[] {
  const out: FolderNode[] = [];
  let current = folderId ? byId.get(folderId) : undefined;
  while (current) {
    out.unshift(current);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return out;
}

/** Every folder id at or below `folderId`, including itself. */
export function subtreeIds(node: FolderNode): string[] {
  const out = [node.id];
  for (const child of node.children) out.push(...subtreeIds(child));
  return out;
}

/** Flat "Parent / Child / Grandchild" labels, for move-to pickers. */
export function flattenFolders(
  roots: FolderNode[],
  prefix = ""
): { id: string; label: string; depth: number }[] {
  const out: { id: string; label: string; depth: number }[] = [];
  for (const node of roots) {
    const label = prefix ? `${prefix} / ${node.name}` : node.name;
    out.push({ id: node.id, label, depth: prefix.split("/").length - (prefix ? 0 : 1) });
    out.push(...flattenFolders(node.children, label));
  }
  return out;
}

export function formatRelativeTime(date: Date | null): string {
  if (!date) return "Never";
  const diffSec = Math.floor((Date.now() - new Date(date).getTime()) / 1000);
  if (diffSec < 60) return "Just now";
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
  if (diffSec < 604800) return `${Math.floor(diffSec / 86400)}d ago`;
  return new Date(date).toLocaleDateString();
}

/** Graph stats without re-parsing the JSON at every render site. */
export function graphStats(graph: string) {
  const parsed = parseGraph(graph);
  return { nodes: parsed.nodes, edges: parsed.edges };
}
