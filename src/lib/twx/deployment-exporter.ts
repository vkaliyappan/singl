import path from 'path';
import { promises as fs } from 'fs';
import { exportProjectToZip, downloadRepositoryFile } from './api';
import type { DeploymentExportResult } from './types';

export interface DeploymentProject {
  key: string;
  twxName: string;
}

function formatTimestamp(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

export interface RunDeploymentExportOptions {
  baseUrl: string;
  appKey: string;
  projects: DeploymentProject[];
  outputDir: string;
  parent: string | null;
  suffix: string | null;
  dryRun: boolean;
  onProgress?: (msg: string) => void;
}

export async function runDeploymentExport({
  baseUrl,
  appKey,
  projects,
  outputDir,
  parent,
  suffix,
  dryRun,
  onProgress,
}: RunDeploymentExportOptions): Promise<DeploymentExportResult> {
  const now = new Date();
  const parentDir = parent ?? formatTimestamp(now);
  const result: DeploymentExportResult = {
    projectsProcessed: 0,
    zipsSaved: 0,
    savedFiles: [],
    exportedDir: path.join(outputDir, parentDir),
    errors: [],
  };

  for (const { key: projectKey, twxName: twxProjectName } of projects) {
    const folderName = suffix ? `${projectKey}_${suffix}` : projectKey;
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
    result.savedFiles.push(zipPath);
    result.zipsSaved += 1;
    result.projectsProcessed += 1;
  }

  return result;
}
