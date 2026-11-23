import type { ComponentType } from "react";
import {
  IconAlertOctagon,
  IconAlertTriangle,
  IconBulb,
  IconCircleCheck,
  IconHelpCircle,
  IconInfoCircle,
  IconMessageReport,
} from "@tabler/icons-react";
import { cn } from "@/lib/utils";

// Minimal structural mdast types: `mdast`/`unified` are not direct deps here.
interface MdNode {
  type: string;
  value?: string;
  children?: MdNode[];
  data?: Record<string, unknown>;
}
type MdParent = MdNode & { children: MdNode[] };

const ALIASES: Record<string, string> = {
  note: "note",
  info: "note",
  tip: "tip",
  success: "tip",
  important: "important",
  question: "important",
  warning: "warning",
  caution: "caution",
  danger: "caution",
};

const MARKER = /^\s*\[!([A-Za-z]+)\][ \t]*([^\n]*)(?:\n|$)/;

function transform(node: MdParent) {
  const para = node.children[0];
  if (para?.type !== "paragraph" || !para.children) return;
  const kids = para.children;
  const first = kids[0];
  if (!first || first.type !== "text" || typeof first.value !== "string") return;
  const m = MARKER.exec(first.value);
  const type = m && ALIASES[m[1].toLowerCase()];
  if (!m || !type) return;
  first.value = first.value.slice(m[0].length);
  if (!first.value) kids.shift();
  // A hard break right after the marker line is dropped too.
  if (kids[0]?.type === "break") kids.shift();
  if (!kids.length) node.children.shift();
  node.data = {
    ...node.data,
    hName: "aside",
    hProperties: { "data-callout": type, "data-title": m[2].trim() },
  };
}

function walk(node: MdNode) {
  if (!node.children) return;
  if (node.type === "blockquote") transform(node as MdParent);
  for (const c of node.children) walk(c);
}

/** remark plugin: GitHub-style `> [!NOTE] Title` blockquotes become `<aside>`. */
export function remarkCallouts() {
  return (tree: MdNode) => walk(tree);
}

const STYLES: Record<
  string,
  { icon: ComponentType<{ className?: string }>; box: string; text: string }
> = {
  note: {
    icon: IconInfoCircle,
    box: "border-info bg-info/10",
    text: "text-info",
  },
  tip: {
    icon: IconBulb,
    box: "border-success bg-success/10",
    text: "text-success",
  },
  important: {
    icon: IconMessageReport,
    box: "border-violet-500 bg-violet-500/10",
    text: "text-violet-600 dark:text-violet-400",
  },
  warning: {
    icon: IconAlertTriangle,
    box: "border-warning bg-warning/10",
    text: "text-warning",
  },
  caution: {
    icon: IconAlertOctagon,
    box: "border-destructive bg-destructive/10",
    text: "text-destructive",
  },
};
// Aliases a caller may pass directly to <Callout>.
STYLES.success = { ...STYLES.tip, icon: IconCircleCheck };
STYLES.info = STYLES.note;
STYLES.danger = STYLES.caution;
STYLES.question = { ...STYLES.important, icon: IconHelpCircle };

export function Callout({
  type,
  title,
  children,
}: {
  type: string;
  title?: string;
  children: React.ReactNode;
}) {
  const key = type.toLowerCase();
  const s = STYLES[key] ?? STYLES.note;
  const Icon = s.icon;
  const label = title || key.charAt(0).toUpperCase() + key.slice(1);
  return (
    <aside
      className={cn("my-2 rounded-md border-l-4 px-3 py-2 text-[13px]", s.box)}
    >
      <div className={cn("mb-1 flex items-center gap-1.5 font-semibold", s.text)}>
        <Icon className="size-4 shrink-0" />
        <span>{label}</span>
      </div>
      <div className="[&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
        {children}
      </div>
    </aside>
  );
}
