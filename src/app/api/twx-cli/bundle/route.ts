import path from 'path';
import { db } from '@/db';
import { twxProjects } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { runBundle } from '@/lib/twx/bundler';

export async function POST(request: Request) {
  const flags = (await request.json()) as {
    src?: string;
    dest?: string;
    env?: string;
    project?: string;
    'dry-run'?: boolean;
  };

  const stream = new TransformStream<Uint8Array, Uint8Array>();
  const writer = stream.writable.getWriter();
  const enc = new TextEncoder();

  const send = (msg: string) => writer.write(enc.encode(`data: ${msg}\n\n`));

  (async () => {
    try {
      const cwd = process.cwd();
      const srcDir = path.resolve(/*turbopackIgnore: true*/ cwd, flags.src ?? './WindchillClients/Thingworx');
      const destDir = path.resolve(/*turbopackIgnore: true*/ cwd, flags.dest ?? './dist/bundles');

      if (!srcDir.startsWith(cwd) || !destDir.startsWith(cwd)) {
        await send('[ERROR] Invalid path — must be within the project root');
        return;
      }

      const rows = flags.env
        ? await db.select().from(twxProjects).where(eq(twxProjects.environment, flags.env))
        : await db.select().from(twxProjects);

      const seen = new Set<string>();
      const projects = rows
        .map(r => ({ alias: r.alias || r.projectName, projectName: r.projectName }))
        .filter(p => { if (seen.has(p.alias)) return false; seen.add(p.alias); return true; });

      if (projects.length === 0) {
        await send('[ERROR] No projects found in database. Configure projects in Settings first.');
        return;
      }

      const projectFilter = flags.project ?? null;
      const dryRun = !!flags['dry-run'];

      const result = await runBundle({ projects, srcDir, destDir, projectFilter, dryRun, onProgress: send });
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
