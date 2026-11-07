//! SMTP sessions over lettre's connection, one per send or check, each
//! step bounded by its own time limit.
//!
//! `open_smtp_session` opens the TCP connection, protects it as the account
//! says, reads the greeting, says EHLO, and signs in. `SmtpSession` then
//! sends one message, with MAIL, each RCPT, DATA, and the message itself,
//! and says QUIT when it closes. The TCP connection and a TLS handshake
//! from the first byte take at most 15 seconds each. The greeting with
//! EHLO, STARTTLS with its handshake and the second EHLO, the sign-in with
//! its challenges, MAIL, each RCPT, DATA, and QUIT take at most 30 seconds
//! each, and the message with the server's answer to it at most 120
//! seconds. No limit covers a whole session: the deadline of the call it
//! serves does.
//!
//! A failed send is classed by how far it came, which a [`SendProgress`]
//! records. Until the end of the message was handed over, the server
//! delivers nothing: a connection that ends then cancels the transaction
//! (RFC 5321, section 3.8). After it, the server may have accepted the
//! message before its answer was lost, so a failure there, other than the
//! server refusing the message, leaves the send unconfirmed.

use std::error::Error;
use std::fmt;
use std::io;
use std::iter;
use std::net::SocketAddr;
use std::pin::Pin;
use std::sync::{Mutex, PoisonError};
use std::task::{Context, Poll};
use std::time::Duration;

use lettre::address::Envelope;
use lettre::transport::smtp::Error as SmtpError;
use lettre::transport::smtp::authentication::{Credentials, DEFAULT_MECHANISMS};
use lettre::transport::smtp::client::{AsyncSmtpConnection, AsyncTokioStream};
use lettre::transport::smtp::commands::{Data, Mail, Rcpt};
use lettre::transport::smtp::extension::{
    ClientId, Extension, MailBodyParameter, MailParameter, ServerInfo,
};
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio::net::TcpStream;
use tokio::time::timeout;
use tokio_rustls::client::TlsStream;

use crate::account::{Account, MailServer, Security};
use crate::failure::{ConnectionFailure, SignInFailure, SmtpExtension};
use crate::log::send_log_line;
use crate::network::{open_tcp_stream, open_tls_stream};
use crate::trust::{Trust, is_certificate_refusal};

/// Longest one exchange may take, from the command to the whole answer.
const EXCHANGE_LIMIT: Duration = Duration::from_secs(30);

/// Longest handing over a message's content and reading the server's
/// answer to it may take.
const MESSAGE_LIMIT: Duration = Duration::from_secs(120);

/// Reply codes that mean the credentials were refused: 535 (RFC 4954)
/// and 534, which Gmail answers when an app password is required.
const CREDENTIALS_REFUSED_CODES: [u16; 2] = [535, 534];

/// The text of lettre's error for a connection that ended before a whole
/// reply; lettre has no other way to tell that case apart from a reply it
/// cannot read.
const INCOMPLETE_REPLY_TEXT: &str = "incomplete response";

/// Why a send did not complete.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum SmtpFailure {
    /// Before the end of the message was handed over, the connection
    /// ended, the server's answer could not be read, or it did not come in
    /// time; nothing was sent.
    Connection(ConnectionFailure),
    /// The server refused the sender, a recipient, DATA, or the message,
    /// with a reply code and its text; nothing was sent.
    Refused {
        /// The reply code, such as 550.
        code: u16,
        /// The server's text.
        text: String,
    },
    /// The server does not offer an extension the message needs; nothing
    /// was sent.
    ExtensionMissing(SmtpExtension),
    /// The end of the message was handed over, but the server's answer was
    /// lost: the connection ended, the answer could not be read, or it did
    /// not come in time. The message may have been sent.
    Unconfirmed,
}

/// How far a send has come.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum SendStage {
    /// The end of the message has not been handed over, so whatever stops
    /// the send now, the server delivers nothing.
    #[default]
    NotHandedOver,
    /// The whole message was handed over and the server has not accepted
    /// it: unless its answer refuses the message, the server may deliver
    /// it.
    HandedOver,
    /// The server accepted the message.
    Accepted,
}

impl SendStage {
    /// Whether the whole message was handed over, so the server may have
    /// it.
    fn is_handed_over(self) -> bool {
        match self {
            Self::HandedOver | Self::Accepted => true,
            Self::NotHandedOver => false,
        }
    }
}

/// How far one send has come: moved forward by the send as it hands the
/// message over and the server accepts it, and read by the caller that may
/// stop the send, to tell whether the message may have gone out.
///
/// Concurrency model: serialized; the send moves the stage through one
/// shared reference while the caller holds another, and each access takes
/// the lock only to read or write the stage. The lock makes the progress
/// `Sync`, so that a send borrowing it can run on any thread. Resource
/// ownership: holds only the stage.
#[derive(Debug, Default)]
pub struct SendProgress {
    /// The stage the send has reached.
    stage: Mutex<SendStage>,
}

impl SendProgress {
    /// The stage the send has reached.
    pub fn stage(&self) -> SendStage {
        *self.stage.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Records the stage the send has reached.
    fn update_stage(&self, stage: SendStage) {
        *self.stage.lock().unwrap_or_else(PoisonError::into_inner) = stage;
    }
}

/// A signed-in SMTP session.
///
/// Concurrency model: single-owner; every step takes the session mutably,
/// and each call opens its own. Resource ownership: owns the connection;
/// [`Self::close`] says QUIT and closes it, and dropping the session closes
/// the socket without QUIT, which ends a transaction in progress.
pub(crate) struct SmtpSession {
    /// The connection, signed in.
    connection: AsyncSmtpConnection,
}

impl fmt::Debug for SmtpSession {
    /// Formats the session without its connection, which has no `Debug`.
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SmtpSession")
            .finish_non_exhaustive()
    }
}

/// A TLS stream in the form lettre's connection runs over, for SMTP
/// protected from the first byte.
///
/// lettre's connection takes a stream of its own trait, which lettre gives
/// only a TCP stream; this wrapper gives it a TLS stream by handing every
/// read, write, flush, and shutdown to the stream it wraps. Resource
/// ownership: owns the TLS stream, which closes with it. Concurrency model:
/// single-owner; the lettre connection that runs over it owns it, and one
/// task polls it.
#[derive(Debug)]
struct SmtpTlsStream(TlsStream<TcpStream>);

impl AsyncRead for SmtpTlsStream {
    /// Reads from the TLS stream.
    fn poll_read(
        mut self: Pin<&mut Self>,
        context: &mut Context<'_>,
        buffer: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        Pin::new(&mut self.0).poll_read(context, buffer)
    }
}

impl AsyncWrite for SmtpTlsStream {
    /// Writes to the TLS stream.
    fn poll_write(
        mut self: Pin<&mut Self>,
        context: &mut Context<'_>,
        bytes: &[u8],
    ) -> Poll<io::Result<usize>> {
        Pin::new(&mut self.0).poll_write(context, bytes)
    }

    /// Flushes the TLS stream.
    fn poll_flush(mut self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.0).poll_flush(context)
    }

    /// Shuts the TLS stream down, which sends its closing alert first.
    fn poll_shutdown(mut self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.0).poll_shutdown(context)
    }
}

impl AsyncTokioStream for SmtpTlsStream {
    /// Returns the address of the server that the TCP connection under the
    /// TLS stream is open to.
    fn peer_addr(&self) -> io::Result<SocketAddr> {
        self.0.get_ref().0.peer_addr()
    }
}

/// Connects to the account's SMTP server and signs in.
///
/// # Arguments
///
/// * `account` - The server, how the connection is protected, and the
///   user name and password to sign in with.
/// * `trust` - Which certificates are accepted.
///
/// # Returns
///
/// The signed-in session, or why signing in failed: the TCP connection was
/// not opened within 15 seconds; the TLS handshake failed, with the
/// certificate refused or otherwise, or took longer than 15 seconds from
/// the first byte; the server does not offer STARTTLS; the greeting with
/// EHLO, STARTTLS, or the sign-in took longer than [`EXCHANGE_LIMIT`]; the
/// credentials were refused; or the server refused a step, answered
/// something unreadable, or ended the connection.
pub(crate) async fn open_smtp_session(
    account: &Account,
    trust: &Trust,
) -> Result<SmtpSession, SignInFailure> {
    let server = &account.smtp;
    let stream = open_smtp_stream(server, trust).await?;
    let mut connection = start_smtp_dialogue(stream).await?;
    match server.security {
        Security::StartTls => start_tls(&mut connection, server, trust).await?,
        Security::Tls | Security::Plain => {}
    }
    send_sign_in(&mut connection, account).await?;
    Ok(SmtpSession { connection })
}

/// Opens the TCP connection, with a TLS stream over it when the account
/// protects the server from the first byte.
async fn open_smtp_stream(
    server: &MailServer,
    trust: &Trust,
) -> Result<Box<dyn AsyncTokioStream>, SignInFailure> {
    let tcp = open_tcp_stream(server).await?;
    match server.security {
        Security::Tls => Ok(Box::new(SmtpTlsStream(
            open_tls_stream(server, trust, tcp).await?,
        ))),
        Security::StartTls | Security::Plain => Ok(Box::new(tcp)),
    }
}

/// Reads the server's greeting and says EHLO, within [`EXCHANGE_LIMIT`].
async fn start_smtp_dialogue(
    stream: Box<dyn AsyncTokioStream>,
) -> Result<AsyncSmtpConnection, SignInFailure> {
    let client = ClientId::default();
    let dialogue = AsyncSmtpConnection::connect_with_transport(stream, &client);
    match timeout(EXCHANGE_LIMIT, dialogue).await {
        Ok(Ok(connection)) => Ok(connection),
        Ok(Err(error)) => Err(calculate_sign_in_failure(&error)),
        Err(_) => Err(SignInFailure::TimedOut),
    }
}

/// Upgrades the connection with STARTTLS, within [`EXCHANGE_LIMIT`] for
/// the command, the TLS handshake, and the second EHLO; a server whose
/// EHLO does not offer STARTTLS fails as `EncryptionNotOffered`.
async fn start_tls(
    connection: &mut AsyncSmtpConnection,
    server: &MailServer,
    trust: &Trust,
) -> Result<(), SignInFailure> {
    if !connection
        .server_info()
        .supports_feature(Extension::StartTls)
    {
        return Err(SignInFailure::EncryptionNotOffered);
    }
    let parameters = trust
        .build_smtp_parameters(server.server_name())
        .map_err(|error| {
            send_log_line(&format!(
                "smtp: the TLS configuration could not be built: {error}"
            ));
            SignInFailure::ProtocolError
        })?;
    let client = ClientId::default();
    let upgrade = connection.starttls(parameters, &client);
    match timeout(EXCHANGE_LIMIT, upgrade).await {
        Ok(Ok(())) => Ok(()),
        Ok(Err(error)) => Err(calculate_sign_in_failure(&error)),
        Err(_) => Err(SignInFailure::TimedOut),
    }
}

/// Sends the sign-in, with PLAIN or LOGIN, within [`EXCHANGE_LIMIT`] for
/// the command and its challenges.
async fn send_sign_in(
    connection: &mut AsyncSmtpConnection,
    account: &Account,
) -> Result<(), SignInFailure> {
    let credentials = Credentials::new(
        account.user_name.clone(),
        account.password.as_str().to_owned(),
    );
    let exchange = connection.auth(DEFAULT_MECHANISMS, &credentials);
    match timeout(EXCHANGE_LIMIT, exchange).await {
        Ok(Ok(_)) => Ok(()),
        Ok(Err(error)) if is_credentials_refusal(&error) => Err(SignInFailure::WrongPassword),
        Ok(Err(error)) => Err(calculate_sign_in_failure(&error)),
        Err(_) => Err(SignInFailure::TimedOut),
    }
}

/// Whether the server refused the credentials: a permanent reply with one
/// of [`CREDENTIALS_REFUSED_CODES`].
fn is_credentials_refusal(error: &SmtpError) -> bool {
    error.is_permanent()
        && error
            .status()
            .is_some_and(|code| CREDENTIALS_REFUSED_CODES.contains(&u16::from(code)))
}

/// Classifies lettre's error met before the session was signed in.
///
/// A timeout of the operating system is `TimedOut`, and a refused
/// certificate `CertificateRefused` wherever lettre files it, as it files
/// a failed STARTTLS handshake as a connection failure. Any other failure
/// is `ProtocolError`, as the server answered the TCP connection: a reply
/// refusing the step, a failed TLS handshake, an unreadable answer, an
/// ended connection, or no sign-in mechanism Lys knows.
fn calculate_sign_in_failure(error: &SmtpError) -> SignInFailure {
    if error.is_timeout() {
        SignInFailure::TimedOut
    } else if is_certificate_refusal(error) {
        SignInFailure::CertificateRefused
    } else {
        SignInFailure::ProtocolError
    }
}

impl SmtpSession {
    /// Sends one message: MAIL, each RCPT, and DATA, each within
    /// [`EXCHANGE_LIMIT`], then the message and the server's answer to it,
    /// within [`MESSAGE_LIMIT`].
    ///
    /// After any failure the session is not used again: the caller drops
    /// it, which ends the transaction.
    ///
    /// # Arguments
    ///
    /// * `envelope` - The sender and the recipients.
    /// * `bytes` - The message (RFC 5322), without its `Bcc` field.
    /// * `progress` - Moved to `HandedOver` before the line that ends the
    ///   message is written, and to `Accepted` once the server accepts it.
    ///
    /// # Returns
    ///
    /// Nothing once the server accepted the message, or why it did not.
    pub(crate) async fn send_message(
        &mut self,
        envelope: &Envelope,
        bytes: &[u8],
        progress: &SendProgress,
    ) -> Result<(), SmtpFailure> {
        let parameters = build_mail_parameters(self.connection.server_info(), envelope, bytes)
            .map_err(SmtpFailure::ExtensionMissing)?;
        self.send_command(Mail::new(envelope.from().cloned(), parameters))
            .await?;
        for recipient in envelope.to() {
            self.send_command(Rcpt::new(recipient.clone(), Vec::new()))
                .await?;
        }
        self.send_command(Data).await?;
        self.send_message_data(bytes, progress).await
    }

    /// Ends the session: says QUIT within [`EXCHANGE_LIMIT`] and closes the
    /// connection. A failed or unanswered QUIT is logged and otherwise
    /// ignored, as the socket closes either way.
    pub(crate) async fn close(mut self) {
        match timeout(EXCHANGE_LIMIT, self.connection.quit()).await {
            Ok(Ok(_)) => {}
            Ok(Err(_)) => send_log_line("smtp: quit failed"),
            Err(_) => send_log_line("smtp: quit timed out"),
        }
    }

    /// Sends one command of the transaction within [`EXCHANGE_LIMIT`].
    async fn send_command<C: fmt::Display>(&mut self, command: C) -> Result<(), SmtpFailure> {
        match timeout(EXCHANGE_LIMIT, self.connection.command(command)).await {
            Ok(Ok(_)) => Ok(()),
            Ok(Err(error)) => Err(calculate_exchange_failure(&error)),
            Err(_) => Err(SmtpFailure::Connection(ConnectionFailure::TimedOut)),
        }
    }

    /// Sends the message's data, handing the message over, and reads the
    /// server's answer, within [`MESSAGE_LIMIT`].
    ///
    /// lettre writes each part of the message it is given and asks for the
    /// next before it writes the line that ends the data. That question
    /// moves the progress to `HandedOver`, so the stage never shows less
    /// than the server may have received.
    async fn send_message_data(
        &mut self,
        bytes: &[u8],
        progress: &SendProgress,
    ) -> Result<(), SmtpFailure> {
        let content = iter::once(bytes).chain(iter::from_fn(|| {
            progress.update_stage(SendStage::HandedOver);
            None
        }));
        let answer = timeout(MESSAGE_LIMIT, self.connection.message_iter(content)).await;
        let handed_over = progress.stage().is_handed_over();
        match answer {
            Ok(Ok(_)) => {
                progress.update_stage(SendStage::Accepted);
                Ok(())
            }
            Ok(Err(error)) if error.status().is_some() || !handed_over => {
                Err(calculate_exchange_failure(&error))
            }
            Ok(Err(_)) => Err(SmtpFailure::Unconfirmed),
            Err(_) if handed_over => Err(SmtpFailure::Unconfirmed),
            Err(_) => Err(SmtpFailure::Connection(ConnectionFailure::TimedOut)),
        }
    }
}

/// Builds the parameters of MAIL that the message needs: SMTPUTF8 for an
/// address beyond ASCII and 8BITMIME for bytes beyond ASCII, each only
/// when the server offers it, as RFC 6531 and RFC 6152 require.
///
/// # Arguments
///
/// * `server_info` - What the server's EHLO offered.
/// * `envelope` - The sender and the recipients.
/// * `bytes` - The message.
///
/// # Returns
///
/// The parameters, or the extension the message needs and the server does
/// not offer.
fn build_mail_parameters(
    server_info: &ServerInfo,
    envelope: &Envelope,
    bytes: &[u8],
) -> Result<Vec<MailParameter>, SmtpExtension> {
    let mut parameters = Vec::new();
    if !is_ascii_envelope(envelope) {
        if !server_info.supports_feature(Extension::SmtpUtfEight) {
            return Err(SmtpExtension::SmtpUtf8);
        }
        parameters.push(MailParameter::SmtpUtfEight);
    }
    if !bytes.is_ascii() {
        if !server_info.supports_feature(Extension::EightBitMime) {
            return Err(SmtpExtension::EightBitMime);
        }
        parameters.push(MailParameter::Body(MailBodyParameter::EightBitMime));
    }
    Ok(parameters)
}

/// Whether every address of the envelope is ASCII.
fn is_ascii_envelope(envelope: &Envelope) -> bool {
    envelope
        .from()
        .into_iter()
        .chain(envelope.to())
        .all(|address| address.user().is_ascii() && address.domain().is_ascii())
}

/// Classifies lettre's error met by a step after the sign-in: a reply that
/// refuses the step is `Refused`, and anything else a failure of the
/// connection.
fn calculate_exchange_failure(error: &SmtpError) -> SmtpFailure {
    match error.status() {
        Some(code) => SmtpFailure::Refused {
            code: u16::from(code),
            text: build_source_text(error),
        },
        None => SmtpFailure::Connection(calculate_connection_failure(error)),
    }
}

/// Classifies lettre's error that carries no reply: a timeout of the
/// operating system is `TimedOut`, and a reply lettre cannot read is
/// `Unreadable`, except a reply that the end of the connection cut short,
/// which is `Lost`, as is any failure of the network.
fn calculate_connection_failure(error: &SmtpError) -> ConnectionFailure {
    if error.is_timeout() {
        ConnectionFailure::TimedOut
    } else if error.is_response() && build_source_text(error) != INCOMPLETE_REPLY_TEXT {
        ConnectionFailure::Unreadable
    } else {
        ConnectionFailure::Lost
    }
}

/// Builds the text of the cause of lettre's error: the server's reply, or
/// lettre's own words.
fn build_source_text(error: &SmtpError) -> String {
    error
        .source()
        .map_or_else(|| error.to_string(), ToString::to_string)
}

#[cfg(test)]
mod tests {
    use lettre::Address;
    use lettre::transport::smtp::response::Response;

    use super::*;

    /// What an EHLO answer offering the extensions, one per line, tells.
    fn build_server_info(extensions: &[&str]) -> ServerInfo {
        let mut answer = String::from("250-localhost Hello\r\n");
        for extension in extensions {
            answer.push_str(&format!("250-{extension}\r\n"));
        }
        answer.push_str("250 HELP\r\n");
        let reply: Response = answer.parse().expect("a reply");
        ServerInfo::from_response(&reply).expect("the server's offer")
    }

    /// An envelope from the sender to the recipient.
    fn build_envelope(sender: &str, recipient: &str) -> Envelope {
        let sender: Address = sender.parse().expect("an address");
        let recipient: Address = recipient.parse().expect("an address");
        Envelope::new(Some(sender), vec![recipient]).expect("an envelope")
    }

    #[test]
    fn asks_for_each_extension_a_message_needs_only_from_a_server_that_offers_it() {
        let neither = build_server_info(&[]);
        let both = build_server_info(&["SMTPUTF8", "8BITMIME"]);
        let ascii = build_envelope("person@example.com", "jane@example.com");
        let from_beyond = build_envelope("jöran@example.com", "jane@example.com");
        let to_beyond = build_envelope("person@example.com", "jane@bücher.example");
        let eight_bit = "Grüße".as_bytes();

        assert_eq!(
            build_mail_parameters(&neither, &ascii, b"Hello"),
            Ok(Vec::new())
        );
        assert_eq!(
            build_mail_parameters(&neither, &from_beyond, b"Hello"),
            Err(SmtpExtension::SmtpUtf8)
        );
        assert_eq!(
            build_mail_parameters(&neither, &to_beyond, b"Hello"),
            Err(SmtpExtension::SmtpUtf8)
        );
        assert_eq!(
            build_mail_parameters(&neither, &ascii, eight_bit),
            Err(SmtpExtension::EightBitMime)
        );
        assert_eq!(
            build_mail_parameters(&both, &ascii, b"Hello"),
            Ok(Vec::new())
        );
        assert_eq!(
            build_mail_parameters(&both, &to_beyond, eight_bit),
            Ok(vec![
                MailParameter::SmtpUtfEight,
                MailParameter::Body(MailBodyParameter::EightBitMime)
            ])
        );
    }
}
