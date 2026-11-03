//! Why a sign-in or a tool call did not do what it was asked.
//!
//! A [`SignInFailure`] is the machine-readable reason the check subcommand
//! reports and the desktop shows; a [`ToolFailure`] is what a tool answers
//! the model with, as one actionable sentence. The identity of a failure is
//! its variant; the text is derived from it, never parsed back.

use std::fmt;

use serde::Serialize;

use crate::folders::FolderRole;

/// Why signing in to one mail server failed; the reasons the protocol's
/// `emailServerCheckFailureSchema` lists.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum SignInFailure {
    /// The server refused the user name or the password.
    WrongPassword,
    /// The server could not be reached: an unknown host, a refused
    /// connection, or no answer to the connection.
    Unreachable,
    /// The operating system refused the server's certificate.
    CertificateRefused,
    /// The account requires STARTTLS, which the server does not offer.
    EncryptionNotOffered,
    /// The server did not answer in time.
    TimedOut,
    /// The server answered something Lys could not read, or ended the
    /// connection.
    ProtocolError,
}

impl SignInFailure {
    /// Returns the failure's name as the check subcommand prints it.
    pub fn name(self) -> &'static str {
        match self {
            Self::WrongPassword => "wrong-password",
            Self::Unreachable => "unreachable",
            Self::CertificateRefused => "certificate-refused",
            Self::EncryptionNotOffered => "encryption-not-offered",
            Self::TimedOut => "timed-out",
            Self::ProtocolError => "protocol-error",
        }
    }

    /// Returns the failure as a clause for a sentence to the model.
    pub fn format_clause(self) -> &'static str {
        match self {
            Self::WrongPassword => "the user name or password was refused",
            Self::Unreachable => "the host could not be reached",
            Self::CertificateRefused => "its certificate was refused by the operating system",
            Self::EncryptionNotOffered => "it does not offer STARTTLS",
            Self::TimedOut => "it did not answer in time",
            Self::ProtocolError => "it answered something Lys could not read",
        }
    }
}

/// Which mail server a failure concerns.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Protocol {
    /// The server mail is read from.
    Imap,
    /// The server mail is sent through.
    Smtp,
}

impl Protocol {
    /// Returns the protocol's name in upper case.
    pub fn name(self) -> &'static str {
        match self {
            Self::Imap => "IMAP",
            Self::Smtp => "SMTP",
        }
    }
}

/// How a connection that was signed in ended before the operation
/// completed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ConnectionFailure {
    /// The server ended the connection, or the network did.
    Lost,
    /// The server answered something Lys could not read.
    Unreadable,
    /// The server did not answer in time.
    TimedOut,
}

impl ConnectionFailure {
    /// Returns the failure's name for the log.
    fn name(self) -> &'static str {
        match self {
            Self::Lost => "lost",
            Self::Unreadable => "unreadable",
            Self::TimedOut => "timed-out",
        }
    }

    /// Formats the failure as the sentence the model reads when it ends a
    /// call: what happened, and, for a connection that ended or timed out,
    /// to try again.
    ///
    /// # Arguments
    ///
    /// * `protocol` - Which server's connection ended.
    fn format_sentence(self, protocol: Protocol) -> String {
        let fact = self.format_fact(protocol);
        match self {
            Self::Lost | Self::TimedOut => format!("{fact} Try again."),
            Self::Unreadable => fact,
        }
    }

    /// Formats what happened as a sentence, without advice.
    ///
    /// # Arguments
    ///
    /// * `protocol` - Which server's connection ended.
    fn format_fact(self, protocol: Protocol) -> String {
        let server = protocol.name();
        match self {
            Self::Lost => {
                format!("The connection to the {server} server ended before it answered.")
            }
            Self::Unreadable => {
                format!("The {server} server answered something Lys could not read.")
            }
            Self::TimedOut => format!("The {server} server did not answer in time."),
        }
    }
}

/// What stopped a call before it finished.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Stop {
    /// The client cancelled the call.
    Cancelled,
    /// The call reached its time limit.
    TimedOut,
}

impl Stop {
    /// Returns the stop's name for the log.
    fn name(self) -> &'static str {
        match self {
            Self::Cancelled => "cancelled",
            Self::TimedOut => "timed-out",
        }
    }

    /// Returns what became of the call, as a clause after "The call".
    fn format_clause(self) -> &'static str {
        match self {
            Self::Cancelled => "was cancelled",
            Self::TimedOut => "did not finish within 240 seconds and was stopped",
        }
    }
}

/// What a send tool sent.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SentKind {
    /// A message `send_email` composed.
    Message,
    /// A draft `send_draft` sent as it is stored.
    Draft,
}

/// An SMTP extension that a message can need and a server may not offer.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SmtpExtension {
    /// SMTPUTF8 (RFC 6531), which an address with characters beyond ASCII
    /// needs.
    SmtpUtf8,
    /// 8BITMIME (RFC 6152), which a message with bytes beyond ASCII needs.
    EightBitMime,
}

impl SmtpExtension {
    /// Returns the extension's keyword, as EHLO lists it.
    fn name(self) -> &'static str {
        match self {
            Self::SmtpUtf8 => "SMTPUTF8",
            Self::EightBitMime => "8BITMIME",
        }
    }

    /// Formats the sentence of a server that does not offer the
    /// extension.
    fn format_sentence(self) -> String {
        let need = match self {
            Self::SmtpUtf8 => "an address with characters beyond ASCII",
            Self::EightBitMime => "its bytes beyond ASCII",
        };
        format!(
            "The SMTP server does not offer {}, which this message needs for {need}, so nothing was sent.",
            self.name()
        )
    }
}

/// Why a tool call did not do what it was asked.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ToolFailure {
    /// Signing in to a server failed.
    SignIn {
        /// Which server.
        protocol: Protocol,
        /// Why.
        failure: SignInFailure,
    },
    /// The IMAP server refused a command with its own text.
    ImapRefused {
        /// What the command was to do, as a verb phrase.
        operation: &'static str,
        /// The server's response code and text, such as `[OVERQUOTA]
        /// Quota exceeded`; a longer text than 500 characters is cut there
        /// and ends with an ellipsis.
        text: String,
    },
    /// A signed-in connection ended before the operation completed.
    Connection {
        /// Which server.
        protocol: Protocol,
        /// How.
        failure: ConnectionFailure,
    },
    /// The SMTP server refused the message, its sender, or a recipient;
    /// nothing was sent.
    SmtpRefused {
        /// The reply code, such as 550.
        code: u16,
        /// The server's text.
        text: String,
    },
    /// The SMTP server does not offer an extension the message needs;
    /// nothing was sent.
    SmtpExtensionMissing(SmtpExtension),
    /// The whole message was handed to the SMTP server, which did not
    /// confirm it: the connection ended, its answer could not be read, or
    /// it did not come in time. The message may have been sent.
    SendUnconfirmed,
    /// The call was stopped after the whole message was handed to the SMTP
    /// server and before the server confirmed it; the message may have
    /// been sent.
    StoppedUnconfirmed(Stop),
    /// The call was stopped after the SMTP server accepted the message,
    /// before the call's later steps finished.
    StoppedAfterSend {
        /// What stopped the call.
        stop: Stop,
        /// What was sent.
        sent: SentKind,
    },
    /// The whole draft was handed to the IMAP server, which did not confirm
    /// that it stored it: the connection ended, its answer could not be
    /// read, or it did not come in time. The draft may be in Drafts.
    DraftUnconfirmed(ConnectionFailure),
    /// A `save_draft` call was stopped once storing its draft began; the
    /// draft may be in Drafts.
    StoppedWhileSaving(Stop),
    /// The whole call reached its time limit.
    TimedOut,
    /// The client cancelled the call.
    Cancelled,
    /// The id is not of the form `uid.uidvalidity.folder`.
    InvalidId,
    /// The id's folder, UIDVALIDITY, or UID no longer matches.
    StaleId,
    /// No folder has the given name.
    FolderMissing(String),
    /// No folder has the role the operation needs.
    NoRoleFolder(FolderRole),
    /// The folder has a role, so it cannot be renamed or deleted.
    RoleFolder {
        /// The folder's name.
        name: String,
        /// Its role.
        role: FolderRole,
    },
    /// The folder holds messages, so it cannot be deleted.
    FolderNotEmpty(String),
    /// The folder holds other folders, so it cannot be deleted.
    FolderHasSubfolders(String),
    /// A folder with the name already exists.
    FolderExists(String),
    /// The id is not in the Drafts folder.
    NotInDrafts,
    /// The message has no attachment with the number.
    AttachmentMissing {
        /// The number asked for.
        number: u32,
        /// How many attachments the message has.
        count: usize,
    },
    /// The attachment is not text.
    AttachmentNotText {
        /// The attachment's name.
        name: String,
        /// Its content type.
        content_type: String,
    },
    /// An argument breaks a rule; the text names the rule.
    Argument(String),
}

impl ToolFailure {
    /// Formats the failure as the reason a step failed after the call had
    /// already changed something, such as the copy of a sent message: the
    /// sentence the model reads without the advice to try again, which only
    /// a failure of a connection carries, as trying the call again would
    /// repeat what it already did.
    pub fn format_reason(&self) -> String {
        match self {
            Self::Connection { protocol, failure } => failure.format_fact(*protocol),
            _ => self.to_string(),
        }
    }

    /// Returns the class of the failure for the log, without any server
    /// text, name, or address.
    pub fn class(&self) -> String {
        match self {
            Self::SignIn { protocol, failure } => {
                format!(
                    "{}-sign-in-{}",
                    protocol.name().to_ascii_lowercase(),
                    failure.name()
                )
            }
            Self::ImapRefused { operation, .. } => {
                format!("imap-refused-to-{}", operation.replace(' ', "-"))
            }
            Self::Connection { protocol, failure } => {
                format!(
                    "{}-connection-{}",
                    protocol.name().to_ascii_lowercase(),
                    failure.name()
                )
            }
            Self::SmtpRefused { code, .. } => format!("smtp-refused-{code}"),
            Self::SmtpExtensionMissing(extension) => {
                format!(
                    "smtp-extension-missing-{}",
                    extension.name().to_ascii_lowercase()
                )
            }
            Self::SendUnconfirmed => "send-unconfirmed".to_owned(),
            Self::StoppedUnconfirmed(stop) => format!("{}-after-hand-over", stop.name()),
            Self::StoppedAfterSend { stop, .. } => format!("{}-after-send", stop.name()),
            Self::DraftUnconfirmed(failure) => format!("save-unconfirmed-{}", failure.name()),
            Self::StoppedWhileSaving(stop) => format!("{}-while-saving", stop.name()),
            Self::TimedOut => "timed-out".to_owned(),
            Self::Cancelled => "cancelled".to_owned(),
            Self::InvalidId => "invalid-id".to_owned(),
            Self::StaleId => "stale-id".to_owned(),
            Self::FolderMissing(_) => "folder-missing".to_owned(),
            Self::NoRoleFolder(role) => format!("no-{}-folder", role.name().to_ascii_lowercase()),
            Self::RoleFolder { .. } => "role-folder".to_owned(),
            Self::FolderNotEmpty(_) => "folder-not-empty".to_owned(),
            Self::FolderHasSubfolders(_) => "folder-has-subfolders".to_owned(),
            Self::FolderExists(_) => "folder-exists".to_owned(),
            Self::NotInDrafts => "not-in-drafts".to_owned(),
            Self::AttachmentMissing { .. } => "attachment-missing".to_owned(),
            Self::AttachmentNotText { .. } => "attachment-not-text".to_owned(),
            Self::Argument(_) => "argument".to_owned(),
        }
    }
}

/// The sentence of an id that is not a message id.
const INVALID_ID_SENTENCE: &str =
    "That is not a message id. Use an id from search_emails, such as 12.345.INBOX.";

/// The sentence of an id that no longer names its message.
const STALE_ID_SENTENCE: &str = "That message id is no longer valid. Search again.";

/// The sentence of an id outside the Drafts folder.
const NOT_IN_DRAFTS_SENTENCE: &str = "That id is not in the Drafts folder. Only a message in the Drafts folder can be sent or deleted as a draft.";

/// What a send that may have gone out tells the model to do.
const UNCONFIRMED_SENTENCE: &str =
    "The message may or may not have been sent; do not send it again without asking the person.";

/// What a draft that may have been stored tells the model to do.
const UNCONFIRMED_DRAFT_ADVICE: &str = "search that folder before saving it again.";

impl fmt::Display for ToolFailure {
    /// Formats the failure as the sentence the model reads.
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let sentence = match self {
            Self::SignIn { protocol, failure } => format_sign_in_sentence(*protocol, *failure),
            Self::ImapRefused { operation, text } => {
                format!("The IMAP server refused to {operation}: {text}.")
            }
            Self::Connection { protocol, failure } => failure.format_sentence(*protocol),
            Self::SmtpRefused { code, text } => {
                format!("The SMTP server refused the message ({code}): {text}.")
            }
            Self::SmtpExtensionMissing(extension) => extension.format_sentence(),
            Self::SendUnconfirmed => format_unconfirmed_sentence(None),
            Self::StoppedUnconfirmed(stop) => format_unconfirmed_sentence(Some(*stop)),
            Self::StoppedAfterSend { stop, sent } => {
                format_stopped_after_send_sentence(*stop, *sent)
            }
            Self::DraftUnconfirmed(failure) => format!(
                "{} The whole draft had been handed over, so it may or may not be in the Drafts folder; {UNCONFIRMED_DRAFT_ADVICE}",
                failure.format_fact(Protocol::Imap)
            ),
            Self::StoppedWhileSaving(stop) => format!(
                "The call {} after saving the draft began, so the draft may be in the Drafts folder; {UNCONFIRMED_DRAFT_ADVICE}",
                stop.format_clause()
            ),
            Self::TimedOut => format!("The call {}.", Stop::TimedOut.format_clause()),
            Self::Cancelled => format!("The call {}.", Stop::Cancelled.format_clause()),
            Self::InvalidId => INVALID_ID_SENTENCE.to_owned(),
            Self::StaleId => STALE_ID_SENTENCE.to_owned(),
            Self::FolderMissing(name) => format_folder_missing_sentence(name),
            Self::NoRoleFolder(role) => format_no_role_folder_sentence(*role),
            Self::RoleFolder { name, role } => format_role_folder_sentence(name, *role),
            Self::FolderNotEmpty(name) => {
                format!("{name} holds messages, so it cannot be deleted. Empty it first.")
            }
            Self::FolderHasSubfolders(name) => {
                format!("{name} holds other folders, so it cannot be deleted. Delete them first.")
            }
            Self::FolderExists(name) => format!("A folder named {name} already exists."),
            Self::NotInDrafts => NOT_IN_DRAFTS_SENTENCE.to_owned(),
            Self::AttachmentMissing { number, count } => {
                format_attachment_missing_sentence(*number, *count)
            }
            Self::AttachmentNotText { name, content_type } => {
                format!("Attachment {name} is {content_type}, not text, so it cannot be read.")
            }
            Self::Argument(text) => text.clone(),
        };
        formatter.write_str(&sentence)
    }
}

/// Formats the sentence of a failed sign-in.
///
/// # Arguments
///
/// * `protocol` - Which server.
/// * `failure` - Why it failed.
fn format_sign_in_sentence(protocol: Protocol, failure: SignInFailure) -> String {
    format!(
        "Signing in to the {} server failed: {}. Check the email account in Settings → MCP.",
        protocol.name(),
        failure.format_clause()
    )
}

/// Formats the sentence of a send the SMTP server did not confirm.
///
/// # Arguments
///
/// * `stop` - What stopped the call while it waited for the server's
///   answer, or `None` when the answer did not come or could not be read.
fn format_unconfirmed_sentence(stop: Option<Stop>) -> String {
    match stop {
        None => format!(
            "The whole message was handed to the SMTP server, but the server did not confirm the send. {UNCONFIRMED_SENTENCE}"
        ),
        Some(stop) => format!(
            "The call {} after the whole message was handed to the SMTP server and before the server confirmed the send. {UNCONFIRMED_SENTENCE}",
            stop.format_clause()
        ),
    }
}

/// Formats the sentence of a call stopped after its send.
///
/// # Arguments
///
/// * `stop` - What stopped the call.
/// * `sent` - What was sent.
fn format_stopped_after_send_sentence(stop: Stop, sent: SentKind) -> String {
    let clause = stop.format_clause();
    match sent {
        SentKind::Message => format!(
            "The message was sent, but then the call {clause}, so its copy in Sent may be missing. Do not send it again."
        ),
        SentKind::Draft => format!(
            "The draft was sent, but then the call {clause}, so its copy in Sent may be missing and the draft may still be in Drafts. Do not send it again; delete it instead."
        ),
    }
}

/// Formats the sentence of a folder name no folder has.
fn format_folder_missing_sentence(name: &str) -> String {
    format!("There is no folder named {name}. Use list_folders to see the folders.")
}

/// Formats the sentence of a role no folder has.
fn format_no_role_folder_sentence(role: FolderRole) -> String {
    format!(
        "No {} folder was found. Create one with manage_folder.",
        role.name()
    )
}

/// Formats the sentence of a folder that cannot change because of its
/// role.
///
/// # Arguments
///
/// * `name` - The folder's name.
/// * `role` - Its role.
fn format_role_folder_sentence(name: &str, role: FolderRole) -> String {
    format!(
        "{name} is the {} folder, which cannot be renamed or deleted.",
        role.name()
    )
}

/// Formats the sentence of a missing attachment.
///
/// # Arguments
///
/// * `number` - The number asked for.
/// * `count` - How many attachments the message has.
fn format_attachment_missing_sentence(number: u32, count: usize) -> String {
    match count {
        0 => format!("The message has no attachment, so there is no #{number}."),
        1 => format!("The message has one attachment, so there is no #{number}."),
        _ => format!("The message has {count} attachments, so there is no #{number}."),
    }
}

impl std::error::Error for ToolFailure {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_and_describes_every_sign_in_failure() {
        let failures = [
            SignInFailure::WrongPassword,
            SignInFailure::Unreachable,
            SignInFailure::CertificateRefused,
            SignInFailure::EncryptionNotOffered,
            SignInFailure::TimedOut,
            SignInFailure::ProtocolError,
        ];
        for failure in failures {
            let json = serde_json::to_string(&failure).expect("json");
            assert_eq!(json, format!("\"{}\"", failure.name()));
            assert!(!failure.format_clause().is_empty());
        }
    }

    #[test]
    fn formats_failures_as_sentences_and_classes_without_server_text() {
        let refused = ToolFailure::ImapRefused {
            operation: "select the folder",
            text: "Unknown mailbox".to_owned(),
        };
        assert_eq!(
            refused.to_string(),
            "The IMAP server refused to select the folder: Unknown mailbox."
        );
        assert_eq!(refused.class(), "imap-refused-to-select-the-folder");
        assert_eq!(
            ToolFailure::SignIn {
                protocol: Protocol::Smtp,
                failure: SignInFailure::WrongPassword
            }
            .class(),
            "smtp-sign-in-wrong-password"
        );
        assert_eq!(
            ToolFailure::StaleId.to_string(),
            "That message id is no longer valid. Search again."
        );
        assert_eq!(
            ToolFailure::AttachmentMissing {
                number: 3,
                count: 1
            }
            .to_string(),
            "The message has one attachment, so there is no #3."
        );
        assert_eq!(
            ToolFailure::NoRoleFolder(FolderRole::Drafts).class(),
            "no-drafts-folder"
        );
    }

    /// Each way a send can end unfinished, with the class the log gives it
    /// and the sentence the model reads.
    const UNFINISHED_SENDS: [(ToolFailure, &str, &str); 10] = [
        (
            ToolFailure::Connection {
                protocol: Protocol::Smtp,
                failure: ConnectionFailure::Lost,
            },
            "smtp-connection-lost",
            "The connection to the SMTP server ended before it answered. Try again.",
        ),
        (
            ToolFailure::Connection {
                protocol: Protocol::Smtp,
                failure: ConnectionFailure::Unreadable,
            },
            "smtp-connection-unreadable",
            "The SMTP server answered something Lys could not read.",
        ),
        (
            ToolFailure::Connection {
                protocol: Protocol::Smtp,
                failure: ConnectionFailure::TimedOut,
            },
            "smtp-connection-timed-out",
            "The SMTP server did not answer in time. Try again.",
        ),
        (
            ToolFailure::SmtpExtensionMissing(SmtpExtension::SmtpUtf8),
            "smtp-extension-missing-smtputf8",
            "The SMTP server does not offer SMTPUTF8, which this message needs for an address with characters beyond ASCII, so nothing was sent.",
        ),
        (
            ToolFailure::SmtpExtensionMissing(SmtpExtension::EightBitMime),
            "smtp-extension-missing-8bitmime",
            "The SMTP server does not offer 8BITMIME, which this message needs for its bytes beyond ASCII, so nothing was sent.",
        ),
        (
            ToolFailure::SendUnconfirmed,
            "send-unconfirmed",
            "The whole message was handed to the SMTP server, but the server did not confirm the send. The message may or may not have been sent; do not send it again without asking the person.",
        ),
        (
            ToolFailure::StoppedUnconfirmed(Stop::Cancelled),
            "cancelled-after-hand-over",
            "The call was cancelled after the whole message was handed to the SMTP server and before the server confirmed the send. The message may or may not have been sent; do not send it again without asking the person.",
        ),
        (
            ToolFailure::StoppedUnconfirmed(Stop::TimedOut),
            "timed-out-after-hand-over",
            "The call did not finish within 240 seconds and was stopped after the whole message was handed to the SMTP server and before the server confirmed the send. The message may or may not have been sent; do not send it again without asking the person.",
        ),
        (
            ToolFailure::StoppedAfterSend {
                stop: Stop::Cancelled,
                sent: SentKind::Message,
            },
            "cancelled-after-send",
            "The message was sent, but then the call was cancelled, so its copy in Sent may be missing. Do not send it again.",
        ),
        (
            ToolFailure::StoppedAfterSend {
                stop: Stop::TimedOut,
                sent: SentKind::Draft,
            },
            "timed-out-after-send",
            "The draft was sent, but then the call did not finish within 240 seconds and was stopped, so its copy in Sent may be missing and the draft may still be in Drafts. Do not send it again; delete it instead.",
        ),
    ];

    /// Each way a draft can end unconfirmed, with the class the log gives
    /// it and the sentence the model reads.
    const UNCONFIRMED_DRAFTS: [(ToolFailure, &str, &str); 4] = [
        (
            ToolFailure::DraftUnconfirmed(ConnectionFailure::Lost),
            "save-unconfirmed-lost",
            "The connection to the IMAP server ended before it answered. The whole draft had been handed over, so it may or may not be in the Drafts folder; search that folder before saving it again.",
        ),
        (
            ToolFailure::DraftUnconfirmed(ConnectionFailure::Unreadable),
            "save-unconfirmed-unreadable",
            "The IMAP server answered something Lys could not read. The whole draft had been handed over, so it may or may not be in the Drafts folder; search that folder before saving it again.",
        ),
        (
            ToolFailure::StoppedWhileSaving(Stop::Cancelled),
            "cancelled-while-saving",
            "The call was cancelled after saving the draft began, so the draft may be in the Drafts folder; search that folder before saving it again.",
        ),
        (
            ToolFailure::StoppedWhileSaving(Stop::TimedOut),
            "timed-out-while-saving",
            "The call did not finish within 240 seconds and was stopped after saving the draft began, so the draft may be in the Drafts folder; search that folder before saving it again.",
        ),
    ];

    #[test]
    fn describes_a_draft_that_may_be_stored_without_advice_to_try_again() {
        for (failure, class, sentence) in UNCONFIRMED_DRAFTS {
            assert_eq!(failure.class(), class);
            assert_eq!(failure.to_string(), sentence);
        }
    }

    #[test]
    fn describes_each_way_a_send_ends_unfinished_by_how_far_it_came() {
        for (failure, class, sentence) in UNFINISHED_SENDS {
            assert_eq!(failure.class(), class);
            assert_eq!(failure.to_string(), sentence);
        }
    }

    #[test]
    fn states_why_a_step_after_a_change_failed_without_advice_to_try_again() {
        let connection = |failure| ToolFailure::Connection {
            protocol: Protocol::Imap,
            failure,
        };
        let refused = ToolFailure::ImapRefused {
            operation: "save the copy",
            text: "[OVERQUOTA] Quota exceeded".to_owned(),
        };

        assert_eq!(
            connection(ConnectionFailure::Lost).format_reason(),
            "The connection to the IMAP server ended before it answered."
        );
        assert_eq!(
            connection(ConnectionFailure::TimedOut).format_reason(),
            "The IMAP server did not answer in time."
        );
        assert_eq!(
            connection(ConnectionFailure::Unreadable).format_reason(),
            "The IMAP server answered something Lys could not read."
        );
        assert_eq!(
            refused.format_reason(),
            "The IMAP server refused to save the copy: [OVERQUOTA] Quota exceeded."
        );
    }
}
