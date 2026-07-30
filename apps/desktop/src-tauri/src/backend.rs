mod manager;
mod process_group;

pub(crate) use manager::Backend;

use manager::BackendStatus;
use tauri::State;

async fn run_blocking<F, T>(operation: F) -> Result<T, String>
where
    F: FnOnce() -> T + Send + 'static,
    T: Send + 'static,
{
    tauri::async_runtime::spawn_blocking(operation)
        .await
        .map_err(|error| format!("failed to join backend lifecycle task: {error}"))
}

#[tauri::command]
pub(crate) async fn start_backend(backend: State<'_, Backend>) -> Result<BackendStatus, String> {
    let backend = backend.inner().clone();
    run_blocking(move || backend.start()).await?
}

#[tauri::command]
pub(crate) async fn restart_backend(backend: State<'_, Backend>) -> Result<BackendStatus, String> {
    let backend = backend.inner().clone();
    run_blocking(move || backend.restart()).await?
}

#[tauri::command]
pub(crate) async fn stop_backend(backend: State<'_, Backend>) -> Result<BackendStatus, String> {
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
