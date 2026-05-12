import path from 'path';
import { db } from '@/db';
import { appSettings, repoSettings } from '@/db/schema';
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
  const { slug, branch, repoUrl } = (await request.json()) as {
    slug: string;
    branch: string;
    repoUrl: string;
  };

  const [settings] = await db.select().from(appSettings).limit(1).catch(() => []);
  const pat = settings?.azurePatToken ?? '';

  const reposDir = path.resolve(/*turbopackIgnore: true*/ process.cwd(), 'repos');
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

      send(`Fetching branch "${branch}" from remote...`);
      await git.fetch(['origin', branch]);

      send(`Switching to "${branch}"...`);
      try {
        await git.checkout(branch);
      } catch {
        await git.checkout(['-b', branch, `origin/${branch}`]);
      }

      await db.update(repoSettings).set({ clonedBranch: branch });

      send(`[DONE] ${JSON.stringify({ branch })}`);
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
