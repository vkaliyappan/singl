import path from 'path';
import { resolveConnection } from '@/lib/twx/config';
import { readManifest } from '@/lib/twx/manifest';
import { runExport } from '@/lib/twx/exporter';
import type { ParsedFlags } from '@/lib/twx/types';

export async function POST(request: Request) {
  const flags = (await request.json()) as ParsedFlags;

  const stream = new TransformStream<Uint8Array, Uint8Array>();
  const writer = stream.writable.getWriter();
  const enc = new TextEncoder();

  const send = (msg: string) => writer.write(enc.encode(`data: ${msg}\n\n`));

  (async () => {
    try {
      const { baseUrl, appKey } = await resolveConnection(flags);

      const manifestPath = path.resolve(
        /*turbopackIgnore: true*/ process.cwd(),
        (flags.manifest as string | undefined) ?? './manifest.twx.json'
      );

      let outputDir = flags.output
        ? path.resolve(/*turbopackIgnore: true*/ process.cwd(), flags.output as string)
        : path.resolve(/*turbopackIgnore: true*/ process.cwd(), './WindchillClients/ThingWorx');

      if (flags.backup) {
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        outputDir = path.resolve(/*turbopackIgnore: true*/ process.cwd(), 'backup', ts);
        send(`Backup mode: exporting to ${outputDir}`);
      }

      const manifest = await readManifest(manifestPath);
      const dryRun = !!flags['dry-run'] || !!flags.dryRun;
      const projectFilter = (flags.project as string | undefined) ?? null;

      const result = await runExport({
        baseUrl,
        appKey,
        manifest,
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
