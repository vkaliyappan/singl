//! Assistant tools: reading files and folders.
//!
//! Read-only, and only inside the workspace folder or a folder the user
//! attached in the current chat; outside MCP clients get the workspace only.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde_json::json;

use super::{Args, CallMeta, Risk, Tool, schema, ser, tool};
use crate::assistant::types::Block;
use crate::assistant::{Assistant, files, store};
use crate::{CoreError, Result};

/// `fs_read_file` returns at most this much per call.
const READ_LIMIT: usize = 120_000;
const LIST_LIMIT: usize = 1_000;

fn norm(p: &Path) -> PathBuf {
  // Canonical when possible, so `..` and links cannot step outside a root.
  std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf())
}

/// Folders this call may read under.
async fn roots(a: &Arc<Assistant>, meta: &CallMeta) -> Vec<PathBuf> {
  let mut out: Vec<PathBuf> = a.workspace_root().into_iter().collect();
  if let Some(chat_id) = &meta.chat_id {
    if let Ok(chat) = store::get(&a.pool().await, chat_id).await {
      for m in &chat.messages {
        for b in &m.blocks {
          if let Block::Attachment { path, directory: true, .. } = b {
            out.push(PathBuf::from(path));
          }
        }
      }
    }
  }
  out.into_iter().map(|p| norm(&p)).collect()
}

/// `raw` resolved and checked against the allowed roots. Relative paths are
/// taken from the workspace folder.
async fn allowed(a: &Arc<Assistant>, meta: &CallMeta, raw: &str) -> Result<PathBuf> {
  let roots = roots(a, meta).await;
  let raw = Path::new(raw.trim());
  let path = if raw.is_absolute() {
    raw.to_path_buf()
  } else {
    a.workspace_root().ok_or_else(|| CoreError::Invalid("No workspace folder is set; use an absolute path.".into()))?.join(raw)
  };
  let path = norm(&path);
  if roots.iter().any(|r| path.starts_with(r)) {
    Ok(path)
  } else {
    Err(CoreError::Invalid(format!(
      "{} is outside the workspace folder and the folders attached in this chat.",
      path.display()
    )))
  }
}

pub fn tools() -> Vec<Tool> {
  let path = json!({ "type": "string", "description": "Absolute path, or relative to the workspace folder." });
  vec![
    tool(
      "fs_list_directory",
      "List a folder (one level, or a tree with depth > 1): names, folders marked with /, file sizes. \
       Works inside the workspace folder and folders the user attached.",
      schema(
        json!({ "path": path, "depth": { "type": "integer", "description": "Levels to show, 1-6. Default 1." } }),
        &["path"],
      ),
      Risk::Read,
      |a, args, meta| async move {
        let x = Args(&args);
        let dir = allowed(&a, &meta, x.need("path")?).await?;
        if !dir.is_dir() {
          return Err(CoreError::Invalid(format!("{} is not a folder.", dir.display())));
        }
        let depth = x.i64("depth").unwrap_or(1).clamp(1, 6) as usize;
        if depth > 1 {
          return Ok(files::tree(&dir, LIST_LIMIT));
        }
        let mut rows: Vec<(bool, String, u64)> = std::fs::read_dir(&dir)?
          .flatten()
          .map(|e| {
            let m = e.metadata().ok();
            (m.as_ref().is_some_and(|m| m.is_dir()), e.file_name().to_string_lossy().into_owned(), m.map(|m| m.len()).unwrap_or(0))
          })
          .collect();
        rows.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.to_lowercase().cmp(&b.1.to_lowercase())));
        let list: Vec<String> = rows
          .into_iter()
          .take(LIST_LIMIT)
          .map(|(is_dir, name, size)| if is_dir { format!("{name}/") } else { format!("{name} ({})", files::human(size)) })
          .collect();
        Ok(if list.is_empty() { "(empty folder)".into() } else { list.join("\n") })
      },
    ),
    tool(
      "fs_read_file",
      "Read a text file, optionally a line range. Works inside the workspace folder and folders the user attached.",
      schema(
        json!({
          "path": path,
          "offset": { "type": "integer", "description": "First line to return, 1-based. Default 1." },
          "limit": { "type": "integer", "description": "Number of lines. Default: the whole file (up to 120 KB)." },
        }),
        &["path"],
      ),
      Risk::Read,
      |a, args, meta| async move {
        let x = Args(&args);
        let file = allowed(&a, &meta, x.need("path")?).await?;
        if !file.is_file() {
          return Err(CoreError::Invalid(format!("{} is not a file.", file.display())));
        }
        let text = String::from_utf8(tokio::fs::read(&file).await?)
          .map_err(|_| CoreError::Invalid(format!("{} is not a text file.", file.display())))?;
        let offset = x.i64("offset").unwrap_or(1).max(1) as usize;
        let selected: String = match x.i64("limit") {
          Some(n) => text.lines().skip(offset - 1).take(n.max(1) as usize).collect::<Vec<_>>().join("\n"),
          None if offset > 1 => text.lines().skip(offset - 1).collect::<Vec<_>>().join("\n"),
          None => text,
        };
        Ok(crate::assistant::context::clip(&selected, READ_LIMIT))
      },
    ),
    tool(
      "fs_search_files",
      "Find files and folders in the workspace by fuzzy name/path match (like an editor's quick-open).",
      schema(
        json!({
          "query": { "type": "string", "description": "Part of a file or folder name or path." },
          "limit": { "type": "integer", "description": "Default 30." },
        }),
        &["query"],
      ),
      Risk::Read,
      |a, args, _| async move {
        let x = Args(&args);
        let root = a.workspace_root().ok_or_else(|| CoreError::Invalid("No workspace folder is set.".into()))?;
        let query = x.need("query")?.to_string();
        let limit = x.i64("limit").unwrap_or(30).clamp(1, 200) as usize;
        let hits = tokio::task::spawn_blocking(move || files::search(&root, &query, limit)).await.unwrap_or_default();
        ser(&hits)
      },
    ),
  ]
}
