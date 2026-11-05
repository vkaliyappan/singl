"use client";

import { useState } from "react";
import { IconCheck, IconCopy } from "@tabler/icons-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** Copies `text` to the clipboard; the icon turns into a tick for a moment. */
export function CopyButton({
  text,
  label = "Copy error",
  className,
}: {
  text: string;
  label?: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);

  const copy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("Could not copy to the clipboard");
    }
  };

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      onClick={copy}
      aria-label={label}
      title={label}
      className={cn("shrink-0 text-current opacity-70 hover:opacity-100", className)}
    >
      {copied ? <IconCheck /> : <IconCopy />}
    </Button>
  );
}
