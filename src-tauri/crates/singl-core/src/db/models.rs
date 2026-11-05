//! Row types for singl-web's `src/db/schema.ts`. Columns are camelCase in SQL,
//! fields are snake_case here. Timestamps are unix seconds; secrets are never
//! serialized to the UI.
//!
//! `push_subscriptions` has no model: web push is dropped in the Tauri app.

use serde::Serialize;
use sqlx::FromRow;

#[derive(Debug, Clone, FromRow, Serialize)]
#[sqlx(rename_all = "camelCase")]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
  pub id: i64,
  #[serde(skip_serializing)]
  pub azure_pat_token: String,
  pub twx_root_prefix: String,
  pub repo_root_subpath: String,
  pub bundle_src_dir: String,
  pub bundle_dest_dir: String,
  /// JSON array of agent providers switched off in Settings.
  pub disabled_agents: String,
  pub workspace_root: String,
  pub updated_at: Option<i64>,
  pub update_dir: String,
}

#[derive(Debug, Clone, FromRow, Serialize)]
#[sqlx(rename_all = "camelCase")]
#[serde(rename_all = "camelCase")]
pub struct RepoSettings {
  pub id: i64,
  pub repo_url: String,
  pub cloned_branch: String,
  pub repo_slug: String,
  pub updated_at: Option<i64>,
}

#[derive(Debug, Clone, FromRow, Serialize)]
#[sqlx(rename_all = "camelCase")]
#[serde(rename_all = "camelCase")]
pub struct EnvironmentSettings {
  pub id: i64,
  pub environment: String,
  pub twx_base_url: String,
  #[serde(skip_serializing)]
  pub twx_app_key: String,
  pub enabled: bool,
  pub created_at: Option<i64>,
  pub updated_at: Option<i64>,
}

#[derive(Debug, Clone, FromRow, Serialize)]
#[sqlx(rename_all = "camelCase")]
#[serde(rename_all = "camelCase")]
pub struct TwxProject {
  pub id: i64,
  pub environment: String,
  pub project_name: String,
  pub folder_name: String,
  pub alias: String,
  /// JSON array, `["all"]` by default.
  pub exports: String,
  pub created_at: Option<i64>,
  pub updated_at: Option<i64>,
}

#[derive(Debug, Clone, FromRow, Serialize)]
#[sqlx(rename_all = "camelCase")]
#[serde(rename_all = "camelCase")]
pub struct FlowFolder {
  pub id: String,
  pub name: String,
  pub parent_id: Option<String>,
  pub created_at: Option<i64>,
  pub updated_at: Option<i64>,
}

#[derive(Debug, Clone, FromRow, Serialize)]
#[sqlx(rename_all = "camelCase")]
#[serde(rename_all = "camelCase")]
pub struct ServiceFlow {
  pub id: String,
  pub name: String,
  pub environment: String,
  pub folder_id: Option<String>,
  /// Whole graph as JSON: `{ nodes, edges }`.
  pub graph: String,
  pub created_at: Option<i64>,
  pub updated_at: Option<i64>,
}

#[derive(Debug, Clone, FromRow, Serialize)]
#[sqlx(rename_all = "camelCase")]
#[serde(rename_all = "camelCase")]
pub struct Notification {
  pub id: String,
  pub title: String,
  pub body: String,
  pub url: String,
  pub tag: Option<String>,
  pub ref_type: Option<String>,
  pub ref_id: Option<String>,
  pub read_at: Option<i64>,
  pub created_at: i64,
}

#[derive(Debug, Clone, FromRow, Serialize)]
#[sqlx(rename_all = "camelCase")]
#[serde(rename_all = "camelCase")]
pub struct TwxServicePreset {
  pub id: i64,
  pub name: String,
  pub environment: String,
  pub entity_type: String,
  pub entity_name: String,
  pub service_name: String,
  pub inputs: String,
  pub output: String,
  pub output_type: String,
  pub created_at: Option<i64>,
  pub updated_at: Option<i64>,
}

#[derive(Debug, Clone, FromRow, Serialize)]
#[sqlx(rename_all = "camelCase")]
#[serde(rename_all = "camelCase")]
pub struct AssistantChat {
  pub id: String,
  pub scope: String,
  pub domain: String,
  pub title: String,
  /// `AssistantMessage[]` as JSON.
  pub messages: String,
  pub message_count: i64,
  pub created_at: Option<i64>,
  pub updated_at: Option<i64>,
}

#[derive(Debug, Clone, FromRow, Serialize)]
#[sqlx(rename_all = "camelCase")]
#[serde(rename_all = "camelCase")]
pub struct AssistantSession {
  pub chat_id: String,
  pub provider: String,
  pub model: String,
  pub session_id: String,
  pub turn_count: i64,
  pub turns_hash: String,
  pub context_hash: Option<String>,
  pub size: i64,
  pub updated_at: Option<i64>,
}

#[derive(Debug, Clone, FromRow, Serialize)]
#[sqlx(rename_all = "camelCase")]
#[serde(rename_all = "camelCase")]
pub struct TodoStatus {
  pub id: String,
  pub name: String,
  pub color: String,
  pub closed: bool,
  pub sort_order: i64,
  pub created_at: Option<i64>,
  pub updated_at: Option<i64>,
}

#[derive(Debug, Clone, FromRow, Serialize)]
#[sqlx(rename_all = "camelCase")]
#[serde(rename_all = "camelCase")]
pub struct Todo {
  pub id: String,
  pub title: String,
  pub description: String,
  /// Id of a `todo_statuses` row.
  pub status: String,
  /// `"low" | "medium" | "high"`
  pub priority: String,
  pub sort_order: i64,
  pub due_at: Option<i64>,
  pub remind_at: Option<i64>,
  pub reminded_at: Option<i64>,
  pub completed_at: Option<i64>,
  pub created_at: Option<i64>,
  pub updated_at: Option<i64>,
}
