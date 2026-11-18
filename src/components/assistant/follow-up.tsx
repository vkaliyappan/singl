"use client";

import { useCallback, useEffect, useState } from "react";
import { IconClockPlay, IconSteeringWheel } from "@tabler/icons-react";
import { cn } from "@/lib/utils";

/** What Enter does while the assistant is still answering. */
export type FollowUpMode = "queue" | "steer";

const STORE_KEY = "singl.assistant.followUp";

function read(): FollowUpMode {
  try {
    return localStorage.getItem(STORE_KEY) === "queue" ? "queue" : "steer";
  } catch {
    return "steer";
  }
}

/** The follow-up preference, remembered across messages and restarts. */
export function useFollowUp() {
  const [mode, setModeState] = useState<FollowUpMode>("steer");
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- read after mount to avoid SSR mismatch
    setModeState(read());
  }, []);
  const setMode = useCallback((m: FollowUpMode) => {
    setModeState(m);
    try {
      localStorage.setItem(STORE_KEY, m);
    } catch {}
  }, []);
  return { mode, setMode };
}

const TITLE: Record<FollowUpMode, string> = {
  steer:
    "Steer: a message sent mid-answer is read by the model before its next step. Click to queue instead.",
  queue:
    "Queue: a message sent mid-answer waits and is sent when the answer finishes. Click to steer instead.",
};

export function FollowUpToggle({
  mode,
  onChange,
}: {
  mode: FollowUpMode;
  onChange: (m: FollowUpMode) => void;
}) {
  const Glyph = mode === "steer" ? IconSteeringWheel : IconClockPlay;
  return (
    <button
      type="button"
      aria-label={`While answering: ${mode}`}
      title={TITLE[mode]}
      onClick={() => onChange(mode === "steer" ? "queue" : "steer")}
      className={cn(
        "flex h-7 shrink-0 items-center gap-1 rounded-full px-2 text-[11px] font-medium text-muted-foreground transition-colors outline-none hover:bg-foreground/5 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/30",
      )}
    >
      <Glyph className="size-3.5 shrink-0" />
      <span className="hidden @md:inline">{mode === "steer" ? "Steer" : "Queue"}</span>
    </button>
  );
}
