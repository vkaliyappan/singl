import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { appSettings } from '@/db/schema';
import { simpleGit } from 'simple-git';

function injectPat(repoUrl: string, pat: string): string {
  const url = new URL(repoUrl);
  if (
    url.hostname.includes('dev.azure.com') ||
    url.hostname.includes('visualstudio.com')
  ) {
    url.username = '';
    url.password = pat;
  } else {
    url.username = 'x-oauth-basic';
    url.password = pat;
  }
  return url.toString();
}

export async function POST(request: NextRequest) {
  const { repoUrl } = (await request.json()) as { repoUrl: string };

  if (!repoUrl) {
    return NextResponse.json({ error: 'repoUrl is required' }, { status: 400 });
  }

  const [settings] = await db.select().from(appSettings).limit(1).catch(() => []);
  const pat = settings?.azurePatToken ?? '';

  if (!pat) {
    return NextResponse.json(
      { error: 'No PAT token configured. Go to Settings.' },
      { status: 400 }
    );
  }

  try {
    const authenticatedUrl = injectPat(repoUrl, pat);
    const git = simpleGit();
    const output = await git.listRemote(['--heads', authenticatedUrl]);

    const branches = output
      .split('\n')
      .filter(Boolean)
      .map((line) => line.split('\t')[1]?.replace('refs/heads/', ''))
      .filter((b): b is string => !!b);

    return NextResponse.json({ branches });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to fetch branches' },
      { status: 500 }
    );
  }
}
