import path from 'path';
import fs from 'fs';
import { NextRequest, NextResponse } from 'next/server';

const MAX_SIZE = 1024 * 1024; // 1 MB

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const relativePath = searchParams.get('path');

  if (!relativePath) {
    return NextResponse.json({ error: 'path is required' }, { status: 400 });
  }

  const baseDir = path.resolve(/*turbopackIgnore: true*/ process.cwd(), 'twx-entities');
  const targetPath = path.resolve(baseDir, relativePath);

  if (!targetPath.startsWith(baseDir)) {
    return NextResponse.json({ error: 'Invalid path' }, { status: 400 });
  }

  if (!fs.existsSync(targetPath)) {
    return NextResponse.json({ error: 'File does not exist' }, { status: 404 });
  }

  try {
    const stats = fs.statSync(targetPath);

    if (stats.isDirectory()) {
      return NextResponse.json({ error: 'Path is a directory' }, { status: 400 });
    }

    if (stats.size > MAX_SIZE) {
      return NextResponse.json(
        { error: 'File too large to display (> 1 MB)' },
        { status: 400 }
      );
    }

    const content = fs.readFileSync(targetPath, 'utf-8');
    return NextResponse.json({ content, path: relativePath });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to read file' },
      { status: 500 }
    );
  }
}
