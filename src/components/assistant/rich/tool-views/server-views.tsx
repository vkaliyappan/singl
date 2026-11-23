"use client";

// Chat views for the server-admin, access, import, dependency, automation and
// undo tools. Each `as*` guard returns null on an unexpected shape so the
// caller falls back to raw JSON.

import { useMemo, type ReactNode } from "react";
import dynamic from "next/dynamic";
import { IconCheck, IconShieldCheck, IconX } from "@tabler/icons-react";
import { cn } from "@/lib/utils";
import { DataGrid, type GridColumn } from "@/components/data-grid";
import { formatBytes, formatDuration } from "@/lib/twx-admin";
import { mermaidSource, type DepGraph } from "@/lib/deps";
import { isRecord } from "../shared";
import { InfoTableView } from "./infotable";

const MermaidBlock = dynamic(() => import("../mermaid-block").then((m) => m.MermaidBlock), {
  ssr: false,
  loading: () => <div className="my-2 h-24 animate-pulse rounded-md border bg-muted/40" />,
});

type Row = Record<string, unknown>;

const str = (v: unknown) => (typeof v === "string" ? v : v == null ? "" : String(v));
const rowsOf = (v: unknown): Row[] | null => (Array.isArray(v) && v.every(isRecord) ? (v as Row[]) : null);

function Grid<T>({ id, columns, rows, maxHeight = 340 }: { id: string; columns: GridColumn<T>[]; rows: T[]; maxHeight?: number }) {
  return (
    <div className="my-1">
      <DataGrid id={`chat-${id}`} columns={columns} rows={rows} maxHeight={maxHeight} pageSize={25} searchable={rows.length > 10} csvName={id} />
    </div>
  );
}

function Pill({ tone, children }: { tone: "ok" | "bad" | "warn" | "info" | "muted"; children: ReactNode }) {
  const t = {
    ok: "bg-success/15 text-success",
    bad: "bg-destructive/15 text-destructive",
    warn: "bg-warning/15 text-warning",
    info: "bg-info/15 text-info",
    muted: "bg-muted text-muted-foreground",
  }[tone];
  return <span className={cn("inline-flex h-5 items-center rounded px-1.5 text-[10px] font-semibold whitespace-nowrap", t)}>{children}</span>;
}

function Caption({ children }: { children: ReactNode }) {
  return <p className="mb-1 text-[11px] text-muted-foreground">{children}</p>;
}

// ---- logs ----

const LEVEL_TONE: Record<string, "bad" | "warn" | "info" | "muted"> = { ERROR: "bad", WARN: "warn", INFO: "info" };

const time = (ms: number) => {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

export function asLogRows(v: unknown) {
  const rows = rowsOf(v);
  return rows && rows.every((r) => "timestamp" in r && "message" in r) ? rows : null;
}

export function LogsView({ rows }: { rows: Row[] }) {
  const columns: GridColumn<Row>[] = [
    { key: "timestamp", label: "Time", kind: "date", width: 120, render: (r) => <span className="font-mono text-[11px] whitespace-nowrap">{typeof r.timestamp === "number" ? time(r.timestamp) : str(r.timestamp)}</span> },
    { key: "level", label: "Level", kind: "text", width: 80, render: (r) => <Pill tone={LEVEL_TONE[str(r.level)] ?? "muted"}>{str(r.level) || "?"}</Pill> },
    { key: "message", label: "Message", kind: "text", width: 420, render: (r) => <span className="font-mono text-[11px]">{str(r.message).split("\n")[0]}</span> },
    { key: "origin", label: "Origin", kind: "text", width: 160 },
    { key: "user", label: "User", kind: "text", width: 100, hidden: true },
  ];
  return (
    <>
      <Caption>{rows.length} log {rows.length === 1 ? "entry" : "entries"}</Caption>
      <Grid id="logs" columns={columns} rows={rows} maxHeight={380} />
    </>
  );
}

// ---- stream / datatable results ----

export function asQueryResult(v: unknown) {
  if (!isRecord(v) || !Array.isArray(v.columns) || !Array.isArray(v.rows)) return null;
  return v.columns.every((c) => isRecord(c) && typeof c.name === "string") && v.rows.every(isRecord) ? v : null;
}

export function QueryResultView({ value, id }: { value: Row; id: string }) {
  const table = useMemo(
    () => ({
      dataShape: {
        fieldDefinitions: Object.fromEntries(
          (value.columns as Row[]).map((c, i) => [str(c.name), { name: str(c.name), baseType: str(c.baseType), ordinal: i }]),
        ),
      },
      rows: value.rows,
    }),
    [value],
  );
  const n = (value.rows as unknown[]).length;
  return (
    <>
      <Caption>
        {value.source ? `${str(value.source)}: ` : ""}
        {n} {n === 1 ? "row" : "rows"}
        {value.maybeMore ? " (there may be more)" : ""}
      </Caption>
      {n > 0 && <InfoTableView value={table} id={id} />}
    </>
  );
}

// ---- lists ----

export function StreamListView({ value }: { value: Row }) {
  const kind = (list: unknown, label: string) =>
    (rowsOf(list) ?? []).map((r) => ({ name: str(r.name), description: str(r.description), kind: label, system: !!r.system }));
  const rows = [...kind(value.streams, "Stream"), ...kind(value.valueStreams, "Value stream")];
  const columns: GridColumn<(typeof rows)[number]>[] = [
    { key: "name", label: "Name", kind: "text", width: 260 },
    { key: "kind", label: "Kind", kind: "text", width: 110 },
    { key: "description", label: "Description", kind: "text", width: 300 },
    { key: "system", label: "System", kind: "boolean", width: 80 },
  ];
  return <Grid id="streams" columns={columns} rows={rows} />;
}

export function NamedListView({ rows, id }: { rows: Row[]; id: string }) {
  const columns: GridColumn<Row>[] = [
    { key: "name", label: "Name", kind: "text", width: 280 },
    { key: "description", label: "Description", kind: "text", width: 320 },
    { key: "system", label: "System", kind: "boolean", width: 80 },
  ];
  return <Grid id={id} columns={columns} rows={rows} />;
}

export function ConnectorsView({ rows }: { rows: Row[] }) {
  const columns: GridColumn<Row>[] = [
    { key: "name", label: "Name", kind: "text", width: 240 },
    { key: "kind", label: "Type", kind: "text", width: 110 },
    { key: "enabled", label: "Enabled", kind: "text", width: 90, value: (r) => (r.enabled === false ? "No" : r.enabled === true ? "Yes" : "?"), render: (r) => <Pill tone={r.enabled === false ? "warn" : "ok"}>{r.enabled === false ? "Off" : "On"}</Pill> },
    { key: "baseUrl", label: "Endpoint", kind: "text", width: 300 },
    { key: "authType", label: "Auth", kind: "text", width: 100 },
  ];
  return <Grid id="connectors" columns={columns} rows={rows} />;
}

export function SubscriptionsView({ rows }: { rows: Row[] }) {
  const columns: GridColumn<Row>[] = [
    { key: "name", label: "Subscription", kind: "text", width: 240 },
    { key: "enabled", label: "Enabled", kind: "text", width: 90, value: (r) => (r.enabled ? "Yes" : "No"), render: (r) => <Pill tone={r.enabled ? "ok" : "muted"}>{r.enabled ? "On" : "Off"}</Pill> },
    { key: "owner", label: "Owner", kind: "text", width: 220 },
    { key: "inherited", label: "Inherited", kind: "boolean", width: 90 },
    {
      key: "events",
      label: "Listens to",
      kind: "text",
      width: 280,
      value: (r) =>
        (rowsOf(r.events) ?? []).map((e) => `${str(e.source)}.${str(e.eventName)}`).join(", "),
    },
  ];
  return <Grid id="subscriptions" columns={columns} rows={rows} />;
}

export function SchedulersView({ rows }: { rows: Row[] }) {
  const columns: GridColumn<Row>[] = [
    { key: "name", label: "Thing", kind: "text", width: 280 },
    { key: "template", label: "Template", kind: "text", width: 100 },
    { key: "enabled", label: "Enabled", kind: "text", width: 90, value: (r) => (r.enabled === null ? "?" : r.enabled ? "Yes" : "No"), render: (r) => (r.enabled === null ? <Pill tone="muted">?</Pill> : <Pill tone={r.enabled ? "ok" : "muted"}>{r.enabled ? "On" : "Off"}</Pill>) },
    { key: "schedule", label: "Schedule", kind: "text", width: 200, value: (r) => (r.schedule ? str(r.schedule) : typeof r.intervalMs === "number" ? `every ${formatDuration(r.intervalMs)}` : "") },
    { key: "event", label: "Event", kind: "text", width: 120 },
  ];
  return <Grid id="schedulers" columns={columns} rows={rows} />;
}

// ---- health ----

function Tile({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: "ok" | "bad" | "warn" }) {
  const border = tone === "bad" ? "border-destructive/50 bg-destructive/5" : tone === "warn" ? "border-warning/50 bg-warning/5" : tone === "ok" ? "border-success/40 bg-success/5" : "bg-background/50";
  return (
    <div className={cn("min-w-0 rounded-md border px-2.5 py-1.5", border)}>
      <div className="text-[10.5px] text-muted-foreground">{label}</div>
      <div className="truncate text-sm font-semibold">{value}</div>
      {sub && <div className="truncate text-[10.5px] text-muted-foreground">{sub}</div>}
    </div>
  );
}

const num = (v: unknown) => (typeof v === "number" ? v.toLocaleString() : "-");

export function asHealth(v: unknown) {
  return isRecord(v) && isRecord(v.ping) && isRecord(v.health) ? { ping: v.ping, health: v.health } : null;
}

export function HealthView({ ping, health }: { ping: Row; health: Row }) {
  const p = isRecord(health.platform) ? health.platform : {};
  const c = isRecord(health.counts) ? health.counts : {};
  const subs = rowsOf(health.subsystems) ?? [];
  const down = subs.filter((s) => s.running === false);
  const errors = Array.isArray(health.errors) ? health.errors.map(str) : [];
  const queue = Math.max(Number(p.eventQueue) || 0, Number(p.streamQueue) || 0, Number(p.valueStreamQueue) || 0);
  const up = ping.ok === true;
  return (
    <div className="my-1 flex flex-col gap-2">
      <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
        <Tile label="Status" value={up ? "Up" : "Down"} sub={typeof ping.latencyMs === "number" ? `${ping.latencyMs} ms` : undefined} tone={up ? "ok" : "bad"} />
        <Tile label="Version" value={str(p.softwareVersion) || "-"} sub={str(p.build) || undefined} />
        <Tile label="Uptime" value={typeof p.uptimeMs === "number" ? formatDuration(p.uptimeMs) : "-"} />
        <Tile
          label="Memory"
          value={typeof p.memoryUsed === "number" ? formatBytes(p.memoryUsed) : "-"}
          sub={typeof p.memoryTotal === "number" ? `of ${formatBytes(p.memoryTotal)} allocated` : undefined}
        />
        <Tile label="Queue" value={num(queue)} sub="longest of event/stream" tone={queue > 1000 ? "warn" : undefined} />
        <Tile label="Things" value={num(c.things)} sub={typeof c.connectedThings === "number" ? `${num(c.connectedThings)} connected` : undefined} />
        <Tile label="Subsystems" value={subs.length ? `${subs.length - down.length} of ${subs.length} running` : "-"} tone={down.length ? "bad" : subs.length ? "ok" : undefined} />
        <Tile label="License" value={typeof p.licenseDaysLeft === "number" ? `${p.licenseDaysLeft} days left` : "-"} sub={p.licenseEvaluation ? "evaluation" : undefined} />
      </div>
      {typeof ping.error === "string" && ping.error && <p className="text-xs text-destructive">{ping.error}</p>}
      {errors.length > 0 && <p className="text-xs text-warning">{errors.join("; ")}</p>}
      {subs.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {subs.map((s) => (
            <span key={str(s.name)} title={str(s.description)} className="inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10.5px]">
              <span className={cn("size-1.5 rounded-full", s.running ? "bg-success" : "bg-destructive")} />
              {str(s.name)}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

// ---- permissions ----

export function asPermissions(v: unknown) {
  return isRecord(v) && rowsOf(v.runTime) && rowsOf(v.designTime) && rowsOf(v.visibility) ? v : null;
}

export function PermissionsView({ value }: { value: Row }) {
  const rows = (["runTime", "designTime", "visibility"] as const).flatMap((section) =>
    (rowsOf(value[section]) ?? []).map((r) => ({ section: { runTime: "Run time", designTime: "Design time", visibility: "Visibility" }[section], ...r })),
  );
  const columns: GridColumn<Row>[] = [
    { key: "section", label: "Section", kind: "text", width: 100 },
    { key: "resource", label: "Applies to", kind: "text", width: 160, value: (r) => (r.resource === "*" ? "Inherited" : str(r.resource)) },
    { key: "action", label: "Action", kind: "text", width: 130 },
    { key: "principal", label: "Principal", kind: "text", width: 200, value: (r) => `${str(r.principal)} (${str(r.kind)})` },
    { key: "permitted", label: "Access", kind: "text", width: 80, value: (r) => (r.permitted ? "Allow" : "Deny"), render: (r) => <Pill tone={r.permitted ? "ok" : "bad"}>{r.permitted ? "Allow" : "Deny"}</Pill> },
  ];
  return (
    <>
      <Caption>
        {str(value.entityType)}:{str(value.name)} · {rows.length} rules
      </Caption>
      <Grid id="permissions" columns={columns} rows={rows} />
    </>
  );
}

export function asDecision(v: unknown) {
  return isRecord(v) && typeof v.allowed === "boolean" && typeof v.explanation === "string" ? v : null;
}

export function VerdictView({ value }: { value: Row }) {
  const allowed = value.allowed === true;
  const groups = Array.isArray(value.userGroups) ? value.userGroups.map(str) : [];
  return (
    <div className={cn("my-1 flex flex-col gap-1 rounded-md border p-2.5", allowed ? "border-success/30 bg-success/10" : "border-destructive/30 bg-destructive/10")}>
      <div className={cn("flex items-center gap-1.5 text-sm font-semibold", allowed ? "text-success" : "text-destructive")}>
        {allowed ? <IconShieldCheck className="size-4" /> : <IconX className="size-4" />}
        {allowed ? "Allowed" : "Denied"}
        <span className="text-xs font-normal text-muted-foreground">
          {str(value.user)} · {str(value.action)}
          {value.member ? ` · ${str(value.member)}` : ""}
        </span>
      </div>
      <p className="text-xs">{str(value.explanation)}</p>
      {groups.length > 0 && <p className="text-[11px] text-muted-foreground">Groups: {groups.join(", ")}</p>}
    </div>
  );
}

// ---- import ----

const IMPORT_TONE: Record<string, "ok" | "bad" | "warn" | "info" | "muted"> = { new: "info", changed: "warn", unchanged: "muted", error: "bad" };

export function asImportItems(v: unknown) {
  const rows = rowsOf(v);
  return rows && rows.every((r) => typeof r.path === "string" && typeof r.status === "string") ? rows : null;
}

export function ImportItemsView({ items, note }: { items: Row[]; note?: string }) {
  const count = (s: string) => items.filter((i) => i.status === s).length;
  return (
    <div className="my-1 flex flex-col gap-1.5">
      <Caption>
        {note ? `${note} · ` : ""}
        {count("new")} new, {count("changed")} changed, {count("unchanged")} unchanged{count("error") ? `, ${count("error")} errors` : ""}
      </Caption>
      <div className="flex flex-col divide-y rounded-md border text-xs">
        {items.map((i) => (
          <div key={str(i.path)} className="px-2.5 py-1.5">
            <div className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate font-medium" title={str(i.path)}>
                {str(i.name) || str(i.path).split("/").pop()}
                {i.type ? <span className="ml-1.5 font-normal text-muted-foreground">{str(i.type)}</span> : null}
              </span>
              <Pill tone={IMPORT_TONE[str(i.status)] ?? "muted"}>{{ new: "New", changed: "Changed", unchanged: "Unchanged", error: "Error" }[str(i.status)] ?? str(i.status)}</Pill>
            </div>
            {i.error ? <p className="text-destructive">{str(i.error)}</p> : null}
          </div>
        ))}
      </div>
    </div>
  );
}

export function ImportResultView({ env, result }: { env: string; result: Row }) {
  const results = rowsOf(result.results) ?? [];
  const failed = results.filter((r) => !r.ok).length;
  return (
    <div className="my-1 flex flex-col gap-1.5">
      <Caption>
        {env ? `${env}: ` : ""}
        {results.length - failed} imported{failed ? `, ${failed} failed` : ""} · backed up {num(result.backedUp)} to {str(result.backupDir)}
      </Caption>
      <div className="flex flex-col divide-y rounded-md border text-xs">
        {results.map((r) => (
          <div key={str(r.path)} className="flex items-start gap-2 px-2.5 py-1.5">
            <Pill tone={r.ok ? "ok" : "bad"}>{r.ok ? "Imported" : "Failed"}</Pill>
            <div className="min-w-0 flex-1">
              <p className="truncate">{str(r.path).split("/").pop()}</p>
              {r.error ? <p className="text-destructive">{str(r.error)}</p> : null}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---- dependencies ----

export function asDepGraph(v: unknown): DepGraph | null {
  if (!isRecord(v) || typeof v.center !== "string" || !rowsOf(v.nodes) || !rowsOf(v.edges)) return null;
  return v as unknown as DepGraph;
}

export function DepGraphView({ graph }: { graph: DepGraph }) {
  const source = useMemo(() => mermaidSource(graph).source, [graph]);
  const centre = graph.nodes[0];
  const byKey = new Map(graph.nodes.map((n) => [n.key, n]));
  const side = (mine: "from" | "to") => {
    const other = mine === "from" ? "to" : "from";
    const groups = new Map<string, Set<string>>();
    for (const e of graph.edges) {
      if (e[mine] !== graph.center) continue;
      const n = byKey.get(e[other]);
      if (!n) continue;
      const s = groups.get(`${n.type}:${n.name}`) ?? new Set<string>();
      s.add(e.member ? `${e.kind}(${e.member})` : e.kind);
      groups.set(`${n.type}:${n.name}`, s);
    }
    return [...groups];
  };
  const uses = side("from");
  const usedBy = side("to");
  const list = (title: string, items: [string, Set<string>][]) =>
    items.length > 0 && (
      <div className="min-w-0 flex-1">
        <div className="mb-0.5 text-[11px] font-medium">
          {title} <span className="text-muted-foreground">({items.length})</span>
        </div>
        <ul className="max-h-40 overflow-auto text-[11px]">
          {items.slice(0, 40).map(([n, kinds]) => (
            <li key={n} className="truncate" title={`${n} · ${[...kinds].join(", ")}`}>
              {n} <span className="text-muted-foreground">{[...kinds].slice(0, 4).join(", ")}</span>
            </li>
          ))}
        </ul>
      </div>
    );
  return (
    <div className="my-1 flex flex-col gap-1.5">
      <Caption>
        {centre ? `${centre.type}:${centre.name} · ` : ""}
        {graph.nodes.length} entities, {graph.edges.length} references{graph.truncated ? " (truncated)" : ""}
      </Caption>
      {source && <MermaidBlock source={source} />}
      <div className="flex flex-wrap gap-3">
        {list("Uses", uses)}
        {list("Used by", usedBy)}
      </div>
    </div>
  );
}

export function asDepNodes(v: unknown) {
  return isRecord(v) && rowsOf(v.nodes) && typeof v.total === "number" ? v : null;
}

export function UnusedView({ value }: { value: Row }) {
  const rows = rowsOf(value.nodes) ?? [];
  const columns: GridColumn<Row>[] = [
    { key: "name", label: "Entity", kind: "text", width: 300 },
    { key: "type", label: "Type", kind: "text", width: 130 },
    { key: "file", label: "File", kind: "text", width: 300, hidden: true },
  ];
  return (
    <>
      <Caption>
        {rows.length} of {num(value.total)} unreferenced entities
      </Caption>
      <Grid id="unused" columns={columns} rows={rows} />
    </>
  );
}

export function asCallers(v: unknown) {
  return isRecord(v) && isRecord(v.entity) && typeof v.service === "string" && rowsOf(v.callers) ? v : null;
}

export function CallersView({ value }: { value: Row }) {
  const rows = (rowsOf(value.callers) ?? []).map((c) => ({
    caller: isRecord(c.caller) ? `${str(c.caller.type)}:${str(c.caller.name)}` : "",
    fromMember: str(c.fromMember),
    kind: str(c.kind),
    via: str(c.via),
  }));
  const columns: GridColumn<(typeof rows)[number]>[] = [
    { key: "caller", label: "Caller", kind: "text", width: 300 },
    { key: "fromMember", label: "From service", kind: "text", width: 160 },
    { key: "kind", label: "Kind", kind: "text", width: 90 },
    { key: "via", label: "Via", kind: "text", width: 200 },
  ];
  return (
    <>
      <Caption>
        {rows.length} callers of {isRecord(value.entity) ? str(value.entity.name) : ""}.{str(value.service)}
      </Caption>
      <Grid id="callers" columns={columns} rows={rows} />
    </>
  );
}

// ---- automation ----

export function asSuiteRun(v: unknown) {
  return isRecord(v) && typeof v.total === "number" && typeof v.passed === "number" && rowsOf(v.results) ? v : null;
}

export function SuiteRunView({ value }: { value: Row }) {
  const rows = rowsOf(value.results) ?? [];
  const failed = rows.filter((r) => !r.passed).length;
  const columns: GridColumn<Row>[] = [
    { key: "passed", label: "Result", kind: "text", width: 80, value: (r) => (r.passed ? "Pass" : "Fail"), render: (r) => (r.passed ? <IconCheck className="size-4 text-success" aria-label="passed" /> : <IconX className="size-4 text-destructive" aria-label="failed" />) },
    { key: "case", label: "Case", kind: "text", width: 220 },
    { key: "env", label: "Env", kind: "text", width: 100 },
    { key: "durationMs", label: "Time", kind: "number", width: 80, render: (r) => (typeof r.durationMs === "number" ? (r.durationMs < 1000 ? `${r.durationMs} ms` : `${(r.durationMs / 1000).toFixed(1)} s`) : "") },
    {
      key: "detail",
      label: "Detail",
      kind: "text",
      width: 360,
      truncate: false,
      value: (r) => str(r.error) || (rowsOf(r.failedChecks) ?? []).map((k) => `${str(k.label)}: expected ${str(k.expected)}, got ${str(k.actual)}`).join("; "),
    },
  ];
  return (
    <>
      <Caption>
        <span className={cn("font-medium", failed ? "text-destructive" : "text-success")}>
          {num(value.passed)}/{num(value.total)} passed
        </span>
        {value.suite ? ` · ${str(value.suite)}` : ""}
        {Array.isArray(value.envs) ? ` · ${value.envs.map(str).join(", ")}` : ""}
      </Caption>
      <Grid id="suite-run" columns={columns} rows={rows} />
    </>
  );
}

export function asDrift(v: unknown) {
  return isRecord(v) && isRecord(v.onlyInA) && isRecord(v.onlyInB) && isRecord(v.different) && typeof v.summary === "string" ? v : null;
}

export function DriftView({ value }: { value: Row }) {
  const group = (key: string, title: string, tone: string) => {
    const g = value[key] as Row;
    const shown = Array.isArray(g.shown) ? g.shown.map(str) : [];
    return { key, title, tone, count: Number(g.count) || 0, shown, truncated: g.truncated === true };
  };
  const groups = [
    group("onlyInA", "Only in A", "text-warning"),
    group("onlyInB", "Only in B", "text-warning"),
    group("different", "Different", "text-destructive"),
  ];
  const stat = (label: string, n: unknown, tone = "") => (
    <div className="min-w-24 rounded-md border bg-background/50 px-2.5 py-1.5">
      <div className={cn("text-base font-semibold", tone)}>{num(n)}</div>
      <div className="text-[10.5px] text-muted-foreground">{label}</div>
    </div>
  );
  const warnings = Array.isArray(value.warnings) ? value.warnings.map(str) : [];
  return (
    <div className="my-1 flex flex-col gap-2">
      <Caption>{str(value.summary)}</Caption>
      <div className="flex flex-wrap gap-1.5">
        {groups.map((g) => stat(g.title, g.count, g.tone))}
        {stat("Same", value.same, "text-success")}
        {Number(value.notCompared) > 0 && stat("Not compared", value.notCompared)}
      </div>
      {groups.map(
        (g) =>
          g.count > 0 && (
            <details key={g.key} open={g.key === "different"} className="rounded-md border text-xs">
              <summary className="cursor-pointer px-2.5 py-1.5 font-medium">
                {g.title} <span className="text-muted-foreground">({g.count})</span>
              </summary>
              <ul className="max-h-48 overflow-auto border-t px-2.5 py-1.5 text-[11px]">
                {g.shown.map((n) => (
                  <li key={n} className="truncate" title={n}>
                    {n}
                  </li>
                ))}
                {g.truncated && <li className="text-muted-foreground">… and {g.count - g.shown.length} more</li>}
              </ul>
            </details>
          ),
      )}
      {warnings.length > 0 && <p className="text-[11px] text-warning">{warnings.length} warnings, e.g. {warnings[0]}</p>}
    </div>
  );
}

// ---- undo ----

export function asUndoList(v: unknown) {
  const rows = rowsOf(v);
  return rows && rows.length && rows.every((r) => typeof r.callId === "string" && Array.isArray(r.paths)) ? rows : null;
}

export function UndoListView({ rows }: { rows: Row[] }) {
  const columns: GridColumn<Row>[] = [
    { key: "createdAt", label: "When", kind: "date", width: 150, render: (r) => <span className="whitespace-nowrap">{typeof r.createdAt === "number" ? new Date(r.createdAt < 1e12 ? r.createdAt * 1000 : r.createdAt).toLocaleString() : ""}</span> },
    { key: "tool", label: "Tool", kind: "text", width: 160 },
    { key: "paths", label: "Paths", kind: "text", width: 380, truncate: false, value: (r) => (Array.isArray(r.paths) ? r.paths.map(str).join("\n") : "") },
    { key: "callId", label: "Call id", kind: "text", width: 160, hidden: true },
  ];
  return (
    <>
      <Caption>{rows.length} undoable change{rows.length === 1 ? "" : "s"}</Caption>
      <Grid id="undo" columns={columns} rows={rows} />
    </>
  );
}
