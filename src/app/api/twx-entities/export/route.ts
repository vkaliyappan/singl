import path from 'path';
import { db } from '@/db';
import { environmentSettings, twxProjects } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { getAllProjects, getProjectEntities, exportEntity } from '@/lib/twx/api';
import { formatEntityXml } from '@/lib/twx/xmlformat';
import { writeEntityXml, filterEntities } from '@/lib/twx/exporter';

export async function POST(request: Request) {
  const { envName, projectName } = (await request.json()) as {
    envName: string;
    projectName?: string;
  };

  const stream = new TransformStream<Uint8Array, Uint8Array>();
  const writer = stream.writable.getWriter();
  const enc = new TextEncoder();

  const send = async (msg: string) => {
    await writer.write(enc.encode(`data: ${msg}\n\n`));
  };

  (async () => {
    try {
      if (!envName?.trim()) {
        await send('[ERROR] Environment name is required');
        return;
      }

      const safeEnv = envName.replace(/[^a-zA-Z0-9_\-]/g, '_');
      const baseDir = path.resolve(/*turbopackIgnore: true*/ process.cwd(), 'twx-entities');
      const outputDir = path.resolve(baseDir, safeEnv);

      const [envRows, dbProjects] = await Promise.all([
        db.select().from(environmentSettings).where(eq(environmentSettings.environment, envName)),
        db.select().from(twxProjects).where(eq(twxProjects.environment, envName)),
      ]);

      const env = envRows[0];
      if (!env) {
        await send(`[ERROR] Environment "${envName}" not found`);
        return;
      }

      const { twxBaseUrl, twxAppKey } = env;
      if (!twxBaseUrl?.trim()) {
        await send(`[ERROR] No TWX Base URL configured for "${envName}"`);
        return;
      }
      if (!twxAppKey?.trim()) {
        await send(`[ERROR] No App Key configured for "${envName}"`);
        return;
      }

      // Build the list of projects to export
      type ProjectJob = { twxName: string; folderName: string; alias: string; exportsFilter: string[] };
      let jobs: ProjectJob[];

      if (projectName?.trim()) {
        // Specific project requested — look up DB config for filters/alias
        const dbMatch = dbProjects.find((p) => p.projectName === projectName.trim());
        jobs = [{
          twxName: projectName.trim(),
          folderName: dbMatch?.folderName?.trim() || projectName.trim(),
          alias: dbMatch?.alias?.trim() || projectName.trim(),
          exportsFilter: dbMatch ? (JSON.parse(dbMatch.exports) as string[]) : ['all'],
        }];
      } else if (dbProjects.length > 0) {
        // No project specified but DB has configured projects — export all of them
        jobs = dbProjects.map((p) => ({
          twxName: p.projectName,
          folderName: p.folderName?.trim() || p.projectName,
          alias: p.alias?.trim() || p.projectName,
          exportsFilter: JSON.parse(p.exports) as string[],
        }));
        await send(`Exporting ${jobs.length} configured project(s): ${jobs.map((j) => j.twxName).join(', ')}`);
      } else {
        // No project specified, no DB config — fetch all TWX projects
        await send('No project specified — fetching all projects from ThingWorx...');
        const allNames = await getAllProjects(twxBaseUrl, twxAppKey);
        await send(`Found ${allNames.length} project(s): ${allNames.join(', ')}`);
        jobs = allNames.map((name) => ({ twxName: name, folderName: name, alias: name, exportsFilter: ['all'] }));
      }

      let totalExported = 0;
      let totalSkipped = 0;
      const allErrors: string[] = [];

      for (const job of jobs) {
        const safeAlias = job.alias.replace(/[^a-zA-Z0-9_\-. ]/g, '_');
        const safeFolderName = job.folderName.replace(/[^a-zA-Z0-9_\-. ]/g, '_');
        const resolved = path.resolve(outputDir, 'WindchillClients', 'Thingworx', safeAlias, safeFolderName);
        if (!resolved.startsWith(baseDir)) {
          await send(`[WARN] Skipping "${job.twxName}": invalid path`);
          continue;
        }

        await send(`Fetching entities for "${job.twxName}"...`);
        let entities;
        try {
          entities = await getProjectEntities(twxBaseUrl, twxAppKey, job.twxName);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          await send(`[WARN] Could not fetch entities for "${job.twxName}": ${msg}`);
          allErrors.push(`${job.twxName}: ${msg}`);
          continue;
        }

        const filtered = filterEntities(entities, job.exportsFilter);
        await send(`[${job.twxName}] ${entities.length} entities found, exporting ${filtered.length} (filter: ${job.exportsFilter.join(', ')})`);

        for (const entity of filtered) {
          const { name, type } = entity;
          try {
            await send(`[${job.twxName}] Exporting ${type}/${name}...`);
            const rawXml = await exportEntity(twxBaseUrl, twxAppKey, type, name);
            const xml = formatEntityXml(rawXml);
            await writeEntityXml(outputDir, safeAlias, safeFolderName, type, name, xml, false);
            totalExported++;
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            await send(`[WARN] Failed ${job.twxName}/${type}/${name}: ${msg}`);
            totalSkipped++;
            allErrors.push(`${job.twxName}/${type}/${name}: ${msg}`);
          }
        }
      }

      await send(
        `[DONE] ${JSON.stringify({
          exported: totalExported,
          skipped: totalSkipped,
          errors: allErrors,
          outputDir: safeEnv,
        })}`
      );
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
