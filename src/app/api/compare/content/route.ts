import path from "path";
import fs from "fs";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { appSettings, repoSettings } from "@/db/schema";

const MAX_SIZE = 1024 * 1024; // 1 MB

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const env = searchParams.get("env");
  const relPath = searchParams.get("path");

  if (!env || !relPath) {
    return NextResponse.json({ error: "env and path are required" }, { status: 400 });
  }

  const [appRows, repoRows] = await Promise.all([
    db.select().from(appSettings).limit(1),
    db.select().from(repoSettings).limit(1),
  ]);

  const app = appRows[0];
  const repo = repoRows[0];

  if (!repo?.repoSlug) {
    return NextResponse.json({ error: "No repository configured." }, { status: 400 });
  }

  const twxRootPrefix = app?.twxRootPrefix ?? "WindchillClients/Thingworx";
  const repoRootSubpath = app?.repoRootSubpath ?? "";

  const cwd = process.cwd();
  const leftRoot = path.resolve(/*turbopackIgnore: true*/ cwd, "repos", repo.repoSlug, repoRootSubpath);
  const rightRoot = path.resolve(/*turbopackIgnore: true*/ cwd, "twx-entities", env, twxRootPrefix);

  const leftFile = path.resolve(leftRoot, relPath);
  const rightFile = path.resolve(rightRoot, relPath);

  // Path traversal guards
  if (!leftFile.startsWith(leftRoot) || !rightFile.startsWith(rightRoot)) {
    return NextResponse.json({ error: "Invalid path" }, { status: 400 });
  }

  function readSide(filePath: string): { content: string | null; size?: number; tooLarge?: boolean } {
    if (!fs.existsSync(filePath)) return { content: null };
    try {
      const stats = fs.statSync(filePath);
      if (stats.isDirectory()) return { content: null };
      if (stats.size > MAX_SIZE) return { content: null, size: stats.size, tooLarge: true };
      // Normalize CRLF so the diff editor doesn't show phantom line-ending changes
      const raw = fs.readFileSync(filePath, "utf-8");
      return { content: raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n"), size: stats.size };
    } catch {
      return { content: null };
    }
  }

  const left = readSide(leftFile);
  const right = readSide(rightFile);

  return NextResponse.json({
    leftContent: left.content,
    rightContent: right.content,
    leftSize: left.size,
    rightSize: right.size,
    leftTooLarge: left.tooLarge ?? false,
    rightTooLarge: right.tooLarge ?? false,
  });
}
