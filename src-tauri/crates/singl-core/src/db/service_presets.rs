//! Saved service calls (`twx_service_presets`) from singl-web's TWX Services
//! page: an entity, a service and its inputs, plus the last output kept with them.

use serde::Deserialize;
use sqlx::SqlitePool;

use super::models::TwxServicePreset;
use super::now;
use crate::{CoreError, Result};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PresetInput {
  /// Updates this preset when set, otherwise creates one.
  pub id: Option<i64>,
  pub name: String,
  pub environment: String,
  pub entity_type: String,
  pub entity_name: String,
  pub service_name: String,
  #[serde(default)]
  pub inputs: Option<String>,
  #[serde(default)]
  pub output: Option<String>,
  #[serde(default)]
  pub output_type: Option<String>,
}

pub async fn list(pool: &SqlitePool) -> Result<Vec<TwxServicePreset>> {
  Ok(sqlx::query_as("SELECT * FROM twx_service_presets ORDER BY id").fetch_all(pool).await?)
}

/// Creates or updates a preset and returns its id.
pub async fn save(pool: &SqlitePool, input: &PresetInput) -> Result<i64> {
  let name = required(&input.name, "Preset name is required.")?;
  let environment = required(&input.environment, "Environment is required.")?;
  let entity_type = required(&input.entity_type, "Entity type is required.")?;
  let entity_name = required(&input.entity_name, "Entity name is required.")?;
  let service_name = required(&input.service_name, "Service name is required.")?;
  let inputs = input.inputs.as_deref().unwrap_or("{}");
  let output = input.output.as_deref().unwrap_or("");
  let output_type = input.output_type.as_deref().unwrap_or("");

  if let Some(id) = input.id {
    let done = sqlx::query(
      "UPDATE twx_service_presets SET name = ?1, environment = ?2, entityType = ?3, entityName = ?4,
         serviceName = ?5, inputs = ?6, output = ?7, outputType = ?8, updatedAt = ?9 WHERE id = ?10",
    )
    .bind(name)
    .bind(environment)
    .bind(entity_type)
    .bind(entity_name)
    .bind(service_name)
    .bind(inputs)
    .bind(output)
    .bind(output_type)
    .bind(now())
    .bind(id)
    .execute(pool)
    .await?;
    if done.rows_affected() == 0 {
      return Err(CoreError::NotFound("That preset no longer exists.".into()));
    }
    return Ok(id);
  }

  let id = sqlx::query_scalar(
    "INSERT INTO twx_service_presets
       (name, environment, entityType, entityName, serviceName, inputs, output, outputType, createdAt, updatedAt)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9) RETURNING id",
  )
  .bind(name)
  .bind(environment)
  .bind(entity_type)
  .bind(entity_name)
  .bind(service_name)
  .bind(inputs)
  .bind(output)
  .bind(output_type)
  .bind(now())
  .fetch_one(pool)
  .await?;
  Ok(id)
}

pub async fn delete(pool: &SqlitePool, id: i64) -> Result<()> {
  sqlx::query("DELETE FROM twx_service_presets WHERE id = ?1").bind(id).execute(pool).await?;
  Ok(())
}

fn required<'a>(value: &'a str, message: &str) -> Result<&'a str> {
  let value = value.trim();
  if value.is_empty() { Err(CoreError::Invalid(message.into())) } else { Ok(value) }
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::db::open;

  fn input(id: Option<i64>, name: &str) -> PresetInput {
    PresetInput {
      id,
      name: name.into(),
      environment: "DEV".into(),
      entity_type: "Things".into(),
      entity_name: "MyThing".into(),
      service_name: "GetData".into(),
      inputs: Some(r#"{"a":"1"}"#.into()),
      output: None,
      output_type: None,
    }
  }

  #[tokio::test]
  async fn saves_updates_and_deletes() {
    let dir = tempfile::tempdir().unwrap();
    let pool = open(&dir.path().join("t.db")).await.unwrap();

    let id = save(&pool, &input(None, " First ")).await.unwrap();
    let rows = list(&pool).await.unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].name, "First");
    assert_eq!(rows[0].output, "");
    assert!(rows[0].created_at.is_some());

    assert_eq!(save(&pool, &input(Some(id), "Renamed")).await.unwrap(), id);
    assert_eq!(list(&pool).await.unwrap()[0].name, "Renamed");

    assert!(matches!(save(&pool, &input(None, "  ")).await, Err(CoreError::Invalid(_))));
    assert!(matches!(save(&pool, &input(Some(id + 9), "x")).await, Err(CoreError::NotFound(_))));

    delete(&pool, id).await.unwrap();
    assert!(list(&pool).await.unwrap().is_empty());
  }
}
