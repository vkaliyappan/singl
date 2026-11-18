//! Assistant tools: undo for the local entity file changes. The changes are
//! saved by the entity tools before they run (see [`snapshots`]).

use serde_json::json;

use super::{Args, Risk, Tool, schema, ser, tool};
use crate::assistant::snapshots;

pub fn tools() -> Vec<Tool> {
  vec![
    tool(
      "entity_undo_list",
      "The local entity file changes the assistant made that can still be undone, newest first: each one's call id, chat, tool and the paths it changed (\"old -> new\" for a rename). Use it to find what entity_undo takes.",
      schema(
        json!({
          "chatId": { "type": "string", "description": "Only changes made in this chat." },
          "path": { "type": "string", "description": "Only changes that touched a path containing this text." },
          "limit": { "type": "integer", "description": "Most changes to list, 1 to 100. Default 20." },
        }),
        &[],
      ),
      Risk::Read,
      |a, args, _| async move {
        let x = Args(&args);
        let limit = x.i64("limit").unwrap_or(20).clamp(1, 100);
        ser(&snapshots::list(&a, x.str("chatId"), x.str("path"), limit).await?)
      },
    ),
    tool(
      "entity_undo",
      "Undo one local change to the exported entity files, by its snapshot id or tool call id (from entity_undo_list). The files go back as they were. Refuses if a file has changed since, so later hand edits are kept. Local only; the server is not changed. The undo can itself be undone with another entity_undo.",
      schema(json!({ "id": { "type": "string", "description": "The snapshot id or tool call id." } }), &["id"]),
      Risk::Write,
      |a, args, meta| async move {
        let id = Args(&args).need("id")?;
        snapshots::undo(&a, id, Some(&meta)).await
      },
    ),
  ]
}
