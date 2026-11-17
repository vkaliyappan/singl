//! Requests that wait for an answer from the UI: approvals and UI actions.

use std::collections::HashMap;
use std::sync::Mutex;

use tokio::sync::oneshot;

pub struct Pending<T> {
  map: Mutex<HashMap<String, oneshot::Sender<T>>>,
}

impl<T> Default for Pending<T> {
  fn default() -> Self {
    Self { map: Mutex::new(HashMap::new()) }
  }
}

impl<T> Pending<T> {
  pub fn open(&self) -> (String, oneshot::Receiver<T>) {
    let id = uuid::Uuid::new_v4().to_string();
    let (tx, rx) = oneshot::channel();
    self.map.lock().unwrap_or_else(|e| e.into_inner()).insert(id.clone(), tx);
    (id, rx)
  }

  /// False when nothing waits on `id` any more.
  pub fn resolve(&self, id: &str, value: T) -> bool {
    match self.map.lock().unwrap_or_else(|e| e.into_inner()).remove(id) {
      Some(tx) => tx.send(value).is_ok(),
      None => false,
    }
  }

  pub fn forget(&self, id: &str) {
    self.map.lock().unwrap_or_else(|e| e.into_inner()).remove(id);
  }
}
