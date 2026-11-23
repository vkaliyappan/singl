"use client";

import { useState } from "react";
import { IconArrowRight, IconDatabase, IconX } from "@tabler/icons-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { asInfotable } from "@/lib/twx-flow/schema";
import { JsonView } from "./json-view";

export type WirePayload = {
  edgeId: string;
  sourceLabel: string;
  targetLabel: string;
  data: unknown;
  rows?: number;
};

export function WireBadge({
  mid,
  sourceLabel,
  targetLabel,
  data,
}: {
  mid: { x: number; y: number };
  sourceLabel: string;
  targetLabel: string;
  data: unknown;
}) {
  const [open, setOpen] = useState(false);

  if (data === undefined) return null;

  const infotable = asInfotable(data);
  const rowCount = infotable ? infotable.rows.length : Array.isArray(data) ? data.length : undefined;
  const label = rowCount !== undefined ? `${rowCount} row${rowCount === 1 ? "" : "s"}` : typeof data === "object" && data !== null ? "JSON" : String(data).slice(0, 10);

  return (
    <>
      <foreignObject
        x={mid.x - 40}
        y={mid.y - 12}
        width={80}
        height={24}
        className="overflow-visible pointer-events-auto select-none"
      >
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setOpen(true);
          }}
          className={cn(
            "flex h-6 w-full items-center justify-center gap-1 rounded-full border border-primary/30 bg-background/95 px-2 py-0.5 text-[10px] font-mono font-medium text-primary shadow-sm transition-all",
            "hover:scale-105 hover:border-primary hover:bg-primary/10 hover:shadow-md cursor-pointer"
          )}
          title={`View wire data: ${sourceLabel} -> ${targetLabel}`}
        >
          <IconDatabase className="size-3 shrink-0" />
          <span className="truncate">{label}</span>
        </button>
      </foreignObject>

      {open && (
        <foreignObject
          x={mid.x - 140}
          y={mid.y + 16}
          width={280}
          height={220}
          className="overflow-visible pointer-events-auto z-50 select-text"
        >
          <div className="flex flex-col h-[200px] w-[280px] rounded-lg border bg-popover text-popover-foreground shadow-xl">
            <div className="flex items-center justify-between border-b px-2.5 py-1.5 bg-muted/40">
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs font-semibold">Wire Data Snapshot</p>
                <p className="truncate text-[10px] text-muted-foreground font-mono">
                  {sourceLabel} <IconArrowRight className="inline size-2.5" /> {targetLabel}
                </p>
              </div>
              <Button
                variant="ghost"
                size="icon"
                className="size-5 text-muted-foreground hover:text-foreground"
                onClick={(e) => {
                  e.stopPropagation();
                  setOpen(false);
                }}
              >
                <IconX className="size-3.5" />
              </Button>
            </div>
            <div className="flex-1 overflow-auto p-2">
              <JsonView value={data} className="text-[10px]" />
            </div>
          </div>
        </foreignObject>
      )}
    </>
  );
}

