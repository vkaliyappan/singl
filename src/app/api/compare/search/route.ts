import path from "path";
import fs from "fs";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { appSettings, repoSettings } from "@/db/schema";

const BINARY_EXTS = new Set([
  "png","jpg","jpeg","gif","bmp","ico","webp","tiff",
  "pdf","zip","tar","gz","7z","rar","bz2",
  "exe","dll","so","dylib","wasm","bin",
  "ttf","otf","woff","woff2","eot",
  "mp3","mp4","wav","ogg","avi","mov","mkv",
  "db","sqlite","sqlite3",
]);

const MAX_FILE_SIZE = 512 * 1024;
const MAX_RESULTS = 500;
const MAX_FILES = 300;

function isBinary(name: string): boolean {
  return BINARY_EXTS.has(name.split(".").pop()?.toLowerCase() ?? "");
}

function buildPattern(q: string, caseSensitive: boolean, wholeWord: boolean, useRegex: boolean): RegExp {
  let src = useRegex ? q : q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (wholeWord) src = `\\b${src}\\b`;
  return new RegExp(src, caseSensitive ? "g" : "gi");
}

function searchFile(filePath: string, pattern: RegExp) {
  const matches: Array<{ lineNumber: number; lineContent: string; matchStart: number; matchEnd: number }> = [];
  try {
    if (fs.statSync(filePath).size > MAX_FILE_SIZE) return matches;
    const lines = fs.readFileSync(filePath, "utf-8").replace(/\r\n/g, "\n").split("\n");
    for (let i = 0; i < lines.length; i++) {
      pattern.lastIndex = 0;
      const m = pattern.exec(lines[i]);
      if (m) matches.push({ lineNumber: i + 1, lineContent: lines[i].slice(0, 200), matchStart: m.index, matchEnd: m.index + m[0].length });
    }
  } catch { /* skip */ }
  return matches;
}

type Result = { filePath: string; matches: ReturnType<typeof searchFile>; filenameMatch?: boolean };

function walk(dir: string, base: string, pattern: RegExp, matchFilename: boolean, out: Result[], fc: { n: number }) {
  if (out.length >= MAX_RESULTS || fc.n >= MAX_FILES) return;
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (out.length >= MAX_RESULTS || fc.n >= MAX_FILES) break;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === ".git" || e.name === "node_modules") continue;
      walk(full, base, pattern, matchFilename, out, fc);
    } else if (e.isFile() && !isBinary(e.name)) {
      fc.n++;
      const matches = searchFile(full, pattern);
      const relPath = path.relative(base, full).replace(/\\/g, "/");
      pattern.lastIndex = 0;
      const nameHit = matchFilename && pattern.test(e.name);
      if (matches.length) out.push({ filePath: relPath, matches, filenameMatch: nameHit });
      else if (nameHit) out.push({ filePath: relPath, matches: [], filenameMatch: true });
    }
  }
}

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const env = searchParams.get("env");
  const q = searchParams.get("q");
  const side = searchParams.get("side") ?? "both";
  const caseSensitive = searchParams.get("case") === "1";
  const wholeWord = searchParams.get("word") === "1";
  const useRegex = searchParams.get("regex") === "1";
  const matchFilename = searchParams.get("filename") === "1";

  if (!env || !q?.trim()) return NextResponse.json({ results: [] });

  try {
    return await handleSearch({ env, q, side, caseSensitive, wholeWord, useRegex, matchFilename });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Internal error" },
      { status: 500 }
    );
  }
}

async function handleSearch({
  env, q, side, caseSensitive, wholeWord, useRegex, matchFilename,
}: {
  env: string; q: string; side: string;
  caseSensitive: boolean; wholeWord: boolean; useRegex: boolean; matchFilename: boolean;
}) {
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

  let pattern: RegExp;
  try { pattern = buildPattern(q, caseSensitive, wholeWord, useRegex); }
  catch { return NextResponse.json({ error: "Invalid regular expression" }, { status: 400 }); }

  const leftResults: Result[] = [];
  const rightResults: Result[] = [];

  if ((side === "left" || side === "both") && fs.existsSync(leftRoot)) {
    walk(leftRoot, leftRoot, pattern, matchFilename, leftResults, { n: 0 });
  }
  if ((side === "right" || side === "both") && fs.existsSync(rightRoot)) {
    walk(rightRoot, rightRoot, pattern, matchFilename, rightResults, { n: 0 });
  }

  const merged = new Map<string, Result>();
  for (const r of leftResults) merged.set(r.filePath, r);
  for (const r of rightResults) {
    if (!merged.has(r.filePath)) merged.set(r.filePath, r);
  }

  return NextResponse.json({ results: Array.from(merged.values()) });
}
