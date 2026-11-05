//! ThingWorx environments (`environment_settings`) and the projects mapped
//! under each (`twx_projects`), as edited on singl-web's Settings page.

use serde::Serialize;
use sqlx::SqlitePool;

use super::models::{EnvironmentSettings, TwxProject};
use super::now;
use crate::{CoreError, Result};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
  pub id: i64,
  pub project_name: String,
  pub folder_name: String,
  pub alias: String,
  pub exports: Vec<String>,
}

/// An environment as the Settings page shows it: the app key is reduced to whether one is set.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Environment {
  pub environment: String,
  pub twx_base_url: String,
  pub has_app_key: bool,
  pub enabled: bool,
  pub projects: Vec<Project>,
}

pub async fn list(pool: &SqlitePool) -> Result<Vec<Environment>> {
  let envs: Vec<EnvironmentSettings> =
    sqlx::query_as("SELECT * FROM environment_settings ORDER BY id").fetch_all(pool).await?;
  let projects: Vec<TwxProject> = sqlx::query_as("SELECT * FROM twx_projects ORDER BY id").fetch_all(pool).await?;

  Ok(
    envs
      .into_iter()
      .map(|env| Environment {
        projects: projects
          .iter()
          .filter(|p| p.environment == env.environment)
          .map(|p| Project {
            id: p.id,
            project_name: p.project_name.clone(),
            folder_name: p.folder_name.clone(),
            alias: p.alias.clone(),
            exports: serde_json::from_str(&p.exports).unwrap_or_else(|_| vec!["all".into()]),
          })
          .collect(),
        has_app_key: !env.twx_app_key.is_empty(),
        environment: env.environment,
        twx_base_url: env.twx_base_url,
        enabled: env.enabled,
      })
      .collect(),
  )
}

/// Creates or updates an environment. A blank `app_key` keeps the stored one.
pub async fn save(pool: &SqlitePool, environment: &str, twx_base_url: &str, app_key: &str) -> Result<()> {
  let environment = required(environment, "Environment is required.")?;
  let (base_url, app_key) = (twx_base_url.trim(), app_key.trim());
  sqlx::query(
    "INSERT INTO environment_settings (environment, twxBaseUrl, twxAppKey, createdAt, updatedAt)
     VALUES (?1, ?2, ?3, ?4, ?4)
     ON CONFLICT(environment) DO UPDATE SET twxBaseUrl = excluded.twxBaseUrl,
       twxAppKey = CASE WHEN excluded.twxAppKey = '' THEN twxAppKey ELSE excluded.twxAppKey END,
       updatedAt = excluded.updatedAt",
  )
  .bind(environment)
  .bind(base_url)
  .bind(app_key)
  .bind(now())
  .execute(pool)
  .await?;
  Ok(())
}

/// A disabled environment stays configured but is hidden from pickers.
pub async fn set_enabled(pool: &SqlitePool, environment: &str, enabled: bool) -> Result<()> {
  let done = sqlx::query("UPDATE environment_settings SET enabled = ?1, updatedAt = ?2 WHERE environment = ?3")
    .bind(enabled)
    .bind(now())
    .bind(environment)
    .execute(pool)
    .await?;
  if done.rows_affected() == 0 {
    return Err(CoreError::NotFound(format!("Environment {environment} not found.")));
  }
  Ok(())
}

/// Copies an environment's base URL and projects under a new name. The app key is not copied.
pub async fn clone(pool: &SqlitePool, source: &str, new_environment: &str) -> Result<()> {
  let new_environment = required(new_environment, "Source and new environment names are required.")?;
  if source == new_environment {
    return Err(CoreError::Invalid("New name must differ from the source.".into()));
  }

  let mut tx = pool.begin().await?;
  let base_url: Option<String> =
    sqlx::query_scalar("SELECT twxBaseUrl FROM environment_settings WHERE environment = ?1")
      .bind(source)
      .fetch_optional(&mut *tx)
      .await?;
  let Some(base_url) = base_url else {
    return Err(CoreError::NotFound("Source environment not found.".into()));
  };
  let taken: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM environment_settings WHERE environment = ?1)")
    .bind(new_environment)
    .fetch_one(&mut *tx)
    .await?;
  if taken {
    return Err(CoreError::Invalid(format!("Environment {new_environment} already exists.")));
  }

  let ts = now();
  sqlx::query(
    "INSERT INTO environment_settings (environment, twxBaseUrl, twxAppKey, createdAt, updatedAt)
     VALUES (?1, ?2, '', ?3, ?3)",
  )
  .bind(new_environment)
  .bind(&base_url)
  .bind(ts)
  .execute(&mut *tx)
  .await?;
  sqlx::query(
    "INSERT INTO twx_projects (environment, projectName, folderName, alias, exports, createdAt, updatedAt)
     SELECT ?1, projectName, folderName, alias, exports, ?2, ?2 FROM twx_projects WHERE environment = ?3 ORDER BY id",
  )
  .bind(new_environment)
  .bind(ts)
  .bind(source)
  .execute(&mut *tx)
  .await?;
  tx.commit().await?;
  Ok(())
}

/// Deletes an environment and every project mapped under it.
pub async fn delete(pool: &SqlitePool, environment: &str) -> Result<()> {
  let mut tx = pool.begin().await?;
  sqlx::query("DELETE FROM twx_projects WHERE environment = ?1").bind(environment).execute(&mut *tx).await?;
  sqlx::query("DELETE FROM environment_settings WHERE environment = ?1").bind(environment).execute(&mut *tx).await?;
  tx.commit().await?;
  Ok(())
}

/// Fields of the project dialog. `exports` is the comma-separated text the user typed.
#[derive(Debug, Clone, Default, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectInput {
  pub id: Option<i64>,
  pub environment: String,
  pub project_name: String,
  #[serde(default)]
  pub folder_name: String,
  #[serde(default)]
  pub alias: String,
  #[serde(default)]
  pub exports: String,
}

/// Inserts a project, or updates it when `id` is set.
pub async fn save_project(pool: &SqlitePool, input: &ProjectInput) -> Result<()> {
  let environment = required(&input.environment, "Environment and project name are required.")?;
  let project_name = required(&input.project_name, "Environment and project name are required.")?;
  let exports = serde_json::to_string(&parse_exports(&input.exports)).expect("string list serializes");
  let ts = now();

  match input.id {
    Some(id) => {
      sqlx::query(
        "UPDATE twx_projects SET projectName = ?1, folderName = ?2, alias = ?3, exports = ?4, updatedAt = ?5
         WHERE id = ?6",
      )
      .bind(project_name)
      .bind(input.folder_name.trim())
      .bind(input.alias.trim())
      .bind(&exports)
      .bind(ts)
      .bind(id)
      .execute(pool)
      .await?;
    }
    None => {
      sqlx::query(
        "INSERT INTO twx_projects (environment, projectName, folderName, alias, exports, createdAt, updatedAt)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
      )
      .bind(environment)
      .bind(project_name)
      .bind(input.folder_name.trim())
      .bind(input.alias.trim())
      .bind(&exports)
      .bind(ts)
      .execute(pool)
      .await?;
    }
  }
  Ok(())
}

pub async fn delete_project(pool: &SqlitePool, id: i64) -> Result<()> {
  sqlx::query("DELETE FROM twx_projects WHERE id = ?1").bind(id).execute(pool).await?;
  Ok(())
}

/// `"Things, Mashups"` → `["Things", "Mashups"]`; blank means `["all"]`.
fn parse_exports(raw: &str) -> Vec<String> {
  let list: Vec<String> = raw.split(',').map(str::trim).filter(|s| !s.is_empty()).map(String::from).collect();
  if list.is_empty() { vec!["all".into()] } else { list }
}

fn required<'a>(value: &'a str, message: &str) -> Result<&'a str> {
  let value = value.trim();
  if value.is_empty() { Err(CoreError::Invalid(message.into())) } else { Ok(value) }
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::db::open;

  async fn pool() -> (tempfile::TempDir, SqlitePool) {
    let dir = tempfile::tempdir().unwrap();
    let pool = open(&dir.path().join("singl.db")).await.unwrap();
    (dir, pool)
  }

  #[tokio::test]
  async fn save_keeps_app_key_when_blank() {
    let (_dir, pool) = pool().await;
    save(&pool, "dev", "https://a", "key").await.unwrap();
    save(&pool, "dev", "https://b", "  ").await.unwrap();

    let key: String = sqlx::query_scalar("SELECT twxAppKey FROM environment_settings").fetch_one(&pool).await.unwrap();
    assert_eq!(key, "key");
    let envs = list(&pool).await.unwrap();
    assert_eq!(envs.len(), 1);
    assert_eq!(envs[0].twx_base_url, "https://b");
    assert!(envs[0].has_app_key && envs[0].enabled);
    assert!(save(&pool, " ", "", "").await.is_err());
  }

  #[tokio::test]
  async fn projects_clone_and_delete() {
    let (_dir, pool) = pool().await;
    save(&pool, "dev", "https://a", "key").await.unwrap();
    let input = ProjectInput {
      environment: "dev".into(),
      project_name: "Proj".into(),
      exports: "Things, , Mashups".into(),
      ..Default::default()
    };
    save_project(&pool, &input).await.unwrap();
    save_project(&pool, &ProjectInput { project_name: "Other".into(), ..input.clone() }).await.unwrap();

    let id = list(&pool).await.unwrap()[0].projects[0].id;
    save_project(&pool, &ProjectInput { id: Some(id), alias: "p".into(), exports: String::new(), ..input })
      .await
      .unwrap();
    let dev = &list(&pool).await.unwrap()[0];
    assert_eq!(dev.projects[0].alias, "p");
    assert_eq!(dev.projects[0].exports, ["all"]);
    assert_eq!(dev.projects[1].exports, ["Things", "Mashups"]);

    clone(&pool, "dev", "qa").await.unwrap();
    assert!(clone(&pool, "dev", "qa").await.is_err());
    assert!(clone(&pool, "dev", "dev").await.is_err());
    assert!(clone(&pool, "nope", "x").await.is_err());
    let qa = list(&pool).await.unwrap().into_iter().find(|e| e.environment == "qa").unwrap();
    assert!(!qa.has_app_key);
    assert_eq!(qa.projects.len(), 2);

    set_enabled(&pool, "qa", false).await.unwrap();
    assert!(set_enabled(&pool, "nope", false).await.is_err());
    delete(&pool, "dev").await.unwrap();
    let envs = list(&pool).await.unwrap();
    assert_eq!(envs.len(), 1);
    assert!(!envs[0].enabled);

    delete_project(&pool, envs[0].projects[0].id).await.unwrap();
    assert_eq!(list(&pool).await.unwrap()[0].projects.len(), 1);
  }
}
