//! Workspace root: the folder that holds `twx-entities/`, `repo/`, `bundles/`,
//! `export/`, `backup/` and the ThingWorx sources. singl-web resolved all of these against
//! `process.cwd()`; a packaged app has no meaningful cwd, so every path goes
//! through [`Workspace::resolve`] instead.

use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PathKind {
  TwxEntities,
  Repo,
  RunTimes,
  Bundles,
  Export,
  Extracted,
  Temp,
  TeamsPresence,
  ThingworxSrc,
  Backup,
}

impl PathKind {
  fn relative(self) -> &'static str {
    match self {
      PathKind::TwxEntities => "twx-entities",
      PathKind::Repo => "repo",
      PathKind::RunTimes => "twx-run-times.json",
      PathKind::Bundles => "bundles",
      PathKind::Export => "export",
      PathKind::Extracted => "extracted",
      PathKind::Temp => "temp",
      PathKind::TeamsPresence => "teams-presence",
      PathKind::ThingworxSrc => "WindchillClients/ThingWorx",
      PathKind::Backup => "backup",
    }
  }
}

#[derive(Debug, Clone, Default)]
pub struct Workspace {
  root: Option<PathBuf>,
}

impl Workspace {
  pub fn new(root: Option<PathBuf>) -> Self {
    let root = root.filter(|p| !p.as_os_str().is_empty());
    if let Some(root) = &root {
      move_legacy_dist(root);
    }
    Self { root }
  }

  pub fn root(&self) -> Option<&Path> {
    self.root.as_deref()
  }

  /// Absolute path for `kind`, or `None` while no workspace root is set.
  pub fn resolve(&self, kind: PathKind) -> Option<PathBuf> {
    self.root.as_ref().map(|root| root.join(kind.relative()))
  }

  /// A user-entered path: absolute ones as given, relative ones (`./bundles`)
  /// against the root. `None` for a relative path while no root is set.
  pub fn resolve_path(&self, path: &str) -> Option<PathBuf> {
    let path = Path::new(path.trim());
    if path.is_absolute() {
      return Some(path.to_path_buf());
    }
    let mut out = self.root.clone()?;
    for part in path.components() {
      match part {
        std::path::Component::CurDir => {}
        std::path::Component::ParentDir => {
          out.pop();
        }
        other => out.push(other),
      }
    }
    Some(out)
  }
}

/// Everything except the ThingWorx sources and backups used to live under
/// `dist/`. Moves each of those to the root once, unless the new path already
/// exists, then drops `dist/` if that left it empty. Best effort: on failure
/// the old files stay put and the next run fills the new path.
fn move_legacy_dist(root: &Path) {
  const MOVED: [PathKind; 8] = [
    PathKind::TwxEntities,
    PathKind::Repo,
    PathKind::RunTimes,
    PathKind::Bundles,
    PathKind::Export,
    PathKind::Extracted,
    PathKind::Temp,
    PathKind::TeamsPresence,
  ];
  let dist = root.join("dist");
  if !dist.is_dir() {
    return;
  }
  for kind in MOVED {
    let (old, new) = (dist.join(kind.relative()), root.join(kind.relative()));
    if old.exists() && !new.exists() {
      if let Err(err) = std::fs::rename(&old, &new) {
        eprintln!("could not move {} to {}: {err}", old.display(), new.display());
      }
    }
  }
  let _ = std::fs::remove_dir(&dist);
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn resolves_under_root() {
    let ws = Workspace::new(Some(PathBuf::from("/w")));
    assert_eq!(ws.resolve(PathKind::Repo), Some(PathBuf::from("/w").join("repo")));
    assert_eq!(Workspace::new(Some(PathBuf::new())).resolve(PathKind::Repo), None);
  }

  #[test]
  fn moves_legacy_dist_to_root() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(dir.path().join("dist/twx-entities/dev")).unwrap();
    std::fs::create_dir_all(dir.path().join("dist/repo/WindchillClients")).unwrap();
    std::fs::write(dir.path().join("dist/twx-run-times.json"), "{}").unwrap();
    let ws = Workspace::new(Some(dir.path().to_path_buf()));
    assert_eq!(ws.resolve(PathKind::TwxEntities), Some(dir.path().join("twx-entities")));
    assert!(dir.path().join("twx-entities/dev").is_dir());
    assert!(dir.path().join("repo/WindchillClients").is_dir());
    assert!(dir.path().join("twx-run-times.json").is_file());
    assert!(!dir.path().join("dist").exists());
  }

  #[test]
  fn keeps_legacy_dist_when_new_path_exists() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(dir.path().join("dist/bundles/old")).unwrap();
    std::fs::create_dir_all(dir.path().join("bundles")).unwrap();
    Workspace::new(Some(dir.path().to_path_buf()));
    assert!(dir.path().join("dist/bundles/old").is_dir());
    assert!(!dir.path().join("bundles/old").exists());
  }

  #[test]
  fn resolves_user_paths() {
    let ws = Workspace::new(Some(PathBuf::from("/w")));
    assert_eq!(ws.resolve_path("./bundles"), Some(PathBuf::from("/w").join("bundles")));
    assert_eq!(ws.resolve_path("../x"), Some(PathBuf::from("/x")));
    assert_eq!(Workspace::default().resolve_path("bundles"), None);
  }
}
