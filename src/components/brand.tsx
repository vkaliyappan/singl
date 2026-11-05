import { cn } from "@/lib/utils"

/** Singl logo tile (same mark as singl-web). */
export function BrandMark({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        "relative flex size-8 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-violet-600 via-indigo-600 to-indigo-700 shadow-md shadow-indigo-500/25 ring-1 ring-white/20",
        className
      )}
    >
      <span className="text-sm font-extrabold text-white tracking-tight">S</span>
      <span className="absolute -bottom-0.5 -right-0.5 size-2 rounded-full bg-emerald-500 ring-2 ring-sidebar" />
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
