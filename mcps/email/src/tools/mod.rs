//! The tools the server offers the model, each over connections opened
//! for the call and closed after it.
//!
//! A tool takes its arguments as a struct the MCP schema is derived from,
//! and answers a [`ToolReport`] or a [`ToolFailure`]: the text the model
//! reads, or one actionable sentence. Nothing stays open between calls.

pub mod drafts;
pub mod folders;
pub mod read;
pub mod search;
pub mod send;

use std::sync::atomic::{AtomicU64, Ordering};

use crate::account::Account;
use crate::email_id::EmailId;
use crate::failure::{Protocol, ToolFailure};
use crate::folders::{Folder, FolderRole, build_folders, find_folder, find_role_folder};
use crate::imap::{FolderAccess, ImapFailure, ImapSession, open_imap_session};
use crate::trust::Trust;

/// Longest text a tool answers, in UTF-16 code units as the backend
/// counts them, inclusive; a longer one is cut so that it ends with
/// [`CUT_NOTE`] within the limit.
pub const RESULT_LIMIT: usize = 20_000;

/// The note a cut result ends with.
pub const CUT_NOTE: &str = "\n\n[The result was cut at 20,000 characters.]";

/// Longest text argument, such as a search text or a subject, in
/// characters.
pub const MAXIMUM_TEXT_ARGUMENT_LENGTH: usize = 998;

/// Longest folder name argument, in characters.
pub const MAXIMUM_FOLDER_NAME_LENGTH: usize = 255;

/// What every tool call works with.
///
/// Concurrency model: concurrent; calls share it and every operation may
/// overlap, as the sequence counter is atomic and [`Self::open_imap`]
/// opens a session of its own each time. Resource ownership: owns the
/// account and the trust; the sessions it opens belong to their callers.
#[derive(Debug)]
pub struct ToolContext {
    /// The account the tools act for.
    pub account: Account,
    /// Which server certificates are accepted.
    pub trust: Trust,
    /// The number of the next message composed, for its identifier.
    sequence: AtomicU64,
}

impl ToolContext {
    /// Creates the context of the server's tools.
    ///
    /// # Arguments
    ///
    /// * `account` - The account.
    /// * `trust` - Which server certificates are accepted.
    pub fn new(account: Account, trust: Trust) -> Self {
        Self {
            account,
            trust,
            sequence: AtomicU64::new(1),
        }
    }

    /// Takes the next sequence number for a message identifier.
    pub fn create_message_sequence(&self) -> u64 {
        self.sequence.fetch_add(1, Ordering::Relaxed)
    }

    /// Connects to the IMAP server and signs in.
    ///
    /// # Returns
    ///
    /// The session, or the sign-in failure as the model reads it.
    pub async fn open_imap(&self) -> Result<ImapSession, ToolFailure> {
        open_imap_session(&self.account, &self.trust)
            .await
            .map_err(|failure| ToolFailure::SignIn {
                protocol: Protocol::Imap,
                failure,
            })
    }
}

/// What a tool answers when it did its work.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ToolReport {
    /// The text the model reads.
    pub text: String,
    /// What the log line says about the call: counts and folders, never
    /// an address, a subject, or a body.
    pub log: String,
}

/// The outcome of a tool call.
pub type ToolResult = Result<ToolReport, ToolFailure>;

/// Cuts a result longer than [`RESULT_LIMIT`] on a character boundary,
/// so that with [`CUT_NOTE`] after it, it is at most the limit.
///
/// # Arguments
///
/// * `text` - The result as the tool built it.
///
/// # Returns
///
/// The text itself when it fits; otherwise its longest beginning that
/// fits with the note, then the note.
pub fn format_result_text(text: String) -> String {
    if calculate_utf16_length(&text) <= RESULT_LIMIT {
        return text;
    }
    let kept_length = RESULT_LIMIT - calculate_utf16_length(CUT_NOTE);
    let mut cut = text;
    cut.truncate(calculate_utf16_cut(&cut, kept_length));
    cut.push_str(CUT_NOTE);
    cut
}

/// Counts a text's UTF-16 code units, as the backend measures a result.
///
/// # Arguments
///
/// * `text` - The text.
fn calculate_utf16_length(text: &str) -> usize {
    text.encode_utf16().count()
}

/// Calculates where a text ends when it is cut to a number of UTF-16 code
/// units without splitting a character.
///
/// # Arguments
///
/// * `text` - The text.
/// * `limit` - Most code units kept, inclusive.
///
/// # Returns
///
/// The byte index of the first character that would pass the limit, or
/// the text's length when it fits.
fn calculate_utf16_cut(text: &str, limit: usize) -> usize {
    let mut length = 0;
    for (index, character) in text.char_indices() {
        length += character.len_utf16();
        if length > limit {
            return index;
        }
    }
    text.len()
}

/// Builds the conversion of an IMAP failure into a tool failure.
///
/// # Arguments
///
/// * `operation` - What the command was to do, as a verb phrase such as
///   `select the folder`.
pub fn build_imap_failure_conversion(
    operation: &'static str,
) -> impl Fn(ImapFailure) -> ToolFailure {
    move |failure| match failure {
        ImapFailure::Refused(text) => ToolFailure::ImapRefused { operation, text },
        ImapFailure::Connection(failure) => ToolFailure::Connection {
            protocol: Protocol::Imap,
            failure,
        },
    }
}

/// Lists and classifies the account's folders.
///
/// # Arguments
///
/// * `session` - The signed-in session.
pub async fn load_folders(session: &mut ImapSession) -> Result<Vec<Folder>, ToolFailure> {
    let listings = session
        .list_folders()
        .await
        .map_err(build_imap_failure_conversion("list the folders"))?;
    Ok(build_folders(&listings))
}

/// Finds the folder with the name, or fails as the model reads it.
///
/// # Arguments
///
/// * `folders` - The classified folders.
/// * `name` - The name asked for.
pub fn get_folder<'a>(folders: &'a [Folder], name: &str) -> Result<&'a Folder, ToolFailure> {
    find_folder(folders, name).ok_or_else(|| ToolFailure::FolderMissing(name.to_owned()))
}

/// Finds the folder with the role, or fails as the model reads it.
///
/// # Arguments
///
/// * `folders` - The classified folders.
/// * `role` - The role needed.
pub fn get_role_folder(folders: &[Folder], role: FolderRole) -> Result<&Folder, ToolFailure> {
    find_role_folder(folders, role).ok_or(ToolFailure::NoRoleFolder(role))
}

/// Finds the folder with the name that a tool may change, or fails as the
/// model reads it: a folder with a role is refused.
///
/// # Arguments
///
/// * `folders` - The classified folders.
/// * `name` - The name asked for.
pub fn get_changeable_folder<'a>(
    folders: &'a [Folder],
    name: &str,
) -> Result<&'a Folder, ToolFailure> {
    let folder = get_folder(folders, name)?;
    match folder.role {
        Some(role) => Err(ToolFailure::RoleFolder {
            name: folder.name.clone(),
            role,
        }),
        None => Ok(folder),
    }
}

/// Opens the folder of a message id read-only and checks that the id is
/// still valid there.
///
/// # Arguments
///
/// * `session` - The signed-in session.
/// * `folders` - The classified folders.
/// * `id` - The id.
///
/// # Returns
///
/// Nothing when the folder is open at the id, or `StaleId` when the
/// folder is gone, cannot be opened, or its UIDVALIDITY changed.
pub async fn open_id_folder(
    session: &mut ImapSession,
    folders: &[Folder],
    id: &EmailId,
) -> Result<(), ToolFailure> {
    let folder = find_folder(folders, &id.folder).ok_or(ToolFailure::StaleId)?;
    if !folder.selectable {
        return Err(ToolFailure::StaleId);
    }
    let opened = session
        .open_folder(&folder.raw_name, FolderAccess::Read)
        .await
        .map_err(build_imap_failure_conversion("select the folder"))?;
    if opened.uid_validity != id.uid_validity {
        return Err(ToolFailure::StaleId);
    }
    Ok(())
}

/// Parses a text argument: at most `limit` characters, no control
/// character, which would break the protocol.
///
/// # Arguments
///
/// * `name` - The argument's name, for the failure.
/// * `value` - The value given.
/// * `limit` - The longest value allowed, in characters.
///
/// # Returns
///
/// The value, or the rule it breaks as the model reads it.
pub fn parse_text_argument<'a>(
    name: &str,
    value: &'a str,
    limit: usize,
) -> Result<&'a str, ToolFailure> {
    if value.chars().any(char::is_control) {
        return Err(ToolFailure::Argument(format!(
            "{name} must not contain line breaks or control characters."
        )));
    }
    if value.chars().count() > limit {
        return Err(ToolFailure::Argument(format!(
            "{name} must be at most {limit} characters."
        )));
    }
    Ok(value)
}

/// Parses a folder name argument: not empty, no edge whitespace, and the
/// text rules.
///
/// # Arguments
///
/// * `name` - The argument's name, for the failure.
/// * `value` - The value given.
///
/// # Returns
///
/// The value, or the rule it breaks as the model reads it.
pub fn parse_folder_name_argument<'a>(name: &str, value: &'a str) -> Result<&'a str, ToolFailure> {
    parse_text_argument(name, value, MAXIMUM_FOLDER_NAME_LENGTH)?;
    if value.is_empty() || value.trim() != value {
        return Err(ToolFailure::Argument(format!(
            "{name} must be a folder name without whitespace at its edges."
        )));
    }
    Ok(value)
}

/// Formats a text as the JSON string the model gives it in as an
/// argument: quoted, with JSON's escapes.
///
/// # Arguments
///
/// * `text` - The text.
pub(crate) fn format_text_argument(text: &str) -> String {
    serde_json::Value::String(text.to_owned()).to_string()
}

/// Formats texts as the JSON array the model gives them in as an
/// argument, such as `["a@example.com", "Jane <jane@example.com>"]`.
///
/// # Arguments
///
/// * `texts` - The texts, in order.
pub(crate) fn format_list_argument(texts: &[String]) -> String {
    let items: Vec<String> = texts
        .iter()
        .map(|text| format_text_argument(text))
        .collect();
    format!("[{}]", items.join(", "))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cuts_long_results_to_the_limit_in_utf16_units_with_the_note() {
        let kept_length = RESULT_LIMIT - CUT_NOTE.encode_utf16().count();
        let emoji = "\u{1F600}";
        let whole_ascii = "x".repeat(RESULT_LIMIT);
        let whole_emoji = emoji.repeat(RESULT_LIMIT / 2);

        let cut_ascii = format_result_text("x".repeat(RESULT_LIMIT + 1));
        let cut_emoji = format_result_text(emoji.repeat(RESULT_LIMIT / 2 + 1));
        let cut_mid_pair = format_result_text(format!("x{whole_emoji}"));

        assert_eq!(format_result_text(whole_ascii.clone()), whole_ascii);
        assert_eq!(format_result_text(whole_emoji.clone()), whole_emoji);
        assert_eq!(cut_ascii, format!("{}{CUT_NOTE}", "x".repeat(kept_length)));
        assert_eq!(
            cut_emoji,
            format!("{}{CUT_NOTE}", emoji.repeat(kept_length / 2))
        );
        assert_eq!(
            cut_mid_pair,
            format!("x{}{CUT_NOTE}", emoji.repeat((kept_length - 1) / 2))
        );
        assert_eq!(cut_ascii.encode_utf16().count(), RESULT_LIMIT);
        assert_eq!(cut_emoji.encode_utf16().count(), RESULT_LIMIT);
        assert_eq!(cut_mid_pair.encode_utf16().count(), RESULT_LIMIT - 1);
    }

    #[test]
    fn formats_texts_and_lists_as_json_arguments() {
        assert_eq!(format_text_argument("Re: \"Hi\""), "\"Re: \\\"Hi\\\"\"");
        assert_eq!(format_list_argument(&[]), "[]");
        assert_eq!(
            format_list_argument(&[
                "a@example.com".to_owned(),
                "\"Doe, Jane\" <j@example.com>".to_owned()
            ]),
            "[\"a@example.com\", \"\\\"Doe, Jane\\\" <j@example.com>\"]"
        );
    }

    #[test]
    fn checks_text_and_folder_name_arguments() {
        assert_eq!(parse_text_argument("text", "fine", 10), Ok("fine"));
        assert_eq!(
            parse_text_argument("text", "a\nb", 10),
            Err(ToolFailure::Argument(
                "text must not contain line breaks or control characters.".to_owned()
            ))
        );
        assert_eq!(
            parse_text_argument("text", "elevenchars", 10),
            Err(ToolFailure::Argument(
                "text must be at most 10 characters.".to_owned()
            ))
        );
        assert_eq!(
            parse_folder_name_argument("name", "Projects"),
            Ok("Projects")
        );
        assert!(parse_folder_name_argument("name", "").is_err());
        assert!(parse_folder_name_argument("name", " Projects").is_err());
    }

    #[test]
    fn gets_folders_that_can_change_and_refuses_role_and_missing_ones() {
        let folders = vec![
            Folder {
                name: "INBOX".to_owned(),
                raw_name: "INBOX".to_owned(),
                role: Some(FolderRole::Inbox),
                selectable: true,
                delimiter: Some("/".to_owned()),
            },
            Folder {
                name: "Projects".to_owned(),
                raw_name: "Projects".to_owned(),
                role: None,
                selectable: true,
                delimiter: Some("/".to_owned()),
            },
        ];

        assert_eq!(
            get_changeable_folder(&folders, "INBOX"),
            Err(ToolFailure::RoleFolder {
                name: "INBOX".to_owned(),
                role: FolderRole::Inbox
            })
        );
        assert_eq!(get_changeable_folder(&folders, "Projects"), Ok(&folders[1]));
        assert_eq!(
            get_changeable_folder(&folders, "Archive"),
            Err(ToolFailure::FolderMissing("Archive".to_owned()))
        );
    }

    #[test]
    fn converts_imap_failures() {
        assert_eq!(
            build_imap_failure_conversion("search")(ImapFailure::Refused("bad".to_owned())),
            ToolFailure::ImapRefused {
                operation: "search",
                text: "bad".to_owned()
            }
        );
        assert_eq!(
            build_imap_failure_conversion("search")(ImapFailure::Connection(
                crate::failure::ConnectionFailure::Lost
            )),
            ToolFailure::Connection {
                protocol: Protocol::Imap,
                failure: crate::failure::ConnectionFailure::Lost
            }
        );
    }
}
