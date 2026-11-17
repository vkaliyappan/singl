//! Assistant tools: compare. The Compare page: the repository clone (left)
//! against an environment's exported entities (right), as a tree, per file,
//! and by text search. Read only.
//!
//! Left is `<workspace>/repo/<slug>/<repo subpath>`, right is
//! `<workspace>/twx-entities/<env>/<TWX root prefix>`; the subpath and prefix
//! come from Settings. Paths are relative to both roots.

use std::path::{Path, PathBuf};

use serde_json::{Value, json};

use super::{Args, Risk, Tool, schema, ser, tool, twx};
use crate::assistant::Assistant;
use crate::compare::{self, SearchResults};
use crate::db;
use crate::repo::files::{SearchOptions, safe_join};
use crate::twx::run_times::safe_env;
use crate::workspace::PathKind;
use crate::{CoreError, Result};

struct Roots {
  workspace: PathBuf,
  left: PathBuf,
  right: PathBuf,
}

/// The two roots for `env`, as the Compare page resolves them.
async fn roots(a: &Assistant, args: &Value) -> Result<Roots> {
  let env = twx::resolve_env(a, args).await?;
  let workspace = a.workspace();
  let (Some(root), Some(repos), Some(entities)) =
    (workspace.root(), workspace.resolve(PathKind::Repo), workspace.resolve(PathKind::TwxEntities))
  else {
    return Err(CoreError::Invalid("No workspace folder is set. Choose one in Settings.".into()));
  };

  let pool = a.pool().await;
  let repo = db::repo::get(&pool, 1).await?;
  if repo.repo_slug.is_empty() {
    return Err(CoreError::Invalid("No repository configured. Clone a repo first.".into()));
  }
  let app = db::settings::get(&pool).await?;
  let left = safe_join(&safe_join(&repos, &repo.repo_slug)?, &app.repo_root_subpath)
    .map_err(|_| CoreError::Invalid("Invalid repo subpath".into()))?;
  let right = safe_join(&entities.join(safe_env(&env)), &app.twx_root_prefix)
    .map_err(|_| CoreError::Invalid("Invalid TWX root prefix".into()))?;
  Ok(Roots { workspace: root.to_path_buf(), left, right })
}

/// Relative to the workspace and `/`-separated, for messages.
fn shown(workspace: &Path, path: &Path) -> String {
  path.strip_prefix(workspace).unwrap_or(path).to_string_lossy().replace('\\', "/")
}

fn blocking_failed(e: tokio::task::JoinError) -> CoreError {
  CoreError::Io(std::io::Error::other(e.to_string()))
}

pub fn tools() -> Vec<Tool> {
  let env = || json!({ "type": "string", "description": "Environment name from Settings. Default: the one on screen, else the first enabled." });
  let flag = |desc: &str| json!({ "type": "boolean", "description": desc });

  vec![
    tool(
      "compare_tree",
      "The repository and the exported TWX entities merged into one tree, each node marked as only on one side, on both and different, with a summary. Use it first to see what differs between the code and the server export.",
      schema(json!({ "env": env() }), &[]),
      Risk::Read,
      |a, args, _| async move {
        let Roots { workspace, left, right } = roots(&a, &args).await?;
        if !left.is_dir() {
          return Err(CoreError::NotFound(format!("Repository path not found: {}", shown(&workspace, &left))));
        }
        if !right.is_dir() {
          return Err(CoreError::NotFound(
            "No TWX entities found for this environment. Pull entities from the server first.".into(),
          ));
        }
        let (left_root, right_root) = (shown(&workspace, &left), shown(&workspace, &right));
        let tree =
          tokio::task::spawn_blocking(move || compare::merge_trees(&left, &right)).await.map_err(blocking_failed)?;
        ser(&json!({ "leftRoot": left_root, "rightRoot": right_root, "tree": tree }))
      },
    ),
    tool(
      "compare_content",
      "Both sides of one file from the repository and the exported entities, normalised for diffing (line ends, trailing spaces). Use it after compare_tree to see the actual difference in a file.",
      schema(
        json!({
          "env": env(),
          "path": { "type": "string", "description": "File path relative to both roots, as compare_tree shows it." },
        }),
        &["path"],
      ),
      Risk::Read,
      |a, args, _| async move {
        let path = Args(&args).need("path")?;
        let Roots { left, right, .. } = roots(&a, &args).await?;
        let (left, right) = (safe_join(&left, path)?, safe_join(&right, path)?);
        ser(&json!({
          "left": tokio::task::spawn_blocking(move || compare::read_side(&left)).await.map_err(blocking_failed)?,
          "right": tokio::task::spawn_blocking(move || compare::read_side(&right)).await.map_err(blocking_failed)?,
        }))
      },
    ),
    tool(
      "compare_search",
      "Text search in both the repository and the exported entities. A file found on both sides is reported once, from the repository. Use it to find where a name or snippet lives on either side.",
      schema(
        json!({
          "env": env(),
          "query": { "type": "string", "description": "Text to find." },
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
        let query = x.need("query")?.to_string();
        let opts = SearchOptions {
          case_sensitive: x.bool("caseSensitive").unwrap_or(false),
          whole_word: x.bool("wholeWord").unwrap_or(false),
          use_regex: x.bool("useRegex").unwrap_or(false),
          match_filename: x.bool("matchFilename").unwrap_or(false),
        };
        let Roots { left, right, .. } = roots(&a, &args).await?;
        let results: SearchResults = tokio::task::spawn_blocking(move || compare::search(&left, &right, &query, opts))
          .await
          .map_err(blocking_failed)??;
        ser(&results)
      },
    ),
  ]
}
