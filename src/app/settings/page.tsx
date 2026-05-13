import { db } from "@/db";
import { environmentSettings, appSettings, twxProjects } from "@/db/schema";
import { SettingsForm, AzurePatForm, ComparePathsForm } from "./settings-form";
import { Separator } from "@/components/ui/separator";

export const metadata = { title: "Settings" };

export default async function SettingsPage() {
  const [envRows, projectRows, appRows] = await Promise.all([
    db.select().from(environmentSettings),
    db.select().from(twxProjects),
    db.select().from(appSettings).limit(1).catch(() => []),
  ]);

  const settings = envRows.map(({ environment, twxBaseUrl, twxAppKey }) => ({
    environment,
    twxBaseUrl,
    hasAppKey: !!twxAppKey,
    projects: projectRows
      .filter((p) => p.environment === environment)
      .map((p) => ({
        id: p.id,
        projectName: p.projectName,
        folderName: p.folderName,
        alias: p.alias,
        exports: JSON.parse(p.exports ?? '["all"]') as string[],
      })),
  }));

  const hasAzurePatToken = !!(appRows[0]?.azurePatToken);
  const twxRootPrefix = appRows[0]?.twxRootPrefix ?? "WindchillClients/Thingworx";
  const repoRootSubpath = appRows[0]?.repoRootSubpath ?? "";

  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-8 overflow-y-auto h-full">
      <div className="mb-2">
        <h1 className="text-base font-semibold">Settings</h1>
        <p className="text-xs text-muted-foreground mt-0.5">
          Configure ThingWorx connection settings per environment.
        </p>
      </div>

      <Separator className="my-4" />

      <div>
        <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-3">
          ThingWorx Connection
        </h2>
        <SettingsForm settings={settings} />
      </div>

      <Separator className="my-4" />

      <div>
        <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-3">
          Azure PAT Token
        </h2>
        <AzurePatForm hasToken={hasAzurePatToken} />
      </div>

      <Separator className="my-4" />

      <div>
        <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-1">
          Compare Paths
        </h2>
        <p className="text-xs text-muted-foreground mb-3">
          Controls how TWX entity paths map to repository paths on the <a href="/compare" className="underline underline-offset-2">/compare</a> page.
        </p>
        <ComparePathsForm twxRootPrefix={twxRootPrefix} repoRootSubpath={repoRootSubpath} />
      </div>
    </div>
  );
}
