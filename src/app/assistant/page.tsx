"use client";

// Full-page assistant: the chat list on the left (search titles and message
// text, rename, delete, select several, copy as Markdown) and the same
// conversation the side panel shows on the right. Both share the dock's chat
// state, so a chat opened here is the one the panel shows elsewhere.

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  IconCheck,
  IconCopy,
  IconListCheck,
  IconLoader2,
  IconMessagePlus,
  IconPencil,
  IconSearch,
  IconTrash,
  IconX,
} from "@tabler/icons-react";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { useDockChat } from "@/components/assistant/dock";
import { AssistantPanel, relativeTime } from "@/components/assistant/panel";
import { isTauri } from "@/lib/clock-widget";
import { errorMessage } from "@/lib/settings";
import { cn } from "@/lib/utils";
import { Spinner } from "@/components/ui/spinner";
import { useAssistantContext } from "@/lib/assistant/context";
import {
  assistantChatDelete,
  assistantChatGet,
  assistantChatRename,
  assistantChatsSearch,
  type Chat,
  type ChatSummary,
} from "@/lib/assistant/api";

const GROUPS = [
  "Today",
  "Yesterday",
  "Previous 7 days",
  "Previous 30 days",
  "Older",
] as const;

function groupOf(seconds: number | null | undefined): (typeof GROUPS)[number] {
  if (!seconds) return "Older";
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const today = startOfToday.getTime() / 1000;
  const day = 86400;
  if (seconds >= today) return "Today";
  if (seconds >= today - day) return "Yesterday";
  if (seconds >= today - 7 * day) return "Previous 7 days";
  if (seconds >= today - 30 * day) return "Previous 30 days";
  return "Older";
}

/** A chat as Markdown, for pasting into notes, tickets or docs. */
function chatToMarkdown(chat: Chat) {
  const out: string[] = [`# ${chat.title}`, ""];
  for (const m of chat.messages) {
    if (m.role === "user" && m.blocks.every((b) => b.type === "tool_result")) {
      for (const b of m.blocks) {
        if (b.type !== "tool_result") continue;
        const full = b.display ?? b.content;
        const body = full.length > 2000 ? `${full.slice(0, 2000)}…` : full;
        out.push(
          `<details><summary>${b.is_error ? "Tool error" : "Tool result"}</summary>`,
          "",
          "```",
          body,
          "```",
          "",
          "</details>",
          "",
        );
      }
      continue;
    }
    const who =
      m.role === "user"
        ? "You"
        : `Assistant${m.provider ? ` (${m.provider}${m.model ? ` · ${m.model}` : ""})` : ""}`;
    out.push(`## ${who}`, "");
    for (const b of m.blocks) {
      if (b.type === "text" && b.text.trim()) out.push(b.text, "");
      if (b.type === "tool_use")
        out.push(
          `> Tool \`${b.name}\``,
          "",
          "```json",
          JSON.stringify(b.input, null, 2),
          "```",
          "",
        );
    }
  }
  return out.join("\n");
}

function ChatRow({
  c,
  active,
  running,
  selecting,
  selected,
  onToggle,
  onOpen,
  onRename,
  onCopy,
  onDelete,
}: {
  c: ChatSummary;
  active: boolean;
  running: boolean;
  selecting: boolean;
  selected: boolean;
  onToggle: () => void;
  onOpen: () => void;
  onRename: (title: string) => Promise<void>;
  onCopy: () => void;
  onDelete: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(c.title);
  const commit = async () => {
    setEditing(false);
    const title = draft.trim();
    if (title && title !== c.title) await onRename(title);
  };

  return (
    <li
      className={cn(
        "group/row flex items-center gap-1.5 rounded-md px-2 py-1.5 hover:bg-accent",
        active && "bg-accent",
        selected && "bg-primary/10",
      )}
    >
      {selecting && (
        <Checkbox
          checked={selected}
          onCheckedChange={onToggle}
          aria-label={`Select ${c.title}`}
        />
      )}
      {editing ? (
        <>
          <Input
            autoFocus
            value={draft}
            aria-label="Chat title"
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => void commit()}
            onKeyDown={(e) => {
              if (e.key === "Enter") void commit();
              if (e.key === "Escape") setEditing(false);
            }}
            className="h-6 flex-1"
          />
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Save name"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => void commit()}
          >
            <IconCheck />
          </Button>
        </>
      ) : (
        <>
          <button
            type="button"
            className="min-w-0 flex-1 text-left"
            onClick={selecting ? onToggle : onOpen}
          >
            <span className="flex items-center gap-1">
              {running && (
                <IconLoader2
                  className="size-3 shrink-0 animate-spin text-primary"
                  aria-label="Answering"
                />
              )}
              <span className="truncate text-xs">{c.title || "Untitled"}</span>
            </span>
            <span className="block text-[10px] text-muted-foreground">
              {relativeTime(c.updatedAt ?? c.createdAt)} · {c.messageCount}{" "}
              messages
            </span>
          </button>
          {!selecting && (
            <div className="flex opacity-0 group-hover/row:opacity-100 focus-within:opacity-100">
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={`Rename ${c.title}`}
                title="Rename"
                onClick={() => {
                  setDraft(c.title);
                  setEditing(true);
                }}
              >
                <IconPencil />
              </Button>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={`Copy ${c.title} as Markdown`}
                title="Copy as Markdown"
                onClick={onCopy}
              >
                <IconCopy />
              </Button>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={`Delete ${c.title}`}
                title="Delete"
                onClick={onDelete}
              >
                <IconTrash />
              </Button>
            </div>
          )}
        </>
      )}
    </li>
  );
}

export default function AssistantPage() {
  const chat = useDockChat();
  const [chats, setChats] = useState<ChatSummary[] | null>(null);
  const [query, setQuery] = useState("");
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirm, setConfirm] = useState<string[] | null>(null);
  const [error, setError] = useState("");

  useAssistantContext({
    screen: "assistant",
    title: "AI Assistant",
    summary: chats
      ? `${chats.length} chats${chat.title ? `; open: ${chat.title}` : ""}`
      : undefined,
  });

  const load = useCallback(async (q: string) => {
    try {
      setChats(await assistantChatsSearch(q));
    } catch (e) {
      setError(errorMessage(e));
    }
  }, []);

  // Search runs on the backend (titles and message text), debounced while typing.
  const { chatsVersion } = chat;
  useEffect(() => {
    if (!isTauri()) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setError(
        "The assistant runs in the desktop app. Open Singl through Tauri to use it.",
      );
      return;
    }
    const t = setTimeout(() => void load(query), query ? 250 : 0);
    return () => clearTimeout(t);
  }, [query, chatsVersion, load]);

  const grouped = useMemo(() => {
    const map = new Map<string, ChatSummary[]>();
    for (const c of chats ?? []) {
      const g = groupOf(c.updatedAt ?? c.createdAt);
      map.set(g, [...(map.get(g) ?? []), c]);
    }
    return GROUPS.filter((g) => map.has(g)).map(
      (g) => [g, map.get(g)!] as const,
    );
  }, [chats]);

  const toggle = (id: string) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const stopSelecting = () => {
    setSelecting(false);
    setSelected(new Set());
  };

  const rename = async (id: string, title: string) => {
    try {
      await assistantChatRename(id, title);
      if (id === chat.chatId) chat.setTitle(title);
      await load(query);
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  const copy = async (ids: string[]) => {
    try {
      const full = await Promise.all(ids.map((id) => assistantChatGet(id)));
      await navigator.clipboard.writeText(
        full.map(chatToMarkdown).join("\n\n---\n\n"),
      );
      toast.success(
        ids.length === 1
          ? "Chat copied as Markdown"
          : `${ids.length} chats copied as Markdown`,
      );
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  const remove = async (ids: string[]) => {
    setConfirm(null);
    const failed: string[] = [];
    for (const id of ids) {
      try {
        await assistantChatDelete(id);
        if (id === chat.chatId) chat.newChat();
        else chat.dropQueue(id);
      } catch (e) {
        failed.push(errorMessage(e));
      }
    }
    if (failed.length)
      toast.error(`${failed.length} could not be deleted: ${failed[0]}`);
    else
      toast.success(
        ids.length === 1 ? "Chat deleted" : `${ids.length} chats deleted`,
      );
    stopSelecting();
    await load(query);
  };

  if (error) {
    return (
      <div className="p-8">
        <p className="rounded-xl border bg-card px-4 py-3.5 text-xs text-muted-foreground">
          {error}
        </p>
      </div>
    );
  }

  const visibleIds = (chats ?? []).map((c) => c.id);
  const allSelected =
    visibleIds.length > 0 && visibleIds.every((id) => selected.has(id));

  return (
    <div className="flex h-full min-h-0">
      <aside
        className="flex w-72 shrink-0 flex-col border-r"
        aria-label="Chat history"
      >
        <div className="flex h-10 shrink-0 items-center gap-1 border-b px-2.5">
          <span className="flex-1 text-xs font-medium">
            Chats
            {chats ? (
              <span className="ml-1 text-muted-foreground">{chats.length}</span>
            ) : null}
          </span>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Select chats"
            aria-pressed={selecting}
            title="Select several"
            className={cn(selecting && "bg-accent")}
            onClick={() => (selecting ? stopSelecting() : setSelecting(true))}
          >
            <IconListCheck />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="New chat"
            title="New chat"
            onClick={chat.newChat}
          >
            <IconMessagePlus />
          </Button>
        </div>

        <div className="relative shrink-0 border-b p-2">
          <IconSearch className="pointer-events-none absolute top-1/2 left-4 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search titles and messages"
            aria-label="Search chats"
            className="h-7 pr-7 pl-7"
          />
          {query && (
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Clear search"
              className="absolute top-1/2 right-3.5 -translate-y-1/2"
              onClick={() => setQuery("")}
            >
              <IconX />
            </Button>
          )}
        </div>

        {selecting && (
          <div className="flex shrink-0 items-center gap-1 border-b bg-muted/30 px-2 py-1.5">
            <Checkbox
              checked={allSelected}
              onCheckedChange={() =>
                setSelected(allSelected ? new Set() : new Set(visibleIds))
              }
              aria-label="Select all"
            />
            <span className="flex-1 text-[11px] text-muted-foreground">
              {selected.size} selected
            </span>
            <Button
              variant="ghost"
              size="xs"
              disabled={!selected.size}
              onClick={() => void copy([...selected])}
            >
              <IconCopy /> Copy
            </Button>
            <Button
              variant="destructive"
              size="xs"
              disabled={!selected.size}
              onClick={() => setConfirm([...selected])}
            >
              <IconTrash /> Delete
            </Button>
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
          {chats === null ? (
            <div className="flex justify-center px-2 py-4 text-muted-foreground"><Spinner className="size-3.5" /></div>
          ) : chats.length === 0 ? (
            <p className="px-2 py-4 text-center text-[11px] text-muted-foreground">
              {query
                ? "No chat matches."
                : "No chats yet. Ask something on the right."}
            </p>
          ) : (
            grouped.map(([group, rows]) => (
              <section key={group} className="mb-2">
                <h2 className="px-2 pt-1 pb-0.5 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
                  {group}
                </h2>
                <ul>
                  {rows.map((c) => (
                    <ChatRow
                      key={c.id}
                      c={c}
                      active={c.id === chat.chatId}
                      running={chat.runningIds.has(c.id)}
                      selecting={selecting}
                      selected={selected.has(c.id)}
                      onToggle={() => toggle(c.id)}
                      onOpen={() => void chat.openChat(c.id)}
                      onRename={(title) => rename(c.id, title)}
                      onCopy={() => void copy([c.id])}
                      onDelete={() => setConfirm([c.id])}
                    />
                  ))}
                </ul>
              </section>
            ))
          )}
        </div>
      </aside>

      <main className="min-w-0 flex-1">
        <AssistantPanel chat={chat} history={false} />
      </main>

      <AlertDialog
        open={confirm !== null}
        onOpenChange={(open) => !open && setConfirm(null)}
      >
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirm?.length === 1
                ? "Delete this chat?"
                : `Delete ${confirm?.length} chats?`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              Their messages are removed from history for good. A chat that is
              still answering is stopped first.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => confirm && void remove(confirm)}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
