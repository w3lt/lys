//! The `get_location` tool, which reads the location the person saved in
//! Settings.
//!
//! The location is never detected: no Location Services, no network lookup,
//! no guess from the time zone. Without a saved location the tool fails.

use std::path::Path;

use serde::Serialize;
use tauri::State;

use super::definition::{ToolAccess, ToolDefinition, ToolGroup, ToolRunner};
use crate::{
    settings::{find_settings_file, location::LocationSettings, LysSettings},
    utils::lys_home::LysHome,
};

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "code", rename_all = "camelCase")]
/// Expected failure of the `get_location` command.
///
/// The command rejects with a JSON object whose `code` is the camelCase
/// variant name, such as `{ "code": "locationNotSet" }`. No failure carries
/// the settings path or the operating system's message.
pub enum GetLocationError {
    /// The person saved no location: there is no settings file, or no part of
    /// its `location` group is set.
    LocationNotSet,
    /// The settings file exists but cannot be read or is not valid settings
    /// JSON.
    SettingsUnreadable,
}

#[tauri::command]
/// Reads the location the person saved in Settings.
///
/// The renderer invokes this command as `get_location` with no arguments. It
/// reads the settings file of the Lys home resolved at startup, so a saved
/// change applies to the next call. It never creates or changes the file and
/// cannot be cancelled. The result holds the `city`, `region`, and `country`
/// the person saved, each a string or `null`, at least one a string.
///
/// # Errors
///
/// Rejects as [`get_saved_location`] does.
pub fn get_location(lys_home: State<'_, LysHome>) -> Result<LocationSettings, GetLocationError> {
    get_saved_location(&lys_home.settings_path())
}

/// Gets the location saved in the settings file at `settings_path`, without
/// creating or changing the file.
///
/// # Errors
///
/// Returns [`GetLocationError::LocationNotSet`] when there is no file or no
/// location is saved, and [`GetLocationError::SettingsUnreadable`] when the
/// file cannot be read or parsed.
fn get_saved_location(settings_path: &Path) -> Result<LocationSettings, GetLocationError> {
    let settings =
        find_settings_file(settings_path).map_err(|_| GetLocationError::SettingsUnreadable)?;

    find_saved_location(settings.as_ref())
}

/// Finds the location saved in `settings`, the settings read from the file or
/// `None` when there is no file.
///
/// # Errors
///
/// Returns [`GetLocationError::LocationNotSet`] when there are no settings or
/// no part of their location is saved.
fn find_saved_location(
    settings: Option<&LysSettings>,
) -> Result<LocationSettings, GetLocationError> {
    settings
        .map(LysSettings::location)
        .filter(|location| location.is_saved())
        .cloned()
        .ok_or(GetLocationError::LocationNotSet)
}

/// Builds the definition of the get-location tool for the client tool list.
/// The tool takes no arguments.
pub(super) fn build_get_location_definition() -> ToolDefinition {
    ToolDefinition {
        name: "get_location",
        description: String::from(
            "Get the location the person saved in Lys's settings: a city, a region, and a country, any of which may be null. The person typed it; it is never detected, so it may be out of date. Fails when no location is saved.",
        ),
        group: ToolGroup::TimeAndPlace,
        access: ToolAccess::Reads,
        runner: ToolRunner::Client,
        arguments: Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use std::fs;

    use serde_json::{json, Value};

    use super::{get_saved_location, GetLocationError};
    use crate::tools::test_directory::TestDirectory;

    /// Name of the settings file each test writes in its own directory.
    const SETTINGS_FILE_NAME: &str = "settings.json";

    #[test]
    fn gives_every_saved_part_and_null_for_the_others_without_changing_the_file() {
        let directory = TestDirectory::create("location-saved");
        let stored_text = json!({
            "location": { "city": "Lyon", "region": null, "country": "France" }
        })
        .to_string();
        let settings_path = directory.create_file(SETTINGS_FILE_NAME, &stored_text);

        let location = get_saved_location(&settings_path).expect("a saved location");

        assert_eq!(
            serde_json::to_value(location).expect("serialize"),
            json!({ "city": "Lyon", "region": null, "country": "France" })
        );
        assert_eq!(
            fs::read_to_string(&settings_path).expect("read the settings file"),
            stored_text
        );
    }

    #[test]
    fn fails_without_a_settings_file_and_creates_none() {
        let directory = TestDirectory::create("location-missing");
        let settings_path = directory.path().join("lys-home").join(SETTINGS_FILE_NAME);

        assert_eq!(
            get_saved_location(&settings_path),
            Err(GetLocationError::LocationNotSet)
        );
        assert!(!directory.path().join("lys-home").exists());
    }

    #[test]
    fn fails_when_no_part_of_the_location_is_saved() {
        for stored in [
            json!({}),
            json!({ "location": {} }),
            json!({ "location": { "city": null, "region": null, "country": null } }),
        ] {
            let directory = TestDirectory::create("location-not-set");
            let settings_path = directory.create_file(SETTINGS_FILE_NAME, stored.to_string());

            assert_eq!(
                get_saved_location(&settings_path),
                Err(GetLocationError::LocationNotSet),
                "{stored}"
            );
        }
    }

    #[test]
    fn fails_when_the_settings_file_cannot_be_read() {
        let directory = TestDirectory::create("location-unreadable");
        let settings_path = directory.create_subdirectory(SETTINGS_FILE_NAME);

        assert_eq!(
            get_saved_location(&settings_path),
            Err(GetLocationError::SettingsUnreadable)
        );
    }

    #[test]
    fn fails_when_the_settings_file_is_not_valid_settings_json() {
        let padded_city: Value = json!({ "location": { "city": "Lyon " } });

        for stored_text in [String::from("{ not json"), padded_city.to_string()] {
            let directory = TestDirectory::create("location-unusable");
            let settings_path = directory.create_file(SETTINGS_FILE_NAME, &stored_text);

            assert_eq!(
                get_saved_location(&settings_path),
                Err(GetLocationError::SettingsUnreadable),
                "{stored_text}"
            );
            assert_eq!(
                fs::read_to_string(&settings_path).expect("read the settings file"),
                stored_text
            );
        }
    }

    #[test]
    fn serializes_failures_with_a_camel_case_code() {
        assert_eq!(
            serde_json::to_value(GetLocationError::LocationNotSet).expect("serialize"),
            json!({ "code": "locationNotSet" })
        );
        assert_eq!(
            serde_json::to_value(GetLocationError::SettingsUnreadable).expect("serialize"),
            json!({ "code": "settingsUnreadable" })
        );
    }
}
