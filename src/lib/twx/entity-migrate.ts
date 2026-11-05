import { formatEntityXml } from './xmlformat';

// ── Types ──────────────────────────────────────────────────────────────────

export type MemberKind = 'property' | 'service';
export type MigrateMode = 'move' | 'copy';

export interface EntityHeader {
  /** Root collection tag, e.g. "ThingShapes", "Things", "ThingTemplates". */
  collection: string;
  /** Singular entity tag, e.g. "ThingShape", "Thing", "ThingTemplate". */
  entityTag: string;
  /** Entity name attribute. */
  name: string;
  projectName: string;
}

export interface EntityMembers {
  header: EntityHeader | null;
  properties: string[];
  services: { name: string; hasImplementation: boolean }[];
}

export interface MigrateItem {
  kind: MemberKind;
  name: string;
  /** Optional new name to give the member on the target. Blank/absent = keep name. */
  newName?: string;
}

export interface MemberResult {
  kind: MemberKind;
  name: string;
  /** Name the member was written under on target when renamed (else same as name). */
  newName?: string;
  status: 'moved' | 'copied' | 'conflict' | 'missing' | 'error';
  warnings: string[];
  /** For conflicts: whether overwrite was requested by caller. */
}

export interface MigrateResult {
  sourceXml: string;
  targetXml: string;
  members: MemberResult[];
  /** True if any member ended in conflict without an overwrite decision. */
  hasBlockingConflict: boolean;
}

// Singular tag → plural container that holds the entity node.
const ENTITY_TAGS: Record<string, string> = {
  Thing: 'Things',
  ThingShape: 'ThingShapes',
  ThingTemplate: 'ThingTemplates',
};

// ── Low-level XML node scanning (CDATA-aware, format-preserving) ─────────────

/** Escape a string for safe use inside a RegExp. */
function reEsc(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Find the opening tag of `<tagName ... name="name" ...>` and return its match
 * start index and whether it is self-closing. Attribute order independent.
 * Returns null when not found.
 */
function findOpeningTag(
  xml: string,
  tagName: string,
  name: string
): { start: number; openEnd: number; selfClosing: boolean } | null {
  // Match a full opening tag for tagName, then verify it carries name="name".
  const tagRe = new RegExp(`<${reEsc(tagName)}\\b[^>]*?(/?)>`, 'g');
  const nameRe = new RegExp(`(?<=\\s)name="${reEsc(name)}"`);
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(xml)) !== null) {
    const tagText = m[0];
    if (nameRe.test(tagText)) {
      return { start: m.index, openEnd: tagRe.lastIndex, selfClosing: m[1] === '/' };
    }
  }
  return null;
}

/**
 * Extract the full raw text of a named node (open tag → matching close tag),
 * accounting for same-name nesting and ignoring tags inside CDATA.
 * Returns the raw substring plus its [start,end) span, or null.
 */
function extractNode(
  xml: string,
  tagName: string,
  name: string
): { raw: string; start: number; end: number } | null {
  const open = findOpeningTag(xml, tagName, name);
  if (!open) return null;
  if (open.selfClosing) {
    return { raw: xml.slice(open.start, open.openEnd), start: open.start, end: open.openEnd };
  }
  // Walk forward from openEnd tracking depth of same-name tags; skip CDATA.
  const scanRe = new RegExp(
    `<!\\[CDATA\\[[\\s\\S]*?\\]\\]>|<${reEsc(tagName)}\\b[^>]*?(/?)>|</${reEsc(tagName)}>`,
    'g'
  );
  scanRe.lastIndex = open.openEnd;
  let depth = 1;
  let m: RegExpExecArray | null;
  while ((m = scanRe.exec(xml)) !== null) {
    const tok = m[0];
    if (tok.startsWith('<![CDATA[')) continue;
    if (tok.startsWith('</')) {
      depth -= 1;
      if (depth === 0) {
        const end = scanRe.lastIndex;
        return { raw: xml.slice(open.start, end), start: open.start, end };
      }
    } else if (m[1] !== '/') {
      // opening tag that is not self-closing
      depth += 1;
    }
  }
  return null; // unbalanced
}

/** Locate `<container>...</container>` and return the insertion point (before close) plus emptiness. */
function findContainer(
  xml: string,
  container: string
): { insertAt: number; isEmpty: boolean } | null {
  // Self-closed empty container: <Container/>
  const selfClose = new RegExp(`<${reEsc(container)}\\b[^>]*/>`);
  const sc = selfClose.exec(xml);
  if (sc) {
    // Treat as empty; caller expands it.
    return { insertAt: sc.index, isEmpty: true };
  }
  const openRe = new RegExp(`<${reEsc(container)}\\b[^>]*?>`);
  const om = openRe.exec(xml);
  if (!om) return null;
  const openEnd = om.index + om[0].length;
  const closeRe = new RegExp(`</${reEsc(container)}>`);
  closeRe.lastIndex = openEnd;
  const cm = closeRe.exec(xml.slice(openEnd));
  if (!cm) return null;
  const closeStart = openEnd + cm.index;
  const between = xml.slice(openEnd, closeStart);
  return { insertAt: closeStart, isEmpty: between.trim() === '' };
}

/** Insert a raw node just inside the given container's closing tag. */
function insertIntoContainer(xml: string, container: string, rawNode: string): string | null {
  const loc = findContainer(xml, container);
  if (!loc) return null;
  // Handle self-closed <Container/> by expanding first.
  const selfClose = new RegExp(`<(${reEsc(container)})\\b([^>]*)/>`);
  const scm = selfClose.exec(xml);
  if (scm && scm.index === loc.insertAt) {
    const expanded = `<${scm[1]}${scm[2]}>\n${rawNode}\n</${scm[1]}>`;
    return xml.slice(0, scm.index) + expanded + xml.slice(scm.index + scm[0].length);
  }
  return xml.slice(0, loc.insertAt) + '\n' + rawNode + '\n' + xml.slice(loc.insertAt);
}

/** Remove a [start,end) span from xml. */
function removeSpan(xml: string, start: number, end: number): string {
  return xml.slice(0, start) + xml.slice(end);
}

/**
 * Rename a raw node's `name="..."` attribute on its opening tag only.
 * Does not touch any inner references. Returns the raw string with the primary
 * name attribute swapped (no-op if the opening name attr isn't found).
 */
function renameRawNode(raw: string, tagName: string, newName: string): string {
  const openRe = new RegExp(`(<${reEsc(tagName)}\\b[^>]*?(?<=\\s)name=")[^"]*(")`);
  return raw.replace(openRe, (_full, pre: string, post: string) => `${pre}${newName}${post}`);
}

// ── Public parsing ───────────────────────────────────────────────────────────

function sliceContainer(xml: string, container: string): string {
  const openRe = new RegExp(`<${reEsc(container)}\\b[^>]*?>`);
  const om = openRe.exec(xml);
  if (!om) return '';
  const openEnd = om.index + om[0].length;
  const closeRe = new RegExp(`</${reEsc(container)}>`);
  const cm = closeRe.exec(xml.slice(openEnd));
  if (!cm) return '';
  return xml.slice(openEnd, openEnd + cm.index);
}

/** Collect the name attributes of every `<tagName ...>` inside `region`. */
function collectNames(region: string, tagName: string): string[] {
  const re = new RegExp(`<${reEsc(tagName)}\\b[^>]*?(?<=\\s)name="([^"]*)"`, 'g');
  const names: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(region)) !== null) names.push(m[1]);
  return names;
}

export function readEntityHeader(xml: string): EntityHeader | null {
  for (const [tag, collection] of Object.entries(ENTITY_TAGS)) {
    const open = new RegExp(`<${tag}\\b[^>]*?(?<=\\s)name="([^"]*)"[^>]*>`).exec(xml);
    if (open) {
      const projMatch = /(?<=\s)projectName="([^"]*)"/.exec(open[0]);
      return {
        collection,
        entityTag: tag,
        name: open[1],
        projectName: projMatch?.[1] ?? '',
      };
    }
  }
  return null;
}

export function parseEntityMembers(xml: string): EntityMembers {
  const header = readEntityHeader(xml);
  const propRegion = sliceContainer(xml, 'PropertyDefinitions');
  const svcRegion = sliceContainer(xml, 'ServiceDefinitions');
  const implRegion = sliceContainer(xml, 'ServiceImplementations');
  const implNames = new Set(collectNames(implRegion, 'ServiceImplementation'));
  return {
    header,
    properties: collectNames(propRegion, 'PropertyDefinition'),
    services: collectNames(svcRegion, 'ServiceDefinition').map((name) => ({
      name,
      hasImplementation: implNames.has(name),
    })),
  };
}

// ── Reference detection (best-effort warnings, never auto-edits) ──────────────

function detectServiceRefs(xml: string, serviceName: string): string[] {
  const warnings: string[] = [];
  const n = reEsc(serviceName);
  if (new RegExp(`\\bme\\.${n}\\s*\\(`).test(xml) || new RegExp(`\\bthis\\.${n}\\s*\\(`).test(xml)) {
    warnings.push(`Source still calls "${serviceName}" in service code (me.${serviceName}(...)). Will break unless inherited.`);
  }
  const subs = sliceContainer(xml, 'Subscriptions');
  if (subs.includes(`"${serviceName}"`) || new RegExp(`sourceProperty="${n}"`).test(subs)) {
    warnings.push(`A subscription in the source references "${serviceName}".`);
  }
  const maps = sliceContainer(xml, 'ServiceMappings');
  if (new RegExp(`(?<=\\s)name="${n}"`).test(maps)) {
    warnings.push(`A ServiceMapping in the source references "${serviceName}".`);
  }
  return warnings;
}

function detectPropertyRefs(xml: string, propName: string): string[] {
  const warnings: string[] = [];
  const n = reEsc(propName);
  for (const bindTag of ['PropertyBindings', 'RemotePropertyBindings', 'LocalPropertyBindings']) {
    const region = sliceContainer(xml, bindTag);
    if (region && new RegExp(`(?<=\\s)name="${n}"|localName="${n}"|sourceName="${n}"`).test(region)) {
      warnings.push(`Source has a ${bindTag} entry for "${propName}" (binding not moved).`);
    }
  }
  if (new RegExp(`\\bme\\.${n}\\b`).test(sliceContainer(xml, 'ServiceImplementations'))) {
    warnings.push(`Source service code references property "${propName}" (me.${propName}).`);
  }
  return warnings;
}

// ── Core batch migration ──────────────────────────────────────────────────────

export interface MigrateOptions {
  sourceXml: string;
  targetXml: string;
  items: MigrateItem[];
  mode: MigrateMode;
  /** Member "kind:name" keys the caller has approved to overwrite on the target. */
  overwrite?: Set<string>;
}

const memberKey = (kind: MemberKind, name: string) => `${kind}:${name}`;

/**
 * Move or copy the given properties/services from source into target.
 * Pure: does no IO. Returns updated XML strings (already reformatted) and a
 * per-member result log. Services move BOTH definition and implementation.
 */
export function migrateMembers({
  sourceXml,
  targetXml,
  items,
  mode,
  overwrite,
}: MigrateOptions): MigrateResult {
  let src = sourceXml;
  let tgt = targetXml;
  const members: MemberResult[] = [];
  let hasBlockingConflict = false;

  const targetExisting = parseEntityMembers(targetXml);
  const targetProps = new Set(targetExisting.properties);
  const targetSvcs = new Set(targetExisting.services.map((s) => s.name));

  for (const item of items) {
    const warnings: string[] = [];
    const renamed = item.newName?.trim() ?? '';
    const targetName = renamed && renamed !== item.name ? renamed : item.name;
    const isRenamed = targetName !== item.name;
    const key = memberKey(item.kind, item.name);
    const wantsOverwrite = overwrite?.has(key) ?? false;
    const resultBase = { kind: item.kind, name: item.name, newName: targetName };

    // Collision check on target (against the NEW name when renamed).
    const collides = item.kind === 'property' ? targetProps.has(targetName) : targetSvcs.has(targetName);
    if (collides && !wantsOverwrite) {
      hasBlockingConflict = true;
      members.push({ ...resultBase, status: 'conflict', warnings });
      continue;
    }

    if (item.kind === 'property') {
      const node = extractNode(src, 'PropertyDefinition', item.name);
      if (!node) {
        members.push({ ...resultBase, status: 'missing', warnings: [`Property "${item.name}" not found in source.`] });
        continue;
      }
      // If overwriting, remove the existing target node first (by target name).
      if (collides && wantsOverwrite) {
        const existing = extractNode(tgt, 'PropertyDefinition', targetName);
        if (existing) tgt = removeSpan(tgt, existing.start, existing.end);
      }
      const rawNode = isRenamed ? renameRawNode(node.raw, 'PropertyDefinition', targetName) : node.raw;
      const inserted = insertIntoContainer(tgt, 'PropertyDefinitions', rawNode);
      if (inserted === null) {
        members.push({ ...resultBase, status: 'error', warnings: ['Target has no PropertyDefinitions container.'] });
        continue;
      }
      tgt = inserted;
      targetProps.add(targetName);
      if (mode === 'move') {
        warnings.push(...detectPropertyRefs(src, item.name));
        const fresh = extractNode(src, 'PropertyDefinition', item.name);
        if (fresh) src = removeSpan(src, fresh.start, fresh.end);
      }
      members.push({ ...resultBase, status: mode === 'move' ? 'moved' : 'copied', warnings });
      continue;
    }

    // service: move BOTH ServiceDefinition and ServiceImplementation.
    const def = extractNode(src, 'ServiceDefinition', item.name);
    if (!def) {
      members.push({ ...resultBase, status: 'missing', warnings: [`ServiceDefinition "${item.name}" not found in source.`] });
      continue;
    }
    const impl = extractNode(src, 'ServiceImplementation', item.name);
    if (!impl) warnings.push(`No ServiceImplementation found for "${item.name}" — moving signature only (no code).`);

    if (collides && wantsOverwrite) {
      const exDef = extractNode(tgt, 'ServiceDefinition', targetName);
      if (exDef) tgt = removeSpan(tgt, exDef.start, exDef.end);
      const exImpl = extractNode(tgt, 'ServiceImplementation', targetName);
      if (exImpl) tgt = removeSpan(tgt, exImpl.start, exImpl.end);
    }

    const defRaw = isRenamed ? renameRawNode(def.raw, 'ServiceDefinition', targetName) : def.raw;
    const withDef = insertIntoContainer(tgt, 'ServiceDefinitions', defRaw);
    if (withDef === null) {
      members.push({ ...resultBase, status: 'error', warnings: ['Target has no ServiceDefinitions container.'] });
      continue;
    }
    tgt = withDef;
    if (impl) {
      const implRaw = isRenamed ? renameRawNode(impl.raw, 'ServiceImplementation', targetName) : impl.raw;
      const withImpl = insertIntoContainer(tgt, 'ServiceImplementations', implRaw);
      if (withImpl === null) {
        warnings.push('Target has no ServiceImplementations container — code not moved.');
      } else {
        tgt = withImpl;
      }
    }
    targetSvcs.add(targetName);

    if (mode === 'move') {
      warnings.push(...detectServiceRefs(src, item.name));
      const freshDef = extractNode(src, 'ServiceDefinition', item.name);
      if (freshDef) src = removeSpan(src, freshDef.start, freshDef.end);
      const freshImpl = extractNode(src, 'ServiceImplementation', item.name);
      if (freshImpl) src = removeSpan(src, freshImpl.start, freshImpl.end);
    }
    members.push({ ...resultBase, status: mode === 'move' ? 'moved' : 'copied', warnings });
  }

  // Reformat both (normalizes indentation of spliced nodes, strips volatile attrs).
  const anyChange = members.some((m) => m.status === 'moved' || m.status === 'copied');
  return {
    sourceXml: anyChange && mode === 'move' ? formatEntityXml(src) : sourceXml,
    targetXml: anyChange ? formatEntityXml(tgt) : targetXml,
    members,
    hasBlockingConflict,
  };
}

// ── Deletion ──────────────────────────────────────────────────────────────────

export interface RemoveResult {
  sourceXml: string;
  members: MemberResult[];
}

/**
 * Delete the given properties/services from an entity. Services remove BOTH the
 * ServiceDefinition and its ServiceImplementation. Pure: no IO. Returns the
 * reformatted XML and a per-member log (with best-effort local-reference warnings).
 */
export function removeMembers({
  sourceXml,
  items,
}: {
  sourceXml: string;
  items: MigrateItem[];
}): RemoveResult {
  let src = sourceXml;
  const members: MemberResult[] = [];

  for (const item of items) {
    const warnings: string[] = [];
    if (item.kind === 'property') {
      const node = extractNode(src, 'PropertyDefinition', item.name);
      if (!node) {
        members.push({ kind: item.kind, name: item.name, status: 'missing', warnings: [`Property "${item.name}" not found.`] });
        continue;
      }
      warnings.push(...detectPropertyRefs(src, item.name));
      src = removeSpan(src, node.start, node.end);
      members.push({ kind: item.kind, name: item.name, status: 'moved', warnings });
      continue;
    }

    const def = extractNode(src, 'ServiceDefinition', item.name);
    const impl = extractNode(src, 'ServiceImplementation', item.name);
    if (!def && !impl) {
      members.push({ kind: item.kind, name: item.name, status: 'missing', warnings: [`Service "${item.name}" not found.`] });
      continue;
    }
    warnings.push(...detectServiceRefs(src, item.name));
    // Remove impl first only if it appears after def; recompute spans after each splice.
    if (def) {
      const d = extractNode(src, 'ServiceDefinition', item.name);
      if (d) src = removeSpan(src, d.start, d.end);
    }
    if (impl) {
      const i = extractNode(src, 'ServiceImplementation', item.name);
      if (i) src = removeSpan(src, i.start, i.end);
    }
    members.push({ kind: item.kind, name: item.name, status: 'moved', warnings });
  }

  const anyChange = members.some((m) => m.status === 'moved');
  return {
    sourceXml: anyChange ? formatEntityXml(src) : sourceXml,
    members,
  };
}
