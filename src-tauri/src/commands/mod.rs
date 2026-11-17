//! Thin `#[tauri::command]` wrappers over singl-core, one file per feature.

pub mod agents;
pub mod assistant;
pub mod compare;
pub mod db;
pub mod entities;
pub mod flows;
pub mod jobs;
pub mod presence;
pub mod repo;
pub mod services;
pub mod settings;
pub mod twx;
pub mod updater;
pub mod workspace;
