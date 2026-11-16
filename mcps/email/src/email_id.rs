//! The id a tool gives a message: `<uid>.<uidvalidity>.<folder>` in the
//! person's mailbox, and `lys.<uid>.<uidvalidity>.<folder>` in Lys's own.
//!
//! The UID and the folder's UIDVALIDITY identify a message until the
//! folder is reset; an id whose folder, UIDVALIDITY, or UID no longer
//! matches is stale, and the tools say so. An id names its mailbox, so a
//! tool of one mailbox refuses an id of the other rather than reading
//! whatever message the other mailbox's folder holds at that UID.

use std::fmt;

use crate::failure::ToolFailure;
use crate::mailbox::Mailbox;

/// Which message an id names.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EmailId {
    /// The mailbox the message is in.
    pub mailbox: Mailbox,
    /// The message's UID in its folder.
    pub uid: u32,
    /// The folder's UIDVALIDITY when the id was given.
    pub uid_validity: u32,
    /// The folder's name as the person and the model see it.
    pub folder: String,
}

impl fmt::Display for EmailId {
    /// Formats the id as the tools give it: the mailbox's id prefix, then
    /// `<uid>.<uidvalidity>.<folder>`.
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "{}{}.{}.{}",
            self.mailbox.id_prefix(),
            self.uid,
            self.uid_validity,
            self.folder
        )
    }
}

/// One folder of a mailbox as it was opened: where the ids of its messages
/// point.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FolderPlace<'a> {
    /// The mailbox the folder is in.
    pub mailbox: Mailbox,
    /// The folder's name as the person and the model see it.
    pub folder: &'a str,
    /// The folder's UIDVALIDITY when it was opened.
    pub uid_validity: u32,
}

impl FolderPlace<'_> {
    /// Builds the id of the folder's message with the UID.
    ///
    /// # Arguments
    ///
    /// * `uid` - The message's UID in the folder.
    pub fn build_id(&self, uid: u32) -> EmailId {
        EmailId {
            mailbox: self.mailbox,
            uid,
            uid_validity: self.uid_validity,
            folder: self.folder.to_owned(),
        }
    }
}

/// Parses an id a tool gave, for a tool of the mailbox.
///
/// # Arguments
///
/// * `text` - The id as the model repeats it.
/// * `mailbox` - The mailbox of the tool the id was given to.
///
/// # Returns
///
/// The id, `InvalidId` when the text is not `uid.uidvalidity.folder`, with
/// `lys.` before it for an id of Lys's mailbox, with two positive numbers
/// and a folder name without control characters, or for a valid id of
/// Lys's mailbox given to the person's tools, which never name her
/// mailbox; or `OtherMailboxId` for a valid id of the person's mailbox
/// given to Lys's tools.
pub fn parse_email_id(text: &str, mailbox: Mailbox) -> Result<EmailId, ToolFailure> {
    let (found, rest) = match text.strip_prefix(Mailbox::Lys.id_prefix()) {
        Some(rest) => (Mailbox::Lys, rest),
        None => (Mailbox::Person, text),
    };
    let invalid = || ToolFailure::InvalidId(mailbox);
    let (uid, rest) = rest.split_once('.').ok_or_else(invalid)?;
    let (uid_validity, folder) = rest.split_once('.').ok_or_else(invalid)?;
    let uid = parse_positive(uid).ok_or_else(invalid)?;
    let uid_validity = parse_positive(uid_validity).ok_or_else(invalid)?;
    if folder.is_empty() || folder.chars().any(char::is_control) {
        return Err(invalid());
    }
    match (found, mailbox) {
        (Mailbox::Person, Mailbox::Lys) => return Err(ToolFailure::OtherMailboxId),
        (Mailbox::Lys, Mailbox::Person) => return Err(invalid()),
        (Mailbox::Person, Mailbox::Person) | (Mailbox::Lys, Mailbox::Lys) => {}
    }
    Ok(EmailId {
        mailbox,
        uid,
        uid_validity,
        folder: folder.to_owned(),
    })
}

/// Parses a positive decimal number of an id.
///
/// # Arguments
///
/// * `text` - The number's part of the id.
///
/// # Returns
///
/// The number, or `None` when the text is empty, holds anything but ASCII
/// digits, is 0, or does not fit in 32 bits.
fn parse_positive(text: &str) -> Option<u32> {
    if text.is_empty() || !text.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    text.parse::<u32>().ok().filter(|value| *value > 0)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Checks that an email id whose folder name holds dots parses into its
    /// UID, its UIDVALIDITY, and the whole folder name, in the person's
    /// mailbox without a prefix and in Lys's with `lys.`, and formats back
    /// to the same text.
    #[test]
    fn parses_and_formats_ids_of_each_mailbox_with_dots_in_the_folder_name() {
        for (mailbox, text) in [
            (Mailbox::Person, "12.345.Projects/2026.11"),
            (Mailbox::Lys, "lys.12.345.Projects/2026.11"),
        ] {
            let id = parse_email_id(text, mailbox).expect("id");

            assert_eq!(
                id,
                EmailId {
                    mailbox,
                    uid: 12,
                    uid_validity: 345,
                    folder: "Projects/2026.11".to_owned()
                }
            );
            assert_eq!(id.to_string(), text);
        }
    }

    /// Checks that a folder place builds the ids of its mailbox's messages.
    #[test]
    fn builds_the_ids_of_an_opened_folder() {
        let place = FolderPlace {
            mailbox: Mailbox::Lys,
            folder: "Drafts",
            uid_validity: 1003,
        };

        assert_eq!(place.build_id(7).to_string(), "lys.7.1003.Drafts");
    }

    /// Checks that `InvalidId`, naming the tool's mailbox, comes for an id
    /// missing a number or the folder, with a number that is zero, signed,
    /// not a number, or past 32 bits, or with a line break in the folder
    /// name, with or without the `lys.` prefix.
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
            "lys.",
            "lys.12.345",
            "LYS.12.345.INBOX",
            "lys.0.345.INBOX",
        ] {
            for mailbox in [Mailbox::Person, Mailbox::Lys] {
                assert_eq!(
                    parse_email_id(text, mailbox),
                    Err(ToolFailure::InvalidId(mailbox)),
                    "{text}"
                );
            }
        }
    }

    /// Checks that a valid id of the person's mailbox, given to Lys's
    /// tools, is refused with `OtherMailboxId`, and one of Lys's mailbox,
    /// given to the person's tools, as `InvalidId`, which names no other
    /// mailbox.
    #[test]
    fn refuses_a_valid_id_of_the_other_mailbox() {
        assert_eq!(
            parse_email_id("12.345.INBOX", Mailbox::Lys),
            Err(ToolFailure::OtherMailboxId)
        );
        assert_eq!(
            parse_email_id("lys.12.345.INBOX", Mailbox::Person),
            Err(ToolFailure::InvalidId(Mailbox::Person))
        );
    }
}
