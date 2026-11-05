import type { ServiceResultType } from "@/lib/twx/types";
import type { FieldDef, FlowNode, OutputSchema } from "./types";

export type Infotable = {
  rows: Record<string, unknown>[];
  dataShape?: { fieldDefinitions?: Record<string, RawFieldDef> };
};

type RawFieldDef = {
  name?: string;
  baseType?: string;
  description?: string;
  ordinal?: number;
};

/** Recognises the `{ dataShape, rows }` envelope a ThingWorx infotable uses. */
export function asInfotable(value: unknown): Infotable | null {
  if (!value || typeof value !== "object") return null;
  const obj = value as Record<string, unknown>;
  if (!Array.isArray(obj.rows)) return null;
  return {
    rows: obj.rows as Record<string, unknown>[],
    dataShape: obj.dataShape as Infotable["dataShape"],
  };
}

/**
 * A value seen as rows, whatever it arrived as: an infotable's `rows`, a bare
 * array, or a single object standing in for a one-row table. Nodes that work
 * row by row — Filter, Loop, Merge, Compare — all start here.
 */
export function toRows(value: unknown): Record<string, unknown>[] {
  const table = asInfotable(value);
  if (table) return table.rows;
  if (Array.isArray(value)) return value as Record<string, unknown>[];
  if (value === null || value === undefined) return [];
  if (typeof value === "object") return [value as Record<string, unknown>];
  return [{ value } as Record<string, unknown>];
}

/**
 * Rows put back into the container they came out of, so a node that filters an
 * infotable still emits an infotable — DataShape and all — and one that filters
 * a plain array still emits an array.
 */
export function reshapeLike(original: unknown, rows: Record<string, unknown>[]): unknown {
  const table = asInfotable(original);
  if (table) {
    // Everything except `rows` is carried over untouched. A real infotable only
    // has `dataShape` there, but a JSON payload that merely looks like one can
    // hold anything — `total`, `hasMore` — and those are not ours to drop.
    return { ...(original as Record<string, unknown>), rows };
  }
  if (Array.isArray(original)) return rows;
  return { rows };
}

const byOrdinal = (a: FieldDef, b: FieldDef) => (a.ordinal ?? 0) - (b.ordinal ?? 0);

export function fieldsFromDefinitions(
  definitions: Record<string, RawFieldDef> | undefined
): FieldDef[] {
  if (!definitions) return [];
  return Object.entries(definitions)
    .map(([key, def]) => ({
      name: def.name ?? key,
      baseType: def.baseType ?? "STRING",
      description: def.description,
      ordinal: def.ordinal ?? 0,
    }))
    .sort(byOrdinal);
}

/** Column names of a live infotable, data-shape order first, keys as fallback. */
export function infotableFields(table: Infotable): FieldDef[] {
  const declared = fieldsFromDefinitions(table.dataShape?.fieldDefinitions);
  if (declared.length) return declared;
  const first = table.rows[0];
  if (!first) return [];
  return Object.keys(first).map((name, ordinal) => ({
    name,
    baseType: baseTypeOf(first[name]),
    ordinal,
  }));
}

function baseTypeOf(value: unknown): string {
  if (typeof value === "number") return "NUMBER";
  if (typeof value === "boolean") return "BOOLEAN";
  if (Array.isArray(value)) return "JSON";
  if (value && typeof value === "object") return asInfotable(value) ? "INFOTABLE" : "JSON";
  return "STRING";
}

/**
 * The structure a service *declares*, before it has ever run. `fields` stays
 * empty until the DataShape named here is resolved against the server.
 */
export function schemaFromResultType(resultType: ServiceResultType): OutputSchema {
  const dataShape = resultType.aspects?.dataShape;
  return {
    baseType: resultType.baseType,
    dataShape: typeof dataShape === "string" && dataShape ? dataShape : undefined,
    fields: [],
  };
}

/** The structure an actual result turned out to have. */
export function schemaFromValue(value: unknown): OutputSchema | null {
  const table = asInfotable(value);
  if (table) {
    return {
      baseType: "INFOTABLE",
      dataShape: (table.dataShape as { name?: string } | undefined)?.name,
      fields: infotableFields(table),
    };
  }
  if (value && typeof value === "object") {
    return {
      baseType: "JSON",
      fields: Object.entries(value as Record<string, unknown>).map(([name, v], ordinal) => ({
        name,
        baseType: baseTypeOf(v),
        ordinal,
      })),
    };
  }
  return null;
}

/**
 * What a node's output looks like *right now*: the live result when it has run,
 * otherwise the declared DataShape.
 *
 * Only service calls declare anything up front. A code node's shape is whatever
 * it returned last, and a branch passes its input straight through — so before
 * either has run there is nothing to describe but the kind of node it is.
 */
export function effectiveSchema(node: FlowNode, result: unknown): OutputSchema {
  const fromRun = result === undefined ? null : schemaFromValue(result);
  if (fromRun?.fields.length) return fromRun;
  if (node.kind !== "service") return fromRun ?? { baseType: "ANY", fields: [] };
  if (node.outputSchema?.fields.length) return node.outputSchema;
  return fromRun ?? node.outputSchema ?? schemaFromResultType(node.resultType);
}

const PLACEHOLDER: Record<string, unknown> = {
  NUMBER: 0,
  INTEGER: 0,
  LONG: 0,
  BOOLEAN: false,
  DATETIME: "1970-01-01T00:00:00.000Z",
  JSON: {},
  INFOTABLE: { dataShape: { fieldDefinitions: {} }, rows: [] },
};

const placeholderFor = (baseType: string): unknown =>
  baseType in PLACEHOLDER ? PLACEHOLDER[baseType] : `${baseType.toLowerCase()}`;

/**
 * A stand-in result built from the declared schema so expressions can be
 * written — and previewed — before anything is executed.
 */
export function sampleFromSchema(schema: OutputSchema): unknown {
  if (schema.baseType === "INFOTABLE") {
    const row = Object.fromEntries(
      schema.fields.map((f) => [f.name, placeholderFor(f.baseType)])
    );
    return {
      dataShape: {
        name: schema.dataShape,
        fieldDefinitions: Object.fromEntries(
          schema.fields.map((f) => [
            f.name,
            { name: f.name, baseType: f.baseType, ordinal: f.ordinal ?? 0 },
          ])
        ),
      },
      rows: schema.fields.length ? [row] : [],
    };
  }
  if (schema.fields.length) {
    return Object.fromEntries(schema.fields.map((f) => [f.name, placeholderFor(f.baseType)]));
  }
  return placeholderFor(schema.baseType);
}

/** One-line description for the node card and the output header. */
export function describeSchema(schema: OutputSchema): string {
  if (schema.baseType === "INFOTABLE") {
    // An unnamed shape is normal for results built at runtime — say so plainly
    // rather than calling a perfectly good structure "unknown".
    const shape = schema.dataShape ?? "INFOTABLE";
    return schema.fields.length ? `${shape} · ${schema.fields.length} fields` : shape;
  }
  // Nothing declares ANY — it is what a code node's output is until it runs.
  return schema.baseType === "ANY" ? "any" : schema.baseType;
}
