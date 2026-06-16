import path from "path";
import fs from "fs";
import { NextRequest, NextResponse } from "next/server";

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
const MAX_FILES = 2000;

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
    const lines = fs.readFileSync(filePath, "utf-8").split("\n");
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
  const root = searchParams.get("root");
  const q = searchParams.get("q");
  const caseSensitive = searchParams.get("case") === "1";
  const wholeWord = searchParams.get("word") === "1";
  const useRegex = searchParams.get("regex") === "1";
  const matchFilename = searchParams.get("filename") === "1";

  if (!root || !q?.trim()) return NextResponse.json({ results: [] });

  const base = path.resolve(/*turbopackIgnore: true*/ process.cwd(), "dist/twx-entities");
  const searchRoot = path.resolve(base, root);

  if (!searchRoot.startsWith(base) || !fs.existsSync(searchRoot)) {
    return NextResponse.json({ error: "Invalid root" }, { status: 400 });
  }

  let pattern: RegExp;
  try { pattern = buildPattern(q, caseSensitive, wholeWord, useRegex); }
  catch { return NextResponse.json({ error: "Invalid regular expression" }, { status: 400 }); }

  const results: Result[] = [];
  walk(searchRoot, searchRoot, pattern, matchFilename, results, { n: 0 });
  return NextResponse.json({ results });
}
