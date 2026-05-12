import { promises as fs } from 'fs';
import type { Manifest } from './types';

export const VALID_TYPES = new Set([
  'DataShapes', 'Mashups', 'MediaEntities', 'Projects',
  'StyleThemes', 'Things', 'ThingShapes', 'ThingTemplates',
]);

export async function readManifest(manifestPath: string): Promise<Manifest> {
  const raw = await fs.readFile(manifestPath, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (err) {
    throw new Error(
      `Failed to parse JSON in ${manifestPath}: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  validateManifest(parsed);
  return parsed as Manifest;
}

export function validateManifest(raw: unknown): void {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Manifest must be a JSON object');
  }
  const obj = raw as Record<string, unknown>;
  if (!obj.projects || typeof obj.projects !== 'object' || Array.isArray(obj.projects)) {
    throw new Error('Manifest must contain a "projects" object');
  }
  const projects = obj.projects as Record<string, unknown>;
  for (const [projName, proj] of Object.entries(projects)) {
    if (!proj || typeof proj !== 'object' || Array.isArray(proj)) {
      throw new Error(`Project ${projName} must be an object`);
    }
    const p = proj as Record<string, unknown>;
    if (!p.alias || typeof p.alias !== 'string') {
      throw new Error(`Project ${projName} must have an "alias" string`);
    }
    if (!Array.isArray(p.exports)) {
      throw new Error(`Project ${projName} must have an "exports" array`);
    }
    for (const e of p.exports as unknown[]) {
      if (e === 'all') continue;
      if (typeof e !== 'string' || !VALID_TYPES.has(e)) {
        throw new Error(`Invalid export type "${String(e)}" for project ${projName}`);
      }
    }
  }
}
