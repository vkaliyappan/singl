import path from "path";
import fs from "fs";
import { NextResponse } from "next/server";
import { db } from "@/db";
import { repoSettings } from "@/db/schema";
import { simpleGit } from "simple-git";

export const dynamic = "force-dynamic";

interface ChangedFile {
  path: string;
  status: "M" | "A" | "D" | "?";
}

export async function GET() {
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

    // Guard: ensure this directory is actually a git repo and not a stale DB entry.
    // Without this, simple-git walks up to the nearest .git (the singl project itself)
    // and reports its status instead.
    if (!fs.existsSync(path.join(repoPath, ".git"))) {
      return NextResponse.json(
        { error: `Repository not found at repos/${repo.repoSlug}. Try cloning again.` },
        { status: 400 }
      );
    }

    const git = simpleGit(repoPath);
    const [status, diffNames] = await Promise.all([
      git.status(),
      // Files with actual textual changes vs HEAD (excludes line-ending-only diffs
      // caused by core.autocrlf on Windows, which git status reports as M).
      git.diff(["HEAD", "--name-only"]).catch(() => ""),
    ]);

    const textuallyChanged = new Set(
      diffNames.split("\n").map((l) => l.trim()).filter(Boolean)
    );

    const seen = new Set<string>();
    const files: ChangedFile[] = [];

    for (const f of status.files) {
      if (seen.has(f.path)) continue;
      seen.add(f.path);

      const s = f.index !== " " && f.index !== "?" ? f.index : f.working_dir;
      let statusCode: ChangedFile["status"];
      if (s === "A") statusCode = "A";
      else if (s === "D") statusCode = "D";
      else if (s === "?") statusCode = "?";
      else statusCode = "M";

      // Skip M files that only differ in line endings — git diff HEAD won't list them.
      if (statusCode === "M" && !textuallyChanged.has(f.path)) continue;

      files.push({ path: f.path, status: statusCode });
    }

    return NextResponse.json({ files, repoPath: path.relative(cwd, repoPath).replace(/\\/g, "/") });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to get status" },
      { status: 500 }
    );
  }
}
