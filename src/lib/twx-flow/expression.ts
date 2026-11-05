/**
 * The `{{ … }}` expression language used by parameter fields.
 *
 * It is a small JavaScript-shaped subset evaluated by a hand-written parser
 * rather than `eval`/`new Function`: the same code has to run in the browser
 * (live preview while typing) and on the server (the actual run), and neither
 * side should hand a user's text to the JS engine.
 *
 * Supported: literals, arrays, objects, member/index access, the usual
 * arithmetic / comparison / logical / ternary operators, a whitelist of value
 * methods (`toUpperCase`, `join`, `slice`, …) and a handful of `$` helpers.
 */

export type ExprContext = {
  /** Result of the node wired into this one. */
  $json: unknown;
  /** Every upstream result, keyed by node label. */
  $node: Record<string, unknown>;
  /** The row being tested, where a node evaluates its condition per row. */
  $item?: unknown;
  /** Index of that row. */
  $index?: number;
  /** Stable clock for the whole run, so `$now` cannot drift mid-flow. */
  now?: Date;
};

export type EvalResult = { value: unknown; error?: string };

const EXPR_RE = /\{\{([\s\S]*?)\}\}/g;

/** True when the raw field value contains at least one `{{ … }}` block. */
export function isExpression(raw: string): boolean {
  return /\{\{[\s\S]*?\}\}/.test(raw ?? "");
}

/* ------------------------------------------------------------------ lexer -- */

type Token =
  | { kind: "num"; value: number }
  | { kind: "str"; value: string }
  | { kind: "name"; value: string }
  | { kind: "punc"; value: string };

const PUNCTUATION = [
  "===",
  "!==",
  "==",
  "!=",
  "<=",
  ">=",
  "&&",
  "||",
  "??",
  "?.",
  "(",
  ")",
  "[",
  "]",
  "{",
  "}",
  ",",
  ".",
  ":",
  "?",
  "+",
  "-",
  "*",
  "/",
  "%",
  "<",
  ">",
  "!",
];

const isNameStart = (c: string) => /[A-Za-z_$]/.test(c);
const isNamePart = (c: string) => /[A-Za-z0-9_$]/.test(c);

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const c = input[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      let out = "";
      i++;
      while (i < input.length && input[i] !== quote) {
        if (input[i] === "\\") {
          const next = input[++i];
          out += next === "n" ? "\n" : next === "t" ? "\t" : next;
        } else {
          out += input[i];
        }
        i++;
      }
      if (i >= input.length) throw new Error("Unterminated string");
      i++;
      tokens.push({ kind: "str", value: out });
      continue;
    }
    if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(input[i + 1] ?? ""))) {
      let out = "";
      while (i < input.length && /[0-9._]/.test(input[i])) out += input[i++];
      tokens.push({ kind: "num", value: Number(out.replace(/_/g, "")) });
      continue;
    }
    if (isNameStart(c)) {
      let out = "";
      while (i < input.length && isNamePart(input[i])) out += input[i++];
      tokens.push({ kind: "name", value: out });
      continue;
    }
    const punc = PUNCTUATION.find((p) => input.startsWith(p, i));
    if (!punc) throw new Error(`Unexpected character "${c}"`);
    i += punc.length;
    tokens.push({ kind: "punc", value: punc });
  }
  return tokens;
}

/* ----------------------------------------------------------------- parser -- */

type Node =
  | { type: "literal"; value: unknown }
  | { type: "ident"; name: string }
  | { type: "member"; object: Node; property: Node; computed: boolean; optional: boolean }
  | { type: "call"; callee: Node; args: Node[] }
  | { type: "unary"; op: string; argument: Node }
  | { type: "binary"; op: string; left: Node; right: Node }
  | { type: "logical"; op: string; left: Node; right: Node }
  | { type: "conditional"; test: Node; consequent: Node; alternate: Node }
  | { type: "array"; elements: Node[] }
  | { type: "object"; properties: { key: string; value: Node }[] };

/** Higher binds tighter. Ternary and the logical operators sit above these. */
const BINARY_PRECEDENCE: Record<string, number> = {
  "==": 1,
  "!=": 1,
  "===": 1,
  "!==": 1,
  "<": 2,
  ">": 2,
  "<=": 2,
  ">=": 2,
  "+": 3,
  "-": 3,
  "*": 4,
  "/": 4,
  "%": 4,
};

function parse(source: string): Node {
  const tokens = tokenize(source);
  let pos = 0;

  const peek = () => tokens[pos];
  const isPunc = (value: string) => {
    const t = peek();
    return t && t.kind === "punc" && t.value === value;
  };
  const eat = (value: string) => {
    if (!isPunc(value)) throw new Error(`Expected "${value}"`);
    pos++;
  };

  function parsePrimary(): Node {
    const token = peek();
    if (!token) throw new Error("Unexpected end of expression");

    if (token.kind === "num" || token.kind === "str") {
      pos++;
      return { type: "literal", value: token.value };
    }
    if (token.kind === "name") {
      pos++;
      if (token.value === "true") return { type: "literal", value: true };
      if (token.value === "false") return { type: "literal", value: false };
      if (token.value === "null") return { type: "literal", value: null };
      if (token.value === "undefined") return { type: "literal", value: undefined };
      return { type: "ident", name: token.value };
    }
    if (isPunc("(")) {
      pos++;
      const inner = parseExpression();
      eat(")");
      return inner;
    }
    if (isPunc("[")) {
      pos++;
      const elements: Node[] = [];
      while (!isPunc("]")) {
        elements.push(parseExpression());
        if (isPunc(",")) pos++;
      }
      eat("]");
      return { type: "array", elements };
    }
    if (isPunc("{")) {
      pos++;
      const properties: { key: string; value: Node }[] = [];
      while (!isPunc("}")) {
        const keyToken = peek();
        if (!keyToken || (keyToken.kind !== "name" && keyToken.kind !== "str")) {
          throw new Error("Object keys must be names or strings");
        }
        pos++;
        eat(":");
        properties.push({ key: String(keyToken.value), value: parseExpression() });
        if (isPunc(",")) pos++;
      }
      eat("}");
      return { type: "object", properties };
    }
    throw new Error(`Unexpected token "${String(token.value)}"`);
  }

  function parsePostfix(): Node {
    let node = parsePrimary();
    for (;;) {
      if (isPunc(".") || isPunc("?.")) {
        const optional = isPunc("?.");
        pos++;
        const name = peek();
        if (!name || name.kind !== "name") throw new Error("Expected a property name after \".\"");
        pos++;
        node = {
          type: "member",
          object: node,
          property: { type: "literal", value: name.value },
          computed: false,
          optional,
        };
        continue;
      }
      if (isPunc("[")) {
        pos++;
        const property = parseExpression();
        eat("]");
        node = { type: "member", object: node, property, computed: true, optional: false };
        continue;
      }
      if (isPunc("(")) {
        pos++;
        const args: Node[] = [];
        while (!isPunc(")")) {
          args.push(parseExpression());
          if (isPunc(",")) pos++;
        }
        eat(")");
        node = { type: "call", callee: node, args };
        continue;
      }
      return node;
    }
  }

  function parseUnary(): Node {
    if (isPunc("!") || isPunc("-") || isPunc("+")) {
      const op = (peek() as { value: string }).value;
      pos++;
      return { type: "unary", op, argument: parseUnary() };
    }
    return parsePostfix();
  }

  function parseBinary(minPrecedence: number): Node {
    let left = parseUnary();
    for (;;) {
      const token = peek();
      if (!token || token.kind !== "punc") return left;
      const precedence = BINARY_PRECEDENCE[token.value];
      if (!precedence || precedence < minPrecedence) return left;
      pos++;
      const right = parseBinary(precedence + 1);
      left = { type: "binary", op: token.value, left, right };
    }
  }

  function parseLogical(): Node {
    let left = parseBinary(1);
    while (isPunc("&&") || isPunc("||") || isPunc("??")) {
      const op = (peek() as { value: string }).value;
      pos++;
      const right = parseBinary(1);
      left = { type: "logical", op, left, right };
    }
    return left;
  }

  function parseExpression(): Node {
    const test = parseLogical();
    if (!isPunc("?")) return test;
    pos++;
    const consequent = parseExpression();
    eat(":");
    const alternate = parseExpression();
    return { type: "conditional", test, consequent, alternate };
  }

  const ast = parseExpression();
  if (pos < tokens.length) {
    throw new Error(`Unexpected "${String(tokens[pos].value)}"`);
  }
  return ast;
}

/* -------------------------------------------------------------- evaluator -- */

const BLOCKED_KEYS = new Set(["__proto__", "constructor", "prototype"]);

const STRING_METHODS = new Set([
  "toUpperCase",
  "toLowerCase",
  "trim",
  "slice",
  "substring",
  "split",
  "replace",
  "replaceAll",
  "padStart",
  "padEnd",
  "includes",
  "startsWith",
  "endsWith",
  "indexOf",
  "charAt",
  "concat",
  "repeat",
  "toString",
]);

const ARRAY_METHODS = new Set([
  "join",
  "slice",
  "includes",
  "indexOf",
  "concat",
  "reverse",
  "flat",
  "toString",
]);

const NUMBER_METHODS = new Set(["toFixed", "toPrecision", "toString"]);

/** A method call is only allowed when the receiver's type whitelists the name. */
function callMethod(target: unknown, name: string, args: unknown[]): unknown {
  if (target === null || target === undefined) {
    throw new Error(`Cannot call ${name}() on ${String(target)}`);
  }
  const allowed =
    (typeof target === "string" && STRING_METHODS.has(name)) ||
    (Array.isArray(target) && ARRAY_METHODS.has(name)) ||
    (typeof target === "number" && NUMBER_METHODS.has(name));
  if (!allowed) throw new Error(`${name}() is not available here`);
  const fn = (target as unknown as Record<string, unknown>)[name];
  if (typeof fn !== "function") throw new Error(`${name}() is not a function`);
  return (fn as (...a: unknown[]) => unknown).apply(target, args);
}

const MATH_FUNCTIONS = new Set([
  "abs",
  "ceil",
  "floor",
  "round",
  "max",
  "min",
  "pow",
  "sqrt",
  "trunc",
]);

function isEmpty(value: unknown): boolean {
  if (value === null || value === undefined || value === "") return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "object") return Object.keys(value as object).length === 0;
  return false;
}

function lengthOf(value: unknown): number {
  if (typeof value === "string" || Array.isArray(value)) return value.length;
  if (value && typeof value === "object") {
    const rows = (value as { rows?: unknown }).rows;
    if (Array.isArray(rows)) return rows.length;
    return Object.keys(value as object).length;
  }
  return 0;
}

/** Host objects and helpers reachable by name inside an expression. */
function globalsFor(ctx: ExprContext): Record<string, unknown> {
  const now = ctx.now ?? new Date();
  return {
    $json: ctx.$json,
    $node: ctx.$node,
    /** `$json.rows` shortcut — the common case is an infotable. */
    $rows: (ctx.$json as { rows?: unknown })?.rows ?? [],
    /** Bound only where a node tests one row at a time, e.g. Filter. */
    $item: ctx.$item,
    $index: ctx.$index ?? 0,
    $now: now.toISOString(),
    $today: now.toISOString().slice(0, 10),
    $timestamp: now.getTime(),
    Math: "Math",
    JSON: "JSON",
  };
}

type CallableName =
  | "$"
  | "$if"
  | "$default"
  | "$isEmpty"
  | "$len"
  | "$keys"
  | "$values"
  | "$pick"
  | "$uuid"
  | "Number"
  | "String"
  | "Boolean";

const CALLABLES = new Set<string>([
  "$",
  "$if",
  "$default",
  "$isEmpty",
  "$len",
  "$keys",
  "$values",
  "$pick",
  "$uuid",
  "Number",
  "String",
  "Boolean",
]);

/**
 * A subset of an infotable's rows, still an infotable.
 *
 * The DataShape is carried over, so a service that receives the result can map
 * the columns exactly as it would for the whole table — picking rows must not
 * degrade an INFOTABLE into a bare row object.
 */
function pickRows(source: unknown, indices: unknown[]): unknown {
  const table =
    source && typeof source === "object" && !Array.isArray(source)
      ? (source as { dataShape?: unknown; rows?: unknown })
      : undefined;
  const rows = Array.isArray(table?.rows)
    ? (table.rows as unknown[])
    : Array.isArray(source)
      ? source
      : [];

  // No indices means "every row" — the identity case, useful while wiring up.
  const flat = indices.flatMap((i) => (Array.isArray(i) ? (i as unknown[]) : [i]));
  const picked = flat.length
    ? flat.map((i) => rows[Number(i)]).filter((row) => row !== undefined)
    : rows;

  return table && table.dataShape !== undefined
    ? { dataShape: table.dataShape, rows: picked }
    : { rows: picked };
}

function callGlobal(name: CallableName, args: unknown[], ctx: ExprContext): unknown {
  switch (name) {
    case "$": {
      const label = String(args[0] ?? "");
      if (!(label in ctx.$node)) throw new Error(`No node named "${label}"`);
      return ctx.$node[label];
    }
    case "$if":
      return args[0] ? args[1] : args[2];
    case "$default":
      return isEmpty(args[0]) ? args[1] : args[0];
    case "$isEmpty":
      return isEmpty(args[0]);
    case "$len":
      return lengthOf(args[0]);
    case "$keys":
      return args[0] && typeof args[0] === "object" ? Object.keys(args[0] as object) : [];
    case "$values":
      return args[0] && typeof args[0] === "object" ? Object.values(args[0] as object) : [];
    case "$pick":
      return pickRows(args[0], args.slice(1));
    case "$uuid":
      return crypto.randomUUID();
    case "Number":
      return Number(args[0]);
    case "String":
      return args[0] === null || args[0] === undefined ? "" : String(args[0]);
    case "Boolean":
      return Boolean(args[0]);
  }
}

function evaluateNode(node: Node, ctx: ExprContext): unknown {
  switch (node.type) {
    case "literal":
      return node.value;

    case "ident": {
      const globals = globalsFor(ctx);
      if (node.name in globals) return globals[node.name];
      if (CALLABLES.has(node.name)) return { __call: node.name };
      throw new Error(`Unknown name "${node.name}"`);
    }

    case "array":
      return node.elements.map((e) => evaluateNode(e, ctx));

    case "object":
      return Object.fromEntries(
        node.properties.map((p) => [p.key, evaluateNode(p.value, ctx)])
      );

    case "unary": {
      const value = evaluateNode(node.argument, ctx);
      if (node.op === "!") return !value;
      if (node.op === "-") return -Number(value);
      return Number(value);
    }

    case "binary": {
      const left = evaluateNode(node.left, ctx) as never;
      const right = evaluateNode(node.right, ctx) as never;
      switch (node.op) {
        case "+":
          // Only a string operand means concatenation; everything else is maths.
          return typeof left === "string" || typeof right === "string"
            ? String(left) + String(right)
            : Number(left) + Number(right);
        case "-":
          return Number(left) - Number(right);
        case "*":
          return Number(left) * Number(right);
        case "/":
          return Number(left) / Number(right);
        case "%":
          return Number(left) % Number(right);
        case "<":
          return left < right;
        case ">":
          return left > right;
        case "<=":
          return left <= right;
        case ">=":
          return left >= right;
        case "==":
          return left == right;
        case "!=":
          return left != right;
        case "===":
          return left === right;
        case "!==":
          return left !== right;
        default:
          throw new Error(`Unsupported operator "${node.op}"`);
      }
    }

    case "logical": {
      const left = evaluateNode(node.left, ctx);
      if (node.op === "&&") return left ? evaluateNode(node.right, ctx) : left;
      if (node.op === "||") return left ? left : evaluateNode(node.right, ctx);
      return left === null || left === undefined ? evaluateNode(node.right, ctx) : left;
    }

    case "conditional":
      return evaluateNode(node.test, ctx)
        ? evaluateNode(node.consequent, ctx)
        : evaluateNode(node.alternate, ctx);

    case "member": {
      const object = evaluateNode(node.object, ctx);
      const key = node.computed
        ? String(evaluateNode(node.property, ctx))
        : String((node.property as { value: unknown }).value);
      if (BLOCKED_KEYS.has(key)) throw new Error(`"${key}" is not readable`);
      if (object === null || object === undefined) return undefined;
      // `Math` / `JSON` are carried as sentinel strings, not real host objects.
      if (object === "Math" && MATH_FUNCTIONS.has(key)) return { __call: `Math.${key}` };
      if (object === "JSON" && (key === "stringify" || key === "parse")) {
        return { __call: `JSON.${key}` };
      }
      if (typeof object === "string" || Array.isArray(object) || typeof object === "number") {
        if (key === "length") return (object as { length: number }).length;
        if (Array.isArray(object) && /^\d+$/.test(key)) return object[Number(key)];
        return { __method: key, __target: object };
      }
      if (typeof object !== "object") return undefined;
      const value = (object as Record<string, unknown>)[key];
      return value;
    }

    case "call": {
      const args = node.args.map((a) => evaluateNode(a, ctx));
      const callee = evaluateNode(node.callee, ctx) as
        | { __call?: string; __method?: string; __target?: unknown }
        | unknown;
      if (callee && typeof callee === "object" && "__method" in (callee as object)) {
        const bound = callee as { __method: string; __target: unknown };
        return callMethod(bound.__target, bound.__method, args);
      }
      if (callee && typeof callee === "object" && "__call" in (callee as object)) {
        const name = (callee as { __call: string }).__call;
        if (name.startsWith("Math.")) {
          const fn = Math[name.slice(5) as keyof Math] as (...a: number[]) => number;
          return fn(...(args as number[]));
        }
        if (name === "JSON.stringify") return JSON.stringify(args[0], null, args[1] ? 2 : 0);
        if (name === "JSON.parse") return JSON.parse(String(args[0]));
        return callGlobal(name as CallableName, args, ctx);
      }
      throw new Error("That value is not callable");
    }
  }
}

/** Evaluates one `{{ … }}` body. Throws on a parse or lookup failure. */
export function evaluateExpression(source: string, ctx: ExprContext): unknown {
  return evaluateNode(parse(source), ctx);
}

/**
 * Evaluates a whole field value.
 *
 * A field that is exactly one `{{ … }}` block returns the raw value, so an
 * infotable stays an infotable. Anything else is string interpolation.
 */
export function evaluateTemplate(raw: string, ctx: ExprContext): EvalResult {
  const text = raw ?? "";
  if (!isExpression(text)) return { value: text };

  const single = text.trim().match(/^\{\{([\s\S]*)\}\}$/);
  if (single && !single[1].includes("}}")) {
    try {
      return { value: evaluateExpression(single[1], ctx) };
    } catch (e) {
      return { value: undefined, error: e instanceof Error ? e.message : String(e) };
    }
  }

  let error: string | undefined;
  const value = text.replace(EXPR_RE, (_match, body: string) => {
    try {
      const part = evaluateExpression(body, ctx);
      if (part === null || part === undefined) return "";
      return typeof part === "object" ? JSON.stringify(part) : String(part);
    } catch (e) {
      error ??= e instanceof Error ? e.message : String(e);
      return "";
    }
  });
  return { value, error };
}

/** Node labels an expression addresses, so the runner can order them first. */
export function referencedNodes(raw: string): string[] {
  const out = new Set<string>();
  const patterns = [
    /\$node\s*\[\s*["'`]([^"'`]+)["'`]\s*\]/g,
    /\$\s*\(\s*["'`]([^"'`]+)["'`]\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of (raw ?? "").matchAll(pattern)) out.add(match[1]);
  }
  return [...out];
}

const PATH_IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * Append one step to a path expression — `$json` + `rows` → `$json.rows`, and
 * `$json.rows` + `0` → `$json.rows[0]`. Keys that are not plain identifiers are
 * written as a quoted index, so any DataShape field name survives the trip.
 */
export function joinPath(base: string, key: string | number, isIndex = false): string {
  if (isIndex || typeof key === "number") return `${base}[${key}]`;
  return PATH_IDENTIFIER.test(key) ? `${base}.${key}` : `${base}[${JSON.stringify(key)}]`;
}

/** Reference an upstream node's field the way the UI writes it. */
export function nodeRef(label: string, path = ""): string {
  const base = `$node[${JSON.stringify(label)}]`;
  return `{{ ${path ? `${base}${path.startsWith("[") ? "" : "."}${path}` : base} }}`;
}

/**
 * Expression yielding the chosen rows of an infotable, as an infotable. `table`
 * is whatever addresses it — `$json`, `$node["Fetch"]`, `$json.rows` and so on.
 */
export function pickExpression(table: string, indices: number[]): string {
  const base = table.endsWith(".rows") ? table.slice(0, -".rows".length) : table;
  return `$pick(${base}, [${[...indices].sort((a, b) => a - b).join(", ")}])`;
}

/** Helper entries shown in the expression hint popover. */
export const EXPRESSION_HELP: { snippet: string; hint: string }[] = [
  { snippet: "$json", hint: "Result of the node wired into this one" },
  { snippet: "$json.rows[0].name", hint: "First row of an incoming infotable" },
  { snippet: '$node["Label"]', hint: "Result of any upstream node, by title" },
  { snippet: '$("Label").rows', hint: "Same thing, shorter" },
  { snippet: "$rows", hint: "Shortcut for $json.rows" },
  { snippet: "$item.name", hint: "The row under test, inside a Filter" },
  { snippet: "$index", hint: "Position of that row" },
  {
    snippet: "$pick($json, [0, 3])",
    hint: "Chosen rows as an infotable, DataShape kept",
  },
  { snippet: "$now", hint: "ISO timestamp, fixed for the whole run" },
  { snippet: "$today", hint: "YYYY-MM-DD" },
  { snippet: "$if(cond, a, b)", hint: "Inline condition" },
  { snippet: "$default($json.name, 'none')", hint: "Fallback when empty" },
  { snippet: "$len($json.rows)", hint: "Row / string / array length" },
  { snippet: "JSON.stringify($json)", hint: "Serialise a value" },
];
