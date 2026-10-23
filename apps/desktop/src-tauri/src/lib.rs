//! Tauri application wiring for the Lys desktop shell.
//!
//! This crate resolves the Lys home once at startup, registers commands, owns
//! the managed backend and vmo process state, and stops both processes during
//! application exit. Feature-specific command implementations live in the
//! `backend`, `settings`, `tools`, and `vmo` modules; `utils` resolves the Lys
//! home.

use std::thread;

use tauri::Manager;

use crate::utils::lys_home::LysHome;

mod backend;
mod settings;
mod tools;
mod utils;
mod vmo;

// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
#[tauri::command]
/// Returns the greeting used by the desktop command example.
///
/// The command has no side effects and formats the supplied name into a
/// human-readable string.
///
/// # Returns
///
/// The greeting for `name`.
fn greet(name: &str) -> String {
    format!("Hello, {name}! You've been greeted from Rust!")
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
/// Builds and runs the Tauri application.
///
/// The Lys home is resolved once from `LYS_HOME` before the builder runs, as
/// described by `LysHome::resolve`. If resolution fails, the error is written
/// to stderr and the process exits with status 1 before any window opens.
///
/// The builder registers the opener plugin, manages the resolved `LysHome`, one
/// mutex-protected `backend::Backend` resource, and one `vmo::Vmo` owner, and
/// exposes the backend, vmo, settings, and client tool commands to the
/// renderer. On `Exit`, the managed backend and vmo are stopped together, and
/// a failure or a killed vmo is reported to stderr without preventing the
/// process from finishing its exit handling. Exit waits for vmo, which can
/// take up to `vmo::VMO_STOP_TIMEOUT` while vmo deletes its VMs.
///
/// # Panics
///
/// Panics if Tauri cannot build the application context. This is an intentional
/// startup failure because the desktop shell cannot run without a valid Tauri
/// application.
pub fn run() {
    let lys_home = match LysHome::resolve() {
        Ok(lys_home) => lys_home,
        Err(error) => {
            eprintln!("Lys cannot start: {error}");
            std::process::exit(1);
        }
    };

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(lys_home)
        .manage(backend::Backend::default())
        .manage(vmo::Vmo::new(vmo::VMO_STOP_TIMEOUT))
        .invoke_handler(tauri::generate_handler![
            greet,
            backend::start_backend,
            backend::stop_backend,
            backend::get_backend_status,
            vmo::start_vmo,
            vmo::stop_vmo,
            vmo::get_vmo_status,
            vmo::get_vmo_health,
            settings::commands::load_settings,
            settings::commands::save_settings,
            tools::client_tools::list_tools,
            tools::get_current_time::get_current_time,
            tools::get_location::get_location,
            tools::read_text_file::read_text_file,
            tools::search_files::find_files
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(handle_run_event);
}

/// Handles one event of the running application: on `Exit`, it stops the
/// managed backend and vmo, and it leaves every other event to Tauri.
fn handle_run_event(app_handle: &tauri::AppHandle, event: tauri::RunEvent) {
    if let tauri::RunEvent::Exit = event {
        stop_runtime_processes_at_exit(app_handle);
    }
}

/// Stops the managed backend and vmo during application exit, writing each
/// failure and a killed vmo to stderr.
///
/// vmo can take up to [`vmo::VMO_STOP_TIMEOUT`] to delete its VMs, so its stop
/// runs on a scoped thread while the backend stops, rather than after it. The
/// call returns once both stops have ended.
fn stop_runtime_processes_at_exit(app_handle: &tauri::AppHandle) {
    let backend = app_handle.state::<backend::Backend>();
    let vmo = app_handle.state::<vmo::Vmo>().inner();
    let vmo_stop = thread::scope(|scope| {
        let vmo_stop = scope.spawn(|| vmo.stop());
        stop_backend_at_exit(&backend);
        vmo_stop.join()
    });
    if let Some(problem) = format_vmo_stop_problem_at_exit(vmo_stop) {
        eprintln!("{problem}");
    }
}

/// Stops the managed backend during application exit, writing a failure to
/// stderr.
fn stop_backend_at_exit(backend: &backend::Backend) {
    if let Err(error) = backend.stop() {
        eprintln!("Failed to stop backend during app exit: {error}");
    }
}

/// Formats what went wrong when vmo stopped during application exit, or
/// returns `None` when vmo exited within its stop timeout.
///
/// `stop` is the joined stop thread's result, whose outer error means that the
/// stop panicked.
fn format_vmo_stop_problem_at_exit(
    stop: thread::Result<Result<vmo::VmoStopOutcome, String>>,
) -> Option<String> {
    match stop {
        Ok(Ok(vmo::VmoStopOutcome::Stopped)) => None,
        Ok(Ok(vmo::VmoStopOutcome::Killed)) => Some(String::from(
            "vmo did not stop in time during app exit and was killed; it may have left VMs running",
        )),
        Ok(Err(error)) => Some(format!("Failed to stop vmo during app exit: {error}")),
        Err(_panic) => Some(String::from(
            "Failed to stop vmo during app exit: the stop panicked",
        )),
    }
}

#[cfg(test)]
mod tests {
    use std::any::Any;

    use super::format_vmo_stop_problem_at_exit;
    use crate::vmo::VmoStopOutcome;

    #[test]
    fn a_vmo_that_stopped_in_time_at_exit_is_not_reported() {
        assert_eq!(
            format_vmo_stop_problem_at_exit(Ok(Ok(VmoStopOutcome::Stopped))),
            None
        );
    }

    #[test]
    fn a_killed_failed_or_panicked_vmo_stop_at_exit_is_reported() {
        let panic: Box<dyn Any + Send> = Box::new("stop panicked");

        assert_eq!(
            format_vmo_stop_problem_at_exit(Ok(Ok(VmoStopOutcome::Killed))).as_deref(),
            Some("vmo did not stop in time during app exit and was killed; it may have left VMs running")
        );
        assert_eq!(
            format_vmo_stop_problem_at_exit(Ok(Err(String::from(
                "Failed to inspect vmo process: Interrupted system call (os error 4)"
            ))))
            .as_deref(),
            Some("Failed to stop vmo during app exit: Failed to inspect vmo process: Interrupted system call (os error 4)")
        );
        assert_eq!(
            format_vmo_stop_problem_at_exit(Err(panic)).as_deref(),
            Some("Failed to stop vmo during app exit: the stop panicked")
        );
    }
}
