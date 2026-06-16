import path from "path";
import fs from "fs";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { repoSettings } from "@/db/schema";
import { simpleGit } from "simple-git";

export const dynamic = "force-dynamic";

const MAX_SIZE = 1024 * 1024; // 1 MB

function normalize(content: string): string {
  return content.replace(/^﻿/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export async function GET(request: NextRequest) {
  const file = request.nextUrl.searchParams.get("file");
  if (!file) {
    return NextResponse.json({ error: "file is required" }, { status: 400 });
  }

  try {
    const [repo] = await db.select().from(repoSettings).limit(1).catch(() => []);
    if (!repo?.repoSlug) {
      return NextResponse.json({ error: "No repository configured." }, { status: 400 });
    }

    const cwd = process.cwd();
    const reposBase = path.resolve(/*turbopackIgnore: true*/ cwd, "dist/repo");
    const repoPath = path.resolve(reposBase, repo.repoSlug);
    const fullPath = path.resolve(repoPath, file);

    // Path traversal guard
    if (!repoPath.startsWith(reposBase) || !fullPath.startsWith(repoPath)) {
      return NextResponse.json({ error: "Invalid file path" }, { status: 400 });
    }

    if (!fs.existsSync(path.join(repoPath, ".git"))) {
      return NextResponse.json(
        { error: `Repository not found at dist/repo/${repo.repoSlug}. Try cloning again.` },
        { status: 400 }
      );
    }

    const git = simpleGit(repoPath);

    // Original content from HEAD (empty string means new/untracked file)
    let original = "";
    let existsInHead = true;
    try {
      original = normalize(await git.show([`HEAD:${file}`]));
    } catch {
      existsInHead = false;
    }

    // Current working tree content (empty string means deleted file)
    let modified = "";
    const fileExists = fs.existsSync(fullPath);
    if (fileExists) {
      const stats = fs.statSync(fullPath);
      if (stats.size > MAX_SIZE) {
        return NextResponse.json({ error: "File too large (> 1 MB)" }, { status: 400 });
      }
      modified = normalize(fs.readFileSync(fullPath, "utf-8"));
    }

    // Ask git whether there are actual textual changes (ignores line-ending-only diffs
    // that autocrlf causes, which make git status show M with no visible content change).
    let hasTextualChanges = true;
    if (existsInHead && fileExists) {
      const rawDiff = await git.diff(["HEAD", "--", file]).catch(() => "");
      hasTextualChanges = rawDiff.trim().length > 0;
    }

    return NextResponse.json({ original, modified, hasTextualChanges });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to get diff" },
      { status: 500 }
    );
  }
}
