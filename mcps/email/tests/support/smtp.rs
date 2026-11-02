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
///
/// Concurrency model: concurrent; the accept task, each connection's
/// task, and the test share the state behind one mutex, held only to read
/// or change it in memory. Resource ownership: the listener and the
/// connection tasks belong to the test's runtime, which drops them when
/// the test ends; the fake keeps the port and a share of the state.
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
        let setup = ConnectionSetup {
            mode,
            acceptor,
            state: Arc::clone(&state),
        };
        tokio::spawn(async move {
            loop {
                let Ok((stream, _)) = listener.accept().await else {
                    break;
                };
                let setup = setup.clone();
                tokio::spawn(async move {
                    handle_connection(stream, setup).await;
                });
            }
        });
        Self { port, state }
    }

    /// The mails accepted so far.
    pub fn list_mails(&self) -> Vec<SentMail> {
        self.state.lock().expect("the state").mails.clone()
    }

    /// Refuses a recipient from now on.
    pub fn add_refused_recipient(&self, address: &str) {
        self.state
            .lock()
            .expect("the state")
            .refused_recipients
            .push(address.to_owned());
    }
}

/// What serving one connection needs.
#[derive(Clone)]
struct ConnectionSetup {
    /// How the fake protects its connections.
    mode: SmtpMode,
    /// The TLS acceptor, for the TLS modes.
    acceptor: Option<TlsAcceptor>,
    /// The fake's state, shared with the test.
    state: Arc<Mutex<FakeSmtpState>>,
}

/// Serves one connection in the setup's mode.
async fn handle_connection(stream: TcpStream, setup: ConnectionSetup) {
    match setup.mode {
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
            let Some(acceptor) = &setup.acceptor else {
                return;
            };
            if let Ok(tls) = acceptor.accept(stream).await {
                Session::new(tls, &setup, true).handle_commands().await;
            }
        }
        SmtpMode::StartTls => {
            if let Some(plain) = Session::new(stream, &setup, false).handle_commands().await {
                let Some(acceptor) = &setup.acceptor else {
                    return;
                };
                if let Ok(tls) = acceptor.accept(plain).await {
                    Session::new(tls, &setup, true).handle_commands().await;
                }
            }
        }
        SmtpMode::StartTlsRefused | SmtpMode::Plain => {
            Session::new(stream, &setup, false).handle_commands().await;
        }
    }
}

/// What a session does after one command.
enum Step {
    /// Reads the next command.
    Next,
    /// Hands the stream back for the TLS upgrade.
    StartTls,
    /// Ends the session.
    End,
}

/// One connection's dialogue, and the mail being sent on it.
///
/// Owned by the task that serves the connection, which runs it once.
struct Session<S> {
    /// The connection.
    reader: BufReader<S>,
    /// How the fake protects its connections.
    mode: SmtpMode,
    /// Whether TLS protects this connection already.
    secured: bool,
    /// The fake's state, shared with the test.
    state: Arc<Mutex<FakeSmtpState>>,
    /// The envelope sender of the mail being sent.
    from: String,
    /// The accepted envelope recipients of the mail being sent.
    recipients: Vec<String>,
}

impl<S> Session<S>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    /// Starts a dialogue on a connection, with no mail being sent.
    ///
    /// # Arguments
    ///
    /// * `stream` - The connection.
    /// * `setup` - The fake's mode and state.
    /// * `secured` - Whether TLS protects the connection already.
    fn new(stream: S, setup: &ConnectionSetup, secured: bool) -> Self {
        Self {
            reader: BufReader::new(stream),
            mode: setup.mode,
            secured,
            state: Arc::clone(&setup.state),
            from: String::new(),
            recipients: Vec::new(),
        }
    }

    /// Runs the dialogue until QUIT, the end of the stream, or an accepted
    /// STARTTLS, which hands the stream back for the upgrade.
    async fn handle_commands(mut self) -> Option<S> {
        if !self.secured || self.mode == SmtpMode::Tls {
            send_line(&mut self.reader, "220 localhost ESMTP fake\r\n").await;
        }
        loop {
            let line = read_command_line(&mut self.reader).await?;
            self.state
                .lock()
                .expect("the state")
                .commands
                .push(line.clone());
            match self.handle_command(&line).await {
                Step::Next => {}
                Step::StartTls => return Some(self.reader.into_inner()),
                Step::End => return None,
            }
        }
    }

    /// Answers one command line.
    async fn handle_command(&mut self, line: &str) -> Step {
        let (verb, rest) = line.split_once(' ').unwrap_or((line, ""));
        match verb.to_ascii_uppercase().as_str() {
            "EHLO" => self.handle_ehlo().await,
            "HELO" => self.send_reply("250 localhost\r\n").await,
            "STARTTLS" => self.handle_starttls().await,
            "AUTH" => self.handle_auth(rest).await,
            "MAIL" => self.handle_mail(rest).await,
            "RCPT" => self.handle_rcpt(rest).await,
            "DATA" => self.handle_data().await,
            "NOOP" | "RSET" => self.send_reply("250 2.0.0 OK\r\n").await,
            "QUIT" => {
                self.send_reply("221 2.0.0 Bye\r\n").await;
                Step::End
            }
            _ => self.send_reply("500 5.5.1 Command unrecognized\r\n").await,
        }
    }

    /// Writes an answer, after which the session reads the next command.
    async fn send_reply(&mut self, text: &str) -> Step {
        send_line(&mut self.reader, text).await;
        Step::Next
    }

    /// Whether the fake offers STARTTLS on this connection.
    fn is_starttls_offered(&self) -> bool {
        self.mode == SmtpMode::StartTls && !self.secured
    }

    /// Answers EHLO with the extensions, STARTTLS while it is offered.
    async fn handle_ehlo(&mut self) -> Step {
        let mut answer = String::from("250-localhost Hello\r\n");
        if self.is_starttls_offered() {
            answer.push_str("250-STARTTLS\r\n");
        }
        answer.push_str("250-AUTH PLAIN LOGIN\r\n250 8BITMIME\r\n");
        self.send_reply(&answer).await
    }

    /// Answers STARTTLS: an upgrade while it is offered, else a refusal.
    async fn handle_starttls(&mut self) -> Step {
        if !self.is_starttls_offered() {
            return self.send_reply("454 4.7.0 TLS not available\r\n").await;
        }
        send_line(&mut self.reader, "220 2.0.0 Ready to start TLS\r\n").await;
        Step::StartTls
    }

    /// Answers AUTH: accepted for the test account's credentials.
    async fn handle_auth(&mut self, rest: &str) -> Step {
        let answer = if read_authentication(&mut self.reader, rest).await {
            "235 2.7.0 Authentication successful\r\n"
        } else {
            "535 5.7.8 Authentication credentials invalid\r\n"
        };
        self.send_reply(answer).await
    }

    /// Answers MAIL, starting a new mail from the sender.
    async fn handle_mail(&mut self, rest: &str) -> Step {
        self.from = parse_path_address(rest);
        self.recipients.clear();
        self.send_reply("250 2.1.0 OK\r\n").await
    }

    /// Answers RCPT, adding the recipient unless the fake refuses it.
    async fn handle_rcpt(&mut self, rest: &str) -> Step {
        let address = parse_path_address(rest);
        let refused = self
            .state
            .lock()
            .expect("the state")
            .refused_recipients
            .contains(&address);
        if refused {
            return self.send_reply("550 5.1.1 User unknown\r\n").await;
        }
        self.recipients.push(address);
        self.send_reply("250 2.1.5 OK\r\n").await
    }

    /// Answers DATA: reads the message and records the mail; the session
    /// ends when the stream ends before the message does.
    async fn handle_data(&mut self) -> Step {
        send_line(&mut self.reader, "354 End data with <CR><LF>.<CR><LF>\r\n").await;
        let Some(bytes) = read_data(&mut self.reader).await else {
            return Step::End;
        };
        self.state.lock().expect("the state").mails.push(SentMail {
            from: self.from.clone(),
            to: self.recipients.clone(),
            bytes,
        });
        self.send_reply("250 2.0.0 OK: queued\r\n").await
    }
}

/// Reads one command line without its line break.
///
/// # Returns
///
/// The line, or `None` once the stream ended or failed.
async fn read_command_line<S>(reader: &mut BufReader<S>) -> Option<String>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let mut line = String::new();
    let count = reader.read_line(&mut line).await.ok()?;
    if count == 0 {
        return None;
    }
    Some(line.trim_end_matches(['\r', '\n']).to_owned())
}

/// Reads the lines of DATA up to the line that holds only a dot, without
/// the dot each line starting with one was stuffed with.
///
/// # Returns
///
/// The message, or `None` once the stream ended or failed first.
async fn read_data<S>(reader: &mut BufReader<S>) -> Option<Vec<u8>>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let mut bytes = Vec::new();
    loop {
        let mut data_line = String::new();
        let count = reader.read_line(&mut data_line).await.ok()?;
        if count == 0 {
            return None;
        }
        if data_line == ".\r\n" {
            return Some(bytes);
        }
        let unstuffed = data_line.strip_prefix('.').unwrap_or(&data_line);
        bytes.extend_from_slice(unstuffed.as_bytes());
    }
}

/// Runs AUTH PLAIN or AUTH LOGIN and tells whether the credentials match.
async fn read_authentication<S>(reader: &mut BufReader<S>, rest: &str) -> bool
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let (mechanism, initial) = rest.split_once(' ').unwrap_or((rest, ""));
    match mechanism.to_ascii_uppercase().as_str() {
        "PLAIN" => {
            let encoded = if initial.is_empty() {
                send_line(reader, "334 \r\n").await;
                read_line(reader).await
            } else {
                initial.to_owned()
            };
            let decoded = STANDARD.decode(encoded.trim()).unwrap_or_default();
            let parts: Vec<&[u8]> = decoded.split(|byte| *byte == 0).collect();
            parts.len() == 3 && parts[1] == USER_NAME.as_bytes() && parts[2] == PASSWORD.as_bytes()
        }
        "LOGIN" => {
            send_line(reader, "334 VXNlcm5hbWU6\r\n").await;
            let user = STANDARD
                .decode(read_line(reader).await.trim())
                .unwrap_or_default();
            send_line(reader, "334 UGFzc3dvcmQ6\r\n").await;
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
async fn send_line<S>(reader: &mut BufReader<S>, text: &str)
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let _ = reader.get_mut().write_all(text.as_bytes()).await;
    let _ = reader.get_mut().flush().await;
}

/// Extracts the address of `FROM:<a@b>` or `TO:<a@b> ...`.
fn parse_path_address(rest: &str) -> String {
    rest.split_once('<')
        .and_then(|(_, after)| after.split_once('>'))
        .map(|(address, _)| address.to_owned())
        .unwrap_or_default()
}
