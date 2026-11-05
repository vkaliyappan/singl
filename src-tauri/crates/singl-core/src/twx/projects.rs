//! The projects and connections configured in Settings, as singl-web's
//! `deploy-projects.ts` and `config.ts` read them.

use serde::Serialize;
use sqlx::SqlitePool;

use super::api::Client;
use crate::{CoreError, Result};

/// A project as the deployment pipeline sees it.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DeployProject {
  /// Folder / ZIP name used by export and extract, e.g. "ITCI_CHBUtils".
  pub key: String,
  /// WindchillClients folder the project lives under, e.g. "InheritanceApp".
  pub alias: String,
  /// ThingWorx project name, e.g. "ITCI.CHBUtils".
  pub project_name: String,
  /// Entity collections to export, or `["all"]`.
  pub exports: Vec<String>,
}

impl DeployProject {
  pub fn matches(&self, filter: Option<&str>) -> bool {
    filter.is_none_or(|f| f.is_empty() || f == self.key || f == self.alias || f == self.project_name)
  }
}

#[derive(sqlx::FromRow)]
#[sqlx(rename_all = "camelCase")]
struct Row {
  environment: String,
  project_name: String,
  folder_name: String,
  alias: String,
  exports: String,
}

/// Projects for `env`, or for every enabled environment when `env` is `None`.
/// The same project is usually configured in several environments; the first
/// configured one wins per key.
pub async fn deploy_projects(pool: &SqlitePool, env: Option<&str>) -> Result<Vec<DeployProject>> {
  let rows: Vec<Row> = sqlx::query_as(
    "SELECT p.environment, p.projectName, p.folderName, p.alias, p.exports
     FROM twx_projects p JOIN environment_settings e ON e.environment = p.environment
     WHERE e.enabled = 1 ORDER BY p.id",
  )
  .fetch_all(pool)
  .await?;

  let mut seen = std::collections::HashSet::new();
  Ok(
    rows
      .into_iter()
      .filter(|r| env.is_none_or(|env| env.is_empty() || r.environment == env))
      .map(|r| DeployProject {
        key: if r.folder_name.is_empty() { r.project_name.replace('.', "_") } else { r.folder_name },
        alias: if r.alias.is_empty() { r.project_name.clone() } else { r.alias },
        exports: serde_json::from_str(&r.exports).unwrap_or_else(|_| vec!["all".into()]),
        project_name: r.project_name,
      })
      .filter(|p| seen.insert(p.key.clone()))
      .collect(),
  )
}

/// The configured projects matching `filter`, or an error saying none are.
pub async fn selected_projects(pool: &SqlitePool, env: Option<&str>, filter: Option<&str>) -> Result<Vec<DeployProject>> {
  let projects: Vec<_> = deploy_projects(pool, env).await?.into_iter().filter(|p| p.matches(filter)).collect();
  if projects.is_empty() {
    let message = match (filter.filter(|f| !f.is_empty()), env.filter(|e| !e.is_empty())) {
      (Some(f), Some(e)) => format!("Project \"{f}\" is not configured for \"{e}\". Check Settings."),
      (Some(f), None) => format!("Project \"{f}\" is not configured. Check Settings."),
      _ => "No projects configured. Add them in Settings first.".into(),
    };
    return Err(CoreError::Invalid(message));
  }
  Ok(projects)
}

/// A client for an enabled environment.
pub async fn connect(pool: &SqlitePool, env: &str) -> Result<Client> {
  if env.trim().is_empty() {
    return Err(CoreError::Invalid("Choose a ThingWorx environment.".into()));
  }
  let row: Option<(String, String, bool)> =
    sqlx::query_as("SELECT twxBaseUrl, twxAppKey, enabled FROM environment_settings WHERE environment = ?1")
      .bind(env)
      .fetch_optional(pool)
      .await?;
  let (base_url, app_key, enabled) = row.ok_or_else(|| {
    CoreError::NotFound(format!("No config found for environment \"{env}\". Add it in the app Settings page."))
  })?;
  if !enabled {
    return Err(CoreError::Invalid(format!("Environment \"{env}\" is disabled. Enable it in the app Settings page.")));
  }
  if base_url.is_empty() || app_key.is_empty() {
    return Err(CoreError::Invalid(format!("Environment \"{env}\" needs a base URL and an App Key. Check Settings.")));
  }
  Ok(Client::new(&base_url, &app_key))
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::db::{environments, open};

  #[tokio::test]
  async fn projects_per_env_and_unique_by_key() {
    let dir = tempfile::tempdir().unwrap();
    let pool = open(&dir.path().join("singl.db")).await.unwrap();
    environments::save(&pool, "dev", "https://dev/Thingworx", "key").await.unwrap();
    environments::save(&pool, "qa", "https://qa/Thingworx", "").await.unwrap();
    for env in ["dev", "qa"] {
      let input = environments::ProjectInput {
        id: None,
        environment: env.into(),
        project_name: "ITCI.CHBUtils".into(),
        folder_name: String::new(),
        alias: "App".into(),
        exports: "Things, Mashups".into(),
      };
      environments::save_project(&pool, &input).await.unwrap();
    }

    let all = deploy_projects(&pool, None).await.unwrap();
    assert_eq!(all.len(), 1);
    assert_eq!(all[0].key, "ITCI_CHBUtils");
    assert_eq!(all[0].exports, ["Things", "Mashups"]);
    assert!(all[0].matches(Some("App")) && !all[0].matches(Some("Other")));

    assert!(selected_projects(&pool, Some("dev"), Some("Other")).await.is_err());
    assert!(connect(&pool, "dev").await.is_ok());
    assert!(connect(&pool, "qa").await.is_err()); // no app key
    environments::set_enabled(&pool, "dev", false).await.unwrap();
    assert!(connect(&pool, "dev").await.is_err());
    assert!(deploy_projects(&pool, Some("dev")).await.unwrap().is_empty());
  }

  /// Read-only calls against a live server, with the credentials of
  /// `SINGL_TWX_ENV` in the database `SINGL_DB`. Prints the repository root
  /// listing as JSON for comparing with singl-web's `/api/twx/repo-dirs`.
  #[tokio::test]
  #[ignore]
  async fn live_read_only() {
    let pool = open(std::path::Path::new(&std::env::var("SINGL_DB").expect("SINGL_DB"))).await.unwrap();
    let client = connect(&pool, &std::env::var("SINGL_TWX_ENV").expect("SINGL_TWX_ENV")).await.unwrap();
    let dirs = client.list_repository_directories("SystemRepository", "/").await.unwrap();
    println!("DIRS {}", serde_json::to_string(&dirs).unwrap());
    let project = &deploy_projects(&pool, None).await.unwrap()[0];
    let entities = client.project_entities(&project.project_name).await.unwrap();
    println!("ENTITIES {} {}", project.project_name, entities.len());
    let first = &entities[0];
    let xml = crate::twx::xmlformat::format_entity_xml(&client.export_entity(&first.entity_type, &first.name).await.unwrap());
    println!("EXPORTED {}/{} {} bytes", first.entity_type, first.name, xml.len());
    let missing = client.project_entities("No.Such.Project.Singl").await.unwrap_err();
    println!("MISSING {missing}");
    assert!(matches!(missing, CoreError::Twx { status: 404 | 500, .. }));
  }
}
