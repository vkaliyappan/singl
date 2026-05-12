import path from 'path';
import { readManifest } from '@/lib/twx/manifest';
import { runDeploymentExtract } from '@/lib/twx/deployment-extractor';
import type { ParsedFlags } from '@/lib/twx/types';

export async function POST(request: Request) {
  const flags = (await request.json()) as ParsedFlags;

  const stream = new TransformStream<Uint8Array, Uint8Array>();
  const writer = stream.writable.getWriter();
  const enc = new TextEncoder();

  const send = (msg: string) => writer.write(enc.encode(`data: ${msg}\n\n`));

  (async () => {
    try {
      const manifestPath = path.resolve(
        /*turbopackIgnore: true*/ process.cwd(),
        (flags.manifest as string | undefined) ?? './manifest.twx.json'
      );
      const inputDir = path.resolve(
        /*turbopackIgnore: true*/ process.cwd(),
        (flags.input as string | undefined) ?? './export'
      );
      const outputDir = path.resolve(
        /*turbopackIgnore: true*/ process.cwd(),
        (flags.output as string | undefined) ?? './WindchillClients/ThingWorx'
      );
      const projectFilter = (flags.project as string | undefined) ?? null;
      const dryRun = !!flags['dry-run'] || !!flags.dryRun;

      const manifest = await readManifest(manifestPath);

      const result = await runDeploymentExtract({
        manifest,
        inputDir,
        outputDir,
        projectFilter,
        dryRun,
        onProgress: send,
      });

      send(`[DONE] ${JSON.stringify(result)}`);
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
