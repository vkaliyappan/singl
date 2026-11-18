//! Assistant tools: the entity dependency graph, from the exported entity
//! XML (no server calls). See [`crate::twx::deps`].

use std::sync::Arc;

use serde::Serialize;
use serde_json::json;

use super::{Args, Risk, Tool, schema, tool, twx};
use crate::assistant::Assistant;
use crate::twx::deps::{self, Direction, Index};
use crate::twx::run_times::safe_env;
use crate::workspace::PathKind;
use crate::{CoreError, Result};

const ENV: &str = "Environment name from Settings. Default: the one on screen, else the first enabled.";
const TYPE: &str =
  "Entity type to disambiguate a name shared by two entities, e.g. Thing, ThingTemplate, ThingShape, DataShape, Mashup.";

/// The dependency index of the tool's environment, built off the async runtime.
async fn load(a: &Arc<Assistant>, args: &serde_json::Value) -> Result<Arc<Index>> {
  let env = twx::resolve_env(a, args).await?;
  let base = a
    .workspace()
    .resolve(PathKind::TwxEntities)
    .ok_or_else(|| CoreError::Invalid("No workspace folder is set. Choose one in Settings.".into()))?;
  tokio::task::spawn_blocking(move || deps::index(&base, &safe_env(&env)))
    .await
    .map_err(|e| CoreError::Invalid(e.to_string()))?
}

fn compact<T: Serialize>(v: &T) -> Result<String> {
  serde_json::to_string(v).map_err(|e| CoreError::Invalid(e.to_string()))
}

pub fn tools() -> Vec<Tool> {
  let s = |desc: &str| json!({ "type": "string", "description": desc });
  let n = |desc: &str| json!({ "type": "integer", "description": desc });
  let env = || s(ENV);

  vec![
    tool(
      "entity_dependencies",
      "What an exported ThingWorx entity depends on (out), what depends on it (in), or both, from the local exported XML: template and shape inheritance, datashapes, calls found in service code (with the member called), mashup bindings, project membership, value stream and persistence provider. Works offline. Approximate: dynamic lookups like Things[name] are not seen. Result: nodes (centre first, then nearest first) and edges {from, to, kind, member, fromMember}.",
      schema(
        json!({
          "env": env(),
          "entity": s("Entity name, case-insensitive."),
          "type": s(TYPE),
          "direction": { "type": "string", "enum": ["in", "out", "both"], "description": "Default both." },
          "depth": n("Hops to follow, 1-5. Default 1."),
          "kinds": { "type": "array", "items": { "type": "string", "enum": deps::KINDS }, "description": "Only these edge kinds. Default all." },
          "limit": n("Most nodes to return. Default 100."),
        }),
        &["entity"],
      ),
      Risk::Read,
      |a, args, _| async move {
        let x = Args(&args);
        let index = load(&a, &args).await?;
        let direction = Direction::parse(x.str("direction").unwrap_or("both"))?;
        let depth = x.i64("depth").unwrap_or(1).clamp(1, 5) as usize;
        let limit = x.i64("limit").unwrap_or(100).clamp(1, 1000) as usize;
        compact(&index.dependencies(x.need("entity")?, x.str("type"), direction, depth, &x.strings("kinds"), limit)?)
      },
    ),
    tool(
      "entity_service_callers",
      "Who calls a service of an exported ThingWorx entity: the scripts (with the calling service) and mashups that name the entity and that service, from the local exported XML. For a template or thing shape it also lists callers of the things built on it (`via`). Approximate: only literal Things[\"X\"].Service() style references are seen.",
      schema(
        json!({ "env": env(), "entity": s("Entity name, case-insensitive."), "type": s(TYPE), "service": s("Service name.") }),
        &["entity", "service"],
      ),
      Risk::Read,
      |a, args, _| async move {
        let x = Args(&args);
        let index = load(&a, &args).await?;
        compact(&index.service_callers(x.need("entity")?, x.str("type"), x.need("service")?)?)
      },
    ),
    tool(
      "entity_unused",
      "Exported ThingWorx entities that nothing in the exported XML references, optionally of one type: a cleanup lead, not proof. Heuristic: entities used through dynamic lookups, REST, schedulers or as entry points (mashups, services called from outside) show up as unused.",
      schema(
        json!({
          "env": env(),
          "type": s("Entity type, e.g. Thing, ThingTemplate, ThingShape, DataShape, Mashup. Default every type."),
          "limit": n("Most entities to list. Default 200."),
        }),
        &[],
      ),
      Risk::Read,
      |a, args, _| async move {
        let x = Args(&args);
        let index = load(&a, &args).await?;
        let mut unused = index.unused(x.str("type"));
        unused.nodes.truncate(x.i64("limit").unwrap_or(200).clamp(1, 2000) as usize);
        compact(&unused)
      },
    ),
  ]
}
