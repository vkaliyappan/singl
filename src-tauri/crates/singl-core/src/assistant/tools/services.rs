//! Assistant tools: services. ThingWorx services on an environment: find
//! entities, read their service definitions, run a service, and keep saved
//! service calls (presets) like the TWX Services page does.

use serde_json::{Value, json};

use super::{Args, Risk, Tool, schema, ser, tool, twx};
use crate::db::service_presets::{self, PresetInput};
use crate::twx::api::collection_name;
use crate::twx::projects;
use crate::{CoreError, Result};

/// Errors on a blank required argument, as the TWX Services page does.
fn required<'a>(value: &'a str, name: &str) -> Result<&'a str> {
  if value.trim().is_empty() { Err(CoreError::Invalid(format!("{name} is required"))) } else { Ok(value) }
}

pub fn tools() -> Vec<Tool> {
  let env = || json!({ "type": "string", "description": "Environment name from Settings. Default: the one on screen, else the first enabled." });
  let text = |desc: &str| json!({ "type": "string", "description": desc });
  let collection = || {
    text(
      "REST collection of the entity, e.g. \"Things\" or \"ThingTemplates\" (singular types like \"Thing\" also work).",
    )
  };
  let entity_name = || text("Name of the entity, e.g. \"MyThing\".");
  let service_name = || text("Name of the service, e.g. \"GetStatus\".");

  vec![
    tool(
      "service_search",
      "Entities of one type on a ThingWorx server whose names match a mask. Use it to find the exact name of a Thing or other entity before looking at its services.",
      schema(
        json!({
          "env": env(),
          "type": text("Entity type, e.g. \"Thing\", \"ThingTemplate\"."),
          "nameMask": text("Name filter with * wildcards. Default \"*\"."),
        }),
        &["type"],
      ),
      Risk::Read,
      |a, args, _| async move {
        let x = Args(&args);
        let entity_type = required(x.need("type")?, "type")?;
        let env = twx::resolve_env(&a, &args).await?;
        let client = projects::connect(&a.pool().await, &env).await?;
        ser(&client.search_entities(entity_type, x.str("nameMask").unwrap_or("*")).await?)
      },
    ),
    tool(
      "service_definitions",
      "The services of one ThingWorx entity: each name, its parameters and result type. Use it before service_execute to learn the inputs.",
      schema(
        json!({
          "env": env(),
          "collection": collection(),
          "entityName": entity_name(),
        }),
        &["collection", "entityName"],
      ),
      Risk::Read,
      |a, args, _| async move {
        let x = Args(&args);
        let collection = required(x.need("collection")?, "collection")?;
        let entity = required(x.need("entityName")?, "entityName")?;
        let env = twx::resolve_env(&a, &args).await?;
        let client = projects::connect(&a.pool().await, &env).await?;
        ser(&client.service_definitions(collection_name(collection), entity).await?)
      },
    ),
    tool(
      "service_execute",
      "Run a service on a ThingWorx entity with the given inputs and return its JSON reply as text. It can change server data. Asks the user first.",
      schema(
        json!({
          "env": env(),
          "collection": collection(),
          "entityName": entity_name(),
          "serviceName": service_name(),
          "inputs": { "type": "object", "additionalProperties": {}, "description": "Service inputs by parameter name. Default: none." },
        }),
        &["collection", "entityName", "serviceName"],
      ),
      Risk::Destructive,
      |a, args, _| async move {
        let x = Args(&args);
        let collection = required(x.need("collection")?, "collection")?;
        let entity = required(x.need("entityName")?, "entityName")?;
        let service = required(x.need("serviceName")?, "serviceName")?;
        let inputs = x.object("inputs")?;
        let env = twx::resolve_env(&a, &args).await?;
        let client = projects::connect(&a.pool().await, &env).await?;
        client.execute_service(collection_name(collection), entity, service, &inputs).await
      },
    ),
    tool(
      "service_presets_list",
      "Saved service calls (presets) from singl's TWX Services page: name, environment, entity, service, inputs and last output.",
      schema(json!({}), &[]),
      Risk::Read,
      |a, _, _| async move { ser(&service_presets::list(&a.pool().await).await?) },
    ),
    tool(
      "service_preset_save",
      "Create or update a saved service call (preset) in singl. Give id to update one; otherwise a new preset is made. Returns its id.",
      schema(
        json!({
          "id": { "type": "integer", "description": "Preset to update. Omit to create one." },
          "name": text("Preset name."),
          "env": env(),
          "entityType": text("Entity type, e.g. \"Thing\"."),
          "entityName": entity_name(),
          "serviceName": service_name(),
          "inputs": text("Service inputs as JSON text, e.g. {\"name\":\"x\"}."),
          "output": text("Last output to keep with the preset."),
          "outputType": text("Type of the saved output, e.g. \"json\" or \"text\"."),
        }),
        &["name", "entityType", "entityName", "serviceName"],
      ),
      Risk::Write,
      |a, args, _| async move {
        let x = Args(&args);
        let env = twx::resolve_env(&a, &args).await?;
        let input = PresetInput {
          id: args.get("id").and_then(Value::as_i64),
          name: x.need("name")?.into(),
          environment: env,
          entity_type: x.need("entityType")?.into(),
          entity_name: x.need("entityName")?.into(),
          service_name: x.need("serviceName")?.into(),
          inputs: x.str("inputs").map(String::from),
          output: x.str("output").map(String::from),
          output_type: x.str("outputType").map(String::from),
        };
        let id = service_presets::save(&a.pool().await, &input).await?;
        Ok(format!("Saved preset {id}."))
      },
    ),
    tool(
      "service_preset_delete",
      "Delete a saved service call (preset) from singl by id. Asks the user first.",
      schema(json!({ "id": { "type": "integer", "description": "Preset id from service_presets_list." } }), &["id"]),
      Risk::Destructive,
      |a, args, _| async move {
        let id = args
          .get("id")
          .and_then(Value::as_i64)
          .ok_or_else(|| CoreError::Invalid("Missing required argument \"id\".".into()))?;
        service_presets::delete(&a.pool().await, id).await?;
        Ok(format!("Deleted preset {id}."))
      },
    ),
  ]
}
