//! A fake SMTP server: EHLO, STARTTLS, AUTH PLAIN and LOGIN, MAIL, RCPT,
//! DATA, and QUIT, recording every mail it accepts.

use std::sync::{Arc, Mutex};

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream};
use tokio_rustls::TlsAcceptor;

use super::{PASSWORD, USER_NAME};

/// How the fake protects its connections.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SmtpMode {
    /// TLS from the first byte.
    Tls,
    /// Plain until STARTTLS.
    StartTls,
    /// Plain, and EHLO does not offer STARTTLS.
    StartTlsRefused,
    /// Plain, no TLS at all.
    Plain,
    /// Accepts the connection and never writes.
    Silent,
}

/// A mail the fake accepted.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SentMail {
    /// The envelope sender.
    pub from: String,
    /// The envelope recipients, in order.
    pub to: Vec<String>,
    /// The message as received, dot-unstuffed.
    pub bytes: Vec<u8>,
}

/// What the fake has seen and does.
#[derive(Debug, Default)]
pub struct FakeSmtpState {
    /// The mails accepted, in order.
    pub mails: Vec<SentMail>,
    /// Recipients answered with 550.
    pub refused_recipients: Vec<String>,
    /// Every command line received, in order.
    pub commands: Vec<String>,
}

/// The running fake.
pub struct FakeSmtpServer {
    /// The port it listens on, on 127.0.0.1.
    pub port: u16,
    /// Its state.
    pub state: Arc<Mutex<FakeSmtpState>>,
}

impl FakeSmtpServer {
    /// Starts the fake on a free port.
    ///
    /// # Arguments
    ///
    /// * `mode` - How connections are protected.
    /// * `acceptor` - The TLS acceptor, for the TLS modes.
    pub async fn start(mode: SmtpMode, acceptor: Option<TlsAcceptor>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("a free port");
        let port = listener.local_addr().expect("the address").port();
        let state = Arc::new(Mutex::new(FakeSmtpState::default()));
        let shared = Arc::clone(&state);
        tokio::spawn(async move {
            loop {
                let Ok((stream, _)) = listener.accept().await else {
                    break;
                };
                let state = Arc::clone(&shared);
                let acceptor = acceptor.clone();
                tokio::spawn(async move {
                    handle_connection(stream, mode, acceptor, state).await;
                });
            }
        });
        Self { port, state }
    }

    /// The mails accepted so far.
    pub fn mails(&self) -> Vec<SentMail> {
        self.state.lock().expect("the state").mails.clone()
    }

    /// Refuses a recipient from now on.
    pub fn refuse_recipient(&self, address: &str) {
        self.state
            .lock()
            .expect("the state")
            .refused_recipients
            .push(address.to_owned());
    }
}

/// Serves one connection in the mode.
async fn handle_connection(
    stream: TcpStream,
    mode: SmtpMode,
    acceptor: Option<TlsAcceptor>,
    state: Arc<Mutex<FakeSmtpState>>,
) {
    match mode {
        SmtpMode::Silent => {
            let mut reader = BufReader::new(stream);
            let mut line = String::new();
            while reader
                .read_line(&mut line)
                .await
                .is_ok_and(|count| count > 0)
            {
                line.clear();
            }
        }
        SmtpMode::Tls => {
            let Some(acceptor) = acceptor else {
                return;
            };
            if let Ok(tls) = acceptor.accept(stream).await {
                run_session(tls, mode, true, state).await;
            }
        }
        SmtpMode::StartTls => {
            if let Some(plain) = run_session(stream, mode, false, Arc::clone(&state)).await {
                let Some(acceptor) = acceptor else {
                    return;
                };
                if let Ok(tls) = acceptor.accept(plain).await {
                    run_session(tls, mode, true, state).await;
                }
            }
        }
        SmtpMode::StartTlsRefused | SmtpMode::Plain => {
            run_session(stream, mode, false, state).await;
        }
    }
}

/// Runs the dialogue until QUIT, the end of the stream, or an accepted
/// STARTTLS, which hands the stream back for the upgrade.
async fn run_session<S>(
    stream: S,
    mode: SmtpMode,
    secured: bool,
    state: Arc<Mutex<FakeSmtpState>>,
) -> Option<S>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let mut reader = BufReader::new(stream);
    if !secured || mode == SmtpMode::Tls {
        write(&mut reader, "220 localhost ESMTP fake\r\n").await;
    }
    let mut from = String::new();
    let mut recipients = Vec::new();
    loop {
        let mut line = String::new();
        let Ok(count) = reader.read_line(&mut line).await else {
            return None;
        };
        if count == 0 {
            return None;
        }
        let line = line.trim_end_matches(['\r', '\n']).to_owned();
        state.lock().expect("the state").commands.push(line.clone());
        let (verb, rest) = line.split_once(' ').unwrap_or((line.as_str(), ""));
        match verb.to_ascii_uppercase().as_str() {
            "EHLO" => {
                let mut answer = String::from("250-localhost Hello\r\n");
                if mode == SmtpMode::StartTls && !secured {
                    answer.push_str("250-STARTTLS\r\n");
                }
                answer.push_str("250-AUTH PLAIN LOGIN\r\n250 8BITMIME\r\n");
                write(&mut reader, &answer).await;
            }
            "HELO" => write(&mut reader, "250 localhost\r\n").await,
            "STARTTLS" => {
                if mode == SmtpMode::StartTls && !secured {
                    write(&mut reader, "220 2.0.0 Ready to start TLS\r\n").await;
                    return Some(reader.into_inner());
                }
                write(&mut reader, "454 4.7.0 TLS not available\r\n").await;
            }
            "AUTH" => {
                let accepted = authenticate(&mut reader, rest).await;
                if accepted {
                    write(&mut reader, "235 2.7.0 Authentication successful\r\n").await;
                } else {
                    write(
                        &mut reader,
                        "535 5.7.8 Authentication credentials invalid\r\n",
                    )
                    .await;
                }
            }
            "MAIL" => {
                from = extract_address(rest);
                recipients.clear();
                write(&mut reader, "250 2.1.0 OK\r\n").await;
            }
            "RCPT" => {
                let address = extract_address(rest);
                let refused = state
                    .lock()
                    .expect("the state")
                    .refused_recipients
                    .contains(&address);
                if refused {
                    write(&mut reader, "550 5.1.1 User unknown\r\n").await;
                } else {
                    recipients.push(address);
                    write(&mut reader, "250 2.1.5 OK\r\n").await;
                }
            }
            "DATA" => {
                write(&mut reader, "354 End data with <CR><LF>.<CR><LF>\r\n").await;
                let mut bytes = Vec::new();
                loop {
                    let mut data_line = String::new();
                    let Ok(count) = reader.read_line(&mut data_line).await else {
                        return None;
                    };
                    if count == 0 {
                        return None;
                    }
                    if data_line == ".\r\n" {
                        break;
                    }
                    let unstuffed = data_line.strip_prefix('.').unwrap_or(&data_line);
                    bytes.extend_from_slice(unstuffed.as_bytes());
                }
                state.lock().expect("the state").mails.push(SentMail {
                    from: from.clone(),
                    to: recipients.clone(),
                    bytes,
                });
                write(&mut reader, "250 2.0.0 OK: queued\r\n").await;
            }
            "NOOP" | "RSET" => write(&mut reader, "250 2.0.0 OK\r\n").await,
            "QUIT" => {
                write(&mut reader, "221 2.0.0 Bye\r\n").await;
                return None;
            }
            _ => write(&mut reader, "500 5.5.1 Command unrecognized\r\n").await,
        }
    }
}

/// Runs AUTH PLAIN or AUTH LOGIN and tells whether the credentials match.
async fn authenticate<S>(reader: &mut BufReader<S>, rest: &str) -> bool
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let (mechanism, initial) = rest.split_once(' ').unwrap_or((rest, ""));
    match mechanism.to_ascii_uppercase().as_str() {
        "PLAIN" => {
            let encoded = if initial.is_empty() {
                write(reader, "334 \r\n").await;
                read_line(reader).await
            } else {
                initial.to_owned()
            };
            let decoded = STANDARD.decode(encoded.trim()).unwrap_or_default();
            let parts: Vec<&[u8]> = decoded.split(|byte| *byte == 0).collect();
            parts.len() == 3 && parts[1] == USER_NAME.as_bytes() && parts[2] == PASSWORD.as_bytes()
        }
        "LOGIN" => {
            write(reader, "334 VXNlcm5hbWU6\r\n").await;
            let user = STANDARD
                .decode(read_line(reader).await.trim())
                .unwrap_or_default();
            write(reader, "334 UGFzc3dvcmQ6\r\n").await;
            let password = STANDARD
                .decode(read_line(reader).await.trim())
                .unwrap_or_default();
            user == USER_NAME.as_bytes() && password == PASSWORD.as_bytes()
        }
        _ => false,
    }
}

/// Reads one line without its line break.
async fn read_line<S>(reader: &mut BufReader<S>) -> String
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let mut line = String::new();
    let _ = reader.read_line(&mut line).await;
    line.trim_end_matches(['\r', '\n']).to_owned()
}

/// Writes text, ignoring a closed connection.
async fn write<S>(reader: &mut BufReader<S>, text: &str)
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let _ = reader.get_mut().write_all(text.as_bytes()).await;
    let _ = reader.get_mut().flush().await;
}

/// Extracts the address of `FROM:<a@b>` or `TO:<a@b> ...`.
fn extract_address(rest: &str) -> String {
    rest.split_once('<')
        .and_then(|(_, after)| after.split_once('>'))
        .map(|(address, _)| address.to_owned())
        .unwrap_or_default()
}
