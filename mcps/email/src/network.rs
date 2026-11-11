//! The network connection to a mail server, for IMAP and SMTP alike: the
//! TCP connection, and the TLS handshake of a connection protected from
//! its first byte, each within [`CONNECT_LIMIT`].
//!
//! Both protocols class a failure here the same way: only a TCP
//! connection that could not be opened is `Unreachable`; once it is open,
//! a TLS failure is `CertificateRefused` or `ProtocolError`, as the server
//! did answer.

use std::io;
use std::time::Duration;

use tokio::net::TcpStream;
use tokio::time::timeout;
use tokio_rustls::client::TlsStream;
use tokio_rustls::rustls::pki_types::ServerName;

use crate::account::MailServer;
use crate::failure::SignInFailure;
use crate::log::send_log_line;
use crate::trust::{Trust, is_certificate_refusal};

/// Longest a TCP connection or a TLS handshake may take.
pub(crate) const CONNECT_LIMIT: Duration = Duration::from_secs(15);

/// Opens the TCP connection within [`CONNECT_LIMIT`].
///
/// # Arguments
///
/// * `server` - The host and port.
///
/// # Returns
///
/// The connection, or `Unreachable` when the host is unknown, the
/// connection is refused, or it is not opened in time.
pub(crate) async fn open_tcp_stream(server: &MailServer) -> Result<TcpStream, SignInFailure> {
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

/// Runs the TLS handshake over an open connection within
/// [`CONNECT_LIMIT`].
///
/// # Arguments
///
/// * `server` - The host the certificate must be issued for.
/// * `trust` - Which certificates are accepted.
/// * `tcp` - The open connection, which the TLS stream takes over.
///
/// # Returns
///
/// The TLS stream, or `CertificateRefused` when the certificate is
/// refused, `TimedOut` when the handshake does not end in time, and
/// `ProtocolError` for any other failure, such as a server that answers
/// without TLS or ends the connection.
pub(crate) async fn open_tls_stream(
    server: &MailServer,
    trust: &Trust,
    tcp: TcpStream,
) -> Result<TlsStream<TcpStream>, SignInFailure> {
    let connector = trust.build_tls_connector().map_err(|error| {
        send_log_line(&format!(
            "tls: the configuration could not be built: {error}"
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

/// Classifies an I/O error met before a session was signed in: a timeout
/// of the operating system is reported as such, anything else as an
/// unreadable or ended connection.
///
/// # Arguments
///
/// * `error` - The error.
pub(crate) fn calculate_io_sign_in_failure(error: &io::Error) -> SignInFailure {
    match error.kind() {
        io::ErrorKind::TimedOut => SignInFailure::TimedOut,
        _ => SignInFailure::ProtocolError,
    }
}
