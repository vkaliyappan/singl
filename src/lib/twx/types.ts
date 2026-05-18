export interface ParsedFlags {
  env?: string;
  manifest?: string;
  output?: string;
  input?: string;
  project?: string;
  parent?: string;
  suffix?: string;
  backup?: boolean | string;
  'dry-run'?: boolean | string;
  dryRun?: boolean | string;
  dry?: boolean;
  help?: boolean | string;
  [key: string]: string | boolean | undefined;
}

export interface Connection {
  baseUrl: string;
  appKey: string;
}

export interface ManifestProject {
  alias: string;
  exports: string[];
  projectName?: string;
}

export interface Manifest {
  projects: Record<string, ManifestProject>;
}

export interface TwxEntity {
  name: string;
  type: string;
}

export interface ExportResult {
  projectsProcessed: number;
  entitiesExported: number;
  entitiesSkipped: number;
  errors: string[];
}

export interface DeploymentExportResult {
  projectsProcessed: number;
  zipsSaved: number;
  savedFiles: string[];
  exportedDir: string;
  errors: string[];
}

export interface DeploymentExtractResult {
  zipFilesProcessed: number;
  entitiesExtracted: number;
  entitiesSkipped: number;
  errors: string[];
}

export interface XmlToken {
  type: 'cdata' | 'tag' | 'text';
  value: string;
}

export interface ParsedTag {
  name: string;
  attrs: string[];
}

export type FilterAttrCallback = (
  name: string,
  value: string
) => false | true | { name: string; value: string };
