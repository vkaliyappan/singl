const KEY = "singl.jsonTable.pending";

/** Stash JSON for the JSON to Table page to pick up on its next mount. */
export function openInJsonTable(value: unknown): void {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(value, null, 2));
  } catch {
    /* storage unavailable or value not serialisable */
  }
}

/** Read and clear the JSON stashed by `openInJsonTable`. */
export function takePendingJson(): string | null {
  try {
    const v = sessionStorage.getItem(KEY);
    if (v !== null) sessionStorage.removeItem(KEY);
    return v;
  } catch {
    return null;
  }
}
