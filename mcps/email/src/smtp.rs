//! SMTP connections through lettre: one per send, bounded by time limits.
//!
//! [`build_smtp_transport`] prepares a transport that opens a fresh
//! connection for every send and closes it afterwards; nothing is pooled.
//! Every read and write waits at most [`EXCHANGE_LIMIT`], and a whole send
//! at most [`SEND_LIMIT`]. A send that reaches its limit is unconfirmed:
//! the message may have been accepted before the answer was lost.

use std::error::Error;
use std::time::Duration;

use lettre::address::Envelope;
use lettre::transport::smtp::Error as SmtpError;
use lettre::transport::smtp::authentication::Credentials;
use lettre::transport::smtp::client::Tls;
use lettre::{AsyncSmtpTransport, AsyncTransport, Tokio1Executor};
use tokio::time::timeout;

use crate::account::{Account, Security};
use crate::failure::SignInFailure;
use crate::trust::{Trust, is_certificate_refusal};

/// Longest one read or write of the connection may wait.
pub const EXCHANGE_LIMIT: Duration = Duration::from_secs(30);

/// Longest one send may take as a whole: connecting, STARTTLS, signing
/// in, and handing over the message.
pub const SEND_LIMIT: Duration = Duration::from_secs(120);

/// Reply codes that mean the credentials were refused: 535 (RFC 4954)
/// and 534, which Gmail answers when an app password is required.
const CREDENTIALS_REFUSED_CODES: [u16; 2] = [535, 534];

/// The text lettre gives its client-side error when the server does not
/// offer STARTTLS; lettre has no other way to tell that case apart.
const STARTTLS_MISSING_TEXT: &str = "STARTTLS is not supported on this server";

/// The transport the server sends through.
pub type SmtpTransport = AsyncSmtpTransport<Tokio1Executor>;

/// Why a send did not complete.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SmtpFailure {
    /// Connecting or signing in failed.
    SignIn(SignInFailure),
    /// The server refused the message with a reply code and its text.
    Refused {
        /// The reply code, such as 550.
        code: u16,
        /// The server's text.
        text: String,
    },
    /// The send reached a time limit; the message may have been accepted.
    Unconfirmed,
}

/// Builds the transport for the account.
///
/// # Arguments
///
/// * `account` - The account and its SMTP server.
/// * `trust` - Which certificates are accepted.
///
/// # Returns
///
/// The transport, or `ProtocolError` when the TLS parameters cannot be
/// built, which no account can cause.
pub fn build_smtp_transport(
    account: &Account,
    trust: &Trust,
) -> Result<SmtpTransport, SignInFailure> {
    let server = &account.smtp;
    let tls = match server.security {
        Security::Tls => Tls::Wrapper(build_parameters(trust, server.server_name())?),
        Security::StartTls => Tls::Required(build_parameters(trust, server.server_name())?),
        Security::Plain => Tls::None,
    };
    Ok(
        AsyncSmtpTransport::<Tokio1Executor>::builder_dangerous(server.server_name())
            .port(server.port)
            .tls(tls)
            .credentials(Credentials::new(
                account.user_name.clone(),
                account.password.as_str().to_owned(),
            ))
            .timeout(Some(EXCHANGE_LIMIT))
            .build(),
    )
}

/// Builds the TLS parameters, logging a failure's cause.
fn build_parameters(
    trust: &Trust,
    server_name: &str,
) -> Result<lettre::transport::smtp::client::TlsParameters, SignInFailure> {
    trust.build_smtp_parameters(server_name).map_err(|error| {
        crate::log::send_log_line(&format!(
            "smtp: the TLS configuration could not be built: {error}"
        ));
        SignInFailure::ProtocolError
    })
}

/// Connects, signs in, and disconnects, to check the account.
///
/// # Arguments
///
/// * `transport` - The transport to check.
/// * `limit` - Longest the whole check may take.
pub async fn offer_transport_sign_in(
    transport: &SmtpTransport,
    limit: Duration,
) -> Result<(), SignInFailure> {
    match timeout(limit, transport.test_connection()).await {
        Ok(Ok(true)) => Ok(()),
        Ok(Ok(false)) => Err(SignInFailure::ProtocolError),
        Ok(Err(error)) => Err(calculate_sign_in_failure(&error)),
        Err(_) => Err(SignInFailure::TimedOut),
    }
}

/// Sends one message.
///
/// # Arguments
///
/// * `transport` - The transport to send through.
/// * `envelope` - The sender and the recipients.
/// * `bytes` - The message (RFC 5322), without its `Bcc` field.
pub async fn send_message(
    transport: &SmtpTransport,
    envelope: &Envelope,
    bytes: &[u8],
) -> Result<(), SmtpFailure> {
    match timeout(SEND_LIMIT, transport.send_raw(envelope, bytes)).await {
        Ok(Ok(_)) => Ok(()),
        Ok(Err(error)) => Err(calculate_send_failure(&error)),
        Err(_) => Err(SmtpFailure::Unconfirmed),
    }
}

/// Classifies lettre's error as a sign-in failure.
///
/// A timeout of the connection is `TimedOut`; a permanent reply with a
/// credentials code is `WrongPassword`; a refused certificate is
/// `CertificateRefused` wherever lettre files it, as a STARTTLS handshake
/// failure is filed as a connection failure; any other reply, TLS
/// failure, client-side failure, or unreadable answer is `ProtocolError`,
/// except the client-side failure for a server without STARTTLS, which is
/// `EncryptionNotOffered`; a connection that could not be opened is
/// `Unreachable`.
fn calculate_sign_in_failure(error: &SmtpError) -> SignInFailure {
    if error.is_timeout() {
        return SignInFailure::TimedOut;
    }
    if let Some(code) = error.status() {
        return if error.is_permanent() && CREDENTIALS_REFUSED_CODES.contains(&u16::from(code)) {
            SignInFailure::WrongPassword
        } else {
            SignInFailure::ProtocolError
        };
    }
    if is_certificate_refusal(error) {
        return SignInFailure::CertificateRefused;
    }
    if error.is_tls() {
        return SignInFailure::ProtocolError;
    }
    if error.is_client() {
        return if format_source(error).contains(STARTTLS_MISSING_TEXT) {
            SignInFailure::EncryptionNotOffered
        } else {
            SignInFailure::ProtocolError
        };
    }
    if error.is_response() || error.is_transport_shutdown() {
        return SignInFailure::ProtocolError;
    }
    SignInFailure::Unreachable
}

/// Classifies lettre's error met while sending.
fn calculate_send_failure(error: &SmtpError) -> SmtpFailure {
    if error.is_timeout() {
        return SmtpFailure::Unconfirmed;
    }
    match error.status() {
        Some(code) if !CREDENTIALS_REFUSED_CODES.contains(&u16::from(code)) => {
            SmtpFailure::Refused {
                code: u16::from(code),
                text: format_source(error),
            }
        }
        _ => SmtpFailure::SignIn(calculate_sign_in_failure(error)),
    }
}

/// Formats the cause of lettre's error: the server's reply, or lettre's
/// own words.
fn format_source(error: &SmtpError) -> String {
    error
        .source()
        .map_or_else(|| error.to_string(), ToString::to_string)
}
