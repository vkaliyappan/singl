//! Assistant tools: repo. The two repository pages: slot 1 is TWX, slot 2 is
//! Windchill. Each keeps its own clone under the workspace's `repo` folder.
//! Each tool calls the same singl-core function as `src-tauri/src/commands/repo.rs`.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use serde_json::json;
use tokio_util::sync::CancellationToken;

use super::{Args, Risk, Tool, schema, ser, tool};
use crate::assistant::Assistant;
use crate::db::{self, repo::RepoState};
use crate::repo::files::{self, SearchOptions};
use crate::repo::git::{self, Auth};
use crate::workspace::PathKind;
use crate::{CoreError, Result};

const SLOTS: i64 = 2;
/// Most files a search reports; the rest are counted, not listed.
const SEARCH_FILE_LIMIT: usize = 200;

/// Git output collected for a tool result; the last 100 lines are reported.
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

fn join_err(e: impl std::fmt::Display) -> CoreError {
  CoreError::Io(std::io::Error::other(e.to_string()))
}

/// The slot argument: 1 (TWX, the default) or 2 (Windchill).
fn slot_arg(args: &serde_json::Value) -> Result<i64> {
  match Args(args).i64("slot").unwrap_or(1) {
    s @ 1..=SLOTS => Ok(s),
    s => Err(CoreError::Invalid(format!("Unknown repository slot {s}. Use 1 (TWX) or 2 (Windchill)."))),
  }
}

fn repos_dir(a: &Assistant) -> Result<PathBuf> {
  a.workspace()
    .resolve(PathKind::Repo)
    .ok_or_else(|| CoreError::Invalid("No workspace folder is set. Choose one in Settings.".into()))
}

/// The slot's saved repository, its clone folder, and credentials for its remote.
async fn current(a: &Assistant, slot: i64) -> Result<(RepoState, PathBuf, Auth)> {
  let pool = a.pool().await;
  let repo = db::repo::get(&pool, slot).await?;
  if repo.repo_slug.is_empty() {
    return Err(CoreError::Invalid("No repository configured.".into()));
  }
  let path = files::safe_join(&repos_dir(a)?, &repo.repo_slug)?;
  let pat = db::settings::azure_pat_token(&pool).await?;
  let auth = Auth::new(&repo.repo_url, pat.as_deref());
  Ok((repo, path, auth))
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T> + Send + 'static) -> Result<T> {
  tokio::task::spawn_blocking(f).await.map_err(join_err)?
}

pub fn tools() -> Vec<Tool> {
  let slot = json!({
    "type": "integer", "enum": [1, 2],
    "description": "Repository page: 1 = TWX (default), 2 = Windchill.",
  });
  let file = json!({ "type": "string", "description": "Path relative to the clone, forward slashes." });
  let repo_url = json!({ "type": "string", "description": "Git remote URL of the repository." });
  let branch = json!({ "type": "string", "description": "Branch name, e.g. \"main\"." });

  vec![
    tool(
      "repo_get",
      "The saved repository for a repository page: its remote URL, cloned branch and clone folder name. Returns \
       empty fields when nothing is cloned yet.",
      schema(json!({ "slot": slot }), &[]),
      Risk::Read,
      |a, args, _| async move {
        let slot = slot_arg(&args)?;
        ser(&db::repo::get(&a.pool().await, slot).await?)
      },
    ),
    tool(
      "repo_branches",
      "Branch names on a git remote. Use it to find a branch before repo_clone or repo_checkout.",
      schema(json!({ "repoUrl": repo_url }), &["repoUrl"]),
      Risk::Read,
      |a, args, _| async move {
        let url = Args(&args).need("repoUrl")?;
        let pat = db::settings::azure_pat_token(&a.pool().await).await?;
        ser(&git::branches(url, &Auth::new(url, pat.as_deref())).await?)
      },
    ),
    tool(
      "repo_clone",
      "Clone one branch of a git repository into a repository page, replacing any earlier clone of that repo. Returns \
       the clone folder name and the last 100 git log lines. The user approves each call.",
      schema(json!({ "slot": slot, "repoUrl": repo_url, "branch": branch }), &["repoUrl", "branch"]),
      Risk::Destructive,
      |a, args, _| async move {
        let slot = slot_arg(&args)?;
        let x = Args(&args);
        let url = x.need("repoUrl")?;
        let branch = x.need("branch")?;
        let slug = git::slug(url);
        let dest = files::safe_join(&repos_dir(&a)?, &slug)?;
        let pool = a.pool().await;
        // Both pages clone under the same folder, so one repo can't sit in two pages.
        for other in (1..=SLOTS).filter(|&s| s != slot) {
          if db::repo::get(&pool, other).await?.repo_slug == slug {
            return Err(CoreError::Invalid(format!(
              "\"{slug}\" is already cloned in the other repository page (TWX / Windchill). Use it there."
            )));
          }
        }
        let pat = db::settings::azure_pat_token(&pool).await?;
        let log = Log::default();
        git::clone(
          &dest,
          url,
          branch,
          &Auth::new(url, pat.as_deref()),
          &CancellationToken::new(),
          &mut |line: String| log.push(line),
        )
        .await?;
        db::repo::save(&pool, slot, url, branch, &slug).await?;
        ser(&json!({ "slug": slug, "log": log.tail() }))
      },
    ),
    tool(
      "repo_checkout",
      "Fetch a branch of the repository on a repository page and switch the clone to it. Returns the last 100 git \
       log lines.",
      schema(json!({ "slot": slot, "branch": branch }), &["branch"]),
      Risk::Write,
      |a, args, _| async move {
        let slot = slot_arg(&args)?;
        let branch = Args(&args).need("branch")?;
        let (repo, path, auth) = current(&a, slot).await?;
        let log = Log::default();
        git::checkout(&path, &repo.repo_url, branch, &auth, &CancellationToken::new(), &mut |line: String| {
          log.push(line)
        })
        .await?;
        db::repo::set_branch(&a.pool().await, slot, branch).await?;
        ser(&json!({ "branch": branch, "log": log.tail() }))
      },
    ),
    tool(
      "repo_fetch",
      "Fetch the latest commits from the remote for a repository page without changing the clone's files. Returns \
       the last 100 git log lines.",
      schema(json!({ "slot": slot }), &[]),
      Risk::Write,
      |a, args, _| async move {
        let (repo, path, auth) = current(&a, slot_arg(&args)?).await?;
        let log = Log::default();
        git::fetch(&path, &repo.repo_url, &auth, &CancellationToken::new(), &mut |line: String| log.push(line)).await?;
        ser(&json!({ "log": log.tail() }))
      },
    ),
    tool(
      "repo_pull",
      "Pull the latest commits into the clone of a repository page. Returns git's summary line (e.g. \"Already up to \
       date.\") and the last 100 git log lines. The user approves each call.",
      schema(json!({ "slot": slot }), &[]),
      Risk::Destructive,
      |a, args, _| async move {
        let (repo, path, auth) = current(&a, slot_arg(&args)?).await?;
        let log = Log::default();
        let summary =
          git::pull(&path, &repo.repo_url, &auth, &CancellationToken::new(), &mut |line: String| log.push(line))
            .await?;
        ser(&json!({ "summary": summary, "log": log.tail() }))
      },
    ),
    tool(
      "repo_status",
      "Files changed in the clone of a repository page compared with HEAD, each with its change kind.",
      schema(json!({ "slot": slot }), &[]),
      Risk::Read,
      |a, args, _| async move {
        let (_, path, _) = current(&a, slot_arg(&args)?).await?;
        ser(&git::status(&path).await?)
      },
    ),
    tool(
      "repo_diff",
      "The diff of one file in the clone of a repository page against HEAD: its original and modified text.",
      schema(json!({ "slot": slot, "file": file }), &["file"]),
      Risk::Read,
      |a, args, _| async move {
        let (_, path, _) = current(&a, slot_arg(&args)?).await?;
        ser(&git::diff(&path, Args(&args).need("file")?).await?)
      },
    ),
    tool(
      "repo_files",
      "Every file path in the clone of a repository page. Use repo_search to find text inside them.",
      schema(json!({ "slot": slot }), &[]),
      Risk::Read,
      |a, args, _| async move {
        let (_, path, _) = current(&a, slot_arg(&args)?).await?;
        ser(&blocking(move || files::list_paths(&path)).await?)
      },
    ),
    tool(
      "repo_file_content",
      "The text of one file in the clone of a repository page (files over 1 MB are refused).",
      schema(json!({ "slot": slot, "path": file }), &["path"]),
      Risk::Read,
      |a, args, _| async move {
        let slot = slot_arg(&args)?;
        let (_, root, _) = current(&a, slot).await?;
        let rel = Args(&args).need("path")?.to_string();
        blocking(move || files::read_text(&files::safe_join(&root, &rel)?)).await
      },
    ),
    tool(
      "repo_search",
      "Search the text (or file names) of the clone of a repository page. Returns matches grouped by file, up to 200 \
       files; a count tells how many files matched in all.",
      schema(
        json!({
          "slot": slot,
          "query": { "type": "string", "description": "Text or regular expression to find." },
          "options": {
            "type": "object",
            "description": "Booleans, all default false: caseSensitive, wholeWord, useRegex, matchFilename.",
          },
        }),
        &["query"],
      ),
      Risk::Read,
      |a, args, _| async move {
        let slot = slot_arg(&args)?;
        let x = Args(&args);
        let query = x.need("query")?.to_string();
        let options: SearchOptions = serde_json::from_value(x.object("options")?)
          .map_err(|e| CoreError::Invalid(format!("\"options\" is not valid: {e}")))?;
        let (_, root, _) = current(&a, slot).await?;
        let mut results = blocking(move || files::search(&root, &query, options)).await?;
        let total = results.len();
        results.truncate(SEARCH_FILE_LIMIT);
        ser(&json!({ "filesMatched": total, "files": results }))
      },
    ),
    tool(
      "repo_clean",
      "Delete the `Code/` folders that Extract generated in the clone of a repository page. Returns how many projects \
       were cleared. The user approves each call.",
      schema(json!({ "slot": slot }), &[]),
      Risk::Destructive,
      |a, args, _| async move {
        let (_, path, _) = current(&a, slot_arg(&args)?).await?;
        let cleared = blocking(move || files::clean_extracted(&path)).await?;
        ser(&json!({ "projectsCleared": cleared }))
      },
    ),
  ]
}
