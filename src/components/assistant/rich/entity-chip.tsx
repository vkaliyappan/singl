"use client";

import { useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { defaultUrlTransform } from "react-markdown";
import {
  IconBolt,
  IconBox,
  IconCheck,
  IconCopy,
  IconCube,
  IconFolder,
  IconLayoutDashboard,
  IconPlug,
  IconShape,
  IconTable,
  IconTemplate,
  type Icon,
} from "@tabler/icons-react";
import { twxEntityHref, twxServiceHref } from "@/lib/twx/links";

export interface TwxRef {
  type: string;
  entity: string;
  service?: string;
  env?: string;
}

const COLLECTIONS: Record<string, string> = Object.fromEntries(
  [
    ["Things", "Thing"],
    ["ThingTemplates", "ThingTemplate"],
    ["ThingShapes", "ThingShape"],
    ["DataShapes", "DataShape"],
    ["Mashups", "Mashup"],
    ["Resources", "Resource"],
    ["Projects", "Project"],
    ["MediaEntities", "MediaEntity"],
    ["Networks", "Network"],
    ["Organizations", "Organization"],
    ["Users", "User"],
    ["Groups", "Group"],
    ["Subsystems", "Subsystem"],
    ["ExtensionPackages", "ExtensionPackage"],
    ["StyleDefinitions", "StyleDefinition"],
    ["StateDefinitions", "StateDefinition"],
    ["LocalizationTables", "LocalizationTable"],
    ["PersistenceProviders", "PersistenceProvider"],
    ["ModelTags", "ModelTag"],
    ["Menus", "Menu"],
    ["Dashboards", "Dashboard"],
  ].flatMap(([plural, singular]) => [
    [plural.toLowerCase(), plural],
    [singular.toLowerCase(), plural],
  ]),
);
COLLECTIONS["vocabulary"] = "ModelTags";
COLLECTIONS["vocabularies"] = "ModelTags";

const decode = (s: string) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

/** Parse `twx://Things/MyThing[/Service][?env=dev]`; null when not a usable twx link. */
export function parseTwxHref(href: string): TwxRef | null {
  const m = /^twx:\/\/([^?#]*)(?:\?([^#]*))?/i.exec(href.trim());
  if (!m) return null;
  const [type, entity, service] = m[1]
    .split("/")
    .filter(Boolean)
    .map(decode);
  const collection = type ? COLLECTIONS[type.toLowerCase()] : undefined;
  if (!collection || !entity) return null;
  const env = new URLSearchParams(m[2] ?? "").get("env")?.trim() || undefined;
  return { type: collection, entity, service: service || undefined, env };
}

/** react-markdown strips unknown protocols; keep twx: links. */
export function urlTransform(url: string): string {
  return /^twx:/i.test(url) ? url : defaultUrlTransform(url);
}

const ICONS: Record<string, Icon> = {
  Things: IconBox,
  ThingTemplates: IconTemplate,
  ThingShapes: IconShape,
  DataShapes: IconTable,
  Mashups: IconLayoutDashboard,
  Resources: IconPlug,
  Projects: IconFolder,
};

const btn =
  "hidden size-4 items-center justify-center rounded-full text-muted-foreground hover:bg-background hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring group-hover:inline-flex group-focus-within:inline-flex";

export function EntityChip({ href, children }: { href: string; children: ReactNode }) {
  const router = useRouter();
  const [copied, setCopied] = useState(false);
  const ref = parseTwxHref(href);
  if (!ref) return <>{children}</>;

  const env = ref.env ?? "";
  const Ico = ICONS[ref.type] ?? IconCube;
  const entityUrl = twxEntityHref({ env, type: ref.type, entity: ref.entity, service: ref.service });
  const serviceUrl = twxServiceHref({ env, type: ref.type, entity: ref.entity, service: ref.service });
  const primary = ref.service ? serviceUrl : entityUrl;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(ref.entity);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      /* clipboard unavailable */
    }
  };

  return (
    <span className="group mx-0.5 inline-flex items-center gap-0.5 rounded-full border bg-muted/60 align-baseline text-[11.5px] leading-5 text-foreground hover:bg-muted">
      <button
        type="button"
        title={`Type: ${ref.type} · Entity: ${ref.entity}${ref.service ? ` · Service: ${ref.service}` : ""}`}
        onClick={() => router.push(primary)}
        className="inline-flex items-center gap-1 rounded-full py-px pr-1.5 pl-1.5 focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none"
      >
        <Ico className="size-3 shrink-0 text-muted-foreground" />
        <span>{children}</span>
        {ref.service && (
          <>
            <IconBolt className="size-3 shrink-0 text-amber-500" />
            <span className="text-muted-foreground">{ref.service}</span>
          </>
        )}
      </button>
      <button type="button" title="Open in Entities" aria-label="Open in Entities" className={btn} onClick={() => router.push(entityUrl)}>
        <IconBox className="size-3" />
      </button>
      <button type="button" title="Open in Services" aria-label="Open in Services" className={btn} onClick={() => router.push(serviceUrl)}>
        <IconBolt className="size-3" />
      </button>
      <button type="button" title="Copy name" aria-label="Copy name" className={`${btn} mr-0.5`} onClick={copy}>
        {copied ? <IconCheck className="size-3" /> : <IconCopy className="size-3" />}
      </button>
    </span>
  );
}
