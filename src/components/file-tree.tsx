import type { ReactNode } from "react";
import {
  IconFolder,
  IconFolderOpen,
  IconFile,
  IconFileCode,
  IconFileText,
  IconChevronRight,
  IconLoader2,
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
import { cn } from "@/lib/utils";

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

export function FileTreeNode({
  name,
  type,
  path,
  depth,
  isExpanded = false,
  isLoading = false,
  isSelected = false,
  badge,
  loadError,
  onFileClick,
  onDirToggle,
  children,
}: {
  name: string;
  type: "file" | "dir";
  path: string;
  depth: number;
  isExpanded?: boolean;
  isLoading?: boolean;
  isSelected?: boolean;
  badge?: ReactNode;
  loadError?: string;
  onFileClick: (path: string) => void;
  onDirToggle: (path: string) => void;
  children?: ReactNode;
}) {
  const indent = depth * 12;

  if (type === "dir") {
    return (
      <div>
        <button
          onClick={() => onDirToggle(path)}
          className="flex w-full items-center gap-1.5 py-[3px] pr-2 text-left text-xs hover:bg-accent/40 transition-colors cursor-pointer"
          style={{ paddingLeft: `${indent + 4}px` }}
        >
          {isLoading ? (
            <IconLoader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
          ) : (
            <IconChevronRight
              className={cn(
                "size-3.5 shrink-0 text-muted-foreground/60 transition-transform duration-100",
                isExpanded && "rotate-90"
              )}
            />
          )}
          {isExpanded ? (
            <IconFolderOpen className="size-3.5 shrink-0" style={{ color: "#E8AB6D" }} />
          ) : (
            <IconFolder className="size-3.5 shrink-0" style={{ color: "#DCB67A" }} />
          )}
          <span className="truncate flex-1">{name}</span>
          {badge}
        </button>

        {isExpanded && (
          <div className="relative">
            <span
              className="absolute top-0 bottom-0 w-px bg-border/40"
              style={{ left: `${indent + 10}px` }}
            />
            {loadError ? (
              <p
                className="truncate text-xs text-destructive py-0.5"
                style={{ paddingLeft: `${indent + 24}px` }}
              >
                {loadError}
              </p>
            ) : (
              children
            )}
          </div>
        )}
      </div>
    );
  }

  return (
    <button
      onClick={() => onFileClick(path)}
      className={cn(
        "flex w-full items-center gap-1.5 py-[3px] pr-2 text-left text-xs transition-colors cursor-pointer",
        isSelected ? "bg-accent text-accent-foreground" : "hover:bg-accent/40 text-foreground"
      )}
      style={{ paddingLeft: `${indent + 22}px` }}
    >
      <FileIcon name={name} className="size-3.5 shrink-0" />
      <span className="truncate flex-1">{name}</span>
      {badge}
    </button>
  );
}
