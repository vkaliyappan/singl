//! Assistant tools: deploy. ThingWorx export, deployment ZIPs, SystemRepository,
//! connectors, twx-cli bundles and extract. Named `deploy_*` so they do not clash
//! with the `twx_*` read tools. Each tool calls the same singl-core function as
//! `src-tauri/src/commands/twx.rs`.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use serde_json::json;
use tokio_util::sync::CancellationToken;

use super::{Args, Risk, Tool, schema, ser, tool, twx};
use crate::assistant::Assistant;
use crate::db;
use crate::repo::files;
use crate::twx::connectors::{self, ConnectorUpdate};
use crate::twx::deployment::{self, BackupFormat, UploadOptions};
use crate::twx::{bundle, export, extract_services, projects, run_times, stamp};
use crate::workspace::PathKind;
use crate::{CoreError, Result};

/// Progress lines of a run, collected for the tool result.
#[derive(Clone, Default)]
struct Log(Arc<Mutex<Vec<String>>>);

impl Log {
  fn push(&self, line: String) {
    self.0.lock().unwrap_or_else(|e| e.into_inner()).push(line);
  }

  fn tail(&self) -> Vec<String> {
    let lines = self.0.lock().unwrap_or_else(|e| e.into_inner());
    lines[lines.len().saturating_sub(100)..].to_vec()
  }
}

/// A run's result with the last 100 progress lines.
fn report<T: Serialize>(result: &T, log: &Log) -> Result<String> {
  ser(&json!({ "result": result, "log": log.tail() }))
}

fn join_err(e: impl std::fmt::Display) -> CoreError {
  CoreError::Io(std::io::Error::other(e.to_string()))
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T> + Send + 'static) -> Result<T> {
  tokio::task::spawn_blocking(f).await.map_err(join_err)?
}

fn no_workspace() -> CoreError {
  CoreError::Invalid("No workspace folder is set. Choose one in Settings.".into())
}

/// `input` (or `default` when blank) against the workspace folder.
fn resolve(a: &Assistant, input: Option<&str>, default: &str) -> Result<PathBuf> {
  let path = input.map(str::trim).filter(|p| !p.is_empty()).unwrap_or(default);
  a.workspace().resolve_path(path).ok_or_else(no_workspace)
}

/// Like [`resolve`], but refuses a path outside the workspace folder.
fn resolve_inside(a: &Assistant, input: Option<&str>, default: &str) -> Result<PathBuf> {
  let path = resolve(a, input, default)?;
  let root = a.workspace().root().map(Path::to_path_buf).ok_or_else(no_workspace)?;
  if !path.starts_with(&root) {
    return Err(CoreError::Invalid("Invalid path: must be within the workspace folder.".into()));
  }
  Ok(path)
}

/// The optional `env` argument, without the screen default: blank means every environment.
fn env_or_all(args: &serde_json::Value) -> Option<String> {
  Args(args).str("env").map(str::to_string)
}

pub fn tools() -> Vec<Tool> {
  let env = json!({ "type": "string", "description": "ThingWorx environment name from Settings. Default: the one on screen, else the first enabled." });
  let env_all = json!({ "type": "string", "description": "ThingWorx environment name from Settings. Blank for projects in every environment." });
  let project = json!({ "type": "string", "description": "Project name or alias to limit the run to. Blank for every configured project." });
  let dry_run =
    json!({ "type": "boolean", "description": "Only report what would happen; write nothing. Default false." });
  let source =
    json!({ "type": "string", "description": "Local folder, relative to the workspace folder or absolute." });

  vec![
    tool(
      "deploy_export_entities",
      "Export the entities of each configured project from a ThingWorx server to local XML files (one per entity). Set \
       backup to write into a timestamped folder under the workspace backup folder instead of output. Returns counts, \
       errors and the last 100 progress lines.",
      schema(
        json!({
          "env": env,
          "project": project,
          "output": { "type": "string", "description": "Folder to write to. Default ./WindchillClients/ThingWorx." },
          "backup": { "type": "boolean", "description": "Write into a timestamped backup folder. Default false." },
          "dry_run": dry_run,
        }),
        &[],
      ),
      Risk::Write,
      |a, args, _| async move {
        let x = Args(&args);
        let pool = a.pool().await;
        let env = twx::resolve_env(&a, &args).await?;
        let client = projects::connect(&pool, &env).await?;
        let selected = projects::selected_projects(&pool, Some(&env), x.str("project")).await?;
        let log = Log::default();
        let output = if x.bool("backup").unwrap_or(false) {
          let dir = a.workspace().resolve(PathKind::Backup).ok_or_else(no_workspace)?;
          let dir = dir.join(stamp::iso_now().replace([':', '.'], "-"));
          log.push(format!("Backup mode: exporting to {}", dir.display()));
          dir
        } else {
          resolve(&a, x.str("output"), "./WindchillClients/ThingWorx")?
        };
        let result = export::run(
          &client,
          &selected,
          &output,
          x.bool("dry_run").unwrap_or(false),
          &CancellationToken::new(),
          &mut |line: String| log.push(line),
        )
        .await?;
        report(&result, &log)
      },
    ),
    tool(
      "deploy_export_deployment_files",
      "Download each project from a ThingWorx server as a deployment ZIP into a local folder, one subfolder per run. \
       Returns counts, errors and the last 100 progress lines.",
      schema(
        json!({
          "env": env,
          "project": project,
          "output": { "type": "string", "description": "Local folder for the runs. Default ./export." },
          "parent": { "type": "string", "description": "Name of this run's folder. Default: a UTC timestamp." },
          "suffix": { "type": "string", "description": "Text appended to each project's folder name." },
          "dry_run": dry_run,
        }),
        &[],
      ),
      Risk::Write,
      |a, args, _| async move {
        let x = Args(&args);
        let pool = a.pool().await;
        let env = twx::resolve_env(&a, &args).await?;
        let client = projects::connect(&pool, &env).await?;
        let selected = projects::selected_projects(&pool, Some(&env), x.str("project")).await?;
        let output = resolve(&a, x.str("output"), "./export")?;
        let parent = x.str("parent").map_or_else(stamp::compact_now, str::to_string);
        if parent.split(['/', '\\']).any(|s| s == "..") {
          return Err(CoreError::Invalid("Folder name must not contain \"..\".".into()));
        }
        let log = Log::default();
        let result = deployment::export(
          &client,
          &selected,
          &output,
          &parent,
          x.str("suffix"),
          x.bool("dry_run").unwrap_or(false),
          &CancellationToken::new(),
          &mut |line: String| log.push(line),
        )
        .await?;
        report(&result, &log)
      },
    ),
    tool(
      "deploy_extract_deployment_files",
      "Turn deployment ZIPs in a local folder (made by deploy_export_deployment_files) into formatted entity XML under \
       the output folder. Returns counts and the last 100 progress lines.",
      schema(
        json!({
          "env": env_all,
          "project": project,
          "input": { "type": "string", "description": "Folder holding one folder per project. Default ./export." },
          "output": { "type": "string", "description": "Folder to write the XML to. Default ./WindchillClients/ThingWorx." },
          "dry_run": dry_run,
        }),
        &[],
      ),
      Risk::Write,
      |a, args, _| async move {
        let x = Args(&args);
        let projects =
          projects::selected_projects(&a.pool().await, env_or_all(&args).as_deref(), x.str("project")).await?;
        let input = resolve(&a, x.str("input"), "./export")?;
        let output = resolve(&a, x.str("output"), "./WindchillClients/ThingWorx")?;
        let dry = x.bool("dry_run").unwrap_or(false);
        let log = Log::default();
        let sink = log.clone();
        let result = blocking(move || {
          deployment::extract(&projects, &input, &output, dry, &CancellationToken::new(), &mut |line: String| {
            sink.push(line)
          })
        })
        .await?;
        report(&result, &log)
      },
    ),
    tool(
      "deploy_backup_deployment_files",
      "Back projects up on the ThingWorx server itself, into SystemRepository/<parent>. Nothing is downloaded. Format \
       entities keeps XML folders; zip keeps one ZIP per project. The user approves each call.",
      schema(
        json!({
          "env": env,
          "project": project,
          "parent": { "type": "string", "description": "SystemRepository folder that holds the backups, e.g. \"/Backup_1\"." },
          "suffix": { "type": "string", "description": "Text appended to each project's folder name." },
          "format": { "type": "string", "enum": ["entities", "zip"], "description": "Default entities." },
          "dry_run": dry_run,
        }),
        &["parent"],
      ),
      Risk::Destructive,
      |a, args, _| async move {
        let x = Args(&args);
        let pool = a.pool().await;
        let env = twx::resolve_env(&a, &args).await?;
        let client = projects::connect(&pool, &env).await?;
        let selected = projects::selected_projects(&pool, Some(&env), x.str("project")).await?;
        let format = match x.str("format") {
          None | Some("entities") => BackupFormat::Entities,
          Some("zip") => BackupFormat::Zip,
          Some(other) => return Err(CoreError::Invalid(format!("Unknown backup format \"{other}\"."))),
        };
        let log = Log::default();
        let result = deployment::backup(
          &client,
          &selected,
          x.need("parent")?,
          x.str("suffix"),
          format,
          x.bool("dry_run").unwrap_or(false),
          &CancellationToken::new(),
          &mut |line: String| log.push(line),
        )
        .await?;
        report(&result, &log)
      },
    ),
    tool(
      "deploy_upload_deployment_files",
      "Upload a local folder into SystemRepository on the ThingWorx server. Options: extract unpacks uploaded ZIPs on \
       the server, extractSubfolder puts each ZIP's contents in a folder of its own, deleteZip removes the ZIPs after. \
       The user approves each call.",
      schema(
        json!({
          "env": env,
          "source": source,
          "target": { "type": "string", "description": "SystemRepository folder, e.g. \"/Deploy/RC1\"." },
          "extract": { "type": "boolean", "description": "Extract uploaded ZIPs on the server. Default false." },
          "extractSubfolder": { "type": "boolean", "description": "Extract each ZIP into a folder named after it. Default false." },
          "deleteZip": { "type": "boolean", "description": "Delete each ZIP after extracting it. Default false." },
          "dryRun": dry_run,
        }),
        &["source", "target"],
      ),
      Risk::Destructive,
      |a, args, _| async move {
        let x = Args(&args);
        let local = resolve(&a, Some(x.need("source")?), "")?;
        let options: UploadOptions = serde_json::from_value(args.clone())
          .map_err(|e| CoreError::Invalid(format!("Upload options are not valid: {e}")))?;
        let client = twx::client(&a, &args).await?;
        let log = Log::default();
        let result = deployment::upload(
          &client,
          &local,
          x.need("target")?,
          options,
          &CancellationToken::new(),
          &mut |line: String| log.push(line),
        )
        .await?;
        report(&result, &log)
      },
    ),
    tool(
      "deploy_list_repository_dirs",
      "Folders of SystemRepository on a ThingWorx server at a path (default \"/\"). Use it to pick a target before an \
       upload or backup.",
      schema(
        json!({
          "env": env,
          "path": { "type": "string", "description": "SystemRepository folder, e.g. \"/Deploy\". Default \"/\"." },
        }),
        &[],
      ),
      Risk::Read,
      |a, args, _| async move {
        let current = deployment::normalize_repository_dir(Args(&args).str("path").unwrap_or("/"));
        let client = twx::client(&a, &args).await?;
        let entries = client.list_repository_directories(deployment::REPOSITORY, &current).await?;
        ser(&json!({ "entries": entries, "currentPath": current }))
      },
    ),
    tool(
      "deploy_list_connectors",
      "Integration connectors (name, ThingTemplate, endpoint URLs and usernames) in a local entity folder. Use it \
       before deploy_update_connectors.",
      schema(json!({ "source": source }), &["source"]),
      Risk::Read,
      |a, args, _| async move {
        let dir = resolve(&a, Some(Args(&args).need("source")?), "")?;
        ser(&blocking(move || connectors::scan(&dir)).await?)
      },
    ),
    tool(
      "deploy_update_connectors",
      "Copy a local entity folder to another folder and rewrite connector endpoints in the copy. Each update maps old \
       origins to new ones (urlMap) and may set the username. clean_dest empties the destination first and is only \
       allowed for a subfolder of the workspace. The user approves each call.",
      schema(
        json!({
          "source": source,
          "dest": { "type": "string", "description": "Destination folder. Relative paths resolve against the workspace folder." },
          "updates": {
            "type": "array",
            "description": "Connector files to change.",
            "items": {
              "type": "object",
              "properties": {
                "relPath": { "type": "string", "description": "Path of the connector file, relative to the source folder." },
                "urlMap": { "type": "object", "additionalProperties": { "type": "string" }, "description": "Old origin to new origin, e.g. {\"https://old:8443\": \"https://new:8443\"}." },
                "username": { "type": ["string", "null"], "description": "New AuthUsername, or null to leave it." },
              },
              "required": ["relPath"],
            },
          },
          "clean_dest": { "type": "boolean", "description": "Empty the destination first. Default false." },
          "dry_run": dry_run,
        }),
        &["source", "dest"],
      ),
      Risk::Destructive,
      |a, args, _| async move {
        let x = Args(&args);
        let src = resolve(&a, Some(x.need("source")?), "")?;
        let dest = resolve(&a, Some(x.need("dest")?), "")?;
        let clean = x.bool("clean_dest").unwrap_or(false);
        if clean {
          // Clearing deletes a whole folder, so only a subfolder of the workspace qualifies.
          let root = a.workspace().root().map(Path::to_path_buf).ok_or_else(no_workspace)?;
          if dest == root || !dest.starts_with(&root) {
            return Err(CoreError::Invalid("\"clean_dest\" is only allowed for a folder inside the workspace.".into()));
          }
        }
        let updates: Vec<ConnectorUpdate> =
          serde_json::from_value(args.get("updates").cloned().unwrap_or_else(|| json!([])))
            .map_err(|e| CoreError::Invalid(format!("\"updates\" is not valid: {e}")))?;
        let dry = x.bool("dry_run").unwrap_or(false);
        let log = Log::default();
        let sink = log.clone();
        let result = blocking(move || {
          connectors::run_update(&src, &dest, &updates, clean, dry, &CancellationToken::new(), &mut |line: String| {
            sink.push(line)
          })
        })
        .await?;
        report(&result, &log)
      },
    ),
    tool(
      "deploy_bundle_projects",
      "Pack the local source folder of each project alias into a ZIP in the bundle destination (twx-cli bundle). Blank \
       src and dest use the Settings bundle folders. Returns the result and the last 100 progress lines.",
      schema(
        json!({
          "env": env_all,
          "project": project,
          "src": { "type": "string", "description": "Source folder. Default: the Settings bundle source folder." },
          "dest": { "type": "string", "description": "Destination folder. Default: the Settings bundle destination folder." },
          "dry_run": dry_run,
        }),
        &[],
      ),
      Risk::Write,
      |a, args, _| async move {
        let x = Args(&args);
        let pool = a.pool().await;
        let settings = db::settings::get(&pool).await?;
        let src = resolve_inside(&a, x.str("src"), &settings.bundle_src_dir)?;
        let dest = resolve_inside(&a, x.str("dest"), &settings.bundle_dest_dir)?;
        let projects = projects::deploy_projects(&pool, env_or_all(&args).as_deref()).await?;
        if projects.is_empty() {
          return Err(CoreError::Invalid(
            "No projects found in database. Configure projects in Settings first.".into(),
          ));
        }
        let filter = x.str("project").map(str::to_string);
        let dry = x.bool("dry_run").unwrap_or(false);
        let log = Log::default();
        let sink = log.clone();
        let result = blocking(move || {
          bundle::run(&projects, &src, &dest, filter.as_deref(), dry, &CancellationToken::new(), &mut |line: String| {
            sink.push(line)
          })
        })
        .await?;
        report(&result, &log)
      },
    ),
    tool(
      "deploy_extract_services",
      "Extract service code, mashup scripts and DataShape types from a project's WindchillClients/ThingWorx folder into \
       its Code/ folders (twx-cli extract). Give envName for a folder under twx-entities (also records the run), or \
       repoSlug for a repository clone. Run deploy_export_entities first.",
      schema(
        json!({
          "envName": { "type": "string", "description": "Environment whose twx-entities folder to extract." },
          "repoSlug": { "type": "string", "description": "Repository clone folder name, e.g. from repo_get." },
        }),
        &[],
      ),
      Risk::Write,
      |a, args, _| async move {
        let x = Args(&args);
        let ws = a.workspace();
        let log = Log::default();
        let (dir, label, env) = if let Some(env) = x.str("envName") {
          let safe = run_times::safe_env(env);
          let dir = ws
            .resolve(PathKind::TwxEntities)
            .ok_or_else(no_workspace)?
            .join(&safe)
            .join("WindchillClients")
            .join("Thingworx");
          (dir, format!("twx-entities/{safe}"), Some(safe))
        } else if let Some(slug) = x.str("repoSlug") {
          let repo = files::safe_join(&ws.resolve(PathKind::Repo).ok_or_else(no_workspace)?, slug)?;
          let direct = repo.join("ThingWorx");
          let dir = if direct.is_dir() { direct } else { repo.join("WindchillClients").join("ThingWorx") };
          (dir, format!("repo/{slug}"), None)
        } else {
          return Err(CoreError::Invalid("Either envName or repoSlug is required.".into()));
        };
        if !dir.is_dir() {
          return Err(CoreError::NotFound(format!(
            "WindchillClients/ThingWorx not found in {label}. Run Export first."
          )));
        }
        let run_times_file = ws.resolve(PathKind::RunTimes).ok_or_else(no_workspace)?;

        let sink = log.clone();
        let result = blocking(move || {
          let mut push = |line: String| sink.push(line);
          push(format!("Running extract-services on {label}..."));
          let projects = extract_services::run(&dir, &CancellationToken::new(), &mut push)?;
          let extracted_at = match env {
            Some(env) => Some(run_times::record(&run_times_file, &env, run_times::RunKind::Extracted)?),
            None => None,
          };
          Ok(json!({ "projects": projects, "extractedAt": extracted_at }))
        })
        .await?;
        report(&result, &log)
      },
    ),
  ]
}
