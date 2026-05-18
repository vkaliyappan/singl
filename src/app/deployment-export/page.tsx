import { db } from "@/db";
import { environmentSettings, twxProjects } from "@/db/schema";
import { DeploymentExportExplorer } from "./deployment-export-explorer";

export const dynamic = "force-dynamic";
export const metadata = { title: "Deployment Export" };

export default async function DeploymentExportPage() {
  const [envRows, projectRows] = await Promise.all([
    db.select().from(environmentSettings).catch(() => []),
    db.select().from(twxProjects).catch(() => []),
  ]);

  const envs = envRows.map(({ environment, twxBaseUrl, twxAppKey }) => ({
    environment,
    twxBaseUrl,
    hasAppKey: !!twxAppKey,
    projects: projectRows
      .filter((p) => p.environment === environment)
      .map((p) => ({
        id: p.id,
        projectName: p.projectName,
        folderName: p.folderName ?? p.projectName,
        alias: p.alias,
        exports: JSON.parse(p.exports ?? '["all"]') as string[],
      })),
  }));

  return <DeploymentExportExplorer initialEnvs={envs} />;
}
