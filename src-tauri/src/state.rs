use std::path::{Path, PathBuf};

use singl_core::db;
use singl_core::jobs::JobRegistry;
use singl_core::workspace::Workspace;
use singl_core::SqlitePool;
use tauri::async_runtime::RwLock;

pub struct AppState {
  /// Behind a lock only so `db_import` can swap the database file out.
  db: RwLock<SqlitePool>,
  pub db_path: PathBuf,
  pub jobs: JobRegistry,
  /// Agent CLIs started by Agent nodes, killed when the app exits.
  pub agents: singl_core::agents::process::ProcRegistry,
  pub workspace: std::sync::RwLock<Workspace>,
}

impl AppState {
  pub async fn load(db_path: PathBuf) -> singl_core::Result<Self> {
    let pool = db::open(&db_path).await?;
    let workspace = Workspace::new(db::settings::workspace_root(&pool).await?);
    Ok(Self {
      db: RwLock::new(pool),
      db_path,
      jobs: JobRegistry::default(),
      agents: Default::default(),
      workspace: std::sync::RwLock::new(workspace),
    })
  }

  pub async fn db(&self) -> SqlitePool {
    self.db.read().await.clone()
  }

  /// Replaces the database with an import of singl-web's `local.db`. The
  /// current file is kept next to it as `singl.db.bak-<unix seconds>`, and
  /// restored if the import fails.
  pub async fn import_db(&self, source: &Path) -> singl_core::Result<db::import::ImportReport> {
    let mut pool = self.db.write().await;
    pool.close().await;

    let backup = self.db_path.with_extension(format!("db.bak-{}", db::now()));
    std::fs::rename(&self.db_path, &backup)?;
    for suffix in ["-wal", "-shm"] {
      let _ = std::fs::remove_file(sidecar(&self.db_path, suffix));
    }

    let report = match db::import::import_drizzle(source, &self.db_path).await {
      Ok(report) => report,
      Err(err) => {
        std::fs::rename(&backup, &self.db_path)?;
        *pool = db::open(&self.db_path).await?;
        return Err(err);
      }
    };
    *pool = db::open(&self.db_path).await?;
    let root = db::settings::workspace_root(&pool).await?;
    *self.workspace.write().unwrap_or_else(|e| e.into_inner()) = Workspace::new(root);
    Ok(report)
  }
}

fn sidecar(path: &Path, suffix: &str) -> PathBuf {
  let mut name = path.as_os_str().to_owned();
  name.push(suffix);
  PathBuf::from(name)
}
