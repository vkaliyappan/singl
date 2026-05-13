import path from 'path';
import fs from 'fs';
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
  const { repoUrl, branch } = (await request.json()) as {
    repoUrl: string;
    branch: string;
  };

  const [settings] = await db.select().from(appSettings).limit(1).catch(() => []);
  const pat = settings?.azurePatToken ?? '';

  const stream = new TransformStream<Uint8Array, Uint8Array>();
  const writer = stream.writable.getWriter();
  const enc = new TextEncoder();
  const send = (msg: string) => writer.write(enc.encode(`data: ${msg}\n\n`));

  (async () => {
    try {
      if (!pat) {
        send('[ERROR] No PAT token configured. Go to Settings.');
        return;
      }

      const authenticatedUrl = injectPat(repoUrl, pat);
      const slug = repoUrl.replace(/\.git$/, '').split('/').pop() ?? 'repo';
      const reposDir = path.resolve(/*turbopackIgnore: true*/ process.cwd(), 'repos');
      const clonePath = path.resolve(reposDir, slug);

      if (!fs.existsSync(reposDir)) {
        fs.mkdirSync(reposDir, { recursive: true });
      }

      if (fs.existsSync(clonePath)) {
        send(`Removing existing clone...`);
        fs.rmSync(clonePath, { recursive: true, force: true });
      }

      send(`Cloning branch "${branch}" from ${repoUrl}...`);

      const git = simpleGit();
      await git.clone(authenticatedUrl, clonePath, [
        '--branch',
        branch,
        '--single-branch',
      ]);

      send(`Clone complete.`);

      // Persist repo state so the page restores on reload
      const existing = await db.select({ id: repoSettings.id }).from(repoSettings).limit(1);
      if (existing.length > 0) {
        await db.update(repoSettings).set({ repoUrl, clonedBranch: branch, repoSlug: slug });
      } else {
        await db.insert(repoSettings).values({ id: 1, repoUrl, clonedBranch: branch, repoSlug: slug });
      }

      send(`[DONE] ${JSON.stringify({ slug })}`);
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
