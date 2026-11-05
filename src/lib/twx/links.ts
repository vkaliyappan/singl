/**
 * Deep links into the TWX Services and TWX Entities explorers.
 *
 * Both pages read these query parameters on load and open straight onto the
 * entity (and service) named, so any other module can point at "this service"
 * without knowing how either explorer keeps its state.
 */

export type TwxServiceLink = {
  env: string;
  /** REST collection, e.g. "Things", "ThingTemplates". */
  type: string;
  entity: string;
  service?: string;
  /** Parameter values to prefill. */
  inputs?: Record<string, string>;
};

export type TwxEntityLink = {
  env: string;
  type: string;
  entity: string;
  /** Service to select on the entity's Services tab. */
  service?: string;
  /** Put the generated script in front instead of the XML. */
  focus?: "code";
};

type Params = Record<string, string | string[] | undefined>;

const first = (value: string | string[] | undefined) =>
  (Array.isArray(value) ? value[0] : value)?.trim() ?? "";

function query(fields: Record<string, string | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) if (value) params.set(key, value);
  return params.toString();
}

export function twxServiceHref(link: TwxServiceLink): string {
  const inputs = link.inputs && Object.keys(link.inputs).length ? JSON.stringify(link.inputs) : "";
  return `/twx-services?${query({
    env: link.env,
    type: link.type,
    entity: link.entity,
    service: link.service,
    inputs,
  })}`;
}

export function twxEntityHref(link: TwxEntityLink): string {
  return `/twx-entities?${query({
    env: link.env,
    type: link.type,
    entity: link.entity,
    service: link.service,
    focus: link.focus,
  })}`;
}

/** The link a TWX Services page was opened with, if any. */
export function parseServiceLink(params: Params): TwxServiceLink | null {
  const entity = first(params.entity);
  if (!entity) return null;
  let inputs: Record<string, string> | undefined;
  try {
    const raw = first(params.inputs);
    const parsed: unknown = raw ? JSON.parse(raw) : undefined;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      inputs = Object.fromEntries(
        Object.entries(parsed as Record<string, unknown>).map(([k, v]) => [k, String(v ?? "")])
      );
    }
  } catch {
    /* a mangled prefill is not worth failing the page over */
  }
  return {
    env: first(params.env),
    type: first(params.type) || "Things",
    entity,
    service: first(params.service) || undefined,
    inputs,
  };
}

/** The link a TWX Entities page was opened with, if any. */
export function parseEntityLink(params: Params): TwxEntityLink | null {
  const entity = first(params.entity);
  if (!entity) return null;
  return {
    env: first(params.env),
    type: first(params.type),
    entity,
    service: first(params.service) || undefined,
    focus: first(params.focus) === "code" ? "code" : undefined,
  };
}

/** Folder name an environment's exports are written under. */
export const safeEnvDir = (env: string) => env.replace(/[^a-zA-Z0-9_\-]/g, "_");
