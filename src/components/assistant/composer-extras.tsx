"use client";

// Attachments, tool allowlist and skills for the composer. State lives in
// useComposerExtras (called by Composer); the pieces render in the card.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  IconBook2,
  IconChevronDown,
  IconChevronLeft,
  IconChevronRight,
  IconFolder,
  IconPaperclip,
  IconPhoto,
  IconPlus,
  IconTool,
  IconX,
} from "@tabler/icons-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { isTauri } from "@/lib/clock-widget";
import { errorMessage } from "@/lib/settings";
import { cn } from "@/lib/utils";
import {
  assistantSkills,
  assistantTools,
  type SkillInfo,
  type ToolSpec,
} from "@/lib/assistant/api";
import { removePin, usePins } from "@/lib/assistant/pins";
import { RiskBadge } from "./messages";
import { PinIcon } from "./pin-icon";
import { ImagePreview } from "./image-preview";
import {
  IMAGE_ACCEPT,
  MAX_IMAGES,
  imageType,
  isImageFile,
  prepareImage,
  revokeImage,
  type PreparedImage,
} from "@/lib/assistant/images";

export const MAX_ATTACHMENTS = 10;
const DISABLED_KEY = "singl.assistant.disabledTools";

type View = "menu" | "tools" | "skills";

const GROUPS: [prefix: string, label: string][] = [
  ["twx_", "ThingWorx"],
  ["entity_", "Entities"],
  ["service_", "Services"],
  ["flow_", "Flows"],
  ["repo_", "Repository"],
  ["compare_", "Compare"],
  ["deploy_", "Deploy"],
];

export function groupOf(name: string) {
  const i = name.indexOf("__");
  if (i > 0) return { key: `mcp:${name.slice(0, i)}`, label: name.slice(0, i) };
  const g = GROUPS.find(([p]) => name.startsWith(p));
  return g ? { key: g[0], label: g[1] } : { key: "app", label: "App" };
}

function loadDisabled(): Set<string> {
  try {
    const raw = localStorage.getItem(DISABLED_KEY);
    const v: unknown = raw ? JSON.parse(raw) : [];
    return new Set(
      Array.isArray(v) ? v.filter((x) => typeof x === "string") : [],
    );
  } catch {
    return new Set();
  }
}

function baseName(path: string) {
  return path.split(/[\\/]/).pop() || path;
}

/** Dropped files larger than this are refused (matches the backend). */
const DROP_LIMIT = 256 * 1024;

export function useComposerExtras() {
  const [attachments, setAttachments] = useState<string[]>([]);
  const [dropped, setDropped] = useState<{ name: string; content: string }[]>(
    [],
  );
  const [dirs, setDirs] = useState<string[]>([]);
  const [skillIds, setSkillIds] = useState<string[]>([]);
  const [skillList, setSkillList] = useState<SkillInfo[] | null>(null);
  const [toolList, setToolList] = useState<ToolSpec[]>([]);
  const [disabled, setDisabled] = useState<Set<string>>(loadDisabled);
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<View>("menu");
  const [images, setImages] = useState<PreparedImage[]>([]);
  const imagesRef = useRef<PreparedImage[]>([]);
  const pending = useRef(0);
  const pastedCount = useRef(0);

  useEffect(() => () => imagesRef.current.forEach(revokeImage), []);

  /** Downscales and adds images; `pasted` names them pasted-image-N. */
  const addImages = useCallback(async (files: File[], pasted = false) => {
    for (const f of files) {
      const type = imageType(f);
      if (type === null) {
        toast.error(`${f.name || "File"} is not a supported image.`);
        continue;
      }
      if (imagesRef.current.length + pending.current >= MAX_IMAGES) {
        toast.error(`At most ${MAX_IMAGES} images per message.`);
        break;
      }
      pending.current++;
      try {
        const name = pasted
          ? `pasted-image-${++pastedCount.current}.${type.split("/")[1]}`
          : f.name;
        const img = await prepareImage(f, name);
        imagesRef.current = [...imagesRef.current, img];
        setImages(imagesRef.current);
      } catch (e) {
        toast.error(errorMessage(e));
      } finally {
        pending.current--;
      }
    }
  }, []);

  const removeImage = useCallback((url: string) => {
    const hit = imagesRef.current.find((i) => i.previewUrl === url);
    if (hit) revokeImage(hit);
    imagesRef.current = imagesRef.current.filter((i) => i.previewUrl !== url);
    setImages(imagesRef.current);
  }, []);

  useEffect(() => {
    if (!isTauri()) return;
    assistantTools(false)
      .then((t) => setToolList(t.filter((x) => !x.externalOnly)))
      .catch(() => {});
  }, []);

  const loadSkills = useCallback(() => {
    assistantSkills()
      .then(setSkillList)
      .catch((e) => {
        setSkillList([]);
        toast.error(errorMessage(e));
      });
  }, []);

  const show = useCallback(
    (v: View) => {
      setView(v);
      setOpen(true);
      if (v === "skills") loadSkills();
    },
    [loadSkills],
  );

  const onOpenChange = useCallback((o: boolean) => {
    setOpen(o);
    if (o) setView("menu");
  }, []);

  const persist = useCallback((next: Set<string>) => {
    setDisabled(next);
    try {
      localStorage.setItem(DISABLED_KEY, JSON.stringify([...next]));
    } catch {
      /* storage unavailable */
    }
  }, []);

  const addAttachments = useCallback((paths: string[], isDir = false) => {
    if (isDir) setDirs((d) => [...d, ...paths.filter((p) => !d.includes(p))]);
    setAttachments((cur) => {
      const next = [...cur];
      let over = false;
      for (const p of paths) {
        if (next.includes(p)) continue;
        if (next.length >= MAX_ATTACHMENTS) {
          over = true;
          break;
        }
        next.push(p);
      }
      if (over) toast.error(`At most ${MAX_ATTACHMENTS} files per message.`);
      return next;
    });
  }, []);

  const attachFiles = useCallback(async () => {
    if (!isTauri()) {
      toast.error("Attaching files needs the desktop app.");
      return;
    }
    try {
      const { open: pick } = await import("@tauri-apps/plugin-dialog");
      const picked = await pick({ multiple: true, directory: false });
      if (!picked) return;
      addAttachments(Array.isArray(picked) ? picked : [picked]);
    } catch (e) {
      toast.error(errorMessage(e));
    }
  }, [addAttachments]);

  const attachFolders = useCallback(async () => {
    if (!isTauri()) {
      toast.error("Attaching folders needs the desktop app.");
      return;
    }
    try {
      const { open: pick } = await import("@tauri-apps/plugin-dialog");
      const picked = await pick({ multiple: true, directory: true });
      if (!picked) return;
      addAttachments(Array.isArray(picked) ? picked : [picked], true);
    } catch (e) {
      toast.error(errorMessage(e));
    }
  }, [addAttachments]);

  const enabledCount = toolList.filter((t) => !disabled.has(t.name)).length;
  const narrowed = toolList.length > 0 && enabledCount < toolList.length;
  const toolAllowlist = narrowed
    ? toolList.filter((t) => !disabled.has(t.name)).map((t) => t.name)
    : null;

  const reset = useCallback(() => {
    imagesRef.current.forEach(revokeImage);
    imagesRef.current = [];
    setImages([]);
    pastedCount.current = 0;
    setAttachments([]);
    setDirs([]);
    setDropped([]);
    setSkillIds([]);
  }, []);

  /**
   * Files dropped from Windows Explorer: a browser drop has no path, so the
   * text is read here and sent with the message. Folders and binary files are refused.
   */
  const addDroppedFiles = useCallback(
    async (dt: DataTransfer) => {
      const entries = [...dt.items].map((i) => i.webkitGetAsEntry?.() ?? null);
      if (entries.some((e) => e?.isDirectory)) {
        toast.info(
          "Folders dropped from outside the app can't be attached. Use “Attach folder…” or drag it from the explorer.",
        );
      }
      const all = [...dt.files].filter((_, i) => !entries[i]?.isDirectory);
      const imgs = all.filter(isImageFile);
      if (imgs.length) void addImages(imgs);
      const files = all.filter((f) => !isImageFile(f));
      const read: { name: string; content: string }[] = [];
      for (const f of files) {
        if (f.size > DROP_LIMIT) {
          toast.error(`${f.name} is larger than 256 KB.`);
          continue;
        }
        const bytes = new Uint8Array(await f.arrayBuffer());
        try {
          read.push({
            name: f.name,
            content: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
          });
        } catch {
          toast.error(`${f.name} is not a text file.`);
        }
      }
      if (!read.length) return;
      setDropped((cur) => {
        const room = MAX_ATTACHMENTS - attachments.length - cur.length;
        if (read.length > room)
          toast.error(`Attach at most ${MAX_ATTACHMENTS} files per message.`);
        return [
          ...cur,
          ...read
            .filter((r) => !cur.some((c) => c.name === r.name))
            .slice(0, Math.max(0, room)),
        ];
      });
    },
    [attachments.length, addImages],
  );

  const skillNames = skillIds.map(
    (id) => skillList?.find((s) => s.id === id)?.name ?? id,
  );

  return {
    attachments,
    dirs,
    dropped,
    images,
    addImages,
    removeImage,
    addDroppedFiles,
    removeDropped: (name: string) =>
      setDropped((d) => d.filter((x) => x.name !== name)),
    removeAttachment: (p: string) => {
      setAttachments((a) => a.filter((x) => x !== p));
      setDirs((d) => d.filter((x) => x !== p));
    },
    attachFiles,
    attachFolders,
    addAttachments,
    loadSkills,
    skillIds,
    skillNames,
    skillList,
    toggleSkill: (id: string) =>
      setSkillIds((s) =>
        s.includes(id) ? s.filter((x) => x !== id) : [...s, id],
      ),
    toolList,
    disabled,
    setDisabledTools: persist,
    enabledCount,
    narrowed,
    toolAllowlist,
    open,
    view,
    setView,
    show,
    onOpenChange,
    reset,
  };
}

export type ComposerExtras = ReturnType<typeof useComposerExtras>;

const chipCls =
  "flex h-6 max-w-44 items-center gap-1 rounded-full border bg-background/70 pr-1 pl-2 text-[11px]";

/** Removable file and skill chips, shown above the textarea. */
export function ExtrasChips({ extras }: { extras: ComposerExtras }) {
  const pins = usePins();
  const [big, setBig] = useState<{ src: string; name: string } | null>(null);
  if (
    !pins.length &&
    !extras.images.length &&
    !extras.attachments.length &&
    !extras.dropped.length &&
    !extras.skillIds.length
  )
    return null;
  return (
    <div
      className="flex flex-wrap items-center gap-1 px-3 pt-2.5"
      aria-label="Attached"
    >
      {extras.images.map((im) => (
        <span key={im.previewUrl} className="relative" title={im.name}>
          <button
            type="button"
            aria-label={`Preview ${im.name}`}
            onClick={() => setBig({ src: im.previewUrl, name: im.name })}
            className="block overflow-hidden rounded-md border"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={im.previewUrl}
              alt={im.name}
              className="size-10 object-cover"
            />
          </button>
          <button
            type="button"
            aria-label={`Remove ${im.name}`}
            onClick={() => extras.removeImage(im.previewUrl)}
            className="absolute -top-1.5 -right-1.5 flex size-4 items-center justify-center rounded-full border bg-background text-muted-foreground hover:text-foreground"
          >
            <IconX className="size-3" />
          </button>
        </span>
      ))}
      <ImagePreview image={big} onClose={() => setBig(null)} />
      {pins.map((p) => (
        <span
          key={p.id}
          className={chipCls}
          title={`${p.label}${p.detail ? ` (${p.detail})` : ""}
${p.content.slice(0, 300)}`}
        >
          <PinIcon kind={p.kind} />
          <span className="truncate">{p.label}</span>
          {p.detail && (
            <span className="shrink-0 text-[10px] text-muted-foreground">
              {p.detail}
            </span>
          )}
          <button
            type="button"
            aria-label={`Remove ${p.label}`}
            onClick={() => removePin(p.id)}
            className="flex size-4 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <IconX className="size-3" />
          </button>
        </span>
      ))}
      {extras.attachments.map((p) => (
        <span key={p} className={chipCls} title={p}>
          {extras.dirs.includes(p) ? (
            <IconFolder className="size-3 shrink-0 text-muted-foreground" />
          ) : (
            <IconPaperclip className="size-3 shrink-0 text-muted-foreground" />
          )}
          <span className="truncate">
            {baseName(p)}
            {extras.dirs.includes(p) ? "/" : ""}
          </span>
          <button
            type="button"
            aria-label={`Remove ${baseName(p)}`}
            onClick={() => extras.removeAttachment(p)}
            className="flex size-4 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <IconX className="size-3" />
          </button>
        </span>
      ))}
      {extras.dropped.map((f) => (
        <span
          key={`dropped:${f.name}`}
          className={chipCls}
          title={`${f.name} (dropped from outside the app)`}
        >
          <IconPaperclip className="size-3 shrink-0 text-muted-foreground" />
          <span className="truncate">{f.name}</span>
          <button
            type="button"
            aria-label={`Remove ${f.name}`}
            onClick={() => extras.removeDropped(f.name)}
            className="flex size-4 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <IconX className="size-3" />
          </button>
        </span>
      ))}
      {extras.skillIds.map((id, i) => (
        <span key={id} className={chipCls} title={`Skill: ${id}`}>
          <IconBook2 className="size-3 shrink-0 text-primary" />
          <span className="truncate">{extras.skillNames[i]}</span>
          <button
            type="button"
            aria-label={`Remove skill ${extras.skillNames[i]}`}
            onClick={() => extras.toggleSkill(id)}
            className="flex size-4 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <IconX className="size-3" />
          </button>
        </span>
      ))}
    </div>
  );
}

/** "Tools 12/80" chip, only when the allowlist is narrowed. */
export function ToolsChip({ extras }: { extras: ComposerExtras }) {
  if (!extras.narrowed) return null;
  return (
    <button
      type="button"
      onClick={() => extras.show("tools")}
      title="Tools enabled for this chat. Click to change."
      aria-label={`Tools: ${extras.enabledCount} of ${extras.toolList.length} enabled`}
      className="flex h-7 shrink-0 items-center gap-1 rounded-full border px-2 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
    >
      <IconTool className="size-3.5" />
      Tools {extras.enabledCount}/{extras.toolList.length}
    </button>
  );
}

function MenuItem({
  icon,
  label,
  hint,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  hint?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
    >
      {icon}
      <span className="flex-1">{label}</span>
      {hint && (
        <span className="text-[10.5px] text-muted-foreground">{hint}</span>
      )}
    </button>
  );
}

function Back({ title, onBack }: { title: string; onBack: () => void }) {
  return (
    <div className="flex items-center gap-1">
      <Button variant="ghost" size="icon-xs" aria-label="Back" onClick={onBack}>
        <IconChevronLeft />
      </Button>
      <span className="text-xs font-medium">{title}</span>
    </div>
  );
}

function TriCheck({
  state,
  label,
  onToggle,
}: {
  state: boolean | "mixed";
  label: string;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={state}
      aria-label={label}
      onClick={onToggle}
      className={cn(
        "flex size-4 shrink-0 items-center justify-center rounded-[4px] border border-input text-[10px] leading-none text-primary-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/30",
        state && "border-primary bg-primary",
      )}
    >
      {state === "mixed" ? "–" : state ? "✓" : ""}
    </button>
  );
}

function ToolsView({ extras }: { extras: ComposerExtras }) {
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const { toolList, disabled, setDisabledTools } = extras;

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const map = new Map<string, { label: string; tools: ToolSpec[] }>();
    for (const t of toolList) {
      if (q && !`${t.name} ${t.description}`.toLowerCase().includes(q))
        continue;
      const g = groupOf(t.name);
      const e = map.get(g.key) ?? { label: g.label, tools: [] };
      e.tools.push(t);
      map.set(g.key, e);
    }
    return [...map.entries()];
  }, [toolList, query]);

  const setMany = (names: string[], on: boolean) => {
    const next = new Set(disabled);
    for (const n of names) {
      if (on) next.delete(n);
      else next.add(n);
    }
    setDisabledTools(next);
  };
  const all = toolList.map((t) => t.name);

  return (
    <>
      <Back
        title={`Tools (${extras.enabledCount}/${toolList.length})`}
        onBack={() => extras.setView("menu")}
      />
      <Input
        autoFocus
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search tools"
        aria-label="Search tools"
        className="h-7"
      />
      <div className="flex gap-1">
        <Button variant="outline" size="xs" onClick={() => setMany(all, true)}>
          All
        </Button>
        <Button variant="outline" size="xs" onClick={() => setMany(all, false)}>
          None
        </Button>
        <Button
          variant="outline"
          size="xs"
          onClick={() =>
            setDisabledTools(
              new Set(
                toolList.filter((t) => t.risk !== "read").map((t) => t.name),
              ),
            )
          }
        >
          Read-only
        </Button>
      </div>
      <div className="max-h-72 overflow-y-auto" aria-label="Tools">
        {groups.length === 0 && (
          <p className="px-2 py-3 text-center text-[11px] text-muted-foreground">
            {toolList.length ? "No matching tools" : "No tools available"}
          </p>
        )}
        {groups.map(([key, g]) => {
          const names = g.tools.map((t) => t.name);
          const on = names.filter((n) => !disabled.has(n)).length;
          const state = on === 0 ? false : on === names.length ? true : "mixed";
          const isOpen = !!query.trim() || !collapsed.has(key);
          return (
            <div key={key}>
              <div className="flex items-center gap-1.5 rounded-md px-1 py-1 hover:bg-accent/50">
                <button
                  type="button"
                  aria-label={`${isOpen ? "Collapse" : "Expand"} ${g.label}`}
                  aria-expanded={isOpen}
                  onClick={() =>
                    setCollapsed((c) => {
                      const n = new Set(c);
                      if (n.has(key)) n.delete(key);
                      else n.add(key);
                      return n;
                    })
                  }
                  className="flex size-4 shrink-0 items-center justify-center text-muted-foreground"
                >
                  {isOpen ? (
                    <IconChevronDown className="size-3.5" />
                  ) : (
                    <IconChevronRight className="size-3.5" />
                  )}
                </button>
                <TriCheck
                  state={state}
                  label={`${g.label}: all tools`}
                  onToggle={() => setMany(names, state !== true)}
                />
                <span className="flex-1 truncate text-xs font-medium">
                  {g.label}
                </span>
                <span className="text-[10px] text-muted-foreground">
                  {on}/{names.length}
                </span>
              </div>
              {isOpen &&
                g.tools.map((t) => (
                  <label
                    key={t.name}
                    title={t.description}
                    className="flex cursor-pointer items-center gap-1.5 rounded-md py-0.5 pr-1 pl-7 hover:bg-accent/50"
                  >
                    <Checkbox
                      checked={!disabled.has(t.name)}
                      onCheckedChange={(v) => setMany([t.name], !!v)}
                      aria-label={t.name}
                    />
                    <span className="min-w-0 flex-1 truncate font-mono text-[11px]">
                      {t.name}
                    </span>
                    <RiskBadge risk={t.risk} />
                  </label>
                ))}
            </div>
          );
        })}
      </div>
    </>
  );
}

function SkillsView({ extras }: { extras: ComposerExtras }) {
  const [query, setQuery] = useState("");
  const { skillList } = extras;
  const q = query.trim().toLowerCase();
  const shown = (skillList ?? []).filter(
    (s) => !q || `${s.name} ${s.description}`.toLowerCase().includes(q),
  );
  return (
    <>
      <Back title="Skills" onBack={() => extras.setView("menu")} />
      <Input
        autoFocus
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search skills"
        aria-label="Search skills"
        className="h-7"
      />
      <div className="max-h-72 overflow-y-auto" aria-label="Skills">
        {skillList === null && (
          <p className="px-2 py-3 text-center text-[11px] text-muted-foreground">
            Loading…
          </p>
        )}
        {skillList !== null && skillList.length === 0 && (
          <p className="px-2 py-3 text-[11px] text-muted-foreground">
            No skills found. Skills are read from{" "}
            <code>~/.claude/skills/&lt;name&gt;/SKILL.md</code> and{" "}
            <code>&lt;workspace&gt;/.claude/skills/&lt;name&gt;/SKILL.md</code>.
          </p>
        )}
        {skillList !== null && skillList.length > 0 && shown.length === 0 && (
          <p className="px-2 py-3 text-center text-[11px] text-muted-foreground">
            No matching skills
          </p>
        )}
        {shown.map((s) => (
          <label
            key={s.id}
            className="flex cursor-pointer items-start gap-2 rounded-md px-1.5 py-1.5 hover:bg-accent/50"
          >
            <Checkbox
              className="mt-0.5"
              checked={extras.skillIds.includes(s.id)}
              onCheckedChange={() => extras.toggleSkill(s.id)}
              aria-label={s.name}
            />
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-1.5">
                <span className="truncate text-xs font-medium">{s.name}</span>
                <Badge
                  variant="secondary"
                  className="h-4 py-0 text-[9px] font-normal"
                >
                  {s.source}
                </Badge>
              </span>
              <span className="line-clamp-2 text-[10.5px] text-muted-foreground">
                {s.description}
              </span>
            </span>
          </label>
        ))}
      </div>
    </>
  );
}

/** The round "+" button and its menu / tools / skills popover. */
export function AddMenu({ extras }: { extras: ComposerExtras }) {
  const fileInput = useRef<HTMLInputElement>(null);
  return (
    <>
      <input
        ref={fileInput}
        type="file"
        hidden
        multiple
        accept={IMAGE_ACCEPT}
        onChange={(e) => {
          const files = [...(e.target.files ?? [])];
          e.target.value = "";
          if (files.length) void extras.addImages(files);
        }}
      />
    <Popover open={extras.open} onOpenChange={extras.onOpenChange}>
      <PopoverTrigger
        render={
          <button
            type="button"
            aria-label="Add files, tools or skills"
            title="Add files, tools or skills"
            className="flex size-7 shrink-0 items-center justify-center rounded-full border text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          />
        }
      >
        <IconPlus className="size-4" />
      </PopoverTrigger>
      <PopoverContent align="start" side="top" className="w-80 gap-1.5 p-1.5">
        {extras.view === "menu" && (
          <>
            <MenuItem
              icon={<IconPaperclip className="size-4" />}
              label="Attach files…"
              onClick={() => {
                extras.onOpenChange(false);
                void extras.attachFiles();
              }}
            />
            <MenuItem
              icon={<IconPhoto className="size-4" />}
              label="Attach image…"
              onClick={() => {
                extras.onOpenChange(false);
                fileInput.current?.click();
              }}
            />
            <MenuItem
              icon={<IconFolder className="size-4" />}
              label="Attach folder…"
              onClick={() => {
                extras.onOpenChange(false);
                void extras.attachFolders();
              }}
            />
            <MenuItem
              icon={<IconTool className="size-4" />}
              label="Tools"
              hint={
                extras.toolList.length
                  ? `${extras.enabledCount}/${extras.toolList.length}`
                  : undefined
              }
              onClick={() => extras.show("tools")}
            />
            <MenuItem
              icon={<IconBook2 className="size-4" />}
              label="Skills"
              hint={
                extras.skillIds.length ? `${extras.skillIds.length}` : undefined
              }
              onClick={() => extras.show("skills")}
            />
          </>
        )}
        {extras.view === "tools" && <ToolsView extras={extras} />}
        {extras.view === "skills" && <SkillsView extras={extras} />}
      </PopoverContent>
    </Popover>
    </>
  );
}
