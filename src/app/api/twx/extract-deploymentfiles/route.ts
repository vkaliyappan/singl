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
        (flags.input as string | undefined) ?? './dist/export'
      );
      const outputDir = path.resolve(
        /*turbopackIgnore: true*/ process.cwd(),
        (flags.output as string | undefined) ?? './WindchillClients/ThingWorx'
      );
      const dryRun = !!flags['dry-run'] || !!flags.dryRun;
      const projectFilter = (flags.project as string | undefined) ?? null;

      const manifest = await readManifest(manifestPath);

      const projects = Object.entries(manifest.projects)
        .filter(([key, proj]) =>
          !projectFilter ||
          projectFilter === key ||
          projectFilter === proj.alias ||
          projectFilter === proj.projectName
        )
        .map(([key, proj]) => ({ key, alias: proj.alias ?? key }));

      const result = await runDeploymentExtract({
        projects,
        inputDir,
        outputDir,
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
