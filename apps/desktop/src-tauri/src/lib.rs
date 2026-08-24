//! Tauri application wiring for the Lys desktop shell.
//!
//! This crate registers commands, owns the managed backend process state, and
//! stops that process during application exit. Feature-specific command
//! implementations live in the `backend` and `settings` modules; `tools`
//! contains unregistered helper and input modules.

use tauri::Manager;

mod backend;
mod settings;
mod tools;

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
/// The builder registers the opener plugin, manages one mutex-protected
/// `backend::Backend` resource, and exposes the backend and settings
/// commands to the renderer. On `Exit`, the managed backend is stopped and a
/// failure is reported to stderr without preventing the process from
/// finishing its exit handling.
///
/// # Panics
///
/// Panics if Tauri cannot build the application context. This is an intentional
/// startup failure because the desktop shell cannot run without a valid Tauri
/// application.
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(backend::Backend::default())
        .invoke_handler(tauri::generate_handler![
            greet,
            backend::start_backend,
            backend::stop_backend,
            backend::get_backend_status,
            settings::commands::load_settings,
            settings::commands::save_settings
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
