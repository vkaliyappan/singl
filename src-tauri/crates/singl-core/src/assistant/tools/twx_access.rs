//! Permission inspection tools: what an entity's rules say, and whether a
//! user may do a thing. Both only read.

use serde_json::json;

use super::twx::client;
use super::{Args, Risk, Tool, schema, ser, tool};
use crate::twx::permissions;

pub fn tools() -> Vec<Tool> {
  let env = json!({ "type": "string", "description": "Environment name from Settings. Default: the one on screen, else the first enabled." });
  let ty = json!({ "type": "string", "description": "Entity type, e.g. \"Thing\", \"ThingTemplate\", \"Mashup\", \"Group\"." });
  let s = json!({ "type": "string" });

  vec![
    tool(
      "twx_entity_permissions",
      "Run-time (per service/property/event, with the \"*\" entity-wide rules), design-time and visibility permissions of a \
       ThingWorx entity, as rules of principal (User/Group/Organization), isPermitted and action. Read only.",
      schema(json!({ "env": env, "type": ty, "entityName": s }), &["type", "entityName"]),
      Risk::Read,
      |a, args, _| async move {
        let c = client(&a, &args).await?;
        let x = Args(&args);
        ser(&permissions::entity_permissions(&c, x.need("type")?, x.need("entityName")?).await?)
      },
    ),
    tool(
      "twx_check_permission",
      "Can a user do an action on a ThingWorx entity? Resolves the user's groups (nested too) and evaluates the entity's \
       run-time rules (member override, then entity-wide, user rule before group rules, deny before allow), returning the \
       verdict and the rule that decided it. Collection-level permissions are not evaluated. Read only.",
      schema(
        json!({
          "env": env,
          "type": ty,
          "entityName": s,
          "user": { "type": "string", "description": "User name." },
          "action": { "type": "string", "enum": permissions::RUNTIME_ACTIONS },
          "member": { "type": "string", "description": "Service, property or event name the action targets. Omit for the entity as a whole." }
        }),
        &["type", "entityName", "user", "action"],
      ),
      Risk::Read,
      |a, args, _| async move {
        let c = client(&a, &args).await?;
        let x = Args(&args);
        ser(&permissions::check_permission(&c, x.need("type")?, x.need("entityName")?, x.need("user")?, x.need("action")?, x.str("member")).await?)
      },
    ),
  ]
}
