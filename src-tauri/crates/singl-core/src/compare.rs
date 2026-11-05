//! The Compare page: the repository clone (left) against an environment's
//! exported entities (right), file by file. Ported from singl-web's
//! `lib/compare/diff-tree.ts` and `/api/compare/*` routes.

use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};

use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::repo::files::{self, SearchFileResult, SearchOptions, normalize_text};
use crate::Result;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum NodeStatus {
  Added,
  Removed,
  Modified,
  Identical,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffNode {
  pub path: String,
  pub name: String,
  #[serde(rename = "type")]
  pub kind: &'static str,
  pub status: NodeStatus,
  pub left_exists: bool,
  pub right_exists: bool,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub left_size: Option<u64>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub right_size: Option<u64>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub children: Option<Vec<String>>,
}

#[derive(Debug, Default, Clone, Serialize)]
pub struct Summary {
  pub added: u32,
  pub removed: u32,
  pub modified: u32,
  pub identical: u32,
}

#[derive(Debug, Serialize)]
pub struct DiffTree {
  pub nodes: Vec<DiffNode>,
  pub summary: Summary,
}

const SKIP_DIRS: &[&str] = &[".git", "node_modules", ".next", ".turbo"];

const TEXT_EXTENSIONS: &[&str] = &[
  "js", "ts", "jsx", "tsx", "mjs", "cjs", "json", "jsonc", "xml", "html", "htm", "css", "scss", "sass", "less", "md",
  "mdx", "txt", "log", "sh", "bash", "ps1", "bat", "yaml", "yml", "toml", "ini", "env", "sql", "graphql", "gql", "py",
  "rb", "go", "rs", "java", "kt", "cs", "php", "swift", "scala", "c", "cpp", "h", "hpp", "vue", "svelte", "prisma",
  "dockerfile",
];

fn is_text_file(name: &str) -> bool {
  let name = name.to_lowercase();
  if matches!(name.as_str(), "dockerfile" | ".gitignore" | ".editorconfig") {
    return true;
  }
  TEXT_EXTENSIONS.contains(&name.rsplit('.').next().unwrap_or(""))
}

/// Hashes text normalised as Monaco's diff sees it with `ignoreTrimWhitespace`:
/// LF line ends, each line trimmed, no trailing blank lines. Other files as bytes.
fn hash(path: &Path) -> Option<String> {
  let data = std::fs::read(path).ok()?;
  let name = path.file_name()?.to_string_lossy();
  let digest = if is_text_file(&name) {
    let text = normalize_text(&String::from_utf8_lossy(&data));
    let lines: Vec<&str> = text.split('\n').map(str::trim).collect();
    Sha256::digest(lines.join("\n").trim_end().as_bytes())
  } else {
    Sha256::digest(&data)
  };
  Some(hex::encode(digest))
}

/// Every file and folder under `root`, by path relative to it.
fn walk(root: &Path) -> BTreeMap<String, (PathBuf, bool)> {
  fn recurse(dir: &Path, rel: &str, out: &mut BTreeMap<String, (PathBuf, bool)>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
      let name = entry.file_name().to_string_lossy().into_owned();
      if SKIP_DIRS.contains(&name.as_str()) {
        continue;
      }
      let rel = if rel.is_empty() { name } else { format!("{rel}/{name}") };
      let is_dir = entry.file_type().is_ok_and(|t| t.is_dir());
      if is_dir {
        recurse(&entry.path(), &rel, out);
      }
      out.insert(rel, (entry.path(), is_dir));
    }
  }
  let mut out = BTreeMap::new();
  recurse(root, "", &mut out);
  out
}

fn size(path: &Path) -> Option<u64> {
  std::fs::metadata(path).ok().map(|m| m.len())
}

/// Both trees merged: a node per path on either side, files marked by how
/// they differ, folders "modified" when anything below them differs.
pub fn merge_trees(left: &Path, right: &Path) -> DiffTree {
  let (left_map, right_map) = (walk(left), walk(right));
  let mut paths: Vec<&String> = left_map.keys().chain(right_map.keys()).collect();
  paths.sort();
  paths.dedup();

  let mut summary = Summary::default();
  let mut nodes: BTreeMap<String, DiffNode> = BTreeMap::new();
  for rel in paths {
    let (l, r) = (left_map.get(rel), right_map.get(rel));
    let name = rel.rsplit('/').next().unwrap_or(rel).to_string();
    let base = DiffNode {
      path: rel.clone(),
      name,
      kind: "file",
      status: NodeStatus::Identical,
      left_exists: l.is_some(),
      right_exists: r.is_some(),
      left_size: None,
      right_size: None,
      children: None,
    };
    let node = if l.is_some_and(|l| l.1) || r.is_some_and(|r| r.1) {
      DiffNode { kind: "dir", children: Some(Vec::new()), ..base }
    } else {
      let (left_size, right_size) = (l.and_then(|l| size(&l.0)), r.and_then(|r| size(&r.0)));
      let status = match (l, r) {
        // Sizes say nothing: line-end normalisation changes byte counts.
        (Some(l), Some(r)) if hash(&l.0) == hash(&r.0) => NodeStatus::Identical,
        (Some(_), Some(_)) => NodeStatus::Modified,
        (Some(_), None) => NodeStatus::Removed,
        _ => NodeStatus::Added,
      };
      match status {
        NodeStatus::Identical => summary.identical += 1,
        NodeStatus::Modified => summary.modified += 1,
        NodeStatus::Removed => summary.removed += 1,
        NodeStatus::Added => summary.added += 1,
      }
      DiffNode { status, left_size, right_size, ..base }
    };
    nodes.insert(rel.clone(), node);
  }

  // Children per folder: folders first, then by name.
  let mut children: HashMap<String, Vec<(bool, String, String)>> = HashMap::new();
  for node in nodes.values() {
    if let Some((parent, _)) = node.path.rsplit_once('/') {
      children.entry(parent.to_string()).or_default().push((node.kind != "dir", node.name.clone(), node.path.clone()));
    }
  }
  for (parent, mut list) in children {
    list.sort();
    if let Some(node) = nodes.get_mut(&parent) {
      node.children = Some(list.into_iter().map(|(_, _, path)| path).collect());
    }
  }

  // A folder differs when any file below it does. Deepest paths first, so
  // each folder sees its subfolders' final status.
  let dirs: Vec<String> = nodes.values().filter(|n| n.kind == "dir").map(|n| n.path.clone()).rev().collect();
  for dir in dirs {
    let differs = nodes[&dir]
      .children
      .iter()
      .flatten()
      .any(|c| nodes.get(c).is_some_and(|c| c.status != NodeStatus::Identical));
    nodes.get_mut(&dir).expect("listed").status = if differs { NodeStatus::Modified } else { NodeStatus::Identical };
  }

  DiffTree { nodes: nodes.into_values().collect(), summary }
}

/// One side of a file, as the diff shows it.
#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Side {
  /// `None` when the file is missing, a folder, or too large.
  pub content: Option<String>,
  pub size: Option<u64>,
  pub too_large: bool,
}

/// BOM dropped, LF line ends, trailing spaces trimmed; refused over 1 MB.
pub fn read_side(path: &Path) -> Side {
  let Ok(meta) = std::fs::metadata(path) else { return Side::default() };
  if meta.is_dir() {
    return Side::default();
  }
  if meta.len() > files::MAX_FILE_SIZE {
    return Side { content: None, size: Some(meta.len()), too_large: true };
  }
  let Ok(bytes) = std::fs::read(path) else { return Side::default() };
  let text = normalize_text(&String::from_utf8_lossy(&bytes));
  let content = text.split('\n').map(str::trim_end).collect::<Vec<_>>().join("\n");
  Side { content: Some(content), size: Some(meta.len()), too_large: false }
}

#[derive(Debug, Serialize)]
pub struct SearchResults {
  pub results: Vec<SearchFileResult>,
  pub warnings: Vec<String>,
}

/// Text search on both sides; a file found on both is reported once, from the left.
pub fn search(left: &Path, right: &Path, query: &str, opts: SearchOptions) -> Result<SearchResults> {
  let mut warnings = Vec::new();
  let mut side = |root: &Path, label: &str| -> Result<Vec<SearchFileResult>> {
    if !root.is_dir() {
      warnings.push(format!("{label} path not found: {}", root.display()));
      return Ok(Vec::new());
    }
    files::search(root, query, opts)
  };
  let mut results = side(left, "Repo")?;
  let right = side(right, "TWX entities")?;
  let seen: std::collections::HashSet<String> = results.iter().map(|r| r.file_path.clone()).collect();
  results.extend(right.into_iter().filter(|r| !seen.contains(&r.file_path)));
  Ok(SearchResults { results, warnings })
}

#[cfg(test)]
mod tests {
  use super::*;

  fn write(path: &Path, text: &str) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, text).unwrap();
  }

  #[test]
  fn merges_and_rolls_up() {
    let dir = tempfile::tempdir().unwrap();
    let (l, r) = (dir.path().join("l"), dir.path().join("r"));
    write(&l.join("A/same.xml"), "<a>\r\n  x  \r\n</a>\r\n\r\n");
    write(&r.join("A/same.xml"), "<a>\nx\n</a>");
    write(&l.join("B/sub/changed.js"), "1");
    write(&r.join("B/sub/changed.js"), "2");
    write(&l.join("gone.txt"), "x");
    write(&r.join("new.txt"), "x");
    write(&l.join(".git/HEAD"), "x");

    let tree = merge_trees(&l, &r);
    let by = |p: &str| tree.nodes.iter().find(|n| n.path == p).unwrap();
    assert_eq!(by("A/same.xml").status, NodeStatus::Identical);
    assert_eq!(by("A").status, NodeStatus::Identical);
    assert_eq!(by("B/sub/changed.js").status, NodeStatus::Modified);
    assert_eq!(by("B").status, NodeStatus::Modified);
    assert_eq!(by("B").children.as_deref(), Some(&["B/sub".to_string()][..]));
    assert_eq!(by("gone.txt").status, NodeStatus::Removed);
    assert_eq!(by("new.txt").status, NodeStatus::Added);
    assert!(tree.nodes.iter().all(|n| !n.path.starts_with(".git")));
    let s = &tree.summary;
    assert_eq!((s.added, s.removed, s.modified, s.identical), (1, 1, 1, 1));
  }

  #[test]
  fn reads_and_searches_both_sides() {
    let dir = tempfile::tempdir().unwrap();
    let (l, r) = (dir.path().join("l"), dir.path().join("r"));
    write(&l.join("f.js"), "\u{feff}let x = 1;  \r\nfoo\r\n");
    write(&r.join("f.js"), "foo");
    write(&r.join("g.js"), "foo");

    assert_eq!(read_side(&l.join("f.js")).content.as_deref(), Some("let x = 1;\nfoo\n"));
    assert!(read_side(&l.join("missing")).content.is_none());

    let found = search(&l, &r, "foo", SearchOptions::default()).unwrap();
    let paths: Vec<_> = found.results.iter().map(|r| r.file_path.as_str()).collect();
    assert_eq!(paths, ["f.js", "g.js"]);
    assert_eq!(found.results[0].matches[0].line_number, 2);

    let missing = search(&dir.path().join("none"), &r, "foo", SearchOptions::default()).unwrap();
    assert_eq!(missing.warnings.len(), 1);
  }
}
