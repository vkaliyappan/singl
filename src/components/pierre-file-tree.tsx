"use client";

import { useEffect, useLayoutEffect, useRef, type CSSProperties, type ReactNode } from "react";
import { IconChevronRight, IconFoldDown, IconFoldUp } from "@tabler/icons-react";
import type {
  FileTree as FileTreeModel,
  ContextMenuItem as FileTreeContextMenuItem,
  ContextMenuOpenContext as FileTreeContextMenuOpenContext,
  FileTreeDirectoryHandle,
  FileTreeIcons,
  FileTreeOptions,
  GitStatusEntry,
} from "@pierre/trees";
import { FileTree, useFileTree } from "@pierre/trees/react";
import { cn } from "@/lib/utils";

export type { FileTreeModel, FileTreeContextMenuItem, FileTreeContextMenuOpenContext, GitStatusEntry };

/** The folder handle at `path`, or null for files and unknown paths. */
export function getTreeFolder(model: FileTreeModel, path: string): FileTreeDirectoryHandle | null {
  const item = model.getItem(path);
  return item?.isDirectory() ? (item as FileTreeDirectoryHandle) : null;
}

// The built-in icon set has nothing for XML (every ThingWorx entity export),
// so it gets its own symbol; other gaps borrow the closest built-in icon.
const APP_ICONS: FileTreeIcons = {
  set: "complete",
  colored: true,
  spriteSheet: `<svg xmlns="http://www.w3.org/2000/svg" width="0" height="0" aria-hidden="true" style="position:absolute"><symbol id="app-icon-xml" viewBox="0 0 24 24" fill="none" stroke="#F4A460" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3v4a1 1 0 0 0 1 1h4"/><path d="M17 21h-10a2 2 0 0 1 -2 -2v-14a2 2 0 0 1 2 -2h7l5 5v11a2 2 0 0 1 -2 2z"/><path d="M10 13l-1 2l1 2"/><path d="M14 13l1 2l-1 2"/></symbol></svg>`,
  byFileExtension: {
    xml: "app-icon-xml",
    sql: "file-tree-builtin-database",
    csv: "file-tree-builtin-table",
    log: "file-tree-builtin-text",
  },
};

// The library keeps a full-width scrollbar gutter even when nothing scrolls,
// leaving an empty strip down the right edge; use a thin, on-demand one.
const TREE_CSS = `[data-file-tree-virtualized-scroll] { scrollbar-gutter: auto; scrollbar-width: thin; }`;

// The tree renders in a shadow root, so Tailwind classes can't reach it; the
// app's theme tokens still cascade in as CSS variables.
const TREE_STYLE = {
  height: "100%",
  "--trees-bg-override": "transparent",
  "--trees-fg-override": "var(--foreground)",
  "--trees-fg-muted-override": "var(--muted-foreground)",
  "--trees-bg-muted-override": "color-mix(in oklch, var(--accent) 40%, transparent)",
  "--trees-selected-bg-override": "var(--accent)",
  "--trees-selected-fg-override": "var(--accent-foreground)",
  "--trees-accent-override": "var(--primary)",
  "--trees-border-color-override": "var(--border)",
  "--trees-input-bg-override": "var(--background)",
  "--trees-font-family-override": "inherit",
  "--trees-font-size-override": "12px",
  // Rows run nearly edge to edge, like the editor sidebars.
  "--trees-padding-inline-override": "6px",
} as CSSProperties;

/** Every folder the paths pass through, as "a/", "a/b/", ... */
export function folderPaths(paths: readonly string[]): string[] {
  const folders = new Set<string>();
  for (const p of paths) {
    for (let i = p.indexOf("/"); i !== -1; i = p.indexOf("/", i + 1)) {
      folders.add(p.slice(0, i + 1));
    }
  }
  return [...folders];
}

export type AppFileTreeOptions = Omit<FileTreeOptions, "paths" | "preparedInput" | "onSelectionChange"> & {
  /** Tree paths; folders end in "/". Changing the array resets the tree. */
  paths: readonly string[];
  /** Path to show as selected (e.g. the active editor tab); null clears it. */
  activePath?: string | null;
  /** A single file was picked in the tree (click, Enter, or search). */
  onFileOpen?: (path: string) => void;
  /** Every selection change, including multi-select. */
  onSelectionChange?: (paths: readonly string[]) => void;
  gitStatus?: readonly GitStatusEntry[];
  /** Open folders changed (by the user, expand/collapse all, or a reset). */
  onExpandedChange?: (expandedFolders: string[]) => void;
};

/** Folders of `paths` that are open in `model`. */
function expandedFolders(model: FileTreeModel, paths: readonly string[]): string[] {
  return folderPaths(paths).filter((p) => getTreeFolder(model, p)?.isExpanded());
}

/**
 * `@pierre/trees` with the app's defaults: built-in search, sticky and
 * flattened folders, colored icons, a right-click/button context menu.
 * The model reads options once, so callbacks are kept current through a ref
 * and `paths`, `gitStatus` and `activePath` are pushed in as they change.
 * Open folders survive `paths` changes; with `initialExpansion: "open"`, new
 * folders open too and only the ones the user closed stay closed.
 */
export function useAppFileTree({
  paths,
  activePath = null,
  onFileOpen,
  onSelectionChange,
  gitStatus,
  onExpandedChange,
  ...options
}: AppFileTreeOptions) {
  const latest = useRef({ activePath, onFileOpen, onSelectionChange, onExpandedChange });
  useLayoutEffect(() => {
    latest.current = { activePath, onFileOpen, onSelectionChange, onExpandedChange };
  });

  const { model } = useFileTree({
    paths,
    gitStatus,
    density: "compact",
    flattenEmptyDirectories: true,
    stickyFolders: true,
    icons: APP_ICONS,
    search: true,
    fileTreeSearchMode: "hide-non-matches",
    ...options,
    unsafeCSS: options.unsafeCSS ? `${TREE_CSS}\n${options.unsafeCSS}` : TREE_CSS,
    composition: {
      // Right-click only: a row button would reserve a lane at the end of every row.
      contextMenu: { enabled: true, triggerMode: "right-click" },
      ...options.composition,
    },
    onSelectionChange: (selected) => {
      const { activePath, onFileOpen, onSelectionChange } = latest.current;
      onSelectionChange?.(selected);
      if (selected.length !== 1 || selected[0].endsWith("/")) return;
      if (selected[0] !== activePath) onFileOpen?.(selected[0]);
    },
  });

  const pathsRef = useRef(paths);
  useEffect(() => {
    if (pathsRef.current === paths) return;
    const previous = pathsRef.current;
    pathsRef.current = paths;
    const open = expandedFolders(model, previous);
    if (options.initialExpansion === "open") {
      const openSet = new Set(open);
      const closed = new Set(folderPaths(previous).filter((p) => !openSet.has(p)));
      model.resetPaths(paths, { initialExpandedPaths: folderPaths(paths).filter((p) => !closed.has(p)) });
    } else {
      model.resetPaths(paths, { initialExpandedPaths: open });
    }
  }, [model, paths, options.initialExpansion]);

  // Report open folders only when they actually change.
  useEffect(() => {
    let last = "";
    const report = () => {
      const listener = latest.current.onExpandedChange;
      if (!listener) return;
      const open = expandedFolders(model, pathsRef.current);
      const key = open.join("\n");
      if (key === last) return;
      last = key;
      listener(open);
    };
    report();
    return model.subscribe(report);
  }, [model]);

  const gitStatusRef = useRef(gitStatus);
  useEffect(() => {
    if (gitStatusRef.current === gitStatus) return;
    gitStatusRef.current = gitStatus;
    model.setGitStatus(gitStatus);
  }, [model, gitStatus]);

  // Reflect outside selection changes (tab switches, restored tabs).
  useEffect(() => {
    for (const p of model.getSelectedPaths()) {
      if (p !== activePath) model.getItem(p)?.deselect();
    }
    const item = activePath ? model.getItem(activePath) : null;
    if (item && !item.isSelected()) {
      item.select();
      model.scrollToPath(activePath!);
    }
  }, [model, activePath, paths]);

  const expandAll = () =>
    model.resetPaths(pathsRef.current, { initialExpandedPaths: folderPaths(pathsRef.current) });
  const collapseAll = () => model.resetPaths(pathsRef.current, { initialExpandedPaths: [] });

  /** Re-draws row decorations after the state they read from changed. */
  const refreshDecorations = () => model.setComposition(model.getComposition());

  return { model, expandAll, collapseAll, refreshDecorations };
}

/** Title row with a count and expand/collapse-all buttons, for the tree's `header`. */
export function AppFileTreeHeader({
  title,
  count,
  onExpandAll,
  onCollapseAll,
  icon,
  children,
}: {
  title: ReactNode;
  count?: ReactNode;
  onExpandAll?: () => void;
  onCollapseAll?: () => void;
  icon?: ReactNode;
  /** Extra rows under the title (filters, toolbars). */
  children?: ReactNode;
}) {
  return (
    <div className="select-none">
      <div className="flex items-center justify-between gap-2 px-2.5 py-1">
        <div className="flex items-center gap-1.5 min-w-0">
          {icon ?? <IconChevronRight className="size-3 shrink-0 text-muted-foreground rotate-90" />}
          <span className="text-[11px] font-semibold text-foreground uppercase tracking-wider truncate">
            {title}
          </span>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {count != null && (
            <span className="text-[10px] text-muted-foreground font-mono mr-1">{count}</span>
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
      {children}
    </div>
  );
}

/** Popover shell for `renderContextMenu`. */
export function AppFileTreeMenu({ children }: { children: ReactNode }) {
  return (
    <div className="min-w-44 rounded-md border bg-popover p-1 text-popover-foreground shadow-md">
      {children}
    </div>
  );
}

export function AppFileTreeMenuItem({
  icon,
  children,
  onClick,
  destructive,
  disabled,
}: {
  icon?: ReactNode;
  children: ReactNode;
  onClick: () => void;
  destructive?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "flex w-full items-center gap-2 rounded-sm px-2 py-1 text-left text-xs cursor-pointer",
        "[&_svg]:size-3.5 [&_svg]:shrink-0 disabled:pointer-events-none disabled:opacity-50",
        destructive
          ? "text-destructive hover:bg-destructive/10 [&_svg]:text-destructive"
          : "hover:bg-accent hover:text-accent-foreground [&_svg]:text-muted-foreground"
      )}
    >
      {icon}
      {children}
    </button>
  );
}

export function AppFileTreeMenuSeparator() {
  return <div className="-mx-1 my-1 h-px bg-border" />;
}

/** The tree itself; fills its container and scrolls on its own. */
export function AppFileTree({
  model,
  header,
  renderContextMenu,
  className,
  style,
}: {
  model: FileTreeModel;
  header?: ReactNode;
  renderContextMenu?: (item: FileTreeContextMenuItem, context: FileTreeContextMenuOpenContext) => ReactNode;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <FileTree
      model={model}
      header={header}
      renderContextMenu={renderContextMenu}
      className={className}
      style={{ ...TREE_STYLE, ...style }}
    />
  );
}
