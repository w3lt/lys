//! Serde-backed desktop settings and their Tauri persistence commands.
//!
//! Settings are stored as pretty-printed JSON in the settings file of the Lys
//! home that the host resolved at startup (`LysHome::settings_path`). Loading
//! a missing file creates the Lys home directory when needed and writes the
//! defaults; saving never creates it.

pub mod commands;
pub mod generation;
pub mod load_configuration;
pub mod model;
pub mod runtime;

use generation::GenerationSettings;
use load_configuration::LoadConfigurationSettings;
use model::ModelSettings;
use runtime::RunTimeSettings;

use std::{fs, io::ErrorKind, path::Path};

use serde::{Deserialize, Serialize};

use crate::utils::lys_home::LysHome;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
/// Complete persisted Lys settings value.
///
/// The private fields group runtime, model, generation, and load configuration
/// settings in the serialized JSON representation while keeping those groups
/// behind the settings module's API boundary. A missing group takes that
/// group's defaults; the load configuration group's default is empty.
pub struct LysSettings {
    /// Process settings and default-model selection in the `runtime` object.
    runtime: RunTimeSettings,
    /// Local context estimate in the serialized `model` object.
    model: ModelSettings,
    /// Generation parameters in the serialized `generation` object.
    generation: GenerationSettings,
    /// Default and per-model load settings in the `loadConfiguration` object.
    load_configuration: LoadConfigurationSettings,
}

impl LysSettings {
    /// Loads settings from the settings file under `lys_home`, creating and
    /// saving defaults when the file is absent.
    ///
    /// Existing files are read as UTF-8 JSON and deserialized with the serde
    /// defaults and validation described by the settings types; they are not
    /// rewritten, including when a group is missing. A missing file causes
    /// `create_parent_dir` to create the Lys home directory if needed, then
    /// writes a default settings document before returning those defaults.
    ///
    /// # Errors
    ///
    /// Returns an error when the file cannot be read, JSON cannot be parsed,
    /// the Lys home directory cannot be created, or default settings cannot be
    /// written. A file that cannot be read or parsed is left as it is.
    pub fn load_settings(lys_home: &LysHome) -> Result<Self, String> {
        load_settings_file(&lys_home.settings_path())
    }

    /// Serializes settings as pretty-printed JSON and writes them to the settings
    /// file under `lys_home`.
    ///
    /// A trailing newline is written. This method does not create a missing
    /// Lys home directory; callers that need that behavior must create it first
    /// or use the missing-file path through loading.
    ///
    /// # Errors
    ///
    /// Returns an error when serde serialization or filesystem writing fails.
    pub fn save_settings(&self, lys_home: &LysHome) -> Result<(), String> {
        save_settings_file(self, &lys_home.settings_path())
    }
}

/// Loads the settings stored at `path`, creating the file when it is absent.
///
/// # Errors
///
/// Returns an error when the file cannot be read or parsed, or when creating
/// it fails. Nothing is written when reading or parsing fails.
fn load_settings_file(path: &Path) -> Result<LysSettings, String> {
    match fs::read_to_string(path) {
        Ok(contents) => serde_json::from_str(&contents)
            .map_err(|err| format!("Failed to parse {}: {err}", path.display())),

        Err(err) if err.kind() == ErrorKind::NotFound => create_settings_file(path),

        Err(err) => Err(format!("Failed to read {}: {err}", path.display())),
    }
}

/// Creates the settings file at `path` with every default, and returns those
/// settings.
///
/// The parent directory is created first, because the Lys home directory
/// might not exist yet.
///
/// # Errors
///
/// Returns an error when the parent directory cannot be created or the file
/// cannot be written.
fn create_settings_file(path: &Path) -> Result<LysSettings, String> {
    create_parent_dir(path)?;

    let settings = LysSettings::default();
    save_settings_file(&settings, path)?;

    Ok(settings)
}

/// Writes `settings` to `path` as pretty-printed JSON with a trailing newline.
///
/// The parent directory is not created.
///
/// # Errors
///
/// Returns an error when serde serialization or filesystem writing fails.
fn save_settings_file(settings: &LysSettings, path: &Path) -> Result<(), String> {
    let settings_json = serde_json::to_string_pretty(settings)
        .map_err(|err| format!("Failed to serialize settings: {err}"))?;

    fs::write(path, format!("{settings_json}\n"))
        .map_err(|err| format!("Failed to write {}: {err}", path.display()))?;

    Ok(())
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

#[cfg(test)]
mod tests {
    use std::{fs, path::PathBuf};

    use serde_json::{json, Value};

    use super::{load_settings_file, save_settings_file, LysSettings};
    use crate::tools::test_directory::TestDirectory;

    /// Stored settings that differ from every default and have no load
    /// configuration group.
    fn get_settings_without_load_configuration() -> Value {
        json!({
            "runtime": {
                "autoStartBackend": false,
                "defaultModel": "qwen/qwen3-8b",
                "backendAddress": "http://127.0.0.1:23456"
            },
            "model": { "contextSize": 4096 },
            "generation": { "temperature": 0.2, "replyCeiling": 512 }
        })
    }

    /// Load configuration group of a settings file that sets no load setting.
    fn get_empty_load_configuration() -> Value {
        json!({ "default": {}, "models": {} })
    }

    /// Stored settings whose load configuration has a hand-written default
    /// and one model's settings.
    fn get_complete_settings() -> Value {
        let mut settings = get_settings_without_load_configuration();
        settings["loadConfiguration"] = json!({
            "default": { "contextLength": 4096, "numExperts": 2 },
            "models": { "qwen/qwen3-8b": { "contextLength": 16384 } }
        });

        settings
    }

    /// Reads the settings file at `path` as JSON.
    fn read_settings_json(path: &PathBuf) -> Value {
        let contents = fs::read_to_string(path).expect("read the settings file");

        serde_json::from_str(&contents).expect("a settings file holding JSON")
    }

    /// Returns the JSON form the settings commands exchange with the renderer.
    fn get_settings_json(settings: &LysSettings) -> Value {
        serde_json::to_value(settings).expect("settings that serialize")
    }

    #[test]
    fn creates_a_missing_file_with_an_empty_load_configuration() {
        let directory = TestDirectory::create("settings-create");
        let path = directory.path().join("settings.json");

        let settings = load_settings_file(&path).expect("settings for a missing file");

        let stored = read_settings_json(&path);
        assert_eq!(stored, get_settings_json(&settings));
        assert_eq!(stored["loadConfiguration"], get_empty_load_configuration());
    }

    #[test]
    fn creates_the_missing_parent_directory_of_a_missing_file() {
        let directory = TestDirectory::create("settings-create-home");
        let path = directory.path().join("lys-home").join("settings.json");

        let settings = load_settings_file(&path).expect("settings for a missing Lys home");

        assert_eq!(read_settings_json(&path), get_settings_json(&settings));
    }

    #[test]
    fn reads_a_file_without_a_load_configuration_without_rewriting_it() {
        let directory = TestDirectory::create("settings-without-group");
        let stored_text = get_settings_without_load_configuration().to_string();
        let path = directory.create_file("settings.json", &stored_text);

        let settings = load_settings_file(&path).expect("settings for a file without the group");

        let mut expected = get_settings_without_load_configuration();
        expected["loadConfiguration"] = get_empty_load_configuration();
        assert_eq!(get_settings_json(&settings), expected);
        assert_eq!(
            fs::read_to_string(&path).expect("read the settings file"),
            stored_text
        );
    }

    #[test]
    fn returns_a_complete_file_without_rewriting_it() {
        let directory = TestDirectory::create("settings-complete");
        let stored_text = get_complete_settings().to_string();
        let path = directory.create_file("settings.json", &stored_text);

        let settings = load_settings_file(&path).expect("settings for a complete file");

        assert_eq!(get_settings_json(&settings), get_complete_settings());
        assert_eq!(
            fs::read_to_string(&path).expect("read the settings file"),
            stored_text
        );
    }

    #[test]
    fn fails_on_an_unusable_file_without_rewriting_it() {
        let mut invalid_group = get_complete_settings();
        invalid_group["loadConfiguration"]["default"]["contextLength"] = json!(0);
        let mut null_group = get_settings_without_load_configuration();
        null_group["loadConfiguration"] = Value::Null;
        let mut null_default = get_settings_without_load_configuration();
        null_default["loadConfiguration"] = json!({ "default": null });
        let unusable_files = [
            invalid_group.to_string(),
            null_group.to_string(),
            null_default.to_string(),
            String::from("{ not json"),
        ];

        for stored_text in unusable_files {
            let directory = TestDirectory::create("settings-unusable");
            let path = directory.create_file("settings.json", &stored_text);

            let failure = load_settings_file(&path).expect_err("an unusable settings file");

            assert!(failure.starts_with("Failed to parse "), "{failure}");
            assert_eq!(
                fs::read_to_string(&path).expect("read the settings file"),
                stored_text
            );
        }
    }

    #[test]
    fn fails_when_the_settings_path_cannot_be_read() {
        let directory = TestDirectory::create("settings-unreadable");
        let path = directory.create_subdirectory("settings.json");

        let failure = load_settings_file(&path).expect_err("a directory at the settings path");

        assert!(failure.starts_with("Failed to read "), "{failure}");
    }

    #[test]
    fn saved_settings_load_back_unchanged() {
        let directory = TestDirectory::create("settings-round-trip");
        let source_path = directory.create_file("source.json", get_complete_settings().to_string());
        let settings = load_settings_file(&source_path).expect("settings for a complete file");
        let saved_path = directory.path().join("saved.json");

        save_settings_file(&settings, &saved_path).expect("save the settings");

        let reloaded = load_settings_file(&saved_path).expect("settings that load back");
        assert_eq!(get_settings_json(&reloaded), get_complete_settings());
    }

    #[test]
    fn saving_does_not_create_a_missing_parent_directory() {
        let directory = TestDirectory::create("settings-save-missing-home");
        let source_path = directory.create_file("source.json", get_complete_settings().to_string());
        let settings = load_settings_file(&source_path).expect("settings for a complete file");
        let saved_path = directory.path().join("missing").join("settings.json");

        let failure = save_settings_file(&settings, &saved_path).expect_err("a missing directory");

        assert!(failure.starts_with("Failed to write "), "{failure}");
        assert!(!saved_path.exists());
    }
}
