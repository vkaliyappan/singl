type Infotable = {
  rows: Record<string, unknown>[];
  dataShape?: { fieldDefinitions?: Record<string, RawFieldDef> };
};

type RawFieldDef = {
  name?: string;
  baseType?: string;
  ordinal?: number;
};

/** Recognises the `{ dataShape, rows }` envelope a ThingWorx infotable uses. */
function asInfotable(value: unknown): Infotable | null {
  if (!value || typeof value !== "object") return null;
  const obj = value as Record<string, unknown>;
  if (!Array.isArray(obj.rows)) return null;
  return {
    rows: obj.rows as Record<string, unknown>[],
    dataShape: obj.dataShape as Infotable["dataShape"],
  };
}

/** Declared DataShape fields in ordinal order; empty when the shape is absent. */
function infotableFields(table: Infotable): TableColumn[] {
  const defs = table.dataShape?.fieldDefinitions;
  if (!defs) return [];
  return Object.entries(defs)
    .map(([key, def]) => ({
      name: def.name ?? key,
      baseType: def.baseType ?? "STRING",
      ordinal: def.ordinal ?? 0,
    }))
    .sort((a, b) => a.ordinal - b.ordinal)
    .map(({ name, baseType }) => ({ name, baseType }));
}

export type TableColumn = {
  name: string;
  baseType: string;
};

export type TableSource = {
  /** Display path into the document, e.g. `$.result.rows`. `$` is the root. */
  path: string;
  segments: (string | number)[];
  rows: Record<string, unknown>[];
  /** Declared columns when the value is an infotable, else inferred from rows. */
  columns: TableColumn[];
  kind: "infotable" | "array" | "object";
};

const MAX_DEPTH = 6;
const MAX_CANDIDATES = 60;

export function baseTypeOf(value: unknown): string {
  if (value === null || value === undefined) return "STRING";
  if (typeof value === "number") return "NUMBER";
  if (typeof value === "boolean") return "BOOLEAN";
  if (Array.isArray(value)) return "JSON";
  if (typeof value === "object") return asInfotable(value) ? "INFOTABLE" : "JSON";
  return "STRING";
}

/** A cell as the text it renders — objects become JSON, so they stay searchable. */
export function cellText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function segmentPath(segments: (string | number)[]): string {
  return segments.reduce<string>((acc, seg) => {
    if (typeof seg === "number") return `${acc}[${seg}]`;
    return /^[A-Za-z_$][\w$]*$/.test(seg) ? `${acc}.${seg}` : `${acc}[${JSON.stringify(seg)}]`;
  }, "$");
}

export function valueAtSegments(root: unknown, segments: (string | number)[]): unknown {
  return segments.reduce<unknown>((acc, seg) => {
    if (acc === null || acc === undefined) return undefined;
    return (acc as Record<string | number, unknown>)[seg];
  }, root);
}

/** True when every entry is a plain object — the shape a grid can render as rows. */
function isRowArray(value: unknown): value is Record<string, unknown>[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((r) => !!r && typeof r === "object" && !Array.isArray(r))
  );
}

/**
 * Every place in the document that could be shown as a table: infotable
 * envelopes, arrays of objects, arrays of scalars, and the root object itself.
 * Breadth-first, so the shallowest — and usually the intended — table is first.
 */
export function collectTableSources(root: unknown): TableSource[] {
  const found: TableSource[] = [];
  const seen = new Set<unknown>();
  const queue: { value: unknown; segments: (string | number)[]; depth: number }[] = [
    { value: root, segments: [], depth: 0 },
  ];

  while (queue.length && found.length < MAX_CANDIDATES) {
    const { value, segments, depth } = queue.shift()!;
    if (!value || typeof value !== "object") continue;
    if (seen.has(value)) continue;
    seen.add(value);

    const source = asTableSource(value, segments);
    if (source) found.push(source);

    if (depth >= MAX_DEPTH) continue;
    if (Array.isArray(value)) {
      // Only the first few entries — a long array's children are all alike, and
      // its own rows are already a candidate.
      value.slice(0, 3).forEach((child, index) => {
        queue.push({ value: child, segments: [...segments, index], depth: depth + 1 });
      });
    } else {
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        queue.push({ value: child, segments: [...segments, key], depth: depth + 1 });
      }
    }
  }

  return found;
}

function asTableSource(value: unknown, segments: (string | number)[]): TableSource | null {
  const path = segmentPath(segments);

  const table = asInfotable(value);
  if (table) {
    const declared = infotableFields(table);
    return {
      path,
      segments: [...segments],
      rows: table.rows,
      columns: declared.length ? declared : columnsFromRows(table.rows),
      kind: "infotable",
    };
  }

  if (Array.isArray(value)) {
    if (value.length === 0) return null;
    if (isRowArray(value)) {
      return { path, segments: [...segments], rows: value, columns: columnsFromRows(value), kind: "array" };
    }
    // A scalar (or mixed) array still makes a one-column table.
    const rows = value.map((entry) => ({ value: entry }));
    return {
      path,
      segments: [...segments],
      rows,
      columns: [{ name: "value", baseType: baseTypeOf(value[0]) }],
      kind: "array",
    };
  }

  // A bare object is only worth offering at the root — deeper ones are reached
  // through the array that holds them.
  if (segments.length === 0) {
    const entries = Object.entries(value as Record<string, unknown>);
    if (!entries.length) return null;
    const rows = entries.map(([key, val]) => ({ key, value: val }));
    return {
      path,
      segments: [],
      rows,
      columns: [
        { name: "key", baseType: "STRING" },
        { name: "value", baseType: "STRING" },
      ],
      kind: "object",
    };
  }

  return null;
}

/** Union of the keys across rows, in first-seen order. */
export function columnsFromRows(rows: Record<string, unknown>[]): TableColumn[] {
  const columns = new Map<string, TableColumn>();
  // A wide document should not be scanned end to end just to name its columns.
  for (const row of rows.slice(0, 500)) {
    if (!row || typeof row !== "object") continue;
    for (const [key, value] of Object.entries(row)) {
      const existing = columns.get(key);
      if (!existing) {
        columns.set(key, { name: key, baseType: baseTypeOf(value) });
      } else if (existing.baseType === "STRING" && value !== null && value !== undefined) {
        // First non-null value wins the type — earlier rows are often empty.
        existing.baseType = baseTypeOf(value);
      }
    }
  }
  return [...columns.values()];
}

/**
 * Nested objects lifted into dotted columns — `address.city` rather than a JSON
 * blob. Arrays and infotables are left whole; they are values, not structure.
 */
export function flattenRow(
  row: Record<string, unknown>,
  prefix = "",
  depth = 0
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    const name = prefix ? `${prefix}.${key}` : key;
    const plainObject =
      !!value && typeof value === "object" && !Array.isArray(value) && !asInfotable(value);
    if (plainObject && depth < MAX_DEPTH) {
      const nested = flattenRow(value as Record<string, unknown>, name, depth + 1);
      // An empty nested object still deserves a column, or it vanishes silently.
      if (Object.keys(nested).length) Object.assign(out, nested);
      else out[name] = value;
    } else {
      out[name] = value;
    }
  }
  return out;
}

export function toCsv(columns: string[], rows: Record<string, unknown>[]): string {
  const escape = (value: unknown) => {
    const text = cellText(value);
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const lines = [columns.map(escape).join(",")];
  for (const row of rows) lines.push(columns.map((c) => escape(row[c])).join(","));
  return lines.join("\r\n");
}
