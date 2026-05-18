import path from "path";
import fs from "fs";
import { NextRequest, NextResponse } from "next/server";

const BINARY_EXTS = new Set([
  "png","jpg","jpeg","gif","bmp","ico","svg","webp","tiff",
  "pdf","zip","tar","gz","7z","rar","bz2",
  "exe","dll","so","dylib","wasm","bin",
  "ttf","otf","woff","woff2","eot",
  "mp3","mp4","wav","ogg","avi","mov","mkv",
  "db","sqlite","sqlite3",
]);

const MAX_FILE_SIZE = 512 * 1024;
const MAX_RESULTS = 500;
const MAX_FILES = 2000;

function isBinary(filePath: string): boolean {
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
  return BINARY_EXTS.has(ext);
}

function buildPattern(q: string, caseSensitive: boolean, wholeWord: boolean, useRegex: boolean): RegExp {
  let src = useRegex ? q : q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (wholeWord) src = `\\b${src}\\b`;
  const flags = caseSensitive ? "g" : "gi";
  return new RegExp(src, flags);
}

function searchFile(filePath: string, pattern: RegExp): Array<{ lineNumber: number; lineContent: string; matchStart: number; matchEnd: number }> {
  const matches: Array<{ lineNumber: number; lineContent: string; matchStart: number; matchEnd: number }> = [];
  try {
    const stat = fs.statSync(filePath);
    if (stat.size > MAX_FILE_SIZE) return matches;
    const content = fs.readFileSync(filePath, "utf-8");
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      pattern.lastIndex = 0;
      const m = pattern.exec(line);
      if (m) {
        matches.push({
          lineNumber: i + 1,
          lineContent: line.slice(0, 200),
          matchStart: m.index,
          matchEnd: m.index + m[0].length,
        });
      }
    }
  } catch {
    // unreadable file — skip
  }
  return matches;
}

type Result = { filePath: string; matches: ReturnType<typeof searchFile>; filenameMatch?: boolean };

function walk(
  dir: string,
  baseDir: string,
  pattern: RegExp,
  matchFilename: boolean,
  results: Result[],
  fileCount: { n: number }
): void {
  if (results.length >= MAX_RESULTS || fileCount.n >= MAX_FILES) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (results.length >= MAX_RESULTS || fileCount.n >= MAX_FILES) break;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      walk(fullPath, baseDir, pattern, matchFilename, results, fileCount);
    } else if (entry.isFile()) {
      if (isBinary(entry.name)) continue;
      fileCount.n++;
      const matches = searchFile(fullPath, pattern);
      const relPath = path.relative(baseDir, fullPath).replace(/\\/g, "/");
      pattern.lastIndex = 0;
      const nameHit = matchFilename && pattern.test(entry.name);
      if (matches.length > 0) {
        results.push({ filePath: relPath, matches, filenameMatch: nameHit });
      } else if (nameHit) {
        results.push({ filePath: relPath, matches: [], filenameMatch: true });
      }
    }
  }
}

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const root = searchParams.get("root");
  const q = searchParams.get("q");
  const caseSensitive = searchParams.get("case") === "1";
  const wholeWord = searchParams.get("word") === "1";
  const useRegex = searchParams.get("regex") === "1";
  const matchFilename = searchParams.get("filename") === "1";

  if (!root || !q?.trim()) {
    return NextResponse.json({ results: [] });
  }

  const reposDir = path.resolve(/*turbopackIgnore: true*/ process.cwd(), "repos");
  const searchRoot = path.resolve(reposDir, root);

  if (!searchRoot.startsWith(reposDir) || !fs.existsSync(searchRoot)) {
    return NextResponse.json({ error: "Invalid root" }, { status: 400 });
  }

  let pattern: RegExp;
  try {
    pattern = buildPattern(q, caseSensitive, wholeWord, useRegex);
  } catch {
    return NextResponse.json({ error: "Invalid regular expression" }, { status: 400 });
  }

  const results: Result[] = [];
  walk(searchRoot, searchRoot, pattern, matchFilename, results, { n: 0 });

  return NextResponse.json({ results });
}
