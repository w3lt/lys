//! The `get_location` tool, which reads the location the person saved in
//! Settings.
//!
//! The location is never detected: no Location Services, no network lookup,
//! no guess from the time zone. Without a saved location the tool fails.

use serde::Serialize;
use tauri::State;

use super::definition::{ToolAccess, ToolDefinition, ToolGroup, ToolRunner};
use crate::{
    settings::{location::LocationSettings, LysSettings},
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
/// Rejects with [`GetLocationError::LocationNotSet`] when no location is
/// saved, and with [`GetLocationError::SettingsUnreadable`] when the settings
/// file cannot be read or parsed.
pub fn get_location(lys_home: State<'_, LysHome>) -> Result<LocationSettings, GetLocationError> {
    let settings =
        LysSettings::find_settings(&lys_home).map_err(|_| GetLocationError::SettingsUnreadable)?;

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
    use serde_json::{json, Value};

    use super::{find_saved_location, GetLocationError};
    use crate::settings::LysSettings;

    /// Reads `stored` as a settings file.
    fn parse_settings(stored: Value) -> LysSettings {
        serde_json::from_value(stored).expect("valid settings")
    }

    #[test]
    fn gives_every_saved_part_and_null_for_the_others() {
        let settings = parse_settings(json!({
            "location": { "city": "Lyon", "region": null, "country": "France" }
        }));

        let location = find_saved_location(Some(&settings)).expect("a saved location");

        assert_eq!(
            serde_json::to_value(location).expect("serialize"),
            json!({ "city": "Lyon", "region": null, "country": "France" })
        );
    }

    #[test]
    fn fails_without_a_settings_file() {
        assert_eq!(
            find_saved_location(None),
            Err(GetLocationError::LocationNotSet)
        );
    }

    #[test]
    fn fails_when_no_part_of_the_location_is_saved() {
        for stored in [
            json!({}),
            json!({ "location": {} }),
            json!({ "location": { "city": null, "region": null, "country": null } }),
        ] {
            let settings = parse_settings(stored.clone());

            assert_eq!(
                find_saved_location(Some(&settings)),
                Err(GetLocationError::LocationNotSet),
                "{stored}"
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
