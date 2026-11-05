import { listEnvironments } from "@/lib/settings"
import { listEntityFiles, readEntityFile, writeEntityFile } from "@/lib/entities"
import { safeEnvDir } from "@/lib/twx/links"
import {
  migrateMembers,
  parseEntityMembers,
  removeMembers,
  type EntityMembers,
  type MemberResult,
  type MigrateItem,
  type MigrateMode,
} from "@/lib/twx/entity-migrate"
import { formatEntityXml } from "@/lib/twx/xmlformat"

// singl-web's /api/twx-migrate/* routes, run in the webview over the entity
// file commands (src/lib/entities.ts). Paths are relative to
// <workspace>/twx-entities and start with the environment folder.
// Errors reject with `{ code, message }` or an Error; read them with errorMessage from @/lib/settings.

/** Only these entity collections support property/service migration. */
export const MIGRATABLE_COLLECTIONS = ["Things", "ThingShapes", "ThingTemplates"] as const
const COLLECTION_SET = new Set<string>(MIGRATABLE_COLLECTIONS)

export interface EntityFile {
  /** Path relative to the twx-entities folder, used as an opaque id. */
  relPath: string
  env: string
  alias: string
  project: string
  collection: string
  name: string
}

export interface MoveResult {
  members: MemberResult[]
  hasBlockingConflict: boolean
  committed: boolean
  sourceOriginal: string
  targetOriginal: string
  sourcePreview: string
  targetPreview: string
}

export interface DeleteResult {
  members: MemberResult[]
  committed: boolean
  sourceOriginal: string
  sourcePreview: string
}

/** Environment folders of the enabled environments, in settings order. */
export async function listMigrateEnvs(): Promise<string[]> {
  const envs = await listEnvironments()
  return [...new Set(envs.filter((e) => e.enabled).map((e) => safeEnvDir(e.environment)))]
}

/**
 * Every migratable entity XML file of one environment folder.
 * Layout: <env>/WindchillClients/Thingworx/<alias>/<project>/<Collection>/<Name>.xml
 */
export async function listMigrateFiles(env: string): Promise<EntityFile[]> {
  const root = `${env}/WindchillClients/Thingworx`
  let paths: string[]
  try {
    paths = await listEntityFiles(root)
  } catch {
    // Not exported yet: nothing to migrate.
    return []
  }
  const out: EntityFile[] = []
  for (const p of paths) {
    const parts = p.split("/")
    if (parts.length !== 4) continue
    const [alias, project, collection, file] = parts
    if (!COLLECTION_SET.has(collection) || !file.toLowerCase().endsWith(".xml")) continue
    out.push({ relPath: `${root}/${p}`, env, alias, project, collection, name: file.replace(/\.xml$/i, "") })
  }
  out.sort((a, b) => a.collection.localeCompare(b.collection) || a.name.localeCompare(b.name))
  return out
}

function assertXml(relPath: string) {
  if (!relPath.trim()) throw new Error("No entity file chosen.")
  if (!relPath.toLowerCase().endsWith(".xml")) throw new Error("Only .xml entity files are allowed.")
}

export async function getEntityMembers(relPath: string): Promise<EntityMembers> {
  assertXml(relPath)
  return parseEntityMembers(await readEntityFile(relPath))
}

/** Previews a move/copy, and writes it when `commit` and no conflict blocks it. */
export async function moveMembers(args: {
  sourceRel: string
  targetRel: string
  items: MigrateItem[]
  mode: MigrateMode
  overwrite?: string[]
  commit?: boolean
}): Promise<MoveResult> {
  const { sourceRel, targetRel, items, mode } = args
  assertXml(sourceRel)
  assertXml(targetRel)
  if (sourceRel === targetRel) throw new Error("Source and target must differ.")
  if (items.length === 0) throw new Error("No members selected.")

  const [sourceXml, targetXml] = await Promise.all([readEntityFile(sourceRel), readEntityFile(targetRel)])
  const result = migrateMembers({ sourceXml, targetXml, items, mode, overwrite: new Set(args.overwrite ?? []) })

  const committed = args.commit === true && !result.hasBlockingConflict
  if (committed) {
    await writeEntityFile(targetRel, result.targetXml)
    if (mode === "move") await writeEntityFile(sourceRel, result.sourceXml)
  }

  return {
    members: result.members,
    hasBlockingConflict: result.hasBlockingConflict,
    committed,
    // Formatted originals + previews for the diff dialog (not written unless committed).
    sourceOriginal: formatEntityXml(sourceXml),
    targetOriginal: formatEntityXml(targetXml),
    sourcePreview: result.sourceXml,
    targetPreview: result.targetXml,
  }
}

/** Previews removing members from the source, and writes it when `commit`. */
export async function deleteMembers(args: { sourceRel: string; items: MigrateItem[]; commit?: boolean }): Promise<DeleteResult> {
  const { sourceRel, items } = args
  assertXml(sourceRel)
  if (items.length === 0) throw new Error("No members selected.")

  const sourceXml = await readEntityFile(sourceRel)
  const result = removeMembers({ sourceXml, items })
  const committed = args.commit === true
  if (committed) await writeEntityFile(sourceRel, result.sourceXml)

  return {
    members: result.members,
    committed,
    sourceOriginal: formatEntityXml(sourceXml),
    sourcePreview: result.sourceXml,
  }
}
