//! Assistant tools: entities. The TWX Entities page: exported entity files
//! under the workspace's `twx-entities` folder, and the export, re-export and
//! remote listing that fill it from a ThingWorx server.
//!
//! Paths are relative to `twx-entities` and `/`-separated. `env` defaults to
//! the environment on screen (see [`twx::resolve_env`]).

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use serde::Serialize;
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use super::{Args, Risk, Tool, schema, ser, tool, twx};
use crate::assistant::Assistant;
use crate::db::environments;
use crate::repo::files::{self, SearchOptions};
use crate::twx::entities::{self as ents, ExportJob, SelectedEntity};
use crate::twx::projects;
use crate::twx::run_times::{self, RunKind};
use crate::workspace::PathKind;
use crate::{CoreError, Result, SqlitePool};

const ENV: &str = "Environment name from Settings. Default: the one on screen, else the first enabled.";

/// The `twx-entities` folder of the workspace.
fn base(a: &Assistant) -> Result<PathBuf> {
  a.workspace()
    .resolve(PathKind::TwxEntities)
    .ok_or_else(|| CoreError::Invalid("No workspace folder is set. Choose one in Settings.".into()))
}

/// Compact JSON, for long lists.
fn compact<T: Serialize>(v: &T) -> Result<String> {
  serde_json::to_string(v).map_err(|e| CoreError::Invalid(e.to_string()))
}

/// A required argument as typed, empty included (file content may be empty).
fn text<'a>(args: &'a Value, key: &str) -> Result<&'a str> {
  args
    .get(key)
    .and_then(Value::as_str)
    .ok_or_else(|| CoreError::Invalid(format!("Missing required argument \"{key}\".")))
}

/// A log sink that keeps its lines, for [`tail`].
fn log_sink() -> (Arc<Mutex<Vec<String>>>, impl FnMut(String) + Send) {
  let lines = Arc::new(Mutex::new(Vec::new()));
  let sink = {
    let lines = lines.clone();
    move |line: String| lines.lock().unwrap_or_else(|e| e.into_inner()).push(line)
  };
  (lines, sink)
}

/// The last 100 lines of a job's log, so a long export does not bury the result.
fn tail(lines: &Mutex<Vec<String>>) -> Vec<String> {
  let lines = lines.lock().unwrap_or_else(|e| e.into_inner());
  lines[lines.len().saturating_sub(100)..].to_vec()
}

/// The export projects an export of `project` covers: `project` alone (with
/// its Settings entry, if any), every project configured for `env`, or `None`
/// for every project on the server.
async fn export_jobs(
  pool: &SqlitePool,
  env: &str,
  project: Option<&str>,
  log: &mut (dyn FnMut(String) + Send),
) -> Result<Option<Vec<ExportJob>>> {
  let configured: Vec<ExportJob> = environments::list(pool)
    .await?
    .into_iter()
    .filter(|e| e.environment == env)
    .flat_map(|e| e.projects)
    .map(|p| {
      let or_name = |s: &str| Some(s.trim()).filter(|s| !s.is_empty()).unwrap_or(&p.project_name).to_string();
      ExportJob {
        folder_name: or_name(&p.folder_name),
        alias: or_name(&p.alias),
        twx_name: p.project_name.clone(),
        exports: p.exports.clone(),
      }
    })
    .collect();

  Ok(match project.map(str::trim).filter(|p| !p.is_empty()) {
    Some(name) => Some(vec![configured.into_iter().find(|j| j.twx_name == name).unwrap_or_else(|| ExportJob {
      twx_name: name.into(),
      folder_name: name.into(),
      alias: name.into(),
      exports: vec!["all".into()],
    })]),
    None if !configured.is_empty() => {
      let names: Vec<_> = configured.iter().map(|j| j.twx_name.as_str()).collect();
      log(format!("Exporting {} configured project(s): {}", names.len(), names.join(", ")));
      Some(configured)
    }
    None => None,
  })
}

pub fn tools() -> Vec<Tool> {
  let env = || json!({ "type": "string", "description": ENV });
  let path = |desc: &str| json!({ "type": "string", "description": desc });
  let flag = |desc: &str| json!({ "type": "boolean", "description": desc });

  vec![
    tool(
      "entity_list_files",
      "Every file and folder under the exported TWX entities (or under one folder), relative to the entities folder; folders end in \"/\". Use it to find an exported entity before reading it.",
      schema(
        json!({ "path": path("Folder relative to the entities folder, e.g. \"dev/WindchillClients\". Default: the whole folder.") }),
        &[],
      ),
      Risk::Read,
      |a, args, _| async move { compact(&ents::list(&base(&a)?, Args(&args).str("path").unwrap_or(""))?) },
    ),
    tool(
      "entity_read",
      "The text of one exported entity file (XML, or a script). Use it to inspect an entity or script before changing it.",
      schema(
        json!({ "path": path("File path relative to the entities folder, e.g. \"dev/.../Name.xml\".") }),
        &["path"],
      ),
      Risk::Read,
      |a, args, _| async move { ents::read(&base(&a)?, Args(&args).need("path")?) },
    ),
    tool(
      "entity_write",
      "Overwrite an existing exported entity file with new text, locally only (the server is not changed). The file must already exist; use entity_create for new ones.",
      schema(
        json!({
          "path": path("Existing file path relative to the entities folder."),
          "content": path("The full new text of the file."),
        }),
        &["path", "content"],
      ),
      Risk::Write,
      |a, args, _| async move {
        let rel = Args(&args).need("path")?;
        ents::write(&base(&a)?, rel, text(&args, "content")?)?;
        Ok(format!("Saved {rel}."))
      },
    ),
    tool(
      "entity_create",
      "Create an empty file or folder inside an existing folder of the exported entities. Returns the new path.",
      schema(
        json!({
          "parent": path("Existing folder relative to the entities folder. Default: the top level."),
          "name": path("Name of the new file or folder."),
          "dir": flag("True to create a folder, false for a file. Default false."),
        }),
        &["name"],
      ),
      Risk::Write,
      |a, args, _| async move {
        let x = Args(&args);
        let created =
          ents::create(&base(&a)?, x.str("parent").unwrap_or(""), x.need("name")?, x.bool("dir").unwrap_or(false))?;
        Ok(format!("Created {created}."))
      },
    ),
    tool(
      "entity_rename",
      "Rename a local exported entity file or folder. Local only; the server is not changed. Asks the user first.",
      schema(
        json!({
          "path": path("Path of the file or folder relative to the entities folder."),
          "name": path("The new name (no folder part)."),
        }),
        &["path", "name"],
      ),
      Risk::Destructive,
      |a, args, _| async move {
        let x = Args(&args);
        let new_path = ents::rename(&base(&a)?, x.need("path")?, x.need("name")?)?;
        Ok(format!("Renamed to {new_path}."))
      },
    ),
    tool(
      "entity_delete",
      "Delete a local exported entity file or folder (folders with their contents). Local only; the server is not changed. Asks the user first.",
      schema(json!({ "path": path("Path relative to the entities folder.") }), &["path"]),
      Risk::Destructive,
      |a, args, _| async move {
        let rel = Args(&args).need("path")?;
        ents::delete(&base(&a)?, rel)?;
        Ok(format!("Deleted {rel}."))
      },
    ),
    tool(
      "entity_search",
      "Text search inside the exported entity files (or one folder of them). Returns matching files with line numbers and text. Use it to find where a name, property or script is used.",
      schema(
        json!({
          "root": path("Folder to search, relative to the entities folder. Default: all of it."),
          "query": path("Text to find."),
          "caseSensitive": flag("Match case. Default false."),
          "wholeWord": flag("Match whole words only. Default false."),
          "useRegex": flag("Treat the query as a regular expression. Default false."),
          "matchFilename": flag("Also match file names. Default false."),
        }),
        &["query"],
      ),
      Risk::Read,
      |a, args, _| async move {
        let x = Args(&args);
        let root = files::safe_join(&base(&a)?, x.str("root").unwrap_or(""))?;
        let opts = SearchOptions {
          case_sensitive: x.bool("caseSensitive").unwrap_or(false),
          whole_word: x.bool("wholeWord").unwrap_or(false),
          use_regex: x.bool("useRegex").unwrap_or(false),
          match_filename: x.bool("matchFilename").unwrap_or(false),
        };
        compact(&files::search(&root, x.need("query")?, opts)?)
      },
    ),
    tool(
      "entity_find",
      "Find exported files and folders by name, best matches first. Without a query, the top of the tree. Use it when only part of an entity's name is known.",
      schema(
        json!({
          "root": path("Environment folder inside the entities folder, e.g. \"dev\"."),
          "query": path("Part of the file or folder name or path."),
          "limit": { "type": "integer", "description": "Maximum results, 1 to 100. Default 30." },
        }),
        &["root"],
      ),
      Risk::Read,
      |a, args, _| async move {
        let x = Args(&args);
        let limit = x.i64("limit").unwrap_or(30).clamp(1, 100) as usize;
        let found = ents::find(&base(&a)?, x.need("root")?, x.str("query").unwrap_or(""), limit)?;
        compact(&found)
      },
    ),
    tool(
      "entity_locate",
      "Find an exported ThingWorx entity's XML file and the scripts extracted from it, by entity name. Fails if the entity has not been exported yet.",
      schema(
        json!({
          "env": env(),
          "entity": path("Entity name, e.g. \"MyThing\"."),
          "collection": path("REST collection, e.g. \"Things\". Default: try every one."),
          "service": path("Service name, to find that service's script."),
        }),
        &["entity"],
      ),
      Risk::Read,
      |a, args, _| async move {
        let x = Args(&args);
        let env = twx::resolve_env(&a, &args).await?;
        let entity = x.need("entity")?;
        let found =
          ents::locate(&base(&a)?, &run_times::safe_env(&env), entity, x.str("collection"), x.str("service"))?;
        match found {
          Some(found) => ser(&found),
          None => Err(CoreError::NotFound(format!(
            "{entity} has not been exported for {env} yet. Export it from TWX Entities first."
          ))),
        }
      },
    ),
    tool(
      "entity_run_times",
      "When an environment's entities were last exported and extracted.",
      schema(json!({ "env": env() }), &[]),
      Risk::Read,
      |a, args, _| async move {
        let env = twx::resolve_env(&a, &args).await?;
        let file = a
          .workspace()
          .resolve(PathKind::RunTimes)
          .ok_or_else(|| CoreError::Invalid("No workspace folder is set. Choose one in Settings.".into()))?;
        ser(&run_times::get(&file, &run_times::safe_env(&env)))
      },
    ),
    tool(
      "entity_list_remote",
      "Every entity on the ThingWorx server in the projects of an export (or of one project), for choosing what to export. Read only.",
      schema(
        json!({
          "env": env(),
          "project": path("One ThingWorx project. Default: the projects configured for the environment, else all of them."),
        }),
        &[],
      ),
      Risk::Read,
      |a, args, _| async move {
        let env = twx::resolve_env(&a, &args).await?;
        let pool = a.pool().await;
        let client = projects::connect(&pool, &env).await?;
        let (lines, mut log) = log_sink();
        let jobs = export_jobs(&pool, &env, Args(&args).str("project"), &mut log).await?;
        let entities = ents::list_remote(&client, jobs, &mut log).await?;
        ser(&json!({ "entities": entities, "log": tail(&lines) }))
      },
    ),
    tool(
      "entity_export",
      "Export ThingWorx entities from the server into the local entities folder as XML, overwriting the local copies. Exports the projects configured for the environment unless one project is named; `only` limits it to chosen entities. Returns counts, errors and the last log lines. Asks the user first.",
      schema(
        json!({
          "env": env(),
          "project": path("One ThingWorx project to export. Default: the configured projects."),
          "only": {
            "type": "array",
            "description": "Entities to export, from entity_list_remote. Default: every entity the export filter covers.",
            "items": {
              "type": "object",
              "properties": {
                "project": { "type": "string" },
                "type": { "type": "string" },
                "name": { "type": "string" },
              },
              "required": ["project", "type", "name"],
            },
          },
        }),
        &[],
      ),
      Risk::Destructive,
      |a, args, _| async move {
        let x = Args(&args);
        let env = twx::resolve_env(&a, &args).await?;
        let base = base(&a)?;
        let pool = a.pool().await;
        let client = projects::connect(&pool, &env).await?;
        let only: Option<Vec<SelectedEntity>> = match args.get("only") {
          None | Some(Value::Null) => None,
          Some(v) => Some(serde_json::from_value(v.clone()).map_err(|e| CoreError::Invalid(format!("\"only\": {e}")))?),
        };

        let (lines, mut log) = log_sink();
        let jobs = export_jobs(&pool, &env, x.str("project"), &mut log).await?;
        if let Some(only) = &only {
          log(format!("Exporting {} selected entit{}", only.len(), if only.len() == 1 { "y" } else { "ies" }));
        }

        let safe_env = run_times::safe_env(&env);
        let cancel = CancellationToken::new();
        let mut result = ents::export(&client, &base, &safe_env, jobs, only.as_deref(), &cancel, &mut log).await?;
        if let Some(file) = a.workspace().resolve(PathKind::RunTimes) {
          result.exported_at = Some(run_times::record(&file, &safe_env, RunKind::Exported)?);
        }
        ser(&json!({ "result": result, "log": tail(&lines) }))
      },
    ),
    tool(
      "entity_reexport",
      "Export one already-exported entity file again from the server, overwriting the local file, and return the new XML. The file must be an exported entity (.../<Collection>/<Name>.xml). Asks the user first.",
      schema(
        json!({
          "env": env(),
          "path": path("The exported entity file, relative to the entities folder."),
        }),
        &["path"],
      ),
      Risk::Destructive,
      |a, args, _| async move {
        let env = twx::resolve_env(&a, &args).await?;
        let rel = Args(&args).need("path")?;
        let safe_env = run_times::safe_env(&env);
        if rel.replace('\\', "/").split('/').next() != Some(safe_env.as_str()) {
          return Err(CoreError::Invalid(format!("\"{rel}\" is not in {env}'s exports")));
        }
        let pool = a.pool().await;
        let client = projects::connect(&pool, &env).await?;
        ents::reexport(&client, &base(&a)?, rel).await
      },
    ),
  ]
}
