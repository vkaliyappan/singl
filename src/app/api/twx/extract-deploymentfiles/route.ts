import path from 'path';
import { db } from '@/db';
import { environmentSettings, twxProjects } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { runDeploymentExtract } from '@/lib/twx/deployment-extractor';
import type { DeploymentExtractProject } from '@/lib/twx/deployment-extractor';

export async function POST(request: Request) {
  const { envName, inputDir, output, dryRun } = (await request.json()) as {
    envName: string;
    inputDir?: string;
    output?: string;
    dryRun?: boolean;
  };

  const stream = new TransformStream<Uint8Array, Uint8Array>();
  const writer = stream.writable.getWriter();
  const enc = new TextEncoder();

  const send = (msg: string) => writer.write(enc.encode(`data: ${msg}\n\n`));

  (async () => {
    try {
      if (!envName?.trim()) {
        send('[ERROR] Environment name is required');
        return;
      }
      if (!inputDir?.trim()) {
        send('[ERROR] Input directory is required');
        return;
      }

      const dbProjects = await db
        .select()
        .from(twxProjects)
        .where(eq(twxProjects.environment, envName));

      // Env row needed only to validate the environment exists
      const envRows = await db
        .select({ id: environmentSettings.id })
        .from(environmentSettings)
        .where(eq(environmentSettings.environment, envName));

      if (!envRows[0]) {
        send(`[ERROR] Environment "${envName}" not found`);
        return;
      }

      if (dbProjects.length === 0) {
        send(`[ERROR] No projects configured for "${envName}". Add projects in Settings.`);
        return;
      }

      const projects: DeploymentExtractProject[] = dbProjects.map((p) => ({
        key: p.folderName?.trim() || p.projectName,
        alias: p.alias?.trim() || p.projectName,
      }));

      const resolvedInput = path.resolve(
        /*turbopackIgnore: true*/ process.cwd(),
        inputDir.trim()
      );
      const resolvedOutput = path.resolve(
        /*turbopackIgnore: true*/ process.cwd(),
        output?.trim() || './WindchillClients/ThingWorx'
      );

      send(`Extracting from ${resolvedInput} → ${resolvedOutput}`);

      const result = await runDeploymentExtract({
        projects,
        inputDir: resolvedInput,
        outputDir: resolvedOutput,
        dryRun: !!dryRun,
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
