//! `read_email`, `read_conversation`, and `read_attachment`: one message,
//! its thread, or one of its attachments, never marking anything as read.

use std::collections::HashSet;

use schemars::JsonSchema;
use serde::Deserialize;

use super::search::{Hit, HitQuery, calculate_hit_order, list_folder_hits};
use super::{
    ToolContext, ToolReport, ToolResult, build_imap_failure_conversion, load_folders,
    open_id_folder,
};
use crate::email_id::{EmailId, parse_email_id};
use crate::failure::{ConnectionFailure, Protocol, ToolFailure};
use crate::folders::{Folder, FolderRole};
use crate::imap::{FetchedMessage, Flags, FolderAccess, ImapSession, format_search_text};
use crate::message::{MessageView, format_size, parse_message};

/// Most messages a conversation shows: the newest ones.
pub const CONVERSATION_LIMIT: usize = 50;

/// Most characters of a message's text shown inside a conversation.
pub const CONVERSATION_TEXT_LIMIT: usize = 3_000;

/// Most identifiers a conversation search asks the server about.
const CONVERSATION_ID_LIMIT: usize = 30;

/// The arguments of `read_email` and `read_conversation`.
#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct IdArguments {
    /// The message id as search_emails gave it, such as 12.345.INBOX.
    pub id: String,
}

/// The arguments of `read_attachment`.
#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct AttachmentArguments {
    /// The message id as search_emails gave it, such as 12.345.INBOX.
    pub id: String,
    /// The attachment's number as read_email lists it, from 1.
    pub attachment: u32,
}

/// Reads one message.
///
/// # Arguments
///
/// * `context` - The account and trust.
/// * `arguments` - Which message.
pub async fn run_read_email(context: &ToolContext, arguments: IdArguments) -> ToolResult {
    let id = parse_email_id(&arguments.id)?;
    let mut session = context.open_imap().await?;
    let folders = load_folders(&mut session).await?;
    let (fetched, view) = get_message_view(&mut session, &folders, &id).await?;
    session.close().await;
    let text = format_message_view(&id, fetched.flags, &view);
    Ok(ToolReport {
        text,
        log: format!(
            "read: {} byte(s), {} attachment(s)",
            fetched.bytes.len(),
            view.attachments.len()
        ),
    })
}

/// Reads the conversation a message belongs to.
///
/// # Arguments
///
/// * `context` - The account and trust.
/// * `arguments` - Which message.
pub async fn run_read_conversation(context: &ToolContext, arguments: IdArguments) -> ToolResult {
    let id = parse_email_id(&arguments.id)?;
    let mut session = context.open_imap().await?;
    let folders = load_folders(&mut session).await?;
    let (_, view) = get_message_view(&mut session, &folders, &id).await?;
    let identifiers = list_conversation_identifiers(&view);
    let mut hits = Vec::new();
    let mut seen_identifiers = HashSet::new();
    if let Some(criteria) = build_conversation_criteria(&identifiers) {
        for folder in folders
            .iter()
            .filter(|folder| folder.selectable && folder.role != Some(FolderRole::All))
        {
            let query = HitQuery {
                criteria: &criteria,
                limit: CONVERSATION_LIMIT,
            };
            let (found, _) = list_folder_hits(&mut session, folder, query).await?;
            for hit in found {
                let new = match &hit.headers.message_id {
                    Some(message_id) => seen_identifiers.insert(message_id.clone()),
                    None => true,
                };
                if new {
                    hits.push(hit);
                }
            }
        }
    }
    if hits.is_empty() {
        hits.push(Hit {
            id: id.clone(),
            flags: Flags::default(),
            headers: view.headers.clone(),
            timestamp: view.headers.timestamp.unwrap_or_default(),
            date: view
                .headers
                .date
                .clone()
                .unwrap_or_else(|| "unknown".to_owned()),
        });
    }
    hits.sort_by(calculate_hit_order);
    let total = hits.len();
    hits.truncate(CONVERSATION_LIMIT);
    hits.reverse();
    let mut text = format!(
        "The conversation has {total} {}, oldest first.",
        if total == 1 { "message" } else { "messages" }
    );
    if total > CONVERSATION_LIMIT {
        text.push_str(&format!(" Only the newest {CONVERSATION_LIMIT} are shown."));
    }
    let mut current_folder: Option<String> = None;
    for hit in &hits {
        if current_folder.as_deref() != Some(&hit.id.folder) {
            let folder = folders
                .iter()
                .find(|folder| folder.name == hit.id.folder)
                .ok_or(ToolFailure::StaleId)?;
            session
                .open_folder(&folder.raw_name, FolderAccess::Read)
                .await
                .map_err(build_imap_failure_conversion("select the folder"))?;
            current_folder = Some(hit.id.folder.clone());
        }
        let fetched = session
            .find_message(hit.id.uid)
            .await
            .map_err(build_imap_failure_conversion("fetch the message"))?;
        text.push_str("\n\n----\n");
        match fetched {
            Some(fetched) => {
                let view = parse_view(&fetched)?;
                text.push_str(&format_conversation_entry(&hit.id, fetched.flags, &view));
            }
            None => text.push_str(&format!(
                "id {}\n[This message was removed while the conversation was read.]",
                hit.id
            )),
        }
    }
    session.close().await;
    Ok(ToolReport {
        text,
        log: format!("conversation: {total} message(s), {} shown", hits.len()),
    })
}

/// Reads one attachment as text.
///
/// # Arguments
///
/// * `context` - The account and trust.
/// * `arguments` - Which message and which attachment.
pub async fn run_read_attachment(
    context: &ToolContext,
    arguments: AttachmentArguments,
) -> ToolResult {
    let id = parse_email_id(&arguments.id)?;
    let mut session = context.open_imap().await?;
    let folders = load_folders(&mut session).await?;
    let (_, view) = get_message_view(&mut session, &folders, &id).await?;
    session.close().await;
    let attachment = view
        .attachments
        .iter()
        .find(|attachment| attachment.number == arguments.attachment)
        .ok_or(ToolFailure::AttachmentMissing {
            number: arguments.attachment,
            count: view.attachments.len(),
        })?;
    let text = attachment
        .text
        .as_ref()
        .ok_or_else(|| ToolFailure::AttachmentNotText {
            name: attachment.name.clone(),
            content_type: attachment.content_type.clone(),
        })?;
    Ok(ToolReport {
        text: format!(
            "Attachment #{} {} ({}, {})\n\n{text}",
            attachment.number,
            attachment.name,
            attachment.content_type,
            format_size(attachment.bytes.len())
        ),
        log: format!(
            "attachment: #{} of {}, {} byte(s)",
            attachment.number,
            view.attachments.len(),
            attachment.bytes.len()
        ),
    })
}

/// Fetches a message by id and parses it.
///
/// # Arguments
///
/// * `session` - The signed-in session.
/// * `folders` - The classified folders.
/// * `id` - The id.
///
/// # Returns
///
/// The fetched message and its view, or `StaleId` when the id no longer
/// names a message.
pub async fn get_message_view(
    session: &mut ImapSession,
    folders: &[Folder],
    id: &EmailId,
) -> Result<(FetchedMessage, MessageView), ToolFailure> {
    open_id_folder(session, folders, id).await?;
    let fetched = session
        .find_message(id.uid)
        .await
        .map_err(build_imap_failure_conversion("fetch the message"))?
        .ok_or(ToolFailure::StaleId)?;
    let view = parse_view(&fetched)?;
    Ok((fetched, view))
}

/// Parses a fetched message, failing as an unreadable answer when the
/// bytes are not a message.
fn parse_view(fetched: &FetchedMessage) -> Result<MessageView, ToolFailure> {
    parse_message(&fetched.bytes).ok_or(ToolFailure::Connection {
        protocol: Protocol::Imap,
        failure: ConnectionFailure::Unreadable,
    })
}

/// Formats a message as `read_email` shows it: the header fields, the
/// flags, the attachments, and the whole text.
///
/// # Arguments
///
/// * `id` - The message's id.
/// * `flags` - Its flags.
/// * `view` - The message.
pub fn format_message_view(id: &EmailId, flags: Flags, view: &MessageView) -> String {
    let mut text = format_view_heading(id, flags, view);
    text.push_str(view.text.trim_end());
    text
}

/// Formats a message as a conversation shows it: as `read_email` does,
/// with the text cut at [`CONVERSATION_TEXT_LIMIT`] characters.
///
/// # Arguments
///
/// * `id` - The message's id.
/// * `flags` - Its flags.
/// * `view` - The message.
fn format_conversation_entry(id: &EmailId, flags: Flags, view: &MessageView) -> String {
    let mut text = format_view_heading(id, flags, view);
    text.push_str(&format_cut_text(
        id,
        view.text.trim_end(),
        CONVERSATION_TEXT_LIMIT,
    ));
    text
}

/// Formats the part of a message before its text: the header fields,
/// the flags, the folder, and the attachments, then an empty line.
///
/// # Arguments
///
/// * `id` - The message's id.
/// * `flags` - Its flags.
/// * `view` - The message.
fn format_view_heading(id: &EmailId, flags: Flags, view: &MessageView) -> String {
    let headers = &view.headers;
    let mut text = format!("id {id}\nFrom: {}\nTo: {}\n", headers.from, headers.to);
    if !headers.cc.is_empty() {
        text.push_str(&format!("Cc: {}\n", headers.cc));
    }
    if !headers.reply_to.is_empty() {
        text.push_str(&format!("Reply-To: {}\n", headers.reply_to));
    }
    text.push_str(&format!(
        "Date: {}\nSubject: {}\n",
        headers.date.as_deref().unwrap_or("unknown"),
        headers.subject
    ));
    if let Some(message_id) = &headers.message_id {
        text.push_str(&format!("Message-ID: <{message_id}>\n"));
    }
    if !headers.in_reply_to.is_empty() {
        text.push_str(&format!(
            "In-Reply-To: {}\n",
            headers
                .in_reply_to
                .iter()
                .map(|identifier| format!("<{identifier}>"))
                .collect::<Vec<_>>()
                .join(" ")
        ));
    }
    text.push_str(&format!(
        "Flags: {}\nFolder: {}\n",
        flags.format(),
        id.folder
    ));
    match view.attachments.len() {
        0 => text.push_str("Attachments: none\n"),
        count => {
            text.push_str(&format!("Attachments: {count}\n"));
            for attachment in &view.attachments {
                text.push_str(&format!(
                    "  #{} {} ({}, {})\n",
                    attachment.number,
                    attachment.name,
                    attachment.content_type,
                    format_size(attachment.bytes.len())
                ));
            }
        }
    }
    if view.text_from_html {
        text.push_str("[The text was converted from HTML.]\n");
    }
    text.push('\n');
    text
}

/// Formats a message's text cut at `limit` characters, with a note that
/// names the id to read the whole message by; a text that is not longer
/// stays whole.
///
/// # Arguments
///
/// * `id` - The message's id.
/// * `body` - The text.
/// * `limit` - Most characters to show.
fn format_cut_text(id: &EmailId, body: &str, limit: usize) -> String {
    match body.char_indices().nth(limit) {
        Some((end, _)) => format!(
            "{}\n[The text was cut. Use read_email with id {id} for the whole message.]",
            &body[..end]
        ),
        None => body.to_owned(),
    }
}

/// Collects the identifiers a conversation is searched by: the message's
/// own, the ones it replies to, and the ones it references.
fn list_conversation_identifiers(view: &MessageView) -> Vec<String> {
    let headers = &view.headers;
    let mut identifiers: Vec<String> = Vec::new();
    for identifier in headers
        .message_id
        .iter()
        .chain(headers.in_reply_to.iter())
        .chain(headers.references.iter())
    {
        let usable = !identifier.is_empty()
            && identifier.is_ascii()
            && !identifier.bytes().any(|byte| byte.is_ascii_control());
        if usable && !identifiers.contains(identifier) {
            identifiers.push(identifier.clone());
        }
    }
    identifiers.truncate(CONVERSATION_ID_LIMIT);
    identifiers
}

/// Builds the search keys finding every message that carries one of the
/// identifiers in its Message-ID, In-Reply-To, or References field.
///
/// # Arguments
///
/// * `identifiers` - The identifiers, without angle brackets.
///
/// # Returns
///
/// The keys, or `None` when there is no identifier to search by.
pub fn build_conversation_criteria(identifiers: &[String]) -> Option<String> {
    let keys: Vec<String> = identifiers
        .iter()
        .flat_map(|identifier| {
            let quoted = format_search_text(identifier);
            [
                format!("HEADER MESSAGE-ID {quoted}"),
                format!("HEADER IN-REPLY-TO {quoted}"),
                format!("HEADER REFERENCES {quoted}"),
            ]
        })
        .collect();
    keys.into_iter()
        .rev()
        .reduce(|inner, key| format!("OR {key} {inner}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::message::parse_message;

    #[test]
    fn builds_an_or_chain_over_every_identifier() {
        assert_eq!(build_conversation_criteria(&[]), None);
        assert_eq!(
            build_conversation_criteria(&["one@example.com".to_owned()]).expect("criteria"),
            "OR HEADER MESSAGE-ID \"one@example.com\" OR HEADER IN-REPLY-TO \"one@example.com\" HEADER REFERENCES \"one@example.com\""
        );
        let two =
            build_conversation_criteria(&["a@x".to_owned(), "b@x".to_owned()]).expect("criteria");
        assert_eq!(two.matches("OR ").count(), 5);
        assert!(two.ends_with("HEADER REFERENCES \"b@x\""), "{two}");
    }

    #[test]
    fn collects_identifiers_once_each_and_skips_unusable_ones() {
        let view = parse_message(b"Message-ID: <one@example.com>\r\nIn-Reply-To: <zero@example.com>\r\nReferences: <minus@example.com> <zero@example.com> <one@example.com>\r\n\r\nx").expect("message");

        assert_eq!(
            list_conversation_identifiers(&view),
            vec!["one@example.com", "zero@example.com", "minus@example.com"]
        );
    }

    #[test]
    fn formats_a_message_with_its_attachments_and_cuts_the_text_when_asked() {
        let view = parse_message(b"From: Jane <jane@example.com>\r\nTo: person@example.com\r\nCc: cc@example.com\r\nReply-To: reply@example.com\r\nDate: Sun, 2 Nov 2026 10:30:00 +0000\r\nSubject: Hello\r\nMessage-ID: <one@example.com>\r\nIn-Reply-To: <zero@example.com>\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=\"b\"\r\n\r\n--b\r\nContent-Type: text/plain\r\n\r\nHello there, this is the text.\r\n--b\r\nContent-Type: text/csv\r\nContent-Disposition: attachment; filename=\"data.csv\"\r\n\r\na,b\r\n--b--\r\n").expect("message");
        let id = EmailId {
            uid: 12,
            uid_validity: 345,
            folder: "INBOX".to_owned(),
        };

        let whole = format_message_view(&id, Flags::default(), &view);
        let cut = format_cut_text(&id, "Hello there", 5);
        let short = format_cut_text(&id, "Hello", 5);

        assert_eq!(
            whole,
            "id 12.345.INBOX\nFrom: Jane <jane@example.com>\nTo: person@example.com\nCc: cc@example.com\nReply-To: reply@example.com\nDate: 2026-11-02T10:30:00Z\nSubject: Hello\nMessage-ID: <one@example.com>\nIn-Reply-To: <zero@example.com>\nFlags: unread\nFolder: INBOX\nAttachments: 1\n  #1 data.csv (text/csv, 3 B)\n\nHello there, this is the text."
        );
        assert_eq!(
            cut,
            "Hello\n[The text was cut. Use read_email with id 12.345.INBOX for the whole message.]"
        );
        assert_eq!(short, "Hello");
    }
}
