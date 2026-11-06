//! `save_draft`, `send_draft`, and `delete_draft`: drafts kept in the
//! Drafts folder, sent as stored once the call names what they hold.

use std::collections::BTreeSet;
use std::str::FromStr;
use std::sync::{Mutex, PoisonError};
use std::time::SystemTime;

use lettre::address::{Address, Envelope};
use mail_parser::{HeaderName, Message, MessageParser};
use schemars::JsonSchema;
use serde::Deserialize;

use super::send::{
    MessageArguments, SentCopy, build_composition, format_copy_for_log, format_optional_list,
    parse_message_arguments, save_copy_in_sent, send_composed,
};
use super::{
    ToolContext, ToolReport, ToolResult, build_imap_failure_conversion, format_list_argument,
    format_text_argument, get_role_folder, load_folders,
};
use crate::compose::{
    ComposedMessage, Composition, CompositionProblem, MessageStamp, build_draft_message,
    build_recipient, parse_recipient,
};
use crate::email_id::{EmailId, parse_email_id};
use crate::failure::ToolFailure;
use crate::folders::{Folder, FolderRole};
use crate::imap::{AppendFailure, Deletion, FolderAccess, ImapSession, SearchWord, Summary};
use crate::message::{ParsedMailbox, build_message_view};
use crate::smtp::SendProgress;

/// The flags a draft is stored with.
const DRAFT_FLAGS: &str = "(\\Draft)";

/// The arguments of `save_draft`.
#[derive(Clone, Debug, Default, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SaveDraftArguments {
    /// The To recipients, each as name@example.com or Name <name@example.com>. Every draft, a reply or a forward too, needs at least one recipient in to, cc, or bcc; none is taken from another message.
    #[serde(default)]
    pub to: Vec<String>,
    /// The Cc recipients.
    #[serde(default)]
    pub cc: Vec<String>,
    /// The Bcc recipients.
    #[serde(default)]
    pub bcc: Vec<String>,
    /// The subject; omitted means none, which a reply or a forward does not allow.
    #[serde(default)]
    pub subject: String,
    /// The text of the message.
    #[serde(default)]
    pub body: String,
    /// The id of the message the draft replies to; sets the conversation fields, not the recipients or the subject.
    #[serde(default)]
    pub reply_to_id: Option<String>,
    /// The id of the message the draft forwards; its text is quoted below the body and its attachments are attached.
    #[serde(default)]
    pub forward_id: Option<String>,
    /// The id of a draft to replace, as save_draft gave it; the replaced draft is deleted and the new id is returned.
    #[serde(default)]
    pub draft_id: Option<String>,
}

/// The arguments of `send_draft`: the draft, and the recipients, subject,
/// and text it must hold, which the approval then shows.
#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SendDraftArguments {
    /// The id of the draft, a message in the Drafts folder, such as 15.345.Drafts.
    pub draft_id: String,
    /// The draft's To recipients, each as name@example.com or Name <name@example.com>; omitted means it has none.
    #[serde(default)]
    pub to: Vec<String>,
    /// The draft's Cc recipients; omitted means it has none.
    #[serde(default)]
    pub cc: Vec<String>,
    /// The draft's Bcc recipients; omitted means it has none.
    #[serde(default)]
    pub bcc: Vec<String>,
    /// The draft's subject; omitted means it has none.
    #[serde(default)]
    pub subject: String,
    /// The draft's text as read_email shows it; omitted means it is empty.
    #[serde(default)]
    pub body: String,
}

/// The arguments of `delete_draft`.
#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct DraftIdArguments {
    /// The id of the draft, a message in the Drafts folder, such as 15.345.Drafts.
    pub draft_id: String,
}

/// How far a `save_draft` call has come.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub enum DraftStage {
    /// Storing the draft has not begun, so whatever stops the call now,
    /// the server stores nothing.
    #[default]
    BeforeStoring,
    /// Storing the draft began: from then on, a stopped call may have
    /// stored it, and may have left the draft it replaces in Drafts.
    Storing {
        /// The id of the draft the stored one replaces, or `None` when the
        /// call replaces none.
        replaced: Option<EmailId>,
    },
}

/// How far one `save_draft` call has come: moved to storing by the call as
/// it begins to store its draft, with the id of the draft it replaces, and
/// read by the caller that may stop the call, to tell whether the draft
/// may be stored and which draft may still be in Drafts beside it.
///
/// Concurrency model: serialized; the call moves the stage through one
/// shared reference while the caller holds another, and each access takes
/// the lock only to read or write the stage. The lock makes the progress
/// `Sync`, so that a call borrowing it can run on any thread. Resource
/// ownership: holds only the stage. Invariant: the stage records that
/// storing began and the draft it replaces together, and never moves back
/// to before storing.
#[derive(Debug, Default)]
pub struct DraftProgress {
    /// The stage the call has reached.
    stage: Mutex<DraftStage>,
}

impl DraftProgress {
    /// The stage the call has reached, as a copy.
    pub fn stage(&self) -> DraftStage {
        self.stage
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }

    /// Records that storing the draft begins, with the draft it replaces.
    ///
    /// # Arguments
    ///
    /// * `replaced` - The id of the draft the stored one replaces, if any.
    fn update_to_storing(&self, replaced: Option<&EmailId>) {
        let storing = DraftStage::Storing {
            replaced: replaced.cloned(),
        };
        *self.stage.lock().unwrap_or_else(PoisonError::into_inner) = storing;
    }
}

/// Saves a draft, replacing one when asked.
///
/// Once the server stored the draft, no step fails the call, as the model
/// would save it again: finding its id and deleting the draft it replaces
/// are reported as they went. A draft whose storing was not confirmed is
/// reported as one that may be stored, beside the draft it replaces, which
/// the call did not delete.
///
/// # Arguments
///
/// * `context` - The account and trust.
/// * `arguments` - The draft's fields.
/// * `progress` - Records when storing the draft begins, with the draft it
///   replaces, for the caller that may stop the call.
pub async fn run_save_draft(
    context: &ToolContext,
    arguments: SaveDraftArguments,
    progress: &DraftProgress,
) -> ToolResult {
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
    let mut session = None;
    let composition = build_composition(context, &mut session, &message).await?;
    let stamp = MessageStamp {
        now: SystemTime::now(),
        sequence: context.create_message_sequence(),
    };
    let composed = build_draft_message(&context.account, &composition, stamp)
        .map_err(|problem| ToolFailure::Argument(problem.format_sentence()))?;
    let mut session = match session {
        Some(opened) => opened,
        None => context.open_imap().await?,
    };
    let drafts = get_draft_folder(&mut session, replaced.as_ref()).await?;
    progress.update_to_storing(replaced.as_ref());
    session
        .save_message(&drafts.raw_name, DRAFT_FLAGS, &composed.bytes)
        .await
        .map_err(|failure| build_draft_save_failure(failure, replaced.as_ref()))?;
    let replacement = match replaced {
        Some(replaced) => Some(delete_replaced_draft(&mut session, replaced).await),
        None => None,
    };
    let id = find_saved_draft_id(&mut session, &drafts, &composed.message_id).await;
    session.close().await;
    let saved = SavedDraft { id, replacement };
    Ok(build_saved_draft_report(&composition, &drafts.name, &saved))
}

/// What became of a draft once the server stored it.
#[derive(Clone, Debug, PartialEq, Eq)]
struct SavedDraft {
    /// The draft's id; `None` when the search for it found nothing; or why
    /// it could not be found.
    id: Result<Option<EmailId>, ToolFailure>,
    /// The draft it replaces and what deleting that one did, when it
    /// replaces one.
    replacement: Option<Replacement>,
}

/// A draft that a stored draft replaces, and what deleting it did.
#[derive(Clone, Debug, PartialEq, Eq)]
struct Replacement {
    /// The replaced draft's id.
    replaced: EmailId,
    /// What deleting it did, or why that failed.
    deletion: Result<Deletion, ToolFailure>,
}

/// Gets the Drafts folder a draft is stored in, once the draft it
/// replaces, if any, is there: opens Drafts at that draft's id, where it
/// stays open.
///
/// # Arguments
///
/// * `session` - The signed-in session.
/// * `replaced` - The id of the draft it replaces, if any.
///
/// # Returns
///
/// The Drafts folder, or why the draft is not stored: no folder has the
/// Drafts role, the replaced draft's id fails as [`open_draft_folder`]
/// says or names no message any more, or the server failed a command.
async fn get_draft_folder(
    session: &mut ImapSession,
    replaced: Option<&EmailId>,
) -> Result<Folder, ToolFailure> {
    let folders = load_folders(session).await?;
    let drafts = get_role_folder(&folders, FolderRole::Drafts)?.clone();
    if let Some(replaced) = replaced {
        open_draft_folder(session, &drafts, replaced).await?;
        find_message_summary(session, replaced.uid)
            .await?
            .ok_or(ToolFailure::StaleId)?;
    }
    Ok(drafts)
}

/// Builds the failure of a draft the server did not store, or may have
/// stored without confirming it; the latter names the draft it replaces,
/// which the call then did not delete.
///
/// # Arguments
///
/// * `failure` - Why storing the draft failed or was not confirmed.
/// * `replaced` - The id of the draft it replaces, if any.
fn build_draft_save_failure(failure: AppendFailure, replaced: Option<&EmailId>) -> ToolFailure {
    match failure {
        AppendFailure::Failed(failure) => build_imap_failure_conversion("save the draft")(failure),
        AppendFailure::Unconfirmed(failure) => ToolFailure::DraftUnconfirmed {
            failure,
            replaced: replaced.cloned(),
        },
    }
}

/// Deletes the draft a stored draft replaces from Drafts, which is still
/// open at its id, as [`get_draft_folder`] left it.
///
/// # Arguments
///
/// * `session` - The signed-in session.
/// * `replaced` - The replaced draft's id.
async fn delete_replaced_draft(session: &mut ImapSession, replaced: EmailId) -> Replacement {
    let deletion = session
        .delete_message(replaced.uid)
        .await
        .map_err(build_imap_failure_conversion("delete the replaced draft"));
    Replacement { replaced, deletion }
}

/// Finds the id of a draft just stored: opens Drafts again, so that it
/// lists the new draft, and searches it for the draft's Message-ID.
///
/// # Arguments
///
/// * `session` - The signed-in session.
/// * `drafts` - The Drafts folder.
/// * `message_id` - The draft's Message-ID, without angle brackets.
///
/// # Returns
///
/// The id, `None` when the search found no draft, or why a command
/// failed.
async fn find_saved_draft_id(
    session: &mut ImapSession,
    drafts: &Folder,
    message_id: &str,
) -> Result<Option<EmailId>, ToolFailure> {
    let selected = session
        .open_folder(&drafts.raw_name, FolderAccess::Change)
        .await
        .map_err(build_imap_failure_conversion("select the Drafts folder"))?;
    let criteria = [
        SearchWord::Plain("HEADER".to_owned()),
        SearchWord::Plain("MESSAGE-ID".to_owned()),
        SearchWord::Text(message_id.to_owned()),
    ];
    let uids = session
        .list_matching_uids(&criteria)
        .await
        .map_err(build_imap_failure_conversion("find the saved draft"))?;
    Ok(uids.first().map(|uid| EmailId {
        uid: *uid,
        uid_validity: selected.uid_validity,
        folder: drafts.name.clone(),
    }))
}

/// Builds the report of a stored draft: its id and fields, or why its id
/// is not known, and what became of the draft it replaces; a failure is
/// stated without advice to try again, as the draft is stored.
///
/// # Arguments
///
/// * `composition` - The draft's fields.
/// * `drafts` - The Drafts folder's name.
/// * `saved` - What became of the draft once it was stored.
fn build_saved_draft_report(
    composition: &Composition,
    drafts: &str,
    saved: &SavedDraft,
) -> ToolReport {
    let replacement = saved
        .replacement
        .as_ref()
        .map(|replacement| format_replacement_line(replacement, drafts))
        .unwrap_or_default();
    let text = match &saved.id {
        Ok(Some(id)) => format!(
            "Draft saved as {id}.\nTo: {}\n{}{}Subject: {}{replacement}\nSend it with send_draft, replace it with save_draft and this draft_id, or delete it with delete_draft.",
            composition.to.join(", "),
            format_optional_list("Cc", &composition.cc),
            format_optional_list("Bcc", &composition.bcc),
            composition.subject
        ),
        Ok(None) => format!(
            "Draft saved in {drafts}, but the server did not report its id. Search that folder to find it.{replacement}"
        ),
        Err(failure) => format!(
            "Draft saved in {drafts}, but its id could not be found: {} Search that folder to find it.{replacement}",
            failure.format_reason()
        ),
    };
    ToolReport {
        text,
        log: format_saved_draft_log(saved),
    }
}

/// Formats what deleting the replaced draft did, as a line of the report.
///
/// # Arguments
///
/// * `replacement` - The replaced draft and what deleting it did.
/// * `drafts` - The Drafts folder's name.
fn format_replacement_line(replacement: &Replacement, drafts: &str) -> String {
    let replaced = &replacement.replaced;
    match &replacement.deletion {
        Ok(deletion) => format!(
            "\nIt replaces draft {replaced}, which {}.",
            format_deletion_clause(*deletion, drafts)
        ),
        Err(failure) => format!(
            "\nIt replaces draft {replaced}, which could not be deleted and may still be in {drafts}: {} Delete it with delete_draft.",
            failure.format_reason()
        ),
    }
}

/// Names what became of a stored draft, for the log, with the class of a
/// step that failed.
fn format_saved_draft_log(saved: &SavedDraft) -> String {
    let deletion = saved
        .replacement
        .as_ref()
        .map(|replacement| &replacement.deletion);
    let replacement = match deletion {
        None => String::new(),
        Some(Ok(_)) => ", replaced one".to_owned(),
        Some(Err(failure)) => format!(", replaced one not deleted ({})", failure.class()),
    };
    let id = match &saved.id {
        Ok(Some(_)) => "found".to_owned(),
        Ok(None) => "not found".to_owned(),
        Err(failure) => format!("not found ({})", failure.class()),
    };
    format!("draft: saved{replacement}, id {id}")
}

/// Sends a stored draft as it is, once the call names its recipients,
/// subject, and text; keeps the Sent copy rule, and deletes the draft.
///
/// # Arguments
///
/// * `context` - The account and trust.
/// * `arguments` - Which draft, and what it must hold.
/// * `progress` - Records how far the send came, for the caller that may
///   stop the call.
///
/// # Returns
///
/// The report, or the failure; when the draft's fields differ from the
/// call's, the refusal names the draft's own and nothing is sent.
pub async fn run_send_draft(
    context: &ToolContext,
    arguments: SendDraftArguments,
    progress: &SendProgress,
) -> ToolResult {
    let id = parse_email_id(&arguments.draft_id)?;
    let given = build_compared_fields(parse_message_arguments(&build_given_fields(arguments))?)?;
    let mut session = context.open_imap().await?;
    let folders = load_folders(&mut session).await?;
    let drafts = get_role_folder(&folders, FolderRole::Drafts)?.clone();
    let bytes = load_draft(&mut session, &drafts, &id).await?;
    let prepared = parse_stored_draft(&context.account.address, &bytes)?;
    if let Some(refusal) = format_draft_difference(&given, &prepared) {
        return Err(ToolFailure::Argument(refusal));
    }
    send_composed(context, &prepared.message, progress).await?;
    let copy = if context.account.server_keeps_sent_copy {
        SentCopy::KeptByServer
    } else {
        save_copy_in_sent(&mut session, &folders, &prepared.message.bytes)
            .await
            .unwrap_or_else(SentCopy::Failed)
    };
    // Drafts is still open at the draft's id, as load_draft checked it:
    // appending the copy to Sent does not change the open folder.
    let deleted = session
        .delete_message(id.uid)
        .await
        .map_err(build_imap_failure_conversion("delete the sent draft"));
    session.close().await;
    Ok(ToolReport {
        text: format!(
            "Sent draft {id}.\nTo: {}\n{}{}Subject: {}\n{}\n{}",
            prepared.fields.to.join(", "),
            format_optional_list("Cc", &prepared.fields.cc),
            format_optional_list("Bcc", &prepared.fields.bcc),
            prepared.fields.subject,
            copy.format_sentence(),
            format_sent_draft_deletion(&deleted, &drafts.name)
        ),
        log: format!(
            "draft: sent to {} recipient(s), copy {}, deleted {}",
            prepared.message.envelope.to().len(),
            format_copy_for_log(&copy),
            format_deletion_for_log(&deleted)
        ),
    })
}

/// Formats what deleting a sent draft did, as the last sentence of the
/// report; a failure is stated without advice to try again, as the draft
/// is sent.
///
/// # Arguments
///
/// * `deleted` - What the deletion did, or why it failed.
/// * `drafts` - The Drafts folder's name.
fn format_sent_draft_deletion(deleted: &Result<Deletion, ToolFailure>, drafts: &str) -> String {
    match deleted {
        Ok(deletion) => format!("The draft {}.", format_deletion_clause(*deletion, drafts)),
        Err(failure) => format!(
            "The draft could not be deleted and may still be in {drafts}: {} Delete it with delete_draft; do not send it again.",
            failure.format_reason()
        ),
    }
}

/// Names what deleting a sent draft did, for the log: `true` once it is
/// gone, else `false`, with the class of a failure.
fn format_deletion_for_log(deleted: &Result<Deletion, ToolFailure>) -> String {
    match deleted {
        Ok(Deletion::Removed) => "true".to_owned(),
        Ok(Deletion::MarkedOnly) => "false".to_owned(),
        Err(failure) => format!("false ({})", failure.class()),
    }
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

/// The fields `send_draft` was given, as a message's fields.
fn build_given_fields(arguments: SendDraftArguments) -> MessageArguments {
    MessageArguments {
        to: arguments.to,
        cc: arguments.cc,
        bcc: arguments.bcc,
        subject: arguments.subject,
        body: arguments.body,
        reply_to_id: None,
        forward_id: None,
    }
}

/// The names of the recipient fields, in the order
/// [`ComparedFields::recipients`] keeps them.
const RECIPIENT_FIELDS: [&str; 3] = ["to", "cc", "bcc"];

/// A message's fields in the form `send_draft` compares them in: two
/// messages match when each recipient field names the same addresses, in
/// any order, and the subjects and the texts are equal.
#[derive(Clone, Debug, PartialEq, Eq)]
struct ComparedFields {
    /// The addresses of the To, Cc, and Bcc fields, in that order, each
    /// field's once.
    recipients: [BTreeSet<String>; 3],
    /// The subject without white space at its edges.
    subject: String,
    /// The text with LF line breaks and without white space at its end.
    body: String,
}

/// Builds the compared form of a message's fields.
///
/// # Arguments
///
/// * `fields` - The fields, with recipients as the model gives them.
///
/// # Returns
///
/// The compared form, or the refusal of a recipient that is not an email
/// address.
fn build_compared_fields(fields: &MessageArguments) -> Result<ComparedFields, ToolFailure> {
    let mut recipients: [BTreeSet<String>; 3] = Default::default();
    for (addresses, list) in recipients
        .iter_mut()
        .zip([&fields.to, &fields.cc, &fields.bcc])
    {
        for recipient in list {
            let mailbox = parse_recipient(recipient)
                .map_err(|problem| ToolFailure::Argument(problem.format_sentence()))?;
            addresses.insert(mailbox.email.to_string());
        }
    }
    Ok(ComparedFields {
        recipients,
        subject: fields.subject.trim().to_owned(),
        body: build_compared_text(&fields.body),
    })
}

/// Builds a text as it is compared: CR LF line breaks as LF, and no
/// white space at its end, as `read_email` shows a text.
fn build_compared_text(text: &str) -> String {
    text.replace("\r\n", "\n").trim_end().to_owned()
}

/// Formats how a call's fields differ from the draft's.
///
/// # Arguments
///
/// * `given` - The call's fields, in compared form.
/// * `draft` - The draft.
///
/// # Returns
///
/// The refusal the model reads: the fields that differ, and the draft's
/// own fields to give instead; `None` when every field matches.
fn format_draft_difference(given: &ComparedFields, draft: &PreparedDraft) -> Option<String> {
    let stored = &draft.compared;
    let mut differing: Vec<&str> = RECIPIENT_FIELDS
        .iter()
        .zip(given.recipients.iter().zip(&stored.recipients))
        .filter(|(_, (given, stored))| given != stored)
        .map(|(name, _)| *name)
        .collect();
    if given.subject != stored.subject {
        differing.push("subject");
    }
    if given.body != stored.body {
        differing.push("body");
    }
    if differing.is_empty() {
        return None;
    }
    let fields = &draft.fields;
    Some(format!(
        "The draft differs from this call in {}, so nothing was sent. Its own fields are:\nto: {}\ncc: {}\nbcc: {}\nsubject: {}\nbody: {}\nCall send_draft with these to send it.",
        differing.join(", "),
        format_list_argument(&fields.to),
        format_list_argument(&fields.cc),
        format_list_argument(&fields.bcc),
        format_text_argument(&fields.subject),
        format_body_comparison(&given.body, &stored.body)
    ))
}

/// Formats how the body given compares with the draft's text, both in
/// compared form.
fn format_body_comparison(given: &str, stored: &str) -> String {
    if given == stored {
        return "its text as read_email shows it, which the body given matches.".to_owned();
    }
    let position = given
        .chars()
        .zip(stored.chars())
        .position(|(given, stored)| given != stored)
        .unwrap_or_else(|| given.chars().count().min(stored.chars().count()));
    format!(
        "its text as read_email shows it, which the body given differs from at character {}, counting a line break as one.",
        position + 1
    )
}

/// A stored draft made ready to send.
#[derive(Clone, Debug, PartialEq, Eq)]
struct PreparedDraft {
    /// The message without its Bcc field, and its envelope with every
    /// recipient.
    message: ComposedMessage,
    /// Its recipients, subject, and text, as the model gives them.
    fields: MessageArguments,
    /// The same fields in compared form.
    compared: ComparedFields,
}

/// Prepares a stored draft: reads its fields, builds its envelope from
/// its recipients, and removes its Bcc field.
///
/// # Arguments
///
/// * `sender` - The account's address.
/// * `bytes` - The draft as stored.
///
/// # Returns
///
/// The draft to send, or why it cannot be sent here: it is not a message,
/// an entry of a recipient field is not an email address lettre accepts,
/// it has no recipient, or lettre refuses the sender address.
fn parse_stored_draft(sender: &str, bytes: &[u8]) -> Result<PreparedDraft, ToolFailure> {
    let parsed = MessageParser::default()
        .parse(bytes)
        .ok_or_else(|| ToolFailure::Argument("The draft is not a message.".to_owned()))?;
    let view = build_message_view(&parsed);
    let fields = MessageArguments {
        to: list_draft_recipients("To", &view.addresses.to)?,
        cc: list_draft_recipients("Cc", &view.addresses.cc)?,
        bcc: list_draft_recipients("Bcc", &view.addresses.bcc)?,
        subject: view.headers.subject,
        body: view.text,
        reply_to_id: None,
        forward_id: None,
    };
    let compared = build_compared_fields(&fields)?;
    let envelope = build_draft_envelope(sender, &fields)?;
    Ok(PreparedDraft {
        message: ComposedMessage {
            bytes: remove_bcc_fields(&parsed, bytes),
            envelope,
            message_id: parsed.message_id().unwrap_or_default().to_owned(),
        },
        fields,
        compared,
    })
}

/// Lists the mailboxes of a draft's recipient field as recipients the
/// model gives.
///
/// # Arguments
///
/// * `field` - The field's name, for the refusal.
/// * `mailboxes` - Its mailboxes.
///
/// # Returns
///
/// The recipients, or the refusal of an entry that is not an email
/// address lettre accepts.
fn list_draft_recipients(
    field: &str,
    mailboxes: &[ParsedMailbox],
) -> Result<Vec<String>, ToolFailure> {
    mailboxes
        .iter()
        .map(|mailbox| build_recipient(mailbox).ok_or_else(|| build_entry_refusal(field, mailbox)))
        .collect()
}

/// Builds the refusal of a draft whose recipient field holds an entry
/// that is not an email address lettre accepts.
///
/// # Arguments
///
/// * `field` - The field's name.
/// * `mailbox` - The entry, named by its address, else by its name.
fn build_entry_refusal(field: &str, mailbox: &ParsedMailbox) -> ToolFailure {
    let entry = mailbox.address.as_deref().or(mailbox.name.as_deref());
    ToolFailure::Argument(format!(
        "The draft's {field} field holds {}, which is not an email address, so the draft cannot be sent here.",
        format_text_argument(entry.unwrap_or_default())
    ))
}

/// Builds the envelope of a draft: the account's address, and every
/// recipient of its To, Cc, and Bcc fields.
///
/// # Arguments
///
/// * `sender` - The account's address.
/// * `fields` - The draft's fields.
fn build_draft_envelope(sender: &str, fields: &MessageArguments) -> Result<Envelope, ToolFailure> {
    let recipients = [&fields.to, &fields.cc, &fields.bcc]
        .into_iter()
        .flatten()
        .map(|recipient| parse_recipient(recipient).map(|mailbox| mailbox.email))
        .collect::<Result<Vec<Address>, CompositionProblem>>()
        .map_err(|problem| ToolFailure::Argument(problem.format_sentence()))?;
    if recipients.is_empty() {
        return Err(ToolFailure::Argument(
            "The draft has no recipient. Save it again with one.".to_owned(),
        ));
    }
    let sender_address = Address::from_str(sender).map_err(|_| {
        ToolFailure::Argument(
            "The account's address cannot be used as a sender. Check it in Settings → MCP."
                .to_owned(),
        )
    })?;
    Envelope::new(Some(sender_address), recipients).map_err(|error| {
        ToolFailure::Argument(format!("The envelope could not be built: {error}."))
    })
}

/// Removes the Bcc fields of a parsed message from its bytes.
///
/// # Arguments
///
/// * `parsed` - The message, parsed from the bytes.
/// * `bytes` - The message as stored.
fn remove_bcc_fields(parsed: &Message<'_>, bytes: &[u8]) -> Vec<u8> {
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
    stripped
}

/// Loads a draft: opens the Drafts folder at its id and fetches it.
///
/// # Arguments
///
/// * `session` - The signed-in session.
/// * `drafts` - The Drafts folder.
/// * `id` - The draft's id.
///
/// # Returns
///
/// The draft as stored, or why it cannot be loaded, as
/// [`open_draft_folder`] says, or `StaleId` when Drafts no longer holds it.
async fn load_draft(
    session: &mut ImapSession,
    drafts: &Folder,
    id: &EmailId,
) -> Result<Vec<u8>, ToolFailure> {
    open_draft_folder(session, drafts, id).await?;
    let fetched = session
        .find_message(id.uid)
        .await
        .map_err(build_imap_failure_conversion("fetch the draft"))?
        .ok_or(ToolFailure::StaleId)?;
    Ok(fetched.bytes)
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
        assert_eq!(
            prepared.fields,
            MessageArguments {
                to: vec![
                    "Jane <jane@example.com>".to_owned(),
                    "a@example.com".to_owned()
                ],
                cc: vec!["cc@example.com".to_owned()],
                bcc: vec!["hidden@example.com".to_owned()],
                subject: "Hi".to_owned(),
                body: "Hello\r\n".to_owned(),
                reply_to_id: None,
                forward_id: None,
            }
        );
    }

    #[test]
    fn refuses_a_draft_with_an_entry_that_is_not_an_address_or_without_recipients() {
        let bare_name = b"From: person@example.com\r\nTo: jane@example.com, nobody\r\nSubject: Hi\r\n\r\nHello\r\n";
        let empty_group = b"From: person@example.com\r\nTo: undisclosed-recipients:;\r\nSubject: Hi\r\n\r\nHello\r\n";

        assert_eq!(
            parse_stored_draft("person@example.com", bare_name),
            Err(ToolFailure::Argument(
                "The draft's To field holds \"nobody\", which is not an email address, so the draft cannot be sent here."
                    .to_owned()
            ))
        );
        assert_eq!(
            parse_stored_draft("person@example.com", empty_group),
            Err(ToolFailure::Argument(
                "The draft has no recipient. Save it again with one.".to_owned()
            ))
        );
    }

    /// The compared form of a call's fields.
    fn build_given(to: &[&str], subject: &str, body: &str) -> ComparedFields {
        build_compared_fields(&MessageArguments {
            to: to.iter().map(|recipient| (*recipient).to_owned()).collect(),
            subject: subject.to_owned(),
            body: body.to_owned(),
            ..MessageArguments::default()
        })
        .expect("compared")
    }

    #[test]
    fn matches_a_draft_by_addresses_in_any_order_and_by_its_text_with_any_line_breaks() {
        let draft = parse_stored_draft(
            "person@example.com",
            b"From: person@example.com\r\nTo: \"Doe, Jane\" <jane@example.com>, b@example.com\r\nSubject: Hi \r\n\r\nHello\r\nthere\r\n\r\n",
        )
        .expect("prepared");

        let reordered = build_given(&["b@example.com", "jane@example.com"], "Hi", "Hello\nthere");
        let with_names = build_given(
            &["\"Doe, Jane\" <jane@example.com>", "B <b@example.com>"],
            " Hi",
            "Hello\r\nthere\n",
        );
        let other_text = build_given(&["jane@example.com", "b@example.com"], "Hi", "Hello there");
        let extra = build_given(
            &["jane@example.com", "b@example.com", "c@example.com"],
            "Hi",
            "Hello\nthere",
        );

        assert_eq!(format_draft_difference(&reordered, &draft), None);
        assert_eq!(format_draft_difference(&with_names, &draft), None);
        assert_eq!(
            format_draft_difference(&other_text, &draft),
            Some("The draft differs from this call in body, so nothing was sent. Its own fields are:\nto: [\"\\\"Doe, Jane\\\" <jane@example.com>\", \"b@example.com\"]\ncc: []\nbcc: []\nsubject: \"Hi\"\nbody: its text as read_email shows it, which the body given differs from at character 6, counting a line break as one.\nCall send_draft with these to send it.".to_owned())
        );
        assert!(
            format_draft_difference(&extra, &draft)
                .is_some_and(|text| text.starts_with("The draft differs from this call in to, so")),
        );
        assert_eq!(
            build_compared_fields(&MessageArguments {
                bcc: vec!["not an address".to_owned()],
                ..MessageArguments::default()
            }),
            Err(ToolFailure::Argument(
                "not an address is not an email address. Give addresses as name@example.com or Name <name@example.com>.".to_owned()
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
            delimiter: Some("/".to_owned()),
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
