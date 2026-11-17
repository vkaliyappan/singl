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
  assistantSend,
  onAssistantEvent,
  type AssistantEvent,
  type Message,
  type Risk,
  type ApprovalMode,
} from "@/lib/assistant/api";

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

export function useAssistantChat(opts: {
  onNeedPanel: () => void;
  panelOpen: boolean;
}) {
  const [chatId, setChatId] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [streaming, setStreaming] = useState("");
  const [thinking, setThinking] = useState("");
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");
  const [liveCalls, setLiveCalls] = useState<Record<string, LiveCall>>({});
  const [external, setExternal] = useState<LiveCall[]>([]);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [chatsVersion, setChatsVersion] = useState(0);
  const [runningProvider, setRunningProvider] = useState<ChatChoice | null>(
    null,
  );

  const chatIdRef = useRef<string | null>(null);
  const adoptNext = useRef(false);
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
          if (e.chatId === chatIdRef.current) setStreaming((s) => s + e.text);
          break;
        case "thinking":
          if (e.chatId === chatIdRef.current) setThinking((s) => s + e.text);
          break;
        case "toolCall": {
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
          } else if (e.chatId === chatIdRef.current) {
            setLiveCalls((c) => ({ ...c, [e.callId]: call }));
          }
          break;
        }
        case "toolResult":
          if (e.chatId === null) {
            setExternal((x) =>
              x.map((c) =>
                c.callId === e.callId
                  ? { ...c, content: e.content, isError: e.isError, done: true }
                  : c,
              ),
            );
          } else if (e.chatId === chatIdRef.current) {
            setLiveCalls((c) =>
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
                : c,
            );
          }
          break;
        case "messageSaved":
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
          if (e.chatId !== chatIdRef.current) break;
          setRunning(false);
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
      .then((fn) => (cancelled ? fn() : (unlisten = fn)))
      .catch((err) => console.warn("assistant events unavailable", err));
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [setChat, sync]);

  const newChat = useCallback(() => {
    setChat(null);
    setTitle("");
    setMessages([]);
    setStreaming("");
    setThinking("");
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
    running,
    runningProvider,
    error,
    liveCalls,
    external,
    clearExternal: () => setExternal([]),
    approvals,
    resolveApproval,
    chatsVersion,
    newChat,
    openChat,
    send,
    stop,
  };
}

export type AssistantChat = ReturnType<typeof useAssistantChat>;
