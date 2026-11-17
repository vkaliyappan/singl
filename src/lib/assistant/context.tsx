"use client";

// Screen awareness for the assistant. Pages call useAssistantContext() /
// useAssistantAction(); the provider merges them with the route and DOM text
// selection and pushes the result to Rust (debounced, only when changed).
// The registrations live in a module-level store so hooks need no provider
// ordering: a page's effects run before the provider's.

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from "react";
import { usePathname, useRouter } from "next/navigation";
import { isTauri } from "@/lib/clock-widget";
import { errorMessage } from "@/lib/settings";
import {
  assistantContextSet,
  assistantUiReply,
  onAssistantEvent,
  type Risk,
  type ScreenContext,
  type UiActionSpec,
} from "./api";

export type ContextPart = {
  screen?: string;
  title?: string;
  summary?: string;
  data?: unknown;
  selection?: unknown;
};

export type ActionSpec = {
  description: string;
  inputSchema?: unknown;
  risk?: Risk;
};
type ActionHandler = (args: unknown) => unknown | Promise<unknown>;

const SELECTION_LIMIT = 4000;

const store = {
  parts: new Map<symbol, ContextPart>(),
  actions: new Map<
    string,
    { spec: ActionSpec; handlerRef: { current: ActionHandler } }
  >(),
  domSelection: "",
  version: 0,
  listeners: new Set<() => void>(),
  bump() {
    this.version++;
    this.listeners.forEach((l) => l());
  },
  subscribe: (l: () => void) => {
    store.listeners.add(l);
    return () => {
      store.listeners.delete(l);
    };
  },
};

const isEmptyValue = (v: unknown) =>
  v == null ||
  v === "" ||
  (Array.isArray(v) && v.length === 0) ||
  (typeof v === "object" &&
    !Array.isArray(v) &&
    Object.keys(v as object).length === 0);

/** A page reports what is on screen. Pass a fresh object every render; it is compared by value. */
export function useAssistantContext(partial: ContextPart) {
  const id = useRef<symbol>(Symbol("assistant-context"));
  const key = JSON.stringify(partial);
  useEffect(() => {
    store.parts.set(id.current, JSON.parse(key));
    store.bump();
  }, [key]);
  useEffect(() => {
    const own = id.current;
    return () => {
      store.parts.delete(own);
      store.bump();
    };
  }, []);
}

/** Registers an action the assistant can run on this page while it is mounted. */
export function useAssistantAction(
  name: string,
  spec: ActionSpec,
  handler: ActionHandler,
) {
  const handlerRef = useRef(handler);
  useEffect(() => {
    handlerRef.current = handler;
  });
  const specKey = JSON.stringify(spec);
  useEffect(() => {
    store.actions.set(name, { spec: JSON.parse(specKey), handlerRef });
    store.bump();
    return () => {
      if (store.actions.get(name)?.handlerRef === handlerRef)
        store.actions.delete(name);
      store.bump();
    };
  }, [name, specKey]);
}

function screenForRoute(route: string) {
  const first = route.replace(/^\/+/, "").split(/[/?#]/)[0];
  return first || "home";
}

function merge(route: string): ScreenContext {
  const merged: ContextPart = {};
  let data: Record<string, unknown> = {};
  let selection: Record<string, unknown> = {};
  for (const part of store.parts.values()) {
    if (part.screen) merged.screen = part.screen;
    if (part.title) merged.title = part.title;
    if (part.summary) merged.summary = part.summary;
    if (part.data && typeof part.data === "object")
      data = { ...data, ...(part.data as object) };
    if (part.selection && typeof part.selection === "object")
      selection = { ...selection, ...(part.selection as object) };
  }
  const pageSelection = isEmptyValue(selection) ? null : selection;
  const actions: UiActionSpec[] = [...store.actions.entries()].map(
    ([name, { spec }]) => ({
      name,
      description: spec.description,
      inputSchema: spec.inputSchema ?? { type: "object", properties: {} },
      risk: spec.risk ?? "read",
    }),
  );
  return {
    route,
    screen: merged.screen ?? screenForRoute(route),
    title: merged.title ?? null,
    summary: merged.summary ?? null,
    data,
    selection:
      pageSelection ?? (store.domSelection ? { text: store.domSelection } : {}),
    actions,
  };
}

const ScreenContextValue = createContext<ScreenContext>({
  route: "/",
  screen: "home",
  actions: [],
});

/** The context the assistant currently sees (for the panel's chip). */
export const useScreenContext = () => useContext(ScreenContextValue);

/** Short human line for the chip: "Entities › Thing:Foo · 2 services selected". */
export function describeContext(ctx: ScreenContext) {
  const parts = [ctx.title || ctx.screen];
  if (ctx.summary) parts[0] = `${parts[0]} › ${ctx.summary}`;
  const sel = ctx.selection as Record<string, unknown> | null;
  if (sel && !isEmptyValue(sel)) {
    const bits: string[] = [];
    for (const [k, v] of Object.entries(sel)) {
      if (isEmptyValue(v)) continue;
      if (Array.isArray(v)) bits.push(`${v.length} ${k} selected`);
      else if (k === "text" && typeof v === "string")
        bits.push(`${v.length} chars selected`);
      else if (k === "code") bits.push("code selected");
      else bits.push(`${k} selected`);
    }
    if (bits.length) parts.push(bits.join(", "));
  }
  return parts.join(" · ");
}

export function AssistantProvider({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const version = useSyncExternalStore(
    store.subscribe,
    () => store.version,
    () => 0,
  );
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const context = useMemo(() => merge(pathname), [pathname, version]);

  // Push to Rust, debounced and only on change.
  const lastSent = useRef("");
  useEffect(() => {
    if (!isTauri()) return;
    const json = JSON.stringify(context);
    if (json === lastSent.current) return;
    const t = setTimeout(() => {
      lastSent.current = json;
      assistantContextSet(context).catch((e) =>
        console.warn("assistant_context_set failed", e),
      );
    }, 250);
    return () => clearTimeout(t);
  }, [context]);

  // DOM text selection fallback. A selection made in the page survives focus
  // moving into the assistant panel (the user is about to ask about it).
  useEffect(() => {
    let inPanel = false;
    const insidePanel = (n: Node | null) =>
      !!(n instanceof Element ? n : n?.parentElement)?.closest(
        "[data-assistant-panel]",
      );
    const onPointer = (e: Event) => {
      inPanel = insidePanel(e.target as Node);
    };
    const onChange = () => {
      const sel = window.getSelection();
      const text = sel?.toString().trim() ?? "";
      if (text) {
        if (insidePanel(sel?.anchorNode ?? null)) return;
        const clipped = text.slice(0, SELECTION_LIMIT);
        if (clipped !== store.domSelection) {
          store.domSelection = clipped;
          store.bump();
        }
      } else if (
        !inPanel &&
        !insidePanel(document.activeElement) &&
        store.domSelection
      ) {
        store.domSelection = "";
        store.bump();
      }
    };
    document.addEventListener("pointerdown", onPointer, true);
    document.addEventListener("selectionchange", onChange);
    return () => {
      document.removeEventListener("pointerdown", onPointer, true);
      document.removeEventListener("selectionchange", onChange);
    };
  }, []);

  // UI requests from the assistant: navigate and page actions. Always reply.
  const routerRef = useRef(router);
  useEffect(() => {
    routerRef.current = router;
  });
  useEffect(() => {
    if (!isTauri()) return;
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    onAssistantEvent(async (event) => {
      if (event.type !== "uiRequest") return;
      const { requestId, action } = event;
      const args = (event.args ?? {}) as Record<string, unknown>;
      try {
        if (action === "navigate") {
          const route = typeof args.route === "string" ? args.route : "";
          if (!route) throw new Error("navigate needs a route");
          routerRef.current.push(route);
          await new Promise((r) => setTimeout(r, 200)); // let the page mount and register its actions
          await assistantUiReply(requestId, true, { ok: true, route });
        } else if (action === "action") {
          const name = typeof args.action === "string" ? args.action : "";
          const entry = store.actions.get(name);
          if (!entry)
            throw new Error(`The current page has no action "${name}".`);
          const result = await entry.handlerRef.current(args.args ?? {});
          await assistantUiReply(requestId, true, result ?? { ok: true });
        } else {
          throw new Error(`Unknown UI action "${action}".`);
        }
      } catch (e) {
        await assistantUiReply(
          requestId,
          false,
          undefined,
          errorMessage(e),
        ).catch(() => {});
      }
    })
      .then((fn) => (cancelled ? fn() : (unlisten = fn)))
      .catch((e) => console.warn("assistant events unavailable", e));
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  return <ScreenContextValue value={context}>{children}</ScreenContextValue>;
}
