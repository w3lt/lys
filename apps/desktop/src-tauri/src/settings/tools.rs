//! Tool choices stored under the `tools` settings group.
//!
//! The group holds the names of the tools the person set to Just run, and the
//! on or off switch of each tool the person switched. Every other tool asks
//! the person before each call, so a missing group, an empty list, and a
//! settings file written before the group existed all mean that every tool
//! asks. A tool without a saved switch keeps the default of its access, which
//! the renderer decides. The backend's tool approval service reads the Just
//! run names from the saved file for every round of tool calls, and the
//! renderer reads the switches; this module only stores them.
//!
//! The group also holds the folders the person lets tools use. With none
//! listed, tools may name any path. The backend's tool call policy reads the
//! list for every round of tool calls, and the desktop's file tools read it
//! for every call, through [`ToolSettings::approved_folders`].

use std::{
    collections::{BTreeMap, BTreeSet},
    path::Path,
};

use serde::de::Error;
use serde::{Deserialize, Serialize};

/// Most characters, counted as Unicode scalar values, an approved folder's
/// path may have, inclusive. Matches `MAXIMUM_APPROVED_FOLDER_PATH_LENGTH` in
/// `@lys/share`, which the renderer and the backend check.
const APPROVED_FOLDER_PATH_MAX_LENGTH: usize = 1024;

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

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(transparent)]
/// Path of a folder the person lets tools use, as they typed it: it starts
/// with `/`, has 1 to 1024 characters, no control character, and no white
/// space at its end.
///
/// It serializes as a JSON string. Paths compare by their text, so a set of
/// paths serializes in ascending order. The path is never trimmed,
/// normalized, or resolved here, and whether the folder exists is not
/// checked. Matches `approvedFolderPathSchema` in `@lys/share`.
pub struct ApprovedFolder(
    /// The validated path.
    String,
);

impl ApprovedFolder {
    /// Creates a folder path when `value` follows the approved folder rule.
    ///
    /// Returns `None` otherwise; the value is never trimmed or changed.
    pub fn new(value: String) -> Option<Self> {
        let is_valid = value.starts_with('/')
            && value.chars().count() <= APPROVED_FOLDER_PATH_MAX_LENGTH
            && !value.chars().any(char::is_control)
            && !value.ends_with(char::is_whitespace);
        is_valid.then_some(Self(value))
    }

    /// Returns the folder's path as saved.
    pub fn path(&self) -> &Path {
        Path::new(&self.0)
    }
}

/// Deserializes a JSON string and applies [`ApprovedFolder`] validation.
impl<'de> Deserialize<'de> for ApprovedFolder {
    /// Reads a JSON string and rejects one that is not a valid folder path.
    ///
    /// # Errors
    ///
    /// Returns the deserializer's error when the input is not a string or not
    /// a valid folder path.
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        Self::new(value).ok_or_else(|| {
            D::Error::custom(
                "a folder must be an absolute path that starts with /, at most 1024 characters, without control characters or spaces at its end",
            )
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields, rename_all = "camelCase")]
/// Tool choices persisted under the `tools` JSON object.
///
/// A missing group or a missing `justRun` list means no tool is on Just run,
/// and a missing `switches` object means no tool has a saved switch. None of
/// them may be `null`, and unknown fields are rejected. A name listed more
/// than once in `justRun` counts once. Names are stored in ascending order,
/// so that saving unchanged choices rewrites the same text. A name Lys does
/// not list is kept and has no effect. A missing `approvedFolders` list means
/// no folder is listed, and an empty list is not written, so a file without
/// folders keeps the form older builds read. A path listed more than once
/// counts once, and paths are stored in ascending order.
pub struct ToolSettings {
    /// Tools that run at once when a model calls them, without asking the
    /// person, in the `justRun` array.
    just_run: BTreeSet<ToolName>,
    /// Whether each tool the person switched is on, in the `switches` object
    /// keyed by tool name. A tool left out keeps its default.
    switches: BTreeMap<ToolName, bool>,
    /// Folders the person lets tools use, in the `approvedFolders` array;
    /// empty when tools may name any path.
    #[serde(skip_serializing_if = "BTreeSet::is_empty")]
    approved_folders: BTreeSet<ApprovedFolder>,
}

impl ToolSettings {
    /// Returns the folders the person lets tools use, in ascending order;
    /// none when tools may name any path.
    pub fn approved_folders(&self) -> impl ExactSizeIterator<Item = &ApprovedFolder> {
        self.approved_folders.iter()
    }
}

#[cfg(test)]
mod tests {
    use serde_json::{json, Value};

    use super::{ApprovedFolder, ToolName, ToolSettings};

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
            json!({ "justRun": ["find_files", "read_page"], "switches": {} })
        );
    }

    #[test]
    fn keeps_every_saved_switch_in_ascending_name_order() {
        let settings = parse_tool_settings(json!({
            "justRun": [],
            "switches": { "web_search": true, "read_text_file": false }
        }))
        .expect("valid tool settings");

        assert_eq!(
            serde_json::to_string(&settings).expect("settings that serialize"),
            r#"{"justRun":[],"switches":{"read_text_file":false,"web_search":true}}"#
        );
    }

    #[test]
    fn reads_a_group_saved_before_switches_existed_as_no_saved_switch() {
        let settings =
            parse_tool_settings(json!({ "justRun": ["read_page"] })).expect("valid tool settings");

        assert_eq!(
            serde_json::to_value(settings).expect("settings that serialize"),
            json!({ "justRun": ["read_page"], "switches": {} })
        );
    }

    #[test]
    fn reads_missing_parts_as_no_tool_on_just_run_and_no_saved_switch() {
        let settings = parse_tool_settings(json!({})).expect("valid tool settings");

        assert_eq!(settings, ToolSettings::default());
        assert_eq!(
            serde_json::to_value(settings).expect("settings that serialize"),
            json!({ "justRun": [], "switches": {} })
        );
    }

    #[test]
    fn accepts_absolute_folder_paths_of_up_to_1024_characters() {
        for value in [
            "/".to_string(),
            "/Users/ada/My Documents".to_string(),
            "/Users/ada/Café".to_string(),
            format!("/{}", "é".repeat(1023)),
        ] {
            assert!(ApprovedFolder::new(value.clone()).is_some(), "{value}");
        }
    }

    #[test]
    fn rejects_relative_long_controlled_and_space_ended_folder_paths() {
        for value in [
            String::new(),
            "Users/ada".to_string(),
            "~/work".to_string(),
            " /Users/ada".to_string(),
            "/Users/ada ".to_string(),
            "/Users/ada\n/etc".to_string(),
            "/Users/ada\u{0}".to_string(),
            format!("/{}", "a".repeat(1024)),
        ] {
            assert!(ApprovedFolder::new(value.clone()).is_none(), "{value:?}");
        }
    }

    #[test]
    fn keeps_each_approved_folder_once_in_ascending_order_and_omits_none() {
        let settings = parse_tool_settings(json!({
            "approvedFolders": ["/srv/shared", "/Users/ada/work", "/srv/shared"]
        }))
        .expect("valid tool settings");

        assert_eq!(
            settings
                .approved_folders()
                .map(|folder| folder.path().to_string_lossy().into_owned())
                .collect::<Vec<_>>(),
            ["/Users/ada/work", "/srv/shared"]
        );
        assert_eq!(
            serde_json::to_value(&settings).expect("settings that serialize"),
            json!({
                "justRun": [],
                "switches": {},
                "approvedFolders": ["/Users/ada/work", "/srv/shared"]
            })
        );
        let without_folders =
            parse_tool_settings(json!({ "approvedFolders": [] })).expect("valid tool settings");
        assert_eq!(without_folders, ToolSettings::default());
    }

    #[test]
    fn rejects_null_parts_invalid_names_and_values_and_an_unknown_field() {
        for stored in [
            json!({ "justRun": null }),
            json!({ "justRun": ["read page"] }),
            json!({ "justRun": [7] }),
            json!({ "justRun": [], "askFirst": [] }),
            json!({ "switches": null }),
            json!({ "switches": [] }),
            json!({ "switches": { "read page": true } }),
            json!({ "switches": { "": true } }),
            json!({ "switches": { "web_search": null } }),
            json!({ "switches": { "web_search": "on" } }),
            json!({ "approvedFolders": null }),
            json!({ "approvedFolders": "/Users/ada" }),
            json!({ "approvedFolders": ["work"] }),
        ] {
            assert!(parse_tool_settings(stored.clone()).is_err(), "{stored}");
        }
    }
}
