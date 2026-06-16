import path from 'path';
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

export async function POST(request: Request) {
  const { slug, repoUrl } = (await request.json()) as {
    slug: string;
    repoUrl: string;
  };

  const [settings] = await db.select().from(appSettings).limit(1).catch(() => []);
  const pat = settings?.azurePatToken ?? '';

  const reposDir = path.resolve(/*turbopackIgnore: true*/ process.cwd(), 'dist/repo');
  const clonePath = path.resolve(reposDir, slug);

  const stream = new TransformStream<Uint8Array, Uint8Array>();
  const writer = stream.writable.getWriter();
  const enc = new TextEncoder();
  const send = (msg: string) => writer.write(enc.encode(`data: ${msg}\n\n`));

  (async () => {
    try {
      const git = simpleGit(clonePath);

      if (pat && repoUrl) {
        await git.remote(['set-url', 'origin', injectPat(repoUrl, pat)]);
      }

      send('Fetching from remote...');
      await git.fetch(['--all']);
      send('Fetch complete.');

      send('[DONE]');
    } catch (err) {
      send(`[ERROR] ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      writer.close();
    }
  })();

  return new Response(stream.readable, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}
