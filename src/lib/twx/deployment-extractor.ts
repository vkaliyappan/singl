import path from 'path';
import { promises as fs } from 'fs';
import AdmZip from 'adm-zip';
import { formatEntityXml } from './xmlformat';
import type { DeploymentExtractResult } from './types';

const ENTITY_TYPE_FOLDERS = new Set([
  'Things', 'Mashups', 'DataShapes', 'ThingShapes', 'ThingTemplates',
  'Projects', 'MediaEntities', 'StyleThemes', 'Groups', 'Organizations',
  'StateDefinitions', 'StyleDefinitions',
]);

export interface DeploymentExtractProject {
  key: string;
  alias: string;
}

export interface RunDeploymentExtractOptions {
  projects: DeploymentExtractProject[];
  inputDir: string;
  outputDir: string;
  dryRun: boolean;
  onProgress?: (msg: string) => void;
}

export async function runDeploymentExtract({
  projects,
  inputDir,
  outputDir,
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
      `Point to the directory that contains the project folders (e.g. ./export/20260518-120000)`
    );
  }

  for (const folderName of subfolders) {
    // Match folder to a project: folder name is exactly {key} or {key}_{suffix}
    const proj = projects.find(
      p => folderName === p.key || folderName.startsWith(`${p.key}_`)
    );
    if (!proj) {
      onProgress?.(`[${folderName}] No matching project found, skipping.`);
      continue;
    }

    const zipPath = path.join(inputDir, folderName, `${folderName}.zip`);
    try {
      await fs.access(zipPath);
    } catch {
      onProgress?.(`[${proj.key}] ZIP not found at ${zipPath}, skipping.`);
      continue;
    }

    onProgress?.(`[${proj.key}] Extracting ${zipPath}...`);
    let zip: AdmZip;
    try {
      zip = new AdmZip(zipPath);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      onProgress?.(`[${proj.key}] Failed to open ZIP: ${errMsg}`);
      result.errors.push(`${proj.key}: failed to open ZIP - ${errMsg}`);
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
        onProgress?.(`[${proj.key}] Unrecognised entry "${entry.entryName}", skipping.`);
        result.entitiesSkipped += 1;
        continue;
      }

      const outDir = path.join(outputDir, proj.alias, proj.key, entityTypeFolder);
      const outFile = path.join(outDir, entityFileName);

      if (dryRun) {
        onProgress?.(`[${proj.key}] (dry-run) Would write ${outFile}`);
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
        onProgress?.(`[${proj.key}] Failed to write ${outFile}: ${errMsg}`);
        result.errors.push(`${proj.key}/${entry.entryName}: ${errMsg}`);
        result.entitiesSkipped += 1;
      }
    }

    result.zipFilesProcessed += 1;
    onProgress?.(`[${proj.key}] Done.`);
  }

  return result;
}
