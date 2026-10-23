//! The location the person saved, stored under the `location` settings group.
//!
//! The person types the location in Settings → Tools as a city, a region, and
//! a country, each optional; Lys never detects it. A missing group, a group
//! whose parts are all `null`, and a settings file written before the group
//! existed all mean that no location is saved. The `get_location` tool reads
//! the group from the saved file; this module only stores it.
//!
//! The location is personal data. It is stored as plain text in the
//! owner-only settings file, `Debug` never shows it, and a validation error
//! never quotes it.

use std::fmt;

use serde::de::Error;
use serde::{Deserialize, Serialize};

/// Most characters, counted as Unicode scalar values, a place name may have,
/// inclusive. Matches `MAXIMUM_PLACE_NAME_LENGTH` in `@lys/share`, which the
/// renderer checks.
const PLACE_NAME_MAX_LENGTH: usize = 100;

#[derive(Clone, PartialEq, Eq, Serialize)]
#[serde(transparent)]
/// Name of a city, region, or country as the person typed it.
///
/// Holds 1 to 100 characters, none of them a control character, with no white
/// space at either end. It serializes as a JSON string. `Debug` never shows
/// the name.
pub struct PlaceName(
    /// The validated name.
    String,
);

impl PlaceName {
    /// Creates a name when `value` follows the place name rule.
    ///
    /// Returns `None` otherwise; the value is never trimmed or changed.
    pub fn new(value: String) -> Option<Self> {
        let is_valid = (1..=PLACE_NAME_MAX_LENGTH).contains(&value.chars().count())
            && !value.chars().any(char::is_control)
            && !value.starts_with(char::is_whitespace)
            && !value.ends_with(char::is_whitespace);

        is_valid.then_some(Self(value))
    }
}

impl fmt::Debug for PlaceName {
    /// Writes a placeholder instead of the name.
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("PlaceName(<redacted>)")
    }
}

/// Deserializes a JSON string and applies [`PlaceName`] validation.
impl<'de> Deserialize<'de> for PlaceName {
    /// Reads a JSON string and rejects one that is not a valid place name.
    ///
    /// # Errors
    ///
    /// Returns the deserializer's error when the input is not a string or not
    /// a valid place name. The error never contains the value.
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;

        Self::new(value).ok_or_else(|| {
            D::Error::custom(
                "a place name must be 1 to 100 characters, without control characters or white space at either end",
            )
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields, rename_all = "camelCase")]
/// Location persisted under the `location` JSON object.
///
/// Each part is a [`PlaceName`] or `None`, JSON `null`; a missing part is
/// `None`. The group may not be `null`, and unknown fields are rejected.
pub struct LocationSettings {
    /// City, town, or other locality; `None` when not saved.
    city: Option<PlaceName>,
    /// State, province, or other region; `None` when not saved.
    region: Option<PlaceName>,
    /// Country; `None` when not saved.
    country: Option<PlaceName>,
}

impl LocationSettings {
    /// Reports whether at least one part of the location is saved.
    pub fn is_saved(&self) -> bool {
        self.city.is_some() || self.region.is_some() || self.country.is_some()
    }
}

#[cfg(test)]
mod tests {
    use serde_json::{json, Value};

    use super::{LocationSettings, PlaceName};

    /// Reads `stored` as the `location` group.
    fn parse_location_settings(stored: Value) -> Result<LocationSettings, serde_json::Error> {
        serde_json::from_value(stored)
    }

    #[test]
    fn accepts_names_of_one_to_100_characters_with_inner_spaces_and_accents() {
        for value in [
            "Y",
            "Saint-Étienne",
            "New South Wales",
            "東京都",
            &"é".repeat(100),
        ] {
            assert!(PlaceName::new(value.to_string()).is_some(), "{value}");
        }
    }

    #[test]
    fn rejects_empty_long_padded_and_control_character_names() {
        for value in [
            String::new(),
            "é".repeat(101),
            " Lyon".to_string(),
            "Lyon ".to_string(),
            "Lyon\u{00a0}".to_string(),
            "\u{3000}Lyon".to_string(),
            "Ly\non".to_string(),
            "Ly\u{0007}on".to_string(),
        ] {
            assert!(PlaceName::new(value.clone()).is_none(), "{value:?}");
        }
    }

    #[test]
    fn debug_output_never_shows_the_location() {
        let location =
            parse_location_settings(json!({ "city": "Lyon", "region": null, "country": "France" }))
                .expect("a valid location");

        let debug_output = format!("{location:?}");

        assert!(!debug_output.contains("Lyon"), "{debug_output}");
        assert!(!debug_output.contains("France"), "{debug_output}");
    }

    #[test]
    fn reads_missing_parts_as_not_saved_and_writes_every_part() {
        let location =
            parse_location_settings(json!({ "country": "France" })).expect("a valid location");

        assert!(location.is_saved());
        assert_eq!(
            serde_json::to_value(&location).expect("serialize"),
            json!({ "city": null, "region": null, "country": "France" })
        );
    }

    #[test]
    fn saves_no_location_in_an_empty_group_or_a_group_of_nulls() {
        for stored in [
            json!({}),
            json!({ "city": null, "region": null, "country": null }),
        ] {
            let location = parse_location_settings(stored.clone()).expect("a valid group");

            assert!(!location.is_saved(), "{stored}");
        }
        assert!(!LocationSettings::default().is_saved());
    }

    #[test]
    fn rejects_a_null_group_unknown_fields_and_invalid_names_without_quoting_them() {
        for stored in [
            Value::Null,
            json!({ "city": "Lyon", "latitude": 45.76 }),
            json!({ "city": " Lyon" }),
            json!({ "country": 33 }),
        ] {
            let failure = parse_location_settings(stored.clone()).expect_err("an invalid group");

            assert!(!failure.to_string().contains("Lyon"), "{failure}");
        }
    }
}
