import path from "path";
import { promises as fs } from "fs";
import { existsSync } from "fs";
import { NextResponse } from "next/server";
import { db } from "@/db";
import { repoSettings } from "@/db/schema";

export async function POST() {
  try {
    const [repo] = await db.select().from(repoSettings).limit(1).catch(() => []);
    if (!repo?.repoSlug) {
      return NextResponse.json({ error: "No repository configured." }, { status: 400 });
    }

    const cwd = process.cwd();
    const reposBase = path.resolve(/*turbopackIgnore: true*/ cwd, "repos");
    const repoPath = path.resolve(reposBase, repo.repoSlug);

    if (!repoPath.startsWith(reposBase)) {
      return NextResponse.json({ error: "Invalid repo path" }, { status: 400 });
    }

    // Match the extract route's ThingWorx dir discovery logic
    const candidate1 = path.resolve(repoPath, "ThingWorx");
    const candidate2 = path.resolve(repoPath, "WindchillClients", "ThingWorx");
    const thingWorxDir = existsSync(candidate1) ? candidate1 : existsSync(candidate2) ? candidate2 : null;

    if (!thingWorxDir) {
      return NextResponse.json(
        { error: "ThingWorx directory not found. Run Extract first." },
        { status: 400 }
      );
    }

    // Delete Code/ under each project directory — mirrors what extractServicesTask creates
    const entries = await fs.readdir(thingWorxDir, { withFileTypes: true });
    let deleted = 0;

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const codeDir = path.resolve(thingWorxDir, entry.name, "Code");
      if (!codeDir.startsWith(repoPath)) continue; // safety guard
      await fs.rm(codeDir, { recursive: true, force: true });
      deleted++;
    }

    return NextResponse.json({ ok: true, deleted });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to clear extracted code" },
      { status: 500 }
    );
  }
}
