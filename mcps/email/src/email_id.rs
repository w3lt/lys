//! The id a tool gives a message: `<uid>.<uidvalidity>.<folder>`.
//!
//! The UID and the folder's UIDVALIDITY identify a message until the
//! folder is reset; an id whose folder, UIDVALIDITY, or UID no longer
//! matches is stale, and the tools say so.

use std::fmt;

use crate::failure::ToolFailure;

/// Which message an id names.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EmailId {
    /// The message's UID in its folder.
    pub uid: u32,
    /// The folder's UIDVALIDITY when the id was given.
    pub uid_validity: u32,
    /// The folder's name as the person and the model see it.
    pub folder: String,
}

impl fmt::Display for EmailId {
    /// Formats the id as the tools give it: `<uid>.<uidvalidity>.<folder>`.
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "{}.{}.{}",
            self.uid, self.uid_validity, self.folder
        )
    }
}

/// Parses an id a tool gave.
///
/// # Arguments
///
/// * `text` - The id as the model repeats it.
///
/// # Returns
///
/// The id, or `InvalidId` when the text is not `uid.uidvalidity.folder`
/// with two positive numbers and a folder name without control
/// characters.
pub fn parse_email_id(text: &str) -> Result<EmailId, ToolFailure> {
    let (uid, rest) = text.split_once('.').ok_or(ToolFailure::InvalidId)?;
    let (uid_validity, folder) = rest.split_once('.').ok_or(ToolFailure::InvalidId)?;
    let uid = parse_positive(uid)?;
    let uid_validity = parse_positive(uid_validity)?;
    if folder.is_empty() || folder.chars().any(char::is_control) {
        return Err(ToolFailure::InvalidId);
    }
    Ok(EmailId {
        uid,
        uid_validity,
        folder: folder.to_owned(),
    })
}

/// Parses a positive decimal number of an id.
fn parse_positive(text: &str) -> Result<u32, ToolFailure> {
    if text.is_empty() || !text.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(ToolFailure::InvalidId);
    }
    match text.parse::<u32>() {
        Ok(0) | Err(_) => Err(ToolFailure::InvalidId),
        Ok(value) => Ok(value),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_and_formats_ids_with_dots_in_the_folder_name() {
        let id = parse_email_id("12.345.Projects/2026.11").expect("id");

        assert_eq!(
            id,
            EmailId {
                uid: 12,
                uid_validity: 345,
                folder: "Projects/2026.11".to_owned()
            }
        );
        assert_eq!(id.to_string(), "12.345.Projects/2026.11");
    }

    #[test]
    fn refuses_ids_that_are_not_two_positive_numbers_and_a_folder() {
        for text in [
            "",
            "12",
            "12.345",
            "12.345.",
            "0.345.INBOX",
            "12.0.INBOX",
            "a.345.INBOX",
            "12.345.IN\nBOX",
            "-1.345.INBOX",
            "99999999999.1.INBOX",
        ] {
            assert_eq!(parse_email_id(text), Err(ToolFailure::InvalidId), "{text}");
        }
    }
}
