//! Reading a clone under `repo`: the file tree, file contents, text
//! search, and clearing what Extract generated.

use std::path::{Component, Path, PathBuf};

use regex::{Regex, RegexBuilder};
use serde::{Deserialize, Serialize};
use walkdir::WalkDir;

use crate::{CoreError, Result};

pub const MAX_FILE_SIZE: u64 = 1024 * 1024;
const MAX_SEARCH_FILE_SIZE: u64 = 512 * 1024;
const MAX_RESULTS: usize = 500;
const MAX_FILES: usize = 2000;
const BINARY_EXTS: &[&str] = &[
  "png", "jpg", "jpeg", "gif", "bmp", "ico", "svg", "webp", "tiff", "pdf", "zip", "tar", "gz", "7z", "rar", "bz2", "exe",
  "dll", "so", "dylib", "wasm", "bin", "ttf", "otf", "woff", "woff2", "eot", "mp3", "mp4", "wav", "ogg", "avi", "mov",
  "mkv", "db", "sqlite", "sqlite3",
];

/// `base` joined with the relative `rel` (`/` or `\` separated), refusing
/// anything that would leave `base`.
pub fn safe_join(base: &Path, rel: &str) -> Result<PathBuf> {
  let mut path = base.to_path_buf();
  for part in Path::new(&rel.replace('\\', "/")).components() {
    match part {
      Component::Normal(name) => path.push(name),
      Component::CurDir => {}
      _ => return Err(CoreError::Invalid("Invalid path".into())),
    }
  }
  Ok(path)
}

/// Drops a BOM and turns CRLF and CR into LF.
pub fn normalize_text(text: &str) -> String {
  text.strip_prefix('\u{feff}').unwrap_or(text).replace("\r\n", "\n").replace('\r', "\n")
}

/// Like [`std::fs::remove_dir_all`], but also clears the read-only flag git
/// sets on pack files, which Windows otherwise refuses to delete.
pub fn remove_dir_all(path: &Path) -> Result<()> {
  if std::fs::remove_dir_all(path).is_ok() || !path.exists() {
    return Ok(());
  }
  for entry in WalkDir::new(path).into_iter().flatten() {
    if let Ok(meta) = entry.metadata() {
      let mut perms = meta.permissions();
      if perms.readonly() {
        #[allow(clippy::permissions_set_readonly_false)]
        perms.set_readonly(false);
        let _ = std::fs::set_permissions(entry.path(), perms);
      }
    }
  }
  Ok(std::fs::remove_dir_all(path)?)
}

/// Every file under `root`, relative and `/`-separated, plus empty folders
/// (with a trailing `/`) so they still show. `.git` is skipped.
pub fn list_paths(root: &Path) -> Result<Vec<String>> {
  if !root.is_dir() {
    return Err(CoreError::NotFound("Path does not exist".into()));
  }
  let mut paths = Vec::new();
  collect(root, "", &mut paths)?;
  Ok(paths)
}

fn collect(root: &Path, prefix: &str, paths: &mut Vec<String>) -> Result<()> {
  let mut entries: Vec<_> = std::fs::read_dir(root.join(prefix))?.flatten().collect();
  entries.sort_by_key(|e| e.file_name());
  for entry in entries {
    let name = entry.file_name().to_string_lossy().into_owned();
    if name == ".git" {
      continue;
    }
    let rel = format!("{prefix}{name}");
    if entry.file_type()?.is_dir() {
      let before = paths.len();
      collect(root, &format!("{rel}/"), paths)?;
      if paths.len() == before {
        paths.push(format!("{rel}/"));
      }
    } else {
      paths.push(rel);
    }
  }
  Ok(())
}

/// A text file of at most 1 MB. Invalid UTF-8 is replaced, not refused.
pub fn read_text(path: &Path) -> Result<String> {
  let meta = std::fs::metadata(path).map_err(|_| CoreError::NotFound("File does not exist".into()))?;
  if meta.is_dir() {
    return Err(CoreError::Invalid("Path is a directory".into()));
  }
  if meta.len() > MAX_FILE_SIZE {
    return Err(CoreError::Invalid("File too large to display (> 1 MB)".into()));
  }
  Ok(String::from_utf8_lossy(&std::fs::read(path)?).into_owned())
}

#[derive(Debug, Clone, Copy, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SearchOptions {
  pub case_sensitive: bool,
  pub whole_word: bool,
  pub use_regex: bool,
  pub match_filename: bool,
}

/// Columns are in UTF-16 units, as the editor counts them.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchMatch {
  pub line_number: usize,
  pub line_content: String,
  pub match_start: usize,
  pub match_end: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchFileResult {
  pub file_path: String,
  pub matches: Vec<SearchMatch>,
  pub filename_match: bool,
}

fn pattern(query: &str, opts: SearchOptions) -> Result<Regex> {
  let mut src = if opts.use_regex { query.to_string() } else { regex::escape(query) };
  if opts.whole_word {
    src = format!(r"\b(?:{src})\b");
  }
  RegexBuilder::new(&src)
    .case_insensitive(!opts.case_sensitive)
    .build()
    .map_err(|_| CoreError::Invalid("Invalid regular expression".into()))
}

fn utf16_len(s: &str) -> usize {
  s.encode_utf16().count()
}

/// First match on each line of `path`; files over 512 KB are skipped.
fn search_file(path: &Path, re: &Regex) -> Vec<SearchMatch> {
  let Ok(meta) = std::fs::metadata(path) else { return Vec::new() };
  if meta.len() > MAX_SEARCH_FILE_SIZE {
    return Vec::new();
  }
  let Ok(bytes) = std::fs::read(path) else { return Vec::new() };
  let text = String::from_utf8_lossy(&bytes);
  text
    .split('\n')
    .enumerate()
    .filter_map(|(i, line)| {
      let line = line.strip_suffix('\r').unwrap_or(line);
      let m = re.find(line)?;
      Some(SearchMatch {
        line_number: i + 1,
        line_content: line.chars().take(200).collect(),
        match_start: utf16_len(&line[..m.start()]),
        match_end: utf16_len(&line[..m.end()]),
      })
    })
    .collect()
}

/// Text search under `root`, skipping `.git`, `node_modules` and binary
/// files. Stops at 500 matching files or 2000 files read.
pub fn search(root: &Path, query: &str, opts: SearchOptions) -> Result<Vec<SearchFileResult>> {
  if query.trim().is_empty() {
    return Ok(Vec::new());
  }
  if !root.is_dir() {
    return Err(CoreError::Invalid("Invalid root".into()));
  }
  let re = pattern(query, opts)?;
  let mut results = Vec::new();
  let mut files_read = 0;
  let walk = WalkDir::new(root)
    .sort_by_file_name()
    .into_iter()
    .filter_entry(|e| !(e.file_type().is_dir() && matches!(e.file_name().to_str(), Some(".git" | "node_modules"))));
  for entry in walk.flatten() {
    if results.len() >= MAX_RESULTS || files_read >= MAX_FILES {
      break;
    }
    if !entry.file_type().is_file() {
      continue;
    }
    let name = entry.file_name().to_string_lossy();
    let ext = name.rsplit('.').next().unwrap_or("").to_lowercase();
    if BINARY_EXTS.contains(&ext.as_str()) {
      continue;
    }
    files_read += 1;
    let matches = search_file(entry.path(), &re);
    let filename_match = opts.match_filename && re.is_match(&name);
    if !matches.is_empty() || filename_match {
      let rel = entry.path().strip_prefix(root).unwrap_or(entry.path());
      results.push(SearchFileResult { file_path: rel.to_string_lossy().replace('\\', "/"), matches, filename_match });
    }
  }
  Ok(results)
}

/// Deletes the `Code/` folder Extract writes under each ThingWorx project in
/// the clone. Returns how many project folders were cleared.
pub fn clean_extracted(repo: &Path) -> Result<usize> {
  let thingworx = [repo.join("ThingWorx"), repo.join("WindchillClients").join("ThingWorx")]
    .into_iter()
    .find(|dir| dir.is_dir())
    .ok_or_else(|| CoreError::NotFound("ThingWorx directory not found. Run Extract first.".into()))?;
  let mut cleared = 0;
  for entry in std::fs::read_dir(thingworx)?.flatten() {
    if !entry.file_type()?.is_dir() {
      continue;
    }
    let code = entry.path().join("Code");
    if code.is_dir() {
      remove_dir_all(&code)?;
    }
    cleared += 1;
  }
  Ok(cleared)
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn safe_join_stays_inside() {
    let base = Path::new("/r");
    assert_eq!(safe_join(base, "a/b.txt").unwrap(), base.join("a").join("b.txt"));
    assert_eq!(safe_join(base, r"a\b.txt").unwrap(), base.join("a").join("b.txt"));
    assert!(safe_join(base, "../x").is_err());
    assert!(safe_join(base, "/etc/passwd").is_err());
  }

  #[test]
  fn tree_search_and_clean() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    std::fs::create_dir_all(root.join(".git")).unwrap();
    std::fs::create_dir_all(root.join("empty")).unwrap();
    std::fs::create_dir_all(root.join("ThingWorx/Proj/Code/x")).unwrap();
    std::fs::write(root.join("ThingWorx/Proj/Code/x/s.js"), "x").unwrap();
    std::fs::write(root.join("Main.js"), "const é = 1;\r\nlet FooBar = 2;\n").unwrap();

    assert_eq!(list_paths(root).unwrap(), ["Main.js", "ThingWorx/Proj/Code/x/s.js", "empty/"]);

    let hits = search(root, "foobar", SearchOptions::default()).unwrap();
    assert_eq!(hits.len(), 1);
    let m = &hits[0].matches[0];
    assert_eq!((m.line_number, m.match_start, m.match_end, m.line_content.as_str()), (2, 4, 10, "let FooBar = 2;"));
    let case = SearchOptions { case_sensitive: true, ..Default::default() };
    assert!(search(root, "foobar", case).unwrap().is_empty());
    let word = SearchOptions { whole_word: true, ..Default::default() };
    assert!(search(root, "Foo", word).unwrap().is_empty());
    let re = SearchOptions { use_regex: true, ..Default::default() };
    assert!(search(root, "(", re).is_err());
    let name = SearchOptions { match_filename: true, ..Default::default() };
    assert_eq!(search(root, "main", name).unwrap()[0].file_path, "Main.js");

    assert_eq!(clean_extracted(root).unwrap(), 1);
    assert!(!root.join("ThingWorx/Proj/Code").exists());
  }
}
