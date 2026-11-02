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
    /// The SMTP server refused the message.
    SmtpRefused {
        /// The reply code, such as 550.
        code: u16,
        /// The server's text.
        text: String,
    },
    /// The SMTP server did not confirm the send in time; the message may
    /// have been sent.
    SendUnconfirmed,
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
            Self::Connection { protocol, failure } => format!(
                "{}-connection-{}",
                protocol.name().to_ascii_lowercase(),
                match failure {
                    ConnectionFailure::Lost => "lost",
                    ConnectionFailure::Unreadable => "unreadable",
                    ConnectionFailure::TimedOut => "timed-out",
                }
            ),
            Self::SmtpRefused { code, .. } => format!("smtp-refused-{code}"),
            Self::SendUnconfirmed => "send-unconfirmed".to_owned(),
            Self::TimedOut => "timed-out".to_owned(),
            Self::Cancelled => "cancelled".to_owned(),
            Self::InvalidId => "invalid-id".to_owned(),
            Self::StaleId => "stale-id".to_owned(),
            Self::FolderMissing(_) => "folder-missing".to_owned(),
            Self::NoRoleFolder(role) => format!("no-{}-folder", role.name().to_ascii_lowercase()),
            Self::RoleFolder { .. } => "role-folder".to_owned(),
            Self::FolderNotEmpty(_) => "folder-not-empty".to_owned(),
            Self::FolderExists(_) => "folder-exists".to_owned(),
            Self::NotInDrafts => "not-in-drafts".to_owned(),
            Self::AttachmentMissing { .. } => "attachment-missing".to_owned(),
            Self::AttachmentNotText { .. } => "attachment-not-text".to_owned(),
            Self::Argument(_) => "argument".to_owned(),
        }
    }
}

impl fmt::Display for ToolFailure {
    /// Formats the failure as the sentence the model reads.
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::SignIn { protocol, failure } => write!(
                formatter,
                "Signing in to the {} server failed: {}. Check the email account in Settings → MCP.",
                protocol.name(),
                failure.format_clause()
            ),
            Self::ImapRefused { operation, text } => {
                write!(formatter, "The IMAP server refused to {operation}: {text}.")
            }
            Self::Connection { protocol, failure } => match failure {
                ConnectionFailure::Lost => write!(
                    formatter,
                    "The connection to the {} server ended before it answered. Try again.",
                    protocol.name()
                ),
                ConnectionFailure::Unreadable => write!(
                    formatter,
                    "The {} server answered something Lys could not read.",
                    protocol.name()
                ),
                ConnectionFailure::TimedOut => {
                    write!(formatter, "The {} server did not answer in time. Try again.", protocol.name())
                }
            },
            Self::SmtpRefused { code, text } => {
                write!(formatter, "The SMTP server refused the message ({code}): {text}.")
            }
            Self::SendUnconfirmed => formatter.write_str(
                "The SMTP server did not confirm the send in time. The message may or may not have been sent; check the Sent folder before sending it again.",
            ),
            Self::TimedOut => {
                formatter.write_str("The call did not finish within 240 seconds and was stopped.")
            }
            Self::Cancelled => formatter.write_str("The call was cancelled."),
            Self::InvalidId => formatter.write_str(
                "That is not a message id. Use an id from search_emails, such as 12.345.INBOX.",
            ),
            Self::StaleId => formatter.write_str("That message id is no longer valid. Search again."),
            Self::FolderMissing(name) => write!(
                formatter,
                "There is no folder named {name}. Use list_folders to see the folders."
            ),
            Self::NoRoleFolder(role) => write!(
                formatter,
                "No {} folder was found. Create one with manage_folder.",
                role.name()
            ),
            Self::RoleFolder { name, role } => write!(
                formatter,
                "{name} is the {} folder, which cannot be renamed or deleted.",
                role.name()
            ),
            Self::FolderNotEmpty(name) => write!(
                formatter,
                "{name} holds messages, so it cannot be deleted. Empty it first."
            ),
            Self::FolderExists(name) => write!(formatter, "A folder named {name} already exists."),
            Self::NotInDrafts => formatter.write_str(
                "That id is not in the Drafts folder. Only a draft saved with save_draft can be sent or deleted here.",
            ),
            Self::AttachmentMissing { number, count } => match count {
                0 => write!(formatter, "The message has no attachment, so there is no #{number}."),
                1 => write!(formatter, "The message has one attachment, so there is no #{number}."),
                _ => write!(formatter, "The message has {count} attachments, so there is no #{number}."),
            },
            Self::AttachmentNotText { name, content_type } => write!(
                formatter,
                "Attachment {name} is {content_type}, not text, so it cannot be read."
            ),
            Self::Argument(text) => formatter.write_str(text),
        }
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
}
