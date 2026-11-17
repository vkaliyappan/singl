"use client";

// Trigger-character mentions in the composer: `/` commands and skills,
// `@` files, `#` tools, `$` skills. useMentions holds the state and key
// handling; MentionPopup renders the list above the composer card.

import { useEffect, useId, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import type { Editor } from "@tiptap/react";
import {
  IconBook2,
  IconFile,
  IconFolder,
  IconTerminal2,
} from "@tabler/icons-react";
import { toast } from "sonner";
import { isTauri } from "@/lib/clock-widget";
import { cn } from "@/lib/utils";
import {
  assistantFilesSearch,
  type FileHit,
  type ProviderInfo,
} from "@/lib/assistant/api";
import { pinPinnable, usePinnableList } from "@/lib/assistant/pins";
import type { ApprovalModes } from "./approval-mode";
import { useScreenContext } from "@/lib/assistant/context";
import { PinIcon } from "./pin-icon";
import { groupOf, type ComposerExtras } from "./composer-extras";
import { effortLabel } from "./model-picker";
import { RiskBadge } from "./messages";
import type { ChatChoice } from "./use-assistant-chat";

export const MENTION_HINT = "/ commands · @ files · # tools · $ skills";

const MAX_ROWS = 50;
const TRIGGERS = ["/", "@", "#", "$"] as const;
type Trigger = (typeof TRIGGERS)[number];
/** `start`/`end` are editor document positions. */
type Token = { trigger: Trigger; start: number; end: number; query: string };

/** Where the caret is: the text before it in its paragraph, and its document position. */
type Caret = { before: string; pos: number; firstBlock: boolean };
const NO_CARET: Caret = { before: "", pos: 0, firstBlock: true };

function caretOf(editor: Editor): Caret {
  const { $from, empty } = editor.state.selection;
  // No popups inside code: `#include`, `$var`, `@Annotation` are just code there.
  const code = $from.parent.type.spec.code || $from.marks().some((m) => m.type.spec.code);
  if (!empty || !$from.parent.isTextblock || code) return { ...NO_CARET, pos: -1 };
  return {
    // Hard breaks count as one character, so lengths stay document positions.
    before: $from.parent.textBetween(0, $from.parentOffset, undefined, "\n"),
    pos: $from.pos,
    firstBlock: $from.before(1) === 0,
  };
}

type Item = {
  key: string;
  label: string;
  detail?: string;
  group?: string;
  mono?: boolean;
  icon?: ReactNode;
  badge?: ReactNode;
  run: () => void;
};

/** The trigger token ending at the caret, or null. `/` only counts at the very start. */
function findToken({ before, pos, firstBlock }: Caret): Token | null {
  if (pos < 0) return null;
  const caret = before.length;
  let s = caret;
  while (s > 0 && !/\s/.test(before[s - 1])) s--;
  if (s >= caret) return null;
  const trigger = before[s] as Trigger;
  if (!TRIGGERS.includes(trigger)) return null;
  if (trigger === "/" && (s !== 0 || !firstBlock)) return null;
  const start = pos - (caret - s);
  return { trigger, start, end: pos, query: before.slice(s + 1) };
}

/** Prefix matches first, then substring on the name, then on the description. */
function filterBy<T>(
  list: T[],
  q: string,
  get: (t: T) => [name: string, description?: string],
): T[] {
  if (!q) return list;
  const ranked: [number, T][] = [];
  for (const t of list) {
    const [name, desc = ""] = get(t);
    const n = name.toLowerCase();
    const r = n.startsWith(q)
      ? 0
      : n.includes(q)
        ? 1
        : desc.toLowerCase().includes(q)
          ? 2
          : -1;
    if (r >= 0) ranked.push([r, t]);
  }
  return ranked.sort((a, b) => a[0] - b[0]).map(([, t]) => t);
}

export function useMentions({
  editor,
  extras,
  providers,
  choice,
  onChoice,
  onNewChat,
  onOpenModel,
  onApproval,
}: {
  editor: Editor | null;
  extras: ComposerExtras;
  providers: ProviderInfo[];
  choice: ChatChoice | null;
  onChoice: (c: ChatChoice) => void;
  onNewChat: () => void;
  onOpenModel: () => void;
  onApproval: (m: ApprovalModes) => void;
}) {
  const router = useRouter();
  const pinnables = usePinnableList();
  const screen = useScreenContext().screen;
  const listId = useId();
  const [caret, setCaret] = useState<Caret>(NO_CARET);
  const [focused, setFocused] = useState(false);
  const [dismissed, setDismissed] = useState<number | null>(null);
  const [sub, setSub] = useState<"effort" | null>(null);
  const [index, setIndex] = useState(0);
  const [files, setFiles] = useState<{ query: string; hits: FileHit[] } | null>(
    null,
  );

  const token = findToken(caret);
  const tokenOpen = !!token && dismissed !== token.start && focused;
  const trigger = tokenOpen ? token.trigger : null;
  const fileQuery = trigger === "@" ? token!.query : null;
  const needSkills = trigger === "/" || trigger === "$";
  const { skillList, loadSkills } = extras;

  useEffect(() => {
    if (needSkills && skillList === null && isTauri()) loadSkills();
  }, [needSkills, skillList, loadSkills]);

  useEffect(() => {
    if (fileQuery === null || !isTauri()) return;
    let cancelled = false;
    const t = setTimeout(() => {
      assistantFilesSearch(fileQuery)
        .then((hits) => !cancelled && setFiles({ query: fileQuery, hits }))
        .catch(() => !cancelled && setFiles({ query: fileQuery, hits: [] }));
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [fileQuery]);

  // Plain text: going through the content parser would turn `#tool` into a heading.
  const replace = (tok: Token, insert: string) => {
    if (!editor) return;
    editor.view.dispatch(editor.state.tr.insertText(insert, tok.start, tok.end));
    editor.commands.focus();
  };

  const q = token?.query.toLowerCase() ?? "";
  const skillItems = (prefix: string, tok: Token): Item[] =>
    filterBy(skillList ?? [], q, (s) => [s.name, s.description]).map((s) => ({
      key: `skill:${s.id}`,
      label: `${prefix}${s.name}`,
      detail: s.description,
      icon: <IconBook2 className="size-3.5 text-primary" />,
      run: () => {
        replace(tok, "");
        if (!extras.skillIds.includes(s.id)) extras.toggleSkill(s.id);
      },
    }));

  let items: Item[] = [];
  let empty = "";
  const efforts = providers.find((p) => p.id === choice?.provider)?.efforts;

  if (sub === "effort" && choice && efforts) {
    items = ["", ...efforts].map((e) => ({
      key: `effort:${e}`,
      label: e ? effortLabel(e) : "Default",
      detail: (choice.effort ?? "") === e ? "current" : undefined,
      run: () => {
        setSub(null);
        onChoice({ ...choice, effort: e });
      },
    }));
  } else if (tokenOpen && token) {
    if (token.trigger === "/") {
      const commands: [string, string, () => void][] = [
        ["new", "Start a new chat", onNewChat],
        ["clear", "Clear this chat (same as /new)", onNewChat],
        ["model", "Change provider or model", onOpenModel],
        [
          "effort",
          "Set reasoning effort",
          () => {
            if (efforts?.length) setSub("effort");
            else toast.error("This provider has no effort levels.");
          },
        ],
        ["ask", "Ask before changes (default)", () => onApproval({ local: "ask", server: "ask" })],
        [
          "auto",
          "Auto-approve everything, deletes included",
          () => onApproval({ local: "auto", server: "auto" }),
        ],
        [
          "auto-local",
          "Auto in singl, ask before ThingWorx server changes",
          () => onApproval({ local: "auto", server: "ask" }),
        ],
        [
          "readonly",
          "Read-only: no changes allowed",
          () => onApproval({ local: "readOnly", server: "readOnly" }),
        ],
        [
          "readonly-twx",
          "Auto in singl, ThingWorx server read-only",
          () => onApproval({ local: "auto", server: "readOnly" }),
        ],
        ["tools", "Choose which tools are enabled", () => extras.show("tools")],
        ["skills", "Pick skills for this message", () => extras.show("skills")],
        ["attach", "Attach files…", () => void extras.attachFiles()],
        ["attach-folder", "Attach folder…", () => void extras.attachFolders()],
        ["history", "Open chat history", () => router.push("/assistant")],
      ];
      items = [
        ...filterBy(commands, q, (c) => [c[0]]).map(
          ([name, detail, run]): Item => ({
            key: `cmd:${name}`,
            label: `/${name}`,
            detail,
            group: "Commands",
            icon: <IconTerminal2 className="size-3.5 text-muted-foreground" />,
            run: () => {
              replace(token, "");
              run();
            },
          }),
        ),
        ...skillItems("/", token).map((i) => ({ ...i, group: "Skills" })),
      ].slice(0, MAX_ROWS);
      empty = "No matching commands";
    } else if (token.trigger === "$") {
      items = skillItems("$", token).slice(0, MAX_ROWS);
      empty = skillList === null ? "Loading…" : "No matching skills";
    } else if (token.trigger === "#") {
      items = filterBy(extras.toolList, q, (t) => [t.name, t.description])
        .slice(0, MAX_ROWS)
        .map((t) => ({
          key: `tool:${t.name}`,
          label: t.name,
          detail: t.description,
          group: groupOf(t.name).label,
          mono: true,
          badge: <RiskBadge risk={t.risk} />,
          run: () => {
            replace(token, `#${t.name} `);
            if (extras.disabled.has(t.name)) {
              const next = new Set(extras.disabled);
              next.delete(t.name);
              extras.setDisabledTools(next);
            }
          },
        }));
      empty = "No matching tools";
    } else {
      const loaded = files?.query === token.query;
      const pinItems: Item[] = filterBy(pinnables, q, (p) => [
        p.label,
        p.kind,
      ])
        .slice(0, 10)
        .map((p) => ({
          key: `pin:${p.kind}:${p.label}`,
          label: p.label,
          detail: p.detail ?? p.kind,
          group: "On this screen",
          icon: <PinIcon kind={p.kind} className="size-3.5 text-primary" />,
          run: () => {
            replace(token, "");
            pinPinnable(p, screen);
          },
        }));
      const fileItems: Item[] = (files?.hits ?? [])
        .slice(0, MAX_ROWS)
        .map((f) => ({
        group: pinItems.length ? "Files" : undefined,
        key: `file:${f.path}`,
        label: f.isDir ? `${f.name}/` : f.name,
        detail: f.relative,
        icon: f.isDir ? (
          <IconFolder className="size-3.5 text-muted-foreground" />
        ) : (
          <IconFile className="size-3.5 text-muted-foreground" />
        ),
        run: () => {
          replace(token, "");
          extras.addAttachments([f.path], f.isDir);
        },
      }));
      items = [...pinItems, ...fileItems];
      empty = !loaded && !pinItems.length
        ? "Searching…"
        : token.query === ""
          ? "No workspace folder set"
          : "No matching files";
    }
  }

  // Command, tool and skill lists vanish when nothing matches so a plain
  // "/etc" or "$5" message still sends on Enter. File search keeps its empty state.
  const open =
    sub === "effort"
      ? items.length > 0
      : tokenOpen && (items.length > 0 || trigger === "@");
  const active = items.length ? Math.min(index, items.length - 1) : -1;
  const optionId = (i: number) => `${listId}-opt-${i}`;

  useEffect(() => {
    if (open && active >= 0)
      document
        .getElementById(`${listId}-opt-${active}`)
        ?.scrollIntoView({ block: "nearest" });
  }, [open, active, listId]);

  // Follow the editor: caret moves, edits, focus.
  useEffect(() => {
    if (!editor) return;
    const sync = () => {
      const c = caretOf(editor);
      setCaret(c);
      if (!findToken(c)) setDismissed(null);
    };
    const onUpdate = () => {
      setSub(null);
      setIndex(0);
      sync();
    };
    const onFocus = () => {
      setFocused(true);
      sync();
    };
    const onBlur = () => {
      setFocused(false);
      setSub(null);
    };
    editor.on("update", onUpdate);
    editor.on("selectionUpdate", sync);
    editor.on("focus", onFocus);
    editor.on("blur", onBlur);
    return () => {
      editor.off("update", onUpdate);
      editor.off("selectionUpdate", sync);
      editor.off("focus", onFocus);
      editor.off("blur", onBlur);
    };
  }, [editor]);

  // The editor is the combobox for screen readers.
  useEffect(() => {
    const el = editor?.view.dom;
    if (!el) return;
    const attrs: Record<string, string | undefined> = {
      role: "combobox",
      "aria-autocomplete": "list",
      "aria-expanded": String(open),
      "aria-controls": open ? listId : undefined,
      "aria-activedescendant": open && active >= 0 ? optionId(active) : undefined,
    };
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined) el.removeAttribute(k);
      else el.setAttribute(k, v);
    }
  });

  const pick = (i: number) => items[i]?.run();

  /** True when the popup took the key. */
  const onKeyDown = (e: KeyboardEvent): boolean => {
    if (!open || e.isComposing || e.keyCode === 229) return false;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (!items.length) return false;
      const d = e.key === "ArrowDown" ? 1 : -1;
      setIndex((active + d + items.length) % items.length);
      return true;
    }
    if ((e.key === "Enter" || e.key === "Tab") && !e.shiftKey) {
      if (e.ctrlKey || e.metaKey || e.altKey) return false;
      if (e.key === "Tab" && !items.length) return false;
      if (active >= 0) pick(active);
      return true;
    }
    if (e.key === "Escape") {
      if (sub) setSub(null);
      else if (token) setDismissed(token.start);
      return true;
    }
    return false;
  };

  return {
    open,
    listId,
    optionId,
    items,
    active,
    empty,
    label:
      sub === "effort"
        ? "Reasoning effort"
        : (
            {
              "/": "Commands",
              "@": "Files",
              "#": "Tools",
              $: "Skills",
            } as const
          )[trigger ?? "/"],
    setIndex,
    pick,
    onKeyDown,
  };
}

export type Mentions = ReturnType<typeof useMentions>;

/** The list, anchored above the composer card (its parent must be `relative`). */
export function MentionPopup({ m }: { m: Mentions }) {
  if (!m.open) return null;
  return (
    <div
      className="absolute inset-x-0 bottom-full z-30 mb-1.5 max-h-72 overflow-y-auto rounded-xl border bg-popover p-1 text-popover-foreground shadow-md"
      onMouseDown={(e) => e.preventDefault()}
    >
      <div role="listbox" id={m.listId} aria-label={m.label}>
        {m.items.length === 0 && (
          <p className="px-2 py-3 text-center text-[11px] text-muted-foreground">
            {m.empty}
          </p>
        )}
        {m.items.map((it, i) => {
          const heading =
            it.group !== m.items[i - 1]?.group ? it.group : undefined;
          return (
            <div key={it.key}>
              {heading && (
                <div
                  role="presentation"
                  className="px-2 pt-1.5 pb-0.5 text-[10px] font-medium tracking-wide text-muted-foreground uppercase"
                >
                  {heading}
                </div>
              )}
              <div
                id={m.optionId(i)}
                role="option"
                aria-selected={i === m.active}
                onClick={() => m.pick(i)}
                onMouseMove={() => i !== m.active && m.setIndex(i)}
                className={cn(
                  "flex min-h-7 cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-xs",
                  i === m.active && "bg-accent text-accent-foreground",
                )}
              >
                {it.icon}
                <span
                  className={cn(
                    "shrink-0 truncate",
                    it.mono
                      ? "max-w-[60%] font-mono text-[11px]"
                      : "max-w-[50%]",
                  )}
                >
                  {it.label}
                </span>
                {it.detail && (
                  <span className="min-w-0 flex-1 truncate text-[10.5px] text-muted-foreground">
                    {it.detail}
                  </span>
                )}
                {it.badge}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
