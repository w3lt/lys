//! IMAP connections: one per tool call, signed in and bounded by time
//! limits.
//!
//! [`open_imap_session`] connects, protects the connection as the account
//! says, reads the greeting, signs in, and gives an [`ImapSession`] whose
//! every command answers within [`EXCHANGE_LIMIT`] or fails. Each command
//! is read up to its tagged status, so a `NO` or `BAD` is a failure that
//! carries the server's code and text, never an empty answer. The session
//! is closed with [`ImapSession::close`], which logs out; dropping it
//! closes the socket either way. A command that ends in a time limit or a
//! lost connection leaves the session unusable, and the tools never reuse
//! one.
//!
//! Folder names given to commands are the server's own (modified UTF-7);
//! [`crate::folder_name`] converts them.

use std::borrow::Cow;
use std::fmt;
use std::io;
use std::time::Duration;

use async_imap::error::Error as ImapError;
use async_imap::imap_proto::{
    AttributeValue, Capability, MailboxDatum, MessageSection, Outcome, RequestId, Response,
    ResponseCode, SectionPath, Status, StatusAttribute,
};
use async_imap::types::NameAttribute;
use async_imap::{Client, Session};
use mail_parser::DateTime;
use tokio::io::{AsyncRead, AsyncWrite, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::time::timeout;
use tokio_rustls::client::TlsStream;
use tokio_rustls::rustls::pki_types::ServerName;

use crate::account::{Account, MailServer, Security};
use crate::failure::{ConnectionFailure, SignInFailure};
use crate::folders::FolderListing;
use crate::log::send_log_line;
use crate::trust::{Trust, is_certificate_refusal};

/// Longest a TCP connection or a TLS handshake may take.
pub const CONNECT_LIMIT: Duration = Duration::from_secs(15);

/// Longest one command may take to be answered in full.
pub const EXCHANGE_LIMIT: Duration = Duration::from_secs(30);

/// Header fields fetched for a listing, enough for a search hit, a
/// conversation link, and a reply.
const SUMMARY_QUERY: &str = "(UID FLAGS INTERNALDATE RFC822.SIZE BODY.PEEK[HEADER.FIELDS (DATE FROM TO CC SUBJECT MESSAGE-ID IN-REPLY-TO REFERENCES)])";

/// What is fetched to read a message without marking it as read.
const MESSAGE_QUERY: &str = "(UID FLAGS BODY.PEEK[])";

/// Month names as IMAP dates write them.
const MONTH_NAMES: [&str; 12] = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/// Longest server text a refusal passes on, in characters (Unicode scalar
/// values); a longer one keeps its first 500 characters and ends with an
/// ellipsis.
const REFUSAL_TEXT_LIMIT: usize = 500;

/// A command whose connection ended or failed before its tagged status.
const LOST: ImapFailure = ImapFailure::Connection(ConnectionFailure::Lost);

/// A command the server answered with something that is not its answer.
const UNREADABLE: ImapFailure = ImapFailure::Connection(ConnectionFailure::Unreadable);

/// A command that was not answered within [`EXCHANGE_LIMIT`].
const TIMED_OUT: ImapFailure = ImapFailure::Connection(ConnectionFailure::TimedOut);

/// A stream an IMAP session runs over: TCP, or TLS over TCP.
pub trait AsyncStream: AsyncRead + AsyncWrite + Unpin + Send + fmt::Debug {}

impl<T: AsyncRead + AsyncWrite + Unpin + Send + fmt::Debug> AsyncStream for T {}

/// The stream of a signed-in session.
type Stream = Box<dyn AsyncStream>;

/// Why a command on a signed-in session did not complete.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ImapFailure {
    /// The server refused the command (`NO` or `BAD`): its response code
    /// and text as the server wrote them, a longer text than
    /// [`REFUSAL_TEXT_LIMIT`] characters cut there with an ellipsis.
    Refused(String),
    /// The connection ended, answered something unreadable, or timed out.
    Connection(ConnectionFailure),
}

/// The system flags of a message that the tools report.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Flags {
    /// `\Seen`: the message was read.
    pub seen: bool,
    /// `\Answered`: the message was replied to.
    pub answered: bool,
    /// `\Flagged`: the message is flagged.
    pub flagged: bool,
    /// `\Draft`: the message is a draft.
    pub draft: bool,
    /// `\Deleted`: the message waits for an expunge.
    pub deleted: bool,
}

impl Flags {
    /// Formats the flags as the tools list them, `read` for a seen
    /// message and `unread` otherwise.
    pub fn format(self) -> String {
        let mut words = vec![if self.seen { "read" } else { "unread" }];
        if self.answered {
            words.push("answered");
        }
        if self.flagged {
            words.push("flagged");
        }
        if self.draft {
            words.push("draft");
        }
        if self.deleted {
            words.push("deleted");
        }
        words.join(", ")
    }
}

/// A message as a listing fetches it: its flags, dates, size, and the
/// header fields the summary query asks for.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Summary {
    /// The message's UID.
    pub uid: u32,
    /// Its system flags.
    pub flags: Flags,
    /// Its size in bytes, when the server reported it.
    pub size: Option<u32>,
    /// When the server received it, as RFC 3339 text.
    pub internal_date: Option<String>,
    /// When the server received it, as seconds since the Unix epoch.
    pub internal_timestamp: Option<i64>,
    /// The fetched header fields, as the server sent them.
    pub header: Vec<u8>,
}

/// A whole message as fetched without marking it as read.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FetchedMessage {
    /// The message's UID.
    pub uid: u32,
    /// Its system flags.
    pub flags: Flags,
    /// The message's bytes (RFC 5322).
    pub bytes: Vec<u8>,
}

/// What deleting one message did.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Deletion {
    /// The message was marked `\Deleted` and expunged by its UID: it is
    /// gone.
    Removed,
    /// The message was only marked `\Deleted`: the server lacks UIDPLUS,
    /// so it cannot expunge one message on its own, and expunging the
    /// folder would also remove every other message marked `\Deleted`.
    MarkedOnly,
}

/// How a folder is opened.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FolderAccess {
    /// Examined (`EXAMINE`): nothing in the folder changes, not even the
    /// `\Recent` flags.
    Read,
    /// Selected (`SELECT`): flags can be stored and messages deleted.
    Change,
}

/// What a selected folder reports.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SelectedFolder {
    /// The folder's UIDVALIDITY.
    pub uid_validity: u32,
    /// How many messages it holds.
    pub exists: u32,
}

/// A signed-in IMAP session.
///
/// Concurrency model: single-owner; every command takes the session
/// mutably, so one task at a time uses it, and each tool call opens its
/// own. Resource ownership: owns the connection; [`Self::close`] logs out
/// and closes it, and dropping the session closes the socket without
/// logging out.
pub struct ImapSession {
    /// The protocol session.
    session: Session<Stream>,
    /// Whether the server supports `UID EXPUNGE`, once asked.
    supports_uid_plus: Option<bool>,
}

impl fmt::Debug for ImapSession {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ImapSession")
            .field("supports_uid_plus", &self.supports_uid_plus)
            .finish_non_exhaustive()
    }
}

/// Connects to the account's IMAP server and signs in.
///
/// # Arguments
///
/// * `account` - The server, how the connection is protected, and the
///   user name and password to sign in with.
/// * `trust` - Which certificates are accepted.
///
/// # Returns
///
/// The signed-in session, or why signing in failed: the server could not
/// be reached within [`CONNECT_LIMIT`]; the TLS handshake failed, with the
/// certificate refused or otherwise; STARTTLS was refused; the greeting,
/// the STARTTLS answer, or the sign-in took longer than
/// [`EXCHANGE_LIMIT`]; the credentials were refused; or the server
/// answered something unreadable or ended the connection.
pub async fn open_imap_session(
    account: &Account,
    trust: &Trust,
) -> Result<ImapSession, SignInFailure> {
    let server = &account.imap;
    let tcp = open_tcp_stream(server).await?;
    let client: Client<Stream> = match server.security {
        Security::Tls => {
            let tls = open_tls_stream(server, trust, tcp).await?;
            let mut client = Client::new(Box::new(tls) as Stream);
            read_greeting(&mut client).await?;
            client
        }
        Security::StartTls => {
            let mut client = Client::new(tcp);
            read_greeting(&mut client).await?;
            start_tls(&mut client).await?;
            let tls = open_tls_stream(server, trust, client.into_inner()).await?;
            Client::new(Box::new(tls) as Stream)
        }
        Security::Plain => {
            let mut client = Client::new(Box::new(tcp) as Stream);
            read_greeting(&mut client).await?;
            client
        }
    };
    let login = client.login(&account.user_name, account.password.as_str());
    let session = match timeout(EXCHANGE_LIMIT, login).await {
        Ok(Ok(session)) => session,
        Ok(Err((error, _client))) => return Err(calculate_sign_in_failure(&error)),
        Err(_) => return Err(SignInFailure::TimedOut),
    };
    Ok(ImapSession {
        session,
        supports_uid_plus: None,
    })
}

/// Opens the TCP connection within [`CONNECT_LIMIT`].
async fn open_tcp_stream(server: &MailServer) -> Result<TcpStream, SignInFailure> {
    match timeout(
        CONNECT_LIMIT,
        TcpStream::connect((server.server_name(), server.port)),
    )
    .await
    {
        Ok(Ok(stream)) => Ok(stream),
        Ok(Err(_)) | Err(_) => Err(SignInFailure::Unreachable),
    }
}

/// Runs the TLS handshake within [`CONNECT_LIMIT`].
async fn open_tls_stream(
    server: &MailServer,
    trust: &Trust,
    tcp: TcpStream,
) -> Result<TlsStream<TcpStream>, SignInFailure> {
    let connector = trust.build_imap_connector().map_err(|error| {
        send_log_line(&format!(
            "imap: the TLS configuration could not be built: {error}"
        ));
        SignInFailure::ProtocolError
    })?;
    let name = ServerName::try_from(server.server_name().to_owned())
        .map_err(|_| SignInFailure::ProtocolError)?;
    match timeout(CONNECT_LIMIT, connector.connect(name, tcp)).await {
        Ok(Ok(tls)) => Ok(tls),
        Ok(Err(error)) if is_certificate_refusal(&error) => Err(SignInFailure::CertificateRefused),
        Ok(Err(error)) => Err(calculate_io_sign_in_failure(&error)),
        Err(_) => Err(SignInFailure::TimedOut),
    }
}

/// Reads the server's greeting within [`EXCHANGE_LIMIT`].
async fn read_greeting<T: AsyncStream>(client: &mut Client<T>) -> Result<(), SignInFailure> {
    match timeout(EXCHANGE_LIMIT, client.read_response()).await {
        Ok(Ok(Some(_))) => Ok(()),
        Ok(Ok(None)) => Err(SignInFailure::ProtocolError),
        Ok(Err(error)) => Err(calculate_io_sign_in_failure(&error)),
        Err(_) => Err(SignInFailure::TimedOut),
    }
}

/// Asks the server to start TLS; a refusal means it is not offered.
async fn start_tls(client: &mut Client<TcpStream>) -> Result<(), SignInFailure> {
    match timeout(
        EXCHANGE_LIMIT,
        client.run_command_and_check_ok("STARTTLS", None),
    )
    .await
    {
        Ok(Ok(())) => Ok(()),
        Ok(Err(ImapError::No(_) | ImapError::Bad(_))) => Err(SignInFailure::EncryptionNotOffered),
        Ok(Err(error)) => Err(calculate_sign_in_failure(&error)),
        Err(_) => Err(SignInFailure::TimedOut),
    }
}

/// Classifies a protocol error met before the session was signed in.
fn calculate_sign_in_failure(error: &ImapError) -> SignInFailure {
    match error {
        ImapError::No(_) => SignInFailure::WrongPassword,
        ImapError::Io(error) => calculate_io_sign_in_failure(error),
        ImapError::Bad(_)
        | ImapError::ConnectionLost
        | ImapError::Parse(_)
        | ImapError::Validate(_)
        | ImapError::Append => SignInFailure::ProtocolError,
        _ => SignInFailure::ProtocolError,
    }
}

/// Classifies an I/O error met before the session was signed in: a
/// timeout of the operating system is reported as such, anything else as
/// an unreadable or ended connection.
fn calculate_io_sign_in_failure(error: &io::Error) -> SignInFailure {
    match error.kind() {
        io::ErrorKind::TimedOut => SignInFailure::TimedOut,
        _ => SignInFailure::ProtocolError,
    }
}

impl ImapSession {
    /// Lists every folder the account has.
    ///
    /// # Returns
    ///
    /// The folders in the server's order, or why the listing failed.
    pub async fn list_folders(&mut self) -> Result<Vec<FolderListing>, ImapFailure> {
        send_command(&mut self.session, "LIST \"\" \"*\"", read_listing).await
    }

    /// Counts the messages of a folder without selecting it.
    ///
    /// # Arguments
    ///
    /// * `raw_name` - The folder's name as the server wrote it.
    ///
    /// # Returns
    ///
    /// The count, or why it is not known; an answer without the count is
    /// unreadable.
    pub async fn get_message_count(&mut self, raw_name: &str) -> Result<u32, ImapFailure> {
        let command = format!("STATUS {} (MESSAGES)", quote_folder_name(raw_name)?);
        let counts = send_command(&mut self.session, &command, read_message_count).await?;
        counts.last().copied().ok_or(UNREADABLE)
    }

    /// Opens a folder, read-only or for changes; it stays open until
    /// another folder is opened or the session closes.
    ///
    /// # Arguments
    ///
    /// * `raw_name` - The folder's name as the server wrote it.
    /// * `access` - Whether to examine the folder or select it.
    ///
    /// # Returns
    ///
    /// The folder's UIDVALIDITY and message count, or why the selection
    /// failed; a server that reports no UIDVALIDITY is unreadable.
    pub async fn open_folder(
        &mut self,
        raw_name: &str,
        access: FolderAccess,
    ) -> Result<SelectedFolder, ImapFailure> {
        let verb = match access {
            FolderAccess::Read => "EXAMINE",
            FolderAccess::Change => "SELECT",
        };
        let command = format!("{verb} {}", quote_folder_name(raw_name)?);
        let facts = send_command(&mut self.session, &command, read_selection_fact).await?;
        build_selected_folder(&facts)
    }

    /// Searches the selected folder.
    ///
    /// # Arguments
    ///
    /// * `criteria` - The search keys, formatted with
    ///   [`format_search_text`] and [`format_search_date`].
    ///
    /// # Returns
    ///
    /// The matching UIDs, highest first.
    pub async fn list_matching_uids(&mut self, criteria: &str) -> Result<Vec<u32>, ImapFailure> {
        let command = format!("UID SEARCH {criteria}");
        let answers = send_command(&mut self.session, &command, read_search_uids).await?;
        let mut uids: Vec<u32> = answers.into_iter().flatten().collect();
        uids.sort_unstable_by(|left, right| right.cmp(left));
        uids.dedup();
        Ok(uids)
    }

    /// Fetches the summaries of messages of the selected folder, without
    /// marking them as read.
    ///
    /// # Arguments
    ///
    /// * `uids` - The messages' UIDs; a UID that no longer exists is left
    ///   out of the answer.
    pub async fn list_summaries(&mut self, uids: &[u32]) -> Result<Vec<Summary>, ImapFailure> {
        if uids.is_empty() {
            return Ok(Vec::new());
        }
        let command = format!("UID FETCH {} {SUMMARY_QUERY}", format_uid_set(uids));
        send_command(&mut self.session, &command, read_summary).await
    }

    /// Fetches one whole message of the selected folder, without marking
    /// it as read.
    ///
    /// # Arguments
    ///
    /// * `uid` - The message's UID.
    ///
    /// # Returns
    ///
    /// The message, or `None` when no message has the UID any more.
    pub async fn find_message(&mut self, uid: u32) -> Result<Option<FetchedMessage>, ImapFailure> {
        let command = format!("UID FETCH {uid} {MESSAGE_QUERY}");
        let messages = send_command(&mut self.session, &command, read_fetched_message).await?;
        Ok(messages.into_iter().find(|message| message.uid == uid))
    }

    /// Appends a message to a folder.
    ///
    /// # Arguments
    ///
    /// * `raw_name` - The folder's name as the server wrote it.
    /// * `flags` - The flag list, such as `(\Seen)`.
    /// * `bytes` - The message (RFC 5322).
    ///
    /// # Returns
    ///
    /// Nothing once the server stored the message, or why it did not: its
    /// code and text when it refused the command, before or after the
    /// message was sent.
    pub async fn save_message(
        &mut self,
        raw_name: &str,
        flags: &str,
        bytes: &[u8],
    ) -> Result<(), ImapFailure> {
        let command = format!(
            "APPEND {} {flags} {{{}}}",
            quote_folder_name(raw_name)?,
            bytes.len()
        );
        timeout(
            EXCHANGE_LIMIT,
            send_append(&mut self.session, &command, bytes),
        )
        .await
        .unwrap_or(Err(TIMED_OUT))
    }

    /// Deletes one message of the selected folder: marks it `\Deleted`
    /// and, when the server supports UIDPLUS, expunges it by its UID. No
    /// other message is ever expunged, so a server without UIDPLUS keeps
    /// the message, marked, until something expunges the folder.
    ///
    /// # Arguments
    ///
    /// * `uid` - The message's UID.
    ///
    /// # Returns
    ///
    /// Whether the message is gone or only marked, or why a command
    /// failed; a refused expunge leaves the message marked.
    pub async fn delete_message(&mut self, uid: u32) -> Result<Deletion, ImapFailure> {
        let supports_uid_plus = self.find_uid_plus().await?;
        let mark = format!("UID STORE {uid} +FLAGS.SILENT (\\Deleted)");
        run_status_command(&mut self.session, &mark).await?;
        if !supports_uid_plus {
            return Ok(Deletion::MarkedOnly);
        }
        run_status_command(&mut self.session, &format!("UID EXPUNGE {uid}")).await?;
        Ok(Deletion::Removed)
    }

    /// Creates a folder.
    ///
    /// # Arguments
    ///
    /// * `raw_name` - The new folder's name as the server expects it.
    pub async fn create_folder(&mut self, raw_name: &str) -> Result<(), ImapFailure> {
        let command = format!("CREATE {}", quote_folder_name(raw_name)?);
        run_status_command(&mut self.session, &command).await
    }

    /// Deletes a folder.
    ///
    /// # Arguments
    ///
    /// * `raw_name` - The folder's name as the server wrote it.
    pub async fn delete_folder(&mut self, raw_name: &str) -> Result<(), ImapFailure> {
        let command = format!("DELETE {}", quote_folder_name(raw_name)?);
        run_status_command(&mut self.session, &command).await
    }

    /// Renames a folder.
    ///
    /// # Arguments
    ///
    /// * `raw_name` - The folder's name as the server wrote it.
    /// * `new_raw_name` - The new name as the server expects it.
    pub async fn update_folder_name(
        &mut self,
        raw_name: &str,
        new_raw_name: &str,
    ) -> Result<(), ImapFailure> {
        let command = format!(
            "RENAME {} {}",
            quote_folder_name(raw_name)?,
            quote_folder_name(new_raw_name)?
        );
        run_status_command(&mut self.session, &command).await
    }

    /// Logs out and closes the connection; a failure to log out is logged
    /// and otherwise ignored, as the socket closes either way.
    pub async fn close(mut self) {
        match timeout(EXCHANGE_LIMIT, self.session.logout()).await {
            Ok(Ok(())) => {}
            Ok(Err(_)) => send_log_line("imap: logout refused"),
            Err(_) => send_log_line("imap: logout timed out"),
        }
    }

    /// Asks the server once whether it supports UIDPLUS; an answer that
    /// does not list it, in any letter case, means it does not.
    async fn find_uid_plus(&mut self) -> Result<bool, ImapFailure> {
        if let Some(supported) = self.supports_uid_plus {
            return Ok(supported);
        }
        let answers = send_command(&mut self.session, "CAPABILITY", read_uid_plus).await?;
        let supported = answers.contains(&true);
        self.supports_uid_plus = Some(supported);
        Ok(supported)
    }
}

/// Sends one command and reads its answers up to its tagged status,
/// within [`EXCHANGE_LIMIT`].
///
/// # Arguments
///
/// * `session` - The signed-in session.
/// * `command` - The command, without its tag.
/// * `read_answer` - Reads an untagged response the command asked for;
///   `None` skips any other response, such as an update the server sends
///   on its own.
///
/// # Returns
///
/// The answers in the server's order, or why the command failed: the
/// server's code and text for `NO` or `BAD`, an ended connection, an
/// answer that is not IMAP, or the time limit.
async fn send_command<T>(
    session: &mut Session<Stream>,
    command: &str,
    read_answer: fn(&Response<'_>) -> Option<T>,
) -> Result<Vec<T>, ImapFailure> {
    let exchange = async {
        let tag = session.run_command(command).await.map_err(|_| LOST)?;
        read_tagged_answers(session, &tag, read_answer).await
    };
    timeout(EXCHANGE_LIMIT, exchange)
        .await
        .unwrap_or(Err(TIMED_OUT))
}

/// Runs one command whose tagged status is its whole answer.
///
/// # Arguments
///
/// * `session` - The signed-in session.
/// * `command` - The command, without its tag.
async fn run_status_command(
    session: &mut Session<Stream>,
    command: &str,
) -> Result<(), ImapFailure> {
    send_command(session, command, |_| None::<()>)
        .await
        .map(drop)
}

/// Sends an APPEND: the command, the message once the server asks for it,
/// and then reads the tagged status.
///
/// # Arguments
///
/// * `session` - The signed-in session.
/// * `command` - The command up to the length of its message, without
///   its tag.
/// * `bytes` - The message.
///
/// # Returns
///
/// Nothing once the server stored the message; the server's code and text
/// when it refused the command, before or after the message; or why the
/// connection failed.
async fn send_append(
    session: &mut Session<Stream>,
    command: &str,
    bytes: &[u8],
) -> Result<(), ImapFailure> {
    let tag = session.run_command(command).await.map_err(|_| LOST)?;
    loop {
        let response = session
            .read_response()
            .await
            .map_err(|_| LOST)?
            .ok_or(LOST)?;
        if matches!(response.parsed(), Response::Continue(_)) {
            break;
        }
        if let Some(outcome) = calculate_tagged_outcome(response.parsed(), &tag) {
            // A tagged OK before the message was sent answers a command
            // that never received its message, so it is not the answer.
            return outcome.and(Err(UNREADABLE));
        }
    }
    let stream = session.get_mut();
    stream.write_all(bytes).await.map_err(|_| LOST)?;
    stream.write_all(b"\r\n").await.map_err(|_| LOST)?;
    stream.flush().await.map_err(|_| LOST)?;
    read_tagged_answers(session, &tag, |_| None::<()>)
        .await
        .map(drop)
}

/// Reads a command's answers up to its tagged status.
///
/// # Arguments
///
/// * `session` - The signed-in session.
/// * `tag` - The command's tag.
/// * `read_answer` - Reads an untagged response the command asked for.
async fn read_tagged_answers<T>(
    session: &mut Session<Stream>,
    tag: &RequestId,
    read_answer: fn(&Response<'_>) -> Option<T>,
) -> Result<Vec<T>, ImapFailure> {
    let mut answers = Vec::new();
    loop {
        let response = session
            .read_response()
            .await
            .map_err(|_| LOST)?
            .ok_or(LOST)?;
        if let Some(outcome) = calculate_tagged_outcome(response.parsed(), tag) {
            return outcome.map(|()| answers);
        }
        answers.extend(read_answer(response.parsed()));
    }
}

/// Calculates how a response ends the command of the tag.
///
/// # Returns
///
/// `None` for a response that is not the command's tagged status;
/// otherwise success for `OK`, a refusal with the server's code and text
/// for `NO` or `BAD`, and an unreadable answer for any other status.
fn calculate_tagged_outcome(
    response: &Response<'_>,
    tag: &RequestId,
) -> Option<Result<(), ImapFailure>> {
    let Response::Done {
        tag: done,
        status,
        outcome,
    } = response
    else {
        return None;
    };
    if done != tag {
        return None;
    }
    Some(match status {
        Status::Ok => Ok(()),
        Status::No | Status::Bad => Err(ImapFailure::Refused(format_refusal_text(outcome))),
        Status::PreAuth | Status::Bye => Err(UNREADABLE),
    })
}

/// Formats the text of a refusal as the server wrote it: the response
/// code in brackets, for a code that can come with a refusal, then the
/// server's text, at most [`REFUSAL_TEXT_LIMIT`] characters of it.
///
/// A code the protocol library does not know, such as `OVERQUOTA`, is
/// part of the server's text as written.
fn format_refusal_text(outcome: &Outcome<'_>) -> String {
    let code = outcome.code.as_ref().and_then(format_response_code);
    let text = match (code, outcome.information.as_deref()) {
        (Some(code), Some(information)) => format!("[{code}] {information}"),
        (Some(code), None) => format!("[{code}]"),
        (None, Some(information)) => information.to_owned(),
        (None, None) => "no reason given".to_owned(),
    };
    match text.char_indices().nth(REFUSAL_TEXT_LIMIT) {
        Some((end, _)) => format!("{}…", &text[..end]),
        None => text,
    }
}

/// Formats a response code that can come with a refusal as the protocol
/// writes it.
///
/// # Returns
///
/// The code, or `None` for a code that only comes with an answer, such
/// as `UIDVALIDITY`.
fn format_response_code(code: &ResponseCode<'_>) -> Option<String> {
    match code {
        ResponseCode::Alert => Some("ALERT".to_owned()),
        ResponseCode::BadCharset(None) => Some("BADCHARSET".to_owned()),
        ResponseCode::BadCharset(Some(charsets)) => {
            Some(format!("BADCHARSET ({})", charsets.join(" ")))
        }
        ResponseCode::Parse => Some("PARSE".to_owned()),
        ResponseCode::ReadOnly => Some("READ-ONLY".to_owned()),
        ResponseCode::ReadWrite => Some("READ-WRITE".to_owned()),
        ResponseCode::TryCreate => Some("TRYCREATE".to_owned()),
        ResponseCode::UidNotSticky => Some("UIDNOTSTICKY".to_owned()),
        _ => None,
    }
}

/// Quotes a folder name for a command.
///
/// # Returns
///
/// The quoted name, or an unreadable answer for a name with a line
/// break, which only the server's own listing can give and a quoted
/// string cannot hold.
fn quote_folder_name(raw_name: &str) -> Result<String, ImapFailure> {
    if raw_name.contains(['\r', '\n']) {
        return Err(UNREADABLE);
    }
    Ok(format_quoted_string(raw_name))
}

/// Formats a text without line breaks as a quoted string.
fn format_quoted_string(text: &str) -> String {
    format!("\"{}\"", text.replace('\\', "\\\\").replace('"', "\\\""))
}

/// Reads a folder listing from a `LIST` answer.
fn read_listing(response: &Response<'_>) -> Option<FolderListing> {
    let Response::MailboxData(MailboxDatum::List(list)) = response else {
        return None;
    };
    Some(FolderListing {
        raw_name: list.name.to_string(),
        attributes: list.name_attributes.iter().map(format_attribute).collect(),
        delimiter: list.delimiter.as_deref().map(str::to_owned),
    })
}

/// Reads the message count of a `STATUS` answer.
fn read_message_count(response: &Response<'_>) -> Option<u32> {
    let Response::MailboxData(MailboxDatum::Status { status, .. }) = response else {
        return None;
    };
    for attribute in status {
        if let StatusAttribute::Messages(count) = attribute {
            return Some(*count);
        }
    }
    None
}

/// What a `SELECT` or `EXAMINE` answer reports about the folder.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum SelectionFact {
    /// How many messages the folder holds.
    Exists(u32),
    /// The folder's UIDVALIDITY.
    UidValidity(u32),
}

/// Reads a fact about the selected folder from a `SELECT` or `EXAMINE`
/// answer.
fn read_selection_fact(response: &Response<'_>) -> Option<SelectionFact> {
    match response {
        Response::MailboxData(MailboxDatum::Exists(count)) => Some(SelectionFact::Exists(*count)),
        Response::Data {
            status: Status::Ok,
            outcome:
                Outcome {
                    code: Some(ResponseCode::UidValidity(uid_validity)),
                    ..
                },
        } => Some(SelectionFact::UidValidity(*uid_validity)),
        _ => None,
    }
}

/// Builds what a selection reports from its facts, the last of each kind
/// counting.
///
/// # Returns
///
/// The folder's UIDVALIDITY and message count, or an unreadable answer
/// without UIDVALIDITY; a missing count is 0.
fn build_selected_folder(facts: &[SelectionFact]) -> Result<SelectedFolder, ImapFailure> {
    let mut uid_validity = None;
    let mut exists = 0;
    for fact in facts {
        match fact {
            SelectionFact::Exists(count) => exists = *count,
            SelectionFact::UidValidity(value) => uid_validity = Some(*value),
        }
    }
    Ok(SelectedFolder {
        uid_validity: uid_validity.ok_or(UNREADABLE)?,
        exists,
    })
}

/// Reads the UIDs of a `SEARCH` answer.
fn read_search_uids(response: &Response<'_>) -> Option<Vec<u32>> {
    let Response::MailboxData(MailboxDatum::Search(uids)) = response else {
        return None;
    };
    Some(uids.clone())
}

/// Reads whether a `CAPABILITY` answer lists UIDPLUS, in any letter case.
fn read_uid_plus(response: &Response<'_>) -> Option<bool> {
    let Response::Capabilities(capabilities) = response else {
        return None;
    };
    Some(capabilities.iter().any(is_uid_plus))
}

/// Whether a capability is UIDPLUS, in any letter case.
fn is_uid_plus(capability: &Capability<'_>) -> bool {
    matches!(capability, Capability::Atom(name) if name.eq_ignore_ascii_case("UIDPLUS"))
}

/// The attributes of one `FETCH` answer that the tools use.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
struct FetchedAttributes {
    /// The message's UID.
    uid: Option<u32>,
    /// Its system flags; none when the answer has no flag list.
    flags: Flags,
    /// Its size in bytes.
    size: Option<u32>,
    /// When the server received it.
    internal_date: Option<DateTime>,
    /// The header fields fetched.
    header: Option<Vec<u8>>,
    /// The whole message.
    body: Option<Vec<u8>>,
}

/// Reads the attributes of a `FETCH` answer.
fn read_fetched_attributes(response: &Response<'_>) -> Option<FetchedAttributes> {
    let Response::Fetch(_, values) = response else {
        return None;
    };
    let mut attributes = FetchedAttributes::default();
    for value in values {
        match value {
            AttributeValue::Uid(uid) => attributes.uid = Some(*uid),
            AttributeValue::Flags(names) => attributes.flags = read_flags(names),
            AttributeValue::Rfc822Size(size) => attributes.size = Some(*size),
            AttributeValue::InternalDate(text) => {
                attributes.internal_date = parse_internal_date(text)
            }
            AttributeValue::BodySection {
                section: Some(SectionPath::Full(MessageSection::Header)),
                data: Some(data),
                ..
            }
            | AttributeValue::Rfc822Header(Some(data)) => attributes.header = Some(data.to_vec()),
            AttributeValue::BodySection {
                section: None,
                data: Some(data),
                ..
            }
            | AttributeValue::Rfc822(Some(data)) => attributes.body = Some(data.to_vec()),
            _ => {}
        }
    }
    Some(attributes)
}

/// Reads a summary from a `FETCH` answer of [`SUMMARY_QUERY`]; an answer
/// without a UID, such as a flag change the server reports on its own, is
/// skipped.
fn read_summary(response: &Response<'_>) -> Option<Summary> {
    let attributes = read_fetched_attributes(response)?;
    Some(Summary {
        uid: attributes.uid?,
        flags: attributes.flags,
        size: attributes.size,
        internal_date: attributes.internal_date.map(|date| date.to_rfc3339()),
        internal_timestamp: attributes.internal_date.map(|date| date.to_timestamp()),
        header: attributes.header.unwrap_or_default(),
    })
}

/// Reads a whole message from a `FETCH` answer of [`MESSAGE_QUERY`]; an
/// answer without a UID or the message is skipped.
fn read_fetched_message(response: &Response<'_>) -> Option<FetchedMessage> {
    let attributes = read_fetched_attributes(response)?;
    Some(FetchedMessage {
        uid: attributes.uid?,
        flags: attributes.flags,
        bytes: attributes.body?,
    })
}

/// Reads the system flags of a flag list, in any letter case.
fn read_flags(names: &[Cow<'_, str>]) -> Flags {
    let mut flags = Flags::default();
    for name in names {
        match name.to_ascii_lowercase().as_str() {
            "\\seen" => flags.seen = true,
            "\\answered" => flags.answered = true,
            "\\flagged" => flags.flagged = true,
            "\\draft" => flags.draft = true,
            "\\deleted" => flags.deleted = true,
            _ => {}
        }
    }
    flags
}

/// Parses an IMAP date-time, such as `02-Nov-2026 14:03:00 +0100`: the
/// `date-time` of RFC 3501 without its quotes.
///
/// # Returns
///
/// The date, or `None` when the text is not a date-time of a real day.
fn parse_internal_date(text: &str) -> Option<DateTime> {
    let fields: Vec<&str> = text.split_whitespace().collect();
    let [day, time, zone] = fields.as_slice() else {
        return None;
    };
    let day: Vec<&str> = day.split('-').collect();
    let time: Vec<&str> = time.split(':').collect();
    let ([day, month, year], [hour, minute, second]) = (day.as_slice(), time.as_slice()) else {
        return None;
    };
    let (sign, offset) = zone.split_at_checked(1)?;
    if !matches!(sign, "+" | "-") || offset.len() != 4 {
        return None;
    }
    let date = DateTime {
        year: year.parse().ok()?,
        month: parse_month_name(month)?,
        day: day.parse().ok()?,
        hour: hour.parse().ok()?,
        minute: minute.parse().ok()?,
        second: second.parse().ok()?,
        tz_before_gmt: sign == "-",
        tz_hour: offset.get(..2)?.parse().ok()?,
        tz_minute: offset.get(2..)?.parse().ok()?,
    };
    is_calendar_date(&date).then_some(date)
}

/// Parses a month name as IMAP dates write it, in any letter case.
///
/// # Returns
///
/// The month, 1 to 12, or `None` for another text.
fn parse_month_name(text: &str) -> Option<u8> {
    let index = MONTH_NAMES
        .iter()
        .position(|name| name.eq_ignore_ascii_case(text))?;
    u8::try_from(index + 1).ok()
}

/// Whether a date's fields are in range and name a day the calendar has,
/// so that 31 November is not one.
fn is_calendar_date(date: &DateTime) -> bool {
    if !date.is_valid() {
        return false;
    }
    let normalized = DateTime::from_timestamp(date.to_timestamp_local());
    (normalized.year, normalized.month, normalized.day) == (date.year, date.month, date.day)
}

/// Formats a `LIST` attribute as the protocol writes it.
fn format_attribute(attribute: &NameAttribute<'_>) -> String {
    match attribute {
        NameAttribute::NoInferiors => "\\Noinferiors".to_owned(),
        NameAttribute::NoSelect => "\\Noselect".to_owned(),
        NameAttribute::Marked => "\\Marked".to_owned(),
        NameAttribute::Unmarked => "\\Unmarked".to_owned(),
        NameAttribute::All => "\\All".to_owned(),
        NameAttribute::Archive => "\\Archive".to_owned(),
        NameAttribute::Drafts => "\\Drafts".to_owned(),
        NameAttribute::Flagged => "\\Flagged".to_owned(),
        NameAttribute::Junk => "\\Junk".to_owned(),
        NameAttribute::Sent => "\\Sent".to_owned(),
        NameAttribute::Trash => "\\Trash".to_owned(),
        NameAttribute::Extension(text) => text.to_string(),
        _ => "\\Unknown".to_owned(),
    }
}

/// Formats UIDs as one `UID FETCH` set.
fn format_uid_set(uids: &[u32]) -> String {
    uids.iter()
        .map(u32::to_string)
        .collect::<Vec<String>>()
        .join(",")
}

/// Formats a text for a search key.
///
/// # Arguments
///
/// * `text` - The text to search for, without line breaks.
///
/// # Returns
///
/// A quoted string for ASCII text, and a non-synchronizing literal
/// (`{n+}`, RFC 7888) for other text. A server without LITERAL+ answers
/// such a search with `BAD`, and the search fails with the server's text.
pub fn format_search_text(text: &str) -> String {
    if text.is_ascii() {
        return format_quoted_string(text);
    }
    format!("{{{}+}}\r\n{}", text.len(), text)
}

/// Formats a calendar date as a search key writes it.
///
/// # Arguments
///
/// * `year` - The year, four digits.
/// * `month` - The month, 1 to 12.
/// * `day` - The day of the month, 1 to 31.
///
/// # Returns
///
/// The date as `D-Mon-YYYY`.
pub fn format_search_date(year: u16, month: u8, day: u8) -> String {
    let month_name = MONTH_NAMES[usize::from(month.clamp(1, 12)) - 1];
    format!("{day}-{month_name}-{year:04}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_flags_search_texts_dates_and_uid_sets() {
        assert_eq!(Flags::default().format(), "unread");
        assert_eq!(
            Flags {
                seen: true,
                answered: true,
                flagged: true,
                draft: false,
                deleted: false
            }
            .format(),
            "read, answered, flagged"
        );
        assert_eq!(format_search_text("plain"), "\"plain\"");
        assert_eq!(
            format_search_text("say \"hi\" \\ bye"),
            "\"say \\\"hi\\\" \\\\ bye\""
        );
        assert_eq!(format_search_text("Grüße"), "{7+}\r\nGrüße");
        assert_eq!(format_search_date(2026, 11, 2), "2-Nov-2026");
        assert_eq!(format_search_date(2026, 1, 31), "31-Jan-2026");
        assert_eq!(format_uid_set(&[3, 1, 2]), "3,1,2");
    }

    #[test]
    fn classifies_sign_in_errors_by_kind() {
        assert_eq!(
            calculate_sign_in_failure(&ImapError::No("AUTHENTICATIONFAILED".to_owned())),
            SignInFailure::WrongPassword
        );
        assert_eq!(
            calculate_sign_in_failure(&ImapError::Io(io::Error::from(io::ErrorKind::TimedOut))),
            SignInFailure::TimedOut
        );
        assert_eq!(
            calculate_sign_in_failure(&ImapError::Io(io::Error::from(
                io::ErrorKind::UnexpectedEof
            ))),
            SignInFailure::ProtocolError
        );
    }

    /// The outcome the tagged line ends the command `A1` with, parsed as
    /// the session reads it.
    fn calculate_line_outcome(line: &[u8]) -> Option<Result<(), ImapFailure>> {
        let (_, response) = Response::parse(line).expect("an IMAP response");
        calculate_tagged_outcome(&response, &RequestId("A1".to_owned()))
    }

    #[test]
    fn ends_a_command_only_at_its_own_tagged_status() {
        assert_eq!(calculate_line_outcome(b"A1 OK Done\r\n"), Some(Ok(())));
        assert_eq!(calculate_line_outcome(b"A2 NO Other command\r\n"), None);
        assert_eq!(calculate_line_outcome(b"* NO A warning\r\n"), None);
        assert_eq!(calculate_line_outcome(b"* SEARCH 1 2\r\n"), None);
        assert_eq!(
            calculate_line_outcome(b"A1 BAD Syntax error\r\n"),
            Some(Err(ImapFailure::Refused("Syntax error".to_owned())))
        );
    }

    #[test]
    fn passes_on_the_code_and_text_of_a_refusal() {
        let cases: [(&[u8], &str); 6] = [
            (
                b"A1 NO [BADCHARSET (US-ASCII UTF-7)] Unsupported charset\r\n",
                "[BADCHARSET (US-ASCII UTF-7)] Unsupported charset",
            ),
            (
                b"A1 NO [BADCHARSET] No charset\r\n",
                "[BADCHARSET] No charset",
            ),
            (
                b"A1 NO [READ-ONLY] Mailbox is read-only\r\n",
                "[READ-ONLY] Mailbox is read-only",
            ),
            (
                b"A1 NO [OVERQUOTA] Quota exceeded\r\n",
                "[OVERQUOTA] Quota exceeded",
            ),
            (b"A1 NO [TRYCREATE]\r\n", "[TRYCREATE]"),
            (b"A1 NO\r\n", "no reason given"),
        ];
        for (line, text) in cases {
            assert_eq!(
                calculate_line_outcome(line),
                Some(Err(ImapFailure::Refused(text.to_owned()))),
                "{}",
                String::from_utf8_lossy(line)
            );
        }
    }

    #[test]
    fn cuts_a_refusal_text_after_its_limit() {
        let at_limit = "é".repeat(REFUSAL_TEXT_LIMIT);
        let over_limit = "é".repeat(REFUSAL_TEXT_LIMIT + 1);
        let outcome = |text: &str| Outcome {
            code: None,
            information: Some(Cow::Owned(text.to_owned())),
        };

        assert_eq!(format_refusal_text(&outcome(&at_limit)), at_limit);
        assert_eq!(
            format_refusal_text(&outcome(&over_limit)),
            format!("{at_limit}…")
        );
    }

    #[test]
    fn reads_flags_in_any_letter_case() {
        let names = [
            Cow::Borrowed("\\SEEN"),
            Cow::Borrowed("\\draft"),
            Cow::Borrowed("\\Deleted"),
            Cow::Borrowed("$Forwarded"),
        ];

        assert_eq!(
            read_flags(&names),
            Flags {
                seen: true,
                answered: false,
                flagged: false,
                draft: true,
                deleted: true
            }
        );
    }

    #[test]
    fn parses_internal_dates_with_their_zone() {
        let date = parse_internal_date("02-Nov-2026 14:03:00 +0100").expect("a date");
        let early = parse_internal_date(" 2-Nov-2026 09:00:00 -0500").expect("a date");

        assert_eq!(date.to_rfc3339(), "2026-11-02T14:03:00+01:00");
        assert_eq!(date.to_timestamp(), 1_793_624_580);
        assert_eq!(early.to_rfc3339(), "2026-11-02T09:00:00-05:00");
        assert_eq!(early.to_timestamp(), 1_793_628_000);
        assert_eq!(parse_internal_date("yesterday"), None);
        assert_eq!(parse_internal_date("02-Foo-2026 10:00:00 +0000"), None);
        assert_eq!(parse_internal_date("31-Nov-2026 10:00:00 +0000"), None);
        assert_eq!(parse_internal_date("02-Nov-2026 24:00:00 +0000"), None);
        assert_eq!(parse_internal_date("02-Nov-2026 10:00:00 0000"), None);
        assert_eq!(parse_internal_date("02-Nov-2026 10:00:00 +0é0"), None);
    }

    #[test]
    fn quotes_folder_names_and_refuses_line_breaks() {
        assert_eq!(
            quote_folder_name("Projects/\"2026\" \\ old"),
            Ok("\"Projects/\\\"2026\\\" \\\\ old\"".to_owned())
        );
        assert_eq!(quote_folder_name("Bad\r\nName"), Err(UNREADABLE));
    }

    #[test]
    fn reads_the_facts_of_a_selection() {
        let facts = [
            SelectionFact::Exists(3),
            SelectionFact::UidValidity(7),
            SelectionFact::Exists(4),
        ];

        assert_eq!(
            build_selected_folder(&facts),
            Ok(SelectedFolder {
                uid_validity: 7,
                exists: 4
            })
        );
        assert_eq!(
            build_selected_folder(&[SelectionFact::Exists(3)]),
            Err(UNREADABLE)
        );
    }
}
