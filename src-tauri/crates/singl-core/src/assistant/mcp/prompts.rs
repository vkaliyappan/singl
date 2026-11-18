//! MCP prompts: ready-made requests for ThingWorx work. Each embeds the code
//! it is about as a `resource` message, so the client needs no extra call.

use serde_json::{Value, json};

use super::resources::{ResUri, read_entity, read_service};
use crate::assistant::Assistant;
use crate::{CoreError, Result};

/// `(name, description, [(argument, description, required)])`.
const PROMPTS: &[(&str, &str, &[(&str, &str, bool)])] = &[
  (
    "review-service",
    "Review one exported ThingWorx service for bugs, ThingWorx pitfalls and readability.",
    &[("env", "Environment name", true), ("entity", "Entity name", true), ("service", "Service name", true)],
  ),
  (
    "debug-service",
    "Work out why a ThingWorx service fails or returns the wrong result.",
    &[
      ("env", "Environment name", true),
      ("entity", "Entity name", true),
      ("service", "Service name", true),
      ("inputs", "The inputs it was called with", false),
      ("error", "The error or wrong result seen", false),
    ],
  ),
  (
    "deploy-checklist",
    "Check that projects are ready to deploy to an environment.",
    &[("env", "Target environment name", true), ("projects", "Comma-separated project names", true)],
  ),
  (
    "explain-entity",
    "Explain what an exported ThingWorx entity does and how it is built.",
    &[("env", "Environment name", true), ("type", "Collection, e.g. Things", true), ("name", "Entity name", true)],
  ),
];

pub fn list() -> Value {
  let prompts: Vec<Value> = PROMPTS
    .iter()
    .map(|(name, description, args)| {
      let args: Vec<Value> = args
        .iter()
        .map(|(n, d, required)| json!({ "name": n, "description": d, "required": required }))
        .collect();
      json!({ "name": name, "description": description, "arguments": args })
    })
    .collect();
  json!({ "prompts": prompts })
}

fn arg<'a>(args: &'a Value, key: &str) -> Option<&'a str> {
  args.get(key).and_then(Value::as_str).map(str::trim).filter(|v| !v.is_empty())
}

fn need<'a>(args: &'a Value, key: &str) -> Result<&'a str> {
  arg(args, key).ok_or_else(|| CoreError::Invalid(format!("Missing required prompt argument \"{key}\".")))
}

fn text(role: &str, text: String) -> Value {
  json!({ "role": role, "content": { "type": "text", "text": text } })
}

fn embedded(uri: String, mime: &str, body: String) -> Value {
  json!({ "role": "user", "content": { "type": "resource", "resource": { "uri": uri, "mimeType": mime, "text": body } } })
}

fn reply(description: &str, messages: Vec<Value>) -> Value {
  json!({ "description": description, "messages": messages })
}

/// A service as an embedded resource, found in whichever collection holds the entity.
fn service_message(a: &Assistant, env: &str, entity: &str, service: &str) -> Result<Value> {
  let (kind, body) = read_service(a, env, None, entity, service)?;
  let uri = ResUri::Service { env: env.into(), kind, entity: entity.into(), service: service.into() }.to_uri();
  Ok(embedded(uri, "text/javascript", body))
}

pub fn get(a: &Assistant, name: &str, args: &Value) -> Result<Value> {
  match name {
    "review-service" => {
      let (env, entity, service) = (need(args, "env")?, need(args, "entity")?, need(args, "service")?);
      Ok(reply(
        &format!("Review {entity}.{service}"),
        vec![
          service_message(a, env, entity, service)?,
          text(
            "user",
            format!(
              "Review the ThingWorx service {entity}.{service} above ({env}). Look for bugs, unhandled nulls and \
               empty InfoTables, wrong base types, missing logging or error handling, slow loops over large \
               InfoTables, and anything that behaves differently in the ThingWorx Rhino runtime than in modern \
               JavaScript. List findings by severity with the line and a concrete fix."
            ),
          ),
        ],
      ))
    }
    "debug-service" => {
      let (env, entity, service) = (need(args, "env")?, need(args, "entity")?, need(args, "service")?);
      let inputs = arg(args, "inputs").unwrap_or("(not given)");
      let error = arg(args, "error").unwrap_or("(not given)");
      Ok(reply(
        &format!("Debug {entity}.{service}"),
        vec![
          service_message(a, env, entity, service)?,
          text(
            "user",
            format!(
              "The ThingWorx service {entity}.{service} ({env}) misbehaves.\n\nInputs:\n{inputs}\n\nError or wrong \
               result:\n{error}\n\nTrace the code step by step with those inputs, name the line that goes wrong and \
               why, and propose a fix. If you need live data, say which service or property to call and with what."
            ),
          ),
        ],
      ))
    }
    "deploy-checklist" => {
      let (env, projects) = (need(args, "env")?, need(args, "projects")?);
      Ok(reply(
        &format!("Deploy {projects} to {env}"),
        vec![text(
          "user",
          format!(
            "Prepare a deploy checklist for the project(s) {projects} to the environment {env}. Using singl's tools:\n\
             1. Check the exported entities are current (entity_run_times) and list what changed (compare_tree \
             against {env}).\n\
             2. Look for entities that depend on something outside the projects (dependency tools, if available).\n\
             3. Review changed services for risky edits (compare_content).\n\
             4. Note what needs a backup first (deploy_backup_deployment_files) and what needs a restart or a \
             connector update.\n\
             Report a checklist with each item marked ready, blocked or needs a decision. Do not deploy anything."
          ),
        )],
      ))
    }
    "explain-entity" => {
      let (env, kind, entity) = (need(args, "env")?, need(args, "type")?, need(args, "name")?);
      let (_, xml) = read_entity(a, env, Some(kind), entity)?;
      let uri = ResUri::Entity { env: env.into(), kind: kind.into(), name: entity.into() }.to_uri();
      Ok(reply(
        &format!("Explain {entity}"),
        vec![
          embedded(uri, "application/xml", xml),
          text(
            "user",
            format!(
              "Explain the ThingWorx entity {entity} ({kind}, {env}) above: what it is for, its template and \
               shapes, its key properties, services and subscriptions, and how they fit together. Keep it short \
               and point out anything unusual."
            ),
          ),
        ],
      ))
    }
    other => Err(CoreError::Invalid(format!("Unknown prompt: {other}"))),
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn lists_every_prompt_with_arguments() {
    let v = list();
    let names: Vec<&str> = v["prompts"].as_array().unwrap().iter().map(|p| p["name"].as_str().unwrap()).collect();
    assert_eq!(names, ["review-service", "debug-service", "deploy-checklist", "explain-entity"]);
    assert_eq!(v["prompts"][1]["arguments"].as_array().unwrap().len(), 5);
  }

  #[test]
  fn arguments_are_trimmed_and_required() {
    let args = json!({ "env": " dev ", "blank": "  " });
    assert_eq!(need(&args, "env").unwrap(), "dev");
    assert!(need(&args, "blank").is_err());
    assert!(need(&args, "missing").is_err());
  }
}
