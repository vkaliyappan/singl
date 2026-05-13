import { db } from "@/db";
import { appSettings, repoSettings } from "@/db/schema";
import { RepoExplorer } from "./repo-explorer";

export const metadata = {
  title: "Repository",
};

export default async function RepoPage() {
  const [[appRow], [repoRow]] = await Promise.all([
    db.select().from(appSettings).limit(1).catch(() => []),
    db.select().from(repoSettings).limit(1).catch(() => []),
  ]);

  return (
    <RepoExplorer
      hasPatToken={!!(appRow?.azurePatToken)}
      savedRepoUrl={repoRow?.repoUrl ?? ""}
      savedBranch={repoRow?.clonedBranch ?? ""}
      savedSlug={repoRow?.repoSlug ?? ""}
    />
  );
}
