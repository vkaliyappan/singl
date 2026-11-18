"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  IconCheck,
  IconHistory,
  IconLayoutSidebarRight,
  IconPin,
  IconPinnedOff,
  IconChevronUp,
  IconMinus,
  IconWindowMaximize,
  IconWindowMinimize,
  IconPictureInPicture,
  IconMessagePlus,
  IconArrowUp,
  IconAt,
  IconPaperclip,
  IconPlayerStopFilled,
  IconPencil,
  IconSparkles,
  IconTrash,
  IconX,
} from "@tabler/icons-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { errorMessage } from "@/lib/settings";
import {
  hasDragPaths,
  hasDragPins,
  readDragPaths,
  readDragPins,
} from "@/lib/assistant/drag";
import { addPins, clearPins, removePin, usePins } from "@/lib/assistant/pins";

/** A drag carrying files from outside the app. */
function hasFiles(e: React.DragEvent) {
  return !!e.dataTransfer?.types.includes("Files");
}
import {
  assistantChatDelete,
  assistantChatRename,
  assistantChats,
  assistantSuggestions,
  assistantTurnMode,
  type ChatSummary,
  type ProviderInfo,
  type Suggestion,
} from "@/lib/assistant/api";
import { describeContext, useScreenContext } from "@/lib/assistant/context";
import { ApprovalCard, CopyButton, MessageList, ToolCard } from "./messages";
import {
  AddMenu,
  baseName,
  type ComposerExtras,
  ExtrasChips,
  ToolsChip,
  useComposerExtras,
} from "./composer-extras";
import { isImageFile } from "@/lib/assistant/images";
import { MENTION_HINT, MentionPopup, useMentions } from "./mentions";
import {
  EditorContent,
  editorMarkdown,
  insertMention,
  mentionRefs,
  removeMentions,
  openFence,
  pasteMarkdown,
  setEditorMarkdown,
  useComposerEditor,
} from "./composer-editor";
import { ApprovalModePicker, useApprovalMode, type ApprovalModes } from "./approval-mode";
import { ModelPicker, useModelChoice } from "./model-picker";
import { SubAgentPicker, subAgentsFor, useSubAgents } from "./sub-agents";
import type {
  AssistantChat,
  ChatChoice,
  SendExtras,
} from "./use-assistant-chat";

export function relativeTime(seconds: number | null | undefined) {
  if (!seconds) return "";
  const diff = Math.max(0, Date.now() / 1000 - seconds);
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400)}d ago`;
  return new Date(seconds * 1000).toLocaleDateString();
}

function History({ chat }: { chat: AssistantChat }) {
  const [open, setOpen] = useState(false);
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  const load = useCallback(() => {
    assistantChats()
      .then(setChats)
      .catch((e) => toast.error(errorMessage(e)));
  }, []);
  const { chatsVersion } = chat;
  useEffect(() => {
    if (open) load();
  }, [open, chatsVersion, load]);

  const q = query.trim().toLowerCase();
  const shown = q
    ? chats.filter((c) => c.title.toLowerCase().includes(q))
    : chats;

  const commitRename = async (id: string) => {
    const title = draft.trim();
    setEditing(null);
    if (!title) return;
    try {
      await assistantChatRename(id, title);
      if (id === chat.chatId) chat.setTitle(title);
      load();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  const remove = async (id: string) => {
    try {
      await assistantChatDelete(id);
      if (id === chat.chatId) chat.newChat();
      load();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Chat history"
            title="Chat history"
          />
        }
      >
        <IconHistory />
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 gap-1 p-1.5">
        <Input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search chats"
          className="h-7"
        />
        <ul className="max-h-80 overflow-y-auto" aria-label="Chats">
          {shown.length === 0 && (
            <li className="px-2 py-3 text-center text-[11px] text-muted-foreground">
              No chats
            </li>
          )}
          {shown.map((c) => (
            <li
              key={c.id}
              className={cn(
                "group/row flex items-center gap-1 rounded-md px-1.5 py-1 hover:bg-accent",
                c.id === chat.chatId && "bg-accent/60",
              )}
            >
              {editing === c.id ? (
                <>
                  <Input
                    autoFocus
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void commitRename(c.id);
                      if (e.key === "Escape") setEditing(null);
                    }}
                    className="h-6 flex-1"
                  />
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label="Save name"
                    onClick={() => void commitRename(c.id)}
                  >
                    <IconCheck />
                  </Button>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    className="min-w-0 flex-1 text-left"
                    onClick={() => {
                      void chat.openChat(c.id);
                      setOpen(false);
                    }}
                  >
                    <span className="block truncate text-xs">
                      {c.title || "Untitled"}
                    </span>
                    <span className="block text-[10px] text-muted-foreground">
                      {relativeTime(c.updatedAt ?? c.createdAt)} ·{" "}
                      {c.messageCount} messages
                    </span>
                  </button>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label={`Rename ${c.title}`}
                    className="opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100"
                    onClick={() => {
                      setDraft(c.title);
                      setEditing(c.id);
                    }}
                  >
                    <IconPencil />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label={`Delete ${c.title}`}
                    className="opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100"
                    onClick={() => void remove(c.id)}
                  >
                    <IconTrash />
                  </Button>
                </>
              )}
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  );
}

/** Side panel or floating window; only the dock passes it. */
export type PanelLayout = {
  floating: boolean;
  onToggleFloating: () => void;
  /** Side panel only: docked beside the page (page shrinks) instead of over it. */
  beside?: boolean;
  onToggleBeside?: () => void;
  /** Starts moving the floating window (pointer down on the header). */
  onDragStart?: (e: React.PointerEvent) => void;
  /** Floating window only. */
  state?: "normal" | "min" | "max";
  onMinimize?: () => void;
  onMaximize?: () => void;
};

function Header({
  chat,
  onClose,
  history,
  layout,
}: {
  chat: AssistantChat;
  onClose?: () => void;
  history: boolean;
  layout?: PanelLayout;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const commit = async () => {
    setEditing(false);
    const title = draft.trim();
    if (!title || !chat.chatId || title === chat.title) return;
    try {
      await assistantChatRename(chat.chatId, title);
      chat.setTitle(title);
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };
  return (
    <div
      className={cn(
        "flex h-10 shrink-0 items-center gap-1 border-b px-2.5",
        layout?.floating && "cursor-move select-none",
      )}
      onPointerDown={(e) => {
        // Only the bare header moves the window, not its buttons or the title field.
        if (layout?.onDragStart && !(e.target as HTMLElement).closest("button,input")) layout.onDragStart(e);
      }}
      onDoubleClick={(e) => {
        if (layout?.onMaximize && !(e.target as HTMLElement).closest("button,input")) layout.onMaximize();
      }}
    >
      <IconSparkles className="size-4 shrink-0 text-primary" />
      {editing ? (
        <Input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => void commit()}
          onKeyDown={(e) => {
            if (e.key === "Enter") void commit();
            if (e.key === "Escape") setEditing(false);
          }}
          className="h-6 flex-1"
          aria-label="Chat title"
        />
      ) : (
        <button
          type="button"
          disabled={!chat.chatId}
          title={chat.chatId ? "Rename chat" : undefined}
          onClick={() => {
            setDraft(chat.title);
            setEditing(true);
          }}
          className="min-w-0 truncate text-left text-xs font-medium disabled:cursor-default"
        >
          {chat.title || "Assistant"}
        </button>
      )}
      {!editing && <div className="min-w-4 flex-1 self-stretch" />}
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="New chat"
        title="New chat"
        onClick={chat.newChat}
      >
        <IconMessagePlus />
      </Button>
      {history && <History chat={chat} />}
      {layout?.onMinimize && (
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={layout.state === "min" ? "Restore" : "Minimize"}
          title={layout.state === "min" ? "Restore" : "Minimize"}
          onClick={layout.onMinimize}
        >
          {layout.state === "min" ? <IconChevronUp /> : <IconMinus />}
        </Button>
      )}
      {layout?.onMaximize && (
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={layout.state === "max" ? "Restore size" : "Maximize"}
          title={layout.state === "max" ? "Restore size (double-click header)" : "Maximize (double-click header)"}
          onClick={layout.onMaximize}
        >
          {layout.state === "max" ? <IconWindowMinimize /> : <IconWindowMaximize />}
        </Button>
      )}
      {layout?.onToggleBeside && (
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={layout.beside ? "Show over the page" : "Dock beside the page"}
          title={layout.beside ? "Show over the page (drawer)" : "Dock beside the page (page shrinks)"}
          onClick={layout.onToggleBeside}
        >
          {layout.beside ? <IconPinnedOff /> : <IconPin />}
        </Button>
      )}
      {layout && (
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={layout.floating ? "Back to the side drawer" : "Float as a window"}
          title={layout.floating ? "Back to the side drawer" : "Float as a window"}
          onClick={layout.onToggleFloating}
        >
          {layout.floating ? <IconLayoutSidebarRight /> : <IconPictureInPicture />}
        </Button>
      )}
      {onClose && (
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Close assistant"
          title="Close (Ctrl+J)"
          onClick={onClose}
        >
          <IconX />
        </Button>
      )}
    </div>
  );
}

/**
 * The message box: one rounded card holding the textarea, with the screen
 * context on the left and the model button and send/stop on the right.
 */
function Composer({
  chat,
  suggestions,
  onSend,
  canSend,
  providers,
  choice,
  onChoice,
  extras,
}: {
  chat: AssistantChat;
  extras: ComposerExtras;
  suggestions: Suggestion[];
  onSend: (text: string, extras?: SendExtras) => Promise<boolean>;
  canSend: boolean;
  providers: ProviderInfo[];
  choice: ChatChoice | null;
  onChoice: (c: ChatChoice) => void;
}) {
  const ctx = useScreenContext();
  const pins = usePins();
  const [modelOpen, setModelOpen] = useState(false);
  const { modes: approval, setModes: saveApproval } = useApprovalMode();
  const { prefs: subAgents, setPrefs: setSubAgents } = useSubAgents();
  // New modes also apply to the turn already running, and settle what it is
  // waiting on, per scope: Auto approves the open cards, Read-only denies them.
  const setApproval = (m: ApprovalModes) => {
    saveApproval(m);
    const id = chat.chatId;
    if (!chat.running || !id) return;
    void assistantTurnMode(id, m.local, m.server).catch(() => {});
    for (const a of chat.approvals) {
      const mode = m[a.scope];
      if (a.chatId === id && mode !== "ask") void chat.resolveApproval(a.requestId, mode === "auto");
    }
  };
  const { editor, empty } = useComposerEditor({
    placeholder: chat.messages.length
      ? "Ask a follow-up…"
      : "Ask about this screen, or tell me what to do…",
    onKeyDown: (e) => {
      if (mentions.onKeyDown(e)) return true;
      // Shift+Enter starts a new paragraph, not a hard break inside this one,
      // so markdown shortcuts (`- `, `1. `, `# `, `> `) work on the new line.
      // In a list it starts the next item (an empty item leaves the list).
      // Code blocks keep their own Shift+Enter.
      if (
        e.key === "Enter" &&
        e.shiftKey &&
        !e.ctrlKey &&
        !e.metaKey &&
        !e.isComposing &&
        editor &&
        !editor.isActive("codeBlock")
      ) {
        e.preventDefault();
        return editor.isActive("listItem")
          ? editor.commands.splitListItem("listItem") || editor.commands.liftListItem("listItem")
          : editor.commands.splitBlock();
      }
      if (e.key !== "Enter" || e.shiftKey || e.isComposing || e.keyCode === 229)
        return false;
      // Ctrl+Enter always sends; plain Enter is a new line in lists and code.
      const ctrl = e.ctrlKey || e.metaKey;
      if (!ctrl && editor && openFence(editor)) return true;
      if (!ctrl && (editor?.isActive("codeBlock") || editor?.isActive("listItem")))
        return false;
      e.preventDefault();
      void submit();
      return true;
    },
    onPaste: (e) => {
      const files = [...(e.clipboardData?.files ?? [])].filter(isImageFile);
      if (!files.length) return !!editor && pasteMarkdown(editor, e);
      e.preventDefault();
      void extras.addImages(files, true);
      return true;
    },
  });
  const mentions = useMentions({
    editor,
    extras,
    providers,
    choice,
    onChoice,
    onNewChat: chat.newChat,
    onOpenModel: () => setModelOpen(true),
    onApproval: setApproval,
  });
  // Every chip (file, dropped file, pinned item) also gets an @name badge in
  // the text. Removing a chip removes its badge; deleting a badge removes its chip.
  const chips: [ref: string, label: string][] = [
    ...pins.map((p): [string, string] => [`pin:${p.id}`, p.label]),
    ...extras.attachments.map((p): [string, string] => [
      `file:${p}`,
      baseName(p) + (extras.dirs.includes(p) ? "/" : ""),
    ]),
    ...extras.dropped.map((f): [string, string] => [`drop:${f.name}`, f.name]),
  ];
  const chipKey = JSON.stringify(chips);
  const seenChips = useRef(new Set<string>());
  useEffect(() => {
    if (!editor) return;
    const now = new Set(chips.map(([r]) => r));
    const prev = seenChips.current;
    seenChips.current = now;
    removeMentions(editor, [...prev].filter((r) => !now.has(r)));
    for (const [r, label] of chips) if (!prev.has(r)) insertMention(editor, r, label);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- chipKey is chips
  }, [editor, chipKey]);

  const latestExtras = useRef(extras);
  useEffect(() => {
    latestExtras.current = extras;
  });
  const sending = useRef(false);
  useEffect(() => {
    if (!editor) return;
    let inDoc = mentionRefs(editor);
    const onUpdate = () => {
      const now = mentionRefs(editor);
      const gone = [...inDoc].filter((r) => !now.has(r));
      inDoc = now;
      if (sending.current) return;
      for (const r of gone) {
        const [kind, ...rest] = r.split(":");
        const id = rest.join(":");
        seenChips.current.delete(r);
        if (kind === "pin") removePin(id);
        else if (kind === "file") latestExtras.current.removeAttachment(id);
        else if (kind === "drop") latestExtras.current.removeDropped(id);
      }
    };
    editor.on("update", onUpdate);
    return () => {
      editor.off("update", onUpdate);
    };
  }, [editor]);

  const submit = async () => {
    const sent = editorMarkdown(editor);
    if ((!sent && !extras.images.length) || chat.running || !canSend) return;
    // Clearing the box must not take the chips with it: they are sent below.
    sending.current = true;
    editor?.commands.clearContent(true);
    sending.current = false;
    const ok = await onSend(sent, {
      attachments: extras.attachments,
      dirs: extras.dirs,
      dropped: extras.dropped,
      images: extras.images.map(({ name, mediaType, data }) => ({
        name,
        mediaType,
        data,
      })),
      tools: extras.toolAllowlist,
      skills: extras.skillIds,
      skillNames: extras.skillNames,
      approval: approval.local,
      serverApproval: approval.server,
      subAgents: subAgentsFor(subAgents, choice?.provider),
      references: pins.map((p) => ({
        kind: p.kind,
        label: p.label,
        screen: p.screen,
        content: p.content,
      })),
    });
    if (ok) {
      extras.reset();
      clearPins();
    }
    else if (editor?.isEmpty) setEditorMarkdown(editor, sent);
  };

  const current = providers.find((p) => p.id === choice?.provider);
  const context = describeContext(ctx);

  return (
    <div className="mx-auto w-full max-w-3xl shrink-0 px-3 pt-1 pb-3">
      {suggestions.length > 0 && chat.messages.length > 0 && !chat.running && (
        <div
          className="mb-2 flex gap-1.5 overflow-x-auto pb-0.5"
          aria-label="Suggestions"
        >
          {suggestions.map((s) => (
            <button
              key={s.label}
              type="button"
              disabled={!canSend}
              onClick={() => void onSend(s.prompt)}
              className="shrink-0 rounded-full border bg-background px-2.5 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
            >
              {s.label}
            </button>
          ))}
        </div>
      )}
      <div className="relative">
        <MentionPopup m={mentions} />
        <div
          className="@container rounded-2xl border bg-muted/40 shadow-xs transition-colors focus-within:border-ring/50 focus-within:bg-muted/50 dark:bg-muted/30"
          onClick={(e) => {
            if (e.target === e.currentTarget) editor?.commands.focus("end");
          }}
        >
          <ExtrasChips extras={extras} />
          <EditorContent editor={editor} />
          <div className="flex items-center gap-1 px-2 pb-2">
            <AddMenu extras={extras} />
            <ToolsChip extras={extras} />
            <span
              className="flex h-7 min-w-0 items-center gap-1 truncate rounded-full px-2 text-[11px] text-muted-foreground"
              title={`The assistant sees: ${context}`}
            >
              <IconAt className="size-3.5 shrink-0" />
              <span className="truncate">{context}</span>
            </span>
            <span className="flex-1" />
            <SubAgentPicker
              prefs={subAgents}
              onChange={setSubAgents}
              choice={choice}
              providers={providers}
            />
            <ApprovalModePicker modes={approval} onChange={setApproval} />
            <ModelPicker
              providers={providers}
              choice={choice}
              onChange={onChoice}
              open={modelOpen}
              onOpenChange={setModelOpen}
            />
            {chat.running ? (
              <button
                type="button"
                aria-label="Stop"
                title="Stop"
                onClick={() => void chat.stop()}
                className="flex size-8 shrink-0 items-center justify-center rounded-full bg-foreground text-background transition-opacity hover:opacity-85"
              >
                <IconPlayerStopFilled className="size-3.5" />
              </button>
            ) : (
              <button
                type="button"
                aria-label="Send"
                title={
                  current && !current.available
                    ? (current.note ?? "Provider not available")
                    : "Send (Enter)"
                }
                disabled={(empty && !extras.images.length) || !canSend}
                onClick={() => void submit()}
                className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-40"
              >
                <IconArrowUp className="size-4" />
              </button>
            )}
          </div>
        </div>
      </div>
      {current && !current.available && (
        <p className="mt-1 px-2 text-[10.5px] text-amber-600 dark:text-amber-400">
          {current.note ?? "This provider is not available."}
        </p>
      )}
    </div>
  );
}

/**
 * The conversation view. The side panel passes `onClose`; the /assistant page
 * leaves it out and sets `history={false}`, since it has its own chat list.
 */
export function AssistantPanel({
  chat,
  onClose,
  history = true,
  layout,
}: {
  chat: AssistantChat;
  onClose?: () => void;
  history?: boolean;
  layout?: PanelLayout;
}) {
  const ctx = useScreenContext();
  const { providers, choice, setChoice } = useModelChoice(true);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const extras = useComposerExtras();
  const { addAttachments, addDroppedFiles } = extras;
  const panelRef = useRef<HTMLDivElement>(null);
  const [dropping, setDropping] = useState(false);

  // Folders and files get separate calls: only folders go into `dirs`.
  const attach = useCallback(
    (items: { path: string; isDir: boolean }[]) => {
      const dirs = items.filter((i) => i.isDir).map((i) => i.path);
      const files = items.filter((i) => !i.isDir).map((i) => i.path);
      if (dirs.length) addAttachments(dirs, true);
      if (files.length) addAttachments(files);
    },
    [addAttachments],
  );

  // Suggestions follow the screen; the backend has the context after its 250ms debounce.
  const ctxKey = JSON.stringify([ctx.screen, ctx.summary, ctx.selection]);
  useEffect(() => {
    const t = setTimeout(() => {
      assistantSuggestions()
        .then(setSuggestions)
        .catch(() => setSuggestions([]));
    }, 450);
    return () => clearTimeout(t);
  }, [ctxKey]);

  const lastLen =
    chat.messages.length +
    chat.streaming.length +
    chat.thinking.length +
    Object.keys(chat.liveCalls).length +
    chat.approvals.length;
  useEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [lastLen, chat.running]);

  const send = async (text: string, extras?: SendExtras) => {
    if (!choice) return false;
    stick.current = true;
    return chat.send(text, choice, extras);
  };
  const mine = chat.approvals.filter(
    (a) => a.chatId === null || a.chatId === chat.chatId,
  );
  const empty = chat.messages.length === 0 && !chat.running;

  return (
    <div
      ref={panelRef}
      data-assistant-panel
      // Explorer rows carry singl paths; files from Windows Explorer arrive as
      // browser Files (Tauri's own drop handler is off: tauri.conf.json dragDropEnabled).
      onDragEnter={(e) => {
        if (hasDragPaths(e) || hasDragPins(e) || hasFiles(e)) setDropping(true);
      }}
      onDragOver={(e) => {
        if (!hasDragPaths(e) && !hasDragPins(e) && !hasFiles(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
        setDropping(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
          setDropping(false);
        }
      }}
      onDrop={(e) => {
        setDropping(false);
        if (hasDragPins(e)) {
          e.preventDefault();
          addPins(readDragPins(e));
        } else if (hasDragPaths(e)) {
          e.preventDefault();
          attach(readDragPaths(e));
        } else if (hasFiles(e)) {
          e.preventDefault();
          void addDroppedFiles(e.dataTransfer);
        }
      }}
      className="relative flex h-full min-w-0 flex-col bg-background"
    >
      {dropping && (
        <div className="pointer-events-none absolute inset-1 z-50 flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed border-primary bg-background/80 text-primary backdrop-blur-[1px]">
          <IconPaperclip className="size-6" />
          <span className="text-sm font-medium">Drop to attach</span>
        </div>
      )}
      <Header chat={chat} onClose={onClose} history={history} layout={layout} />

      <div
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
        className="min-h-0 flex-1 overflow-y-auto px-4 py-4"
      >
        <div className="mx-auto w-full max-w-3xl">
          {empty ? (
            <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
              <div className="flex size-10 items-center justify-center rounded-xl border bg-card shadow-xs">
                <IconSparkles className="size-5 text-primary" />
              </div>
              <div>
                <p className="text-sm font-medium">How can I help?</p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  I can see your current screen and selection, and operate the
                  app.
                </p>
                <p className="mt-1 font-mono text-[10.5px] text-muted-foreground/70">
                  {MENTION_HINT}
                </p>
              </div>
              <div className="flex flex-wrap justify-center gap-1.5">
                {suggestions.map((s) => (
                  <button
                    key={s.label}
                    type="button"
                    disabled={!choice}
                    onClick={() => void send(s.prompt)}
                    className="rounded-full border bg-card px-2.5 py-1 text-[11px] transition-colors hover:bg-muted"
                  >
                    {s.label}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <MessageList
              messages={chat.messages}
              streaming={chat.streaming}
              thinking={chat.thinking}
              status={chat.status}
              running={chat.running}
              runningProvider={chat.runningProvider ?? choice}
              liveCalls={chat.liveCalls}
              onChoose={(text) => void send(text)}
            />
          )}

          {mine.map((a) => (
            <ApprovalCard
              key={a.requestId}
              approval={a}
              onResolve={chat.resolveApproval}
              showAlways={a.chatId !== null}
            />
          ))}

          {chat.error && (
            <div
              role="alert"
              className="mt-2 flex items-start gap-1.5 rounded-md border border-destructive/40 bg-destructive/5 p-2 text-xs text-destructive"
            >
              <span className="min-w-0 flex-1 break-words">{chat.error}</span>
              <CopyButton text={chat.error} />
            </div>
          )}

          {chat.external.length > 0 && (
            <details className="mt-4 rounded-md border bg-muted/20 px-2 py-1.5">
              <summary className="cursor-pointer text-[11px] font-medium text-muted-foreground">
                External MCP activity ({chat.external.length})
              </summary>
              <div className="mt-1">
                {chat.external.map((c) => (
                  <ToolCard
                    key={c.callId}
                    name={c.name}
                    input={c.input}
                    content={c.content}
                    isError={c.isError}
                    running={!c.done}
                    source={c.source}
                  />
                ))}
                <Button variant="ghost" size="xs" onClick={chat.clearExternal}>
                  Clear
                </Button>
              </div>
            </details>
          )}
        </div>
      </div>

      <Composer
        chat={chat}
        suggestions={suggestions}
        onSend={send}
        canSend={!!choice}
        providers={providers}
        choice={choice}
        onChoice={setChoice}
        extras={extras}
      />
    </div>
  );
}
