"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { IconChevronRight, IconPlayerPlay } from "@tabler/icons-react";
import { cn } from "@/lib/utils";
import { twxServiceHref } from "@/lib/twx/links";
import { isRecord } from "../shared";
import { TypeBadge } from "./datashape";

type Param = {
  name: string;
  description?: string;
  baseType?: string;
  required: boolean;
  def?: string;
};
type Svc = {
  name: string;
  description?: string;
  category?: string;
  params: Param[];
  resultType?: string;
};

const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);

export function asServiceDefs(value: unknown): Svc[] | null {
  try {
    if (!Array.isArray(value) || !value.length) return null;
    const out: Svc[] = [];
    for (const s of value) {
      if (!isRecord(s) || typeof s.name !== "string") return null;
      const defs = Array.isArray(s.parameterDefinitions) ? s.parameterDefinitions : [];
      const params = defs.filter(isRecord).map((p, i) => {
        const a = isRecord(p.aspects) ? p.aspects : {};
        const d = a.defaultValue;
        return {
          name: str(p.name) ?? `param${i}`,
          description: str(p.description),
          baseType: str(p.baseType),
          required: a.isRequired === true,
          def: d === undefined || d === null ? undefined : typeof d === "object" ? JSON.stringify(d) : String(d),
          ord: typeof p.ordinal === "number" ? p.ordinal : i,
        };
      });
      params.sort((a, b) => a.ord - b.ord);
      out.push({
        name: s.name,
        description: str(s.description),
        category: str(s.category),
        params,
        resultType: isRecord(s.resultType) ? str(s.resultType.baseType) : undefined,
      });
    }
    return out;
  } catch {
    return null;
  }
}

const IRREGULAR: Record<string, string> = { Directory: "DirectoryServices" };

/** "Thing" -> "Things", "ThingTemplate" -> "ThingTemplates"; collections pass through. */
export function toCollection(type: string): string {
  const t = type.trim();
  if (!t) return "Things";
  if (IRREGULAR[t]) return IRREGULAR[t];
  if (t.endsWith("s")) return t;
  if (/[^aeiou]y$/i.test(t)) return t.slice(0, -1) + "ies";
  return t + "s";
}

function str2(v: unknown) {
  return typeof v === "string" ? v.trim() : "";
}

function SvcRow({ s, link }: { s: Svc; link: (s: Svc) => string | null }) {
  const [open, setOpen] = useState(false);
  const href = open ? link(s) : null;
  const defaults = s.params.filter((p) => p.def !== undefined);
  return (
    <li className="border-b border-border/50 last:border-0">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-label={`${open ? "Collapse" : "Expand"} ${s.name}`}
        className="flex w-full items-center gap-1.5 px-2 py-1 text-left hover:bg-muted/50"
      >
        <IconChevronRight className={cn("size-3 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} />
        <span className="font-mono text-[11px] font-medium">{s.name}</span>
        {s.category && (
          <span className="rounded bg-muted px-1 text-[9.5px] leading-4 text-muted-foreground">{s.category}</span>
        )}
        {s.resultType && (
          <span className="ml-auto flex items-center gap-1 text-[10.5px] text-muted-foreground">
            → <TypeBadge type={s.resultType} />
          </span>
        )}
      </button>
      {open && (
        <div className="space-y-1.5 px-2 pt-0.5 pb-2 pl-6 text-[11px]">
          {s.description && <p className="text-muted-foreground">{s.description}</p>}
          {s.params.length ? (
            <table className="w-full border-collapse">
              <thead className="text-left text-[10px] text-muted-foreground">
                <tr>
                  <th className="py-0.5 pr-2 font-medium">Parameter</th>
                  <th className="pr-2 font-medium">Type</th>
                  <th className="pr-2 font-medium">Default</th>
                  <th className="font-medium">Description</th>
                </tr>
              </thead>
              <tbody>
                {s.params.map((p) => (
                  <tr key={p.name} className="align-top">
                    <td className="py-0.5 pr-2 font-mono">
                      {p.name}
                      {p.required && (
                        <span className="ml-1 font-sans text-[9px] text-red-600 dark:text-red-400" title="Required">
                          required
                        </span>
                      )}
                    </td>
                    <td className="pr-2">
                      <TypeBadge type={p.baseType ?? ""} />
                    </td>
                    <td className="pr-2 font-mono text-[10.5px]">{p.def ?? ""}</td>
                    <td className="text-muted-foreground">{p.description}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="text-muted-foreground">No parameters.</div>
          )}
          {href && (
            <Link
              href={href}
              aria-label={`Run ${s.name} with these inputs`}
              className="inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10.5px] hover:bg-muted"
            >
              <IconPlayerPlay className="size-3" />
              Run with these inputs{defaults.length ? ` (${defaults.length} default${defaults.length > 1 ? "s" : ""})` : ""}
            </Link>
          )}
        </div>
      )}
    </li>
  );
}

export function ServiceSignatures({ value, input }: { value: unknown; input: unknown }) {
  const defs = useMemo(() => asServiceDefs(value), [value]);
  const [q, setQ] = useState("");
  if (!defs) return null;

  const inp = isRecord(input) ? input : {};
  const env = str2(inp.env);
  const type = toCollection(str2(inp.type) || str2(inp.collection));
  const entity = str2(inp.entityName) || str2(inp.entity);

  const link = (s: Svc): string | null => {
    if (!entity) return null;
    const inputs: Record<string, string> = {};
    for (const p of s.params) if (p.def !== undefined) inputs[p.name] = p.def;
    return twxServiceHref({ env, type, entity, service: s.name, inputs });
  };

  const needle = q.trim().toLowerCase();
  const shown = needle
    ? defs.filter((s) => s.name.toLowerCase().includes(needle) || (s.description ?? "").toLowerCase().includes(needle))
    : defs;

  return (
    <div className="rounded-md border bg-card text-[11px]">
      <div className="flex items-center gap-2 border-b px-2 py-1">
        <span className="text-muted-foreground">
          {needle ? `${shown.length} of ${defs.length}` : defs.length} services
          {entity && <> on <span className="font-mono">{entity}</span></>}
        </span>
        {defs.length > 6 && (
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search…"
            aria-label="Search services"
            className="h-5 w-32 rounded border bg-background px-1.5 text-[10.5px] outline-none focus:border-ring"
          />
        )}
      </div>
      <ul className="max-h-[26rem] overflow-auto">
        {shown.map((s) => (
          <SvcRow key={s.name} s={s} link={link} />
        ))}
        {!shown.length && <li className="px-2 py-3 text-center text-muted-foreground">No matches</li>}
      </ul>
    </div>
  );
}
