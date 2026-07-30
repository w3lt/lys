// The backend lifecycle depends on Darwin process-group semantics that other
// platforms do not share. Fail the build rather than silently shipping a
// backend that cannot be stopped. See `backend::process_group` for details.
#[cfg(not(target_os = "macos"))]
compile_error!("Lys desktop currently supports macOS only.");

mod backend;

use tauri::Manager;

pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(backend::Backend::default())
        .invoke_handler(tauri::generate_handler![
            backend::start_backend,
            backend::restart_backend,
            backend::stop_backend
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| {
        if matches!(event, tauri::RunEvent::Exit) {
            // Blocking the exit path is deliberate: the backend runs in its own
            // process group and would outlive an early return. Worst case is the
            // termination grace period plus the force-kill window.
            let backend = app_handle.state::<backend::Backend>();
            if let Err(error) = backend.shutdown() {
                eprintln!("failed to stop backend process group during application exit: {error}");
            }
        }
    });
}
