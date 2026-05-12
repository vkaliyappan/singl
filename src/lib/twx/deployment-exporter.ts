import path from 'path';
import { promises as fs } from 'fs';
import { exportProjectToZip, downloadRepositoryFile } from './api';
import type { Manifest, DeploymentExportResult } from './types';

function formatDateStr(date: Date): string {
  const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
  return `${String(date.getDate()).padStart(2, '0')}-${MONTHS[date.getMonth()]}-${date.getFullYear()}`;
}

function formatTimestamp(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

export interface RunDeploymentExportOptions {
  baseUrl: string;
  appKey: string;
  manifest: Manifest;
  outputDir: string;
  projectFilter: string | null;
  parent: string | null;
  suffix: string | null;
  dryRun: boolean;
  onProgress?: (msg: string) => void;
}

export async function runDeploymentExport({
  baseUrl,
  appKey,
  manifest,
  outputDir,
  projectFilter,
  parent,
  suffix,
  dryRun,
  onProgress,
}: RunDeploymentExportOptions): Promise<DeploymentExportResult> {
  const result: DeploymentExportResult = { projectsProcessed: 0, zipsSaved: 0, errors: [] };
  const now = new Date();
  const dateStr = formatDateStr(now);
  const parentDir = parent ?? formatTimestamp(now);

  for (const [projectKey, proj] of Object.entries(manifest.projects)) {
    if (
      projectFilter &&
      projectFilter !== projectKey &&
      projectFilter !== proj.alias &&
      projectFilter !== proj.projectName
    ) {
      continue;
    }

    const twxProjectName = proj.projectName ?? projectKey;
    const folderName = suffix ? `${projectKey}_${dateStr}_${suffix}` : `${projectKey}_${dateStr}`;
    const fileName = `${folderName}.zip`;
    const remoteDirPath = `${parentDir}/${folderName}`;
    const localDir = path.join(outputDir, parentDir, folderName);
    const zipPath = path.join(localDir, fileName);

    if (dryRun) {
      onProgress?.(
        `[${projectKey}] (dry-run) Would export ${twxProjectName} → SystemRepository/${remoteDirPath}/${fileName}`
      );
      onProgress?.(`[${projectKey}] (dry-run) Would save locally → ${zipPath}`);
      result.projectsProcessed += 1;
      continue;
    }

    onProgress?.(
      `[${projectKey}] Exporting ${twxProjectName} to SystemRepository/${remoteDirPath}/${fileName}...`
    );
    try {
      await exportProjectToZip(baseUrl, appKey, twxProjectName, remoteDirPath, fileName);
      onProgress?.(`[${projectKey}] Export triggered. Downloading...`);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      onProgress?.(`[${projectKey}] Export failed: ${errMsg}`);
      result.errors.push(`${projectKey}: export failed - ${errMsg}`);
      result.projectsProcessed += 1;
      continue;
    }

    let buffer: Buffer;
    try {
      buffer = await downloadRepositoryFile(baseUrl, appKey, remoteDirPath, fileName);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      onProgress?.(`[${projectKey}] Download failed: ${errMsg}`);
      result.errors.push(`${projectKey}: download failed - ${errMsg}`);
      result.projectsProcessed += 1;
      continue;
    }

    await fs.mkdir(localDir, { recursive: true });
    await fs.writeFile(zipPath, buffer);
    onProgress?.(`[${projectKey}] Saved ${zipPath}`);
    result.zipsSaved += 1;
    result.projectsProcessed += 1;
  }

  return result;
}
