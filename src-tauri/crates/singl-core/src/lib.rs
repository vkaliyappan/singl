//! singl application logic. Nothing here depends on Tauri: the app crate wraps
//! these functions in thin `#[tauri::command]`s and maps [`CoreError`] to its
//! IPC error at the boundary.

pub mod compare;
pub mod agents;
pub mod db;
pub mod error;
pub mod flow;
pub mod jobs;
pub mod repo;
pub mod twx;
pub mod workspace;

pub use error::{CoreError, Result};
pub use sqlx::SqlitePool;
