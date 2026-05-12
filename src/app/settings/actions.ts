"use server";

import { db } from "@/db";
import { environmentSettings, appSettings } from "@/db/schema";
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

export async function deleteEnvironmentSettings(
  _prevState: SettingsActionState,
  formData: FormData
): Promise<SettingsActionState> {
  const environment = formData.get("environment") as string;

  if (!environment) {
    return { error: "Environment is required." };
  }

  try {
    await db
      .delete(environmentSettings)
      .where(eq(environmentSettings.environment, environment));

    revalidatePath("/settings");
    return { success: true };
  } catch {
    return { error: "Failed to delete settings. Please try again." };
  }
}
