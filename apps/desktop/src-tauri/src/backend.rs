mod error;
mod manager;
mod process_group;

pub(crate) use manager::Backend;

use error::{BackendError, BackendErrorKind};
use manager::BackendStatus;
use tauri::State;

/// Runs a lifecycle operation off the caller's thread.
///
/// Every operation holds the lifecycle mutex across blocking waits — startup
/// observation, the termination grace period — so none of them may run on a
/// thread that the UI depends on.
async fn run_blocking<F, T>(operation: F) -> Result<T, BackendError>
where
    F: FnOnce() -> T + Send + 'static,
    T: Send + 'static,
{
    tauri::async_runtime::spawn_blocking(operation)
        .await
        .map_err(|error| {
            BackendError::new(
                BackendErrorKind::Internal,
                format!("failed to join backend lifecycle task: {error}"),
            )
        })
}

#[tauri::command]
pub(crate) async fn start_backend(
    backend: State<'_, Backend>,
) -> Result<BackendStatus, BackendError> {
    let backend = backend.inner().clone();
    run_blocking(move || backend.start()).await?
}

#[tauri::command]
pub(crate) async fn restart_backend(
    backend: State<'_, Backend>,
) -> Result<BackendStatus, BackendError> {
    let backend = backend.inner().clone();
    run_blocking(move || backend.restart()).await?
}

#[tauri::command]
pub(crate) async fn stop_backend(
    backend: State<'_, Backend>,
) -> Result<BackendStatus, BackendError> {
    let backend = backend.inner().clone();
    run_blocking(move || backend.stop()).await?
}

#[cfg(test)]
mod tests {
    use std::thread;

    use super::*;

    #[test]
    fn lifecycle_operations_run_off_the_caller_thread() {
        let caller = thread::current().id();

        let worker = tauri::async_runtime::block_on(run_blocking(|| thread::current().id()))
            .expect("blocking task should complete");

        assert_ne!(worker, caller);
    }
}
