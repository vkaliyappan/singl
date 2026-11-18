//! Import entity XML files from the workspace's twx-entities folder into a
//! ThingWorx server, with a diff-before-import preview and a backup first.

use serde_json::{Value, json};

use super::twx::{client, resolve_env};
use super::{Args, Risk, Tool, schema, ser, tool};
use crate::twx::import::{self, PreviewItem};
use crate::workspace::PathKind;
use crate::CoreError;

fn no_workspace() -> CoreError {
  CoreError::Invalid("No workspace folder is set. Choose one in Settings.".into())
}

/// The preview without the XML, which would flood the conversation.
fn summary(items: &[PreviewItem]) -> Value {
  let status = |i: &PreviewItem| match (i.error.is_some(), i.exists_on_server, i.changed) {
    (true, _, _) => "error",
    (_, false, _) => "new",
    (_, _, true) => "changed",
    _ => "unchanged",
  };
  json!(items
    .iter()
    .map(|i| json!({ "path": i.path, "type": i.entity_type, "name": i.name, "status": status(i), "error": i.error }))
    .collect::<Vec<_>>())
}

pub fn tools() -> Vec<Tool> {
  let env = json!({ "type": "string", "description": "Environment name from Settings. Default: the one on screen, else the first enabled." });
  let files = json!({
    "type": "array",
    "items": { "type": "string" },
    "description": "Entity XML paths relative to <workspace>/twx-entities, e.g. \"DEV/WindchillClients/Thingworx/alias/Project/Things/My.Thing.xml\"."
  });

  vec![
    tool(
      "twx_import_preview",
      "Compares local entity XML files with what the ThingWorx server has now. Returns per file: type, name, status (new, changed, unchanged, error). Changes nothing.",
      schema(json!({ "env": env, "files": files }), &["files"]),
      Risk::Read,
      |a, args, _| async move {
        let c = client(&a, &args).await?;
        let base = a.workspace().resolve(PathKind::TwxEntities).ok_or_else(no_workspace)?;
        let sources = import::read_sources(&base, &Args(&args).strings("files"))?;
        ser(&summary(&import::preview(&c, &sources).await))
      },
    ),
    tool(
      "twx_import_entities",
      "IMPORTS local entity XML files into a ThingWorx server, overwriting those entities. Current server versions are first saved to <workspace>/twx-backups/<env>/<timestamp>. Use dryRun=true to only preview. Returns per-file success or error and the backup folder.",
      schema(
        json!({ "env": env, "files": files, "dryRun": { "type": "boolean", "description": "Only preview; import nothing. Default false." } }),
        &["files"],
      ),
      Risk::Destructive,
      |a, args, _| async move {
        let env = resolve_env(&a, &args).await?;
        let c = client(&a, &args).await?;
        let workspace = a.workspace();
        let base = workspace.resolve(PathKind::TwxEntities).ok_or_else(no_workspace)?;
        let root = workspace.root().ok_or_else(no_workspace)?.to_path_buf();
        let sources = import::read_sources(&base, &Args(&args).strings("files"))?;
        if Args(&args).bool("dryRun").unwrap_or(false) {
          return ser(&json!({ "dryRun": true, "environment": env, "files": summary(&import::preview(&c, &sources).await) }));
        }
        let result = import::import(&c, &env, &sources, &root, &mut |_| {}).await?;
        ser(&json!({ "environment": env, "result": result }))
      },
    ),
  ]
}
