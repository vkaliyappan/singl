import path from 'path';
import fs from 'fs';
import { NextRequest, NextResponse } from 'next/server';

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const relativePath = searchParams.get('path') ?? '';

  const baseDir = path.resolve(/*turbopackIgnore: true*/ process.cwd(), 'dist/twx-entities');
  const targetPath = relativePath
    ? path.resolve(baseDir, relativePath)
    : baseDir;

  if (!targetPath.startsWith(baseDir)) {
    return NextResponse.json({ error: 'Invalid path' }, { status: 400 });
  }

  if (!fs.existsSync(targetPath)) {
    return NextResponse.json({ entries: [] });
  }

  try {
    const entries = fs.readdirSync(targetPath, { withFileTypes: true })
      .map((e) => ({
        name: e.name,
        type: e.isDirectory() ? ('dir' as const) : ('file' as const),
        path: relativePath ? `${relativePath}/${e.name}` : e.name,
      }))
      .sort((a, b) => {
        if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
        return a.name.localeCompare(b.name);
      });

    return NextResponse.json({ entries });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to read directory' },
      { status: 500 }
    );
  }
}
