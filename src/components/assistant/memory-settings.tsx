"use client";

// Settings → AI → Memory: the facts the assistant saved with memory_save.
// The assistant adds them itself; here the user reviews, fixes or removes them.

import { useCallback, useEffect, useState } from "react";
import {
  IconCheck,
  IconEdit,
  IconRefresh,
  IconTrash,
  IconX,
} from "@tabler/icons-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { errorMessage } from "@/lib/settings";
import {
  type Memory,
  assistantMemories,
  assistantMemoryDelete,
  assistantMemoryUpdate,
} from "@/lib/assistant/api";

const dateFmt = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });

export function MemorySettings() {
  const [items, setItems] = useState<Memory[] | null>(null);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  const load = useCallback(() => {
    assistantMemories()
      .then((m) => {
        setItems(m);
        setError("");
      })
      .catch((e) => setError(errorMessage(e)));
  }, []);

  useEffect(load, [load]);

  async function save(id: string) {
    try {
      const m = await assistantMemoryUpdate(id, draft);
      setItems((all) => all?.map((x) => (x.id === id ? m : x)) ?? null);
      setEditing(null);
    } catch (e) {
      toast.error(errorMessage(e));
    }
  }

  async function remove(id: string) {
    try {
      await assistantMemoryDelete(id);
      setItems((all) => all?.filter((x) => x.id !== id) ?? null);
    } catch (e) {
      toast.error(errorMessage(e));
    }
  }

  return (
    <Card className="gap-0 py-0">
      <CardHeader className="border-b px-3.5 py-2.5">
        <div className="flex items-center gap-2">
          <CardTitle className="text-xs font-semibold">Memory</CardTitle>
          <Button
            size="icon-sm"
            variant="ghost"
            className="ml-auto"
            aria-label="Reload memories"
            onClick={load}
          >
            <IconRefresh className="size-3.5" />
          </Button>
        </div>
        <CardDescription className="text-[11px]">
          Facts the assistant chose to remember across chats: your corrections
          and preferences, and things about your servers it found. Every chat
          reads all of them. Fix or remove any that are wrong.
        </CardDescription>
      </CardHeader>
      <CardContent className="p-0 text-xs">
        {error && <p className="p-3.5 text-destructive">{error}</p>}
        {items?.length === 0 && (
          <p className="p-3.5 text-muted-foreground">Nothing remembered yet.</p>
        )}
        {items && items.length > 0 && (
          <ul className="max-h-96 divide-y overflow-y-auto">
            {items.map((m) => (
              <li key={m.id} className="flex items-start gap-2 px-3.5 py-2">
                {editing === m.id ? (
                  <>
                    <Textarea
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      maxLength={1000}
                      className="min-h-16 flex-1 text-xs"
                      aria-label="Memory text"
                      autoFocus
                    />
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label="Save memory"
                      disabled={!draft.trim()}
                      onClick={() => void save(m.id)}
                    >
                      <IconCheck className="size-3.5" />
                    </Button>
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label="Cancel edit"
                      onClick={() => setEditing(null)}
                    >
                      <IconX className="size-3.5" />
                    </Button>
                  </>
                ) : (
                  <>
                    <div className="min-w-0 flex-1">
                      <p className="whitespace-pre-wrap break-words">
                        {m.text}
                      </p>
                      <p className="text-[11px] text-muted-foreground">
                        {dateFmt.format(new Date(m.updatedAt * 1000))}
                      </p>
                    </div>
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label="Edit memory"
                      onClick={() => {
                        setEditing(m.id);
                        setDraft(m.text);
                      }}
                    >
                      <IconEdit className="size-3.5" />
                    </Button>
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      className="text-destructive"
                      aria-label="Delete memory"
                      onClick={() => void remove(m.id)}
                    >
                      <IconTrash className="size-3.5" />
                    </Button>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
