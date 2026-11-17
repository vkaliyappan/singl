"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  IconBolt,
  IconCheck,
  IconEye,
  IconShieldCheck,
  type Icon,
} from "@tabler/icons-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import type { ApprovalMode } from "@/lib/assistant/api";

const STORE_KEY = "singl.assistant.approval";

const MODES: {
  id: ApprovalMode;
  label: string;
  title: string;
  description: string;
  icon: Icon;
  tint: string;
}[] = [
  {
    id: "ask",
    label: "Ask",
    title: "Ask before changes",
    description: "Reads run, writes and deletes ask first",
    icon: IconShieldCheck,
    tint: "",
  },
  {
    id: "auto",
    label: "Auto",
    title: "Auto-approve everything",
    description: "Includes deploys, deletes and service calls",
    icon: IconBolt,
    tint: "text-red-600 dark:text-red-400",
  },
  {
    id: "readOnly",
    label: "Read-only",
    title: "Read-only",
    description: "The assistant can look but not change anything",
    icon: IconEye,
    tint: "text-sky-600 dark:text-sky-400",
  },
];

function isMode(v: unknown): v is ApprovalMode {
  return v === "ask" || v === "auto" || v === "readOnly";
}

/** The chosen approval mode, remembered across messages and restarts. */
export function useApprovalMode() {
  const [mode, setModeState] = useState<ApprovalMode>("ask");
  useEffect(() => {
    try {
      const v = localStorage.getItem(STORE_KEY);
      // eslint-disable-next-line react-hooks/set-state-in-effect -- read after mount to avoid SSR mismatch
      if (isMode(v)) setModeState(v);
    } catch {}
  }, []);
  const setMode = useCallback((m: ApprovalMode) => {
    setModeState(m);
    try {
      localStorage.setItem(STORE_KEY, m);
    } catch {}
  }, []);
  return { mode, setMode };
}

/** Composer button + popover with three radio rows. */
export function ApprovalModePicker({
  mode,
  onChange,
  disabled,
}: {
  mode: ApprovalMode;
  onChange: (m: ApprovalMode) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const rows = useRef<(HTMLDivElement | null)[]>([]);
  const current = MODES.find((m) => m.id === mode) ?? MODES[0];
  const Glyph = current.icon;

  const focusRow = (i: number) => {
    rows.current[(i + MODES.length) % MODES.length]?.focus();
  };
  const pick = (m: ApprovalMode) => {
    onChange(m);
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        disabled={disabled}
        aria-label={`Approval mode: ${current.title}`}
        title={`${current.title} - ${current.description}`}
        className={cn(
          "flex h-8 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-[13px] font-medium text-foreground/75 transition-colors outline-none hover:bg-foreground/5 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/30 disabled:opacity-50 data-[popup-open]:bg-foreground/5",
          current.tint,
        )}
      >
        <Glyph className="size-4 shrink-0" />
        <span className="hidden @md:inline">{current.label}</span>
      </PopoverTrigger>
      <PopoverContent align="end" side="top" className="w-80 gap-0.5 p-1.5">
        <div role="radiogroup" aria-label="Approval mode" className="contents">
          {MODES.map((m, i) => {
            const selected = m.id === mode;
            const RowIcon = m.icon;
            return (
              <div
                key={m.id}
                ref={(el) => {
                  rows.current[i] = el;
                }}
                role="radio"
                aria-checked={selected}
                tabIndex={selected ? 0 : -1}
                onClick={() => pick(m.id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    pick(m.id);
                  } else if (e.key === "ArrowDown" || e.key === "ArrowRight") {
                    e.preventDefault();
                    focusRow(i + 1);
                  } else if (e.key === "ArrowUp" || e.key === "ArrowLeft") {
                    e.preventDefault();
                    focusRow(i - 1);
                  }
                }}
                className="flex cursor-pointer items-start gap-2.5 rounded-md px-2 py-1.5 outline-none hover:bg-muted focus-visible:bg-muted focus-visible:ring-2 focus-visible:ring-ring/30"
              >
                <RowIcon
                  className={cn("mt-0.5 size-4 shrink-0", m.tint)}
                  aria-hidden
                />
                <span className="min-w-0 flex-1">
                  <span className="block text-[13px] font-medium">
                    {m.title}
                  </span>
                  <span className="block text-[11.5px] text-muted-foreground">
                    {m.description}
                  </span>
                </span>
                {selected && (
                  <IconCheck className="mt-0.5 size-4 shrink-0" aria-hidden />
                )}
              </div>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}
