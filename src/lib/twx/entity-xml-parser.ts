export interface ParsedProperty {
  name: string;
  description: string;
  baseType: string;
  defaultValue?: string;
  isPersistent?: boolean;
  isLogged?: boolean;
  isReadOnly?: boolean;
  dataShape?: string;
  aspects: Record<string, unknown>;
}

export interface ParsedServiceParam {
  name: string;
  description: string;
  baseType: string;
  isRequired?: boolean;
  defaultValue?: string;
  dataShape?: string;
}

export interface ParsedServiceResult {
  name?: string;
  description?: string;
  baseType: string;
  dataShape?: string;
}

export interface ParsedService {
  name: string;
  category: string;
  description: string;
  parameters: ParsedServiceParam[];
  resultType: ParsedServiceResult;
  handlerName?: string;
  script?: string;
  isAsync?: boolean;
  isCustom?: boolean;
}

export interface ParsedSubscription {
  name: string;
  eventName: string;
  source: string;
  sourceType?: string;
  handlerName?: string;
  script?: string;
  enabled: boolean;
}

export interface ParsedConfigTable {
  name: string;
  description?: string;
  isMultiRow?: boolean;
  rows: Record<string, string>[];
}

export interface ParsedTwxEntity {
  name: string;
  entityType: string;
  description: string;
  projectName?: string;
  tags: string[];
  baseThingTemplate?: string;
  implementedShapes: string[];
  properties: ParsedProperty[];
  services: ParsedService[];
  subscriptions: ParsedSubscription[];
  configurationTables: ParsedConfigTable[];
  isMashup?: boolean;
  mashupType?: string;
  rawXml?: string;
}

// Known container tags that wrap singular entities
const KNOWN_CONTAINERS = new Set([
  'ENTITIES',
  'THINGS',
  'THINGTEMPLATES',
  'THINGSHAPES',
  'DATASHAPES',
  'MASHUPS',
  'PROJECTS',
  'GROUPS',
  'ORGANIZATIONS',
  'STYLETHEMES',
  'MEDIAENTITIES',
  'MODELTAGVOCABULARIES',
  'MENUS',
  'LOCALIZATIONTABLES',
  'DASHBOARDS',
  'AUTHENTICATORS',
  'DIRECTORIES',
]);

/**
 * Locate the primary entity element in a parsed XML document.
 * Recursively unwraps <Entities> and plural collection wrappers (<Things>, <ThingTemplates>, etc.)
 */
function findEntityElement(root: Element): Element {
  // If root has a name attribute, it's likely the entity
  if (root.getAttribute('name') && root.tagName.toUpperCase() !== 'ENTITIES') {
    return root;
  }

  // Iterate over children to find a child that is an entity
  for (let i = 0; i < root.children.length; i++) {
    const child = root.children[i];
    const tag = child.tagName;
    if (tag === 'ExtensionPackages' || tag === 'Owner') continue;

    if (child.getAttribute('name')) {
      return child;
    }

    // If child is a plural container like <Things>, <DataShapes>, search inside it
    if (KNOWN_CONTAINERS.has(tag.toUpperCase())) {
      const nested = findEntityElement(child);
      if (nested !== child) {
        return nested;
      }
    }
  }

  // Fallback to first non-metadata child if available
  for (let i = 0; i < root.children.length; i++) {
    const child = root.children[i];
    if (child.tagName !== 'ExtensionPackages' && child.tagName !== 'Owner') {
      return child;
    }
  }

  return root;
}

/**
 * Safely parse a ThingWorx entity XML string into a structured model.
 */
export function parseTwxEntityXml(xmlText: string): ParsedTwxEntity | null {
  if (!xmlText || typeof window === 'undefined') return null;

  try {
    const parser = new DOMParser();
    const doc = parser.parseFromString(xmlText, 'text/xml');

    const parserError = doc.querySelector('parsererror');
    if (parserError) {
      return null;
    }

    const entityEl = findEntityElement(doc.documentElement);

    const entityType = entityEl.tagName;
    const name = entityEl.getAttribute('name') || '';
    const description = entityEl.getAttribute('description') || '';
    const projectName =
      entityEl.getAttribute('projectName') || entityEl.getAttribute('project') || undefined;
    const baseThingTemplate =
      entityEl.getAttribute('thingTemplate') ||
      entityEl.getAttribute('baseThingTemplate') ||
      undefined;
    const tags = (entityEl.getAttribute('tags') || '')
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);

    // Implemented shapes
    const implementedShapes: string[] = [];
    const shapeEls = entityEl.querySelectorAll('ImplementedShapes > ImplementedShape, thingShapes > ThingShape, thingShapes > ImplementedShape');
    shapeEls.forEach((el) => {
      const sName = el.getAttribute('name');
      if (sName && !implementedShapes.includes(sName)) implementedShapes.push(sName);
    });

    // ── Properties & Fields ────────────────────────────────────────────────
    const properties: ParsedProperty[] = [];
    const seenPropNames = new Set<string>();

    // 1. Thing / ThingTemplate / ThingShape PropertyDefinitions
    const propDefs = entityEl.querySelectorAll('PropertyDefinitions > PropertyDefinition');
    propDefs.forEach((p) => {
      if (p.closest('ConfigurationTable') || p.closest('ServiceImplementation')) return;
      const pName = p.getAttribute('name') || '';
      if (!pName || seenPropNames.has(pName)) return;
      seenPropNames.add(pName);

      const baseType = p.getAttribute('baseType') || 'STRING';
      const pDesc = p.getAttribute('description') || '';
      const defaultValue =
        p.getAttribute('defaultValue') || p.getAttribute('aspect.defaultValue') || undefined;
      const isPersistent =
        p.getAttribute('isPersistent') === 'true' ||
        p.getAttribute('aspect.isPersistent') === 'true';
      const isLogged =
        p.getAttribute('isLogged') === 'true' || p.getAttribute('aspect.isLogged') === 'true';
      const isReadOnly =
        p.getAttribute('isReadOnly') === 'true' ||
        p.getAttribute('aspect.isReadOnly') === 'true';
      const dataShape =
        p.getAttribute('dataShape') ||
        p.getAttribute('aspect.dataShape') ||
        undefined;

      const aspects: Record<string, unknown> = {};
      // Attributes starting with aspect.
      for (let i = 0; i < p.attributes.length; i++) {
        const attr = p.attributes[i];
        if (attr.name.startsWith('aspect.')) {
          aspects[attr.name.slice(7)] = attr.value;
        }
      }
      // Child Aspects
      const aspectEls = p.querySelectorAll('Aspects > Aspect');
      aspectEls.forEach((a) => {
        const aName = a.getAttribute('name');
        const aVal = a.getAttribute('value');
        if (aName && aVal !== null) {
          aspects[aName] = aVal;
        }
      });

      properties.push({
        name: pName,
        description: pDesc,
        baseType,
        defaultValue,
        isPersistent,
        isLogged,
        isReadOnly,
        dataShape: dataShape || (aspects.dataShape as string | undefined),
        aspects,
      });
    });

    // 2. DataShape FieldDefinitions (only for DataShape entities)
    if (entityType.toLowerCase() === 'datashape' || entityType.toLowerCase() === 'datashapes') {
      const fieldDefs = entityEl.querySelectorAll('FieldDefinitions > FieldDefinition');
      fieldDefs.forEach((f) => {
        if (f.closest('ParameterDefinitions') || f.closest('ConfigurationTable') || f.closest('ServiceImplementation')) return;

        const fName = f.getAttribute('name') || '';
        if (!fName || seenPropNames.has(fName)) return;
        seenPropNames.add(fName);

        const baseType = f.getAttribute('baseType') || 'STRING';
        const fDesc = f.getAttribute('description') || '';
        const defaultValue =
          f.getAttribute('defaultValue') || f.getAttribute('aspect.defaultValue') || undefined;
        const isPrimaryKey =
          f.getAttribute('aspect.isPrimaryKey') === 'true' || f.getAttribute('isPrimaryKey') === 'true';
        const dataShape =
          f.getAttribute('dataShape') || f.getAttribute('aspect.dataShape') || undefined;

        const aspects: Record<string, unknown> = {};
        if (isPrimaryKey) aspects.isPrimaryKey = true;

        properties.push({
          name: fName,
          description: fDesc,
          baseType,
          defaultValue,
          isPersistent: isPrimaryKey,
          dataShape,
          aspects,
        });
      });
    }

    // ── Service Implementations (Script Code) ──────────────────────────────
    const scriptMap = new Map<string, { handlerName: string; script: string }>();
    const serviceImpls = entityEl.querySelectorAll('ServiceImplementations > ServiceImplementation');
    serviceImpls.forEach((impl) => {
      const sName = impl.getAttribute('name');
      const handlerName = impl.getAttribute('handlerName') || 'Script';
      if (!sName) return;

      const codeEl = impl.querySelector('code');
      let script = '';
      if (codeEl) {
        script = codeEl.textContent || '';
      }
      scriptMap.set(sName, { handlerName, script });
    });

    // ── Service Definitions ────────────────────────────────────────────────
    const services: ParsedService[] = [];
    const serviceDefs = entityEl.querySelectorAll('ServiceDefinitions > ServiceDefinition');
    serviceDefs.forEach((s) => {
      const sName = s.getAttribute('name') || '';
      if (!sName) return;
      const category = s.getAttribute('category') || 'General';
      const sDesc = s.getAttribute('description') || '';
      const isAsync =
        s.getAttribute('isAsync') === 'true' || s.getAttribute('aspect.isAsync') === 'true';

      // Parameter definitions
      const parameters: ParsedServiceParam[] = [];
      const paramEls = s.querySelectorAll('ParameterDefinitions > FieldDefinition');
      paramEls.forEach((param) => {
        const pName = param.getAttribute('name') || '';
        if (!pName) return;
        const pType = param.getAttribute('baseType') || 'STRING';
        const pDesc = param.getAttribute('description') || '';
        const isRequired =
          param.getAttribute('isRequired') === 'true' ||
          param.getAttribute('aspect.isRequired') === 'true';
        const dataShape =
          param.getAttribute('dataShape') || param.getAttribute('aspect.dataShape') || undefined;
        const defVal =
          param.getAttribute('defaultValue') || param.getAttribute('aspect.defaultValue') || undefined;

        parameters.push({
          name: pName,
          description: pDesc,
          baseType: pType,
          isRequired,
          defaultValue: defVal,
          dataShape,
        });
      });

      // Result type
      const resultEl = s.querySelector('ResultType');
      let resultType: ParsedServiceResult = { baseType: 'NOTHING' };
      if (resultEl) {
        const rType = resultEl.getAttribute('baseType') || 'NOTHING';
        const rDesc = resultEl.getAttribute('description') || '';
        const dataShape =
          resultEl.getAttribute('dataShape') ||
          resultEl.getAttribute('aspect.dataShape') ||
          undefined;
        resultType = {
          baseType: rType,
          description: rDesc,
          dataShape,
        };
      }

      const impl = scriptMap.get(sName);
      services.push({
        name: sName,
        category,
        description: sDesc,
        parameters,
        resultType,
        handlerName: impl?.handlerName,
        script: impl?.script,
        isAsync,
        isCustom: !!impl?.script,
      });
    });

    // ── Subscriptions / Events ─────────────────────────────────────────────
    const subscriptions: ParsedSubscription[] = [];
    const subEls = entityEl.querySelectorAll('Subscriptions > Subscription');
    subEls.forEach((sub) => {
      const sName = sub.getAttribute('name') || '';
      const eventName = sub.getAttribute('eventName') || '';
      const source = sub.getAttribute('source') || '';
      const sourceType = sub.getAttribute('sourceType') || undefined;
      const handlerName = sub.getAttribute('handlerName') || 'Script';
      const enabled = sub.getAttribute('enabled') !== 'false';
      const codeEl = sub.querySelector('code');
      const script = codeEl ? codeEl.textContent || '' : undefined;

      subscriptions.push({
        name: sName,
        eventName,
        source,
        sourceType,
        handlerName,
        script,
        enabled,
      });
    });

    // ── Configuration Tables ───────────────────────────────────────────────
    const configurationTables: ParsedConfigTable[] = [];
    const configTableEls = entityEl.querySelectorAll(':scope > ConfigurationTables > ConfigurationTable, ConfigurationTables > ConfigurationTable');
    configTableEls.forEach((ct) => {
      const tName = ct.getAttribute('name') || '';
      if (!tName || tName === 'Script') return; // Skip internal script tables
      const tDesc = ct.getAttribute('description') || undefined;
      const isMultiRow = ct.getAttribute('isMultiRow') === 'true';

      const rows: Record<string, string>[] = [];
      const rowEls = ct.querySelectorAll('Rows > Row');
      rowEls.forEach((r) => {
        const rowData: Record<string, string> = {};
        for (let j = 0; j < r.children.length; j++) {
          const col = r.children[j];
          rowData[col.tagName] = col.textContent || '';
        }
        rows.push(rowData);
      });

      configurationTables.push({
        name: tName,
        description: tDesc,
        isMultiRow,
        rows,
      });
    });

    const isMashup =
      entityType.toLowerCase() === 'mashup' || xmlText.includes('<mashupContent>');
    const mashupType = entityEl.getAttribute('mashupType') || (isMashup ? 'Mashup' : undefined);

    return {
      name: name || 'Unnamed Entity',
      entityType,
      description,
      projectName,
      tags,
      baseThingTemplate,
      implementedShapes,
      properties,
      services,
      subscriptions,
      configurationTables,
      isMashup,
      mashupType,
      rawXml: xmlText,
    };
  } catch {
    return null;
  }
}

/**
 * Returns a badge color & acronym for a ThingWorx entity type.
 */
export function getEntityTypeBadge(entityType: string): {
  label: string;
  bg: string;
  text: string;
  border: string;
} {
  switch (entityType.toLowerCase()) {
    case 'thing':
    case 'things':
      return {
        label: 'T',
        bg: 'bg-blue-500/10 dark:bg-blue-500/20',
        text: 'text-blue-600 dark:text-blue-400',
        border: 'border-blue-500/30',
      };
    case 'thingtemplate':
    case 'thingtemplates':
      return {
        label: 'TT',
        bg: 'bg-cyan-500/10 dark:bg-cyan-500/20',
        text: 'text-cyan-600 dark:text-cyan-400',
        border: 'border-cyan-500/30',
      };
    case 'thingshape':
    case 'thingshapes':
      return {
        label: 'TS',
        bg: 'bg-purple-500/10 dark:bg-purple-500/20',
        text: 'text-purple-600 dark:text-purple-400',
        border: 'border-purple-500/30',
      };
    case 'mashup':
    case 'mashups':
      return {
        label: 'M',
        bg: 'bg-emerald-500/10 dark:bg-emerald-500/20',
        text: 'text-emerald-600 dark:text-emerald-400',
        border: 'border-emerald-500/30',
      };
    case 'datashape':
    case 'datashapes':
      return {
        label: 'DS',
        bg: 'bg-amber-500/10 dark:bg-amber-500/20',
        text: 'text-amber-600 dark:text-amber-400',
        border: 'border-amber-500/30',
      };
    case 'modeltagvocabulary':
    case 'modeltagvocabularies':
      return {
        label: 'TAG',
        bg: 'bg-rose-500/10 dark:bg-rose-500/20',
        text: 'text-rose-600 dark:text-rose-400',
        border: 'border-rose-500/30',
      };
    case 'project':
    case 'projects':
      return {
        label: 'PRJ',
        bg: 'bg-indigo-500/10 dark:bg-indigo-500/20',
        text: 'text-indigo-600 dark:text-indigo-400',
        border: 'border-indigo-500/30',
      };
    case 'group':
    case 'groups':
      return {
        label: 'GRP',
        bg: 'bg-teal-500/10 dark:bg-teal-500/20',
        text: 'text-teal-600 dark:text-teal-400',
        border: 'border-teal-500/30',
      };
    case 'organization':
    case 'organizations':
      return {
        label: 'ORG',
        bg: 'bg-orange-500/10 dark:bg-orange-500/20',
        text: 'text-orange-600 dark:text-orange-400',
        border: 'border-orange-500/30',
      };
    default:
      return {
        label: 'E',
        bg: 'bg-zinc-500/10 dark:bg-zinc-500/20',
        text: 'text-zinc-600 dark:text-zinc-400',
        border: 'border-zinc-500/30',
      };
  }
}
