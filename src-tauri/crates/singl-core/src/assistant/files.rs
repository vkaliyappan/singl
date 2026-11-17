//! `@` file mentions: fuzzy search over the workspace folder.
//!
//! Matches the query as a case-insensitive subsequence of the relative path,
//! scoring hits in the file name and at word starts higher, like an editor's
//! quick-open. Build output and dependency folders are skipped.

use std::path::Path;

use serde::Serialize;

/// Folders never searched.
const SKIP_DIRS: &[&str] = &[".git", "node_modules", "target", ".next", "out", ".turbo", ".cache", "__pycache__", ".venv"];
/// Stop walking after this many files, so a huge folder stays fast.
const MAX_SCANNED: usize = 60_000;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FileHit {
  /// Absolute path.
  pub path: String,
  /// Relative to the workspace, `/`-separated.
  pub relative: String,
  pub name: String,
  pub is_dir: bool,
}

/// Entries an attached folder's tree lists at most.
pub const TREE_LIMIT: usize = 400;

fn walk(root: &Path) -> impl Iterator<Item = walkdir::DirEntry> {
  walkdir::WalkDir::new(root)
    .sort_by_file_name()
    .into_iter()
    .filter_entry(|e| !(e.file_type().is_dir() && e.depth() > 0 && SKIP_DIRS.iter().any(|d| e.file_name() == *d)))
    .flatten()
}

/// A folder as an indented tree (`name/` for folders, file sizes), cut after `limit` entries.
pub fn tree(root: &Path, limit: usize) -> String {
  let mut out = String::new();
  let mut count = 0;
  let mut more = 0;
  for e in walk(root).filter(|e| e.depth() > 0) {
    if count >= limit {
      more += 1;
      continue;
    }
    count += 1;
    let indent = "  ".repeat(e.depth() - 1);
    let name = e.file_name().to_string_lossy();
    if e.file_type().is_dir() {
      out.push_str(&format!("{indent}{name}/\n"));
    } else {
      let size = e.metadata().map(|m| m.len()).unwrap_or(0);
      out.push_str(&format!("{indent}{name} ({})\n", human(size)));
    }
  }
  if more > 0 {
    out.push_str(&format!("… {more} more entries not listed (use fs_list_directory)\n"));
  }
  if out.is_empty() {
    out.push_str("(empty folder)\n");
  }
  out
}

pub fn human(bytes: u64) -> String {
  match bytes {
    b if b < 1024 => format!("{b} B"),
    b if b < 1024 * 1024 => format!("{:.1} KB", b as f64 / 1024.0),
    b => format!("{:.1} MB", b as f64 / 1024.0 / 1024.0),
  }
}

/// Score of `query` as a subsequence of `text` (both lowercase); `None` when it is not one.
fn score(query: &str, text: &str, name_start: usize) -> Option<i64> {
  let q: Vec<char> = query.chars().collect();
  let t: Vec<char> = text.chars().collect();
  let mut qi = 0;
  let mut total = 0i64;
  let mut prev: Option<usize> = None;
  for (i, c) in t.iter().enumerate() {
    if qi < q.len() && *c == q[qi] {
      let mut s = 1;
      if prev == Some(i.wrapping_sub(1)) {
        s += 5; // consecutive
      }
      if i == 0 || matches!(t[i - 1], '/' | '_' | '-' | '.' | ' ') {
        s += 4; // word start
      }
      if i >= name_start {
        s += 3; // in the file name
      }
      total += s;
      prev = Some(i);
      qi += 1;
    }
  }
  (qi == q.len()).then(|| total * 100 - t.len() as i64)
}

/// Best matches for `query` under `root`. An empty query lists recently changed files first.
pub fn search(root: &Path, query: &str, limit: usize) -> Vec<FileHit> {
  let query = query.trim().to_lowercase().replace('\\', "/");
  let mut scored: Vec<(i64, FileHit)> = Vec::new();
  for entry in walk(root).filter(|e| e.depth() > 0).take(MAX_SCANNED) {
    let Ok(rel) = entry.path().strip_prefix(root) else { continue };
    let relative = rel.to_string_lossy().replace('\\', "/");
    let lower = relative.to_lowercase();
    let name_start = lower.rfind('/').map(|i| i + 1).unwrap_or(0);
    let s = if query.is_empty() {
      // Newest first: seconds since the epoch.
      entry.metadata().ok().and_then(|m| m.modified().ok()).and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_secs() as i64).unwrap_or(0)
    } else {
      match score(&query, &lower, name_start) {
        Some(s) => s,
        None => continue,
      }
    };
    scored.push((
      s,
      FileHit {
        path: entry.path().display().to_string(),
        name: entry.file_name().to_string_lossy().into_owned(),
        is_dir: entry.file_type().is_dir(),
        relative,
      },
    ));
  }
  scored.sort_by(|a, b| b.0.cmp(&a.0));
  scored.into_iter().take(limit).map(|(_, h)| h).collect()
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn ranks_name_matches_and_skips_build_dirs() {
    let dir = tempfile::tempdir().unwrap();
    for f in ["src/GetData.js", "src/other/data_util.js", "node_modules/x/GetData.js", "docs/readme.md"] {
      let p = dir.path().join(f);
      std::fs::create_dir_all(p.parent().unwrap()).unwrap();
      std::fs::write(p, "x").unwrap();
    }
    let hits = search(dir.path(), "getdata", 10);
    assert_eq!(hits[0].relative, "src/GetData.js");
    assert!(hits.iter().all(|h| !h.relative.starts_with("node_modules")));
    assert!(search(dir.path(), "zzz", 10).is_empty());
    // 3 files + src/, src/other/, docs/
    assert_eq!(search(dir.path(), "", 10).len(), 6);
    assert!(search(dir.path(), "other", 10).iter().any(|h| h.is_dir && h.relative == "src/other"));
    let t = tree(dir.path(), 400);
    assert!(t.contains("src/") && t.contains("  GetData.js") && !t.contains("node_modules"));
  }
}
