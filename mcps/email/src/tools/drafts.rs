//! `save_draft`, `send_draft`, and `delete_draft`: drafts kept in the
//! Drafts folder, sent as stored.

use std::str::FromStr;
use std::time::SystemTime;

use lettre::address::{Address, Envelope};
use mail_parser::{HeaderName, MessageParser};
use schemars::JsonSchema;
use serde::Deserialize;

use super::send::{
    MessageArguments, build_composition, format_copy_for_log, format_optional_list,
    parse_message_arguments, save_read_copy, send_composed,
};
use super::{
    ToolContext, ToolReport, ToolResult, build_imap_failure_conversion, get_role_folder,
    load_folders,
};
use crate::compose::{ComposedMessage, MessageStamp, build_draft_message};
use crate::email_id::{EmailId, parse_email_id};
use crate::failure::ToolFailure;
use crate::folders::{Folder, FolderRole};
use crate::imap::{Deletion, FolderAccess, ImapSession, Summary, format_search_text};
use crate::message::format_addresses;

/// The flags a draft is stored with.
const DRAFT_FLAGS: &str = "(\\Draft)";

/// The arguments of `save_draft`.
#[derive(Clone, Debug, Default, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SaveDraftArguments {
    /// The To recipients, each as name@example.com or Name <name@example.com>.
    #[serde(default)]
    pub to: Vec<String>,
    /// The Cc recipients.
    #[serde(default)]
    pub cc: Vec<String>,
    /// The Bcc recipients.
    #[serde(default)]
    pub bcc: Vec<String>,
    /// The subject. For a reply or a forward, omitted means the original's subject with Re: or Fwd: in front.
    #[serde(default)]
    pub subject: String,
    /// The text of the message.
    #[serde(default)]
    pub body: String,
    /// The id of the message the draft replies to; sets the conversation fields.
    #[serde(default)]
    pub reply_to_id: Option<String>,
    /// The id of the message the draft forwards; its text is quoted below the body and its attachments are attached.
    #[serde(default)]
    pub forward_id: Option<String>,
    /// The id of a draft to replace, as save_draft gave it; the replaced draft is deleted and the new id is returned.
    #[serde(default)]
    pub draft_id: Option<String>,
}

/// The arguments of `send_draft` and `delete_draft`.
#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct DraftIdArguments {
    /// The draft's id as save_draft gave it, such as 15.345.Drafts.
    pub draft_id: String,
}

/// Saves a draft, replacing one when asked.
///
/// # Arguments
///
/// * `context` - The account and trust.
/// * `arguments` - The draft's fields.
pub async fn run_save_draft(context: &ToolContext, arguments: SaveDraftArguments) -> ToolResult {
    let message = MessageArguments {
        to: arguments.to,
        cc: arguments.cc,
        bcc: arguments.bcc,
        subject: arguments.subject,
        body: arguments.body,
        reply_to_id: arguments.reply_to_id,
        forward_id: arguments.forward_id,
    };
    parse_message_arguments(&message)?;
    let replaced = arguments
        .draft_id
        .as_deref()
        .map(parse_email_id)
        .transpose()?;
    let mut session = Some(context.open_imap().await?);
    let composition = build_composition(context, &mut session, &message).await?;
    let stamp = MessageStamp {
        now: SystemTime::now(),
        sequence: context.create_message_sequence(),
    };
    let composed = build_draft_message(&context.account, &composition, stamp)
        .map_err(|problem| ToolFailure::Argument(problem.format_sentence()))?;
    let mut session = session.take().expect("the session was opened above");
    let folders = load_folders(&mut session).await?;
    let drafts = get_role_folder(&folders, FolderRole::Drafts)?.clone();
    if let Some(replaced) = &replaced {
        open_draft_folder(&mut session, &drafts, replaced).await?;
        find_message_summary(&mut session, replaced.uid)
            .await?
            .ok_or(ToolFailure::StaleId)?;
    }
    session
        .save_message(&drafts.raw_name, DRAFT_FLAGS, &composed.bytes)
        .await
        .map_err(build_imap_failure_conversion("save the draft"))?;
    let selected = session
        .open_folder(&drafts.raw_name, FolderAccess::Change)
        .await
        .map_err(build_imap_failure_conversion("select the Drafts folder"))?;
    let uids = session
        .list_matching_uids(&format!(
            "HEADER MESSAGE-ID {}",
            format_search_text(&composed.message_id)
        ))
        .await
        .map_err(build_imap_failure_conversion("find the saved draft"))?;
    let id = uids.first().map(|uid| EmailId {
        uid: *uid,
        uid_validity: selected.uid_validity,
        folder: drafts.name.clone(),
    });
    let replacement = match &replaced {
        Some(replaced) => {
            let deletion = session
                .delete_message(replaced.uid)
                .await
                .map_err(build_imap_failure_conversion("delete the replaced draft"))?;
            format!(
                "\nIt replaces draft {replaced}, which {}.",
                format_deletion_clause(deletion, &drafts.name)
            )
        }
        None => String::new(),
    };
    session.close().await;
    let text = match &id {
        Some(id) => format!(
            "Draft saved as {id}.\nTo: {}\n{}{}Subject: {}{replacement}\nSend it with send_draft, replace it with save_draft and this draft_id, or delete it with delete_draft.",
            composition.to.join(", "),
            format_optional_list("Cc", &composition.cc),
            format_optional_list("Bcc", &composition.bcc),
            composition.subject
        ),
        None => format!(
            "Draft saved in {}, but the server did not report its id. Search that folder to find it.{replacement}",
            drafts.name
        ),
    };
    Ok(ToolReport {
        text,
        log: format!(
            "draft: saved{}, id {}",
            if replaced.is_some() {
                ", replaced one"
            } else {
                ""
            },
            if id.is_some() { "found" } else { "not found" }
        ),
    })
}

/// Sends a stored draft as it is, keeps the Sent copy rule, and deletes
/// the draft.
///
/// # Arguments
///
/// * `context` - The account and trust.
/// * `arguments` - Which draft.
pub async fn run_send_draft(context: &ToolContext, arguments: DraftIdArguments) -> ToolResult {
    let id = parse_email_id(&arguments.draft_id)?;
    let mut session = context.open_imap().await?;
    let folders = load_folders(&mut session).await?;
    let drafts = get_role_folder(&folders, FolderRole::Drafts)?.clone();
    open_draft_folder(&mut session, &drafts, &id).await?;
    let fetched = session
        .find_message(id.uid)
        .await
        .map_err(build_imap_failure_conversion("fetch the draft"))?
        .ok_or(ToolFailure::StaleId)?;
    let prepared = parse_stored_draft(&context.account.address, &fetched.bytes)?;
    send_composed(context, &prepared.message).await?;
    let copy = if context.account.server_keeps_sent_copy {
        super::send::SentCopy::KeptByServer
    } else {
        match folders
            .iter()
            .find(|folder| folder.role == Some(FolderRole::Sent))
        {
            Some(sent) => match save_read_copy(&mut session, sent, &prepared.message.bytes).await {
                Ok(()) => super::send::SentCopy::Saved(sent.name.clone()),
                Err(failure) => super::send::SentCopy::Failed(failure.to_string()),
            },
            None => super::send::SentCopy::NoFolder,
        }
    };
    let deleted = match session
        .open_folder(&drafts.raw_name, FolderAccess::Change)
        .await
        .map_err(build_imap_failure_conversion("select the Drafts folder"))
    {
        Ok(_) => session
            .delete_message(id.uid)
            .await
            .map_err(build_imap_failure_conversion("delete the sent draft")),
        Err(failure) => Err(failure),
    };
    session.close().await;
    let deletion = match &deleted {
        Ok(deletion) => format!(
            "The draft {}.",
            format_deletion_clause(*deletion, &drafts.name)
        ),
        Err(failure) => format!("The draft is still in {}: {failure}", drafts.name),
    };
    Ok(ToolReport {
        text: format!(
            "Sent draft {id}.\nTo: {}\nSubject: {}\n{}\n{deletion}",
            prepared.recipients.join(", "),
            prepared.subject,
            copy.format_sentence()
        ),
        log: format!(
            "draft: sent to {} recipient(s), copy {}, deleted {}",
            prepared.message.envelope.to().len(),
            format_copy_for_log(&copy),
            deleted == Ok(Deletion::Removed)
        ),
    })
}

/// Deletes a draft.
///
/// # Arguments
///
/// * `context` - The account and trust.
/// * `arguments` - Which draft.
pub async fn run_delete_draft(context: &ToolContext, arguments: DraftIdArguments) -> ToolResult {
    let id = parse_email_id(&arguments.draft_id)?;
    let mut session = context.open_imap().await?;
    let folders = load_folders(&mut session).await?;
    let drafts = get_role_folder(&folders, FolderRole::Drafts)?.clone();
    open_draft_folder(&mut session, &drafts, &id).await?;
    find_message_summary(&mut session, id.uid)
        .await?
        .ok_or(ToolFailure::StaleId)?;
    let deletion = session
        .delete_message(id.uid)
        .await
        .map_err(build_imap_failure_conversion("delete the draft"))?;
    session.close().await;
    Ok(ToolReport {
        text: format!(
            "Draft {id} {}.",
            format_deletion_clause(deletion, &drafts.name)
        ),
        log: match deletion {
            Deletion::Removed => "draft: deleted".to_owned(),
            Deletion::MarkedOnly => "draft: marked as deleted".to_owned(),
        },
    })
}

/// Formats what deleting a draft did, as the end of a sentence whose
/// subject is the draft.
///
/// # Arguments
///
/// * `deletion` - What the deletion did.
/// * `drafts` - The Drafts folder's name.
fn format_deletion_clause(deletion: Deletion, drafts: &str) -> String {
    match deletion {
        Deletion::Removed => format!("was deleted from {drafts}"),
        Deletion::MarkedOnly => format!(
            "is marked as deleted but stays in {drafts} until the folder is expunged, as the server cannot remove one message on its own"
        ),
    }
}

/// A stored draft made ready to send.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PreparedDraft {
    /// The message without its Bcc field, and its envelope with every
    /// recipient.
    pub message: ComposedMessage,
    /// The To, Cc, and Bcc recipients as stored, for the report.
    pub recipients: Vec<String>,
    /// The subject as stored.
    pub subject: String,
}

/// Prepares a stored draft: reads its recipients into the envelope and
/// removes its Bcc field.
///
/// # Arguments
///
/// * `sender` - The account's address.
/// * `bytes` - The draft as stored.
///
/// # Returns
///
/// The message to send, or why it cannot be sent: no recipient that is
/// an address, or a sender address lettre refuses.
pub fn parse_stored_draft(sender: &str, bytes: &[u8]) -> Result<PreparedDraft, ToolFailure> {
    let parsed = MessageParser::default()
        .parse(bytes)
        .ok_or_else(|| ToolFailure::Argument("The draft is not a message.".to_owned()))?;
    let mut recipients = Vec::new();
    let mut addresses = Vec::new();
    for list in [parsed.to(), parsed.cc(), parsed.bcc()]
        .into_iter()
        .flatten()
    {
        for mailbox in list.mailboxes() {
            if let Some(address) = mailbox.address()
                && let Ok(address) = Address::from_str(address)
            {
                addresses.push(address);
            }
        }
        recipients.push(format_addresses(list));
    }
    if addresses.is_empty() {
        return Err(ToolFailure::Argument(
            "The draft has no recipient that is an email address. Save it again with one."
                .to_owned(),
        ));
    }
    let sender_address = Address::from_str(sender).map_err(|_| {
        ToolFailure::Argument(
            "The account's address cannot be used as a sender. Check it in Settings → MCP."
                .to_owned(),
        )
    })?;
    let envelope = Envelope::new(Some(sender_address), addresses).map_err(|error| {
        ToolFailure::Argument(format!("The envelope could not be built: {error}."))
    })?;
    let mut ranges: Vec<(usize, usize)> = parsed
        .headers()
        .iter()
        .filter(|header| header.name() == HeaderName::Bcc)
        .map(|header| (header.offset_field() as usize, header.offset_end() as usize))
        .collect();
    ranges.sort_unstable_by_key(|range| std::cmp::Reverse(range.0));
    let mut stripped = bytes.to_vec();
    for (start, end) in ranges {
        if start < end && end <= stripped.len() {
            stripped.drain(start..end);
        }
    }
    let message_id = parsed.message_id().unwrap_or_default().to_owned();
    let subject = parsed.subject().unwrap_or_default().to_owned();
    Ok(PreparedDraft {
        message: ComposedMessage {
            bytes: stripped,
            envelope,
            message_id,
        },
        recipients: recipients
            .into_iter()
            .filter(|text| !text.is_empty())
            .collect(),
        subject,
    })
}

/// Opens the Drafts folder for changes at a draft id.
///
/// # Arguments
///
/// * `session` - The signed-in session.
/// * `drafts` - The Drafts folder.
/// * `id` - The draft's id.
///
/// # Returns
///
/// Nothing when Drafts is open at the id; `NotInDrafts` for an id of
/// another folder; `StaleId` when Drafts cannot be opened or its
/// UIDVALIDITY changed.
async fn open_draft_folder(
    session: &mut ImapSession,
    drafts: &Folder,
    id: &EmailId,
) -> Result<(), ToolFailure> {
    if !is_in_drafts(id, drafts) {
        return Err(ToolFailure::NotInDrafts);
    }
    if !drafts.selectable {
        return Err(ToolFailure::StaleId);
    }
    let opened = session
        .open_folder(&drafts.raw_name, FolderAccess::Change)
        .await
        .map_err(build_imap_failure_conversion("select the Drafts folder"))?;
    if opened.uid_validity != id.uid_validity {
        return Err(ToolFailure::StaleId);
    }
    Ok(())
}

/// Tells whether an id is of the Drafts folder.
fn is_in_drafts(id: &EmailId, drafts: &Folder) -> bool {
    id.folder == drafts.name
}

/// Finds the summary of a message of the open folder.
///
/// # Returns
///
/// The summary, or `None` when the folder no longer holds the message.
async fn find_message_summary(
    session: &mut ImapSession,
    uid: u32,
) -> Result<Option<Summary>, ToolFailure> {
    let summaries = session
        .list_summaries(&[uid])
        .await
        .map_err(build_imap_failure_conversion("fetch the message summary"))?;
    Ok(summaries.into_iter().next())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prepares_a_draft_with_every_recipient_in_the_envelope_and_no_bcc_field() {
        let draft = b"From: A Person <person@example.com>\r\nTo: Jane <jane@example.com>, Team: a@example.com;\r\nCc: cc@example.com\r\nBcc: hidden@example.com\r\nSubject: Hi\r\nMessage-ID: <one@example.com>\r\nContent-Type: text/plain\r\n\r\nHello\r\n";

        let prepared = parse_stored_draft("person@example.com", draft).expect("prepared");

        let text = String::from_utf8(prepared.message.bytes.clone()).expect("utf-8");
        assert!(!text.contains("hidden"), "{text}");
        assert!(
            text.contains("Cc: cc@example.com\r\nSubject: Hi\r\n"),
            "{text}"
        );
        let recipients: Vec<String> = prepared
            .message
            .envelope
            .to()
            .iter()
            .map(ToString::to_string)
            .collect();
        assert_eq!(
            recipients,
            vec![
                "jane@example.com",
                "a@example.com",
                "cc@example.com",
                "hidden@example.com"
            ]
        );
        assert_eq!(
            prepared.message.envelope.from().map(ToString::to_string),
            Some("person@example.com".to_owned())
        );
        assert_eq!(prepared.message.message_id, "one@example.com");
        assert_eq!(prepared.subject, "Hi");
        assert_eq!(
            prepared.recipients,
            vec![
                "Jane <jane@example.com>, Team: a@example.com;",
                "cc@example.com",
                "hidden@example.com"
            ]
        );
    }

    #[test]
    fn refuses_a_draft_without_an_address() {
        let draft = b"From: person@example.com\r\nTo: nobody\r\nSubject: Hi\r\n\r\nHello\r\n";

        assert_eq!(
            parse_stored_draft("person@example.com", draft),
            Err(ToolFailure::Argument(
                "The draft has no recipient that is an email address. Save it again with one."
                    .to_owned()
            ))
        );
    }

    #[test]
    fn checks_that_an_id_is_in_drafts() {
        let drafts = Folder {
            name: "Drafts".to_owned(),
            raw_name: "Drafts".to_owned(),
            role: Some(FolderRole::Drafts),
            selectable: true,
        };
        let inside = EmailId {
            uid: 1,
            uid_validity: 2,
            folder: "Drafts".to_owned(),
        };
        let outside = EmailId {
            folder: "INBOX".to_owned(),
            ..inside.clone()
        };

        assert!(is_in_drafts(&inside, &drafts));
        assert!(!is_in_drafts(&outside, &drafts));
    }
}
