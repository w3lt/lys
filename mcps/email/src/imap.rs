//! IMAP connections: one per tool call, signed in and bounded by time
//! limits.
//!
//! [`open_imap_session`] connects, protects the connection as the account
//! says, reads the greeting, signs in, and gives an [`ImapSession`] whose
//! every command answers within [`EXCHANGE_LIMIT`] or fails. The session
//! is closed with [`ImapSession::close`], which logs out; dropping it
//! closes the socket either way. A command that ends in a time limit or a
//! lost connection leaves the session unusable, and the tools never reuse
//! one.
//!
//! Folder names given to commands are the server's own (modified UTF-7);
//! [`crate::folder_name`] converts them.

use std::fmt;
use std::io;
use std::time::Duration;

use async_imap::error::Error as ImapError;
use async_imap::types::{Fetch, Flag, Name, NameAttribute};
use async_imap::{Client, Session};
use futures_util::StreamExt;
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::net::TcpStream;
use tokio::time::{error::Elapsed, timeout};
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

/// A stream an IMAP session runs over: TCP, or TLS over TCP.
pub trait AsyncStream: AsyncRead + AsyncWrite + Unpin + Send + fmt::Debug {}

impl<T: AsyncRead + AsyncWrite + Unpin + Send + fmt::Debug> AsyncStream for T {}

/// The stream of a signed-in session.
type Stream = Box<dyn AsyncStream>;

/// Why a command on a signed-in session did not complete.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ImapFailure {
    /// The server refused the command with its own text (`NO` or `BAD`).
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
        build_command_result(
            timeout(EXCHANGE_LIMIT, async {
                let mut names = self.session.list(Some(""), Some("*")).await?;
                let mut listings = Vec::new();
                while let Some(name) = names.next().await {
                    listings.push(build_listing(&name?));
                }
                Ok(listings)
            })
            .await,
        )
    }

    /// Counts the messages of a folder without selecting it.
    ///
    /// # Arguments
    ///
    /// * `raw_name` - The folder's name as the server wrote it.
    pub async fn get_message_count(&mut self, raw_name: &str) -> Result<u32, ImapFailure> {
        build_command_result(
            timeout(EXCHANGE_LIMIT, self.session.status(raw_name, "(MESSAGES)")).await,
        )
        .map(|mailbox| mailbox.exists)
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
        let mailbox = build_command_result(
            timeout(EXCHANGE_LIMIT, async {
                match access {
                    FolderAccess::Read => self.session.examine(raw_name).await,
                    FolderAccess::Change => self.session.select(raw_name).await,
                }
            })
            .await,
        )?;
        let uid_validity = mailbox
            .uid_validity
            .ok_or(ImapFailure::Connection(ConnectionFailure::Unreadable))?;
        Ok(SelectedFolder {
            uid_validity,
            exists: mailbox.exists,
        })
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
        let uids =
            build_command_result(timeout(EXCHANGE_LIMIT, self.session.uid_search(criteria)).await)?;
        let mut uids: Vec<u32> = uids.into_iter().collect();
        uids.sort_unstable_by(|left, right| right.cmp(left));
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
        let set = format_uid_set(uids);
        build_command_result(
            timeout(EXCHANGE_LIMIT, async {
                let mut fetches = self.session.uid_fetch(&set, SUMMARY_QUERY).await?;
                let mut summaries = Vec::new();
                while let Some(fetch) = fetches.next().await {
                    if let Some(summary) = build_summary(&fetch?) {
                        summaries.push(summary);
                    }
                }
                Ok(summaries)
            })
            .await,
        )
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
        build_command_result(
            timeout(EXCHANGE_LIMIT, async {
                let mut fetches = self
                    .session
                    .uid_fetch(uid.to_string(), MESSAGE_QUERY)
                    .await?;
                let mut message = None;
                while let Some(fetch) = fetches.next().await {
                    let fetch = fetch?;
                    if fetch.uid == Some(uid)
                        && let Some(body) = fetch.body()
                    {
                        message = Some(FetchedMessage {
                            uid,
                            flags: read_flags(&fetch),
                            bytes: body.to_vec(),
                        });
                    }
                }
                Ok(message)
            })
            .await,
        )
    }

    /// Appends a message to a folder.
    ///
    /// # Arguments
    ///
    /// * `raw_name` - The folder's name as the server wrote it.
    /// * `flags` - The flag list, such as `(\Seen)`.
    /// * `bytes` - The message (RFC 5322).
    pub async fn save_message(
        &mut self,
        raw_name: &str,
        flags: &str,
        bytes: &[u8],
    ) -> Result<(), ImapFailure> {
        build_command_result(
            timeout(
                EXCHANGE_LIMIT,
                self.session.append(raw_name, Some(flags), None, bytes),
            )
            .await,
        )
    }

    /// Deletes one message of the selected folder: marks it `\Deleted`
    /// and expunges it, by UID when the server supports UIDPLUS and with
    /// the folder's `EXPUNGE` otherwise, which also removes other messages
    /// already marked `\Deleted`.
    ///
    /// # Arguments
    ///
    /// * `uid` - The message's UID.
    pub async fn delete_message(&mut self, uid: u32) -> Result<(), ImapFailure> {
        let supports_uid_plus = self.find_uid_plus().await?;
        let set = uid.to_string();
        build_command_result(
            timeout(EXCHANGE_LIMIT, async {
                let mut stored = self
                    .session
                    .uid_store(&set, "+FLAGS.SILENT (\\Deleted)")
                    .await?;
                while let Some(fetch) = stored.next().await {
                    fetch?;
                }
                Ok(())
            })
            .await,
        )?;
        build_command_result(
            timeout(EXCHANGE_LIMIT, async {
                if supports_uid_plus {
                    let mut expunged = Box::pin(self.session.uid_expunge(&set).await?);
                    while let Some(item) = expunged.next().await {
                        item?;
                    }
                } else {
                    let mut expunged = Box::pin(self.session.expunge().await?);
                    while let Some(item) = expunged.next().await {
                        item?;
                    }
                }
                Ok(())
            })
            .await,
        )
    }

    /// Creates a folder.
    ///
    /// # Arguments
    ///
    /// * `raw_name` - The new folder's name as the server expects it.
    pub async fn create_folder(&mut self, raw_name: &str) -> Result<(), ImapFailure> {
        build_command_result(timeout(EXCHANGE_LIMIT, self.session.create(raw_name)).await)
    }

    /// Deletes a folder.
    ///
    /// # Arguments
    ///
    /// * `raw_name` - The folder's name as the server wrote it.
    pub async fn delete_folder(&mut self, raw_name: &str) -> Result<(), ImapFailure> {
        build_command_result(timeout(EXCHANGE_LIMIT, self.session.delete(raw_name)).await)
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
        build_command_result(
            timeout(EXCHANGE_LIMIT, self.session.rename(raw_name, new_raw_name)).await,
        )
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

    /// Asks the server once whether it supports UIDPLUS.
    async fn find_uid_plus(&mut self) -> Result<bool, ImapFailure> {
        if let Some(supported) = self.supports_uid_plus {
            return Ok(supported);
        }
        let capabilities =
            build_command_result(timeout(EXCHANGE_LIMIT, self.session.capabilities()).await)?;
        let supported = capabilities.has_str("UIDPLUS");
        self.supports_uid_plus = Some(supported);
        Ok(supported)
    }
}

/// Turns a timed command's outcome into the session's contract.
fn build_command_result<T>(
    outcome: Result<Result<T, ImapError>, Elapsed>,
) -> Result<T, ImapFailure> {
    match outcome {
        Ok(Ok(value)) => Ok(value),
        Ok(Err(error)) => Err(calculate_command_failure(error)),
        Err(_) => Err(ImapFailure::Connection(ConnectionFailure::TimedOut)),
    }
}

/// Classifies a protocol error met by a command of a signed-in session.
fn calculate_command_failure(error: ImapError) -> ImapFailure {
    match error {
        ImapError::No(text) | ImapError::Bad(text) => ImapFailure::Refused(text),
        ImapError::Append => {
            ImapFailure::Refused("the server did not accept the message".to_owned())
        }
        ImapError::Io(_) | ImapError::ConnectionLost => {
            ImapFailure::Connection(ConnectionFailure::Lost)
        }
        ImapError::Parse(_) | ImapError::Validate(_) => {
            ImapFailure::Connection(ConnectionFailure::Unreadable)
        }
        _ => ImapFailure::Connection(ConnectionFailure::Unreadable),
    }
}

/// Builds a folder listing from a `LIST` response.
fn build_listing(name: &Name) -> FolderListing {
    FolderListing {
        raw_name: name.name().to_owned(),
        attributes: name.attributes().iter().map(format_attribute).collect(),
        delimiter: name.delimiter().map(str::to_owned),
    }
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

/// Builds a summary from a `FETCH` response of [`SUMMARY_QUERY`].
fn build_summary(fetch: &Fetch) -> Option<Summary> {
    let uid = fetch.uid?;
    let internal_date = fetch.internal_date();
    Some(Summary {
        uid,
        flags: read_flags(fetch),
        size: fetch.size,
        internal_date: internal_date.map(|date| date.to_rfc3339()),
        internal_timestamp: internal_date.map(|date| date.timestamp()),
        header: fetch.header().map(<[u8]>::to_vec).unwrap_or_default(),
    })
}

/// Reads the system flags of a `FETCH` response.
fn read_flags(fetch: &Fetch) -> Flags {
    let mut flags = Flags::default();
    for flag in fetch.flags() {
        match flag {
            Flag::Seen => flags.seen = true,
            Flag::Answered => flags.answered = true,
            Flag::Flagged => flags.flagged = true,
            Flag::Draft => flags.draft = true,
            Flag::Deleted => flags.deleted = true,
            Flag::Recent | Flag::MayCreate | Flag::Custom(_) => {}
        }
    }
    flags
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
/// (`{n+}`, RFC 7888) for other text, which servers without LITERAL+
/// refuse; the search then fails with the server's text.
pub fn format_search_text(text: &str) -> String {
    if text.is_ascii() {
        let escaped = text.replace('\\', "\\\\").replace('"', "\\\"");
        return format!("\"{escaped}\"");
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
    fn classifies_command_errors_by_kind() {
        assert_eq!(
            calculate_command_failure(ImapError::No("Unknown mailbox".to_owned())),
            ImapFailure::Refused("Unknown mailbox".to_owned())
        );
        assert_eq!(
            calculate_command_failure(ImapError::ConnectionLost),
            ImapFailure::Connection(ConnectionFailure::Lost)
        );
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
}
