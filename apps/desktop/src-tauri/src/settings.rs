use std::{
    fs,
    io::ErrorKind,
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct RunTimeSettings {
    pub auto_start_backend: bool,
    pub selected_model: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct LysSettings {
    run_time: RunTimeSettings,
}

impl LysSettings {
    pub fn load_settings_from_custom_path(path: &PathBuf) -> Result<Self, String> {
        match fs::read_to_string(path) {
            Ok(contents) => serde_json::from_str(&contents)
                .map_err(|err| format!("Failed to parse {}: {err}", path.display())),

            Err(err) if err.kind() == ErrorKind::NotFound => {
                // ~/.lys might not exist yet
                create_parent_dir(path)?;

                // Save the settings to file
                let settings = Self::default();
                settings.save_to_custom_path(path)?;
                Ok(settings)
            }

            Err(err) => Err(format!("Failed to read {}: {err}", path.display())),
        }
    }

    pub fn load_settings_from_default_path() -> Result<Self, String> {
        let default_settings_path = &default_settings_path()?;
        Self::load_settings_from_custom_path(default_settings_path)
    }

    pub fn save_to_custom_path(&self, path: &PathBuf) -> Result<(), String> {
        let settings_json = serde_json::to_string_pretty(self)
            .map_err(|err| format!("Failed to serialize settings: {err}"))?;

        fs::write(path, format!("{settings_json}\n"))
            .map_err(|err| format!("Failed to write {}: {err}", path.display()))?;

        Ok(())
    }

    pub fn save_to_default_path(&self) -> Result<(), String> {
        let default_settings_path = &default_settings_path()?;
        self.save_to_custom_path(default_settings_path)
    }
}

fn default_settings_path() -> Result<PathBuf, String> {
    Ok(std::env::home_dir()
        .ok_or("Could not determine the home directory")?
        .join(".lys")
        .join("settings.json"))
}

fn create_parent_dir(path: &Path) -> Result<(), String> {
    if let Some(directory) = path.parent() {
        fs::create_dir_all(directory)
            .map_err(|err| format!("Failed to create {}: {err}", directory.display()))?;
    }

    Ok(())
}

#[tauri::command]
pub fn load_settings() -> Result<LysSettings, String> {
    LysSettings::load_settings_from_default_path()
}

#[tauri::command]
pub fn save_settings(new_settings: LysSettings) -> Result<(), String> {
    new_settings.save_to_default_path()
}
