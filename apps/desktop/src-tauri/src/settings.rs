//! Serde-backed desktop settings and their Tauri persistence commands.
//!
//! Settings are stored as pretty-printed JSON at `~/.lys/settings.json` by
//! default. Loading a missing file attempts to create its parent directory;
//! the supplied path must therefore have a creatable parent. Custom-path saves
//! write only to the path supplied by the caller.

use std::{
    fs,
    io::ErrorKind,
    path::{Path, PathBuf},
};

use serde::de::Error;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
/// Sampling temperature constrained to the half-open interval `[0, 1)`.
///
/// Serialization represents the value as a JSON number. Deserialization uses
/// the same range validation, so `1.0`, negative values, `NaN`, and infinities
/// are rejected; the default is `0.7`.
pub struct GenerationTemperature(
    /// The validated sampling value serialized as a JSON number.
    f64,
);

impl GenerationTemperature {
    /// Creates a temperature when `value` is in `[0, 1)`.
    ///
    /// Returns `None` for values outside the range, including non-finite
    /// values.
    pub fn new(value: f64) -> Option<Self> {
        (0.0..1.0).contains(&value).then_some(Self(value))
    }

    /// Returns the validated floating-point temperature.
    pub fn get(&self) -> f64 {
        self.0
    }
}

impl Default for GenerationTemperature {
    /// Returns the default sampling temperature, `0.7`.
    fn default() -> Self {
        Self(0.7)
    }
}

/// Deserializes a JSON number and applies [`GenerationTemperature`] validation.
///
/// The serialized representation is a scalar number rather than an object.
impl<'de> Deserialize<'de> for GenerationTemperature {
    /// Reads a JSON number and rejects values outside `[0, 1)`.
    ///
    /// # Errors
    ///
    /// Returns the deserializer's error when the input is not a number or does
    /// not satisfy the temperature range.
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
/// Runtime settings persisted under the `runtime` JSON object.
///
/// Missing fields use Rust defaults (`false`, `None`, and an empty string),
/// and field names serialize in camelCase.
pub struct RunTimeSettings {
    /// Whether application initialization requests backend startup.
    pub auto_start_backend: bool,
    /// Optional model identifier selected as the runtime default.
    pub default_model: Option<String>,
    /// Backend address persisted for runtime consumers; empty by default.
    pub backend_address: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
/// Generation settings persisted under the `generation` JSON object.
///
/// Missing fields use Rust defaults: a zero context window and temperature
/// `0.7`. Field names serialize in camelCase.
pub struct GenerationSettings {
    /// Context-window size in tokens, defaulting to zero.
    pub context_window: u32,
    /// Validated sampling temperature.
    pub temperature: GenerationTemperature,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
/// Complete persisted Lys settings value.
///
/// The private fields group runtime and generation settings in the serialized
/// JSON representation while keeping those groups behind the settings module's
/// API boundary.
pub struct LysSettings {
    /// Runtime process and model settings in the serialized `runtime` object.
    runtime: RunTimeSettings,
    /// Generation parameters in the serialized `generation` object.
    generation: GenerationSettings,
}

impl LysSettings {
    /// Loads settings from `path`, creating and saving defaults when the file is absent.
    ///
    /// Existing files are read as UTF-8 JSON and deserialized with the serde
    /// defaults and temperature validation described by the settings types.
    /// A missing file causes `create_parent_dir` to attempt parent-directory
    /// creation, then writes a default settings document before returning those
    /// defaults. The path must have a parent that the filesystem can create;
    /// an empty parent from a bare relative filename can itself fail.
    ///
    /// # Errors
    ///
    /// Returns an error when the file cannot be read, JSON cannot be parsed,
    /// the path's parent cannot be created (including an empty relative
    /// parent), or default settings cannot be written.
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

    /// Loads settings from the default path under the current user's home directory.
    ///
    /// This delegates to [`Self::load_settings_from_custom_path`] for
    /// `~/.lys/settings.json`, including missing-file directory creation and
    /// default-file persistence.
    ///
    /// # Errors
    ///
    /// Returns an error when the home directory cannot be determined or the
    /// selected settings file cannot be loaded or initialized.
    pub fn load_settings_from_default_path() -> Result<Self, String> {
        let default_settings_path = &default_settings_path()?;
        Self::load_settings_from_custom_path(default_settings_path)
    }

    /// Serializes settings as pretty-printed JSON and writes them to `path`.
    ///
    /// A trailing newline is written. This method does not create a missing
    /// parent directory; callers that need that behavior must create it first
    /// or use the missing-file path through loading.
    ///
    /// # Errors
    ///
    /// Returns an error when serde serialization or filesystem writing fails.
    pub fn save_to_custom_path(&self, path: &PathBuf) -> Result<(), String> {
        let settings_json = serde_json::to_string_pretty(self)
            .map_err(|err| format!("Failed to serialize settings: {err}"))?;

        fs::write(path, format!("{settings_json}\n"))
            .map_err(|err| format!("Failed to write {}: {err}", path.display()))?;

        Ok(())
    }

    /// Saves settings to `~/.lys/settings.json`.
    ///
    /// # Errors
    ///
    /// Returns an error when the home directory cannot be determined,
    /// serialization fails, or the default file cannot be written.
    pub fn save_to_default_path(&self) -> Result<(), String> {
        let default_settings_path = &default_settings_path()?;
        self.save_to_custom_path(default_settings_path)
    }
}

/// Resolves the default settings file below the current user's home directory.
///
/// The returned path is `~/.lys/settings.json`; this helper does not create the
/// directory.
///
/// # Errors
///
/// Returns an error when the operating system cannot determine the home
/// directory.
fn default_settings_path() -> Result<PathBuf, String> {
    Ok(std::env::home_dir()
        .ok_or("Could not determine the home directory")?
        .join(".lys")
        .join("settings.json"))
}

/// Attempts to create the parent directory returned for a settings path.
///
/// This calls `create_dir_all` for the `Path::parent` result, including an
/// empty parent produced by some bare relative paths; callers therefore need a
/// path whose parent is accepted by the filesystem.
///
/// # Errors
///
/// Returns an error when directory creation fails.
fn create_parent_dir(path: &Path) -> Result<(), String> {
    if let Some(directory) = path.parent() {
        fs::create_dir_all(directory)
            .map_err(|err| format!("Failed to create {}: {err}", directory.display()))?;
    }

    Ok(())
}

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
/// `newSettings` into the Rust `new_settings` parameter. The current renderer
/// adapter passes a flat settings object instead of that named argument, so
/// deserialization rejects the request before this function can write. When a
/// correctly shaped value reaches the command, it serializes the complete Rust
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
