//! `send_email`: a new message, a reply, or a forward over SMTP, with a
//! copy in the Sent folder.

use std::time::SystemTime;

use schemars::JsonSchema;
use serde::Deserialize;

use super::read::fetch_view;
use super::{
    MAXIMUM_TEXT_ARGUMENT_LENGTH, ToolContext, ToolReport, ToolResult, check_text_argument,
    imap_failure, load_folders,
};
use crate::compose::{
    ComposedMessage, Composition, build_forward_attachments, build_forward_body,
    build_forward_subject, build_reply_references, build_reply_subject, compose_message,
};
use crate::email_id::parse_email_id;
use crate::failure::{Protocol, ToolFailure};
use crate::folders::{Folder, FolderRole, find_role_folder};
use crate::imap::ImapSession;
use crate::smtp::{SmtpFailure, build_smtp_transport, send_message};

/// Most recipients of one field.
pub const MAXIMUM_RECIPIENTS: usize = 50;

/// Longest body, in characters.
pub const MAXIMUM_BODY_LENGTH: usize = 500_000;

/// The flags a Sent copy is stored with.
const SENT_FLAGS: &str = "(\\Seen)";

/// The fields of a message to send or to save as a draft.
#[derive(Clone, Debug, Default, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct MessageArguments {
    /// The To recipients, each as name@example.com or Name <name@example.com>. For a reply, omitted means the sender of the replied message.
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
    /// The id of the message this replies to; sets the conversation fields.
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
    /// Saving the copy failed as described.
    Failed(String),
}

impl SentCopy {
    /// Returns the sentence the model reads.
    pub fn describe(&self) -> String {
        match self {
            Self::KeptByServer => "The server keeps a copy of sent mail.".to_owned(),
            Self::Saved(folder) => format!("A copy was saved in {folder}."),
            Self::NoFolder => "No Sent folder was found, so no copy was saved.".to_owned(),
            Self::Failed(reason) => format!("The copy could not be saved in Sent: {reason}"),
        }
    }
}

/// Sends a message.
///
/// # Arguments
///
/// * `context` - The account and trust.
/// * `arguments` - The message.
pub async fn send_email(context: &ToolContext, arguments: MessageArguments) -> ToolResult {
    check_message_arguments(&arguments)?;
    let mut session = None;
    let composition = build_composition(context, &mut session, &arguments).await?;
    let now = SystemTime::now();
    let composed = compose_message(
        &context.account,
        &composition,
        now,
        context.next_sequence(),
        false,
    )
    .map_err(|problem| ToolFailure::Argument(problem.describe()))?;
    send_composed(context, &composed).await?;
    let copy = keep_sent_copy(context, &mut session, &composed.bytes).await;
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
            copy.describe()
        ),
        log: format!(
            "send: {} recipient(s), {} attachment(s), copy {}",
            composed.envelope.to().len(),
            composition.attachments.len(),
            describe_copy_for_log(&copy)
        ),
    })
}

/// Checks the rules of the message fields.
///
/// # Arguments
///
/// * `arguments` - The fields.
pub fn check_message_arguments(arguments: &MessageArguments) -> Result<(), ToolFailure> {
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
            check_text_argument(name, recipient, MAXIMUM_TEXT_ARGUMENT_LENGTH)?;
        }
    }
    check_text_argument("subject", &arguments.subject, MAXIMUM_TEXT_ARGUMENT_LENGTH)?;
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
    Ok(())
}

/// Builds the composition of the fields: a plain message, a reply with
/// the conversation fields of the replied message, or a forward with the
/// forwarded message's text and attachments.
///
/// # Arguments
///
/// * `context` - The account and trust.
/// * `session` - The IMAP session, opened here when the message replies
///   to or forwards another.
/// * `arguments` - The fields.
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
    let original_id = arguments
        .reply_to_id
        .as_deref()
        .or(arguments.forward_id.as_deref());
    let Some(original_id) = original_id else {
        return Ok(composition);
    };
    let id = parse_email_id(original_id)?;
    let opened = match session {
        Some(opened) => opened,
        None => session.insert(context.open_imap().await?),
    };
    let folders = load_folders(opened).await?;
    let (_, original) = fetch_view(opened, &folders, &id).await?;
    if arguments.reply_to_id.is_some() {
        if composition.to.is_empty() && composition.cc.is_empty() && composition.bcc.is_empty() {
            let sender = if original.headers.reply_to.is_empty() {
                &original.headers.from
            } else {
                &original.headers.reply_to
            };
            composition.to = vec![sender.clone()];
        }
        if composition.subject.trim().is_empty() {
            composition.subject = build_reply_subject(&original.headers.subject);
        }
        let (in_reply_to, references) = build_reply_references(&original);
        composition.in_reply_to = in_reply_to;
        composition.references = references;
    } else {
        if composition.subject.trim().is_empty() {
            composition.subject = build_forward_subject(&original.headers.subject);
        }
        composition.body = build_forward_body(&arguments.body, &original);
        composition.attachments = build_forward_attachments(&original);
    }
    Ok(composition)
}

/// Sends a composed message over SMTP.
///
/// # Arguments
///
/// * `context` - The account and trust.
/// * `composed` - The message.
pub async fn send_composed(
    context: &ToolContext,
    composed: &ComposedMessage,
) -> Result<(), ToolFailure> {
    let transport = build_smtp_transport(&context.account, &context.trust).map_err(|failure| {
        ToolFailure::SignIn {
            protocol: Protocol::Smtp,
            failure,
        }
    })?;
    send_message(&transport, &composed.envelope, &composed.bytes)
        .await
        .map_err(|failure| match failure {
            SmtpFailure::SignIn(failure) => ToolFailure::SignIn {
                protocol: Protocol::Smtp,
                failure,
            },
            SmtpFailure::Refused { code, text } => ToolFailure::SmtpRefused { code, text },
            SmtpFailure::Unconfirmed => ToolFailure::SendUnconfirmed,
        })
}

/// Saves a copy of a sent message in the Sent folder, unless the server
/// keeps one; a failure is reported, never raised, as the message is sent.
///
/// # Arguments
///
/// * `context` - The account and trust.
/// * `session` - The IMAP session, opened here when none is open yet.
/// * `bytes` - The message as sent.
pub async fn keep_sent_copy(
    context: &ToolContext,
    session: &mut Option<ImapSession>,
    bytes: &[u8],
) -> SentCopy {
    if context.account.server_keeps_sent_copy {
        return SentCopy::KeptByServer;
    }
    match save_sent_copy(context, session, bytes).await {
        Ok(copy) => copy,
        Err(failure) => SentCopy::Failed(failure.to_string()),
    }
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
    let Some(sent) = find_role_folder(&folders, FolderRole::Sent) else {
        return Ok(SentCopy::NoFolder);
    };
    append_copy(opened, sent, bytes).await?;
    Ok(SentCopy::Saved(sent.name.clone()))
}

/// Appends a sent message's copy to a folder, marked as read.
///
/// # Arguments
///
/// * `session` - The signed-in session.
/// * `folder` - The Sent folder.
/// * `bytes` - The message as sent.
pub async fn append_copy(
    session: &mut ImapSession,
    folder: &Folder,
    bytes: &[u8],
) -> Result<(), ToolFailure> {
    session
        .append_message(&folder.raw_name, SENT_FLAGS, bytes)
        .await
        .map_err(imap_failure("save the copy"))
}

/// Formats a recipient list as a line, or nothing when it is empty.
pub fn format_optional_list(name: &str, recipients: &[String]) -> String {
    if recipients.is_empty() {
        String::new()
    } else {
        format!("{name}: {}\n", recipients.join(", "))
    }
}

/// Names what became of the copy, for the log.
pub fn describe_copy_for_log(copy: &SentCopy) -> &'static str {
    match copy {
        SentCopy::KeptByServer => "kept by the server",
        SentCopy::Saved(_) => "saved",
        SentCopy::NoFolder => "no folder",
        SentCopy::Failed(_) => "failed",
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

        assert_eq!(check_message_arguments(&fine), Ok(()));
        assert_eq!(
            check_message_arguments(&both),
            Err(ToolFailure::Argument(
                "Give reply_to_id or forward_id, not both.".to_owned()
            ))
        );
        assert_eq!(
            check_message_arguments(&many),
            Err(ToolFailure::Argument(
                "cc must hold at most 50 recipients.".to_owned()
            ))
        );
        assert_eq!(
            check_message_arguments(&broken),
            Err(ToolFailure::Argument(
                "subject must not contain line breaks or control characters.".to_owned()
            ))
        );
    }

    #[test]
    fn describes_what_became_of_the_copy() {
        assert_eq!(
            SentCopy::Saved("Sent".to_owned()).describe(),
            "A copy was saved in Sent."
        );
        assert_eq!(describe_copy_for_log(&SentCopy::NoFolder), "no folder");
        assert_eq!(format_optional_list("Cc", &[]), "");
        assert_eq!(
            format_optional_list("Cc", &["a@x".to_owned(), "b@x".to_owned()]),
            "Cc: a@x, b@x\n"
        );
    }
}
