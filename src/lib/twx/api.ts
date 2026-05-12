import type { TwxEntity } from './types';

class ApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

const TYPE_TO_COLLECTION: Record<string, string> = {
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
};

function collectionName(entityType: string): string {
  return TYPE_TO_COLLECTION[entityType] ?? entityType;
}

async function safeRead(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '<unreadable body>';
  }
}

export async function getProjectEntities(
  baseUrl: string,
  appKey: string,
  projectName: string
): Promise<TwxEntity[]> {
  const url = `${baseUrl.replace(/\/$/, '')}/Projects/${encodeURIComponent(projectName)}/Services/GetEntities`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { appKey, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({}),
  });
  if (!res.ok) {
    const body = await safeRead(res);
    throw new ApiError(
      `GetEntities ${projectName} failed: ${res.status} ${res.statusText} - ${body}`,
      res.status
    );
  }
  const json = (await res.json()) as { rows?: TwxEntity[] };
  return json.rows ?? [];
}

export async function exportEntity(
  baseUrl: string,
  appKey: string,
  entityType: string,
  entityName: string
): Promise<string> {
  const base = baseUrl.replace(/\/$/, '');
  const collection = collectionName(entityType);
  const url = `${base}/Exporter/${collection}/${encodeURIComponent(entityName)}`;
  const res = await fetch(url, {
    method: 'GET',
    headers: { appKey, Accept: 'text/xml' },
  });
  if (!res.ok) {
    const body = await safeRead(res);
    throw new Error(
      `Export ${collection}/${entityName} failed: ${res.status} ${res.statusText} - ${body}`
    );
  }
  return res.text();
}

export async function exportProjectToZip(
  baseUrl: string,
  appKey: string,
  twxProjectName: string,
  remoteDirPath: string,
  fileName: string
): Promise<unknown> {
  const url = `${baseUrl.replace(/\/$/, '')}/Resources/SourceControlFunctions/Services/ExportSourceControlledEntitiesToZipFile`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { appKey, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      repositoryName: 'SystemRepository',
      path: remoteDirPath,
      name: fileName.endsWith('.zip') ? fileName.slice(0, -4) : fileName,
      projectName: twxProjectName,
    }),
  });
  if (!res.ok) {
    throw new Error(
      `ExportToZip ${twxProjectName} failed: ${res.status} ${res.statusText} - ${await safeRead(res)}`
    );
  }
  const json = (await res.json()) as { result?: unknown };
  return json.result ?? json;
}

export async function downloadRepositoryFile(
  baseUrl: string,
  appKey: string,
  remoteDirPath: string,
  fileName: string
): Promise<Buffer> {
  const base = baseUrl.replace(/\/$/, '');

  const listUrl = `${base}/Things/SystemRepository/Services/GetFileListingWithLinks`;
  const listRes = await fetch(listUrl, {
    method: 'POST',
    headers: { appKey, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ path: remoteDirPath }),
  });
  if (!listRes.ok) {
    throw new Error(
      `GetFileListingWithLinks failed: ${listRes.status} ${listRes.statusText} - ${await safeRead(listRes)}`
    );
  }
  const listJson = (await listRes.json()) as {
    rows?: Array<{ name: string; downloadLink?: string }>;
  };
  const rows = listJson.rows ?? [];
  const entry = rows.find(r => r.name === fileName);
  if (!entry) {
    const names = rows.map(r => r.name).join(', ');
    throw new Error(
      `File "${fileName}" not found in SystemRepository/${remoteDirPath} — found: [${names}]`
    );
  }
  if (!entry.downloadLink) {
    throw new Error(`No downloadLink for "${fileName}" — entry: ${JSON.stringify(entry)}`);
  }

  const origin = new URL(baseUrl).origin;
  const downloadUrl = `${origin}${entry.downloadLink}`;

  const downloadRes = await fetch(downloadUrl, {
    headers: { appKey, Accept: 'application/octet-stream' },
  });
  if (!downloadRes.ok) {
    throw new Error(
      `Download ${downloadUrl} failed: ${downloadRes.status} ${downloadRes.statusText} - ${await safeRead(downloadRes)}`
    );
  }
  return Buffer.from(await downloadRes.arrayBuffer());
}
