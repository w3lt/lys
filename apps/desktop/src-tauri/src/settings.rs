//! Serde-backed desktop settings and their Tauri persistence commands.
//!
//! Settings are stored as pretty-printed JSON at `~/.lys/settings.json` by
//! default. Loading a missing file attempts to create its parent directory;
//! the supplied path must therefore have a creatable parent. Custom-path saves
//! write only to the path supplied by the caller.

pub mod commands;
pub mod generation;
pub mod model;
pub mod runtime;

use generation::GenerationSettings;
use model::ModelSettings;
use runtime::RunTimeSettings;

use std::{fs, io::ErrorKind, path::Path};

use serde::{Deserialize, Serialize};

use crate::utils::lys_home::LysHome;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
/// Complete persisted Lys settings value.
///
/// The private fields group runtime, model, and generation settings in the
/// serialized JSON representation while keeping those groups behind the
/// settings module's API boundary.
pub struct LysSettings {
    /// Process settings and default-model selection in the `runtime` object.
    runtime: RunTimeSettings,
    /// Local context estimate in the serialized `model` object.
    model: ModelSettings,
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
    pub fn load_settings(lys_home: &LysHome) -> Result<Self, String> {
        let path = &lys_home.settings_path();
        match fs::read_to_string(path) {
            Ok(contents) => serde_json::from_str(&contents)
                .map_err(|err| format!("Failed to parse {}: {err}", path.display())),

            Err(err) if err.kind() == ErrorKind::NotFound => {
                // ~/.lys might not exist yet
                create_parent_dir(path)?;

                // Save the settings to file
                let settings = Self::default();
                settings.save_settings(lys_home)?;
                Ok(settings)
            }

            Err(err) => Err(format!("Failed to read {}: {err}", path.display())),
        }
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
    pub fn save_settings(&self, lys_home: &LysHome) -> Result<(), String> {
        let path = &lys_home.settings_path();

        let settings_json = serde_json::to_string_pretty(self)
            .map_err(|err| format!("Failed to serialize settings: {err}"))?;

        fs::write(path, format!("{settings_json}\n"))
            .map_err(|err| format!("Failed to write {}: {err}", path.display()))?;

        Ok(())
    }
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
