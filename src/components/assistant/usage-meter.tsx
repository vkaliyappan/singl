"use client";

// Token and cost meter: a compact one for the chat header and the "Usage"
// card in AI settings. Both reload when the backend reports `usageUpdated`.

import { DataGrid, type GridColumn } from "@/components/data-grid";
import { useEffect, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip as ChartTooltip,
  XAxis,
  YAxis,
} from "recharts";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  assistantUsageChat,
  assistantUsageSummary,
  onAssistantEvent,
  type UsageSummary,
  type UsageTotals,
} from "@/lib/assistant/api";
import { errorMessage } from "@/lib/settings";

const nf = new Intl.NumberFormat("en-US");

function tokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${Math.round(n / 1000)}k`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function dollars(n: number): string {
  if (n === 0) return "$0";
  return n < 0.01 ? "<$0.01" : `$${n.toFixed(n < 10 ? 2 : 1)}`;
}

/** Cost text, marked `+` when some calls are unpriced so it reads as a floor. */
function costText(t: UsageTotals): string {
  if (t.calls > 0 && t.unpricedCalls === t.calls) return "n/a";
  return dollars(t.costUsd) + (t.unpricedCalls > 0 ? "+" : "");
}

/** Reloads with `load` now and whenever the backend reports new usage. */
function useUsage<T>(load: () => Promise<T>, key: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (key === null) return;
    let alive = true;
    const run = () =>
      load().then(
        (d) => alive && (setData(d), setError("")),
        (e) => alive && setError(errorMessage(e)),
      );
    void run();
    const unlisten = onAssistantEvent((e) => {
      if (e.type === "usageUpdated") void run();
    });
    return () => {
      alive = false;
      void unlisten.then((u) => u());
    };
    // `load` is rebuilt every render; `key` says when it really changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return { data, error };
}

/** Header meter for one chat: tokens in/out and cost; the tooltip has the breakdown. */
export function UsageMeter({ chatId }: { chatId: string | null }) {
  const { data } = useUsage(
    () => assistantUsageChat(chatId ?? ""),
    chatId,
  );
  if (!chatId || !data || data.calls === 0) return null;
  const title = [
    `${nf.format(data.calls)} model call${data.calls === 1 ? "" : "s"} in this chat`,
    `Input: ${nf.format(data.input)}`,
    `Output: ${nf.format(data.output)}`,
    `Cache read: ${nf.format(data.cacheRead)}`,
    `Cache write: ${nf.format(data.cacheWrite)}`,
    `Cost: ${costText(data)}`,
    data.unpricedCalls > 0
      ? `${data.unpricedCalls} call${data.unpricedCalls === 1 ? "" : "s"} without a known price are not counted in the cost.`
      : "",
  ]
    .filter(Boolean)
    .join("\n");
  return (
    <span
      title={title}
      className="shrink-0 cursor-default rounded-md px-1.5 py-0.5 text-[10px] tabular-nums text-muted-foreground"
    >
      {tokens(data.input + data.cacheRead + data.cacheWrite)} in ·{" "}
      {tokens(data.output)} out · {costText(data)}
    </span>
  );
}

type ModelRow = UsageTotals & { provider: string; model: string };

const MODEL_COLUMNS: GridColumn<ModelRow>[] = [
  { key: "label", label: "Provider / model", kind: "text", width: 220, value: (m) => `${m.provider} / ${m.model || "default"}` },
  { key: "input", label: "In", kind: "number", width: 80, render: (m) => tokens(m.input) },
  { key: "output", label: "Out", kind: "number", width: 80, render: (m) => tokens(m.output) },
  {
    key: "cache",
    label: "Cache",
    kind: "number",
    width: 80,
    value: (m) => m.cacheRead + m.cacheWrite,
    render: (m) => tokens(m.cacheRead + m.cacheWrite),
  },
  { key: "cost", label: "Cost", kind: "number", width: 90, value: (m) => m.costUsd, render: (m) => costText(m) },
];

/** "Usage" card for AI settings: last 30 days by model, and a cost-by-day chart. */
export function UsageSettings() {
  const { data, error } = useUsage<UsageSummary>(
    () => assistantUsageSummary(30),
    "30",
  );
  const days = (data?.byDay ?? []).map((d) => ({
    day: d.day.slice(5),
    cost: Number(d.costUsd.toFixed(4)),
    tokens: d.input + d.output + d.cacheRead + d.cacheWrite,
  }));
  return (
    <Card className="gap-0 py-0">
      <CardHeader className="border-b px-3.5 py-2.5">
        <CardTitle className="text-xs font-semibold">Usage</CardTitle>
        <CardDescription className="text-[11px]">
          Tokens and cost of the assistant over the last 30 days. Cost is what
          the provider reported, else worked out from Anthropic list prices; a
          + means some calls have no known price (CLI agents other than Claude
          Code report none).
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 p-3.5 text-xs">
        {error && <p className="text-destructive">{error}</p>}
        {data && data.total.calls === 0 && (
          <p className="text-muted-foreground">No usage recorded yet.</p>
        )}
        {data && data.total.calls > 0 && (
          <>
            <p className="tabular-nums">
              <span className="font-medium">{costText(data.total)}</span> ·{" "}
              {tokens(data.total.input)} in · {tokens(data.total.output)} out ·{" "}
              {tokens(data.total.cacheRead + data.total.cacheWrite)} cached ·{" "}
              {nf.format(data.total.calls)} calls
            </p>
            <div className="h-32">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={days}>
                  <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" />
                  <XAxis dataKey="day" tick={{ fontSize: 10 }} stroke="var(--border)" />
                  <YAxis
                    tick={{ fontSize: 10 }}
                    stroke="var(--border)"
                    width={40}
                    tickFormatter={(v: number) => dollars(v)}
                  />
                  <ChartTooltip
                    formatter={(v, name) =>
                      name === "cost"
                        ? [dollars(Number(v)), "Cost"]
                        : [nf.format(Number(v)), "Tokens"]
                    }
                    contentStyle={{
                      background: "var(--popover)",
                      border: "1px solid var(--border)",
                      fontSize: 11,
                    }}
                  />
                  <Bar dataKey="cost" fill="var(--primary)" radius={[2, 2, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
            <DataGrid
              id="usage-by-model"
              columns={MODEL_COLUMNS}
              rows={data.byModel as ModelRow[]}
              rowKey={(m) => `${m.provider}/${m.model}`}
              searchable={false}
              pageSize={20}
              csvName="assistant-usage"
              initialSort={{ key: "cost", dir: "desc" }}
            />
          </>
        )}
      </CardContent>
    </Card>
  );
}
