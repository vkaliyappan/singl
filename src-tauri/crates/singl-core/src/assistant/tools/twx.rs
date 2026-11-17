//! ThingWorx server tools, over the environments in Settings.
//!
//! `env` is optional everywhere: it defaults to the environment the current
//! screen reports (`data.env` / `data.environment`), else the first enabled one.

use std::sync::Arc;

use serde_json::{Value, json};

use super::{Args, Risk, Tool, schema, ser, tool};
use crate::assistant::Assistant;
use crate::twx::api::{Client, collection_name};
use crate::twx::projects;
use crate::{CoreError, Result};

/// The environment to use for a call.
pub async fn resolve_env(a: &Assistant, args: &Value) -> Result<String> {
  if let Some(env) = Args(args).str("env") {
    return Ok(env.to_string());
  }
  let ctx = a.context.get();
  for key in ["env", "environment"] {
    if let Some(env) = ctx.data.get(key).and_then(Value::as_str).filter(|e| !e.is_empty()) {
      return Ok(env.to_string());
    }
  }
  let first: Option<String> =
    sqlx::query_scalar("SELECT environment FROM environment_settings WHERE enabled = 1 ORDER BY id LIMIT 1")
      .fetch_optional(&a.pool().await)
      .await?;
  first.ok_or_else(|| CoreError::Invalid("No ThingWorx environment is enabled. Add one in Settings.".into()))
}

pub async fn client(a: &Arc<Assistant>, args: &Value) -> Result<Client> {
  let env = resolve_env(a, args).await?;
  projects::connect(&a.pool().await, &env).await
}

pub fn tools() -> Vec<Tool> {
  let env = json!({ "type": "string", "description": "Environment name from Settings. Default: the one on screen, else the first enabled." });
  let ty = json!({ "type": "string", "description": "Entity type or collection, e.g. \"Thing\", \"ThingTemplate\", \"Things\"." });
  let mask = json!({ "type": "string", "description": "Name filter with * wildcards. Default \"*\"." });
  let s = json!({ "type": "string" });

  vec![
    tool(
      "twx_list_environments",
      "ThingWorx environments configured in singl (no secrets).",
      schema(json!({}), &[]),
      Risk::Read,
      |a, _, _| async move {
        let rows: Vec<(String, String, i64)> =
          sqlx::query_as("SELECT environment, twxBaseUrl, enabled FROM environment_settings ORDER BY id")
            .fetch_all(&a.pool().await)
            .await?;
        ser(&rows.into_iter().map(|(e, u, en)| json!({ "environment": e, "twxBaseUrl": u, "enabled": en != 0 })).collect::<Vec<_>>())
      },
    ),
    tool(
      "twx_list_entities",
      "Search entities on a ThingWorx server by type and name mask.",
      schema(json!({ "env": env, "type": ty, "nameMask": mask }), &["type"]),
      Risk::Read,
      |a, args, _| async move {
        let c = client(&a, &args).await?;
        let x = Args(&args);
        ser(&c.search_entities(x.need("type")?, x.str("nameMask").unwrap_or("*")).await?)
      },
    ),
    tool(
      "twx_list_projects",
      "All projects on a ThingWorx server.",
      schema(json!({ "env": env }), &[]),
      Risk::Read,
      |a, args, _| async move { ser(&client(&a, &args).await?.all_projects().await?) },
    ),
    tool(
      "twx_list_project_entities",
      "Every entity in a ThingWorx project.",
      schema(json!({ "env": env, "projectName": s }), &["projectName"]),
      Risk::Read,
      |a, args, _| async move { ser(&client(&a, &args).await?.project_entities(Args(&args).need("projectName")?).await?) },
    ),
    tool(
      "twx_list_services",
      "Service definitions (name, parameters, result type) of a ThingWorx entity.",
      schema(json!({ "env": env, "type": ty, "entityName": s }), &["type", "entityName"]),
      Risk::Read,
      |a, args, _| async move {
        let x = Args(&args);
        ser(&client(&a, &args).await?.service_definitions(collection_name(x.need("type")?), x.need("entityName")?).await?)
      },
    ),
    tool(
      "twx_list_properties",
      "Property definitions (name, baseType, aspects) of a ThingWorx entity.",
      schema(json!({ "env": env, "type": ty, "entityName": s }), &["type", "entityName"]),
      Risk::Read,
      |a, args, _| async move {
        let x = Args(&args);
        ser(&client(&a, &args).await?.property_definitions(collection_name(x.need("type")?), x.need("entityName")?).await?)
      },
    ),
    tool(
      "twx_get_property_values",
      "Current property values of a Thing; all of them, or one when propertyName is given.",
      schema(json!({ "env": env, "entityName": s, "propertyName": s }), &["entityName"]),
      Risk::Read,
      |a, args, _| async move {
        let c = client(&a, &args).await?;
        let x = Args(&args);
        let v = match x.str("propertyName") {
          Some(p) => c.property_value(x.need("entityName")?, p).await?,
          None => c.property_values(x.need("entityName")?).await?,
        };
        ser(&v)
      },
    ),
    tool(
      "twx_datashape_fields",
      "Field definitions of a ThingWorx DataShape.",
      schema(json!({ "env": env, "name": s }), &["name"]),
      Risk::Read,
      |a, args, _| async move { ser(&client(&a, &args).await?.datashape_fields(Args(&args).need("name")?).await?) },
    ),
    tool(
      "twx_export_entity",
      "A ThingWorx entity's definition as exported XML, straight from the server.",
      schema(json!({ "env": env, "type": ty, "entityName": s }), &["type", "entityName"]),
      Risk::Read,
      |a, args, _| async move {
        let x = Args(&args);
        client(&a, &args).await?.export_entity(x.need("type")?, x.need("entityName")?).await
      },
    ),
    tool(
      "twx_invoke_service",
      "Run a service on a ThingWorx entity with inputs and return its result. It can change server data, so the \
       user approves each call.",
      schema(
        json!({
          "env": env, "type": ty, "entityName": s, "serviceName": s,
          "inputs": { "type": "object", "additionalProperties": {}, "description": "Service inputs by parameter name." },
        }),
        &["type", "entityName", "serviceName"],
      ),
      Risk::Destructive,
      |a, args, _| async move {
        let x = Args(&args);
        let inputs = x.object("inputs")?;
        client(&a, &args)
          .await?
          .execute_service(collection_name(x.need("type")?), x.need("entityName")?, x.need("serviceName")?, &inputs)
          .await
      },
    ),
  ]
}
