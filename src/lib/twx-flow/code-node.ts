/**
 * Facts about the Code node that both sides need to agree on.
 *
 * The sandbox itself is server-only — it loads a native module — so the pieces
 * the editor also has to know live here instead.
 */

export const DEFAULT_CODE_TIMEOUT_MS = 5_000;
export const MAX_CODE_TIMEOUT_MS = 60_000;
export const CODE_MEMORY_LIMIT_MB = 128;

/** Starting point for a new Code node, and the shape the panel documents. */
export const CODE_TEMPLATE = `// $json is the connected node's output; $node["Label"] reaches any other node.
// Whatever you return becomes this node's output.
const rows = $json?.rows ?? [];

return {
  dataShape: $json?.dataShape,
  rows: rows.filter((row) => row.name),
};
`;

/** Shown in the panel so the limits of the isolate are not a surprise. */
export const CODE_HELP = [
  { snippet: "$json", hint: "output of the connected node" },
  { snippet: '$node["Label"]', hint: "output of any other node, by title" },
  { snippet: "$now", hint: "run start time, as an ISO string" },
  { snippet: "console.log(x)", hint: "collected and shown under Output" },
  { snippet: "await …", hint: "allowed — but there is no fetch and no timer" },
];
