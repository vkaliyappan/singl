import {
  IconAdjustmentsHorizontal,
  IconAlertTriangle,
  IconBinaryTree,
  IconBox,
  IconBraces,
  IconCode,
  IconFileCode,
  IconHierarchy2,
  IconPin,
  IconTable,
  IconTerminal2,
} from "@tabler/icons-react";

/** Icon for a pinned reference by kind. */
export function PinIcon({ kind, className }: { kind: string; className?: string }) {
  const cls = className ?? "size-3 shrink-0 text-muted-foreground";
  switch (kind) {
    case "service":
      return <IconCode className={cls} />;
    case "code":
      return <IconFileCode className={cls} />;
    case "entity":
      return <IconBox className={cls} />;
    case "property":
      return <IconAdjustmentsHorizontal className={cls} />;
    case "node":
      return <IconHierarchy2 className={cls} />;
    case "flow":
      return <IconBinaryTree className={cls} />;
    case "inputs":
      return <IconBraces className={cls} />;
    case "result":
      return <IconTable className={cls} />;
    case "error":
      return <IconAlertTriangle className={cls} />;
    case "script":
      return <IconTerminal2 className={cls} />;
    default:
      return <IconPin className={cls} />;
  }
}
