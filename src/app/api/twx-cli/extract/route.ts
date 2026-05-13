import { spawn } from 'child_process';
import path from 'path';
import { promises as fs } from 'fs';

export async function POST(request: Request) {
  const { envName, repoSlug } = (await request.json()) as {
    envName?: string;
    repoSlug?: string;
  };

  const stream = new TransformStream<Uint8Array, Uint8Array>();
  const writer = stream.writable.getWriter();
  const enc = new TextEncoder();

  const send = async (msg: string) => {
    try { await writer.write(enc.encode(`data: ${msg}\n\n`)); } catch {}
  };

  (async () => {
    try {
      const cwd = process.cwd();
      let dir: string;
      let label: string;

      if (envName?.trim()) {
        const safeEnv = envName.replace(/[^a-zA-Z0-9_\-]/g, '_');
        dir = path.resolve(cwd, 'twx-entities', safeEnv, 'WindchillClients', 'Thingworx');
        label = `twx-entities/${safeEnv}`;
      } else if (repoSlug?.trim()) {
        label = `repos/${repoSlug}`;
        // Try ThingWorx directly at repo root first, then under WindchillClients/
        const candidate1 = path.resolve(cwd, 'repos', repoSlug, 'ThingWorx');
        const candidate2 = path.resolve(cwd, 'repos', repoSlug, 'WindchillClients', 'ThingWorx');
        const exists = async (p: string) => fs.access(p).then(() => true).catch(() => false);
        dir = (await exists(candidate1)) ? candidate1 : candidate2;
      } else {
        await send('[ERROR] Either envName or repoSlug is required');
        return;
      }

      if (!dir.startsWith(cwd)) {
        await send('[ERROR] Invalid path');
        return;
      }

      try {
        await fs.access(dir);
      } catch {
        await send(`[ERROR] WindchillClients/ThingWorx not found in ${label}. Run Export first.`);
        return;
      }

      await send(`Running extract-services on ${label}...`);

      await new Promise<void>((resolve, reject) => {
        const child = spawn('npx', ['gulp', 'extract-services', '--dir', dir], {
          cwd,
          shell: true,
        });

        const pipe = (chunk: Buffer) => {
          for (const line of chunk.toString().split('\n')) {
            const t = line.trim();
            if (t && !t.startsWith('npm warn')) send(t).catch(() => {});
          }
        };

        child.stdout.on('data', pipe);
        child.stderr.on('data', pipe);
        child.on('error', reject);
        child.on('close', (code) =>
          code === 0 ? resolve() : reject(new Error(`Process exited with code ${code}`))
        );
      });

      await send('[DONE] {}');
    } catch (err) {
      await send(`[ERROR] ${err instanceof Error ? err.message : String(err)}`);
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
