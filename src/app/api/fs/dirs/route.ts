import path from 'path';
import fs from 'fs';
import { NextRequest, NextResponse } from 'next/server';

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const relativePath = (searchParams.get('path') ?? '').replace(/\\/g, '/').replace(/\/+$/, '');

  const cwd = /*turbopackIgnore: true*/ process.cwd();
  const targetPath = relativePath ? path.resolve(cwd, relativePath) : cwd;

  // Reject paths that escape cwd
  const rel = path.relative(cwd, targetPath);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    return NextResponse.json({ error: 'Invalid path' }, { status: 400 });
  }

  if (!fs.existsSync(targetPath)) {
    return NextResponse.json({ entries: [], currentPath: relativePath });
  }

  try {
    const entries = fs
      .readdirSync(targetPath, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => ({
        name: e.name,
        path: relativePath ? `${relativePath}/${e.name}` : e.name,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

    return NextResponse.json({ entries, currentPath: relativePath });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to read directory' },
      { status: 500 }
    );
  }
}
