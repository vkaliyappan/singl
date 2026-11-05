#[derive(Debug, thiserror::Error)]
pub enum CoreError {
  #[error("database error: {0}")]
  Db(#[from] sqlx::Error),
  #[error("migration error: {0}")]
  Migrate(#[from] sqlx::migrate::MigrateError),
  #[error("io error: {0}")]
  Io(#[from] std::io::Error),
  #[error("{0}")]
  NotFound(String),
  #[error("{0}")]
  Invalid(String),
  /// A `git` command failed; the message is its stderr.
  #[error("{0}")]
  Git(String),
  /// A ThingWorx call failed. `status` is the HTTP status, 0 when no response came back.
  #[error("{message}")]
  Twx { status: u16, message: String },
  #[error("cancelled")]
  Cancelled,
}

impl CoreError {
  /// Stable machine-readable code the UI can branch on.
  pub fn code(&self) -> &'static str {
    match self {
      CoreError::Db(_) => "db",
      CoreError::Migrate(_) => "migrate",
      CoreError::Io(_) => "io",
      CoreError::NotFound(_) => "not_found",
      CoreError::Invalid(_) => "invalid",
      CoreError::Git(_) => "git",
      CoreError::Twx { .. } => "twx",
      CoreError::Cancelled => "cancelled",
    }
  }
}

pub type Result<T, E = CoreError> = std::result::Result<T, E>;
