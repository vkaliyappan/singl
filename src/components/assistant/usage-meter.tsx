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
import { Button } from "@/components/ui/button";
import {
  assistantUsageCalls,
  assistantUsageChat,
  assistantUsageSummary,
  onAssistantEvent,
  type CallUsage,
  type ChatUsage,
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

/** Everything the model read for a call: new input plus cache reads and writes. */
const readOf = (t: { input: number; cacheRead: number; cacheWrite: number }) =>
  t.input + t.cacheRead + t.cacheWrite;

const when = (secs: number) =>
  new Date(secs * 1000).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

const CHAT_COLUMNS: GridColumn<ChatUsage>[] = [
  {
    key: "title",
    label: "Chat",
    kind: "text",
    width: 240,
    value: (c) => c.title ?? "(deleted chat)",
  },
  { key: "calls", label: "Calls", kind: "number", width: 70 },
  { key: "read", label: "Read", kind: "number", width: 80, value: readOf, render: (c) => tokens(readOf(c)) },
  { key: "output", label: "Out", kind: "number", width: 70, render: (c) => tokens(c.output) },
  { key: "cost", label: "Cost", kind: "number", width: 80, value: (c) => c.costUsd, render: (c) => costText(c) },
  { key: "lastAt", label: "Last used", kind: "number", width: 130, render: (c) => when(c.lastAt) },
];

const CALL_COLUMNS: GridColumn<CallUsage & { n: number }>[] = [
  { key: "n", label: "#", kind: "number", width: 50 },
  { key: "createdAt", label: "Time", kind: "number", width: 130, render: (c) => when(c.createdAt) },
  { key: "model", label: "Model", kind: "text", width: 160, value: (c) => c.model || c.provider },
  { key: "read", label: "Read", kind: "number", width: 80, value: readOf, render: (c) => tokens(readOf(c)) },
  { key: "cacheWrite", label: "Cache write", kind: "number", width: 90, render: (c) => tokens(c.cacheWrite) },
  { key: "output", label: "Out", kind: "number", width: 70, render: (c) => tokens(c.output) },
  {
    key: "cost",
    label: "Cost",
    kind: "number",
    width: 80,
    value: (c) => c.costUsd ?? 0,
    render: (c) => (c.costUsd == null ? "n/a" : dollars(c.costUsd)),
  },
];

/** One chat's calls: how much the model read each time, and what each cost. */
function ChatCalls({ chat, onClose }: { chat: ChatUsage; onClose: () => void }) {
  const { data, error } = useUsage<CallUsage[]>(
    () => assistantUsageCalls(chat.chatId),
    chat.chatId,
  );
  const rows = (data ?? []).map((c, i) => ({ ...c, n: i + 1 }));
  const bars = rows.map((c) => ({ n: c.n, read: readOf(c), cost: c.costUsd ?? 0 }));
  return (
    <div className="space-y-2 rounded-md border p-2.5">
      <div className="flex items-center gap-2">
        <p className="min-w-0 flex-1 truncate font-medium">
          {chat.title ?? "(deleted chat)"}
        </p>
        <Button variant="ghost" size="sm" className="h-6 px-2 text-[11px]" onClick={onClose}>
          Close
        </Button>
      </div>
      <p className="text-[11px] text-muted-foreground">
        Tokens the model read for each message. Every message re-reads the
        whole chat so far, so the bars grow as a chat gets longer; a new chat
        starts small again.
      </p>
      {error && <p className="text-destructive">{error}</p>}
      {rows.length > 0 && (
        <>
          <div className="h-28">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={bars}>
                <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" />
                <XAxis dataKey="n" tick={{ fontSize: 10 }} stroke="var(--border)" />
                <YAxis
                  tick={{ fontSize: 10 }}
                  stroke="var(--border)"
                  width={40}
                  tickFormatter={(v: number) => tokens(v)}
                />
                <ChartTooltip
                  formatter={(v, name) =>
                    name === "read"
                      ? [nf.format(Number(v)), "Tokens read"]
                      : [dollars(Number(v)), "Cost"]
                  }
                  labelFormatter={(n) => `Message ${n}`}
                  contentStyle={{
                    background: "var(--popover)",
                    border: "1px solid var(--border)",
                    fontSize: 11,
                  }}
                />
                <Bar dataKey="read" fill="var(--primary)" radius={[2, 2, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
          <DataGrid
            id="usage-chat-calls"
            columns={CALL_COLUMNS}
            rows={rows}
            rowKey={(c) => String(c.id)}
            searchable={false}
            pageSize={20}
            csvName="assistant-usage-chat"
            initialSort={{ key: "n", dir: "asc" }}
          />
        </>
      )}
    </div>
  );
}

/** "Usage" card for AI settings: last 30 days by model, a cost-by-day chart, and the costliest chats. */
export function UsageSettings() {
  const { data, error } = useUsage<UsageSummary>(
    () => assistantUsageSummary(30),
    "30",
  );
  const [openChat, setOpenChat] = useState<string | null>(null);
  const selected = data?.byChat.find((c) => c.chatId === openChat) ?? null;
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
          Tokens and cost of the assistant over the last 30 days. Claude models
          (API and Claude Code) are priced from their tokens at Anthropic list
          prices; OpenRouter cost is what it reported. A + means some calls
          have no known price (Codex and other CLI agents report none).
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
            <div className="space-y-1.5">
              <p className="font-medium">Costliest chats</p>
              <p className="text-[11px] text-muted-foreground">
                Click a chat to see what each of its messages read and cost.
              </p>
              <DataGrid
                id="usage-by-chat"
                columns={CHAT_COLUMNS}
                rows={data.byChat}
                rowKey={(c) => c.chatId}
                searchable={data.byChat.length > 10}
                pageSize={10}
                csvName="assistant-usage-chats"
                initialSort={{ key: "cost", dir: "desc" }}
                onRowClick={(c) => setOpenChat((cur) => (cur === c.chatId ? null : c.chatId))}
                rowClassName={(c) => (c.chatId === openChat ? "bg-accent" : undefined)}
              />
            </div>
            {selected && <ChatCalls chat={selected} onClose={() => setOpenChat(null)} />}
          </>
        )}
      </CardContent>
    </Card>
  );
}
