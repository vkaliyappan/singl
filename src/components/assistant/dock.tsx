"use client";

// Assistant panel for every route: a drawer over the right side of the page, or a floating window
// that can be moved and resized. AssistantDock stays mounted, so chat state
// (and a running turn) survives closing the panel or switching layout.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
} from "react";
import { usePathname } from "next/navigation";
import { AssistantPanel } from "./panel";
import { useAssistantChat, type AssistantChat } from "./use-assistant-chat";

/** The full-page assistant; the side panel stays hidden there. */
export const ASSISTANT_ROUTE = "/assistant";

const DockChat = createContext<AssistantChat | null>(null);

/** The one chat state shared by the side panel and the /assistant page. */
export function useDockChat() {
  const chat = useContext(DockChat);
  if (!chat) throw new Error("useDockChat needs AssistantDock");
  return chat;
}

const OPEN_KEY = "singl.assistant.open";
const DRAWER_KEY = "singl.assistant.drawerWidth";
const FLOAT_KEY = "singl.assistant.floating";
const RECT_KEY = "singl.assistant.rect";

const listeners = new Set<() => void>();
let openState: boolean | null = null;

function readOpen() {
  if (openState === null) {
    try {
      openState = localStorage.getItem(OPEN_KEY) === "1";
    } catch {
      openState = false;
    }
  }
  return openState;
}

export function setAssistantOpen(open: boolean) {
  openState = open;
  // Something needs the assistant (a pin, an approval): bring a minimized window back.
  if (open && readWindowState() === "min") windowState = "normal";
  try {
    localStorage.setItem(OPEN_KEY, open ? "1" : "0");
  } catch {}
  listeners.forEach((l) => l());
}

export function toggleAssistant() {
  setAssistantOpen(!readOpen());
}

export function useAssistantOpen() {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => {
        listeners.delete(l);
      };
    },
    readOpen,
    () => false,
  );
}

const DRAWER_MIN = 340;
/** Share of the content area the drawer may cover at most. */
const DRAWER_MAX = 0.85;

function readDrawerWidth() {
  try {
    const n = Number(localStorage.getItem(DRAWER_KEY));
    return n >= DRAWER_MIN ? n : 460;
  } catch {
    return 460;
  }
}

/**
 * The assistant as a sheet over the right side of the page: the page keeps its
 * full width underneath and stays usable. Drag the left edge to resize.
 */
function Drawer({ children }: { children: React.ReactNode }) {
  const [width, setWidth] = useState(readDrawerWidth);
  useEffect(() => {
    try {
      localStorage.setItem(DRAWER_KEY, String(Math.round(width)));
    } catch {}
  }, [width]);

  const onResizeStart = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const area = e.currentTarget.parentElement?.parentElement?.getBoundingClientRect();
    const max = (area?.width ?? window.innerWidth) * DRAWER_MAX;
    const right = area?.right ?? window.innerWidth;
    const move = (ev: PointerEvent) => setWidth(Math.min(max, Math.max(DRAWER_MIN, right - ev.clientX)));
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return (
    <div
      role="complementary"
      aria-label="Assistant"
      className="absolute inset-y-0 right-0 z-40 flex max-w-[85%] border-l bg-background shadow-2xl duration-200 animate-in slide-in-from-right"
      style={{ width }}
    >
      <div
        aria-hidden
        title="Drag to resize"
        className="absolute inset-y-0 left-0 z-50 w-1.5 -translate-x-1/2 cursor-ew-resize hover:bg-primary/30"
        onPointerDown={onResizeStart}
      />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

type Rect = { x: number; y: number; w: number; h: number };

const MIN_W = 320;
const MIN_H = 360;
/** Pixels of the window that must stay on screen. */
const KEEP = 48;
/** The app's own title bar (window buttons): the assistant stays below it. */
const TITLE_BAR = 44;

/** Keeps the window's size sane and its header reachable. */
function clampRect(r: Rect): Rect {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const w = Math.min(Math.max(r.w, MIN_W), vw);
  const h = Math.min(Math.max(r.h, MIN_H), vh);
  return {
    w,
    h,
    x: Math.min(Math.max(r.x, KEEP - w), vw - KEEP),
    y: Math.min(Math.max(r.y, TITLE_BAR), vh - KEEP),
  };
}

function readRect(): Rect {
  try {
    const r = JSON.parse(localStorage.getItem(RECT_KEY) ?? "null") as Rect | null;
    if (r && [r.x, r.y, r.w, r.h].every(Number.isFinite)) return clampRect(r);
  } catch {}
  const w = 440;
  const h = Math.min(680, window.innerHeight - 96);
  return clampRect({ w, h, x: window.innerWidth - w - 24, y: 72 });
}

/** The floating window: its normal size, folded down to its header, or filling the app. */
export type WindowState = "normal" | "min" | "max";
const WINDOW_KEY = "singl.assistant.window";
let windowState: WindowState | null = null;

function readWindowState(): WindowState {
  if (windowState === null) {
    try {
      const v = localStorage.getItem(WINDOW_KEY);
      windowState = v === "min" || v === "max" ? v : "normal";
    } catch {
      windowState = "normal";
    }
  }
  return windowState;
}

function setWindowState(next: WindowState) {
  windowState = next;
  try {
    localStorage.setItem(WINDOW_KEY, next);
  } catch {}
  listeners.forEach((l) => l());
}

function useWindowState() {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => {
        listeners.delete(l);
      };
    },
    readWindowState,
    () => "normal" as WindowState,
  );
}

let floatingState: boolean | null = null;

function readFloating() {
  if (floatingState === null) {
    try {
      floatingState = localStorage.getItem(FLOAT_KEY) === "1";
    } catch {
      floatingState = false;
    }
  }
  return floatingState;
}

function toggleFloating() {
  floatingState = !readFloating();
  try {
    localStorage.setItem(FLOAT_KEY, floatingState ? "1" : "0");
  } catch {}
  listeners.forEach((l) => l());
}

function useFloating() {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => {
        listeners.delete(l);
      };
    },
    readFloating,
    () => false,
  );
}

/** Which edges a resize handle moves. */
type Edges = { l?: boolean; r?: boolean; t?: boolean; b?: boolean };

const HANDLES: { edges: Edges; className: string }[] = [
  { edges: { l: true }, className: "left-0 top-3 bottom-3 w-1.5 cursor-ew-resize" },
  { edges: { r: true }, className: "right-0 top-3 bottom-3 w-1.5 cursor-ew-resize" },
  { edges: { t: true }, className: "top-0 left-3 right-3 h-1.5 cursor-ns-resize" },
  { edges: { b: true }, className: "bottom-0 left-3 right-3 h-1.5 cursor-ns-resize" },
  { edges: { l: true, t: true }, className: "left-0 top-0 size-3 cursor-nwse-resize" },
  { edges: { r: true, t: true }, className: "right-0 top-0 size-3 cursor-nesw-resize" },
  { edges: { l: true, b: true }, className: "left-0 bottom-0 size-3 cursor-nesw-resize" },
  { edges: { r: true, b: true }, className: "right-0 bottom-0 size-3 cursor-nwse-resize" },
];

/** The assistant as a window over the page: drag by the header, resize from any edge. */
/** Height of the panel header plus borders: what a minimized window shows. */
const HEADER_H = 42;

type WindowControls = {
  state: WindowState;
  onDragStart: (e: React.PointerEvent) => void;
  onMinimize: () => void;
  onMaximize: () => void;
};

function FloatingWindow({ children }: { children: (c: WindowControls) => React.ReactNode }) {
  const [rect, setRect] = useState<Rect>(readRect);
  const state = useWindowState();

  useEffect(() => {
    try {
      localStorage.setItem(RECT_KEY, JSON.stringify(rect));
    } catch {}
  }, [rect]);

  useEffect(() => {
    const onResize = () => setRect((r) => clampRect(r));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  /** Follows the pointer until release, mapping its movement to a new rect. */
  const track = (e: React.PointerEvent, next: (start: Rect, dx: number, dy: number) => Rect) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const start = rect;
    const sx = e.clientX;
    const sy = e.clientY;
    const move = (ev: PointerEvent) => setRect(clampRect(next(start, ev.clientX - sx, ev.clientY - sy)));
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  // A maximized window stays put; minimized and normal ones move.
  const onDragStart = (e: React.PointerEvent) => {
    if (state !== "max") track(e, (s, dx, dy) => ({ ...s, x: s.x + dx, y: s.y + dy }));
  };

  const onResizeStart = (e: React.PointerEvent, edges: Edges) =>
    track(e, (s, dx, dy) => {
      let { x, y, w, h } = s;
      if (edges.r) w = Math.max(MIN_W, s.w + dx);
      if (edges.b) h = Math.max(MIN_H, s.h + dy);
      if (edges.l) {
        w = Math.max(MIN_W, s.w - dx);
        x = s.x + s.w - w;
      }
      if (edges.t) {
        h = Math.max(MIN_H, s.h - dy);
        y = s.y + s.h - h;
      }
      return { x, y, w, h };
    });

  const box =
    state === "max"
      ? { left: 8, top: TITLE_BAR, right: 8, bottom: 8 }
      : state === "min"
        ? { left: rect.x, top: rect.y, width: Math.min(rect.w, 360), height: HEADER_H }
        : { left: rect.x, top: rect.y, width: rect.w, height: rect.h };

  return (
    <div
      role="dialog"
      aria-label="Assistant"
      className="fixed z-40 overflow-hidden rounded-xl border bg-background shadow-2xl"
      style={box}
    >
      {children({
        state,
        onDragStart,
        onMinimize: () => setWindowState(state === "min" ? "normal" : "min"),
        onMaximize: () => setWindowState(state === "max" ? "normal" : "max"),
      })}
      {state === "normal" && HANDLES.map((hd, i) => (
        <div
          key={i}
          aria-hidden
          className={`absolute z-50 ${hd.className}`}
          onPointerDown={(e) => onResizeStart(e, hd.edges)}
        />
      ))}
    </div>
  );
}

export function AssistantDock({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const onPage = pathname === ASSISTANT_ROUTE;
  const open = useAssistantOpen() && !onPage;
  const close = useCallback(() => setAssistantOpen(false), []);
  const floating = useFloating();
  const chat = useAssistantChat({
    onNeedPanel: () => setAssistantOpen(true),
    panelOpen: open || onPage,
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (
        (e.ctrlKey || e.metaKey) &&
        !e.shiftKey &&
        !e.altKey &&
        e.key.toLowerCase() === "j"
      ) {
        e.preventDefault();
        toggleAssistant();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <DockChat.Provider value={chat}>
      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
        {children}
        {open && !floating && (
          <Drawer>
            <AssistantPanel
              chat={chat}
              onClose={close}
              layout={{ floating: false, onToggleFloating: toggleFloating }}
            />
          </Drawer>
        )}
      </div>
      {open && floating && (
        <FloatingWindow>
          {(w) => (
            <AssistantPanel
              chat={chat}
              onClose={close}
              layout={{ floating: true, onToggleFloating: toggleFloating, ...w }}
            />
          )}
        </FloatingWindow>
      )}
    </DockChat.Provider>
  );
}
