# twx-scripts

Utilities and a CLI for managing ThingWorx project entities — export XML, export deployment ZIPs, extract ZIPs, and embed code changes back into XML.

## Prerequisites

- Node.js >= 18 (required for built-in `fetch`)
- Credentials — either via env vars **or** the `--env` flag (see below)

```
TWX_BASE_URL=https://your-thingworx-host/Thingworx
TWX_APP_KEY=your-app-key-uuid
```

Set these in `.env.local` (takes precedence) or `.env`.  
Alternatively, use `--env <name>` to load credentials from the app database (configured in the Settings page).

---

## Structure

| Path | Purpose |
|------|---------|
| `cli.ts` | CLI entry point — run from terminal via `pnpm twx` |
| `src/lib/twx/` | Shared library — imported by both the CLI and the API routes |
| `src/app/api/twx/` | Next.js route handlers — expose each command as an SSE stream |

No separate build step is needed. `tsx` compiles `cli.ts` on the fly, and Next.js handles `src/`.

---

## Manifest

All CLI commands and API routes read `manifest.twx.json` to know which projects to operate on.

```json
{
  "projects": {
    "ITCI_CHBUtils": {
      "projectName": "ITCI.CHBUtils",
      "alias": "InheritanceApp",
      "exports": ["all"]
    }
  }
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `projectName` | No | ThingWorx internal project name — falls back to the manifest key if omitted |
| `alias` | Yes | Folder name used in the local output directory tree |
| `exports` | Yes | `"all"` or a subset: `DataShapes`, `Mashups`, `MediaEntities`, `Projects`, `StyleThemes`, `Things`, `ThingShapes`, `ThingTemplates` |

See `manifest-example.twx.json` for a full multi-project example.

---

## Commands

### `export` — Export entity XML files

Downloads project entities from ThingWorx as individual XML files via the Exporter REST API.

```bash
# Export all projects
pnpm twx -- export

# Dry-run (preview only, no files written)
pnpm twx -- export --dry-run

# Export a single project
pnpm twx -- export --project ITCI_CHBUtils

# Export using named credentials from the app database
pnpm twx -- export --env production

# Export to a timestamped backup directory
pnpm twx -- export --backup
```

**Options**

| Flag | Default | Description |
|------|---------|-------------|
| `--env <name>` | — | Load TWX credentials from the app database (Settings page) |
| `--manifest <path>` | `./manifest.twx.json` | Path to the manifest file |
| `--output <dir>` | `./WindchillClients/ThingWorx` | Root directory for XML output |
| `--project <name>` | all | Export only this project (manifest key, alias, or projectName) |
| `--dry-run` | — | Preview actions without writing files |
| `--backup` | — | Write to `backup/<ISO-timestamp>/` instead of `--output` |

**Output structure**

```
WindchillClients/ThingWorx/
└── {alias}/
    └── {projectKey}/
        ├── Things/
        │   └── MyThing.xml
        ├── Mashups/
        └── DataShapes/
```

---

### `export-deploymentfiles` — Export deployment ZIPs via source control

Uses ThingWorx's `SourceControlFunctions` to export each project as a ZIP file into SystemRepository, then downloads the ZIPs locally. Folder and file names include today's date (`DD-MON-YYYY`). All projects in a single run are grouped under a shared parent directory (auto-generated timestamp by default).

```bash
# Export all projects (auto timestamp parent)
pnpm twx -- export-deploymentfiles

# Dry-run (no API calls, no files written)
pnpm twx -- export-deploymentfiles --dry-run

# Export a single project
pnpm twx -- export-deploymentfiles --project ITCI_CHBUtils

# Load credentials from the app database
pnpm twx -- export-deploymentfiles --env production

# Custom parent directory name
pnpm twx -- export-deploymentfiles --parent Release_v1

# Add a suffix to each project folder/zip name
pnpm twx -- export-deploymentfiles --parent Release_v1 --suffix RC1
```

**Options**

| Flag | Default | Description |
|------|---------|-------------|
| `--env <name>` | — | Load TWX credentials from the app database (Settings page) |
| `--manifest <path>` | `./manifest.twx.json` | Path to the manifest file |
| `--output <dir>` | `./export` | Local directory to save downloaded ZIPs |
| `--project <name>` | all | Export only this project |
| `--parent <dir>` | `YYYYMMDD-HHmmss` | Parent folder in SystemRepository and locally — shared across all projects in the run |
| `--suffix <text>` | — | Text appended to each project folder and ZIP name (e.g. `RC1`, `v1.0`) |
| `--dry-run` | — | Preview without calling API or writing files |

**Output structure**

```
# Default (auto timestamp parent, no suffix)
export/
└── 20260421-143000/
    ├── ITCI_CHBUtils_21-APR-2026/
    │   └── ITCI_CHBUtils_21-APR-2026.zip
    └── ITCI_CHBPR_21-APR-2026/
        └── ITCI_CHBPR_21-APR-2026.zip

# With --parent Release_v1 --suffix RC1
export/
└── Release_v1/
    ├── ITCI_CHBUtils_21-APR-2026_RC1/
    │   └── ITCI_CHBUtils_21-APR-2026_RC1.zip
    └── ITCI_CHBPR_21-APR-2026_RC1/
        └── ITCI_CHBPR_21-APR-2026_RC1.zip
```

The same structure is mirrored in SystemRepository under `SystemRepository/{parent}/{projectKey}_{date}[_{suffix}]/`.

---

### `extract-deploymentfiles` — Extract deployment ZIPs into WindchillClients

Unzips previously downloaded deployment ZIPs and distributes the XML files into the same `WindchillClients/ThingWorx/` structure that the `export` command produces. Automatically detects flat (`Things/Entity.xml`) and project-wrapped (`ITCI.CHBUtils/Things/Entity.xml`) ZIP structures. Applies XML formatting to each extracted file.

```bash
# Extract all projects from a specific export run
pnpm twx -- extract-deploymentfiles --input ./export/20260421-143000

# Dry-run (preview only)
pnpm twx -- extract-deploymentfiles --input ./export/20260421-143000 --dry-run

# Extract a single project
pnpm twx -- extract-deploymentfiles --input ./export/20260421-143000 --project ITCI_CHBUtils
```

`--input` must point to the directory that **directly contains** the project folders (e.g. `ITCI_CHBUtils_21-APR-2026/`). For exports done with a `--parent` or auto-timestamp, that means pointing one level inside `./export/`.

**Options**

| Flag | Default | Description |
|------|---------|-------------|
| `--manifest <path>` | `./manifest.twx.json` | Path to the manifest file |
| `--input <dir>` | `./export` | Directory that directly contains the project folders |
| `--output <dir>` | `./WindchillClients/ThingWorx` | WindchillClients root to extract into |
| `--project <name>` | all | Extract only this project's ZIPs |
| `--dry-run` | — | Preview without writing files |

---

## API Routes

Each command is also available as a Next.js route handler that streams progress via Server-Sent Events (SSE). This lets the UI show live status as operations run.

| Method | Route | Equivalent CLI command |
|--------|-------|------------------------|
| `POST` | `/api/twx/export` | `export` |
| `POST` | `/api/twx/export-deploymentfiles` | `export-deploymentfiles` |
| `POST` | `/api/twx/extract-deploymentfiles` | `extract-deploymentfiles` |

Send flags as a JSON body. The response is a `text/event-stream` where each `data:` line is one progress message. The final line is `data: [DONE] <result json>` on success or `data: [ERROR] <message>` on failure.

```ts
const res = await fetch('/api/twx/export', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ env: 'production', 'dry-run': true }),
});

const reader = res.body!.getReader();
const dec = new TextDecoder();
while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  console.log(dec.decode(value)); // each data: line is one progress message
}
```

---

## Extract and Embed (Gulp tasks)

Two Gulp tasks operate on the XML files under `WindchillClients/ThingWorx/` after they have been exported or extracted.

### `extract-services`

Scans XML entity files and writes extracted source code into each project's `Code/` directory:
- `Things` / `ThingShapes` / `ThingTemplates` → service JS and subscription JS
- `Mashups` → `stylesheet.css`, widget expression JS, widget HTML
- `DataShapes` → TypeScript interfaces

```bash
# Extract all projects
npm run extract-services

# Extract a single project (verbose)
npm run extract-services -- --project InheritanceApp --verbose
```

### `embed-services`

Reads modified source files from each project's `Code/` directory and embeds them back into the matching XML entities. Produces `embed-report.json` listing changed entities.

```bash
# Embed all changes
npm run embed-services

# Embed specific files only (comma-separated)
npm run embed-services -- --only MyService.js,stylesheet.css
```

**Gulp task options**

| Flag / Env var | Description |
|----------------|-------------|
| `--project <name>` / `PROJECT` | Limit to one project folder |
| `--verbose` / `VERBOSE` | Verbose logging |
| `--files <list>` / `--only <list>` / `EMBED_FILES` | Filter by filename (comma-separated) |

---

## Typical workflow

```
1. pnpm twx -- export-deploymentfiles                                      ← pull ZIPs from ThingWorx (note the parent dir printed, e.g. 20260421-143000)
2. pnpm twx -- extract-deploymentfiles --input ./export/20260421-143000    ← expand ZIPs into WindchillClients XML
3. npm run extract-services                                                 ← extract code from XML into Code/ dirs
4. ... edit Code/ files in your IDE ...
5. npm run embed-services                                                   ← write changes back into XML
6. (commit WindchillClients/ to source control)
```

Or use the lighter entity-level export instead of deployment ZIPs:

```
1. pnpm twx -- export           ← pull entity XML directly
2. npm run extract-services
3. ... edit ...
4. npm run embed-services
```
