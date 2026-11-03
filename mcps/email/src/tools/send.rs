//! `send_email`: a new message, a reply, or a forward over SMTP, with a
//! copy in the Sent folder.

use std::time::SystemTime;

use schemars::JsonSchema;
use serde::Deserialize;

use super::read::get_message_view;
use super::{
    MAXIMUM_TEXT_ARGUMENT_LENGTH, ToolContext, ToolReport, ToolResult,
    build_imap_failure_conversion, format_list_argument, format_text_argument, load_folders,
    parse_text_argument,
};
use crate::compose::{
    ComposedMessage, Composition, MessageStamp, build_forward_attachments, build_forward_body,
    build_forward_subject, build_reply_references, build_reply_subject, build_sent_message,
    format_recipient,
};
use crate::email_id::parse_email_id;
use crate::failure::{Protocol, ToolFailure};
use crate::folders::{Folder, FolderRole, find_role_folder};
use crate::imap::{AppendFailure, ImapSession};
use crate::message::{MessageView, ParsedMailbox};
use crate::smtp::{SendProgress, SmtpFailure, open_smtp_session};

/// Most recipients of one field.
const MAXIMUM_RECIPIENTS: usize = 50;

/// Longest body, in characters.
const MAXIMUM_BODY_LENGTH: usize = 500_000;

/// The flags a Sent copy is stored with.
const SENT_FLAGS: &str = "(\\Seen)";

/// The fields of a message to send or to save as a draft, as the model
/// gives them; also a stored draft's, which `send_draft` compares with
/// its call.
#[derive(Clone, Debug, Default, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct MessageArguments {
    /// The To recipients, each as name@example.com or Name <name@example.com>. Every message, a reply or a forward too, needs at least one recipient in to, cc, or bcc; none is taken from another message.
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
    /// The id of the message this replies to; sets the conversation fields, not the recipients or the subject.
    #[serde(default)]
    pub reply_to_id: Option<String>,
    /// The id of the message this forwards; its text is quoted below the body and its attachments are attached.
    #[serde(default)]
    pub forward_id: Option<String>,
}

/// What became of the copy of a sent message.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SentCopy {
    /// The server keeps sent mail itself.
    KeptByServer,
    /// The copy was saved in the folder.
    Saved(String),
    /// No Sent folder was found.
    NoFolder,
    /// Saving the copy failed for the reason.
    Failed(ToolFailure),
    /// The whole copy was handed to the IMAP server, which did not confirm
    /// that it stored it, for the reason; the copy may be in Sent.
    Unconfirmed(ToolFailure),
}

impl SentCopy {
    /// Returns the sentence the model reads; a failure is stated without
    /// advice to try again, as the message is sent.
    pub fn format_sentence(&self) -> String {
        match self {
            Self::KeptByServer => "The server keeps a copy of sent mail.".to_owned(),
            Self::Saved(folder) => format!("A copy was saved in {folder}."),
            Self::NoFolder => "No Sent folder was found, so no copy was saved.".to_owned(),
            Self::Failed(failure) => format!(
                "The copy could not be saved in Sent: {}",
                failure.format_reason()
            ),
            Self::Unconfirmed(failure) => format!(
                "The copy may or may not have been saved in Sent: {}",
                failure.format_reason()
            ),
        }
    }
}

/// Sends a message.
///
/// # Arguments
///
/// * `context` - The account and trust.
/// * `arguments` - The message.
/// * `progress` - Records how far the send came, for the caller that may
///   stop the call.
pub async fn run_send_email(
    context: &ToolContext,
    arguments: MessageArguments,
    progress: &SendProgress,
) -> ToolResult {
    parse_message_arguments(&arguments)?;
    let mut session = None;
    let composition = build_composition(context, &mut session, &arguments).await?;
    let stamp = MessageStamp {
        now: SystemTime::now(),
        sequence: context.create_message_sequence(),
    };
    let composed = build_sent_message(&context.account, &composition, stamp)
        .map_err(|problem| ToolFailure::Argument(problem.format_sentence()))?;
    send_composed(context, &composed, progress).await?;
    let copy = offer_sent_copy(context, &mut session, &composed.bytes).await;
    if let Some(session) = session {
        session.close().await;
    }
    Ok(ToolReport {
        text: format!(
            "Sent as Message-ID <{}>.\nTo: {}\n{}{}Subject: {}\n{}",
            composed.message_id,
            composition.to.join(", "),
            format_optional_list("Cc", &composition.cc),
            format_optional_list("Bcc", &composition.bcc),
            composition.subject,
            copy.format_sentence()
        ),
        log: format!(
            "send: {} recipient(s), {} attachment(s), copy {}",
            composed.envelope.to().len(),
            composition.attachments.len(),
            format_copy_for_log(&copy)
        ),
    })
}

/// Parses the message fields against their rules.
///
/// # Arguments
///
/// * `arguments` - The fields.
///
/// # Returns
///
/// The fields, or the first rule they break as the model reads it.
pub fn parse_message_arguments(
    arguments: &MessageArguments,
) -> Result<&MessageArguments, ToolFailure> {
    for (name, recipients) in [
        ("to", &arguments.to),
        ("cc", &arguments.cc),
        ("bcc", &arguments.bcc),
    ] {
        if recipients.len() > MAXIMUM_RECIPIENTS {
            return Err(ToolFailure::Argument(format!(
                "{name} must hold at most {MAXIMUM_RECIPIENTS} recipients."
            )));
        }
        for recipient in recipients {
            parse_text_argument(name, recipient, MAXIMUM_TEXT_ARGUMENT_LENGTH)?;
        }
    }
    parse_text_argument("subject", &arguments.subject, MAXIMUM_TEXT_ARGUMENT_LENGTH)?;
    if arguments.body.chars().count() > MAXIMUM_BODY_LENGTH {
        return Err(ToolFailure::Argument(format!(
            "body must be at most {MAXIMUM_BODY_LENGTH} characters."
        )));
    }
    if arguments.reply_to_id.is_some() && arguments.forward_id.is_some() {
        return Err(ToolFailure::Argument(
            "Give reply_to_id or forward_id, not both.".to_owned(),
        ));
    }
    Ok(arguments)
}

/// Builds the composition of the fields: a plain message, a reply with
/// the conversation fields of the replied message, or a forward with the
/// forwarded message's text and attachments. The recipients and the
/// subject are always the fields' own, so the approval shows them.
///
/// # Arguments
///
/// * `context` - The account and trust.
/// * `session` - The IMAP session, opened here when the message replies
///   to or forwards another.
/// * `arguments` - The fields.
///
/// # Returns
///
/// The composition, or why it cannot be built; a reply or a forward
/// without recipients or a subject is refused, naming what the original
/// suggests.
pub async fn build_composition(
    context: &ToolContext,
    session: &mut Option<ImapSession>,
    arguments: &MessageArguments,
) -> Result<Composition, ToolFailure> {
    let mut composition = Composition {
        to: arguments.to.clone(),
        cc: arguments.cc.clone(),
        bcc: arguments.bcc.clone(),
        subject: arguments.subject.clone(),
        body: arguments.body.clone(),
        ..Composition::default()
    };
    let (original_id, usage) = match (&arguments.reply_to_id, &arguments.forward_id) {
        (Some(id), _) => (id, OriginalUse::Reply),
        (None, Some(id)) => (id, OriginalUse::Forward),
        (None, None) => return Ok(composition),
    };
    let id = parse_email_id(original_id)?;
    let opened = match session {
        Some(opened) => opened,
        None => session.insert(context.open_imap().await?),
    };
    let folders = load_folders(opened).await?;
    let (_, original) = get_message_view(opened, &folders, &id).await?;
    if let Some(refusal) = find_left_out_fields(arguments, &original, usage) {
        return Err(ToolFailure::Argument(refusal));
    }
    match usage {
        OriginalUse::Reply => {
            let (in_reply_to, references) = build_reply_references(&original);
            composition.in_reply_to = in_reply_to;
            composition.references = references;
        }
        OriginalUse::Forward => {
            composition.body = build_forward_body(&arguments.body, &original);
            composition.attachments = build_forward_attachments(&original);
        }
    }
    Ok(composition)
}

/// What a message does with the message it is built from.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum OriginalUse {
    /// It replies to it.
    Reply,
    /// It forwards it.
    Forward,
}

impl OriginalUse {
    /// Names the message as the model reads it.
    fn name(self) -> &'static str {
        match self {
            Self::Reply => "reply",
            Self::Forward => "forward",
        }
    }

    /// Builds the usual subject of the message from the original's.
    fn build_subject(self, subject: &str) -> String {
        match self {
            Self::Reply => build_reply_subject(subject),
            Self::Forward => build_forward_subject(subject),
        }
    }
}

/// Finds what a reply or a forward leaves out that it must give itself:
/// its recipients and its subject, which no other message supplies.
///
/// # Arguments
///
/// * `arguments` - The fields.
/// * `original` - The message replied to or forwarded.
/// * `usage` - Whether the message replies to it or forwards it.
///
/// # Returns
///
/// The refusal the model reads: what to give, with the original's
/// mailboxes for a reply and the usual subject; `None` when nothing is
/// left out.
fn find_left_out_fields(
    arguments: &MessageArguments,
    original: &MessageView,
    usage: OriginalUse,
) -> Option<String> {
    let kind = usage.name();
    let mut sentences = Vec::new();
    if arguments.to.is_empty() && arguments.cc.is_empty() && arguments.bcc.is_empty() {
        sentences.push(format!("A {kind} needs its recipients in to, cc, or bcc."));
        if usage == OriginalUse::Reply {
            sentences.extend(format_reply_mailboxes(original));
        }
    }
    if arguments.subject.trim().is_empty() {
        sentences.push(format!(
            "A {kind} needs a subject, such as {}.",
            format_text_argument(&usage.build_subject(&original.headers.subject))
        ));
    }
    (!sentences.is_empty()).then(|| sentences.join(" "))
}

/// Formats who a message is from and where it asks replies to go, as
/// recipients the model can give, so it sees a `Reply-To` that differs
/// from the sender.
///
/// # Returns
///
/// The sentence, or `None` when the message names no mailbox to reply
/// to.
fn format_reply_mailboxes(original: &MessageView) -> Option<String> {
    let from = list_recipient_arguments(&original.addresses.from);
    let reply_to = list_recipient_arguments(&original.addresses.reply_to);
    match (from.is_empty(), reply_to.is_empty()) {
        (true, true) => None,
        (false, true) => Some(format!(
            "The message replied to is from {}.",
            format_list_argument(&from)
        )),
        (true, false) => Some(format!(
            "The message replied to asks for replies to go to {}.",
            format_list_argument(&reply_to)
        )),
        (false, false) => Some(format!(
            "The message replied to is from {} and asks for replies to go to {}.",
            format_list_argument(&from),
            format_list_argument(&reply_to)
        )),
    }
}

/// Lists mailboxes as recipients the model can give, leaving out those
/// without an address lettre accepts.
fn list_recipient_arguments(mailboxes: &[ParsedMailbox]) -> Vec<String> {
    mailboxes.iter().filter_map(format_recipient).collect()
}

/// Sends a composed message over an SMTP session of its own, which it
/// closes once the server accepted the message and drops after a failure.
///
/// # Arguments
///
/// * `context` - The account and trust.
/// * `composed` - The message.
/// * `progress` - Records how far the send came, for the caller that may
///   stop the call.
///
/// # Returns
///
/// Nothing once the server accepted the message, or why it did not.
pub(crate) async fn send_composed(
    context: &ToolContext,
    composed: &ComposedMessage,
    progress: &SendProgress,
) -> Result<(), ToolFailure> {
    let mut session = open_smtp_session(&context.account, &context.trust)
        .await
        .map_err(|failure| ToolFailure::SignIn {
            protocol: Protocol::Smtp,
            failure,
        })?;
    session
        .send_message(&composed.envelope, &composed.bytes, progress)
        .await
        .map_err(build_send_failure)?;
    session.close().await;
    Ok(())
}

/// Builds the failure the model reads from why a send did not complete.
fn build_send_failure(failure: SmtpFailure) -> ToolFailure {
    match failure {
        SmtpFailure::Connection(failure) => ToolFailure::Connection {
            protocol: Protocol::Smtp,
            failure,
        },
        SmtpFailure::Refused { code, text } => ToolFailure::SmtpRefused { code, text },
        SmtpFailure::ExtensionMissing(extension) => ToolFailure::SmtpExtensionMissing(extension),
        SmtpFailure::Unconfirmed => ToolFailure::SendUnconfirmed,
    }
}

/// Offers a copy of a sent message to the Sent folder, unless the server
/// keeps one; a failure is reported, never raised, as the message is sent.
///
/// # Arguments
///
/// * `context` - The account and trust.
/// * `session` - The IMAP session, opened here when none is open yet.
/// * `bytes` - The message as sent.
///
/// # Returns
///
/// What became of the copy.
async fn offer_sent_copy(
    context: &ToolContext,
    session: &mut Option<ImapSession>,
    bytes: &[u8],
) -> SentCopy {
    if context.account.server_keeps_sent_copy {
        return SentCopy::KeptByServer;
    }
    save_sent_copy(context, session, bytes)
        .await
        .unwrap_or_else(SentCopy::Failed)
}

/// Appends the copy to the Sent folder.
async fn save_sent_copy(
    context: &ToolContext,
    session: &mut Option<ImapSession>,
    bytes: &[u8],
) -> Result<SentCopy, ToolFailure> {
    let opened = match session {
        Some(opened) => opened,
        None => session.insert(context.open_imap().await?),
    };
    let folders = load_folders(opened).await?;
    save_copy_in_sent(opened, &folders, bytes).await
}

/// Appends a sent message's copy, marked as read, to the Sent folder of
/// the account's folders.
///
/// # Arguments
///
/// * `session` - The signed-in session.
/// * `folders` - The account's folders.
/// * `bytes` - The message as sent.
///
/// # Returns
///
/// The folder the copy was saved in, that no folder has the Sent role, or
/// that the server may have stored the copy without confirming it;
/// otherwise why the server did not store the copy.
pub(super) async fn save_copy_in_sent(
    session: &mut ImapSession,
    folders: &[Folder],
    bytes: &[u8],
) -> Result<SentCopy, ToolFailure> {
    let Some(sent) = find_role_folder(folders, FolderRole::Sent) else {
        return Ok(SentCopy::NoFolder);
    };
    match session
        .save_message(&sent.raw_name, SENT_FLAGS, bytes)
        .await
    {
        Ok(()) => Ok(SentCopy::Saved(sent.name.clone())),
        Err(AppendFailure::Unconfirmed(failure)) => {
            Ok(SentCopy::Unconfirmed(ToolFailure::Connection {
                protocol: Protocol::Imap,
                failure,
            }))
        }
        Err(AppendFailure::Failed(failure)) => {
            Err(build_imap_failure_conversion("save the copy")(failure))
        }
    }
}

/// Formats a recipient list as a line, or nothing when it is empty.
pub fn format_optional_list(name: &str, recipients: &[String]) -> String {
    if recipients.is_empty() {
        String::new()
    } else {
        format!("{name}: {}\n", recipients.join(", "))
    }
}

/// Names what became of the copy, for the log: a failure with its class.
pub fn format_copy_for_log(copy: &SentCopy) -> String {
    match copy {
        SentCopy::KeptByServer => "kept by the server".to_owned(),
        SentCopy::Saved(_) => "saved".to_owned(),
        SentCopy::NoFolder => "no folder".to_owned(),
        SentCopy::Failed(failure) => format!("failed ({})", failure.class()),
        SentCopy::Unconfirmed(failure) => format!("unconfirmed ({})", failure.class()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn checks_the_message_fields() {
        let fine = MessageArguments {
            to: vec!["jane@example.com".to_owned()],
            subject: "Hi".to_owned(),
            body: "Hello".to_owned(),
            ..MessageArguments::default()
        };
        let both = MessageArguments {
            reply_to_id: Some("1.2.INBOX".to_owned()),
            forward_id: Some("1.2.INBOX".to_owned()),
            ..fine.clone()
        };
        let many = MessageArguments {
            cc: vec!["a@example.com".to_owned(); MAXIMUM_RECIPIENTS + 1],
            ..fine.clone()
        };
        let broken = MessageArguments {
            subject: "Hi\r\nBcc: x".to_owned(),
            ..fine.clone()
        };

        assert_eq!(parse_message_arguments(&fine), Ok(&fine));
        assert_eq!(
            parse_message_arguments(&both),
            Err(ToolFailure::Argument(
                "Give reply_to_id or forward_id, not both.".to_owned()
            ))
        );
        assert_eq!(
            parse_message_arguments(&many),
            Err(ToolFailure::Argument(
                "cc must hold at most 50 recipients.".to_owned()
            ))
        );
        assert_eq!(
            parse_message_arguments(&broken),
            Err(ToolFailure::Argument(
                "subject must not contain line breaks or control characters.".to_owned()
            ))
        );
    }

    #[test]
    fn describes_what_became_of_the_copy() {
        assert_eq!(
            SentCopy::Saved("Sent".to_owned()).format_sentence(),
            "A copy was saved in Sent."
        );
        assert_eq!(format_copy_for_log(&SentCopy::NoFolder), "no folder");
        let unconfirmed = SentCopy::Unconfirmed(ToolFailure::Connection {
            protocol: Protocol::Imap,
            failure: crate::failure::ConnectionFailure::TimedOut,
        });
        assert_eq!(
            unconfirmed.format_sentence(),
            "The copy may or may not have been saved in Sent: The IMAP server did not answer in time."
        );
        assert_eq!(
            format_copy_for_log(&unconfirmed),
            "unconfirmed (imap-connection-timed-out)"
        );
        assert_eq!(format_optional_list("Cc", &[]), "");
        assert_eq!(
            format_optional_list("Cc", &["a@x".to_owned(), "b@x".to_owned()]),
            "Cc: a@x, b@x\n"
        );
    }
}
