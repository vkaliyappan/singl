use serde::Serialize;
use singl_core::CoreError;

/// The one error shape commands return to the UI.
#[derive(Debug, Serialize)]
pub struct IpcError {
  pub code: &'static str,
  pub message: String,
}

impl From<CoreError> for IpcError {
  fn from(err: CoreError) -> Self {
    Self { code: err.code(), message: err.to_string() }
  }
}

impl From<std::io::Error> for IpcError {
  fn from(err: std::io::Error) -> Self {
    CoreError::from(err).into()
  }
}

pub type IpcResult<T> = Result<T, IpcError>;
