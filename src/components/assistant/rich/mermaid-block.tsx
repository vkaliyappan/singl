"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  IconArrowsMaximize,
  IconCheck,
  IconCode,
  IconCopy,
} from "@tabler/icons-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

type Mermaid = typeof import("mermaid").default;

let mermaidP: Promise<Mermaid> | null = null;
let lastTheme = "";
let counter = 0;

async function getMermaid(dark: boolean): Promise<Mermaid> {
  mermaidP ??= import("mermaid").then((m) => m.default);
  const mermaid = await mermaidP;
  const theme = dark ? "dark" : "default";
  if (theme !== lastTheme) {
    mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme });
    lastTheme = theme;
  }
  return mermaid;
}

const isDark = () => document.documentElement.classList.contains("dark");

function subscribeDark(cb: () => void) {
  const mo = new MutationObserver(cb);
  mo.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class"],
  });
  return () => mo.disconnect();
}

const useDark = () =>
  useSyncExternalStore(subscribeDark, isDark, () => false);

/** Mermaid leaves temp nodes (`#id`, `#did`) in <body> when rendering fails. */
function cleanup(id: string) {
  document.getElementById(id)?.remove();
  document.getElementById(`d${id}`)?.remove();
}

export function MermaidBlock({ source }: { source: string }) {
  const dark = useDark();
  const [svg, setSvg] = useState("");
  const [error, setError] = useState("");
  const [settled, setSettled] = useState("");
  const [showSource, setShowSource] = useState(false);
  const [big, setBig] = useState(false);
  const [copied, setCopied] = useState(false);
  const seq = useRef(0);

  useEffect(() => {
    const run = ++seq.current;
    const timer = setTimeout(async () => {
      const id = `mmd-${Date.now().toString(36)}-${++counter}`;
      try {
        const mermaid = await getMermaid(dark);
        const ok = await mermaid.parse(source, { suppressErrors: true });
        if (run !== seq.current) return;
        if (!ok) {
          setError("Invalid diagram syntax");
          return;
        }
        const out = await mermaid.render(id, source);
        if (run !== seq.current) return;
        setSvg(out.svg);
        setError("");
      } catch (e) {
        if (run !== seq.current) return;
        setError(e instanceof Error ? e.message : "Could not render diagram");
      } finally {
        cleanup(id);
        if (run === seq.current) setSettled(source);
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [source, dark]);

  const stable = settled === source;
  const btn =
    "flex size-5 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground";

  return (
    <div className="group/mermaid relative my-2 rounded-md border bg-card">
      <div className="absolute top-1 right-1 z-10 flex gap-0.5 rounded bg-background/80 opacity-0 transition-opacity group-hover/mermaid:opacity-100 focus-within:opacity-100">
        <button
          type="button"
          className={btn}
          title="Toggle source"
          aria-label="Toggle source"
          aria-pressed={showSource}
          onClick={() => setShowSource((v) => !v)}
        >
          <IconCode className="size-3" />
        </button>
        <button
          type="button"
          className={btn}
          title="Copy source"
          aria-label="Copy source"
          onClick={() => {
            void navigator.clipboard.writeText(source).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1200);
            });
          }}
        >
          {copied ? (
            <IconCheck className="size-3" />
          ) : (
            <IconCopy className="size-3" />
          )}
        </button>
        {svg && (
          <button
            type="button"
            className={btn}
            title="Open larger"
            aria-label="Open larger"
            onClick={() => setBig(true)}
          >
            <IconArrowsMaximize className="size-3" />
          </button>
        )}
      </div>

      {svg && (
        <div
          className={cn(
            "flex justify-center overflow-x-auto p-3 [&>svg]:h-auto [&>svg]:max-w-full",
            !!error && !stable && "opacity-70",
          )}
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      )}
      {!svg && !(error && stable) && (
        <p className="px-3 pt-2 text-[11px] text-muted-foreground">
          Diagram: rendering…
        </p>
      )}
      {error && stable && (
        <p className="px-3 pt-2 text-[11px] text-destructive">
          Diagram error: {error}
        </p>
      )}
      {(showSource || !svg) && (
        <pre className="selectable overflow-x-auto p-2.5 font-mono text-[11px] leading-relaxed">
          {source}
        </pre>
      )}

      <Dialog open={big} onOpenChange={setBig}>
        <DialogContent className="max-h-[90vh] overflow-auto sm:max-w-[90vw]">
          <DialogHeader>
            <DialogTitle>Diagram</DialogTitle>
          </DialogHeader>
          <div
            className="flex justify-center overflow-auto [&>svg]:h-auto [&>svg]:max-w-full"
            dangerouslySetInnerHTML={{ __html: svg }}
          />
        </DialogContent>
      </Dialog>
    </div>
  );
}
