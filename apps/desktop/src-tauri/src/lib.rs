//! Tauri application wiring for the Lys desktop shell.
//!
//! This crate resolves the Lys home once at startup, registers commands, owns
//! the managed backend process state, and stops that process during
//! application exit. Feature-specific command implementations live in the
//! `backend`, `settings`, and `tools` modules; `utils` resolves the Lys home.

use tauri::Manager;

use crate::utils::lys_home::LysHome;

mod backend;
mod settings;
mod tools;
mod utils;

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
/// The builder registers the opener plugin, manages the resolved `LysHome` and
/// one mutex-protected `backend::Backend` resource, and exposes the backend,
/// settings, and file tool commands to the renderer. On `Exit`, the managed
/// backend is stopped and a failure is reported to stderr without preventing
/// the process from finishing its exit handling.
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
        .invoke_handler(tauri::generate_handler![
            greet,
            backend::start_backend,
            backend::stop_backend,
            backend::get_backend_status,
            settings::commands::load_settings,
            settings::commands::save_settings,
            tools::read_text_file::read_text_file,
            tools::search_files::find_files
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| {
        if let tauri::RunEvent::Exit = event {
            let backend = app_handle.state::<backend::Backend>();

            if let Err(error) = backend.stop() {
                eprintln!("Failed to stop backend during app exit: {error}");
            }
        }
    })
}
