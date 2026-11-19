"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { IconPlayerPlay } from "@tabler/icons-react"
import { InfoTableView } from "@/components/assistant/rich/tool-views/infotable"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { errorMessage } from "@/lib/settings"
import { useAssistantAction, useAssistantContext } from "@/lib/assistant/context"
import { usePinnables } from "@/lib/assistant/pins"
import {
  getDataTableInfo,
  listDataTables,
  queryDataTable,
  type DataTableInfo,
  type QueryResult,
  type StreamInfo,
} from "@/lib/twx-admin"

/** The shape InfoTableView reads: declared columns in order, plus the rows. */
function asInfoTable(result: QueryResult) {
  return {
    dataShape: {
      fieldDefinitions: Object.fromEntries(
        result.columns.map((c, i) => [c.name, { name: c.name, baseType: c.baseType, ordinal: i }]),
      ),
    },
    // DATETIME values stay epoch ms: the grid shows them as dates but sorts and filters them as numbers.
    rows: result.rows,
  }
}

export function DataTablesTab({ env }: { env: string }) {
  const [tables, setTables] = useState<StreamInfo[] | null>(null)
  const [table, setTable] = useState("")
  const [info, setInfo] = useState<DataTableInfo | null>(null)
  const [search, setSearch] = useState("")
  const [query, setQuery] = useState("")
  const [advanced, setAdvanced] = useState(false)
  const [maxItems, setMaxItems] = useState("100")
  const [result, setResult] = useState<QueryResult | null>(null)
  const [error, setError] = useState("")
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    listDataTables(env)
      .then((list) => {
        setTables(list)
        const first = list.find((t) => !t.system) ?? list[0]
        if (first) setTable(first.name)
      })
      .catch((err) => setError(errorMessage(err)))
  }, [env])

  useEffect(() => {
    if (!table) return
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setInfo(null)
    setResult(null)
    let current = true
    getDataTableInfo(env, table)
      .then((i) => current && setInfo(i))
      .catch((err) => current && setError(errorMessage(err)))
    return () => {
      current = false
    }
  }, [env, table])

  function run(over?: { table?: string; search?: string; query?: string; maxItems?: number }) {
    const t = over?.table ?? table
    const q = over?.query ?? (advanced ? query : "")
    setLoading(true)
    setError("")
    return queryDataTable(env, {
      table: t,
      search: (over?.search ?? search).trim() || undefined,
      query: q.trim() ? q : undefined,
      maxItems: Math.min(5000, Math.max(1, over?.maxItems ?? (Number(maxItems) || 100))),
    })
      .then((r) => {
        setResult(r)
        return r
      })
      .catch((err) => {
        setResult(null)
        setError(errorMessage(err))
        throw err
      })
      .finally(() => setLoading(false))
  }

  const tablesRef = useRef(tables)
  useEffect(() => {
    tablesRef.current = tables
  })

  const rowsPreview = result?.rows.slice(0, 10).map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === "string" ? v.slice(0, 80) : v]))) ?? []
  useAssistantContext({
    screen: "twx-server",
    data: {
      datatables: {
        table,
        search,
        query: advanced ? query.slice(0, 500) : "",
        maxItems,
        entryCount: info?.entryCount ?? null,
        fields: info?.fields.map((f) => f.name).slice(0, 40),
        error,
        resultRows: result?.rows.length ?? null,
        columns: result?.columns.map((c) => c.name).slice(0, 40),
        rows: rowsPreview,
      },
    },
  })
  usePinnables(
    result && table
      ? [
          {
            kind: "datatable",
            label: `Data table · ${table}`,
            detail: `${result.rows.length} rows`,
            content: () => JSON.stringify({ table, search, columns: result.columns.map((c) => c.name), rows: result.rows.slice(0, 50) }).slice(0, 8000),
          },
        ]
      : [],
  )
  useAssistantAction(
    "select_datatable",
    {
      description:
        "On the Data tables tab, pick a data table and run a query. `search` is text or a name:val* expression; `query` an optional JSON query filter; maxItems defaults to 100. Shows the result on screen and returns a row summary.",
      inputSchema: {
        type: "object",
        properties: { table: { type: "string" }, search: { type: "string" }, query: { type: "string" }, maxItems: { type: "number" } },
        required: ["table"],
      },
    },
    async (args) => {
      const a = args as { table?: string; search?: string; query?: string; maxItems?: number }
      const name = String(a.table ?? "")
      for (let i = 0; i < 30 && !tablesRef.current; i++) await new Promise((r) => setTimeout(r, 100))
      if (!tablesRef.current?.some((t) => t.name === name)) throw new Error(`No data table "${name}" on ${env}.`)
      setTable(name)
      setSearch(a.search ?? "")
      if (a.query) {
        setQuery(a.query)
        setAdvanced(true)
      }
      const r = await run({ table: name, search: a.search ?? "", query: a.query ?? "", maxItems: a.maxItems })
      return { table: name, rows: r.rows.length, maybeMore: r.maybeMore, columns: r.columns.map((c) => c.name), sample: r.rows.slice(0, 5) }
    },
  )

  const value = useMemo(() => (result ? asInfoTable(result) : null), [result])
  const userTables = tables?.filter((t) => !t.system) ?? []
  const systemTables = tables?.filter((t) => t.system) ?? []

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-3 rounded-xl border bg-card p-3">
        <label className="flex flex-col gap-1 text-[11px] text-muted-foreground">
          Data table
          <NativeSelect value={table} onChange={(e) => setTable(e.target.value)}>
            {!tables && <NativeSelectOption value="">Loading...</NativeSelectOption>}
            {userTables.length > 0 && (
              <optgroup label="Data tables">
                {userTables.map((t) => (
                  <NativeSelectOption key={t.name} value={t.name}>
                    {t.name}
                  </NativeSelectOption>
                ))}
              </optgroup>
            )}
            {systemTables.length > 0 && (
              <optgroup label="System data tables">
                {systemTables.map((t) => (
                  <NativeSelectOption key={t.name} value={t.name}>
                    {t.name}
                  </NativeSelectOption>
                ))}
              </optgroup>
            )}
          </NativeSelect>
        </label>
        <label className="flex flex-col gap-1 text-[11px] text-muted-foreground">
          Search
          <Input
            className="w-56"
            placeholder="Text, or name:val* expression"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && table && !loading && void run().catch(() => {})}
          />
        </label>
        <label className="flex flex-col gap-1 text-[11px] text-muted-foreground">
          Max items
          <Input className="w-24" type="number" min={1} max={5000} value={maxItems} onChange={(e) => setMaxItems(e.target.value)} />
        </label>
        <label className="flex items-center gap-1.5 pb-1.5 text-xs">
          <input type="checkbox" checked={advanced} onChange={(e) => setAdvanced(e.target.checked)} /> Query filter (JSON)
        </label>
        <Button size="sm" onClick={() => void run().catch(() => {})} disabled={!table || loading}>
          <IconPlayerPlay /> {loading ? "Querying..." : "Query"}
        </Button>
        {advanced && (
          <textarea
            className="min-h-20 w-full rounded-lg border bg-background p-2 font-mono text-xs outline-none focus:border-ring"
            placeholder={'{"filters":{"type":"EQ","fieldName":"Name","value":"x"}}'}
            spellCheck={false}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        )}
      </div>

      {info && (
        <p className="text-xs text-muted-foreground">
          Data shape {info.dataShape ?? "-"} · {info.entryCount != null ? `${info.entryCount.toLocaleString()} entries` : "entries unknown"}
          {info.fields.length > 0 && <> · {info.fields.map((f) => `${f.name} (${f.baseType.toLowerCase()})`).join(", ")}</>}
        </p>
      )}

      {error && <p className="rounded-xl border border-red-500/40 bg-red-500/5 px-4 py-3 text-xs">{error}</p>}

      {result && value && (
        <>
          <p className="text-xs text-muted-foreground">
            {result.rows.length.toLocaleString()} rows
            {result.maybeMore && " (there may be more, raise Max items or narrow the search)"}
            {result.rows.length > 5000 && " · the table shows the first 5000"}
          </p>
          <InfoTableView value={value} id={`datatable:${table}`} maxHeight={520} pageSize={100} />
        </>
      )}
    </div>
  )
}
