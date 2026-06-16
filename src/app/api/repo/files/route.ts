import path from 'path';
import fs from 'fs';
import { NextRequest, NextResponse } from 'next/server';

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const relativePath = searchParams.get('path') ?? '';

  const reposDir = path.resolve(/*turbopackIgnore: true*/ process.cwd(), 'dist/repo');
  const targetPath = relativePath
    ? path.resolve(reposDir, relativePath)
    : reposDir;

  if (!targetPath.startsWith(reposDir)) {
    return NextResponse.json({ error: 'Invalid path' }, { status: 400 });
  }

  if (!fs.existsSync(targetPath)) {
    return NextResponse.json({ error: 'Path does not exist' }, { status: 404 });
  }

  try {
    const entries = fs.readdirSync(targetPath, { withFileTypes: true });
    const result = entries
      .filter((e) => e.name !== '.git')
      .map((e) => ({
        name: e.name,
        type: e.isDirectory() ? ('dir' as const) : ('file' as const),
        path: relativePath ? `${relativePath}/${e.name}` : e.name,
      }))
      .sort((a, b) => {
        if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
        return a.name.localeCompare(b.name);
      });

    return NextResponse.json({ entries: result });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to read directory' },
      { status: 500 }
    );
  }
}
