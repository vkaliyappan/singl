//! Assistant tools: long-term memory across chats (see [`memory`]). The model
//! decides what to keep; the current list is in its system prompt, so there is
//! no list tool. These run without asking: they only change the assistant's own
//! notes, which the user can review in Settings → AI.

use serde_json::json;

use super::{Args, Risk, Tool, schema, ser, tool};
use crate::assistant::memory;

pub fn tools() -> Vec<Tool> {
  vec![
    tool(
      "memory_save",
      "Save one durable fact to your long-term memory, so later chats know it (it joins every system prompt under \"Memory\"). \
       For user corrections and preferences, facts about their servers, projects and entities that took effort to find, and pitfalls. \
       One short self-contained fact; update an existing memory instead of saving a near-duplicate. Never save secrets.",
      schema(json!({ "text": { "type": "string", "description": "The fact, at most 1000 characters." } }), &["text"]),
      Risk::Read,
      |a, args, _| async move { ser(&memory::add(&a.pool().await, Args(&args).need("text")?).await?) },
    ),
    tool(
      "memory_update",
      "Rewrite one memory (id from the \"Memory\" section of your system prompt), e.g. when it is out of date or to merge related ones.",
      schema(
        json!({
          "id": { "type": "string", "description": "The memory's id." },
          "text": { "type": "string", "description": "The new text, at most 1000 characters." },
        }),
        &["id", "text"],
      ),
      Risk::Read,
      |a, args, _| async move {
        let x = Args(&args);
        ser(&memory::update(&a.pool().await, x.need("id")?, x.need("text")?).await?)
      },
    ),
    tool(
      "memory_delete",
      "Remove one memory that is wrong, stale or no longer useful (id from the \"Memory\" section of your system prompt).",
      schema(json!({ "id": { "type": "string", "description": "The memory's id." } }), &["id"]),
      Risk::Read,
      |a, args, _| async move {
        let id = Args(&args).need("id")?;
        memory::delete(&a.pool().await, id).await?;
        Ok(format!("Deleted memory {id}."))
      },
    ),
  ]
}
