"use client";

// Trigger-character mentions in the composer: `/` commands and skills,
// `@` files, `#` tools, `$` skills. useMentions holds the state and key
// handling; MentionPopup renders the list above the composer card.

import {
  useEffect,
  useId,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  type SyntheticEvent,
} from "react";
import { useRouter } from "next/navigation";
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
  type ApprovalMode,
  type FileHit,
  type ProviderInfo,
} from "@/lib/assistant/api";
import { pinPinnable, usePinnableList } from "@/lib/assistant/pins";
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
type Token = { trigger: Trigger; start: number; end: number; query: string };

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

/** The trigger token ending at the caret, or null. `/` only counts at the start. */
function findToken(text: string, caretPos: number): Token | null {
  const caret = Math.min(caretPos, text.length);
  let s = caret;
  while (s > 0 && !/\s/.test(text[s - 1])) s--;
  if (s >= caret) return null;
  const trigger = text[s] as Trigger;
  if (!TRIGGERS.includes(trigger)) return null;
  if (trigger === "/" && s !== 0) return null;
  return { trigger, start: s, end: caret, query: text.slice(s + 1, caret) };
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
  text,
  setText,
  inputRef,
  extras,
  providers,
  choice,
  onChoice,
  onNewChat,
  onOpenModel,
  onApproval,
}: {
  text: string;
  setText: (t: string) => void;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  extras: ComposerExtras;
  providers: ProviderInfo[];
  choice: ChatChoice | null;
  onChoice: (c: ChatChoice) => void;
  onNewChat: () => void;
  onOpenModel: () => void;
  onApproval: (m: ApprovalMode) => void;
}) {
  const router = useRouter();
  const pinnables = usePinnableList();
  const screen = useScreenContext().screen;
  const listId = useId();
  const [caret, setCaret] = useState(0);
  const [focused, setFocused] = useState(false);
  const [dismissed, setDismissed] = useState<number | null>(null);
  const [sub, setSub] = useState<"effort" | null>(null);
  const [index, setIndex] = useState(0);
  const [focusAt, setFocusAt] = useState<{ pos: number } | null>(null);
  const [files, setFiles] = useState<{ query: string; hits: FileHit[] } | null>(
    null,
  );

  const token = findToken(text, caret);
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

  useEffect(() => {
    const el = inputRef.current;
    if (!focusAt || !el) return;
    el.focus();
    el.setSelectionRange(focusAt.pos, focusAt.pos);
  }, [focusAt, inputRef]);

  const replace = (tok: Token, insert: string) => {
    const pos = tok.start + insert.length;
    setText(text.slice(0, tok.start) + insert + text.slice(tok.end));
    setCaret(pos);
    setFocusAt({ pos });
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
        ["ask", "Ask before changes (default)", () => onApproval("ask")],
        [
          "auto",
          "Auto-approve everything, deletes included",
          () => onApproval("auto"),
        ],
        [
          "readonly",
          "Read-only: no changes allowed",
          () => onApproval("readOnly"),
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

  const sync = (el: HTMLTextAreaElement) => {
    const pos = el.selectionStart ?? el.value.length;
    setCaret(pos);
    if (!findToken(el.value, pos)) setDismissed(null);
  };

  const pick = (i: number) => items[i]?.run();

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!open || e.nativeEvent.isComposing || e.keyCode === 229) return;
    const stop = () => {
      e.preventDefault();
      e.nativeEvent.stopImmediatePropagation();
    };
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (!items.length) return;
      stop();
      const d = e.key === "ArrowDown" ? 1 : -1;
      setIndex((active + d + items.length) % items.length);
    } else if (
      (e.key === "Enter" && !e.shiftKey) ||
      (e.key === "Tab" && !e.shiftKey)
    ) {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === "Tab" && !items.length) return;
      stop();
      if (active >= 0) pick(active);
    } else if (e.key === "Escape") {
      stop();
      if (sub) setSub(null);
      else if (token) setDismissed(token.start);
    }
  };

  const inputProps = {
    role: "combobox" as const,
    "aria-autocomplete": "list" as const,
    "aria-expanded": open,
    "aria-controls": open ? listId : undefined,
    "aria-activedescendant": open && active >= 0 ? optionId(active) : undefined,
    onChange: (e: ChangeEvent<HTMLTextAreaElement>) => {
      setText(e.target.value);
      setSub(null);
      setIndex(0);
      sync(e.target);
    },
    onSelect: (e: SyntheticEvent<HTMLTextAreaElement>) => sync(e.currentTarget),
    onFocus: () => setFocused(true),
    onBlur: () => {
      setFocused(false);
      setSub(null);
    },
    onKeyDown,
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
    inputProps,
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
