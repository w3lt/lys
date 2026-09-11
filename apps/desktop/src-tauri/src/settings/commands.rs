use crate::settings::LysSettings;

#[tauri::command]
/// Loads the persisted settings from the default settings path.
///
/// If the file does not exist, default settings are created, persisted, and
/// returned. The Tauri response uses the settings types' camelCase JSON shape.
///
/// # Errors
///
/// Returns an error when the home path cannot be resolved, the file cannot be
/// read or parsed, or missing-file initialization cannot create or write the
/// settings path.
pub fn load_settings() -> Result<LysSettings, String> {
    LysSettings::load_settings_from_default_path()
}

#[tauri::command]
/// Persists the supplied settings at the default settings path.
///
/// Tauri deserializes the command argument from the camelCase wire key
/// `newSettings` into the Rust `new_settings` parameter. After validation,
/// it serializes the complete Rust
/// settings representation and writes a trailing newline; it does not create
/// the parent directory if it is missing.
///
/// # Errors
///
/// Returns an error when command-argument deserialization, home-path
/// resolution, serialization, or file writing fails.
pub fn save_settings(new_settings: LysSettings) -> Result<(), String> {
    new_settings.save_to_default_path()
}
