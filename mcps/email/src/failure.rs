//! Why a sign-in or a tool call did not do what it was asked.
//!
//! A [`SignInFailure`] is the machine-readable reason the check subcommand
//! reports and the desktop shows; a [`ToolFailure`] is what a tool answers
//! the model with, as one actionable sentence. The identity of a failure is
//! its variant; the text is derived from it, never parsed back.

use std::fmt;

use serde::Serialize;

use crate::email_id::EmailId;
use crate::folders::FolderRole;
use crate::mailbox::Mailbox;

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
    fn format_clause(self) -> &'static str {
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
    /// read, or it did not come in time. The draft may be in Drafts, and
    /// the call did not delete the draft it replaces, if any.
    DraftUnconfirmed {
        /// How the server's answer was lost.
        failure: ConnectionFailure,
        /// The id of the draft the new one replaces, or `None` when it
        /// replaces none.
        replaced: Option<EmailId>,
    },
    /// A `save_draft` call was stopped once storing its draft began; the
    /// draft may be in Drafts, and the draft it replaces, if any, may still
    /// be there too.
    StoppedWhileSaving {
        /// What stopped the call.
        stop: Stop,
        /// The id of the draft the new one replaces, or `None` when it
        /// replaces none.
        replaced: Option<EmailId>,
    },
    /// The whole call reached its time limit.
    TimedOut,
    /// The client cancelled the call.
    Cancelled,
    /// The id is not of the form `uid.uidvalidity.folder`, with `lys.`
    /// before it in Lys's mailbox; it names the mailbox of the tool it was
    /// given to.
    InvalidId(Mailbox),
    /// The id is valid but names a message of the person's mailbox, and
    /// was given to one of Lys's tools. The person's tools refuse an id of
    /// Lys's mailbox as `InvalidId`, so that nothing they answer names her
    /// mailbox, which only Caliginia and Lysiptera are told of.
    OtherMailboxId,
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
            Self::SignIn { .. }
            | Self::ImapRefused { .. }
            | Self::SmtpRefused { .. }
            | Self::SmtpExtensionMissing(_)
            | Self::SendUnconfirmed
            | Self::StoppedUnconfirmed(_)
            | Self::StoppedAfterSend { .. }
            | Self::DraftUnconfirmed { .. }
            | Self::StoppedWhileSaving { .. }
            | Self::TimedOut
            | Self::Cancelled
            | Self::InvalidId(_)
            | Self::OtherMailboxId
            | Self::StaleId
            | Self::FolderMissing(_)
            | Self::NoRoleFolder(_)
            | Self::RoleFolder { .. }
            | Self::FolderNotEmpty(_)
            | Self::FolderHasSubfolders(_)
            | Self::FolderExists(_)
            | Self::NotInDrafts
            | Self::AttachmentMissing { .. }
            | Self::AttachmentNotText { .. }
            | Self::Argument(_) => self.to_string(),
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
            Self::DraftUnconfirmed { failure, .. } => {
                format!("save-unconfirmed-{}", failure.name())
            }
            Self::StoppedWhileSaving { stop, .. } => format!("{}-while-saving", stop.name()),
            Self::TimedOut => "timed-out".to_owned(),
            Self::Cancelled => "cancelled".to_owned(),
            Self::InvalidId(_) => "invalid-id".to_owned(),
            Self::OtherMailboxId => "other-mailbox-id".to_owned(),
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

impl From<Stop> for ToolFailure {
    /// Gives the failure that reports a stop as it is, with nothing about
    /// how far the call came: [`ToolFailure::Cancelled`] for a call the
    /// client cancelled and [`ToolFailure::TimedOut`] for one that reached
    /// its time limit.
    fn from(stop: Stop) -> Self {
        match stop {
            Stop::Cancelled => Self::Cancelled,
            Stop::TimedOut => Self::TimedOut,
        }
    }
}

/// What a draft that may have been stored tells the model to do.
const UNCONFIRMED_DRAFT_ADVICE: &str = "search that folder before saving it again.";

impl fmt::Display for ToolFailure {
    /// Formats the failure as the sentence the model reads.
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        /// The sentence of an id that no longer names its message.
        const STALE_ID_SENTENCE: &str = "That message id is no longer valid. Search again.";

        /// The sentence of an id outside the Drafts folder.
        const NOT_IN_DRAFTS_SENTENCE: &str = "That id is not in the Drafts folder. Only a message in the Drafts folder can be sent or deleted as a draft.";

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
            Self::DraftUnconfirmed { failure, replaced } => {
                format_unconfirmed_draft_sentence(*failure, replaced.as_ref())
            }
            Self::StoppedWhileSaving { stop, replaced } => {
                format_stopped_while_saving_sentence(*stop, replaced.as_ref())
            }
            Self::TimedOut => format!("The call {}.", Stop::TimedOut.format_clause()),
            Self::Cancelled => format!("The call {}.", Stop::Cancelled.format_clause()),
            Self::InvalidId(mailbox) => format_invalid_id_sentence(*mailbox),
            Self::OtherMailboxId => {
                "This id is from the person's mailbox. Use the tools without lys_ for it."
                    .to_owned()
            }
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

/// Formats the sentence of a text that is not a message id, with an
/// example id and the search tool of the mailbox it was given to.
///
/// # Arguments
///
/// * `mailbox` - The mailbox of the tool the text was given to.
fn format_invalid_id_sentence(mailbox: Mailbox) -> String {
    format!(
        "That is not a message id. Use an id from {}search_emails, such as {}12.345.INBOX.",
        mailbox.tool_prefix(),
        mailbox.id_prefix()
    )
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
    /// What a send that may have gone out tells the model to do.
    const UNCONFIRMED_SENTENCE: &str = "The message may or may not have been sent; do not send it again without asking the person.";

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

/// Formats the sentence of a draft the IMAP server did not confirm it
/// stored, which names the draft it replaces, if any, as one the call did
/// not delete.
///
/// # Arguments
///
/// * `failure` - How the server's answer was lost.
/// * `replaced` - The id of the draft the new one replaces, if any.
fn format_unconfirmed_draft_sentence(
    failure: ConnectionFailure,
    replaced: Option<&EmailId>,
) -> String {
    let sentence = format!(
        "{} The whole draft had been handed over, so it may or may not be in the Drafts folder; {UNCONFIRMED_DRAFT_ADVICE}",
        failure.format_fact(Protocol::Imap)
    );
    match replaced {
        None => sentence,
        Some(replaced) => {
            format!("{sentence} The draft it replaces, {replaced}, is still in the Drafts folder.")
        }
    }
}

/// Formats the sentence of a `save_draft` call stopped once storing its
/// draft began, which names the draft it replaces, if any, as one that may
/// not have been deleted.
///
/// # Arguments
///
/// * `stop` - What stopped the call.
/// * `replaced` - The id of the draft the new one replaces, if any.
fn format_stopped_while_saving_sentence(stop: Stop, replaced: Option<&EmailId>) -> String {
    let sentence = format!(
        "The call {} after saving the draft began, so the draft may be in the Drafts folder; {UNCONFIRMED_DRAFT_ADVICE}",
        stop.format_clause()
    );
    match replaced {
        None => sentence,
        Some(replaced) => format!(
            "{sentence} The draft it replaces, {replaced}, may still be in the Drafts folder too."
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

    /// Checks that each sign-in failure serializes to its name and, in a
    /// `SignIn` failure, reads as the sentence that names the IMAP or SMTP
    /// server, gives the failure's clause, and points to the account in
    /// Settings.
    #[test]
    fn names_and_describes_every_sign_in_failure() {
        /// Each sign-in failure, with its name and the clause the model reads.
        const SIGN_IN_FAILURES: [(SignInFailure, &str, &str); 6] = [
            (
                SignInFailure::WrongPassword,
                "wrong-password",
                "the user name or password was refused",
            ),
            (
                SignInFailure::Unreachable,
                "unreachable",
                "the host could not be reached",
            ),
            (
                SignInFailure::CertificateRefused,
                "certificate-refused",
                "its certificate was refused by the operating system",
            ),
            (
                SignInFailure::EncryptionNotOffered,
                "encryption-not-offered",
                "it does not offer STARTTLS",
            ),
            (
                SignInFailure::TimedOut,
                "timed-out",
                "it did not answer in time",
            ),
            (
                SignInFailure::ProtocolError,
                "protocol-error",
                "it answered something Lys could not read",
            ),
        ];

        for (failure, name, clause) in SIGN_IN_FAILURES {
            let json = serde_json::to_string(&failure).expect("json");
            let sign_in = ToolFailure::SignIn {
                protocol: Protocol::Imap,
                failure,
            };
            assert_eq!(json, format!("\"{name}\""));
            assert_eq!(
                sign_in.to_string(),
                format!(
                    "Signing in to the IMAP server failed: {clause}. Check the email account in Settings → MCP."
                )
            );
        }
        assert_eq!(
            ToolFailure::SignIn {
                protocol: Protocol::Smtp,
                failure: SignInFailure::TimedOut
            }
            .to_string(),
            "Signing in to the SMTP server failed: it did not answer in time. Check the email account in Settings → MCP."
        );
    }

    /// Each failure about a folder, with the class the log gives it and the
    /// sentence the model reads.
    fn build_folder_failures() -> [(ToolFailure, &'static str, &'static str); 6] {
        [
            (
                ToolFailure::FolderMissing("Projects".to_owned()),
                "folder-missing",
                "There is no folder named Projects. Use list_folders to see the folders.",
            ),
            (
                ToolFailure::NoRoleFolder(FolderRole::Sent),
                "no-sent-folder",
                "No Sent folder was found. Create one with manage_folder.",
            ),
            (
                ToolFailure::RoleFolder {
                    name: "INBOX".to_owned(),
                    role: FolderRole::Inbox,
                },
                "role-folder",
                "INBOX is the Inbox folder, which cannot be renamed or deleted.",
            ),
            (
                ToolFailure::FolderNotEmpty("Projects".to_owned()),
                "folder-not-empty",
                "Projects holds messages, so it cannot be deleted. Empty it first.",
            ),
            (
                ToolFailure::FolderHasSubfolders("Projects".to_owned()),
                "folder-has-subfolders",
                "Projects holds other folders, so it cannot be deleted. Delete them first.",
            ),
            (
                ToolFailure::FolderExists("Projects".to_owned()),
                "folder-exists",
                "A folder named Projects already exists.",
            ),
        ]
    }

    /// Each failure about the SMTP server's refusal, a draft, or an
    /// attachment, with the class the log gives it and the sentence the
    /// model reads.
    fn build_message_failures() -> [(ToolFailure, &'static str, &'static str); 5] {
        [
            (
                ToolFailure::SmtpRefused {
                    code: 550,
                    text: "Mailbox unavailable".to_owned(),
                },
                "smtp-refused-550",
                "The SMTP server refused the message (550): Mailbox unavailable.",
            ),
            (
                ToolFailure::NotInDrafts,
                "not-in-drafts",
                "That id is not in the Drafts folder. Only a message in the Drafts folder can be sent or deleted as a draft.",
            ),
            (
                ToolFailure::AttachmentNotText {
                    name: "photo.png".to_owned(),
                    content_type: "image/png".to_owned(),
                },
                "attachment-not-text",
                "Attachment photo.png is image/png, not text, so it cannot be read.",
            ),
            (
                ToolFailure::AttachmentMissing {
                    number: 2,
                    count: 0,
                },
                "attachment-missing",
                "The message has no attachment, so there is no #2.",
            ),
            (
                ToolFailure::AttachmentMissing {
                    number: 4,
                    count: 3,
                },
                "attachment-missing",
                "The message has 3 attachments, so there is no #4.",
            ),
        ]
    }

    /// Checks that each folder failure has its log class and a sentence
    /// that names the folder or the role it concerns.
    #[test]
    fn names_the_folder_each_folder_failure_concerns() {
        for (failure, class, sentence) in build_folder_failures() {
            assert_eq!(failure.class(), class);
            assert_eq!(failure.to_string(), sentence);
        }
    }

    /// Checks that an SMTP refusal, an id outside the Drafts folder, an
    /// attachment that is not text, and a missing attachment each have
    /// their log class and the sentence the model reads.
    #[test]
    fn describes_smtp_refusals_drafts_outside_drafts_and_missing_attachments() {
        for (failure, class, sentence) in build_message_failures() {
            assert_eq!(failure.class(), class);
            assert_eq!(failure.to_string(), sentence);
        }
    }

    /// Each failure about which mailbox an id belongs to, with the class
    /// the log gives it and the sentence the model reads.
    fn build_mailbox_failures() -> [(ToolFailure, &'static str, &'static str); 3] {
        [
            (
                ToolFailure::InvalidId(Mailbox::Person),
                "invalid-id",
                "That is not a message id. Use an id from search_emails, such as 12.345.INBOX.",
            ),
            (
                ToolFailure::InvalidId(Mailbox::Lys),
                "invalid-id",
                "That is not a message id. Use an id from lys_search_emails, such as lys.12.345.INBOX.",
            ),
            (
                ToolFailure::OtherMailboxId,
                "other-mailbox-id",
                "This id is from the person's mailbox. Use the tools without lys_ for it.",
            ),
        ]
    }

    /// Checks that an id that is not one and an id of the person's mailbox
    /// given to Lys's tools each have their log class and the sentence the
    /// model reads, which names the tools to use instead.
    #[test]
    fn tells_which_mailbox_an_id_belongs_to() {
        for (failure, class, sentence) in build_mailbox_failures() {
            assert_eq!(failure.class(), class);
            assert_eq!(failure.to_string(), sentence);
        }
    }

    /// Checks that an IMAP refusal's sentence quotes the server's text
    /// while its log class names only the operation, and that a sign-in
    /// failure, a stale id, a missing attachment, and a missing Drafts
    /// folder read with their classes or sentences.
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

    /// Checks that each way a new draft's save can end unconfirmed has its
    /// log class and a sentence that says the draft may be stored, without
    /// advice to try again.
    #[test]
    fn describes_a_draft_that_may_be_stored_without_advice_to_try_again() {
        /// Each way a draft that replaces none can end unconfirmed, with the
        /// class the log gives it and the sentence the model reads.
        const UNCONFIRMED_DRAFTS: [(ToolFailure, &str, &str); 5] = [
            (
                ToolFailure::DraftUnconfirmed {
                    failure: ConnectionFailure::Lost,
                    replaced: None,
                },
                "save-unconfirmed-lost",
                "The connection to the IMAP server ended before it answered. The whole draft had been handed over, so it may or may not be in the Drafts folder; search that folder before saving it again.",
            ),
            (
                ToolFailure::DraftUnconfirmed {
                    failure: ConnectionFailure::Unreadable,
                    replaced: None,
                },
                "save-unconfirmed-unreadable",
                "The IMAP server answered something Lys could not read. The whole draft had been handed over, so it may or may not be in the Drafts folder; search that folder before saving it again.",
            ),
            (
                ToolFailure::DraftUnconfirmed {
                    failure: ConnectionFailure::TimedOut,
                    replaced: None,
                },
                "save-unconfirmed-timed-out",
                "The IMAP server did not answer in time. The whole draft had been handed over, so it may or may not be in the Drafts folder; search that folder before saving it again.",
            ),
            (
                ToolFailure::StoppedWhileSaving {
                    stop: Stop::Cancelled,
                    replaced: None,
                },
                "cancelled-while-saving",
                "The call was cancelled after saving the draft began, so the draft may be in the Drafts folder; search that folder before saving it again.",
            ),
            (
                ToolFailure::StoppedWhileSaving {
                    stop: Stop::TimedOut,
                    replaced: None,
                },
                "timed-out-while-saving",
                "The call did not finish within 240 seconds and was stopped after saving the draft began, so the draft may be in the Drafts folder; search that folder before saving it again.",
            ),
        ];

        for (failure, class, sentence) in UNCONFIRMED_DRAFTS {
            assert_eq!(failure.class(), class);
            assert_eq!(failure.to_string(), sentence);
        }
    }

    /// Each way a draft that replaces `1.1003.Drafts` can end unconfirmed,
    /// with the class the log gives it, the same as without a replaced
    /// draft, and the sentence the model reads, which names that draft.
    fn build_replacing_unconfirmed_drafts() -> [(ToolFailure, &'static str, &'static str); 5] {
        let replaced = Some(EmailId {
            mailbox: Mailbox::Person,
            uid: 1,
            uid_validity: 1003,
            folder: "Drafts".to_owned(),
        });
        [
            (
                ToolFailure::DraftUnconfirmed {
                    failure: ConnectionFailure::Lost,
                    replaced: replaced.clone(),
                },
                "save-unconfirmed-lost",
                "The connection to the IMAP server ended before it answered. The whole draft had been handed over, so it may or may not be in the Drafts folder; search that folder before saving it again. The draft it replaces, 1.1003.Drafts, is still in the Drafts folder.",
            ),
            (
                ToolFailure::DraftUnconfirmed {
                    failure: ConnectionFailure::Unreadable,
                    replaced: replaced.clone(),
                },
                "save-unconfirmed-unreadable",
                "The IMAP server answered something Lys could not read. The whole draft had been handed over, so it may or may not be in the Drafts folder; search that folder before saving it again. The draft it replaces, 1.1003.Drafts, is still in the Drafts folder.",
            ),
            (
                ToolFailure::DraftUnconfirmed {
                    failure: ConnectionFailure::TimedOut,
                    replaced: replaced.clone(),
                },
                "save-unconfirmed-timed-out",
                "The IMAP server did not answer in time. The whole draft had been handed over, so it may or may not be in the Drafts folder; search that folder before saving it again. The draft it replaces, 1.1003.Drafts, is still in the Drafts folder.",
            ),
            (
                ToolFailure::StoppedWhileSaving {
                    stop: Stop::Cancelled,
                    replaced: replaced.clone(),
                },
                "cancelled-while-saving",
                "The call was cancelled after saving the draft began, so the draft may be in the Drafts folder; search that folder before saving it again. The draft it replaces, 1.1003.Drafts, may still be in the Drafts folder too.",
            ),
            (
                ToolFailure::StoppedWhileSaving {
                    stop: Stop::TimedOut,
                    replaced,
                },
                "timed-out-while-saving",
                "The call did not finish within 240 seconds and was stopped after saving the draft began, so the draft may be in the Drafts folder; search that folder before saving it again. The draft it replaces, 1.1003.Drafts, may still be in the Drafts folder too.",
            ),
        ]
    }

    /// Checks that each way a replacing draft's save can end unconfirmed
    /// keeps the class it has without a replaced draft, and has a sentence
    /// that names the draft it replaces.
    #[test]
    fn names_the_draft_a_save_replaces_when_the_new_one_may_be_stored() {
        for (failure, class, sentence) in build_replacing_unconfirmed_drafts() {
            assert_eq!(failure.class(), class);
            assert_eq!(failure.to_string(), sentence);
        }
    }

    /// Checks that each of the ten ways a send can end unfinished has its
    /// log class and a sentence that says how far the send came.
    #[test]
    fn describes_each_way_a_send_ends_unfinished_by_how_far_it_came() {
        for (failure, class, sentence) in UNFINISHED_SENDS {
            assert_eq!(failure.class(), class);
            assert_eq!(failure.to_string(), sentence);
        }
    }

    /// Checks that the reason given for a lost, timed-out, or unreadable
    /// IMAP connection, and for an IMAP refusal with the server's text, is
    /// one sentence without advice to try again.
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
