"use server";

import { db } from "@/db";
import { environmentSettings, appSettings, twxProjects } from "@/db/schema";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";

export type SettingsActionState = {
  success?: boolean;
  error?: string;
};

export async function saveEnvironmentSettings(
  _prevState: SettingsActionState,
  formData: FormData
): Promise<SettingsActionState> {
  const environment = formData.get("environment") as string;
  const twxBaseUrl = (formData.get("twxBaseUrl") as string)?.trim();
  const twxAppKey = (formData.get("twxAppKey") as string)?.trim();

  if (!environment) {
    return { error: "Environment is required." };
  }

  try {
    const updateSet: Record<string, unknown> = { twxBaseUrl, updatedAt: new Date() };
    if (twxAppKey) updateSet.twxAppKey = twxAppKey;

    await db
      .insert(environmentSettings)
      .values({ environment, twxBaseUrl, twxAppKey })
      .onConflictDoUpdate({
        target: environmentSettings.environment,
        set: updateSet,
      });

    revalidatePath("/settings");
    revalidatePath("/twx-entities");
    return { success: true };
  } catch {
    return { error: "Failed to save settings. Please try again." };
  }
}

export async function saveAzurePatToken(
  _prevState: SettingsActionState,
  formData: FormData
): Promise<SettingsActionState> {
  const azurePatToken = ((formData.get("azurePatToken") as string) ?? "").trim();

  try {
    const existing = await db.select({ id: appSettings.id }).from(appSettings).limit(1);
    if (existing.length > 0) {
      await db.update(appSettings).set({ azurePatToken, updatedAt: new Date() });
    } else {
      await db.insert(appSettings).values({ id: 1, azurePatToken });
    }

    revalidatePath("/settings");
    return { success: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("saveAzurePatToken error:", e);
    return { error: msg };
  }
}

export async function saveProjectConfig(
  _prevState: SettingsActionState,
  formData: FormData
): Promise<SettingsActionState> {
  const id = formData.get("id") as string;
  const environment = formData.get("environment") as string;
  const projectName = (formData.get("projectName") as string)?.trim();
  const folderName = (formData.get("folderName") as string)?.trim() ?? "";
  const alias = (formData.get("alias") as string)?.trim() ?? "";
  const exportsRaw = (formData.get("exports") as string)?.trim() || "all";

  if (!environment || !projectName) {
    return { error: "Environment and project name are required." };
  }

  // Parse exports: comma-separated → JSON array. "all" stays as ["all"]
  const exportsArr = exportsRaw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const exportsJson = JSON.stringify(exportsArr.length ? exportsArr : ["all"]);

  try {
    if (id) {
      await db
        .update(twxProjects)
        .set({ projectName, folderName, alias, exports: exportsJson, updatedAt: new Date() })
        .where(eq(twxProjects.id, parseInt(id)));
    } else {
      await db.insert(twxProjects).values({ environment, projectName, folderName, alias, exports: exportsJson });
    }
    revalidatePath("/settings");
    revalidatePath("/twx-entities");
    return { success: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("saveProjectConfig error:", e);
    return { error: msg };
  }
}

export async function deleteProjectConfig(
  _prevState: SettingsActionState,
  formData: FormData
): Promise<SettingsActionState> {
  const id = formData.get("id") as string;
  if (!id) return { error: "Project ID is required." };

  try {
    await db.delete(twxProjects).where(eq(twxProjects.id, parseInt(id)));
    revalidatePath("/settings");
    revalidatePath("/twx-entities");
    return { success: true };
  } catch {
    return { error: "Failed to delete project. Please try again." };
  }
}

export async function saveComparePaths(
  _prevState: SettingsActionState,
  formData: FormData
): Promise<SettingsActionState> {
  const twxRootPrefix = ((formData.get("twxRootPrefix") as string) ?? "").trim();
  const repoRootSubpath = ((formData.get("repoRootSubpath") as string) ?? "").trim();

  try {
    const existing = await db.select({ id: appSettings.id }).from(appSettings).limit(1);
    if (existing.length > 0) {
      await db.update(appSettings).set({ twxRootPrefix, repoRootSubpath, updatedAt: new Date() });
    } else {
      await db.insert(appSettings).values({ id: 1, azurePatToken: "", twxRootPrefix, repoRootSubpath });
    }
    revalidatePath("/settings");
    revalidatePath("/compare");
    return { success: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { error: msg };
  }
}

export async function deleteEnvironmentSettings(
  _prevState: SettingsActionState,
  formData: FormData
): Promise<SettingsActionState> {
  const environment = formData.get("environment") as string;

  if (!environment) {
    return { error: "Environment is required." };
  }

  try {
    await db.delete(twxProjects).where(eq(twxProjects.environment, environment));
    await db.delete(environmentSettings).where(eq(environmentSettings.environment, environment));
    revalidatePath("/settings");
    revalidatePath("/twx-entities");
    return { success: true };
  } catch {
    return { error: "Failed to delete settings. Please try again." };
  }
}
