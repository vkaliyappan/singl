import path from 'path';
import { promises as fs } from 'fs';
import AdmZip from 'adm-zip';
import { formatEntityXml } from './xmlformat';
import type { Manifest, DeploymentExtractResult } from './types';

const ENTITY_TYPE_FOLDERS = new Set([
  'Things', 'Mashups', 'DataShapes', 'ThingShapes', 'ThingTemplates',
  'Projects', 'MediaEntities', 'StyleThemes', 'Groups', 'Organizations',
  'StateDefinitions', 'StyleDefinitions',
]);

const FOLDER_NAME_RE = /^([A-Za-z0-9_]+?)_\d{2}-[A-Z]{3}-\d{4}$/;

export interface RunDeploymentExtractOptions {
  manifest: Manifest;
  inputDir: string;
  outputDir: string;
  projectFilter: string | null;
  dryRun: boolean;
  onProgress?: (msg: string) => void;
}

export async function runDeploymentExtract({
  manifest,
  inputDir,
  outputDir,
  projectFilter,
  dryRun,
  onProgress,
}: RunDeploymentExtractOptions): Promise<DeploymentExtractResult> {
  const result: DeploymentExtractResult = {
    zipFilesProcessed: 0,
    entitiesExtracted: 0,
    entitiesSkipped: 0,
    errors: [],
  };

  let subfolders: string[];
  try {
    const entries = await fs.readdir(inputDir, { withFileTypes: true });
    subfolders = entries.filter(e => e.isDirectory()).map(e => e.name);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Failed to read input directory "${inputDir}": ${errMsg}. ` +
      `Use --input to point to the directory that contains the project folders (e.g. ./export/20260421-143000)`
    );
  }

  for (const folderName of subfolders) {
    const match = FOLDER_NAME_RE.exec(folderName);
    if (!match) continue;

    const projectKey = match[1];
    const proj = manifest.projects[projectKey];
    if (!proj) {
      onProgress?.(`[${folderName}] No manifest entry for project key "${projectKey}", skipping.`);
      continue;
    }

    if (
      projectFilter &&
      projectFilter !== projectKey &&
      projectFilter !== proj.alias &&
      projectFilter !== proj.projectName
    ) {
      continue;
    }

    const zipPath = path.join(inputDir, folderName, `${folderName}.zip`);
    try {
      await fs.access(zipPath);
    } catch {
      onProgress?.(`[${projectKey}] ZIP not found at ${zipPath}, skipping.`);
      continue;
    }

    onProgress?.(`[${projectKey}] Extracting ${zipPath}...`);
    let zip: AdmZip;
    try {
      zip = new AdmZip(zipPath);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      onProgress?.(`[${projectKey}] Failed to open ZIP: ${errMsg}`);
      result.errors.push(`${projectKey}: failed to open ZIP - ${errMsg}`);
      continue;
    }

    for (const entry of zip.getEntries()) {
      if (entry.isDirectory) continue;

      const parts = entry.entryName.replace(/\\/g, '/').split('/').filter(Boolean);
      if (parts.length < 2) {
        result.entitiesSkipped += 1;
        continue;
      }

      let entityTypeFolder: string;
      let entityFileName: string;

      if (ENTITY_TYPE_FOLDERS.has(parts[0])) {
        entityTypeFolder = parts[0];
        entityFileName = parts.slice(1).join('/');
      } else if (parts.length >= 3 && ENTITY_TYPE_FOLDERS.has(parts[1])) {
        entityTypeFolder = parts[1];
        entityFileName = parts.slice(2).join('/');
      } else {
        onProgress?.(`[${projectKey}] Unrecognised entry "${entry.entryName}", skipping.`);
        result.entitiesSkipped += 1;
        continue;
      }

      const alias = proj.alias ?? projectKey;
      const outDir = path.join(outputDir, alias, projectKey, entityTypeFolder);
      const outFile = path.join(outDir, entityFileName);

      if (dryRun) {
        onProgress?.(`[${projectKey}] (dry-run) Would write ${outFile}`);
        result.entitiesExtracted += 1;
        continue;
      }

      try {
        const rawXml = zip.readAsText(entry);
        const xml = formatEntityXml(rawXml);
        await fs.mkdir(outDir, { recursive: true });
        await fs.writeFile(outFile, xml, 'utf8');
        result.entitiesExtracted += 1;
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        onProgress?.(`[${projectKey}] Failed to write ${outFile}: ${errMsg}`);
        result.errors.push(`${projectKey}/${entry.entryName}: ${errMsg}`);
        result.entitiesSkipped += 1;
      }
    }

    result.zipFilesProcessed += 1;
    onProgress?.(`[${projectKey}] Done.`);
  }

  return result;
}
