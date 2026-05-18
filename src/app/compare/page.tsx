import { db } from "@/db";
import { environmentSettings } from "@/db/schema";
import { CompareExplorer } from "./compare-explorer";

export const dynamic = "force-dynamic";
export const metadata = { title: "Compare" };

export default async function ComparePage() {
  const envRows = await db
    .select({ environment: environmentSettings.environment })
    .from(environmentSettings)
    .catch(() => []);

  return <CompareExplorer envs={envRows.map((r) => r.environment)} />;
}
