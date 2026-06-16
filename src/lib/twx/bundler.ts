import path from 'path';
import { promises as fs } from 'fs';

interface AdmZipInstance {
  addLocalFolder(localPath: string, zipPath?: string): void;
  getEntries(): unknown[];
  writeZip(targetFileName: string): void;
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
const AdmZip = require('adm-zip') as new () => AdmZipInstance;

export interface BundleProject {
  alias: string;
  projectName: string;
}

export interface BundleResult {
  projectsProcessed: number;
  zipsCreated: number;
  errors: string[];
}

export interface RunBundleOptions {
  projects: BundleProject[];
  srcDir: string;
  destDir: string;
  projectFilter: string | null;
  dryRun: boolean;
  onProgress?: (msg: string) => void;
}

export async function runBundle({
  projects,
  srcDir,
  destDir,
  projectFilter,
  dryRun,
  onProgress,
}: RunBundleOptions): Promise<BundleResult> {
  const result: BundleResult = { projectsProcessed: 0, zipsCreated: 0, errors: [] };

  for (const proj of projects) {
    const { alias, projectName } = proj;

    if (projectFilter && projectFilter !== alias && projectFilter !== projectName) {
      continue;
    }

    const projectSrc = path.join(srcDir, alias);
    const zipName = `${alias}.zip`;
    const zipDest = path.join(destDir, zipName);

    try {
      await fs.access(projectSrc);
    } catch {
      onProgress?.(`[${alias}] Skipping — source folder not found: ${projectSrc}`);
      continue;
    }

    onProgress?.(`[${alias}] Zipping ${projectSrc} → ${zipDest}`);

    if (dryRun) {
      onProgress?.(`[${alias}] (dry-run) Would create ${zipName}`);
      result.projectsProcessed += 1;
      continue;
    }

    try {
      await fs.mkdir(destDir, { recursive: true });
      const zip = new AdmZip();
      zip.addLocalFolder(projectSrc, alias);
      zip.writeZip(zipDest);
      const entries = zip.getEntries().length;
      onProgress?.(`[${alias}] Done — ${zipName} (${entries} entries)`);
      result.projectsProcessed += 1;
      result.zipsCreated += 1;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      onProgress?.(`[${alias}] Error: ${msg}`);
      result.errors.push(`${alias}: ${msg}`);
    }
  }

  return result;
}
