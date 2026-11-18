//! Drift reports: which entities differ between two environments. Read only:
//! it lists entities and (optionally) exports them, nothing is written.

use std::collections::BTreeSet;
use std::sync::Arc;
use std::time::Instant;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::SqlitePool;
use tokio::sync::Semaphore;
use tokio::task::JoinSet;

use super::{Outcome, record_run};
use crate::db::now;
use crate::twx::api::Client;
use crate::twx::projects;
use crate::twx::xmlformat::format_entity_xml;
use crate::{CoreError, Result};

/// Exports compared at once, and the most entities whose XML one report compares.
const PARALLEL_EXPORTS: usize = 6;
const MAX_XML_COMPARES: usize = 600;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DriftRequest {
  pub env_a: String,
  pub env_b: String,
  /// Empty = every project on either server.
  #[serde(default)]
  pub projects: Vec<String>,
  /// Also compare each shared entity's normalised exported XML.
  #[serde(default)]
  pub compare_xml: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "camelCase")]
pub struct DriftEntity {
  pub project: String,
  pub entity_type: String,
  pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DriftReport {
  pub run_id: String,
  pub env_a: String,
  pub env_b: String,
  pub projects: Vec<String>,
  pub compare_xml: bool,
  pub started_at: i64,
  pub duration_ms: u64,
  pub only_a: Vec<DriftEntity>,
  pub only_b: Vec<DriftEntity>,
  pub different: Vec<DriftEntity>,
  pub same: Vec<DriftEntity>,
  /// Present on both, XML not compared (comparison off, or over the cap).
  pub unchecked: Vec<DriftEntity>,
  pub warnings: Vec<String>,
}

impl DriftReport {
  pub fn drifted(&self) -> usize {
    self.only_a.len() + self.only_b.len() + self.different.len()
  }

  pub fn summary(&self) -> String {
    let mut s = format!(
      "{} only in {}, {} only in {}, {} different, {} same",
      self.only_a.len(),
      self.env_a,
      self.only_b.len(),
      self.env_b,
      self.different.len(),
      self.same.len()
    );
    if !self.unchecked.is_empty() {
      s += &format!(", {} not compared", self.unchecked.len());
    }
    s
  }
}

type Key = (String, String, String);

async fn entities_of(client: &Client, project: &str) -> std::result::Result<BTreeSet<Key>, String> {
  let rows = client.project_entities(project).await.map_err(|e| e.to_string())?;
  Ok(rows.into_iter().map(|e| (project.to_string(), e.entity_type, e.name)).collect())
}

fn entity((project, entity_type, name): Key) -> DriftEntity {
  DriftEntity { project, entity_type, name }
}

/// Splits what each side has into only-in-A, only-in-B and shared.
pub fn partition(a: &BTreeSet<Key>, b: &BTreeSet<Key>) -> (Vec<DriftEntity>, Vec<DriftEntity>, Vec<DriftEntity>) {
  let only_a = a.difference(b).cloned().map(entity).collect();
  let only_b = b.difference(a).cloned().map(entity).collect();
  let both = a.intersection(b).cloned().map(entity).collect();
  (only_a, only_b, both)
}

/// Compares two environments and stores the report.
pub async fn run(pool: &SqlitePool, req: &DriftRequest) -> Result<DriftReport> {
  if req.env_a.trim().is_empty() || req.env_b.trim().is_empty() {
    return Err(CoreError::Invalid("Choose two environments to compare.".into()));
  }
  if req.env_a == req.env_b {
    return Err(CoreError::Invalid("Choose two different environments.".into()));
  }
  let started_at = now();
  let timer = Instant::now();
  let client_a = projects::connect(pool, &req.env_a).await?;
  let client_b = projects::connect(pool, &req.env_b).await?;

  let mut warnings = Vec::new();
  let project_names: Vec<String> = if req.projects.is_empty() {
    let mut all: BTreeSet<String> = client_a.all_projects().await?.into_iter().collect();
    all.extend(client_b.all_projects().await?);
    all.into_iter().collect()
  } else {
    req.projects.clone()
  };

  let (mut set_a, mut set_b) = (BTreeSet::new(), BTreeSet::new());
  for project in &project_names {
    let (a, b) = (entities_of(&client_a, project).await, entities_of(&client_b, project).await);
    match (a, b) {
      (Ok(a), Ok(b)) => {
        set_a.extend(a);
        set_b.extend(b);
      }
      // A project that exists on one server only reads as empty on the other.
      (Ok(a), Err(e)) => {
        warnings.push(format!("{project} on {}: {e}", req.env_b));
        set_a.extend(a);
      }
      (Err(e), Ok(b)) => {
        warnings.push(format!("{project} on {}: {e}", req.env_a));
        set_b.extend(b);
      }
      (Err(a), Err(b)) => warnings.push(format!("{project}: {a}; {b}")),
    }
  }
  let (only_a, only_b, both) = partition(&set_a, &set_b);

  let (mut same, mut different) = (Vec::new(), Vec::new());
  let mut unchecked: Vec<DriftEntity>;
  if req.compare_xml {
    let (to_compare, rest) = if both.len() > MAX_XML_COMPARES {
      warnings.push(format!("Only the first {MAX_XML_COMPARES} shared entities had their XML compared; narrow the projects."));
      let mut both = both;
      let rest = both.split_off(MAX_XML_COMPARES);
      (both, rest)
    } else {
      (both, Vec::new())
    };
    unchecked = rest;
    let permits = Arc::new(Semaphore::new(PARALLEL_EXPORTS));
    let mut tasks = JoinSet::new();
    for e in to_compare {
      let (a, b, permits) = (client_a.clone(), client_b.clone(), permits.clone());
      tasks.spawn(async move {
        let _permit = permits.acquire_owned().await;
        let (kind, name) = (e.entity_type.clone(), e.name.clone());
        let xml = async {
          let left = a.export_entity(&kind, &name).await?;
          let right = b.export_entity(&kind, &name).await?;
          Ok::<_, CoreError>((format_entity_xml(&left), format_entity_xml(&right)))
        };
        (e, xml.await)
      });
    }
    while let Some(done) = tasks.join_next().await {
      let (e, outcome) = done.map_err(|e| CoreError::Invalid(format!("Drift comparison stopped: {e}")))?;
      match outcome {
        Ok((l, r)) if l == r => same.push(e),
        Ok(_) => different.push(e),
        Err(err) => {
          warnings.push(format!("{} {}: {err}", e.entity_type, e.name));
          unchecked.push(e);
        }
      }
    }
    for list in [&mut same, &mut different, &mut unchecked] {
      list.sort();
    }
  } else {
    unchecked = both;
  }

  let mut report = DriftReport {
    run_id: String::new(),
    env_a: req.env_a.clone(),
    env_b: req.env_b.clone(),
    projects: req.projects.clone(),
    compare_xml: req.compare_xml,
    started_at,
    duration_ms: timer.elapsed().as_millis() as u64,
    only_a,
    only_b,
    different,
    same,
    unchecked,
    warnings,
  };
  let name = format!("{} vs {}", report.env_a, report.env_b);
  let status = if report.drifted() == 0 { "same" } else { "drift" };
  let result = serde_json::to_value(&report).unwrap_or(Value::Null);
  report.run_id =
    record_run(pool, "drift", &format!("{}|{}", report.env_a, report.env_b), &name, status, &report.summary(), &result, started_at, report.duration_ms as i64)
      .await?;
  Ok(report)
}

/// Runs a drift report for a schedule: any drift counts as a failure.
pub async fn run_scheduled(pool: &SqlitePool, req: &DriftRequest) -> Result<Outcome> {
  let report = run(pool, req).await?;
  Ok(Outcome {
    ok: report.drifted() == 0,
    message: format!("{} vs {}: {}", report.env_a, report.env_b, report.summary()),
    ref_type: "driftReport".into(),
    ref_id: report.run_id,
  })
}

/// Both environments' normalised XML for one entity (empty where it is missing), for a diff.
pub async fn entity_xml(pool: &SqlitePool, env_a: &str, env_b: &str, entity_type: &str, name: &str) -> Result<(String, String)> {
  let one = |env: String| async move {
    let client = projects::connect(pool, &env).await?;
    Ok::<_, CoreError>(match client.export_entity(entity_type, name).await {
      Ok(xml) => format_entity_xml(&xml),
      Err(CoreError::Twx { status, .. }) if status == 404 || status == 500 => String::new(),
      Err(e) => return Err(e),
    })
  };
  Ok((one(env_a.to_string()).await?, one(env_b.to_string()).await?))
}

#[cfg(test)]
mod tests {
  use super::*;

  fn key(p: &str, t: &str, n: &str) -> Key {
    (p.into(), t.into(), n.into())
  }

  #[test]
  fn partitions_entity_sets() {
    let a: BTreeSet<Key> = [key("P", "Thing", "A"), key("P", "Thing", "B"), key("P", "Thing", "C")].into();
    let b: BTreeSet<Key> = [key("P", "Thing", "B"), key("P", "Thing", "C"), key("P", "Thing", "D")].into();
    let (only_a, only_b, both) = partition(&a, &b);
    assert_eq!(only_a.iter().map(|e| e.name.as_str()).collect::<Vec<_>>(), ["A"]);
    assert_eq!(only_b.iter().map(|e| e.name.as_str()).collect::<Vec<_>>(), ["D"]);
    assert_eq!(both.len(), 2);
  }

  #[test]
  fn same_name_in_another_type_is_a_different_entity() {
    let a: BTreeSet<Key> = [key("P", "Thing", "X")].into();
    let b: BTreeSet<Key> = [key("P", "ThingTemplate", "X")].into();
    let (only_a, only_b, both) = partition(&a, &b);
    assert_eq!((only_a.len(), only_b.len(), both.len()), (1, 1, 0));
  }
}
