mod backend;

use tauri::Manager;

// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {name}! You've been greeted from Rust!")
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(backend::Backend::default())
        .invoke_handler(tauri::generate_handler![
            greet,
            backend::start_backend,
            backend::restart_backend,
            backend::stop_backend
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| {
        if matches!(event, tauri::RunEvent::Exit) {
            let backend = app_handle.state::<backend::Backend>();
            if let Err(error) = backend.shutdown() {
                eprintln!("failed to stop backend process group during application exit: {error}");
            }
        }
    });
}
