"use client";

import { useCallback, useEffect, useState } from "react";
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

/** One mode for changes inside singl, one for the ThingWorx server. */
export type ApprovalModes = { local: ApprovalMode; server: ApprovalMode };

const STORE_KEY = "singl.assistant.approvalModes";
/** Before the split: one mode for everything. */
const LEGACY_KEY = "singl.assistant.approval";

const MODE: Record<ApprovalMode, { label: string; icon: Icon; tint: string }> = {
  ask: { label: "Ask", icon: IconShieldCheck, tint: "" },
  auto: { label: "Auto", icon: IconBolt, tint: "text-red-600 dark:text-red-400" },
  readOnly: { label: "Read-only", icon: IconEye, tint: "text-sky-600 dark:text-sky-400" },
};
const ORDER: ApprovalMode[] = ["ask", "auto", "readOnly"];

const PRESETS: { title: string; description: string; modes: ApprovalModes }[] = [
  {
    title: "Ask before changes",
    description: "Reads run; every change asks first",
    modes: { local: "ask", server: "ask" },
  },
  {
    title: "Auto in singl, ask for ThingWorx",
    description: "Files, flows and presets change freely; service calls and deploys ask",
    modes: { local: "auto", server: "ask" },
  },
  {
    title: "Auto in singl, ThingWorx read-only",
    description: "Local changes run; the server can be read but not changed",
    modes: { local: "auto", server: "readOnly" },
  },
  {
    title: "Auto-approve everything",
    description: "Includes deploys, deletes and service calls",
    modes: { local: "auto", server: "auto" },
  },
  {
    title: "Read-only",
    description: "The assistant can look but not change anything",
    modes: { local: "readOnly", server: "readOnly" },
  },
];

const SCOPES: { key: keyof ApprovalModes; title: string; hint: string }[] = [
  { key: "local", title: "In singl", hint: "Entity files, flows, presets, repo, screens" },
  { key: "server", title: "ThingWorx server", hint: "Running services and flows, uploads, server backups" },
];

function isMode(v: unknown): v is ApprovalMode {
  return v === "ask" || v === "auto" || v === "readOnly";
}

const same = (a: ApprovalModes, b: ApprovalModes) => a.local === b.local && a.server === b.server;

function read(): ApprovalModes | null {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      const v = JSON.parse(raw) as Partial<ApprovalModes>;
      if (isMode(v.local) && isMode(v.server)) return { local: v.local, server: v.server };
    }
    const legacy = localStorage.getItem(LEGACY_KEY);
    if (isMode(legacy)) return { local: legacy, server: legacy };
  } catch {}
  return null;
}

/** The saved approval modes, for messages sent without the composer (choices, suggestions). */
export function savedApprovalModes(): ApprovalModes {
  return read() ?? { local: "ask", server: "ask" };
}

/** The chosen approval modes, remembered across messages and restarts. */
export function useApprovalMode() {
  const [modes, setModesState] = useState<ApprovalModes>({ local: "ask", server: "ask" });
  useEffect(() => {
    const saved = read();
    // eslint-disable-next-line react-hooks/set-state-in-effect -- read after mount to avoid SSR mismatch
    if (saved) setModesState(saved);
  }, []);
  const setModes = useCallback((m: ApprovalModes) => {
    setModesState(m);
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(m));
    } catch {}
  }, []);
  return { modes, setModes };
}

/** What the composer button says: one word when both agree, else both. */
function summary(m: ApprovalModes) {
  if (m.local === m.server) return MODE[m.local].label;
  return `${MODE[m.local].label} · TWX ${MODE[m.server].label}`;
}

/** Composer button + popover: presets, then each scope on its own. */
export function ApprovalModePicker({
  modes,
  onChange,
  disabled,
}: {
  modes: ApprovalModes;
  onChange: (m: ApprovalModes) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  // The button takes the more permissive side's look: Auto anywhere is red.
  const shown =
    modes.local === "auto" || modes.server === "auto"
      ? MODE.auto
      : modes.local === "ask" || modes.server === "ask"
        ? MODE.ask
        : MODE.readOnly;
  const Glyph = shown.icon;
  const text = summary(modes);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        disabled={disabled}
        aria-label={`Approval mode: ${text}`}
        title={`In singl: ${MODE[modes.local].label}. ThingWorx server: ${MODE[modes.server].label}.`}
        className={cn(
          "flex h-8 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-[13px] font-medium text-foreground/75 transition-colors outline-none hover:bg-foreground/5 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/30 disabled:opacity-50 data-[popup-open]:bg-foreground/5",
          shown.tint,
        )}
      >
        <Glyph className="size-4 shrink-0" />
        <span className="hidden max-w-40 truncate @md:inline">{text}</span>
      </PopoverTrigger>
      <PopoverContent align="end" side="top" className="w-88 gap-0.5 p-1.5">
        <div role="radiogroup" aria-label="Approval presets" className="contents">
          {PRESETS.map((p) => {
            const selected = same(p.modes, modes);
            const look =
              p.modes.server === "auto" ? MODE.auto : p.modes.local === "readOnly" ? MODE.readOnly : p.modes.local === "auto" ? MODE.auto : MODE.ask;
            const RowIcon = look.icon;
            return (
              <button
                key={p.title}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => {
                  onChange(p.modes);
                  setOpen(false);
                }}
                className="flex w-full cursor-pointer items-start gap-2.5 rounded-md px-2 py-1.5 text-left outline-none hover:bg-muted focus-visible:bg-muted focus-visible:ring-2 focus-visible:ring-ring/30"
              >
                <RowIcon className={cn("mt-0.5 size-4 shrink-0", look.tint)} aria-hidden />
                <span className="min-w-0 flex-1">
                  <span className="block text-[13px] font-medium">{p.title}</span>
                  <span className="block text-[11.5px] text-muted-foreground">{p.description}</span>
                </span>
                {selected && <IconCheck className="mt-0.5 size-4 shrink-0" aria-hidden />}
              </button>
            );
          })}
        </div>
        <div className="mx-2 my-1 border-t" />
        {SCOPES.map((s) => (
          <div key={s.key} className="flex items-center gap-2 px-2 py-1.5">
            <span className="min-w-0 flex-1">
              <span className="block text-[12.5px] font-medium">{s.title}</span>
              <span className="block truncate text-[11px] text-muted-foreground" title={s.hint}>
                {s.hint}
              </span>
            </span>
            <div
              role="radiogroup"
              aria-label={s.title}
              className="flex shrink-0 rounded-md border bg-muted/40 p-0.5"
            >
              {ORDER.map((m) => {
                const on = modes[s.key] === m;
                return (
                  <button
                    key={m}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    onClick={() => onChange({ ...modes, [s.key]: m })}
                    className={cn(
                      "rounded px-2 py-0.5 text-[11.5px] outline-none focus-visible:ring-2 focus-visible:ring-ring/30",
                      on ? cn("bg-background font-medium shadow-sm", MODE[m].tint) : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {MODE[m].label}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </PopoverContent>
    </Popover>
  );
}
