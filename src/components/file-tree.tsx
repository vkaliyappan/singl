"use client";

import { useLayoutEffect, useRef, type ReactNode } from "react";
import { useFileTreeSelector } from "@pierre/trees/react";
import {
  IconFile,
  IconFileCode,
  IconFileText,
  IconFoldDown,
  IconFoldUp,
  IconSearch,
  IconX,
  IconFileTypeTs,
  IconFileTypeTsx,
  IconFileTypeJs,
  IconFileTypeJsx,
  IconFileTypeHtml,
  IconFileTypeCss,
  IconFileTypeSvg,
  IconFileTypeRs,
  IconFileTypeSql,
  IconFileTypeTxt,
  IconFileTypePhp,
  IconFileTypeVue,
  IconFileTypeCsv,
  IconFileTypePdf,
  IconFileTypePng,
  IconFileTypeJpg,
  IconBrandPython,
  IconBrandGolang,
  IconBrandKotlin,
  IconBrandSwift,
  IconBrandGraphql,
  IconBrandSass,
  IconBrandPrisma,
  IconBrandDocker,
  IconBrandPowershell,
} from "@tabler/icons-react";
import type { DragPath } from "@/lib/assistant/drag";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  AppFileTree,
  AppFileTreeMenu,
  AppFileTreeMenuItem,
  useAppFileTree,
} from "@/components/pierre-file-tree";

export const LANGUAGE_MAP: Record<string, string> = {
  ts: "typescript", tsx: "typescript",
  js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  json: "json", jsonc: "json",
  py: "python", rb: "ruby", go: "go", rs: "rust",
  java: "java", kt: "kotlin", scala: "scala",
  c: "c", cpp: "cpp", h: "c", hpp: "cpp", cs: "csharp",
  php: "php", swift: "swift",
  html: "html", css: "css", scss: "scss", sass: "scss", less: "less",
  md: "markdown", mdx: "markdown",
  yaml: "yaml", yml: "yaml",
  xml: "xml", svg: "xml",
  sql: "sql", graphql: "graphql", gql: "graphql",
  sh: "shell", bash: "shell", zsh: "shell",
  ps1: "powershell", bat: "bat",
  dockerfile: "dockerfile",
  toml: "ini", ini: "ini", env: "ini",
  prisma: "graphql",
};

export function getLanguage(filePath: string): string {
  const name = filePath.split("/").pop()?.toLowerCase() ?? "";
  if (name === "dockerfile" || name === ".dockerignore") return "dockerfile";
  if (name === ".gitignore" || name === ".gitattributes") return "ini";
  const ext = name.split(".").pop() ?? "";
  return LANGUAGE_MAP[ext] ?? "plaintext";
}

/** True for ThingWorx Mashup entity exports: .xml files inside a Mashups/ folder. */
export function isMashupFile(filePath: string): boolean {
  return (
    filePath.toLowerCase().endsWith(".xml") &&
    filePath.split(/[\\/]/).includes("Mashups")
  );
}

export function FileIcon({ name, className }: { name: string; className?: string }) {
  const lowerName = name.toLowerCase();

  if (lowerName === "dockerfile" || lowerName === ".dockerignore") {
    return <IconBrandDocker className={className} style={{ color: "#0DB7ED" }} />;
  }
  if (lowerName.startsWith(".env")) {
    return <IconFileCode className={className} style={{ color: "#ECD53F" }} />;
  }

  const ext = lowerName.split(".").pop() ?? "";
  switch (ext) {
    case "ts":      return <IconFileTypeTs      className={className} style={{ color: "#3178C6" }} />;
    case "tsx":     return <IconFileTypeTsx     className={className} style={{ color: "#3178C6" }} />;
    case "js":
    case "mjs":
    case "cjs":     return <IconFileTypeJs      className={className} style={{ color: "#F0DB4F" }} />;
    case "jsx":     return <IconFileTypeJsx     className={className} style={{ color: "#F0DB4F" }} />;
    case "html":
    case "htm":     return <IconFileTypeHtml    className={className} style={{ color: "#E44D26" }} />;
    case "css":     return <IconFileTypeCss     className={className} style={{ color: "#2965F1" }} />;
    case "scss":
    case "sass":    return <IconBrandSass       className={className} style={{ color: "#C76494" }} />;
    case "svg":     return <IconFileTypeSvg     className={className} style={{ color: "#FFB13B" }} />;
    case "py":      return <IconBrandPython     className={className} style={{ color: "#4B8BBE" }} />;
    case "go":      return <IconBrandGolang     className={className} style={{ color: "#00ACD7" }} />;
    case "rs":      return <IconFileTypeRs      className={className} style={{ color: "#DEA584" }} />;
    case "kt":      return <IconBrandKotlin     className={className} style={{ color: "#A97BFF" }} />;
    case "swift":   return <IconBrandSwift      className={className} style={{ color: "#F05138" }} />;
    case "php":     return <IconFileTypePhp     className={className} style={{ color: "#8892BF" }} />;
    case "graphql":
    case "gql":     return <IconBrandGraphql    className={className} style={{ color: "#E535AB" }} />;
    case "prisma":  return <IconBrandPrisma     className={className} style={{ color: "#5A67D8" }} />;
    case "ps1":     return <IconBrandPowershell className={className} style={{ color: "#5391FE" }} />;
    case "vue":     return <IconFileTypeVue     className={className} style={{ color: "#41B883" }} />;
    case "sql":     return <IconFileTypeSql     className={className} style={{ color: "#DA70D6" }} />;
    case "csv":     return <IconFileTypeCsv     className={className} style={{ color: "#89E051" }} />;
    case "pdf":     return <IconFileTypePdf     className={className} style={{ color: "#F40F02" }} />;
    case "png":     return <IconFileTypePng     className={className} style={{ color: "#4CAF50" }} />;
    case "jpg":
    case "jpeg":    return <IconFileTypeJpg     className={className} style={{ color: "#FF9800" }} />;
    case "md":
    case "mdx":     return <IconFileText        className={className} style={{ color: "#519ABA" }} />;
    case "txt":
    case "log":     return <IconFileTypeTxt     className={className} style={{ color: "#9DA5B4" }} />;
    case "json":
    case "jsonc":   return <IconFileCode        className={className} style={{ color: "#CBCB41" }} />;
    case "xml":     return <IconFileCode        className={className} style={{ color: "#F4A460" }} />;
    case "yaml":
    case "yml":     return <IconFileCode        className={className} style={{ color: "#CB171E" }} />;
    case "toml":
    case "ini":     return <IconFileCode        className={className} style={{ color: "#9C4221" }} />;
    case "env":     return <IconFileCode        className={className} style={{ color: "#ECD53F" }} />;
    case "sh":
    case "bash":
    case "zsh":     return <IconFileCode        className={className} style={{ color: "#89E051" }} />;
    case "bat":     return <IconFileCode        className={className} style={{ color: "#A0A0A0" }} />;
    case "java":    return <IconFileCode        className={className} style={{ color: "#B07219" }} />;
    case "rb":      return <IconFileCode        className={className} style={{ color: "#CC342D" }} />;
    case "scala":   return <IconFileCode        className={className} style={{ color: "#DC322F" }} />;
    case "c":       return <IconFileCode        className={className} style={{ color: "#00599C" }} />;
    case "cpp":     return <IconFileCode        className={className} style={{ color: "#00599C" }} />;
    case "h":
    case "hpp":     return <IconFileCode        className={className} style={{ color: "#A0A0A0" }} />;
    case "cs":      return <IconFileCode        className={className} style={{ color: "#512BD4" }} />;
    case "less":    return <IconFileCode        className={className} style={{ color: "#1D365D" }} />;
    default:        return <IconFile            className={className} style={{ color: "#9DA5B4" }} />;
  }
}

/** Most rows the open-editors tree shows before it scrolls. */
const OPEN_EDITORS_MAX_ROWS = 8;

/**
 * Open editor tabs as a small `@pierre/trees` tree, grouped by folder.
 * Right-click (or the row button) to close one, the others, or all.
 */
export function OpenEditorsPanel({
  openPaths,
  activePath,
  onSelect,
  onClose,
  onCloseAll,
  getDecoration,
  dragItems,
}: {
  openPaths: string[];
  activePath: string | null;
  onSelect: (path: string) => void;
  onClose: (path: string) => void;
  onCloseAll: () => void;
  /** Short badge shown at the end of a row, e.g. an entity type. */
  getDecoration?: (path: string) => { text: string; title?: string } | null;
  /** Makes rows draggable onto the assistant; see `useAppFileTree`. */
  dragItems?: (treePaths: string[]) => DragPath[];
}) {
  const decorate = useRef(getDecoration);
  useLayoutEffect(() => {
    decorate.current = getDecoration;
  });

  const { model } = useAppFileTree({
    paths: openPaths,
    activePath,
    onFileOpen: onSelect,
    dragItems,
    initialExpansion: "open",
    stickyFolders: false,
    search: false,
    renderRowDecoration: ({ item }) =>
      item.kind === "file" ? (decorate.current?.(item.path) ?? null) : null,
  });
  const rows = useFileTreeSelector(model, (m) => m.getVisibleCount());

  if (openPaths.length === 0) return null;
  return (
    <div className="shrink-0 border-b">
      <div className="px-3 py-1.5 flex items-center justify-between">
        <span className="text-[10px] font-semibold tracking-widest text-muted-foreground uppercase select-none">
          Open Editors
        </span>
        <button
          onClick={onCloseAll}
          title="Close All Editors"
          className="text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
        >
          <IconX className="size-3.5" />
        </button>
      </div>
      <div style={{ height: Math.min(rows, OPEN_EDITORS_MAX_ROWS) * model.getItemHeight() + 4 }}>
        <AppFileTree
          model={model}
          renderContextMenu={(item, context) => {
            const run = (action: () => void) => () => {
              context.close();
              action();
            };
            const files =
              item.kind === "file"
                ? [item.path]
                : openPaths.filter((p) => p.startsWith(item.path));
            return (
              <AppFileTreeMenu>
                <AppFileTreeMenuItem icon={<IconX />} onClick={run(() => files.forEach(onClose))}>
                  {item.kind === "file" ? "Close" : "Close Folder"}
                </AppFileTreeMenuItem>
                <AppFileTreeMenuItem
                  icon={<IconX />}
                  disabled={files.length === openPaths.length}
                  onClick={run(() => openPaths.filter((p) => !files.includes(p)).forEach(onClose))}
                >
                  Close Others
                </AppFileTreeMenuItem>
                <AppFileTreeMenuItem icon={<IconX />} onClick={run(onCloseAll)}>
                  Close All
                </AppFileTreeMenuItem>
              </AppFileTreeMenu>
            );
          }}
        />
      </div>
    </div>
  );
}

export function FileTreePanel({
  onCollapseAll,
  onExpandAll,
  header,
  children,
  openEditors,
  isSearchActive,
  onSearchToggle,
  searchContent,
  scrollable = true,
}: {
  onCollapseAll?: () => void;
  onExpandAll?: () => void;
  header?: ReactNode;
  children: ReactNode;
  openEditors?: ReactNode;
  isSearchActive?: boolean;
  onSearchToggle?: () => void;
  searchContent?: ReactNode;
  /** False when `children` scroll themselves (e.g. a virtualized tree). */
  scrollable?: boolean;
}) {
  if (isSearchActive) {
    return (
      <>
        <div className="shrink-0 px-3 py-1.5 border-b flex items-center justify-between">
          <span className="text-[10px] font-semibold tracking-widest text-muted-foreground uppercase select-none">
            Search
          </span>
          <button
            onClick={onSearchToggle}
            title="Back to Explorer"
            className="text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
          >
            <IconX className="size-3.5" />
          </button>
        </div>
        <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
          {searchContent}
        </div>
      </>
    );
  }

  return (
    <>
      {openEditors}
      <div className="shrink-0 px-3 py-1.5 border-b flex items-center justify-between">
        <span className="text-[10px] font-semibold tracking-widest text-muted-foreground uppercase select-none">
          Explorer
        </span>
        <div className="flex items-center gap-1">
          {onSearchToggle && (
            <button
              onClick={onSearchToggle}
              title="Search (Ctrl+Shift+F)"
              className="text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
            >
              <IconSearch className="size-3.5" />
            </button>
          )}
          {onExpandAll && (
            <button
              onClick={onExpandAll}
              title="Expand All"
              className="text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
            >
              <IconFoldDown className="size-3.5" />
            </button>
          )}
          {onCollapseAll && (
            <button
              onClick={onCollapseAll}
              title="Collapse All"
              className="text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
            >
              <IconFoldUp className="size-3.5" />
            </button>
          )}
        </div>
      </div>
      {header}
      {scrollable ? (
        <ScrollArea className="flex-1 min-h-0">
          {children}
        </ScrollArea>
      ) : (
        <div className="flex-1 min-h-0">{children}</div>
      )}
    </>
  );
}

/** Drag type of a tree entry; the data is `TreeDragData` as JSON. */
export const TREE_DRAG_MIME = "application/x-singl-tree-entry";

export type TreeDragData = { path: string; type: "file" | "dir" };

/** Reads a dropped tree entry, or null when the drop was something else. */
export function readTreeDrag(data: DataTransfer): TreeDragData | null {
  try {
    const parsed = JSON.parse(data.getData(TREE_DRAG_MIME)) as Partial<TreeDragData>;
    if (typeof parsed.path !== "string" || !parsed.path) return null;
    return { path: parsed.path, type: parsed.type === "dir" ? "dir" : "file" };
  } catch {
    return null;
  }
}
