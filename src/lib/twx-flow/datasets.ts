/**
 * Row algebra for the Merge and Compare Datasets nodes.
 *
 * Pure functions over plain rows: the runner uses them to produce results and
 * the editor uses them to preview one before the flow is ever run.
 */

import { reshapeLike, toRows } from "./schema";
import type { MergeMode } from "./types";

/** Splits "id, name" into ["id", "name"]. A compound key is joined field-wise. */
export const keyFields = (raw: string): string[] =>
  (raw ?? "")
    .split(",")
    .map((f) => f.trim())
    .filter(Boolean);

/** Value a row is matched on. `null`/`undefined` are distinct from "". */
function keyOf(row: Record<string, unknown>, fields: string[]): string {
  return JSON.stringify(fields.map((f) => row?.[f] ?? null));
}

/* ------------------------------------------------------------------ merge -- */

export type MergeResult = {
  value: unknown;
  /** What the node card and the panel report about the join. */
  summary: Record<string, unknown>;
};

/**
 * Puts several inputs together.
 *
 * - `append` — every row of input 1, then every row of input 2, …
 * - `position` — row *n* of each input merged into one row
 * - `field` — an inner join on `field`, input 2 overwriting input 1
 * - `branch` — waits for both, then emits input 1 unchanged
 */
export function mergeInputs(inputs: unknown[], mode: MergeMode, field: string): MergeResult {
  const tables = inputs.map(toRows);
  const shape = inputs[0];
  const counts = Object.fromEntries(tables.map((rows, i) => [`input ${i + 1}`, rows.length]));

  switch (mode) {
    case "branch":
      return { value: inputs[0], summary: { mode, ...counts } };

    case "position": {
      const length = Math.max(0, ...tables.map((rows) => rows.length));
      const rows = Array.from({ length }, (_, index) =>
        Object.assign({}, ...tables.map((table) => table[index] ?? {}))
      );
      return { value: reshapeLike(shape, rows), summary: { mode, ...counts, merged: rows.length } };
    }

    case "field": {
      const fields = keyFields(field);
      if (!fields.length) {
        return {
          value: reshapeLike(shape, tables.flat()),
          summary: { mode, ...counts, note: "no field set — inputs were appended" },
        };
      }
      const [first = [], ...rest] = tables;
      // Every later input contributes at most one match per key, like a join.
      const indexes = rest.map((rows) => {
        const map = new Map<string, Record<string, unknown>>();
        for (const row of rows) map.set(keyOf(row, fields), row);
        return map;
      });
      const rows: Record<string, unknown>[] = [];
      for (const row of first) {
        const key = keyOf(row, fields);
        const matches = indexes.map((index) => index.get(key));
        if (matches.some((m) => m === undefined)) continue;
        rows.push(Object.assign({}, row, ...matches));
      }
      return {
        value: reshapeLike(shape, rows),
        summary: { mode, on: fields.join(", "), ...counts, matched: rows.length },
      };
    }

    case "append":
    default: {
      const rows = tables.flat();
      return { value: reshapeLike(shape, rows), summary: { mode: "append", ...counts, total: rows.length } };
    }
  }
}

/* ---------------------------------------------------------------- compare -- */

export type CompareBuckets = {
  inA: Record<string, unknown>[];
  same: Record<string, unknown>[];
  different: Record<string, unknown>[];
  inB: Record<string, unknown>[];
};

/** Key-order-independent deep equality, enough for infotable rows. */
function sameRow(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of keys) if (!sameRow(left[key], right[key])) return false;
  return true;
}

/**
 * Sorts two datasets into the four buckets the node's ports carry. Rows with no
 * key field configured fall back to comparing the whole row, so the node still
 * says something useful before it is set up.
 */
export function compareDatasets(
  a: unknown,
  b: unknown,
  keyA: string,
  keyB: string,
  resolve: "a" | "b"
): CompareBuckets {
  const rowsA = toRows(a);
  const rowsB = toRows(b);
  const fieldsA = keyFields(keyA);
  const fieldsB = keyFields(keyB).length ? keyFields(keyB) : fieldsA;

  const keyed = (row: Record<string, unknown>, fields: string[]) =>
    fields.length ? keyOf(row, fields) : JSON.stringify(row);

  const indexB = new Map<string, Record<string, unknown>>();
  for (const row of rowsB) indexB.set(keyed(row, fieldsB), row);

  const buckets: CompareBuckets = { inA: [], same: [], different: [], inB: [] };
  const seen = new Set<string>();

  for (const row of rowsA) {
    const key = keyed(row, fieldsA);
    const match = indexB.get(key);
    if (match === undefined) {
      buckets.inA.push(row);
      continue;
    }
    seen.add(key);
    if (sameRow(row, match)) buckets.same.push(row);
    else buckets.different.push(resolve === "a" ? row : match);
  }

  for (const row of rowsB) {
    if (!seen.has(keyed(row, fieldsB))) buckets.inB.push(row);
  }
  return buckets;
}
