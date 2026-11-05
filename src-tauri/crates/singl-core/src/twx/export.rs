//! Entity export: each configured project's entities, one formatted XML file
//! each. singl-web's CLI read the project list from `manifest.twx.json`; here
//! it comes from the projects configured in Settings, whose "exports" field
//! is the manifest's.

use std::path::{Path, PathBuf};

use serde::Serialize;
use tokio_util::sync::CancellationToken;

use super::api::{Client, TwxEntity, collection_name};
use super::projects::DeployProject;
use super::xmlformat::format_entity_xml;
use crate::{CoreError, Result};

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportResult {
  pub projects_processed: u32,
  pub entities_exported: u32,
  pub entities_skipped: u32,
  pub errors: Vec<String>,
}

/// The entities `exports` selects: `["all"]` is everything, otherwise entity
/// types, singular ("Thing") or as Settings shows them, plural ("Things").
pub fn filter_entities(all: Vec<TwxEntity>, exports: &[String]) -> Vec<TwxEntity> {
  match exports {
    [] => Vec::new(),
    [only] if only == "all" => all,
    _ => all
      .into_iter()
      .filter(|e| exports.iter().any(|x| *x == e.entity_type || x == collection_name(&e.entity_type)))
      .collect(),
  }
}

/// `<output>/WindchillClients/Thingworx/<alias>/<project>/<Collection>/<name>.xml`.
pub fn entity_path(output: &Path, alias: &str, project: &str, entity_type: &str, name: &str) -> PathBuf {
  output
    .join("WindchillClients")
    .join("Thingworx")
    .join(alias)
    .join(project)
    .join(collection_name(entity_type))
    .join(format!("{name}.xml"))
}

pub async fn run(
  client: &Client,
  projects: &[DeployProject],
  output: &Path,
  dry_run: bool,
  cancel: &CancellationToken,
  log: &mut (dyn FnMut(String) + Send),
) -> Result<ExportResult> {
  let mut result = ExportResult::default();

  for proj in projects {
    let twx_name = &proj.project_name;
    let mut candidates = vec![twx_name.clone()];
    if !proj.alias.is_empty() && proj.alias != *twx_name {
      candidates.push(proj.alias.clone());
    }

    let mut found = None;
    for candidate in &candidates {
      if cancel.is_cancelled() {
        return Err(CoreError::Cancelled);
      }
      log(format!("[{candidate}] Fetching entity list for {candidate}..."));
      match client.project_entities(candidate).await {
        Ok(entities) => {
          found = Some((candidate.clone(), entities));
          break;
        }
        Err(CoreError::Twx { status: 404, .. }) => log(format!("[{candidate}] Not found, trying next candidate...")),
        Err(err) => {
          log(format!("[{candidate}] Failed to list entities for {candidate}: {err}"));
          result.errors.push(format!("Project {candidate}: {err}"));
          break;
        }
      }
    }
    let Some((used, entities)) = found else { continue };

    let total = entities.len();
    let filtered = filter_entities(entities, &proj.exports);
    log(format!("[{}] Found {total} entities (exporting {})", proj.alias, filtered.len()));

    for TwxEntity { name, entity_type } in filtered {
      if cancel.is_cancelled() {
        return Err(CoreError::Cancelled);
      }
      let file = entity_path(output, &proj.alias, twx_name, &entity_type, &name);
      if dry_run {
        log(format!("[{used}] (dry-run) Would export {entity_type}/{name} → {}", file.display()));
        result.entities_exported += 1;
        continue;
      }
      log(format!("[{used}] Exporting {entity_type}/{name}..."));
      let written = async {
        let xml = format_entity_xml(&client.export_entity(&entity_type, &name).await?);
        std::fs::create_dir_all(file.parent().expect("has a parent"))?;
        std::fs::write(&file, xml)?;
        Ok::<_, CoreError>(())
      }
      .await;
      match written {
        Ok(()) => result.entities_exported += 1,
        Err(err) => {
          log(format!("[{used}] Failed to export {entity_type}/{name}: {err}"));
          result.entities_skipped += 1;
          result.errors.push(format!("{used}/{entity_type}/{name}: {err}"));
        }
      }
    }

    result.projects_processed += 1;
    log(format!(
      "[{used}] Done. {} exported so far, {} skipped.",
      result.entities_exported, result.entities_skipped
    ));
  }
  Ok(result)
}

#[cfg(test)]
mod tests {
  use super::*;

  fn entity(name: &str, t: &str) -> TwxEntity {
    TwxEntity { name: name.into(), entity_type: t.into() }
  }

  #[test]
  fn filters_and_paths() {
    let all = vec![entity("A", "Thing"), entity("B", "Mashup")];
    assert_eq!(filter_entities(all.clone(), &["all".into()]).len(), 2);
    assert_eq!(filter_entities(all.clone(), &["Mashup".into()])[0].name, "B");
    assert_eq!(filter_entities(all.clone(), &["Things".into()])[0].name, "A");
    assert!(filter_entities(all, &[]).is_empty());
    let p = entity_path(Path::new("/o"), "App", "P.X", "Thing", "T1");
    assert!(p.ends_with("WindchillClients/Thingworx/App/P.X/Things/T1.xml"));
  }
}
