//! Registry for long-running jobs (exports, deploys, git, flow runs). Each job
//! gets an id and a [`CancellationToken`]; progress goes out as [`JobEvent`]s
//! over whatever channel the caller owns (a Tauri `Channel` in the app).

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use serde::Serialize;
use serde_json::Value;
use tokio_util::sync::CancellationToken;

pub type JobId = String;

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum JobEvent {
  Log { line: String },
  Progress { done: u32, total: u32 },
  Item { value: Value },
  Done { summary: Value },
  Error { message: String },
}

#[derive(Debug, Clone, Default)]
pub struct JobRegistry {
  jobs: Arc<Mutex<HashMap<JobId, CancellationToken>>>,
}

impl JobRegistry {
  /// Registers a new job. Call [`JobRegistry::finish`] when it ends, or hold
  /// the returned [`JobGuard`] which does so on drop.
  pub fn start(&self) -> JobGuard {
    self.start_with_id(uuid::Uuid::new_v4().to_string())
  }

  /// Like [`JobRegistry::start`], under an id the caller picked, so the UI can
  /// cancel a call it is still awaiting.
  pub fn start_with_id(&self, id: JobId) -> JobGuard {
    let token = CancellationToken::new();
    self.lock().insert(id.clone(), token.clone());
    JobGuard { registry: self.clone(), id, token }
  }

  /// Trips the job's token. Returns false when no such job is running.
  pub fn cancel(&self, id: &str) -> bool {
    match self.lock().get(id) {
      Some(token) => {
        token.cancel();
        true
      }
      None => false,
    }
  }

  pub fn cancel_all(&self) {
    for token in self.lock().values() {
      token.cancel();
    }
  }

  pub fn finish(&self, id: &str) {
    self.lock().remove(id);
  }

  pub fn running(&self) -> Vec<JobId> {
    self.lock().keys().cloned().collect()
  }

  fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<JobId, CancellationToken>> {
    // A panic while holding the lock cannot leave the map half-updated.
    self.jobs.lock().unwrap_or_else(|e| e.into_inner())
  }
}

/// Runs `work` until it finishes or `token` trips, whichever comes first.
pub async fn until_cancelled<T>(
  token: &CancellationToken,
  work: impl std::future::Future<Output = crate::Result<T>>,
) -> crate::Result<T> {
  tokio::select! {
    result = work => result,
    () = token.cancelled() => Err(crate::CoreError::Cancelled),
  }
}

pub struct JobGuard {
  registry: JobRegistry,
  pub id: JobId,
  pub token: CancellationToken,
}

impl Drop for JobGuard {
  fn drop(&mut self) {
    self.registry.finish(&self.id);
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn cancel_and_finish() {
    let jobs = JobRegistry::default();
    let job = jobs.start();
    let id = job.id.clone();
    assert!(jobs.cancel(&id));
    assert!(job.token.is_cancelled());
    drop(job);
    assert!(!jobs.cancel(&id));
    assert!(jobs.running().is_empty());
  }
}
