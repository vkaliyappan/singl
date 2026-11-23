"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import {
  IconTerminal2,
  IconChevronUp,
  IconChevronDown,
  IconX,
  IconCopy,
  IconCheck,
  IconAlertTriangle,
  IconAlertCircle,
} from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

interface OutputDrawerProps {
  title?: string;
  status: "idle" | "exporting" | "extracting" | "done" | "error";
  messages: string[];
  onClear: () => void;
  isOpen: boolean;
  onToggleOpen: () => void;
}

export function OutputDrawer({
  title = "Process Output",
  status,
  messages,
  onClear,
  isOpen,
  onToggleOpen,
}: OutputDrawerProps) {
  const [onlyErrors, setOnlyErrors] = useState(false);
  const [copied, setCopied] = useState(false);
  const [drawerHeight, setDrawerHeight] = useState(() => {
    if (typeof window === "undefined") return 160;
    try {
      const saved = localStorage.getItem("singl:twx:drawerHeight");
      if (saved) {
        const val = Number(saved);
        if (!isNaN(val) && val >= 80 && val <= 800) return val;
      }
    } catch {}
    return 160;
  });
  const scrollRef = useRef<HTMLDivElement>(null);

  const isRunning = status === "exporting" || status === "extracting";

  const handleDragStart = useCallback((e: React.MouseEvent) => {
    const startY = e.clientY;
    const startHeight = drawerHeight;
    let currentHeight = drawerHeight;
    const onMove = (ev: MouseEvent) => {
      const maxH = typeof window !== "undefined" ? window.innerHeight * 0.75 : 600;
      const newHeight = Math.max(80, Math.min(maxH, startHeight + (startY - ev.clientY)));
      currentHeight = newHeight;
      setDrawerHeight(newHeight);
    };
    const onUp = () => {
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      try {
        localStorage.setItem("singl:twx:drawerHeight", String(currentHeight));
      } catch {}
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    e.preventDefault();
  }, [drawerHeight]);

  // Auto-scroll when new messages arrive if drawer is open
  useEffect(() => {
    if (isOpen && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, isOpen]);

  if (messages.length === 0 && !isRunning) {
    return null;
  }

  const warningCount = messages.filter((m) => m.startsWith("[WARN]")).length;
  const errorCount = messages.filter(
    (m) => m.startsWith("[ERROR]") || m.toLowerCase().includes("error:")
  ).length;

  const filteredMessages = onlyErrors
    ? messages.filter(
        (m) =>
          m.startsWith("[WARN]") ||
          m.startsWith("[ERROR]") ||
          m.toLowerCase().includes("error:")
      )
    : messages;

  const handleCopy = () => {
    navigator.clipboard.writeText(messages.join("\n"));
    setCopied(true);
    toast.success("Logs copied to clipboard");
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="shrink-0 border-t bg-card shadow-md flex flex-col transition-colors select-none relative">
      {/* Top resize bar (when console is open) */}
      {isOpen && (
        <div
          className="absolute -top-1 inset-x-0 h-2 cursor-row-resize z-20 group flex items-center justify-center hover:bg-primary/20 transition-colors"
          onMouseDown={handleDragStart}
          title="Drag to resize console"
        >
          <div className="h-0.5 w-10 rounded-full bg-border group-hover:bg-primary transition-colors" />
        </div>
      )}
      {/* Header / Summary Bar */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-border/50 select-none">
        <div
          onClick={onToggleOpen}
          role="button"
          tabIndex={0}
          className="flex items-center gap-2.5 cursor-pointer group flex-1 min-w-0"
        >
          <div
            className={cn(
              "flex size-6 items-center justify-center rounded-md text-xs font-mono transition-colors",
              isRunning
                ? "bg-primary/20 text-primary animate-pulse"
                : status === "error"
                ? "bg-destructive/20 text-destructive"
                : status === "done"
                ? "bg-success/20 text-success"
                : "bg-muted text-muted-foreground"
            )}
          >
            <IconTerminal2 className="size-3.5" />
          </div>

          <span className="text-xs font-semibold text-foreground tracking-tight truncate">
            {title}
          </span>

          {isRunning && (
            <Badge
              variant="outline"
              className="bg-primary/10 text-primary border-primary/20 text-[10px] animate-pulse"
            >
              {status === "exporting" ? "Exporting..." : "Extracting..."}
            </Badge>
          )}

          {status === "done" && (
            <Badge
              variant="outline"
              className="bg-success/10 text-success border-success/20 text-[10px]"
            >
              Complete
            </Badge>
          )}

          {status === "error" && (
            <Badge
              variant="outline"
              className="bg-destructive/10 text-destructive border-destructive/20 text-[10px]"
            >
              Failed
            </Badge>
          )}

          {errorCount > 0 && (
            <Badge variant="destructive" className="text-[10px] gap-1 px-1.5 py-0 h-4">
              <IconAlertCircle className="size-2.5" />
              {errorCount}
            </Badge>
          )}

          {warningCount > 0 && (
            <Badge
              variant="outline"
              className="bg-warning/10 text-warning border-warning/30 text-[10px] gap-1 px-1.5 py-0 h-4"
            >
              <IconAlertTriangle className="size-2.5" />
              {warningCount}
            </Badge>
          )}

          <span className="text-[11px] text-muted-foreground ml-auto pr-2 hidden sm:inline">
            {messages.length} lines
          </span>
        </div>

        {/* Action Controls */}
        <div className="flex items-center gap-1 shrink-0">
          {(warningCount > 0 || errorCount > 0) && (
            <Button
              size="xs"
              variant={onlyErrors ? "secondary" : "ghost"}
              onClick={() => setOnlyErrors((v) => !v)}
              className="h-6 text-[11px] px-2 gap-1 text-muted-foreground hover:text-foreground"
            >
              <IconAlertTriangle className="size-3" />
              {onlyErrors ? "Show All" : "Issues Only"}
            </Button>
          )}

          <Button
            size="xs"
            variant="ghost"
            onClick={handleCopy}
            title="Copy logs"
            className="h-6 w-6 p-0 text-muted-foreground hover:text-foreground"
          >
            {copied ? <IconCheck className="size-3 text-success" /> : <IconCopy className="size-3" />}
          </Button>

          <Button
            size="xs"
            variant="ghost"
            onClick={onClear}
            disabled={isRunning}
            title="Clear logs"
            className="h-6 w-6 p-0 text-muted-foreground hover:text-foreground disabled:opacity-30"
          >
            <IconX className="size-3" />
          </Button>

          <Button
            size="xs"
            variant="ghost"
            onClick={onToggleOpen}
            title={isOpen ? "Collapse console" : "Expand console"}
            className="h-6 w-6 p-0 text-muted-foreground hover:text-foreground"
          >
            {isOpen ? <IconChevronDown className="size-3.5" /> : <IconChevronUp className="size-3.5" />}
          </Button>
        </div>
      </div>

      {/* Expandable Log Area */}
      {isOpen && (
        <div
          ref={scrollRef}
          style={{ height: `${drawerHeight}px` }}
          className="overflow-y-auto bg-muted/30 dark:bg-black/40 p-3 space-y-1 font-mono text-[11.5px] leading-relaxed select-text"
        >
          {filteredMessages.map((msg, i) => {
            const isWarn = msg.startsWith("[WARN]");
            const isError =
              msg.startsWith("[ERROR]") ||
              msg.toLowerCase().includes("error:") ||
              (status === "error" && i === filteredMessages.length - 1);
            const isDone = msg.startsWith("[DONE]");

            return (
              <div
                key={i}
                className={cn(
                  "flex items-start gap-2 rounded px-1.5 py-0.5 transition-colors",
                  isError
                    ? "bg-destructive/10 text-destructive font-medium"
                    : isWarn
                    ? "bg-warning/10 text-warning"
                    : isDone
                    ? "bg-success/10 text-success font-medium"
                    : "text-muted-foreground hover:bg-accent/40"
                )}
              >
                <span className="text-[10px] text-muted-foreground/50 select-none shrink-0 w-6 text-right">
                  {i + 1}
                </span>
                <span className="break-all whitespace-pre-wrap flex-1">{msg}</span>
              </div>
            );
          })}
          {status === "done" && (
            <div className="text-success font-semibold px-1.5 pt-1 text-xs">
              Process finished successfully.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
