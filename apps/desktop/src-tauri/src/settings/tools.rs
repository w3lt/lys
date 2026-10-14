//! Tool choices stored under the `tools` settings group.
//!
//! The group holds the names of the tools the person set to Just run. Every
//! other tool asks the person before each call, so a missing group, an empty
//! list, and a settings file written before the group existed all mean that
//! every tool asks. The backend's tool approval service reads the names from
//! the saved file for every round of tool calls; this module only stores them.

use std::collections::BTreeSet;

use serde::de::Error;
use serde::{Deserialize, Serialize};

/// Most characters a tool name may have, inclusive. Matches the tool name
/// rule of `toolNameSchema` in `@lys/share`, which the renderer and the
/// backend check.
const TOOL_NAME_MAX_LENGTH: usize = 64;

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(transparent)]
/// Name a model calls a tool by: 1 to 64 ASCII letters, digits, underscores,
/// or hyphens.
///
/// It serializes as a JSON string. Names compare by their text, so a set of
/// names serializes in ascending order.
pub struct ToolName(
    /// The validated name.
    String,
);

impl ToolName {
    /// Creates a name when `value` follows the tool name rule.
    ///
    /// Returns `None` otherwise; the value is never trimmed or changed.
    pub fn new(value: String) -> Option<Self> {
        let is_valid = !value.is_empty()
            && value.len() <= TOOL_NAME_MAX_LENGTH
            && value
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-');

        is_valid.then_some(Self(value))
    }
}

/// Deserializes a JSON string and applies [`ToolName`] validation.
impl<'de> Deserialize<'de> for ToolName {
    /// Reads a JSON string and rejects one that is not a valid tool name.
    ///
    /// # Errors
    ///
    /// Returns the deserializer's error when the input is not a string or not
    /// a valid tool name.
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;

        Self::new(value).ok_or_else(|| {
            D::Error::custom(
                "a tool name must be 1 to 64 ASCII letters, digits, underscores, or hyphens",
            )
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields, rename_all = "camelCase")]
/// Tool choices persisted under the `tools` JSON object.
///
/// A missing group or a missing `justRun` list means no tool is on Just run.
/// Neither may be `null`, and unknown fields are rejected. A name listed more
/// than once counts once, and names are stored in ascending order, so that
/// saving unchanged choices rewrites the same text. A name Lys does not list
/// is kept and has no effect.
pub struct ToolSettings {
    /// Tools that run at once when a model calls them, without asking the
    /// person, in the `justRun` array.
    just_run: BTreeSet<ToolName>,
}

#[cfg(test)]
mod tests {
    use serde_json::{json, Value};

    use super::{ToolName, ToolSettings};

    /// Reads `stored` as the `tools` group.
    fn parse_tool_settings(stored: Value) -> Result<ToolSettings, serde_json::Error> {
        serde_json::from_value(stored)
    }

    #[test]
    fn accepts_names_of_one_to_64_letters_digits_underscores_and_hyphens() {
        for value in ["a", "read_page", "web-search-2", &"a".repeat(64)] {
            assert!(ToolName::new(value.to_string()).is_some(), "{value}");
        }
    }

    #[test]
    fn rejects_empty_long_spaced_dotted_and_non_ascii_names() {
        for value in [
            String::new(),
            "a".repeat(65),
            "read page".to_string(),
            "read.page".to_string(),
            "lire_pagé".to_string(),
        ] {
            assert!(ToolName::new(value.clone()).is_none(), "{value:?}");
        }
    }

    #[test]
    fn keeps_each_just_run_name_once_in_ascending_order() {
        let settings =
            parse_tool_settings(json!({ "justRun": ["read_page", "find_files", "read_page"] }))
                .expect("valid tool settings");

        assert_eq!(
            serde_json::to_value(settings).expect("settings that serialize"),
            json!({ "justRun": ["find_files", "read_page"] })
        );
    }

    #[test]
    fn reads_a_missing_list_as_no_tool_on_just_run() {
        let settings = parse_tool_settings(json!({})).expect("valid tool settings");

        assert_eq!(settings, ToolSettings::default());
        assert_eq!(
            serde_json::to_value(settings).expect("settings that serialize"),
            json!({ "justRun": [] })
        );
    }

    #[test]
    fn rejects_a_null_list_an_invalid_name_and_an_unknown_field() {
        for stored in [
            json!({ "justRun": null }),
            json!({ "justRun": ["read page"] }),
            json!({ "justRun": [7] }),
            json!({ "justRun": [], "askFirst": [] }),
        ] {
            assert!(parse_tool_settings(stored.clone()).is_err(), "{stored}");
        }
    }
}
