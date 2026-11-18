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
pub mod twx_access;
pub mod updater;
pub mod workspace;
pub mod twx_logs;
pub mod twx_admin;
pub mod twx_import;
pub mod deps;
pub mod automation;
pub mod twx_events;
