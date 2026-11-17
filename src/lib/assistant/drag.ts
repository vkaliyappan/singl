// Drag explorer files and folders onto the assistant to attach them. The
// payload rides on a custom MIME type; data is only readable on drop, so
// dragover checks `types` through `hasDragPaths`.

export const SINGL_PATHS_MIME = "application/x-singl-paths";

export type DragPath = { path: string; isDir: boolean };

export function setDragPaths(e: DragEvent, items: DragPath[]) {
  const dt = e.dataTransfer;
  if (!dt || items.length === 0) return;
  dt.setData(SINGL_PATHS_MIME, JSON.stringify(items));
  dt.setData("text/plain", items.map((i) => i.path).join("\n"));
  dt.effectAllowed = "copy";
}

export function hasDragPaths(e: DragEvent | React.DragEvent) {
  return !!e.dataTransfer?.types.includes(SINGL_PATHS_MIME);
}

export function readDragPaths(e: DragEvent | React.DragEvent): DragPath[] {
  try {
    const raw = e.dataTransfer?.getData(SINGL_PATHS_MIME);
    const v: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(v)) return [];
    return v.flatMap((x) =>
      x && typeof x.path === "string"
        ? [{ path: x.path as string, isDir: !!x.isDir }]
        : [],
    );
  } catch {
    return [];
  }
}

// Pins dragged from a screen (services, results...) onto the assistant.
export const SINGL_PINS_MIME = "application/x-singl-pins";

export type DragPin = {
  kind: string;
  label: string;
  screen?: string;
  content: string;
  detail?: string;
};

export function setDragPins(e: DragEvent | React.DragEvent, pins: DragPin[]) {
  const dt = e.dataTransfer;
  if (!dt || pins.length === 0) return;
  dt.setData(SINGL_PINS_MIME, JSON.stringify(pins));
  dt.setData("text/plain", pins.map((p) => p.label).join("\n"));
  dt.effectAllowed = "copy";
}

export function hasDragPins(e: DragEvent | React.DragEvent) {
  return !!e.dataTransfer?.types.includes(SINGL_PINS_MIME);
}

export function readDragPins(e: DragEvent | React.DragEvent): DragPin[] {
  try {
    const raw = e.dataTransfer?.getData(SINGL_PINS_MIME);
    const v: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(v)) return [];
    return v.flatMap((x) =>
      x && typeof x.kind === "string" && typeof x.label === "string"
        ? [
            {
              kind: x.kind as string,
              label: x.label as string,
              screen: typeof x.screen === "string" ? x.screen : undefined,
              content: typeof x.content === "string" ? x.content : "",
              detail: typeof x.detail === "string" ? x.detail : undefined,
            },
          ]
        : [],
    );
  } catch {
    return [];
  }
}
