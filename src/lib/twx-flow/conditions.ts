/**
 * The rule builder behind the Filter node: a list of
 * `column · operator · value` tests, combined with AND or OR and evaluated once
 * per infotable row.
 *
 * The left-hand side is a column name, because rows here are infotable rows —
 * `{{ … }}` is still accepted for anything a column name cannot say.
 */

import { evaluateTemplate, isExpression, type ExprContext } from "./expression";
import type { FilterCondition, FilterOperator } from "./types";

export type OperatorDef = {
  id: FilterOperator;
  label: string;
  group: "General" | "Text" | "Number" | "Date" | "Boolean";
  /** One-sided operators — "is empty" and friends — hide the value field. */
  unary?: boolean;
  /** How the right-hand value is read before comparing. */
  as?: "string" | "number" | "date";
};

export const OPERATORS: OperatorDef[] = [
  { id: "eq", label: "is equal to", group: "General" },
  { id: "neq", label: "is not equal to", group: "General" },
  { id: "exists", label: "exists", group: "General", unary: true },
  { id: "notExists", label: "does not exist", group: "General", unary: true },
  { id: "isEmpty", label: "is empty", group: "General", unary: true },
  { id: "isNotEmpty", label: "is not empty", group: "General", unary: true },

  { id: "contains", label: "contains", group: "Text", as: "string" },
  { id: "notContains", label: "does not contain", group: "Text", as: "string" },
  { id: "startsWith", label: "starts with", group: "Text", as: "string" },
  { id: "endsWith", label: "ends with", group: "Text", as: "string" },
  { id: "regex", label: "matches regex", group: "Text", as: "string" },

  { id: "gt", label: "is greater than", group: "Number", as: "number" },
  { id: "gte", label: "is greater than or equal to", group: "Number", as: "number" },
  { id: "lt", label: "is less than", group: "Number", as: "number" },
  { id: "lte", label: "is less than or equal to", group: "Number", as: "number" },

  { id: "after", label: "is after", group: "Date", as: "date" },
  { id: "before", label: "is before", group: "Date", as: "date" },

  { id: "isTrue", label: "is true", group: "Boolean", unary: true },
  { id: "isFalse", label: "is false", group: "Boolean", unary: true },
];

export const OPERATOR_GROUPS = ["General", "Text", "Number", "Date", "Boolean"] as const;

const BY_ID = new Map(OPERATORS.map((op) => [op.id, op]));

export const operatorDef = (id: FilterOperator): OperatorDef => BY_ID.get(id) ?? OPERATORS[0];

/** Short text for the node card: `status is equal to Online`. */
export function describeCondition(condition: FilterCondition): string {
  const op = operatorDef(condition.operator);
  const left = condition.left?.trim() || "value";
  return op.unary ? `${left} ${op.label}` : `${left} ${op.label} ${condition.right?.trim() || "…"}`;
}

/* ------------------------------------------------------------- evaluation -- */

const isBlank = (value: unknown) =>
  value === null ||
  value === undefined ||
  value === "" ||
  (Array.isArray(value) && value.length === 0);

const toNumber = (value: unknown): number =>
  typeof value === "number" ? value : Number(String(value ?? "").trim());

const toTime = (value: unknown): number => {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value;
  return new Date(String(value ?? "")).getTime();
};

/** Key-order-independent equality, so two identical rows count as equal. */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of keys) if (!deepEqual(left[key], right[key])) return false;
  return true;
}

/**
 * One test.
 *
 * `convert` is the "convert types where required" switch: with it on, a column
 * holding the string `"12"` still counts as the number 12 and equality is
 * loose. With it off, a mismatch of types is simply false.
 */
export function testCondition(
  left: unknown,
  operator: FilterOperator,
  right: unknown,
  convert: boolean
): boolean {
  const op = operatorDef(operator);

  switch (operator) {
    case "exists":
      return left !== undefined && left !== null;
    case "notExists":
      return left === undefined || left === null;
    case "isEmpty":
      return isBlank(left);
    case "isNotEmpty":
      return !isBlank(left);
    case "isTrue":
      return convert ? Boolean(left) && left !== "false" : left === true;
    case "isFalse":
      return convert ? !left || left === "false" : left === false;
  }

  if (op.as === "number") {
    const a = toNumber(left);
    const b = toNumber(right);
    if (Number.isNaN(a) || Number.isNaN(b)) return false;
    if (!convert && typeof left !== "number") return false;
    switch (operator) {
      case "gt":
        return a > b;
      case "gte":
        return a >= b;
      case "lt":
        return a < b;
      case "lte":
        return a <= b;
    }
  }

  if (op.as === "date") {
    const a = toTime(left);
    const b = toTime(right);
    if (Number.isNaN(a) || Number.isNaN(b)) return false;
    return operator === "after" ? a > b : a < b;
  }

  if (op.as === "string") {
    if (!convert && typeof left !== "string") return false;
    const a = String(left ?? "");
    const b = String(right ?? "");
    switch (operator) {
      case "contains":
        return a.includes(b);
      case "notContains":
        return !a.includes(b);
      case "startsWith":
        return a.startsWith(b);
      case "endsWith":
        return a.endsWith(b);
      case "regex":
        try {
          return new RegExp(b).test(a);
        } catch {
          // An unfinished regex is not a match, and not a crash either.
          return false;
        }
    }
  }

  // What is left is equality, which is the only place strictness is a choice.
  const same = convert
    ? typeof left === "object" || typeof right === "object"
      ? deepEqual(left, right)
      : String(left ?? "") === String(right ?? "")
    : deepEqual(left, right);
  return operator === "neq" ? !same : same;
}

/**
 * Reads one side of a condition.
 *
 * Anything holding `{{ … }}` is an expression. A plain left-hand side is a
 * column of the row; a plain right-hand side is the literal typed in.
 */
function sideValue(
  raw: string,
  side: "left" | "right",
  row: Record<string, unknown>,
  ctx: ExprContext
): { value: unknown; error?: string } {
  const text = raw ?? "";
  if (isExpression(text)) {
    const { value, error } = evaluateTemplate(text, ctx);
    return { value, error };
  }
  if (side === "right") return { value: text };
  const name = text.trim();
  return { value: name ? row?.[name] : undefined };
}

export type ConditionOutcome = {
  /** Whether the row passes. */
  pass: boolean;
  /** First expression that would not evaluate, if any. */
  error?: string;
};

/** Runs every condition against one row and combines them. */
export function testConditions(
  conditions: FilterCondition[],
  combinator: "and" | "or",
  convert: boolean,
  row: Record<string, unknown>,
  ctx: ExprContext
): ConditionOutcome {
  const usable = conditions.filter((c) => c.left?.trim() || isExpression(c.left ?? ""));
  // Nothing configured keeps everything, which is what an empty filter means.
  if (!usable.length) return { pass: true };

  let error: string | undefined;
  const results = usable.map((condition) => {
    const left = sideValue(condition.left, "left", row, ctx);
    const right = operatorDef(condition.operator).unary
      ? { value: undefined, error: undefined }
      : sideValue(condition.right, "right", row, ctx);
    error ??= left.error ?? right.error;
    return testCondition(left.value, condition.operator, right.value, convert);
  });

  return {
    pass: combinator === "or" ? results.some(Boolean) : results.every(Boolean),
    error,
  };
}
