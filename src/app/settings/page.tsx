import { db } from "@/db";
import { environmentSettings, appSettings } from "@/db/schema";
import { SettingsForm, AzurePatForm } from "./settings-form";
import { Separator } from "@/components/ui/separator";

export const metadata = {
  title: "Settings",
};

export default async function SettingsPage() {
  const [rows, appSettingsRows] = await Promise.all([
    db.select().from(environmentSettings),
    db.select().from(appSettings).limit(1).catch(() => []),
  ]);

  const settings = rows.map(({ environment, twxBaseUrl, twxAppKey }) => ({
    environment,
    twxBaseUrl,
    hasAppKey: !!twxAppKey,
  }));

  const hasAzurePatToken = !!(appSettingsRows[0]?.azurePatToken);

  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-8">
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
    </div>
  );
}
