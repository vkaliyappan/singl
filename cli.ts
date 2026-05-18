import path from 'path';
import dotenv from 'dotenv';
import { resolveConnection } from './src/lib/twx/config';
import { readManifest } from './src/lib/twx/manifest';
import { runExport } from './src/lib/twx/exporter';
import { runDeploymentExport } from './src/lib/twx/deployment-exporter';
import { runDeploymentExtract } from './src/lib/twx/deployment-extractor';
import type { ParsedFlags } from './src/lib/twx/types';

dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });
dotenv.config({ path: path.resolve(process.cwd(), '.env') });

const argv = process.argv.slice(2);

function parseArgs(): { args: string[]; flags: ParsedFlags } {
  const flags: ParsedFlags = {};
  const args: string[] = [];
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (!a.startsWith('--')) { args.push(a); i++; continue; }
    const eq = a.indexOf('=');
    if (eq !== -1) { flags[a.slice(2, eq)] = a.slice(eq + 1); i++; continue; }
    const name = a.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) { flags[name] = next; i += 2; }
    else { flags[name] = true; i++; }
  }
  return { args, flags };
}

function showHelp(): void {
  console.log('Usage: pnpm twx -- <command> [options]');
  console.log('');
  console.log('Commands:');
  console.log('  export                      Export project entities as XML files');
  console.log('  export-deploymentfiles      Export project ZIPs via source control');
  console.log('  extract-deploymentfiles     Extract deployment ZIPs into WindchillClients');
  console.log('');
  console.log('Options (export):');
  console.log('  --env <name>        Load credentials from app database');
  console.log('  --manifest <path>   Path to manifest.twx.json  (default: ./manifest.twx.json)');
  console.log('  --output <dir>      Output directory root       (default: ./WindchillClients/ThingWorx)');
  console.log('  --project <name>    Export only this project    (default: all)');
  console.log('  --dry-run           Preview without writing files');
  console.log('  --backup            Export into backup/<timestamp> instead of --output');
  console.log('');
  console.log('Options (export-deploymentfiles):');
  console.log('  --env <name>        Load credentials from app database');
  console.log('  --manifest <path>   Path to manifest.twx.json  (default: ./manifest.twx.json)');
  console.log('  --output <dir>      Local directory for ZIPs    (default: ./export)');
  console.log('  --project <name>    Export only this project    (default: all)');
  console.log('  --parent <dir>      Parent directory name       (default: auto timestamp)');
  console.log('  --suffix <text>     Suffix appended to each project folder');
  console.log('  --dry-run           Preview without calling API or writing files');
  console.log('');
  console.log('Options (extract-deploymentfiles):');
  console.log('  --manifest <path>   Path to manifest.twx.json  (default: ./manifest.twx.json)');
  console.log('  --input <dir>       Directory containing project folders (e.g. ./export/20260421-143000)');
  console.log('  --output <dir>      WindchillClients root       (default: ./WindchillClients/ThingWorx)');
  console.log('  --project <name>    Extract only this project   (default: all)');
  console.log('  --dry-run           Preview without writing files');
  console.log('');
  console.log('  --help              Show this help');
}

async function main(): Promise<void> {
  const { args, flags } = parseArgs();
  const cmd = args[0];
  if (!cmd || flags.help) { showHelp(); return; }

  const manifestPath = path.resolve(process.cwd(), (flags.manifest as string | undefined) ?? './manifest.twx.json');
  const dryRun = !!flags['dry-run'] || !!flags.dryRun;
  const projectFilter = (flags.project as string | undefined) ?? null;

  if (cmd === 'export') {
    const { baseUrl, appKey } = await resolveConnection(flags).catch(err => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    });

    let outputDir = flags.output
      ? path.resolve(process.cwd(), flags.output as string)
      : path.resolve(process.cwd(), './WindchillClients/ThingWorx');
    if (flags.backup) {
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      outputDir = path.resolve(process.cwd(), 'backup', ts);
      console.log(`Backup mode: exporting to ${outputDir}`);
    }

    const manifest = await readManifest(manifestPath).catch(err => {
      console.error('Failed to read manifest:', err instanceof Error ? err.message : err);
      process.exit(1);
    });

    const result = await runExport({ baseUrl, appKey, manifest, outputDir, projectFilter, dryRun, onProgress: console.log });
    console.log('\nExport summary:');
    console.log(`  projectsProcessed: ${result.projectsProcessed}`);
    console.log(`  entitiesExported:  ${result.entitiesExported}`);
    console.log(`  entitiesSkipped:   ${result.entitiesSkipped}`);
    if (result.errors.length) {
      console.error(`  errors: ${result.errors.length}`);
      result.errors.forEach(e => console.error('   -', e));
      process.exit(1);
    }
    return;
  }

  if (cmd === 'export-deploymentfiles') {
    const { baseUrl, appKey } = await resolveConnection(flags).catch(err => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    });

    const outputDir = path.resolve(process.cwd(), (flags.output as string | undefined) ?? './export');
    const parent = (flags.parent as string | undefined) ?? null;
    const suffix = (flags.suffix as string | undefined) ?? null;

    const manifest = await readManifest(manifestPath).catch(err => {
      console.error('Failed to read manifest:', err instanceof Error ? err.message : err);
      process.exit(1);
    });

    const projects = Object.entries(manifest.projects)
      .filter(([key, proj]) =>
        !projectFilter ||
        projectFilter === key ||
        projectFilter === proj.alias ||
        projectFilter === proj.projectName
      )
      .map(([key, proj]) => ({ key, twxName: proj.projectName ?? key }));

    const result = await runDeploymentExport({ baseUrl, appKey, projects, outputDir, parent, suffix, dryRun, onProgress: console.log });
    console.log('\nExport deployment files summary:');
    console.log(`  projectsProcessed: ${result.projectsProcessed}`);
    console.log(`  zipsSaved:         ${result.zipsSaved}`);
    if (result.errors.length) {
      console.error(`  errors: ${result.errors.length}`);
      result.errors.forEach(e => console.error('   -', e));
      process.exit(1);
    }
    return;
  }

  if (cmd === 'extract-deploymentfiles') {
    const inputDir = path.resolve(process.cwd(), (flags.input as string | undefined) ?? './export');
    const outputDir = path.resolve(process.cwd(), (flags.output as string | undefined) ?? './WindchillClients/ThingWorx');

    const manifest = await readManifest(manifestPath).catch(err => {
      console.error('Failed to read manifest:', err instanceof Error ? err.message : err);
      process.exit(1);
    });

    const extractProjects = Object.entries(manifest.projects)
      .filter(([key, proj]) =>
        !projectFilter ||
        projectFilter === key ||
        projectFilter === proj.alias ||
        projectFilter === proj.projectName
      )
      .map(([key, proj]) => ({ key, alias: proj.alias ?? key }));

    const result = await runDeploymentExtract({ projects: extractProjects, inputDir, outputDir, dryRun, onProgress: console.log })
      .catch(err => { console.error(err instanceof Error ? err.message : String(err)); process.exit(1); });

    console.log('\nExtract deployment files summary:');
    console.log(`  zipFilesProcessed: ${result.zipFilesProcessed}`);
    console.log(`  entitiesExtracted: ${result.entitiesExtracted}`);
    console.log(`  entitiesSkipped:   ${result.entitiesSkipped}`);
    if (result.errors.length) {
      console.error(`  errors: ${result.errors.length}`);
      result.errors.forEach(e => console.error('   -', e));
      process.exit(1);
    }
    return;
  }

  console.error('Unknown command:', cmd);
  showHelp();
  process.exit(1);
}

main().catch(err => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
