import path from "path";
import { db } from "@/db";
import { environmentSettings, appSettings, twxProjects } from "@/db/schema";
import { readManifest } from "@/lib/twx/manifest";
import { DeployExplorer } from "./deploy-explorer";

export const dynamic = "force-dynamic";
export const metadata = { title: "Deploy" };

export default async function DeployPage() {
  const [envRows, appRows, projectRows, manifest] = await Promise.all([
    db
      .select({ environment: environmentSettings.environment })
      .from(environmentSettings)
      .catch(() => []),
    db.select().from(appSettings).limit(1).catch(() => []),
    db.select({ alias: twxProjects.alias, projectName: twxProjects.projectName }).from(twxProjects).catch(() => []),
    readManifest(path.resolve(process.cwd(), "./manifest.twx.json")).catch(() => null),
  ]);

  const deployProjects = manifest
    ? Object.entries(manifest.projects).map(([key, proj]) => ({
        key,
        alias: proj.alias,
      }))
    : [];

  // Deduplicate by alias for the bundle tab
  const seen = new Set<string>();
  const bundleProjects = projectRows
    .map(r => ({ alias: r.alias || r.projectName, projectName: r.projectName }))
    .filter(p => { if (seen.has(p.alias)) return false; seen.add(p.alias); return true; });

  const bundleSrcDir = appRows[0]?.bundleSrcDir ?? "./WindchillClients/Thingworx";
  const bundleDestDir = appRows[0]?.bundleDestDir ?? "./dist/bundles";

  return (
    <DeployExplorer
      envs={envRows.map((r) => r.environment)}
      projects={deployProjects}
      bundleProjects={bundleProjects}
      bundleSrcDir={bundleSrcDir}
      bundleDestDir={bundleDestDir}
    />
  );
}
