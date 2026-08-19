use std::{
    fs,
    io::ErrorKind,
    path::{Path, PathBuf},
};

use serde::de::Error;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct GenerationTemperature(f64);

impl GenerationTemperature {
    pub fn new(value: f64) -> Option<Self> {
        (0.0..1.0).contains(&value).then_some(Self(value))
    }

    pub fn get(&self) -> f64 {
        self.0
    }
}

impl Default for GenerationTemperature {
    fn default() -> Self {
        Self(0.7)
    }
}

impl<'de> Deserialize<'de> for GenerationTemperature {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let value: f64 = f64::deserialize(deserializer)?;

        Self::new(value)
            .ok_or_else(|| D::Error::custom("temperature must be between 0 and 1 inclusive"))
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct RunTimeSettings {
    pub auto_start_backend: bool,
    pub default_model: Option<String>,
    pub backend_address: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct GenerationSettings {
    pub context_window: u32,
    pub temperature: GenerationTemperature,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct LysSettings {
    runtime: RunTimeSettings,
    generation: GenerationSettings,
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
