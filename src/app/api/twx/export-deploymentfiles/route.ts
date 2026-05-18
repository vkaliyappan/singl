import path from 'path';
import { db } from '@/db';
import { environmentSettings, twxProjects } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { runDeploymentExport } from '@/lib/twx/deployment-exporter';
import type { DeploymentProject } from '@/lib/twx/deployment-exporter';

export async function POST(request: Request) {
  const { envName, projectName, parent, suffix, output, dryRun } = (await request.json()) as {
    envName: string;
    projectName?: string;
    parent?: string;
    suffix?: string;
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

      const [envRows, dbProjects] = await Promise.all([
        db.select().from(environmentSettings).where(eq(environmentSettings.environment, envName)),
        db.select().from(twxProjects).where(eq(twxProjects.environment, envName)),
      ]);

      const env = envRows[0];
      if (!env) {
        send(`[ERROR] Environment "${envName}" not found`);
        return;
      }
      if (!env.twxBaseUrl?.trim()) {
        send(`[ERROR] No TWX Base URL configured for "${envName}"`);
        return;
      }
      if (!env.twxAppKey?.trim()) {
        send(`[ERROR] No App Key configured for "${envName}"`);
        return;
      }

      let projects: DeploymentProject[];

      if (projectName?.trim()) {
        const dbMatch = dbProjects.find((p) => p.projectName === projectName.trim());
        projects = [{
          key: dbMatch?.folderName?.trim() || projectName.trim(),
          twxName: projectName.trim(),
        }];
      } else if (dbProjects.length > 0) {
        projects = dbProjects.map((p) => ({
          key: p.folderName?.trim() || p.projectName,
          twxName: p.projectName,
        }));
        send(`Exporting ${projects.length} configured project(s): ${projects.map((p) => p.twxName).join(', ')}`);
      } else {
        send(`[ERROR] No projects configured for "${envName}". Add projects in Settings.`);
        return;
      }

      const outputDir = path.resolve(
        /*turbopackIgnore: true*/ process.cwd(),
        output?.trim() || './export'
      );

      const result = await runDeploymentExport({
        baseUrl: env.twxBaseUrl,
        appKey: env.twxAppKey,
        projects,
        outputDir,
        parent: parent?.trim() || null,
        suffix: suffix?.trim() || null,
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
