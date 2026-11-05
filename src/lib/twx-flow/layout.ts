import { effectiveEdges, portFraction } from "./graph";
import { outputPorts } from "./nodes";
import type { EdgePort, FlowGraph, FlowNode } from "./types";

/**
 * Node box geometry, in world units. Cards are a fixed size — parameters live
 * in the detail panel, not on the card — so the wire layer can compute port
 * positions without measuring the DOM.
 */
export const NODE_W = 208;
export const NODE_H = 76;
export const COLUMN_GAP = 96;
export const ROW_GAP = 40;

export type Point = { x: number; y: number };
export type Obstacle = { x: number; y: number; w: number; h: number };

/** Room one output port needs on the right edge before cards have to grow. */
const PORT_PITCH = 22;

/**
 * How tall a card is drawn. Fixed for most nodes; a Switch with several rules,
 * or a Compare with its four buckets, grows enough for its ports to be aimed at.
 */
export function nodeHeight(node: FlowNode): number {
  const ports = outputPorts(node).length;
  return Math.max(NODE_H, ports * PORT_PITCH + PORT_PITCH);
}

export const inputPortPoint = (node: FlowNode): Point => ({
  x: node.x,
  y: node.y + nodeHeight(node) / 2,
});

/**
 * Where a wire leaves a card. Branching nodes stack their ports down the right
 * edge, evenly spaced; every other node has one, in the middle.
 */
export const outputPortPoint = (node: FlowNode, port?: EdgePort): Point => {
  const ports = outputPorts(node);
  const index = port ? ports.findIndex((p) => p.id === port) : -1;
  return {
    x: node.x + NODE_W,
    y: node.y + nodeHeight(node) * portFraction(Math.max(index, 0), ports.length),
  };
};

/** Horizontal cubic bezier, the usual node-graph wire shape. */
export function wirePath(from: Point, to: Point): string {
  const dx = Math.max(48, Math.abs(to.x - from.x) * 0.55);
  return `M ${from.x} ${from.y} C ${from.x + dx} ${from.y}, ${to.x - dx} ${to.y}, ${to.x} ${to.y}`;
}

/* ---------------------------------------------------------------- routing -- */

const cubicAt = (p0: number, c1: number, c2: number, p3: number, t: number): number => {
  const u = 1 - t;
  return u * u * u * p0 + 3 * u * u * t * c1 + 3 * u * t * t * c2 + t * t * t * p3;
};

function sampleCubic(from: Point, c1: Point, c2: Point, to: Point, steps = 24): Point[] {
  const points: Point[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    points.push({
      x: cubicAt(from.x, c1.x, c2.x, to.x, t),
      y: cubicAt(from.y, c1.y, c2.y, to.y, t),
    });
  }
  return points;
}

const inside = (p: Point, o: Obstacle, pad: number) =>
  p.x > o.x - pad && p.x < o.x + o.w + pad && p.y > o.y - pad && p.y < o.y + o.h + pad;

const blockers = (points: Point[], obstacles: Obstacle[], pad: number) =>
  obstacles.filter((o) => points.some((p) => inside(p, o, pad)));

/** Clearance kept between a wire and any card it has to get past. */
const PAD = 14;
/** Extra room between the detour lane and the cards it clears. */
const GAP = 26;

const round = (n: number) => Math.round(n * 10) / 10;

/**
 * Straight lane over (or under) the obstruction, entered and left smoothly.
 * `entryX` is the end the wire joins from the source, `exitX` the end it leaves
 * towards the target — so a wire running right-to-left works the same way.
 */
function lanePath(from: Point, to: Point, entryX: number, exitX: number, lane: number) {
  // Ports have a fixed orientation: results leave rightwards, inputs arrive
  // from the left, whichever way round the two nodes happen to sit.
  const out = 40;
  const into = 40;
  const bend = (a: number, b: number) => Math.max(24, Math.abs(b - a) * 0.4);
  const entryPull = entryX >= from.x ? -bend(from.x, entryX) : bend(from.x, entryX);
  const exitPull = to.x >= exitX ? bend(exitX, to.x) : -bend(exitX, to.x);

  const entry = { x: entryX, y: lane };
  const exit = { x: exitX, y: lane };
  const steps = 17;

  return {
    entry,
    exit,
    points: [
      ...sampleCubic(from, { x: from.x + out, y: from.y }, { x: entryX + entryPull, y: lane }, entry),
      ...sampleCubic(exit, { x: exitX + exitPull, y: lane }, { x: to.x - into, y: to.y }, to),
      // The flat middle needs checking too — it is the part that clears the card.
      ...Array.from({ length: steps }, (_, i) => ({
        x: entryX + ((exitX - entryX) * i) / (steps - 1),
        y: lane,
      })),
    ],
    d:
      `M ${round(from.x)} ${round(from.y)} ` +
      `C ${round(from.x + out)} ${round(from.y)}, ${round(entryX + entryPull)} ${round(lane)}, ${round(entryX)} ${round(lane)} ` +
      `L ${round(exitX)} ${round(lane)} ` +
      `C ${round(exitX + exitPull)} ${round(lane)}, ${round(to.x - into)} ${round(to.y)}, ${round(to.x)} ${round(to.y)}`,
  };
}

/**
 * A wire from `from` to `to` that does not disappear under a card.
 *
 * The plain bezier is used whenever it is clear. When something is in the way —
 * typically a connection that skips a column — the wire climbs to a lane that
 * clears the obstruction's whole width, runs across, and drops onto the target
 * port. Whichever side costs less vertical travel is tried first, and each
 * attempt is re-checked against everything it might newly have run into.
 */
export function routeWire(
  from: Point,
  to: Point,
  obstacles: Obstacle[]
): { d: string; mid: Point } {
  const dx = Math.max(48, Math.abs(to.x - from.x) * 0.55);
  const direct = sampleCubic(from, { x: from.x + dx, y: from.y }, { x: to.x - dx, y: to.y }, to);
  const hit = blockers(direct, obstacles, PAD);
  const straightMid = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
  if (!hit.length) return { d: wirePath(from, to), mid: straightMid };

  for (const direction of pickSides(hit, straightMid)) {
    let blocking = hit;
    let lane =
      direction < 0
        ? Math.min(...blocking.map((o) => o.y)) - GAP
        : Math.max(...blocking.map((o) => o.y + o.h)) + GAP;
    let left = Math.min(...blocking.map((o) => o.x)) - GAP;
    let right = Math.max(...blocking.map((o) => o.x + o.w)) + GAP;

    for (let attempt = 0; attempt < 4; attempt++) {
      // The lane spans the obstruction; which end is the entry depends on
      // whether the target sits to the right of the source or behind it.
      const forward = to.x >= from.x;
      const candidate = lanePath(
        from,
        to,
        forward ? left : right,
        forward ? right : left,
        lane
      );
      const stillBlocked = blockers(candidate.points, obstacles, PAD);
      if (!stillBlocked.length) {
        return {
          d: candidate.d,
          mid: { x: (candidate.entry.x + candidate.exit.x) / 2, y: lane },
        };
      }

      // Clear the newcomers as well, rather than nudging blindly.
      blocking = [...blocking, ...stillBlocked];
      lane =
        direction < 0
          ? Math.min(lane, Math.min(...stillBlocked.map((o) => o.y)) - GAP)
          : Math.max(lane, Math.max(...stillBlocked.map((o) => o.y + o.h)) + GAP);
      left = Math.min(left, ...stillBlocked.map((o) => o.x - GAP));
      right = Math.max(right, ...stillBlocked.map((o) => o.x + o.w + GAP));
    }
  }

  // Nothing clean available — the plain curve is still the least confusing.
  return { d: wirePath(from, to), mid: straightMid };
}

/** Above first when that is the shorter climb, below first otherwise. */
function pickSides(hit: Obstacle[], mid: Point): number[] {
  const above = mid.y - (Math.min(...hit.map((o) => o.y)) - GAP);
  const below = Math.max(...hit.map((o) => o.y + o.h)) + GAP - mid.y;
  return above <= below ? [-1, 1] : [1, -1];
}

export const midpoint = (a: Point, b: Point): Point => ({
  x: (a.x + b.x) / 2,
  y: (a.y + b.y) / 2,
});

/* ----------------------------------------------------------------- layout -- */

/**
 * Layered left-to-right arrangement, Sugiyama-style but deliberately small:
 * columns come from the longest path to a node, then rows are ordered by the
 * average position of each node's parents so wires cross as little as possible.
 * Deterministic — pressing the brush twice does not shuffle the canvas.
 */
export function autoLayout(graph: FlowGraph, originX = 80, originY = 80): FlowNode[] {
  const edges = effectiveEdges(graph);
  const depth = new Map<string, number>(graph.nodes.map((n) => [n.id, 0]));

  // Relaxation instead of recursion: cheap, and immune to cycles.
  for (let pass = 0; pass < graph.nodes.length; pass++) {
    let changed = false;
    for (const e of edges) {
      const next = (depth.get(e.source) ?? 0) + 1;
      if (next > (depth.get(e.target) ?? 0)) {
        depth.set(e.target, next);
        changed = true;
      }
    }
    if (!changed) break;
  }

  const columns = new Map<number, FlowNode[]>();
  for (const node of graph.nodes) {
    const column = depth.get(node.id) ?? 0;
    if (!columns.has(column)) columns.set(column, []);
    columns.get(column)!.push(node);
  }
  const columnKeys = [...columns.keys()].sort((a, b) => a - b);

  const parents = new Map<string, string[]>();
  const children = new Map<string, string[]>();
  for (const e of edges) {
    if (!parents.has(e.target)) parents.set(e.target, []);
    if (!children.has(e.source)) children.set(e.source, []);
    parents.get(e.target)!.push(e.source);
    children.get(e.source)!.push(e.target);
  }

  const rowOf = new Map<string, number>();
  const reindex = () => {
    for (const key of columnKeys) {
      columns.get(key)!.forEach((n, index) => rowOf.set(n.id, index));
    }
  };
  reindex();

  /** Average row of a node's neighbours in the adjacent column. */
  const barycentre = (id: string, side: Map<string, string[]>): number | null => {
    const rows = (side.get(id) ?? []).map((n) => rowOf.get(n)).filter((r): r is number => r !== undefined);
    if (!rows.length) return null;
    return rows.reduce((a, b) => a + b, 0) / rows.length;
  };

  // Two sweeps each way is plenty for graphs of this size, and keeps the
  // result stable: nodes with no neighbours hold their current row.
  for (let sweep = 0; sweep < 2; sweep++) {
    for (const key of columnKeys) {
      const list = columns.get(key)!;
      const keyed = list.map((n, index) => ({ n, index, b: barycentre(n.id, parents) }));
      keyed.sort((a, b) => (a.b ?? a.index) - (b.b ?? b.index) || a.index - b.index);
      columns.set(key, keyed.map((k) => k.n));
      reindex();
    }
    for (const key of [...columnKeys].reverse()) {
      const list = columns.get(key)!;
      const keyed = list.map((n, index) => ({ n, index, b: barycentre(n.id, children) }));
      keyed.sort((a, b) => (a.b ?? a.index) - (b.b ?? b.index) || a.index - b.index);
      columns.set(key, keyed.map((k) => k.n));
      reindex();
    }
  }

  // Cards are not all the same height any more, so a column is stacked rather
  // than indexed: each node starts where the one above it ended.
  const stackHeight = (list: FlowNode[]) =>
    list.reduce((sum, n) => sum + nodeHeight(n) + ROW_GAP, -ROW_GAP);
  const totalHeight = Math.max(NODE_H, ...columnKeys.map((k) => stackHeight(columns.get(k)!)));

  const placed = new Map<string, { x: number; y: number }>();
  for (const key of columnKeys) {
    const list = columns.get(key)!;
    let y = originY + (totalHeight - stackHeight(list)) / 2;
    for (const node of list) {
      placed.set(node.id, { x: originX + key * (NODE_W + COLUMN_GAP), y: Math.round(y) });
      y += nodeHeight(node) + ROW_GAP;
    }
  }

  return graph.nodes.map((node) => ({ ...node, ...placed.get(node.id)! }));
}
