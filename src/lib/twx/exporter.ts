import path from 'path';
import { promises as fs } from 'fs';
import { getProjectEntities, exportEntity } from './api';
import { formatEntityXml } from './xmlformat';
import type { Manifest, TwxEntity, ExportResult } from './types';

const TYPE_TO_PLURAL: Record<string, string> = {
  DataShape: 'DataShapes',
  Group: 'Groups',
  Mashup: 'Mashups',
  MediaEntity: 'MediaEntities',
  Organization: 'Organizations',
  Project: 'Projects',
  StateDefinition: 'StateDefinitions',
  StyleDefinition: 'StyleDefinitions',
  StyleTheme: 'StyleThemes',
  Thing: 'Things',
  ThingShape: 'ThingShapes',
  ThingTemplate: 'ThingTemplates',
  Transformer: 'Transformers',
};

function pluralType(entityType: string): string {
  return TYPE_TO_PLURAL[entityType] ?? entityType;
}

export function filterEntities(allEntities: TwxEntity[], exportFilter: string[]): TwxEntity[] {
  if (!exportFilter || exportFilter.length === 0) return [];
  if (exportFilter.length === 1 && exportFilter[0] === 'all') return allEntities;
  const allowed = new Set(exportFilter);
  return allEntities.filter(e => allowed.has(e.type));
}

export async function writeEntityXml(
  outputDir: string,
  alias: string,
  projectName: string,
  entityType: string,
  entityName: string,
  xmlContent: string,
  dryRun: boolean,
  onProgress?: (msg: string) => void
): Promise<void> {
  const dir = path.join(/*turbopackIgnore: true*/ outputDir, 'WindchillClients', 'Thingworx', alias, projectName, pluralType(entityType));
  const filePath = path.join(/*turbopackIgnore: true*/ dir, `${entityName}.xml`);
  if (dryRun) {
    onProgress?.(`[${alias}] (dry-run) Would write ${filePath}`);
    return;
  }
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(filePath, xmlContent, 'utf8');
}

export interface RunExportOptions {
  baseUrl: string;
  appKey: string;
  manifest: Manifest;
  outputDir: string;
  projectFilter: string | null;
  dryRun: boolean;
  onProgress?: (msg: string) => void;
}

export async function runExport({
  baseUrl,
  appKey,
  manifest,
  outputDir,
  projectFilter,
  dryRun,
  onProgress,
}: RunExportOptions): Promise<ExportResult> {
  const result: ExportResult = {
    projectsProcessed: 0,
    entitiesExported: 0,
    entitiesSkipped: 0,
    errors: [],
  };

  for (const [projectName, proj] of Object.entries(manifest.projects)) {
    const twxProjectName = proj.projectName ?? projectName;
    if (
      projectFilter &&
      projectFilter !== projectName &&
      projectFilter !== proj.alias &&
      projectFilter !== twxProjectName
    ) {
      continue;
    }
    const alias = proj.alias ?? projectName;
    const candidates: string[] = [];
    if (twxProjectName) candidates.push(twxProjectName);
    if (projectName !== twxProjectName) candidates.push(projectName);
    if (proj.alias && !candidates.includes(proj.alias)) candidates.push(proj.alias);

    let entities: TwxEntity[] | null = null;
    let usedProjectName: string | null = null;

    for (const candidate of candidates) {
      onProgress?.(`[${candidate}] Fetching entity list for ${candidate}...`);
      try {
        entities = await getProjectEntities(baseUrl, appKey, candidate);
        usedProjectName = candidate;
        break;
      } catch (err) {
        const apiErr = err as { status?: number; message?: string };
        if (apiErr.status === 404) {
          onProgress?.(`[${candidate}] Not found, trying next candidate...`);
          continue;
        }
        onProgress?.(`[${candidate}] Failed to list entities for ${candidate}: ${apiErr.message}`);
        result.errors.push(`Project ${candidate}: ${apiErr.message}`);
        entities = null;
        usedProjectName = null;
        break;
      }
    }

    if (!entities) continue;

    const filtered = filterEntities(entities, proj.exports);
    onProgress?.(`[${alias}] Found ${entities.length} entities (exporting ${filtered.length})`);

    for (const e of filtered) {
      const { name, type } = e;
      try {
        const exportLabel = usedProjectName ?? twxProjectName ?? projectName;
        if (dryRun) {
          onProgress?.(`[${exportLabel}] (dry-run) Would export ${type}/${name}`);
          result.entitiesExported += 1;
          continue;
        }
        onProgress?.(`[${exportLabel}] Exporting ${type}/${name}...`);
        const rawXml = await exportEntity(baseUrl, appKey, type, name);
        const xml = formatEntityXml(rawXml);
        await writeEntityXml(outputDir, alias, twxProjectName, type, name, xml, dryRun, onProgress);
        result.entitiesExported += 1;
      } catch (err) {
        const failedLabel = usedProjectName ?? twxProjectName ?? projectName;
        const errMsg = err instanceof Error ? err.message : String(err);
        onProgress?.(`[${failedLabel}] Failed to export ${type}/${name}: ${errMsg}`);
        result.entitiesSkipped += 1;
        result.errors.push(`${failedLabel}/${type}/${name}: ${errMsg}`);
      }
    }

    result.projectsProcessed += 1;
    onProgress?.(
      `[${usedProjectName ?? twxProjectName}] Done. ${result.entitiesExported} exported so far, ${result.entitiesSkipped} skipped.`
    );
  }

  return result;
}
