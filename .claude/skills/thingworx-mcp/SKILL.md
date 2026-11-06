---
name: thingworx-mcp
description: Work with a live ThingWorx server through the twx MCP tools (mcp__twx__*). Use when the user asks to inspect, query, export, or invoke anything on ThingWorx — environments, projects, entities, Things, properties, services — or says "twx", "ThingWorx", "check on the server", "call service X on thing Y".
---

# ThingWorx via twx MCP

## What the twx MCP is

Local stdio MCP server shipped in this repo. It lets Claude talk to a live ThingWorx server over the ThingWorx REST API.

- **Start:** `src-tauri/target/debug/twx-mcp.exe` (Rust bin, registered as `twx` in `.mcp.json`; build with `pnpm twx:mcp:build`).
- **Tool code:** `src-tauri/crates/singl-core/src/bin/twx-mcp.rs`, REST calls in `src-tauri/crates/singl-core/src/twx/api.rs`.
- **Connection** (`twx-mcp.rs`):
  - With `env` param → looks up `twxBaseUrl` + `twxAppKey` in `environment_settings` table (app Settings page; DB from `--db`, else `SINGL_DB`, else `%APPDATA%\com.singl.app\singl.db`, opened read-only). Environments switched off in Settings are refused and left out of `twx_list_environments`.
  - Without `env` → falls back to `TWX_BASE_URL` / `TWX_APP_KEY` env vars (or `.env.local` / `.env`).
- **Output:** every tool returns pretty JSON text. Errors come back as `isError: true` with ThingWorx's message.
- **Auth:** app key per environment. Claude acts with that key's permissions — writes are real.

## Tools

Every tool except `twx_list_environments` takes optional `env` (environment name).

| Tool | Required params | Does |
|------|-----------------|------|
| `twx_list_environments` | — | List environments in app DB: `{ environment, twxBaseUrl }`. |
| `twx_list_projects` | — | List all projects. |
| `twx_list_project_entities` | `projectName` | List all entities in a project. |
| `twx_list_entities` | `type` (+ `nameMask`, default `*`) | Search entities of one type by name mask (`*` wildcard). |
| `twx_list_things` | (`nameMask`) | Shortcut for `twx_list_entities` with type `Things`. |
| `twx_list_properties` | `type`, `entityName` | Property definitions: name, baseType, aspects. |
| `twx_get_property_value` | `entityName`, `propertyName` | Current value of one Thing property. |
| `twx_get_all_property_values` | `entityName` | Current values of all Thing properties. |
| `twx_list_services` | `type`, `entityName` | Service definitions: name, params, result type. |
| `twx_invoke_service` | `type`, `entityName`, `serviceName` (+ `inputs` object) | Execute service. **May have side effects.** |
| `twx_export_entity` | `type`, `entityName` | Export entity definition as XML. |

### `type` param

Accepts entity type or collection name — both work (`Thing` ≡ `Things`). Known mappings:

`Thing`, `ThingTemplate`, `ThingShape`, `DataShape`, `Mashup`, `MediaEntity`, `Group`, `Organization`, `Project`, `StateDefinition`, `StyleDefinition`, `StyleTheme`, `Transformer`, `Resource`, `Subsystem`.

Other values pass through unchanged as collection name (e.g. `Users`, `Networks`).

Property value tools (`twx_get_property_value`, `twx_get_all_property_values`) work on Things only — no `type` param.

## Local exported code (read this before hitting the server)

The app exports ThingWorx projects often and extracts their code to disk. **Prefer these local files for reading code** — faster, greppable, no server load. Use MCP for live state (property values, running services) or when local copy may be stale.

Root: `workdir/twx-entities/` (workspace root set in app Settings; `workdir/` in this repo). Layout:

```
workdir/twx-entities/<ENV>/WindchillClients/Thingworx/<ProjectAlias>/
├── <ProjectName>/                     # raw entity exports (XML)
│   └── <Collection>/<EntityName>.xml   # e.g. Things/Thing.Common.HelperThing.xml
└── Code/                               # code extracted from those XMLs
    ├── Things/<EntityName>/<Service>.js
    ├── ThingTemplates/<EntityName>/<Service>.js
    ├── ThingShapes/<EntityName>/<Service>.js
    ├── Mashups/<MashupName>/<Expression>.js   (+ .css / .html)
    └── DataShapes/<DataShapeName>.ts          # field definitions as TS type
```

- `<ENV>` = environment name (same as MCP `env`, e.g. `test`).
- `<ProjectAlias>` = folder alias chosen in app (e.g. `CommonUtility`, `BomTransform`).
- `<ProjectName>` = real ThingWorx project name (e.g. `CHB_Common`, `ITCI_CHBBOMTransformer`) — the only non-`Code` folder under alias.
- `<Collection>` = plural REST collection (`Things`, `ThingTemplates`, `DataShapes`, `Mashups`, `Groups`, `Projects`, …).
- Workspace layout in `src-tauri/crates/singl-core/src/workspace.rs`; export in `src/twx/export.rs`, code extraction in `src/twx/extract_services.rs` (same crate).

### What's in `Code/`

Main folders: `Things`, `Mashups`, `DataShapes` (some projects also have `ThingShapes` / `ThingTemplates`, same format as `Things`).

| Folder | Files | Contents |
|--------|-------|----------|
| `Things/<Thing>/` | `<Service>.js` | Service code, one file per service. Top of file has a doc comment and `var` lines for the inputs and `result`. |
| `DataShapes/` | `<DataShape>.ts` | One TS `interface` per DataShape: field names, base types (`TwxBaseTypeMap['STRING']`), description and `@ordinal` in comments. Generated files, don't edit. `twx-types.ts` and `index.ts` are helpers, not DataShapes. |
| `Mashups/<Mashup>/` | `<Name>.js`, `stylesheet.css`, `.html` | Mashup expression and validator functions (e.g. `HideExportButton.js`, `DownStreamInfotableValidator.js`) plus the mashup CSS. |

### Reviewing service code: pull in its DataShapes

When checking or debugging a service, don't read the `.js` alone. Also load the DataShapes it uses:

1. Read `Code/Things/<Thing>/<Service>.js`.
2. Find the DataShapes it uses:
   - In the code: `dataShapeName: "DataShape.X"`, `CreateInfoTableFromDataShape`, `CreateValuesWithData`, and so on.
   - For input and result InfoTables, the `.js` only has `var x;`. The DataShape name is in the Thing's XML (`<ProjectName>/Things/<Thing>.xml` → `<ServiceDefinition name="<Service>">` → `aspect.dataShape` attribute on `<ResultType>` and on each `<ParameterDefinitions><FieldDefinition>`). Or use `twx_list_services`.
3. Open `Code/DataShapes/<DataShape>.ts`. Look in the same alias first; if it's not there, glob the whole env (DataShapes are often shared, e.g. from `CommonUtility`).
4. Check that the code uses real field names, the right types and the right case. Wrong or misspelled InfoTable field names are a common bug.

### Reading service code: rules

**`me`**: what it points to depends on where the code lives:
- `Code/Things/<Thing>/…`: `me` is that Thing. `me.X()` is a service on the same Thing, so look in the same folder: `Code/Things/<Thing>/X.js`. `me.prop` is a property on that Thing.
- `Code/ThingShapes/<Shape>/…`: `me` is the Thing that uses the ThingShape at runtime, not the shape. `me.X()` may be defined on the shape itself, or on that Thing or its template. Find the Things that use the shape in the XMLs under `<ProjectName>/` (the `ImplementedShapes` of Things and ThingTemplates). Or check live with `twx_list_entities`.
- The same applies to ThingTemplates: `me` is the Thing built from the template.

**Follow the code flow.** Trace calls in the order they run; don't read files at random.
1. When the code calls another service (`Things["Name"].Service(...)` or `me.Service(...)`), first find which Thing it is and where that Thing lives. Grep for its folder under `workdir/twx-entities/<ENV>/**/Code/Things/<Name>/`.
2. Open that service's `.js` only when you need it to answer the question. Go deeper step by step; don't read every called service up front.
3. If there's no local code for the Thing (not exported, or a system or extension Thing), use `twx_list_services` to get its signature. Use `twx_export_entity` if you need the whole definition.
4. **Need real data to follow the logic?** For example, the rows a service returns, a property value, or the config it reads. Fetch it with the MCP (`twx_get_property_value`, `twx_get_all_property_values`, or read-only `twx_invoke_service` like `Get*` / `Query*`). Use it as reference. Don't call services that write data without asking the user.

**IntegrationConnectors** (`Things["IntegrationConnector.<X>.ODATA"]`, `…FixedConnector`, `itci-windchill-OData-connector`, and so on):
- Their code is not in `Code/`. Connectors are configured on the server; they aren't script services.
- If the flow depends on a connector call (e.g. `WC_CONNECTOR.Containers_GET_All(...)`, `.GetVersions`, `.CheckOutPart`), check it through the MCP:
  - `twx_list_services`: endpoint signature (inputs and result).
  - `twx_export_entity`: full config (base URL, endpoint mapping, connection settings).
  - Read-only invoke: sample response data.
- Only do this when needed; for simple calls the name and arguments are often enough.
- Watch for connectors picked at runtime, e.g. `useFixedConnector ? FixedConnector : ODATA`. Check the one the scenario actually uses.

How to use:
- Find service code: glob `workdir/twx-entities/<ENV>/**/Code/**/<Entity>/<Service>.js`.
- Find who calls something: grep across `workdir/twx-entities/<ENV>/**/Code/`.
- Full entity definition (properties, bindings, config, permissions): the XML under `<ProjectName>/`.
- Env unknown: `ls workdir/twx-entities/` shows exported envs.
- Local code is a snapshot. If user says server changed, or results disagree with live behavior, compare with `twx_export_entity` / `twx_list_services`.

## General workflow

1. Pick environment. If user didn't name one and more than one exists, run `twx_list_environments` and ask.
2. Code questions → local `workdir/twx-entities` first. Live data / behavior → MCP.
3. Discover before acting: list → inspect definitions → read values / invoke.
4. Before `twx_invoke_service`, check params with `twx_list_services`. Read-only services (`Get*`, `Query*`, `Search*`) are fine. Confirm with user before any service that writes, deletes, restarts, or has other side effects.

<!-- Rules added one by one by user below -->

- **Don't edit entity XML files** (`<ProjectName>/<Collection>/*.xml`) unless the user explicitly says to. Change service code in `Code/…/<Service>.js` only. If the change also needs definition updates (new inputs, result type, DataShape), list them in the reply (name, base type, DataShape) for the user to apply in ThingWorx. Don't write them to the XML.
