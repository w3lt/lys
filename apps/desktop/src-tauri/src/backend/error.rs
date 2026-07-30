use std::fmt;

use serde::Serialize;

/// Why a backend lifecycle operation failed.
///
/// The frontend is expected to branch on `kind`; `message` carries the
/// diagnostic detail and is not a stable contract.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum BackendErrorKind {
    /// The application is exiting. No further backend may be started.
    ShuttingDown,
    /// This build cannot launch a backend at all.
    LaunchUnavailable,
    /// The backend process could not be spawned or registered.
    Spawn,
    /// The backend exited during the startup observation window.
    Startup,
    /// The backend process group could not be inspected.
    Inspect,
    /// The backend could not be stopped. Ownership is retained, so the caller
    /// may retry the same operation.
    Cleanup,
    /// A lifecycle invariant was violated. This is a bug in the manager.
    Internal,
}

/// A lifecycle failure as seen by the frontend.
///
/// Serializes as `{ "kind": "cleanup", "message": "..." }`.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BackendError {
    pub(crate) kind: BackendErrorKind,
    pub(crate) message: String,
}

impl BackendError {
    pub(crate) fn new(kind: BackendErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }

    pub(crate) fn shutting_down() -> Self {
        Self::new(BackendErrorKind::ShuttingDown, "backend is shutting down")
    }
}

impl fmt::Display for BackendError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for BackendError {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn errors_expose_a_machine_readable_kind_to_the_frontend() {
        let error = BackendError::shutting_down();

        assert_eq!(
            serde_json::to_value(&error).expect("error should serialize"),
            serde_json::json!({
                "kind": "shuttingDown",
                "message": "backend is shutting down",
            }),
        );
    }

    #[test]
    fn display_reports_the_diagnostic_message() {
        let error = BackendError::new(BackendErrorKind::Cleanup, "could not stop the group");

        assert_eq!(error.to_string(), "could not stop the group");
    }
}
