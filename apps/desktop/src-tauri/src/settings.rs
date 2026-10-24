//! Serde-backed desktop settings and their Tauri persistence commands.
//!
//! Settings are stored as pretty-printed JSON in the settings file of the Lys
//! home that the host resolved at startup (`LysHome::settings_path`). Loading
//! a missing file creates the Lys home directory when needed and writes the
//! defaults; saving never creates it.

pub mod commands;
pub mod generation;
pub mod load_configuration;
pub mod location;
pub mod mcp;
pub mod runtime;
pub mod secrets;
pub mod tools;

use generation::GenerationSettings;
use load_configuration::LoadConfigurationSettings;
use location::LocationSettings;
use mcp::McpSettings;
use runtime::RunTimeSettings;
use secrets::SecretsSettings;
use tools::ToolSettings;

use std::{
    ffi::OsString,
    fs,
    io::{self, ErrorKind, Write},
    path::{Path, PathBuf},
    process,
    sync::atomic::{AtomicU64, Ordering},
};

use serde::{Deserialize, Serialize};

use crate::utils::lys_home::LysHome;

/// Number of temporary files this process has named, so that two saves
/// running at once in one process never share a temporary file.
static TEMPORARY_FILE_COUNT: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
/// Complete persisted Lys settings value.
///
/// The private fields group runtime, generation, load configuration, secrets,
/// tools, location, and MCP server settings in the serialized JSON
/// representation while keeping those groups behind the settings module's API
/// boundary. A missing group takes that group's defaults; the load
/// configuration group's default is empty, the secrets group's default holds
/// no key, the tools group's default puts no tool on Just run and saves no
/// tool switch, the location group's default saves no location, and the MCP
/// group's default lists no server. A group the value does not hold, such as
/// the `model` group of files written before the local context estimate was
/// removed, is ignored when loading and left out of the next save.
pub struct LysSettings {
    /// Process settings and default-model selection in the `runtime` object.
    runtime: RunTimeSettings,
    /// Generation parameters in the serialized `generation` object.
    generation: GenerationSettings,
    /// Default and per-model load settings in the `loadConfiguration` object.
    load_configuration: LoadConfigurationSettings,
    /// Secrets, such as the Tavily API key, in the `secrets` object.
    secrets: SecretsSettings,
    /// Tools set to Just run and saved tool switches, in the `tools` object.
    tools: ToolSettings,
    /// Location the person saved, in the `location` object.
    location: LocationSettings,
    /// MCP servers Lys connects to, in the `mcp` object.
    mcp: McpSettings,
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

    /// Returns the location the person saved, which may hold no part.
    pub fn location(&self) -> &LocationSettings {
        &self.location
    }

    /// Serializes settings as pretty-printed JSON and replaces the settings file
    /// under `lys_home` atomically, readable only by its owner.
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
    match find_settings_file(path)? {
        Some(settings) => Ok(settings),
        None => create_settings_file(path),
    }
}

/// Reads the settings stored at `path`, such as the settings file of the Lys
/// home, without creating it, or `None` when there is no file. An existing
/// file is read as [`LysSettings::load_settings`] reads it.
///
/// # Errors
///
/// Returns an error naming `path` when the file cannot be read or JSON cannot
/// be parsed. Nothing is written.
pub fn find_settings_file(path: &Path) -> Result<Option<LysSettings>, String> {
    match fs::read_to_string(path) {
        Ok(contents) => serde_json::from_str(&contents)
            .map(Some)
            .map_err(|err| format!("Failed to parse {}: {err}", path.display())),

        Err(err) if err.kind() == ErrorKind::NotFound => Ok(None),

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

/// Writes `settings` to `path` as pretty-printed JSON with a trailing newline,
/// replacing any file there atomically and readable only by its owner.
///
/// The parent directory is not created. See
/// [`save_owner_only_file_atomically`] for the replacement guarantee.
///
/// # Errors
///
/// Returns an error when serde serialization or filesystem writing fails; the
/// file at `path` is then left as it was.
fn save_settings_file(settings: &LysSettings, path: &Path) -> Result<(), String> {
    let settings_json = serde_json::to_string_pretty(settings)
        .map_err(|err| format!("Failed to serialize settings: {err}"))?;

    save_owner_only_file_atomically(path, format!("{settings_json}\n").as_bytes())
        .map_err(|err| format!("Failed to write {}: {err}", path.display()))
}

/// Replaces the file at `path` with `contents`, readable and writable only by
/// its owner on Unix.
///
/// The contents are written to a new temporary file beside `path` whose name
/// no other save shares, flushed to disk, and renamed over `path`. Another
/// process reading `path` therefore sees either the previous file or a
/// complete new one, never a partial write, also while another host saves the
/// same file. When two saves overlap, the one renamed last is kept whole. The
/// directory entry is not synced, so the rename itself is not promised to
/// survive a power loss. On failure the temporary file this call created is
/// removed and `path` is unchanged; a process that stops mid-save leaves its
/// temporary file, owner-only like `path`.
///
/// # Errors
///
/// Returns the first I/O error of creating, writing, syncing, or renaming,
/// including when the temporary file's name is already taken.
fn save_owner_only_file_atomically(path: &Path, contents: &[u8]) -> io::Result<()> {
    let temporary_path = build_temporary_path(path);
    let temporary_file = create_owner_only_file(&temporary_path)?;
    let written = save_temporary_file_and_rename(temporary_file, &temporary_path, path, contents);
    if written.is_err() {
        // The write already failed; a failed removal of the temporary file
        // this call created must not replace that error.
        let _ = fs::remove_file(&temporary_path);
    }

    written
}

/// Builds a temporary path beside `path` that no other save shares: its file
/// name followed by `.`, this process's id, `.`, the number of temporary files
/// this process named before, and `.tmp`.
///
/// Another host saving the same file runs in another process, so its names
/// differ. Only a later process with a reused id can meet a name that a
/// stopped process left behind; creating the file then fails instead of
/// writing into it.
fn build_temporary_path(path: &Path) -> PathBuf {
    let temporary_file_number = TEMPORARY_FILE_COUNT.fetch_add(1, Ordering::Relaxed);
    let mut file_name = path.file_name().map(OsString::from).unwrap_or_default();
    file_name.push(format!(".{}.{temporary_file_number}.tmp", process::id()));

    path.with_file_name(file_name)
}

/// Writes `contents` to the new temporary file at `temporary_path`, syncs it,
/// closes it, and renames it over `path`.
///
/// # Errors
///
/// Returns the first I/O error.
fn save_temporary_file_and_rename(
    mut temporary_file: fs::File,
    temporary_path: &Path,
    path: &Path,
    contents: &[u8],
) -> io::Result<()> {
    temporary_file.write_all(contents)?;
    temporary_file.sync_all()?;
    drop(temporary_file);

    fs::rename(temporary_path, path)
}

#[cfg(unix)]
/// Creates a new file at `path` for writing with mode `0600`, which the
/// process umask can only narrow.
///
/// Nothing that already exists at `path` is opened, truncated, or followed,
/// including a symbolic link.
///
/// # Errors
///
/// Returns the I/O error of creating the file, such as `AlreadyExists` when
/// `path` names an existing entry.
fn create_owner_only_file(path: &Path) -> io::Result<fs::File> {
    use std::os::unix::fs::OpenOptionsExt;

    fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)
}

#[cfg(not(unix))]
/// Creates a new file at `path` for writing; permissions are left to the
/// platform.
///
/// Nothing that already exists at `path` is opened or truncated.
///
/// # Errors
///
/// Returns the I/O error of creating the file, such as `AlreadyExists` when
/// `path` names an existing entry.
fn create_owner_only_file(path: &Path) -> io::Result<fs::File> {
    fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
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
    use std::{
        fs,
        path::{Path, PathBuf},
    };

    use serde_json::{json, Value};

    use super::{
        build_temporary_path, create_owner_only_file, find_settings_file, load_settings_file,
        save_settings_file, LysSettings,
    };
    use crate::tools::test_directory::TestDirectory;

    /// Stored settings that differ from every default and have no load
    /// configuration group.
    fn get_settings_without_load_configuration() -> Value {
        json!({
            "runtime": {
                "autoStartBackend": false,
                "autoStartVmo": false,
                "defaultModel": "qwen/qwen3-8b",
                "backendAddress": "http://127.0.0.1:23456"
            },
            "generation": { "temperature": 0.2, "replyCeiling": 512 }
        })
    }

    /// Load configuration group of a settings file that sets no load setting.
    fn get_empty_load_configuration() -> Value {
        json!({ "default": {}, "models": {} })
    }

    /// Stored settings whose load configuration has a hand-written default
    /// and one model's settings, with a saved Tavily API key, location, and
    /// two MCP servers.
    fn get_complete_settings() -> Value {
        let mut settings = get_settings_without_load_configuration();
        settings["loadConfiguration"] = json!({
            "default": { "contextLength": 4096, "numExperts": 2 },
            "models": { "qwen/qwen3-8b": { "contextLength": 16384 } }
        });
        settings["secrets"] = json!({ "tavilyApiKey": "tvly-synthetic-0123456789" });
        settings["tools"] = json!({
            "justRun": ["read_page", "read_text_file"],
            "switches": { "read_page": true, "search_files": false }
        });
        settings["location"] = json!({ "city": "Lyon", "region": null, "country": "France" });
        settings["mcp"] = json!({ "servers": [
            {
                "name": "files",
                "transport": "stdio",
                "command": "/opt/homebrew/bin/npx",
                "arguments": ["-y", "@modelcontextprotocol/server-filesystem"],
                "environment": [{ "name": "LOG_LEVEL", "value": "env-synthetic-value" }]
            },
            {
                "name": "docs",
                "transport": "http",
                "url": "https://mcp.example.com/mcp",
                "headers": [{ "name": "Authorization", "value": "Bearer header-synthetic-value" }]
            }
        ] });

        settings
    }

    /// Secrets group of a settings file without a saved key.
    fn get_empty_secrets() -> Value {
        json!({ "tavilyApiKey": null })
    }

    /// Tools group of a settings file in which every tool asks first and no
    /// tool has a saved switch.
    fn get_empty_tools() -> Value {
        json!({ "justRun": [], "switches": {} })
    }

    /// Location group of a settings file without a saved location.
    fn get_empty_location() -> Value {
        json!({ "city": null, "region": null, "country": null })
    }

    /// MCP group of a settings file that lists no server.
    fn get_empty_mcp() -> Value {
        json!({ "servers": [] })
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

    /// Lists the names of the temporary files in `directory`.
    fn list_temporary_file_names(directory: &Path) -> Vec<String> {
        fs::read_dir(directory)
            .expect("list the directory")
            .map(|entry| entry.expect("read a directory entry").file_name())
            .map(|name| name.to_string_lossy().into_owned())
            .filter(|name| name.ends_with(".tmp"))
            .collect()
    }

    #[test]
    fn creates_a_missing_file_with_an_empty_load_configuration() {
        let directory = TestDirectory::create("settings-create");
        let path = directory.path().join("settings.json");

        let settings = load_settings_file(&path).expect("settings for a missing file");

        let stored = read_settings_json(&path);
        assert_eq!(stored, get_settings_json(&settings));
        assert_eq!(stored["loadConfiguration"], get_empty_load_configuration());
        assert_eq!(stored["secrets"], get_empty_secrets());
        assert_eq!(stored["tools"], get_empty_tools());
        assert_eq!(stored["location"], get_empty_location());
        assert_eq!(stored["mcp"], get_empty_mcp());
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
        expected["secrets"] = get_empty_secrets();
        expected["tools"] = get_empty_tools();
        expected["location"] = get_empty_location();
        expected["mcp"] = get_empty_mcp();
        assert_eq!(get_settings_json(&settings), expected);
        assert_eq!(
            fs::read_to_string(&path).expect("read the settings file"),
            stored_text
        );
    }

    #[test]
    fn starts_vmo_at_launch_for_a_file_saved_before_the_vmo_switch() {
        let directory = TestDirectory::create("settings-without-vmo-switch");
        let mut stored = get_complete_settings();
        stored["runtime"]
            .as_object_mut()
            .expect("a runtime group")
            .remove("autoStartVmo");
        let path = directory.create_file("settings.json", stored.to_string());

        let settings = load_settings_file(&path).expect("settings for an older file");

        let runtime = &get_settings_json(&settings)["runtime"];
        assert_eq!(runtime["autoStartVmo"], json!(true));
        assert_eq!(runtime["autoStartBackend"], json!(false));
    }

    #[test]
    fn ignores_the_retired_model_group_and_saves_without_it() {
        let directory = TestDirectory::create("settings-retired-model-group");
        let mut stored = get_complete_settings();
        stored["model"] = json!({ "contextSize": 4096 });
        let path = directory.create_file("settings.json", stored.to_string());
        let saved_path = directory.path().join("saved.json");

        let settings = load_settings_file(&path).expect("settings for an older file");
        save_settings_file(&settings, &saved_path).expect("save the settings");

        assert_eq!(get_settings_json(&settings), get_complete_settings());
        assert_eq!(read_settings_json(&saved_path), get_complete_settings());
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
        let mut spaced_key = get_complete_settings();
        spaced_key["secrets"]["tavilyApiKey"] = json!("tvly-key with space");
        let mut null_secrets = get_settings_without_load_configuration();
        null_secrets["secrets"] = Value::Null;
        let mut null_tools = get_settings_without_load_configuration();
        null_tools["tools"] = Value::Null;
        let mut invalid_tool_name = get_complete_settings();
        invalid_tool_name["tools"]["justRun"] = json!(["read page"]);
        let mut invalid_switch = get_complete_settings();
        invalid_switch["tools"]["switches"] = json!({ "read_page": "on" });
        let mut null_location = get_settings_without_load_configuration();
        null_location["location"] = Value::Null;
        let mut padded_place_name = get_complete_settings();
        padded_place_name["location"]["city"] = json!("Lyon ");
        let mut null_mcp = get_settings_without_load_configuration();
        null_mcp["mcp"] = Value::Null;
        let mut invalid_server_name = get_complete_settings();
        invalid_server_name["mcp"]["servers"][0]["name"] = json!("My Files");
        let mut plain_http_url = get_complete_settings();
        plain_http_url["mcp"]["servers"][1]["url"] = json!("http://mcp.example.com/mcp");
        let unusable_files = [
            invalid_group.to_string(),
            null_group.to_string(),
            null_default.to_string(),
            spaced_key.to_string(),
            null_secrets.to_string(),
            null_tools.to_string(),
            invalid_tool_name.to_string(),
            invalid_switch.to_string(),
            null_location.to_string(),
            padded_place_name.to_string(),
            null_mcp.to_string(),
            invalid_server_name.to_string(),
            plain_http_url.to_string(),
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
    fn finds_no_settings_for_a_missing_file_and_creates_nothing() {
        let directory = TestDirectory::create("settings-find-missing");
        let path = directory.path().join("lys-home").join("settings.json");

        let settings = find_settings_file(&path).expect("no failure for a missing file");

        assert!(settings.is_none());
        assert!(!directory.path().join("lys-home").exists());
    }

    #[test]
    fn finds_the_saved_location_of_an_existing_file_without_rewriting_it() {
        let directory = TestDirectory::create("settings-find-existing");
        let stored_text = get_complete_settings().to_string();
        let path = directory.create_file("settings.json", &stored_text);

        let settings = find_settings_file(&path)
            .expect("a readable file")
            .expect("settings for an existing file");

        assert!(settings.location().is_saved());
        assert_eq!(get_settings_json(&settings), get_complete_settings());
        assert_eq!(
            fs::read_to_string(&path).expect("read the settings file"),
            stored_text
        );
    }

    #[test]
    fn finding_fails_on_an_unreadable_or_unusable_file() {
        let directory = TestDirectory::create("settings-find-failure");
        let unreadable_path = directory.create_subdirectory("settings.json");
        let unusable_path = directory.create_file("unusable.json", "{ not json");

        let read_failure = find_settings_file(&unreadable_path).expect_err("a directory");
        let parse_failure = find_settings_file(&unusable_path).expect_err("invalid JSON");

        assert!(
            read_failure.starts_with("Failed to read "),
            "{read_failure}"
        );
        assert!(
            parse_failure.starts_with("Failed to parse "),
            "{parse_failure}"
        );
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
    fn reads_a_saved_tavily_api_key_and_hides_it_from_debug_output() {
        let directory = TestDirectory::create("settings-secret");
        let path = directory.create_file("settings.json", get_complete_settings().to_string());

        let settings = load_settings_file(&path).expect("settings with a key");

        assert_eq!(
            get_settings_json(&settings)["secrets"]["tavilyApiKey"],
            json!("tvly-synthetic-0123456789")
        );
        assert!(!format!("{settings:?}").contains("tvly-synthetic"));
    }

    #[test]
    fn reads_saved_mcp_servers_and_hides_their_secret_values_from_debug_output() {
        let directory = TestDirectory::create("settings-mcp");
        let path = directory.create_file("settings.json", get_complete_settings().to_string());

        let settings = load_settings_file(&path).expect("settings with MCP servers");

        assert_eq!(
            get_settings_json(&settings)["mcp"],
            get_complete_settings()["mcp"]
        );
        let debug_output = format!("{settings:?}");
        assert!(
            !debug_output.contains("env-synthetic-value"),
            "{debug_output}"
        );
        assert!(
            !debug_output.contains("header-synthetic-value"),
            "{debug_output}"
        );
    }

    #[test]
    fn replaces_an_existing_file_and_leaves_no_temporary_file() {
        let directory = TestDirectory::create("settings-replace");
        let path = directory.create_file("settings.json", "{}");
        let source_path = directory.create_file("source.json", get_complete_settings().to_string());
        let settings = load_settings_file(&source_path).expect("settings for a complete file");

        save_settings_file(&settings, &path).expect("save the settings");

        assert_eq!(read_settings_json(&path), get_complete_settings());
        assert!(list_temporary_file_names(directory.path()).is_empty());
    }

    #[test]
    fn names_a_different_temporary_file_beside_the_settings_file_for_every_save() {
        let directory = TestDirectory::create("settings-temporary-names");
        let path = directory.path().join("settings.json");

        let first = build_temporary_path(&path);
        let second = build_temporary_path(&path);

        assert_ne!(first, second);
        for temporary_path in [first, second] {
            assert_eq!(temporary_path.parent(), Some(directory.path()));
            let name = temporary_path
                .file_name()
                .expect("a file name")
                .to_string_lossy()
                .into_owned();
            assert!(
                name.starts_with(&format!("settings.json.{}.", std::process::id())),
                "{name}"
            );
            assert!(name.ends_with(".tmp"), "{name}");
        }
    }

    #[test]
    fn leaves_the_temporary_files_of_other_saves_untouched() {
        let directory = TestDirectory::create("settings-other-saves");
        let path = directory.create_file("settings.json", "{}");
        let fixed_name = directory.create_file("settings.json.tmp", "an older host's save");
        // Process id 1 is the operating system's first process, never this test's.
        let other_process = directory.create_file("settings.json.1.0.tmp", "another host's save");
        let source_path = directory.create_file("source.json", get_complete_settings().to_string());
        let settings = load_settings_file(&source_path).expect("settings for a complete file");

        save_settings_file(&settings, &path).expect("save the settings");

        assert_eq!(read_settings_json(&path), get_complete_settings());
        assert_eq!(
            fs::read_to_string(&fixed_name).expect("read the older host's file"),
            "an older host's save"
        );
        assert_eq!(
            fs::read_to_string(&other_process).expect("read the other host's file"),
            "another host's save"
        );
    }

    #[test]
    fn removes_its_temporary_file_when_the_replacement_fails() {
        let directory = TestDirectory::create("settings-rename-fails");
        let path = directory.create_subdirectory("settings.json");
        directory.create_file("settings.json/kept.txt", "kept");
        let source_path = directory.create_file("source.json", get_complete_settings().to_string());
        let settings = load_settings_file(&source_path).expect("settings for a complete file");

        let failure = save_settings_file(&settings, &path).expect_err("a directory at the path");

        assert!(failure.starts_with("Failed to write "), "{failure}");
        assert!(list_temporary_file_names(directory.path()).is_empty());
        assert_eq!(
            fs::read_to_string(path.join("kept.txt")).expect("read the kept file"),
            "kept"
        );
    }

    #[test]
    fn creating_a_temporary_file_refuses_an_existing_file_without_changing_it() {
        let directory = TestDirectory::create("settings-temporary-taken");
        let taken = directory.create_file("settings.json.tmp", "another save's contents");

        let failure = create_owner_only_file(&taken).expect_err("an existing file");

        assert_eq!(failure.kind(), std::io::ErrorKind::AlreadyExists);
        assert_eq!(
            fs::read_to_string(&taken).expect("read the existing file"),
            "another save's contents"
        );
    }

    #[cfg(unix)]
    #[test]
    fn creating_a_temporary_file_never_follows_a_symbolic_link() {
        use std::os::unix::fs::{symlink, PermissionsExt};

        let directory = TestDirectory::create("settings-temporary-link");
        let target = directory.create_file("target.txt", "the link's target");
        fs::set_permissions(&target, fs::Permissions::from_mode(0o644)).expect("widen the target");
        let link = directory.path().join("settings.json.tmp");
        symlink(&target, &link).expect("create the link");

        let failure = create_owner_only_file(&link).expect_err("an existing link");

        assert_eq!(failure.kind(), std::io::ErrorKind::AlreadyExists);
        assert_eq!(
            fs::read_to_string(&target).expect("read the target"),
            "the link's target"
        );
        let mode = fs::metadata(&target)
            .expect("read metadata")
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o644);
    }

    #[cfg(unix)]
    #[test]
    fn saved_settings_are_readable_only_by_their_owner() {
        use std::os::unix::fs::PermissionsExt;

        let directory = TestDirectory::create("settings-permissions");
        let path = directory.create_file("settings.json", "{}");
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).expect("widen the file");
        let source_path = directory.create_file("source.json", get_complete_settings().to_string());
        let settings = load_settings_file(&source_path).expect("settings for a complete file");

        save_settings_file(&settings, &path).expect("save the settings");

        let mode = fs::metadata(&path)
            .expect("read metadata")
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600);
    }

    #[cfg(unix)]
    #[test]
    fn a_created_settings_file_is_readable_only_by_its_owner() {
        use std::os::unix::fs::PermissionsExt;

        let directory = TestDirectory::create("settings-created-permissions");
        let path = directory.path().join("settings.json");

        load_settings_file(&path).expect("settings for a missing file");

        let mode = fs::metadata(&path)
            .expect("read metadata")
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600);
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
