"use client";

// Chat state for the assistant panel. Lives in AssistantDock, which is always
// mounted, so a running turn keeps streaming while the panel is closed.

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { isTauri } from "@/lib/clock-widget";
import { errorMessage } from "@/lib/settings";
import {
  assistantApprove,
  assistantCancel,
  assistantChatGet,
  assistantChatRunning,
  assistantRunningChats,
  assistantSend,
  onAssistantEvent,
  type AssistantEvent,
  type Message,
  type Risk,
  type ApprovalMode,
} from "@/lib/assistant/api";
import { emitAssistantChange } from "@/lib/assistant/changes";

export type LiveCall = {
  callId: string;
  name: string;
  input: unknown;
  source: string;
  content?: string;
  isError?: boolean;
  done: boolean;
};

export type Approval = {
  requestId: string;
  chatId: string | null;
  tool: string;
  input: unknown;
  risk: Risk;
  source: string;
};

/** `effort` empty or missing = the provider's default. */
export type SendExtras = {
  attachments: string[];
  /** Subset of attachments that are folders. */
  dirs?: string[];
  /** null = all tools. */
  tools: string[] | null;
  /** Skill ids and display names, parallel arrays. */
  skills: string[];
  skillNames: string[];
  approval?: ApprovalMode;
  /** Files dropped from outside the app, already read. */
  dropped?: { name: string; content: string }[];
  /** Pinned screen items. */
  references?: { kind: string; label: string; screen?: string; content: string }[];
  images?: { name: string; mediaType: string; data: string }[];
};

export type ChatChoice = { provider: string; model: string; effort?: string };

const EXTERNAL_LIMIT = 25;

/** What a running turn has shown so far, kept for every chat, on screen or not. */
type Live = {
  /** What an agent CLI is doing between visible output ("Reading a.js"). */
  status: string;
  streaming: string;
  thinking: string;
  liveCalls: Record<string, LiveCall>;
  provider: ChatChoice | null;
};
const emptyLive = (): Live => ({ status: "", streaming: "", thinking: "", liveCalls: {}, provider: null });

export function useAssistantChat(opts: {
  onNeedPanel: () => void;
  panelOpen: boolean;
}) {
  const [chatId, setChatId] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [streaming, setStreaming] = useState("");
  const [thinking, setThinking] = useState("");
  const [status, setStatus] = useState("");
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");
  const [liveCalls, setLiveCalls] = useState<Record<string, LiveCall>>({});
  const [external, setExternal] = useState<LiveCall[]>([]);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [chatsVersion, setChatsVersion] = useState(0);
  /** Every chat with a turn in progress, not just the open one. */
  const [runningIds, setRunningIds] = useState<ReadonlySet<string>>(new Set());
  const markRunning = useCallback((id: string, on: boolean) => {
    setRunningIds((s) => {
      if (s.has(id) === on) return s;
      const next = new Set(s);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);
  const [runningProvider, setRunningProvider] = useState<ChatChoice | null>(
    null,
  );

  const chatIdRef = useRef<string | null>(null);
  const adoptNext = useRef(false);
  // Opening a chat mid-turn restores its live state from here instead of
  // showing only what streams after the switch.
  const live = useRef(new Map<string, Live>());
  // Every call in flight, any chat or outside client, so a success can tell
  // the open screens what changed.
  const inFlight = useRef(new Map<string, { name: string; input: unknown }>());
  const track = (id: string, change: (l: Live) => Live) => {
    live.current.set(id, change(live.current.get(id) ?? emptyLive()));
  };
  const panelOpenRef = useRef(opts.panelOpen);
  const needPanelRef = useRef(opts.onNeedPanel);
  useEffect(() => {
    panelOpenRef.current = opts.panelOpen;
    needPanelRef.current = opts.onNeedPanel;
  });

  const setChat = useCallback((id: string | null) => {
    chatIdRef.current = id;
    setChatId(id);
  }, []);

  const resolveApproval = useCallback(
    async (requestId: string, approved: boolean, always = false) => {
      setApprovals((a) => a.filter((x) => x.requestId !== requestId));
      toast.dismiss(requestId);
      try {
        await assistantApprove(requestId, approved, always);
      } catch (e) {
        toast.error(errorMessage(e));
      }
    },
    [],
  );
  const resolveRef = useRef(resolveApproval);
  useEffect(() => {
    resolveRef.current = resolveApproval;
  });

  const sync = useCallback(async (id: string) => {
    const chat = await assistantChatGet(id);
    if (chatIdRef.current !== id) return;
    setMessages(chat.messages);
    setTitle(chat.title);
  }, []);

  useEffect(() => {
    if (!isTauri()) return;
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    const handle = (e: AssistantEvent) => {
      switch (e.type) {
        case "turnStarted":
          markRunning(e.chatId, true);
          live.current.set(e.chatId, {
            ...emptyLive(),
            provider: { provider: e.provider, model: e.model },
          });
          if (!chatIdRef.current && adoptNext.current) {
            adoptNext.current = false;
            setChat(e.chatId);
          }
          if (e.chatId === chatIdRef.current) {
            setRunning(true);
            setRunningProvider((p) => ({
              provider: e.provider,
              model: e.model,
              effort: p?.effort,
            }));
          }
          break;
        case "text":
          track(e.chatId, (l) => ({ ...l, status: "", streaming: l.streaming + e.text }));
          if (e.chatId === chatIdRef.current) {
            setStatus("");
            setStreaming((s) => s + e.text);
          }
          break;
        case "thinking":
          track(e.chatId, (l) => ({ ...l, status: "", thinking: l.thinking + e.text }));
          if (e.chatId === chatIdRef.current) {
            setStatus("");
            setThinking((s) => s + e.text);
          }
          break;
        case "status":
          track(e.chatId, (l) => ({ ...l, status: e.text }));
          if (e.chatId === chatIdRef.current) setStatus(e.text);
          break;
        case "toolCall": {
          inFlight.current.set(e.callId, { name: e.name, input: e.input });
          const call: LiveCall = {
            callId: e.callId,
            name: e.name,
            input: e.input,
            source: e.source,
            done: false,
          };
          if (e.chatId === null) {
            if (e.source === "mcp")
              setExternal((x) => [call, ...x].slice(0, EXTERNAL_LIMIT));
          } else {
            // The card says what is happening now; an older status would be stale.
            track(e.chatId, (l) => ({ ...l, status: "", liveCalls: { ...l.liveCalls, [e.callId]: call } }));
            if (e.chatId === chatIdRef.current) {
              setStatus("");
              setLiveCalls((c) => ({ ...c, [e.callId]: call }));
            }
          }
          break;
        }
        case "toolResult": {
          const started = inFlight.current.get(e.callId);
          inFlight.current.delete(e.callId);
          if (started && !e.isError) emitAssistantChange(started.name, started.input);
          if (e.chatId === null) {
            setExternal((x) =>
              x.map((c) =>
                c.callId === e.callId
                  ? { ...c, content: e.content, isError: e.isError, done: true }
                  : c,
              ),
            );
          } else {
            const finish = (c: Record<string, LiveCall>) =>
              c[e.callId]
                ? {
                    ...c,
                    [e.callId]: {
                      ...c[e.callId],
                      content: e.content,
                      isError: e.isError,
                      done: true,
                    },
                  }
                : c;
            track(e.chatId, (l) => ({ ...l, liveCalls: finish(l.liveCalls) }));
            if (e.chatId === chatIdRef.current) setLiveCalls(finish);
          }
          break;
        }
        case "messageSaved":
          if (e.message.role === "assistant" && live.current.has(e.chatId)) {
            track(e.chatId, (l) => ({ ...l, streaming: "", thinking: "" }));
          }
          if (e.chatId !== chatIdRef.current) break;
          setMessages((m) => {
            const base =
              e.message.role === "user"
                ? m.filter((x) => !x.id.startsWith("tmp-"))
                : m;
            return base.some((x) => x.id === e.message.id)
              ? base
              : [...base, e.message];
          });
          if (e.message.role === "assistant") {
            setStreaming("");
            setThinking("");
          }
          break;
        case "turnEnded":
          markRunning(e.chatId, false);
          live.current.delete(e.chatId);
          if (e.chatId !== chatIdRef.current) break;
          setRunning(false);
          setStatus("");
          setStreaming("");
          setThinking("");
          setLiveCalls({});
          setRunningProvider(null);
          if (e.error) setError(e.error);
          sync(e.chatId).catch(() => {});
          break;
        case "approvalRequest": {
          const a: Approval = {
            requestId: e.requestId,
            chatId: e.chatId,
            tool: e.tool,
            input: e.input,
            risk: e.risk,
            source: e.source,
          };
          setApprovals((x) =>
            x.some((y) => y.requestId === a.requestId) ? x : [...x, a],
          );
          const inView =
            a.chatId !== null &&
            a.chatId === chatIdRef.current &&
            panelOpenRef.current;
          if (!inView) {
            toast(`Approve ${e.tool}?`, {
              id: e.requestId,
              description: e.chatId
                ? "The assistant wants to run this tool."
                : `Requested by an external MCP client (${e.source}).`,
              duration: Infinity,
              action: {
                label: "Approve",
                onClick: () => void resolveRef.current(e.requestId, true),
              },
              cancel: {
                label: "Deny",
                onClick: () => void resolveRef.current(e.requestId, false),
              },
            });
          }
          break;
        }
        case "approvalResolved":
          setApprovals((x) => x.filter((y) => y.requestId !== e.requestId));
          toast.dismiss(e.requestId);
          break;
        case "chatsChanged":
          setChatsVersion((v) => v + 1);
          if (chatIdRef.current) sync(chatIdRef.current).catch(() => {});
          break;
      }
    };
    onAssistantEvent(handle)
      .then((fn) => {
        if (cancelled) return fn();
        unlisten = fn;
        // Turns that started before this window (re)loaded.
        return assistantRunningChats().then((ids) => {
          if (!cancelled) ids.forEach((id) => markRunning(id, true));
        });
      })
      .catch((err) => console.warn("assistant events unavailable", err));
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [setChat, sync, markRunning]);

  const newChat = useCallback(() => {
    setChat(null);
    setTitle("");
    setMessages([]);
    setStreaming("");
    setThinking("");
    setStatus("");
    setLiveCalls({});
    setRunning(false);
    setRunningProvider(null);
    setError("");
  }, [setChat]);

  const openChat = useCallback(
    async (id: string) => {
      newChat();
      setChat(id);
      try {
        const [chat, isRunning] = await Promise.all([
          assistantChatGet(id),
          assistantChatRunning(id),
        ]);
        if (chatIdRef.current !== id) return;
        setMessages(chat.messages);
        setTitle(chat.title);
        setRunning(isRunning);
        const soFar = isRunning ? live.current.get(id) : undefined;
        if (!isRunning) live.current.delete(id);
        if (soFar) {
          // Events that arrived during the fetch are already in soFar.
          setStatus(soFar.status);
          setStreaming(soFar.streaming);
          setThinking(soFar.thinking);
          setLiveCalls(soFar.liveCalls);
          setRunningProvider(soFar.provider);
        }
      } catch (e) {
        setError(errorMessage(e));
      }
    },
    [newChat, setChat],
  );

  const send = useCallback(
    async (
      text: string,
      choice: ChatChoice,
      extras?: SendExtras,
    ): Promise<boolean> => {
      const body = text.trim();
      if (!body && !extras?.images?.length) return false;
      setError("");
      setStreaming("");
      setThinking("");
      setStatus("");
      setLiveCalls({});
      setRunning(true);
      setRunningProvider(choice);
      setMessages((m) => [
        ...m,
        {
          id: `tmp-${Date.now()}`,
          role: "user",
          blocks: [
            ...(extras?.attachments ?? []).map((path) => ({
              type: "attachment" as const,
              name:
                (path.split(/[\/]/).pop() || path) +
                (extras?.dirs?.includes(path) ? "/" : ""),
              path,
              content: "",
              directory: extras?.dirs?.includes(path) || undefined,
            })),
            ...(extras?.dropped ?? []).map((f) => ({
              type: "attachment" as const,
              name: f.name,
              path: `(dropped file) ${f.name}`,
              content: "",
            })),
            ...(extras?.references ?? []).map((r) => ({
              type: "reference" as const,
              ...r,
            })),
            ...(extras?.images ?? []).map((i) => ({
              type: "image" as const,
              name: i.name,
              media_type: i.mediaType,
              data: i.data,
            })),
            ...(body ? [{ type: "text" as const, text: body }] : []),
          ],
          skills: extras?.skillNames.length ? extras.skillNames : undefined,
          createdAt: Date.now() / 1000,
        },
      ]);
      const existing = chatIdRef.current;
      adoptNext.current = !existing;
      try {
        const id = await assistantSend({
          chatId: existing ?? undefined,
          provider: choice.provider,
          model: choice.model,
          effort: choice.effort,
          text: body,
          attachments: extras?.attachments ?? [],
          tools: extras?.tools ?? null,
          skills: extras?.skills ?? [],
          approval: extras?.approval,
          inlineAttachments: extras?.dropped ?? [],
          references: extras?.references?.length ? extras.references : undefined,
          images: extras?.images?.length ? extras.images : undefined,
        });
        adoptNext.current = false;
        if (!chatIdRef.current) setChat(id);
        return true;
      } catch (e) {
        adoptNext.current = false;
        setRunning(false);
        setRunningProvider(null);
        setMessages((m) => m.filter((x) => !x.id.startsWith("tmp-")));
        setError(errorMessage(e));
        return false;
      }
    },
    [setChat],
  );

  const stop = useCallback(async () => {
    const id = chatIdRef.current;
    if (id) await assistantCancel(id).catch(() => {});
  }, []);

  return {
    chatId,
    title,
    setTitle,
    messages,
    streaming,
    thinking,
    status,
    running,
    runningProvider,
    error,
    liveCalls,
    external,
    clearExternal: () => setExternal([]),
    approvals,
    resolveApproval,
    chatsVersion,
    runningIds,
    newChat,
    openChat,
    send,
    stop,
  };
}

export type AssistantChat = ReturnType<typeof useAssistantChat>;
