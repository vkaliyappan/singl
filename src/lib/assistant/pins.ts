"use client";

// "Add to chat": things pinned from a screen ride along with the next message
// as references. Module stores (no provider ordering needed). Pages also
// register `pinnables` so the composer's @ menu can offer them.

import { useEffect, useRef, useSyncExternalStore } from "react";
import { setAssistantOpen } from "@/components/assistant/dock";

export type Pin = {
  id: string;
  kind: string;
  label: string;
  screen?: string;
  content: string;
  /** Short hint for the chip, e.g. "35 cols · 120 rows". Not sent. */
  detail?: string;
};

export type NewPin = Omit<Pin, "id">;

export type Pinnable = {
  kind: string;
  label: string;
  detail?: string;
  /** Built lazily, only when picked. */
  content: () => string;
};

const NO_PINS: Pin[] = [];
let pins: Pin[] = NO_PINS;
const pinListeners = new Set<() => void>();
const emitPins = () => pinListeners.forEach((l) => l());
let seq = 0;

const keyOf = (p: { kind: string; label: string; screen?: string }) =>
  `${p.kind}\u0000${p.label}\u0000${p.screen ?? ""}`;

export function addPins(items: NewPin[]) {
  if (!items.length) return;
  const next = [...pins];
  for (const it of items) {
    const i = next.findIndex((p) => keyOf(p) === keyOf(it));
    if (i >= 0) next[i] = { ...next[i], ...it };
    else next.push({ ...it, id: `pin-${++seq}` });
  }
  pins = next;
  emitPins();
  setAssistantOpen(true);
}

export function removePin(id: string) {
  pins = pins.filter((p) => p.id !== id);
  emitPins();
}

export function clearPins() {
  if (!pins.length) return;
  pins = [];
  emitPins();
}

export function usePins(): Pin[] {
  return useSyncExternalStore(
    (l) => {
      pinListeners.add(l);
      return () => {
        pinListeners.delete(l);
      };
    },
    () => pins,
    () => NO_PINS,
  );
}

// ---- pinnables of the current screen ----

let pinnables: { owner: symbol; items: Pinnable[] }[] = [];
let pinnableSnapshot: Pinnable[] = [];
const pinnableListeners = new Set<() => void>();

function publishPinnables() {
  pinnableSnapshot = pinnables.flatMap((p) => p.items);
  pinnableListeners.forEach((l) => l());
}

/** A page lists what can be pinned. Cheap to call every render; compared by kind/label/detail. */
export function usePinnables(items: Pinnable[]) {
  const owner = useRef<symbol>(Symbol("pinnables"));
  const latest = useRef(items);
  useEffect(() => {
    latest.current = items;
  });
  const key = JSON.stringify(items.map((i) => [i.kind, i.label, i.detail]));
  useEffect(() => {
    const o = owner.current;
    pinnables = [
      ...pinnables.filter((p) => p.owner !== o),
      // Late-bound so content() reads the page's current state.
      {
        owner: o,
        items: latest.current.map((_, idx) => ({
          ...latest.current[idx],
          content: () => latest.current[idx]?.content() ?? "",
        })),
      },
    ];
    publishPinnables();
  }, [key]);
  useEffect(() => {
    const o = owner.current;
    return () => {
      pinnables = pinnables.filter((p) => p.owner !== o);
      publishPinnables();
    };
  }, []);
}

export function usePinnableList(): Pinnable[] {
  return useSyncExternalStore(
    (l) => {
      pinnableListeners.add(l);
      return () => {
        pinnableListeners.delete(l);
      };
    },
    () => pinnableSnapshot,
    () => [],
  );
}

/** Pins a pinnable (builds its content now). */
export function pinPinnable(p: Pinnable, screen?: string) {
  addPins([
    {
      kind: p.kind,
      label: p.label,
      detail: p.detail,
      screen,
      content: p.content(),
    },
  ]);
}
