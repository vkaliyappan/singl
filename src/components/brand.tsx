import { cn } from "@/lib/utils"

/** Singl logo tile (same mark as singl-web). */
export function BrandMark({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        "relative flex size-8 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-primary to-[oklch(0.46_0.2_268)] text-primary-foreground shadow-sm ring-1 ring-inset ring-white/20",
        className
      )}
    >
      <span className="text-sm font-extrabold tracking-tight">S</span>
      <span className="absolute -bottom-0.5 -right-0.5 size-2 rounded-full bg-success ring-2 ring-sidebar" />
    </div>
  )
}

export function BrandWordmark({ className }: { className?: string }) {
  return (
    <span className={cn("font-heading text-[15px] font-bold leading-none tracking-[-0.03em]", className)}>
      singl<span className="text-primary dark:text-sidebar-primary">.</span>
    </span>
  )
}
