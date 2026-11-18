"use client";

import { IconPencil, IconX } from "@tabler/icons-react";
import type { AssistantChat } from "./use-assistant-chat";

/**
 * Follow-ups waiting for the running answer to end. When nothing is running
 * and the queue did not start itself (cancelled, failed, or the chat was
 * opened later), "Send next" resumes it.
 */
export function QueueList({
  chat,
  onEdit,
  editorEmpty,
}: {
  chat: AssistantChat;
  onEdit: (text: string) => void;
  editorEmpty: boolean;
}) {
  const { queue, running } = chat;
  if (!queue.length) return null;
  return (
    <div className="mb-2 space-y-1" aria-label="Queued messages">
      {queue.map((q, i) => (
        <div
          key={q.id}
          className="flex h-7 items-center gap-2 rounded-full border bg-background px-3 text-[11.5px]"
        >
          <span className="shrink-0 text-muted-foreground">Queued</span>
          <span className="min-w-0 flex-1 truncate" title={q.text}>
            {q.text || "(image)"}
          </span>
          {!running && i === 0 && (
            <button
              type="button"
              onClick={() => void chat.sendNext()}
              className="shrink-0 rounded-full px-2 text-[11px] font-medium text-primary hover:bg-primary/10"
            >
              Send next
            </button>
          )}
          {editorEmpty && q.text && (
            <button
              type="button"
              aria-label="Edit queued message"
              title="Edit"
              onClick={() => {
                chat.removeQueued(q.id);
                onEdit(q.text);
              }}
              className="shrink-0 text-muted-foreground hover:text-foreground"
            >
              <IconPencil className="size-3.5" />
            </button>
          )}
          <button
            type="button"
            aria-label="Remove queued message"
            title="Remove"
            onClick={() => chat.removeQueued(q.id)}
            className="shrink-0 text-muted-foreground hover:text-foreground"
          >
            <IconX className="size-3.5" />
          </button>
        </div>
      ))}
    </div>
  );
}
