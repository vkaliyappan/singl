import type { Layout } from "react-resizable-panels";

/**
 * The board/assistant split, kept in a cookie rather than `localStorage` so the
 * server renders the same sizes the browser will: otherwise hydration fails.
 */
export const ASSISTANT_LAYOUT_COOKIE = "twx-flow-assistant-layout";
/** The same split on the entity explorer, which has its own panels. */
export const ENTITIES_ASSISTANT_LAYOUT_COOKIE = "twx-entities-assistant-layout";

const ONE_YEAR = 60 * 60 * 24 * 365;

/** A saved layout, or undefined when the cookie is missing or malformed. */
export function parseAssistantLayout(value: string | undefined): Layout | undefined {
  if (!value) return undefined;
  try {
    const parsed: unknown = JSON.parse(decodeURIComponent(value));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const entries = Object.entries(parsed);
    if (!entries.length || !entries.every(([, v]) => typeof v === "number" && Number.isFinite(v))) {
      return undefined;
    }
    return Object.fromEntries(entries) as Layout;
  } catch {
    return undefined;
  }
}

/** Browser only: remembers the layout for the next page load. */
export function saveAssistantLayout(layout: Layout, cookie = ASSISTANT_LAYOUT_COOKIE) {
  const value = encodeURIComponent(JSON.stringify(layout));
  document.cookie = `${cookie}=${value}; path=/; max-age=${ONE_YEAR}; samesite=lax`;
}
