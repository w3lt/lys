use tauri::State;

use crate::{settings::LysSettings, utils::lys_home::LysHome};

#[tauri::command]
/// Loads the persisted settings from the Lys home resolved at startup.
///
/// If the file does not exist, default settings are created, persisted, and
/// returned. The Tauri response uses the settings types' camelCase JSON shape.
///
/// # Errors
///
/// Returns an error when the file cannot be read or parsed, or missing-file
/// initialization cannot create or write the settings path.
pub fn load_settings(lys_home: State<'_, LysHome>) -> Result<LysSettings, String> {
    LysSettings::load_settings(&lys_home)
}

#[tauri::command]
/// Persists the supplied settings in the Lys home resolved at startup.
///
/// Tauri deserializes the command argument from the camelCase wire key
/// `newSettings` into the Rust `new_settings` parameter. After validation,
/// it serializes the complete Rust
/// settings representation and writes a trailing newline; it does not create
/// the Lys home directory if it is missing.
///
/// # Errors
///
/// Returns an error when command-argument deserialization, serialization, or
/// file writing fails.
pub fn save_settings(
    new_settings: LysSettings,
    lys_home: State<'_, LysHome>,
) -> Result<(), String> {
    new_settings.save_settings(&lys_home)
}
