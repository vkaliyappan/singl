"use client";

import { useEffect, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { readEntityFile } from "@/lib/entities";
import { errorMessage } from "@/lib/settings";
import { cn } from "@/lib/utils";
import { DiffView } from "./diff-view";
import { isRecord } from "./shared";

const DESTRUCTIVE = /delete|clean|force|overwrite|remove|purge|drop/i;

function Cell({ value }: { value: unknown }) {
  if (typeof value === "boolean")
    return (
      <span
        className={cn(
          "rounded px-1 text-[10px]",
          value ? "bg-primary/15 text-primary" : "bg-muted text-muted-foreground",
        )}
      >
        {String(value)}
      </span>
    );
  if (value === null || value === undefined) return <span className="text-muted-foreground">—</span>;
  let text: string;
  if (typeof value === "string") text = value;
  else {
    try {
      text = typeof value === "object" ? JSON.stringify(value) : String(value);
    } catch {
      text = String(value);
    }
  }
  return (
    <span className="font-mono text-[11px] break-all whitespace-pre-wrap">
      {text.length > 600 ? `${text.slice(0, 600)}…` : text}
    </span>
  );
}

export function KeyValueInput({ input }: { input: unknown }) {
  if (!isRecord(input)) {
    return input === undefined || input === null ? null : (
      <div className="my-2 rounded-md border bg-card p-2 text-xs">
        <Cell value={input} />
      </div>
    );
  }
  const entries = Object.entries(input);
  if (!entries.length) return null;
  return (
    <div className="my-2 overflow-hidden rounded-md border bg-card text-xs">
      <table className="w-full border-collapse">
        <tbody>
          {entries.map(([k, v]) => {
            const risky = DESTRUCTIVE.test(k) && v !== false && v !== null && v !== undefined;
            return (
              <tr key={k} className={cn("border-b align-top last:border-b-0", risky && "bg-destructive/10")}>
                <th
                  scope="row"
                  className={cn(
                    "w-px px-2 py-1 text-left text-[11px] font-medium whitespace-nowrap",
                    risky ? "text-destructive" : "text-muted-foreground",
                  )}
                >
                  {k}
                </th>
                <td className="px-2 py-1">
                  <Cell value={v} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

type State<T> = { key: string; value?: T; error?: string };

function useLoaded<T>(key: string, load: () => Promise<T>): State<T> | null {
  const [state, setState] = useState<State<T> | null>(null);
  useEffect(() => {
    let live = true;
    load().then(
      (value) => live && setState({ key, value }),
      (e) => live && setState({ key, error: errorMessage(e) }),
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return state && state.key === key ? state : null;
}

function Skeleton() {
  return <div className="my-2 h-16 animate-pulse rounded-md border bg-muted/50" aria-busy="true" />;
}

function ErrorBlock({ error, content, path }: { error: string; content: string; path?: string }) {
  return (
    <div className="my-2 rounded-md border bg-card p-2 text-xs">
      <div className="text-destructive">
        Could not read current file{path ? ` ${path}` : ""}: {error}
      </div>
      <div className="mt-1 text-[10.5px] text-muted-foreground">New content:</div>
      <pre className="max-h-60 overflow-auto font-mono text-[11px] whitespace-pre-wrap">{content}</pre>
    </div>
  );
}

function EntityWrite({ path, content }: { path: string; content: string }) {
  const s = useLoaded(path, () => readEntityFile(path));
  if (!s) return <Skeleton />;
  if (s.error !== undefined) {
    // A missing file is a new file, not a failure.
    if (/not.?found|no such file|cannot find|os error 2/i.test(s.error))
      return <DiffView original="" modified={content} path={path} />;
    return <ErrorBlock error={s.error} content={content} path={path} />;
  }
  return <DiffView original={s.value ?? ""} modified={content} path={path} />;
}

/**
 * entity_edit's result, as the backend computes it (tools/entities.rs
 * replace_passage): an LF passage also matches a CRLF file.
 */
function replacePassage(text: string, old: string, next: string, all: boolean): string {
  if (!old) throw new Error("old_string is empty.");
  if (!text.includes(old) && text.includes("\r\n") && !old.includes("\r")) {
    old = old.replace(/\n/g, "\r\n");
    next = next.replace(/\r\n/g, "\n").replace(/\n/g, "\r\n");
  }
  const n = text.split(old).length - 1;
  if (n === 0) throw new Error("old_string was not found in the file.");
  if (n > 1 && !all) throw new Error(`old_string occurs ${n} times.`);
  return all ? text.split(old).join(next) : text.replace(old, () => next);
}

function EntityEdit({ path, old, next, all }: { path: string; old: string; next: string; all: boolean }) {
  const s = useLoaded(path, () => readEntityFile(path));
  if (!s) return <Skeleton />;
  if (s.error !== undefined) return <ErrorBlock error={s.error} content={next} path={path} />;
  let modified: string;
  try {
    modified = replacePassage(s.value ?? "", old, next, all);
  } catch (e) {
    return <ErrorBlock error={errorMessage(e)} content={next} path={path} />;
  }
  return <DiffView original={s.value ?? ""} modified={modified} path={path} />;
}

function pretty(v: unknown): string {
  try {
    const o = typeof v === "string" ? JSON.parse(v) : v;
    return JSON.stringify(o, null, 2) ?? "";
  } catch {
    return typeof v === "string" ? v : "";
  }
}

function FlowSave({ id, graph }: { id: string; graph: unknown }) {
  const modified = pretty(graph);
  const s = useLoaded(id, () => invoke<{ graph?: unknown } | null>("flow_get", { id }));
  if (!s) return <Skeleton />;
  if (s.error !== undefined) return <ErrorBlock error={s.error} content={modified} />;
  if (!s.value) return <DiffView original="" modified={modified} path={`flow ${id}`} />;
  return <DiffView original={pretty(s.value.graph)} modified={modified} path={`flow ${id}`} />;
}

function SetPropertyValues({ input }: { input: Record<string, unknown> }) {
  const values = isRecord(input.values) ? input.values : {};
  return (
    <div className="my-2 flex flex-col gap-1.5">
      <div className="text-xs">
        Write to Thing <span className="font-medium">{String(input.thing ?? "")}</span>
        {typeof input.env === "string" && <span className="text-muted-foreground"> on {input.env}</span>}
      </div>
      <KeyValueInput input={values} />
    </div>
  );
}

function ImportFiles({ input }: { input: Record<string, unknown> }) {
  const files = Array.isArray(input.files) ? input.files.map(String) : [];
  return (
    <div className="my-2 flex flex-col gap-1.5">
      <div className="text-xs">
        {input.dryRun === true ? "Preview" : "Import"} {files.length} {files.length === 1 ? "file" : "files"}
        {typeof input.env === "string" && <span className="text-muted-foreground"> into {input.env}</span>}
      </div>
      <ul className="max-h-48 overflow-auto rounded-md border bg-card p-1.5 font-mono text-[11px]">
        {files.slice(0, 100).map((f) => (
          <li key={f} className="truncate" title={f}>
            {f}
          </li>
        ))}
        {files.length > 100 && <li className="text-muted-foreground">… and {files.length - 100} more</li>}
      </ul>
    </div>
  );
}

export function ApprovalPreview({ tool, input }: { tool: string; input: unknown }): ReactNode | null {
  if (isRecord(input)) {
    if (tool === "entity_write" && typeof input.path === "string" && typeof input.content === "string")
      return <EntityWrite path={input.path} content={input.content} />;
    if (
      tool === "entity_edit" &&
      typeof input.path === "string" &&
      typeof input.old_string === "string" &&
      typeof input.new_string === "string"
    )
      return (
        <EntityEdit
          path={input.path}
          old={input.old_string}
          next={input.new_string}
          all={input.replace_all === true}
        />
      );
    if (tool === "twx_set_property_values" && isRecord(input.values)) return <SetPropertyValues input={input} />;
    if (tool === "twx_import_entities" && Array.isArray(input.files)) return <ImportFiles input={input} />;
    if (tool === "flow_save" && typeof input.id === "string" && input.graph !== undefined)
      return <FlowSave id={input.id} graph={input.graph} />;
  }
  return <KeyValueInput input={input} />;
}
