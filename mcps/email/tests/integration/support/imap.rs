//! A fake IMAP server: folders and messages in memory, the commands the
//! email server sends, TLS or STARTTLS, and a log of every command; on
//! request it leaves LITERAL+ or UIDPLUS out of its capabilities, writes an
//! untagged line before each continuation request, refuses a command,
//! fails it by never answering it or by closing the connection, or removes
//! a message before a command, as another client would.

use std::fmt::Debug;
use std::future::Future;
use std::sync::{Arc, Mutex};

use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::Notify;
use tokio_rustls::TlsAcceptor;

use super::{
    FaultTiming, PASSWORD, USER_NAME, build_internal_date, get_current_timestamp,
    parse_search_date, read_until_end, run_past_fault,
};

/// How the fake protects its connections.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ImapMode {
    /// TLS from the first byte.
    Tls,
    /// Plain until STARTTLS.
    StartTls,
    /// Plain, and STARTTLS is refused.
    StartTlsRefused,
    /// Plain, no TLS at all.
    Plain,
    /// Accepts the connection, reads whatever comes, text or not, and
    /// never writes; each connection counts as a fault for
    /// [`FakeImapServer::run_past_fault`].
    Silent,
    /// Greets with text that is not IMAP, then closes.
    Garbage,
}

/// How the fake fails a command: instead of handling it, when a command
/// with a synchronizing literal, such as APPEND, fails before its literal
/// is sent; or after handling it, instead of answering.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ImapFault {
    /// Never answers, and records each line the client sends after it as
    /// a command, until the client closes the connection.
    Stall,
    /// Closes the connection without answering.
    Close,
    /// Handles the command, its literals read and a message stored, then
    /// stalls instead of answering, as [`Self::Stall`] does.
    StallAfterHandling,
    /// Handles the command, its literals read and a message stored, then
    /// closes the connection instead of answering.
    CloseAfterHandling,
}

impl ImapFault {
    /// Whether the fault strikes before the command is handled.
    fn is_before_handling(self) -> bool {
        match self {
            Self::Stall | Self::Close => true,
            Self::StallAfterHandling | Self::CloseAfterHandling => false,
        }
    }
}

/// A message the fake removes before a command, as another client that
/// expunged it while a call was running would.
#[derive(Clone, Debug, PartialEq, Eq)]
struct Removal {
    /// Text of the command line the message is removed before.
    trigger: String,
    /// The message's folder.
    folder: String,
    /// The message's UID.
    uid: u32,
}

/// One stored message.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FakeMessage {
    /// Its UID in the folder.
    pub uid: u32,
    /// Its flags, such as `\Seen`.
    pub flags: Vec<String>,
    /// When it arrived, as seconds since the Unix epoch.
    pub timestamp: i64,
    /// The message (RFC 5322).
    pub bytes: Vec<u8>,
}

impl FakeMessage {
    /// Whether the message has the flag, in any letter case.
    pub fn has_flag(&self, flag: &str) -> bool {
        self.flags
            .iter()
            .any(|candidate| candidate.eq_ignore_ascii_case(flag))
    }
}

/// A message to add to a folder.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NewMessage<'a> {
    /// The message (RFC 5322).
    pub bytes: Vec<u8>,
    /// Its flags, such as `\Seen`.
    pub flags: &'a [&'a str],
    /// When it arrived, as seconds since the Unix epoch.
    pub timestamp: i64,
}

/// One folder.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FakeFolder {
    /// Its name as the server writes it.
    pub name: String,
    /// Its `LIST` attributes, such as `\Sent`.
    pub attributes: Vec<String>,
    /// Its UIDVALIDITY.
    pub uid_validity: u32,
    /// The UID the next message gets.
    pub next_uid: u32,
    /// Its messages, in UID order.
    pub messages: Vec<FakeMessage>,
}

impl FakeFolder {
    /// Creates an empty folder.
    pub fn new(name: &str, attributes: &[&str], uid_validity: u32) -> Self {
        Self {
            name: name.to_owned(),
            attributes: attributes
                .iter()
                .map(|attribute| (*attribute).to_owned())
                .collect(),
            uid_validity,
            next_uid: 1,
            messages: Vec::new(),
        }
    }

    /// Whether the folder can be selected.
    pub fn is_selectable(&self) -> bool {
        !self
            .attributes
            .iter()
            .any(|attribute| attribute.eq_ignore_ascii_case("\\Noselect"))
    }
}

/// The folders, the messages, and what the fake has seen.
///
/// Concurrency model: single-owner; the fake retains it behind one mutex,
/// and only the holder of the lock reads or changes it.
#[derive(Debug)]
pub struct FakeMailbox {
    /// The folders, in listing order.
    pub folders: Vec<FakeFolder>,
    /// Every command received, in order, with literals shown as quoted
    /// strings.
    pub commands: Vec<String>,
    /// Whether UIDPLUS is advertised.
    pub uid_plus: bool,
    /// Whether LITERAL+ is advertised. Without it, `{n+}` is not a
    /// literal: a command line that ends in one ends there and is answered
    /// `BAD`, and the next line is read as a command of its own.
    pub literal_plus: bool,
    /// The hierarchy delimiter.
    pub delimiter: String,
    /// An untagged line the fake writes before each continuation request,
    /// such as `* 1 EXISTS` repeating the size of the open folder, as a
    /// server may send data the client did not ask for at any time
    /// (RFC 3501, section 5.2); `None` writes none.
    pub untagged_before_continuation: Option<String>,
    /// The UIDVALIDITY the next created folder gets.
    next_uid_validity: u32,
    /// The commands the fake refuses, by name, with what it answers after
    /// the tag.
    refusals: Vec<(String, String)>,
    /// The commands the fake refuses by a text their line holds, with what
    /// it answers after the tag.
    line_refusals: Vec<(String, String)>,
    /// The commands the fake fails, by name, and how.
    faults: Vec<(String, ImapFault)>,
    /// The messages still to remove, each before the first command whose
    /// line holds its trigger.
    removals: Vec<Removal>,
}

impl FakeMailbox {
    /// A mailbox without folders that advertises UIDPLUS and LITERAL+, uses
    /// `/` as its hierarchy delimiter, gives the folders that CREATE makes
    /// UIDVALIDITY 2001 and up, writes no untagged line before a
    /// continuation request, and refuses, fails, and removes nothing.
    pub fn create_empty() -> Self {
        Self {
            folders: Vec::new(),
            commands: Vec::new(),
            uid_plus: true,
            literal_plus: true,
            delimiter: "/".to_owned(),
            untagged_before_continuation: None,
            next_uid_validity: 2001,
            refusals: Vec::new(),
            line_refusals: Vec::new(),
            faults: Vec::new(),
            removals: Vec::new(),
        }
    }

    /// The usual folders, all without messages, in a mailbox with the
    /// defaults of [`Self::create_empty`]: INBOX, Sent, Drafts, Trash, an
    /// All Mail view, a plain Projects folder, and a parent that cannot hold
    /// messages, with UIDVALIDITY 1001 to 1007 in that order.
    pub fn create_standard() -> Self {
        let mut mailbox = Self::create_empty();
        mailbox.folders = vec![
            FakeFolder::new("INBOX", &["\\HasNoChildren"], 1001),
            FakeFolder::new("Sent", &["\\HasNoChildren", "\\Sent"], 1002),
            FakeFolder::new("Drafts", &["\\HasNoChildren", "\\Drafts"], 1003),
            FakeFolder::new("Trash", &["\\HasNoChildren", "\\Trash"], 1004),
            FakeFolder::new("All Mail", &["\\HasNoChildren", "\\All"], 1005),
            FakeFolder::new("Projects", &["\\HasNoChildren"], 1006),
            FakeFolder::new("[Gmail]", &["\\Noselect", "\\HasChildren"], 1007),
        ];
        mailbox
    }

    /// Adds a message to a folder.
    ///
    /// # Arguments
    ///
    /// * `folder` - The folder's name.
    /// * `message` - The message, with its flags and when it arrived.
    ///
    /// # Returns
    ///
    /// The message's UID.
    ///
    /// # Panics
    ///
    /// When the mailbox has no folder of that name.
    pub fn add_message(&mut self, folder: &str, message: NewMessage<'_>) -> u32 {
        let folder = self.find_folder_mut(folder).expect("the folder exists");
        let uid = folder.next_uid;
        folder.next_uid += 1;
        folder.messages.push(FakeMessage {
            uid,
            flags: message
                .flags
                .iter()
                .map(|flag| (*flag).to_owned())
                .collect(),
            timestamp: message.timestamp,
            bytes: message.bytes,
        });
        uid
    }

    /// Finds a folder by name.
    pub fn find_folder(&self, name: &str) -> Option<&FakeFolder> {
        self.folders.iter().find(|folder| folder.name == name)
    }

    /// Finds a folder by name, to change it.
    pub fn find_folder_mut(&mut self, name: &str) -> Option<&mut FakeFolder> {
        self.folders.iter_mut().find(|folder| folder.name == name)
    }

    /// Makes the fake refuse every command of a name instead of handling
    /// it; a command with a synchronizing literal, such as APPEND, is
    /// refused before its literal is sent.
    ///
    /// # Arguments
    ///
    /// * `name` - The command's name in capitals; for `UID <name>`, the
    ///   name after `UID`.
    /// * `answer` - What the fake answers after the tag, such as
    ///   `NO [OVERQUOTA] Quota exceeded`.
    pub fn add_refusal(&mut self, name: &str, answer: &str) {
        self.refusals.push((name.to_owned(), answer.to_owned()));
    }

    /// Makes the fake refuse every command whose line holds a text instead
    /// of handling it, such as the FETCH of one message among others; a
    /// command with a synchronizing literal is refused before its literal
    /// is sent when the text comes before the literal.
    ///
    /// # Arguments
    ///
    /// * `trigger` - Text of the command line, such as
    ///   `UID FETCH 2 (UID FLAGS BODY.PEEK[])`.
    /// * `answer` - What the fake answers after the tag, such as
    ///   `NO [SERVERBUG] Internal error`.
    pub fn add_line_refusal(&mut self, trigger: &str, answer: &str) {
        self.line_refusals
            .push((trigger.to_owned(), answer.to_owned()));
    }

    /// Makes the fake remove a message just before it handles the first
    /// command whose line holds a text, as another client that expunged
    /// the message would; the fake announces no EXPUNGE response for it.
    ///
    /// # Arguments
    ///
    /// * `trigger` - Text of the command line, such as
    ///   `UID FETCH 2 (UID FLAGS BODY.PEEK[])`.
    /// * `folder` - The message's folder.
    /// * `uid` - The message's UID.
    pub fn add_removal(&mut self, trigger: &str, folder: &str, uid: u32) {
        self.removals.push(Removal {
            trigger: trigger.to_owned(),
            folder: folder.to_owned(),
            uid,
        });
    }

    /// Removes the messages whose trigger the command line holds.
    ///
    /// # Arguments
    ///
    /// * `line` - The command line, before the fake handles it.
    fn remove_triggered_messages(&mut self, line: &str) {
        let (due, waiting): (Vec<Removal>, Vec<Removal>) = std::mem::take(&mut self.removals)
            .into_iter()
            .partition(|removal| line.contains(&removal.trigger));
        self.removals = waiting;
        for removal in due {
            let folder = self
                .find_folder_mut(&removal.folder)
                .expect("the folder exists");
            folder.messages.retain(|message| message.uid != removal.uid);
        }
    }

    /// Finds what the fake answers instead of handling a command, if it
    /// refuses it by its name or by a text its line holds.
    ///
    /// # Arguments
    ///
    /// * `command` - The command, with its line.
    ///
    /// # Returns
    ///
    /// The answer after the tag, or `None` when the fake handles the
    /// command.
    fn find_refusal(&self, command: &Command) -> Option<String> {
        let by_name = self
            .refusals
            .iter()
            .find(|(refused, _)| *refused == command.name);
        let by_line = self
            .line_refusals
            .iter()
            .find(|(trigger, _)| command.line.contains(trigger.as_str()));
        by_name.or(by_line).map(|(_, answer)| answer.clone())
    }

    /// Finds how the fake fails a command of the name, if it fails it.
    fn find_fault(&self, name: &str) -> Option<ImapFault> {
        self.faults
            .iter()
            .find(|(failed, _)| failed == name)
            .map(|(_, fault)| *fault)
    }
}

/// The running fake.
///
/// Concurrency model: concurrent; the accept task, each connection's
/// task, and the test share the mailbox behind one mutex, held only to
/// read or change it in memory. Resource ownership: the listener and the
/// connection tasks belong to the test's runtime, which drops them when
/// the test ends; the fake keeps the port and a share of the mailbox.
pub struct FakeImapServer {
    /// The port it listens on, on 127.0.0.1.
    pub port: u16,
    /// Its state.
    pub state: Arc<Mutex<FakeMailbox>>,
    /// Notified each time a fault strikes, or a connection is accepted in
    /// the silent mode.
    faulted: Arc<Notify>,
}

impl FakeImapServer {
    /// Starts the fake on a free port.
    ///
    /// # Arguments
    ///
    /// * `mailbox` - The folders and messages.
    /// * `mode` - How connections are protected.
    /// * `acceptor` - The TLS acceptor, for the TLS modes.
    pub async fn start(
        mailbox: FakeMailbox,
        mode: ImapMode,
        acceptor: Option<TlsAcceptor>,
    ) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("a free port");
        let port = listener.local_addr().expect("the address").port();
        let state = Arc::new(Mutex::new(mailbox));
        let faulted = Arc::new(Notify::new());
        let setup = ConnectionSetup {
            mode,
            acceptor,
            state: Arc::clone(&state),
            faulted: Arc::clone(&faulted),
        };
        tokio::spawn(handle_incoming_connections(listener, setup));
        Self {
            port,
            state,
            faulted,
        }
    }

    /// The commands received so far.
    pub fn list_commands(&self) -> Vec<String> {
        self.state.lock().expect("the state").commands.clone()
    }

    /// The messages of a folder.
    pub fn list_messages(&self, folder: &str) -> Vec<FakeMessage> {
        self.state
            .lock()
            .expect("the state")
            .find_folder(folder)
            .map(|folder| folder.messages.clone())
            .unwrap_or_default()
    }

    /// Finds a folder by name, as a copy.
    pub fn find_folder(&self, name: &str) -> Option<FakeFolder> {
        self.state
            .lock()
            .expect("the state")
            .find_folder(name)
            .cloned()
    }

    /// Changes the state, as a server whose mailbox changed between two
    /// calls.
    pub fn update_state(&self, change: impl FnOnce(&mut FakeMailbox)) {
        change(&mut self.state.lock().expect("the state"));
    }

    /// Fails every command of a name from now on instead of handling it.
    ///
    /// # Arguments
    ///
    /// * `name` - The command's name in capitals; for `UID <name>`, the
    ///   name after `UID`.
    /// * `fault` - How the fake fails it.
    pub fn add_fault(&self, name: &str, fault: ImapFault) {
        self.state
            .lock()
            .expect("the state")
            .faults
            .push((name.to_owned(), fault));
    }

    /// Waits until a fault has struck, or a connection was accepted in the
    /// silent mode, since the last wait.
    pub async fn wait_for_fault(&self) {
        self.faulted.notified().await;
    }

    /// Runs a future until a fault strikes, or a connection was accepted
    /// in the silent mode, lets it take up the input it already has, pauses
    /// the clock for the rest of the case, and runs it to its end, as
    /// [`run_past_fault`] does.
    ///
    /// # Arguments
    ///
    /// * `future` - The code under test, talking to this fake.
    ///
    /// # Returns
    ///
    /// The future's output and how long the run took, on the real clock
    /// until the pause and on the paused clock after it.
    ///
    /// # Panics
    ///
    /// As [`run_past_fault`] does: when the case runs on a runtime other
    /// than a current-thread one, or the clock is already paused, as by an
    /// earlier run in the same case; when the future ends before the clock
    /// paused; or when it outwaits the guard limit on the paused clock.
    pub async fn run_past_fault<F>(&self, future: F) -> (F::Output, FaultTiming)
    where
        F: Future,
        F::Output: Debug,
    {
        run_past_fault(self.wait_for_fault(), future).await
    }
}

/// What every connection of the fake shares.
///
/// Concurrency model: single-owner; each connection's task owns its own
/// copy, and the copies reach the mailbox only through its mutex.
#[derive(Clone)]
struct ConnectionSetup {
    /// How the fake protects its connections.
    mode: ImapMode,
    /// The TLS acceptor, for the TLS modes.
    acceptor: Option<TlsAcceptor>,
    /// The folders, the messages, and what the fake has seen.
    state: Arc<Mutex<FakeMailbox>>,
    /// Notified each time a fault strikes, or a connection is accepted in
    /// the silent mode.
    faulted: Arc<Notify>,
}

impl ConnectionSetup {
    /// Adds a line the client sent to the fake's commands, in the order
    /// the fake read it.
    fn add_command_line(&self, line: String) {
        self.state.lock().expect("the state").commands.push(line);
    }
}

/// Accepts the fake's connections until accepting one fails, and serves
/// each in a task of its own.
///
/// Resource ownership: owns the listener, which closes when the test's
/// runtime drops the task that runs this.
///
/// # Arguments
///
/// * `listener` - The fake's listener.
/// * `setup` - What every connection shares; each one gets a copy.
async fn handle_incoming_connections(listener: TcpListener, setup: ConnectionSetup) {
    while let Ok((stream, _)) = listener.accept().await {
        tokio::spawn(handle_connection(stream, setup.clone()));
    }
}

/// Serves one connection in the setup's mode.
async fn handle_connection(stream: TcpStream, setup: ConnectionSetup) {
    match setup.mode {
        ImapMode::Silent => {
            setup.faulted.notify_one();
            read_until_end(&mut BufReader::new(stream)).await;
        }
        ImapMode::Garbage => {
            let mut stream = stream;
            let _ = stream.write_all(b"this is not an IMAP server\r\n").await;
            let _ = stream.shutdown().await;
        }
        ImapMode::Tls => {
            let Some(acceptor) = &setup.acceptor else {
                return;
            };
            if let Ok(tls) = acceptor.accept(stream).await {
                handle_session_commands(tls, &setup, true).await;
            }
        }
        ImapMode::StartTls => {
            if let Some(plain) = handle_session_commands(stream, &setup, false).await {
                let Some(acceptor) = &setup.acceptor else {
                    return;
                };
                if let Ok(tls) = acceptor.accept(plain).await {
                    handle_session_commands(tls, &setup, true).await;
                }
            }
        }
        ImapMode::StartTlsRefused | ImapMode::Plain => {
            handle_session_commands(stream, &setup, false).await;
        }
    }
}

/// One session over one connection: what it knows about the connection,
/// and the folder it has open.
///
/// Concurrency model: single-owner; the task that serves the connection
/// owns it and handles its commands one at a time.
struct Session {
    /// How the fake protects its connections.
    mode: ImapMode,
    /// Whether TLS protects this connection already.
    secured: bool,
    /// The capabilities it advertises.
    capabilities: String,
    /// The name of the folder SELECT or EXAMINE opened, if any.
    selected: Option<String>,
}

/// One command a client sent.
struct Command {
    /// Its line, with literals shown as quoted strings.
    line: String,
    /// Its tag.
    tag: String,
    /// Its name in capitals; for `UID <name>`, the name after `UID`.
    name: String,
    /// Whether it came as `UID <name>`.
    by_uid: bool,
    /// Its arguments, as [`tokenize`] splits them.
    arguments: Vec<String>,
    /// The literals it carried, in order.
    literals: Vec<Vec<u8>>,
}

/// What a session does after one command.
enum Step {
    /// Writes the answer and reads the next command.
    Answer(Vec<u8>),
    /// Writes the line and hands the stream back for the TLS upgrade.
    StartTls(String),
    /// Writes the lines and ends the session.
    Logout(String),
}

/// Handles the session's commands until LOGOUT, the end of the stream, a
/// fault, or an accepted STARTTLS, which hands the stream back for the
/// upgrade.
///
/// # Arguments
///
/// * `stream` - The connection.
/// * `setup` - The mode and the mailbox.
/// * `secured` - Whether TLS protects the connection already.
async fn handle_session_commands<S>(stream: S, setup: &ConnectionSetup, secured: bool) -> Option<S>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let mut reader = BufReader::new(stream);
    let mut session = start_session(&mut reader, setup, secured).await;
    loop {
        let (text, literals) = read_command(&mut reader, &setup.state).await?;
        setup.add_command_line(text.clone());
        let Some(command) = parse_command(&text, literals) else {
            continue;
        };
        if parse_trailing_literal(&text).is_some() {
            let answer = format!(
                "{} BAD Error in IMAP command: Invalid literal\r\n",
                command.tag
            );
            send_line(&mut reader, &answer).await;
            continue;
        }
        let fault = setup
            .state
            .lock()
            .expect("the state")
            .find_fault(&command.name);
        if let Some(fault) = fault {
            if !fault.is_before_handling() {
                let mut mailbox = setup.state.lock().expect("the state");
                drop(session.handle_command(&command, &mut mailbox));
            }
            handle_fault(&mut reader, setup, fault).await;
            return None;
        }
        let step = {
            let mut mailbox = setup.state.lock().expect("the state");
            mailbox.remove_triggered_messages(&text);
            session.handle_command(&command, &mut mailbox)
        };
        match step {
            Step::Answer(answer) => send_bytes(&mut reader, &answer).await,
            Step::StartTls(line) => {
                send_line(&mut reader, &line).await;
                return Some(reader.into_inner());
            }
            Step::Logout(lines) => {
                send_line(&mut reader, &lines).await;
                return None;
            }
        }
    }
}

/// Starts a session on the connection: greets the client, unless STARTTLS
/// just upgraded the connection, after which IMAP sends no new greeting.
///
/// # Arguments
///
/// * `reader` - The connection.
/// * `setup` - The mode and the mailbox.
/// * `secured` - Whether TLS protects the connection already.
async fn start_session<S>(
    reader: &mut BufReader<S>,
    setup: &ConnectionSetup,
    secured: bool,
) -> Session
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let session = Session {
        mode: setup.mode,
        secured,
        capabilities: build_capabilities(setup.mode, secured, &setup.state),
        selected: None,
    };
    if is_greeting_due(setup.mode, secured) {
        let greeting = format!("* OK [CAPABILITY {}] Fake ready\r\n", session.capabilities);
        send_line(reader, &greeting).await;
    }
    session
}

/// Whether the fake greets on a connection: on one with TLS from the
/// first byte, and on any plain one; not after STARTTLS upgraded it.
///
/// # Arguments
///
/// * `mode` - How the fake protects its connections.
/// * `secured` - Whether TLS protects the connection already.
fn is_greeting_due(mode: ImapMode, secured: bool) -> bool {
    match mode {
        ImapMode::Tls => true,
        ImapMode::StartTls
        | ImapMode::StartTlsRefused
        | ImapMode::Plain
        | ImapMode::Silent
        | ImapMode::Garbage => !secured,
    }
}

/// Fails a command: never answers it, recording each line the client sends
/// after it until the client closes the connection, or returns at once,
/// so that the caller closes the connection.
///
/// # Arguments
///
/// * `reader` - The connection.
/// * `setup` - The mailbox, which records the lines, and the notification
///   of the fault.
/// * `fault` - How the command fails.
async fn handle_fault<S>(reader: &mut BufReader<S>, setup: &ConnectionSetup, fault: ImapFault)
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    setup.faulted.notify_one();
    match fault {
        ImapFault::Close | ImapFault::CloseAfterHandling => return,
        ImapFault::Stall | ImapFault::StallAfterHandling => {}
    }
    let mut line = String::new();
    while reader
        .read_line(&mut line)
        .await
        .is_ok_and(|count| count > 0)
    {
        setup.add_command_line(line.trim_end_matches(['\r', '\n']).to_owned());
        line.clear();
    }
}

/// Splits a command's text into its tag, name, and arguments, and keeps
/// the whole text as the command's line, which line refusals match. A
/// command sent as `UID <name>` is marked so, takes the token after `UID`
/// as its name, and has its arguments start after that token; `UID` alone
/// stays a command of that name, which the fake does not know.
///
/// # Arguments
///
/// * `text` - The command's text, its literals shown as quoted strings, as
///   [`read_command`] gives it.
/// * `literals` - The literals it carried, in order.
///
/// # Returns
///
/// The command, or `None` for a line without a tag, which the session
/// skips.
fn parse_command(text: &str, literals: Vec<Vec<u8>>) -> Option<Command> {
    let mut tokens = parse_tokens(text).into_iter();
    let tag = tokens.next()?;
    let mut name = tokens
        .next()
        .map(|token| token.to_ascii_uppercase())
        .unwrap_or_default();
    let mut arguments: Vec<String> = tokens.collect();
    let by_uid = name == "UID" && !arguments.is_empty();
    if by_uid {
        name = arguments.remove(0).to_ascii_uppercase();
    }
    Some(Command {
        line: text.to_owned(),
        tag,
        name,
        by_uid,
        arguments,
        literals,
    })
}

impl Session {
    /// Handles one command over the mailbox, which it may change.
    ///
    /// A command the mailbox refuses, by its name or by a text of its line,
    /// gets the refusal instead of being handled, and a command the fake
    /// does not know gets `BAD`. SELECT and EXAMINE, refused or not, first
    /// leave no folder selected, as RFC 3501 (section 6.3.1) has a server
    /// do, then select the folder they name when it can hold messages;
    /// CLOSE leaves none selected.
    ///
    /// # Arguments
    ///
    /// * `command` - The command, with its line.
    /// * `mailbox` - The folders and messages, and what the fake refuses.
    ///
    /// # Returns
    ///
    /// What the session does next: write the answer and read the next
    /// command; for an accepted STARTTLS, write the line and hand the
    /// stream back for the upgrade; or, for LOGOUT, write the lines and end.
    fn handle_command(&mut self, command: &Command, mailbox: &mut FakeMailbox) -> Step {
        let tag = &command.tag;
        if matches!(command.name.as_str(), "SELECT" | "EXAMINE") {
            self.selected = None;
        }
        if let Some(answer) = mailbox.find_refusal(command) {
            return Step::Answer(format!("{tag} {answer}\r\n").into_bytes());
        }
        let selected = &mut self.selected;
        match command.name.as_str() {
            "CAPABILITY" => Step::Answer(
                format!(
                    "* CAPABILITY {}\r\n{tag} OK Capability completed\r\n",
                    self.capabilities
                )
                .into_bytes(),
            ),
            "NOOP" => Step::Answer(format!("{tag} OK Noop completed\r\n").into_bytes()),
            "STARTTLS" => handle_starttls(tag, self.mode, self.secured),
            "LOGIN" => Step::Answer(handle_login(command, &self.capabilities)),
            "LOGOUT" => Step::Logout(format!(
                "* BYE Logging out\r\n{tag} OK Logout completed\r\n"
            )),
            "LIST" => Step::Answer(handle_list(tag, mailbox)),
            "STATUS" => Step::Answer(handle_status(command, mailbox)),
            "SELECT" | "EXAMINE" => Step::Answer(handle_select(command, mailbox, selected)),
            "CREATE" => Step::Answer(handle_create(command, mailbox)),
            "DELETE" => Step::Answer(handle_delete(command, mailbox)),
            "RENAME" => Step::Answer(handle_rename(command, mailbox)),
            "SEARCH" => Step::Answer(handle_search(command, mailbox, selected.as_deref())),
            "FETCH" => Step::Answer(handle_fetch(command, mailbox, selected.as_deref())),
            "STORE" => Step::Answer(handle_store(command, mailbox, selected.as_deref())),
            "EXPUNGE" | "CLOSE" => Step::Answer(handle_expunge(command, mailbox, selected)),
            "APPEND" => Step::Answer(handle_append(command, mailbox)),
            _ => Step::Answer(
                format!("{tag} BAD Error in IMAP command: Unknown command\r\n").into_bytes(),
            ),
        }
    }
}

/// Answers STARTTLS: an upgrade while the fake offers it on a plain
/// connection, else a refusal.
fn handle_starttls(tag: &str, mode: ImapMode, secured: bool) -> Step {
    match mode {
        ImapMode::StartTls if !secured => {
            Step::StartTls(format!("{tag} OK Begin TLS negotiation now\r\n"))
        }
        ImapMode::StartTls
        | ImapMode::Tls
        | ImapMode::StartTlsRefused
        | ImapMode::Plain
        | ImapMode::Silent
        | ImapMode::Garbage => {
            Step::Answer(format!("{tag} NO STARTTLS is not available\r\n").into_bytes())
        }
    }
}

/// Answers LOGIN: accepted for the test account's user name and password.
fn handle_login(command: &Command, capabilities: &str) -> Vec<u8> {
    let tag = &command.tag;
    let arguments = &command.arguments;
    let accepted = arguments.first().is_some_and(|user| user == USER_NAME)
        && arguments
            .get(1)
            .is_some_and(|password| password == PASSWORD);
    if accepted {
        format!("{tag} OK [CAPABILITY {capabilities}] Logged in\r\n").into_bytes()
    } else {
        format!("{tag} NO [AUTHENTICATIONFAILED] Authentication failed.\r\n").into_bytes()
    }
}

/// Answers LIST with every folder, in listing order.
fn handle_list(tag: &str, mailbox: &FakeMailbox) -> Vec<u8> {
    let mut answer = String::new();
    for folder in &mailbox.folders {
        answer.push_str(&format!(
            "* LIST ({}) \"{}\" \"{}\"\r\n",
            folder.attributes.join(" "),
            mailbox.delimiter,
            folder.name
        ));
    }
    answer.push_str(&format!("{tag} OK List completed\r\n"));
    answer.into_bytes()
}

/// Answers STATUS with the number of messages of a folder that can hold
/// them.
fn handle_status(command: &Command, mailbox: &FakeMailbox) -> Vec<u8> {
    let tag = &command.tag;
    match command
        .arguments
        .first()
        .and_then(|name| mailbox.find_folder(name))
    {
        Some(folder) if folder.is_selectable() => format!(
            "* STATUS \"{}\" (MESSAGES {})\r\n{tag} OK Status completed\r\n",
            folder.name,
            folder.messages.len()
        )
        .into_bytes(),
        _ => format!("{tag} NO Mailbox doesn't exist\r\n").into_bytes(),
    }
}

/// Answers SELECT or EXAMINE, selecting a folder that can hold messages.
fn handle_select(
    command: &Command,
    mailbox: &FakeMailbox,
    selected: &mut Option<String>,
) -> Vec<u8> {
    let tag = &command.tag;
    match command
        .arguments
        .first()
        .and_then(|name| mailbox.find_folder(name))
    {
        Some(folder) if folder.is_selectable() => {
            *selected = Some(folder.name.clone());
            let (access, verb) = if command.name == "SELECT" {
                ("READ-WRITE", "Select")
            } else {
                ("READ-ONLY", "Examine")
            };
            format!(
                "* FLAGS (\\Answered \\Flagged \\Deleted \\Seen \\Draft)\r\n* OK [PERMANENTFLAGS (\\Answered \\Flagged \\Deleted \\Seen \\Draft \\*)] Flags permitted.\r\n* {} EXISTS\r\n* 0 RECENT\r\n* OK [UIDVALIDITY {}] UIDs valid\r\n* OK [UIDNEXT {}] Predicted next UID\r\n{tag} OK [{access}] {verb} completed\r\n",
                folder.messages.len(),
                folder.uid_validity,
                folder.next_uid,
            )
            .into_bytes()
        }
        Some(_) => format!("{tag} NO Mailbox is not selectable\r\n").into_bytes(),
        None => format!("{tag} NO Mailbox doesn't exist\r\n").into_bytes(),
    }
}

/// Answers CREATE, adding an empty folder of a new name.
fn handle_create(command: &Command, mailbox: &mut FakeMailbox) -> Vec<u8> {
    let tag = &command.tag;
    match command.arguments.first() {
        Some(name) if mailbox.find_folder(name).is_some() => {
            format!("{tag} NO Mailbox already exists\r\n").into_bytes()
        }
        Some(name) => {
            let uid_validity = mailbox.next_uid_validity;
            mailbox.next_uid_validity += 1;
            let folder = FakeFolder::new(name, &["\\HasNoChildren"], uid_validity);
            mailbox.folders.push(folder);
            format!("{tag} OK Create completed\r\n").into_bytes()
        }
        None => format!("{tag} BAD Missing name\r\n").into_bytes(),
    }
}

/// Answers DELETE, removing a folder that exists.
fn handle_delete(command: &Command, mailbox: &mut FakeMailbox) -> Vec<u8> {
    let tag = &command.tag;
    match command.arguments.first().and_then(|name| {
        mailbox
            .folders
            .iter()
            .position(|folder| &folder.name == name)
    }) {
        Some(index) => {
            mailbox.folders.remove(index);
            format!("{tag} OK Delete completed\r\n").into_bytes()
        }
        None => format!("{tag} NO Mailbox doesn't exist\r\n").into_bytes(),
    }
}

/// Answers RENAME, giving a folder that exists its new name.
fn handle_rename(command: &Command, mailbox: &mut FakeMailbox) -> Vec<u8> {
    let tag = &command.tag;
    let (Some(old), Some(new)) = (command.arguments.first(), command.arguments.get(1)) else {
        return format!("{tag} BAD Missing names\r\n").into_bytes();
    };
    match mailbox.find_folder_mut(old) {
        Some(folder) => {
            folder.name = new.clone();
            format!("{tag} OK Rename completed\r\n").into_bytes()
        }
        None => format!("{tag} NO Mailbox doesn't exist\r\n").into_bytes(),
    }
}

/// Answers SEARCH over the selected folder with the UIDs that match.
fn handle_search(command: &Command, mailbox: &FakeMailbox, selected: Option<&str>) -> Vec<u8> {
    let tag = &command.tag;
    let Some(folder) = selected.and_then(|name| mailbox.find_folder(name)) else {
        return build_no_mailbox_reply(tag);
    };
    match list_search_matches(folder, &command.arguments) {
        Ok(uids) => {
            let listed: Vec<String> = uids.iter().map(ToString::to_string).collect();
            format!(
                "* SEARCH{}{}\r\n{tag} OK Search completed\r\n",
                if listed.is_empty() { "" } else { " " },
                listed.join(" ")
            )
            .into_bytes()
        }
        Err(problem) => format!("{tag} BAD {problem}\r\n").into_bytes(),
    }
}

/// Answers FETCH over the selected folder.
fn handle_fetch(command: &Command, mailbox: &mut FakeMailbox, selected: Option<&str>) -> Vec<u8> {
    match selected.and_then(|name| mailbox.find_folder_mut(name)) {
        Some(folder) => handle_folder_fetch(folder, &command.arguments, &command.tag),
        None => build_no_mailbox_reply(&command.tag),
    }
}

/// Answers STORE over the selected folder.
fn handle_store(command: &Command, mailbox: &mut FakeMailbox, selected: Option<&str>) -> Vec<u8> {
    match selected.and_then(|name| mailbox.find_folder_mut(name)) {
        Some(folder) => handle_folder_store(folder, &command.arguments, &command.tag),
        None => build_no_mailbox_reply(&command.tag),
    }
}

/// Answers EXPUNGE or CLOSE: removes the selected folder's messages marked
/// `\Deleted`, only those of the UID set for `UID EXPUNGE`; EXPUNGE
/// reports each removal, and CLOSE also ends the selection.
fn handle_expunge(
    command: &Command,
    mailbox: &mut FakeMailbox,
    selected: &mut Option<String>,
) -> Vec<u8> {
    let tag = &command.tag;
    let Some(folder) = selected
        .as_deref()
        .and_then(|name| mailbox.find_folder_mut(name))
    else {
        return build_no_mailbox_reply(tag);
    };
    let only: Option<Vec<u32>> = if command.by_uid {
        command.arguments.first().map(|set| parse_set(set, folder))
    } else {
        None
    };
    let removed = remove_deleted_messages(folder, only.as_deref());
    let is_close = command.name == "CLOSE";
    let mut answer = String::new();
    if !is_close {
        for position in removed {
            answer.push_str(&format!("* {position} EXPUNGE\r\n"));
        }
    }
    if is_close {
        *selected = None;
    }
    let verb = if is_close { "Close" } else { "Expunge" };
    answer.push_str(&format!("{tag} OK {verb} completed\r\n"));
    answer.into_bytes()
}

/// Removes a folder's messages marked `\Deleted`, only those whose UID is
/// in the set when one is given.
///
/// # Returns
///
/// The message sequence number of each removed message at the time it was
/// removed, in removal order, as EXPUNGE reports them.
fn remove_deleted_messages(folder: &mut FakeFolder, only: Option<&[u32]>) -> Vec<usize> {
    let mut removed = Vec::new();
    let mut position = 0;
    while position < folder.messages.len() {
        let message = &folder.messages[position];
        let chosen = only.is_none_or(|set| set.contains(&message.uid));
        if chosen && message.has_flag("\\Deleted") {
            folder.messages.remove(position);
            removed.push(position + 1);
        } else {
            position += 1;
        }
    }
    removed
}

/// Answers APPEND: stores the literal in a folder that exists, with the
/// flags of the parenthesized group.
fn handle_append(command: &Command, mailbox: &mut FakeMailbox) -> Vec<u8> {
    let tag = &command.tag;
    let flags: Vec<&str> = command
        .arguments
        .iter()
        .find(|token| token.starts_with('('))
        .map(|token| token.trim_matches(['(', ')']).split_whitespace().collect())
        .unwrap_or_default();
    let (Some(name), Some(bytes)) = (command.arguments.first(), command.literals.last()) else {
        return format!("{tag} BAD Missing name or message\r\n").into_bytes();
    };
    if mailbox.find_folder(name).is_none() {
        return format!("{tag} NO [TRYCREATE] Mailbox doesn't exist\r\n").into_bytes();
    }
    let uid = mailbox.add_message(
        name,
        NewMessage {
            bytes: bytes.clone(),
            flags: &flags,
            timestamp: get_current_timestamp(),
        },
    );
    let uid_validity = mailbox.find_folder(name).expect("the folder").uid_validity;
    format!("{tag} OK [APPENDUID {uid_validity} {uid}] Append completed\r\n").into_bytes()
}

/// The answer to a command that needs a selected folder while none is.
fn build_no_mailbox_reply(tag: &str) -> Vec<u8> {
    format!("{tag} BAD No mailbox selected\r\n").into_bytes()
}

/// The capabilities advertised in the state.
fn build_capabilities(mode: ImapMode, secured: bool, state: &Arc<Mutex<FakeMailbox>>) -> String {
    let mut capabilities = vec!["IMAP4rev1"];
    let mailbox = state.lock().expect("the state");
    if mailbox.literal_plus {
        capabilities.push("LITERAL+");
    }
    if mailbox.uid_plus {
        capabilities.push("UIDPLUS");
    }
    let offers_starttls = match mode {
        ImapMode::StartTls | ImapMode::StartTlsRefused => !secured,
        ImapMode::Tls | ImapMode::Plain | ImapMode::Silent | ImapMode::Garbage => false,
    };
    if offers_starttls {
        capabilities.push("STARTTLS");
    }
    capabilities.join(" ")
}

/// Reads one command, with its literals, which are shown in the text as
/// quoted strings.
///
/// A command ends before a synchronizing literal, which the client then
/// never sends, when the fake refuses it by its name or by a text of the
/// line before that literal, or fails it with [`ImapFault::Stall`] or
/// [`ImapFault::Close`]. Every other synchronizing literal is asked for as
/// [`send_continuation`] does, and read: that of a command refused by a
/// text after it, which [`Session::handle_command`] then refuses, and that
/// of a command failed after handling. A non-synchronizing literal, `{n+}`,
/// is read without being asked for; without LITERAL+, a line that ends in
/// one ends the command there, its marker kept in the text.
///
/// # Arguments
///
/// * `reader` - The connection.
/// * `state` - The mailbox, which says which commands are refused or
///   failed, and what to write before a continuation request.
///
/// # Returns
///
/// The command's text and its literals; `None` when the connection fails,
/// or ends before the command or within a literal.
async fn read_command<S>(
    reader: &mut BufReader<S>,
    state: &Arc<Mutex<FakeMailbox>>,
) -> Option<(String, Vec<Vec<u8>>)>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let mut line = String::new();
    let count = reader.read_line(&mut line).await.ok()?;
    if count == 0 {
        return None;
    }
    let mut text = line.trim_end_matches(['\r', '\n']).to_owned();
    let mut literals = Vec::new();
    while let Some((length, synchronizing)) = parse_trailing_literal(&text) {
        if !synchronizing && !state.lock().expect("the state").literal_plus {
            break;
        }
        let cut = text.rfind('{')?;
        text.truncate(cut);
        if synchronizing {
            if is_answered_before_literal(&text, state) {
                return Some((text, literals));
            }
            send_continuation(reader, state).await;
        }
        let mut bytes = vec![0; length];
        reader.read_exact(&mut bytes).await.ok()?;
        text.push_str(&build_quoted_string(&String::from_utf8_lossy(&bytes)));
        literals.push(bytes);
        let mut rest = String::new();
        reader.read_line(&mut rest).await.ok()?;
        text.push_str(rest.trim_end_matches(['\r', '\n']));
    }
    Some((text, literals))
}

/// Asks the client for a literal with `+ OK`, after the mailbox's untagged
/// line, if it has one.
///
/// # Arguments
///
/// * `reader` - The connection.
/// * `state` - The mailbox, which holds the untagged line.
async fn send_continuation<S>(reader: &mut BufReader<S>, state: &Arc<Mutex<FakeMailbox>>)
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let untagged = state
        .lock()
        .expect("the state")
        .untagged_before_continuation
        .clone();
    if let Some(untagged) = untagged {
        send_line(reader, &format!("{untagged}\r\n")).await;
    }
    send_line(reader, "+ OK\r\n").await;
}

/// Whether the fake refuses the command the text begins, or fails it
/// before handling it, so that it never asks for the command's literal.
fn is_answered_before_literal(text: &str, state: &Arc<Mutex<FakeMailbox>>) -> bool {
    parse_command(text, Vec::new()).is_some_and(|command| {
        let mailbox = state.lock().expect("the state");
        let fault = mailbox.find_fault(&command.name);
        mailbox.find_refusal(&command).is_some() || fault.is_some_and(ImapFault::is_before_handling)
    })
}

/// Finds a literal marker, `{n}` or `{n+}`, at the end of the text.
fn parse_trailing_literal(text: &str) -> Option<(usize, bool)> {
    let inner = text.strip_suffix('}')?;
    let start = inner.rfind('{')?;
    let marker = &inner[start + 1..];
    let (digits, synchronizing) = match marker.strip_suffix('+') {
        Some(digits) => (digits, false),
        None => (marker, true),
    };
    if digits.is_empty() || !digits.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    Some((digits.parse().ok()?, synchronizing))
}

/// Builds the quoted string IMAP writes for a text.
fn build_quoted_string(text: &str) -> String {
    format!("\"{}\"", text.replace('\\', "\\\\").replace('"', "\\\""))
}

/// Splits a command into tokens: atoms, the contents of quoted strings,
/// and parenthesized groups kept whole.
fn parse_tokens(text: &str) -> Vec<String> {
    let mut tokenizer = Tokenizer::default();
    let mut characters = text.chars();
    while let Some(character) = characters.next() {
        if tokenizer.quoted {
            tokenizer.read_quoted(character, &mut characters);
        } else {
            tokenizer.read_plain(character);
        }
    }
    tokenizer.list_tokens()
}

/// What [`tokenize`] has read of a command so far.
///
/// Concurrency model: single-owner; one [`tokenize`] call owns it and
/// feeds it one character at a time.
#[derive(Default)]
struct Tokenizer {
    /// The tokens ended so far.
    tokens: Vec<String>,
    /// The token being read.
    current: String,
    /// How many parentheses are open; negative after a stray `)`.
    parentheses: i32,
    /// How many brackets are open; negative after a stray `]`.
    brackets: i32,
    /// Whether a quoted string is being read.
    quoted: bool,
}

impl Tokenizer {
    /// Whether the text read so far is inside a parenthesized or bracketed
    /// group, which keeps its quotes and spaces.
    fn is_nested(&self) -> bool {
        self.parentheses > 0 || self.brackets > 0
    }

    /// Ends the token being read.
    fn add_token(&mut self) {
        self.tokens.push(std::mem::take(&mut self.current));
    }

    /// Reads one character of a quoted string: a backslash takes the next
    /// character with it, and a quote ends the string.
    fn read_quoted(&mut self, character: char, characters: &mut std::str::Chars<'_>) {
        let nested = self.is_nested();
        match character {
            '\\' => {
                if let Some(next) = characters.next() {
                    if nested {
                        self.current.push('\\');
                    }
                    self.current.push(next);
                }
            }
            '"' => {
                self.quoted = false;
                if nested {
                    self.current.push('"');
                } else {
                    self.add_token();
                }
            }
            _ => self.current.push(character),
        }
    }

    /// Reads one character outside a quoted string.
    fn read_plain(&mut self, character: char) {
        let nested = self.is_nested();
        match character {
            '"' => {
                self.quoted = true;
                if nested {
                    self.current.push('"');
                }
            }
            '(' => {
                self.parentheses += 1;
                self.current.push(character);
            }
            ')' => {
                self.parentheses -= 1;
                self.current.push(character);
                if self.parentheses == 0 && self.brackets == 0 {
                    self.add_token();
                }
            }
            '[' => {
                self.brackets += 1;
                self.current.push(character);
            }
            ']' => {
                self.brackets -= 1;
                self.current.push(character);
            }
            ' ' if !nested => {
                if !self.current.is_empty() {
                    self.add_token();
                }
            }
            _ => self.current.push(character),
        }
    }

    /// Ends the last token, if any, and returns every token in order.
    fn list_tokens(mut self) -> Vec<String> {
        if !self.current.is_empty() {
            self.add_token();
        }
        self.tokens
    }
}

/// Parses a UID set such as `1,3:5,*`.
fn parse_set(text: &str, folder: &FakeFolder) -> Vec<u32> {
    let highest = folder.messages.last().map_or(0, |message| message.uid);
    let bound = |part: &str| parse_set_bound(part, highest);
    let mut uids = Vec::new();
    for item in text.split(',') {
        match item.split_once(':') {
            Some((low, high)) => {
                if let (Some(low), Some(high)) = (bound(low), bound(high)) {
                    uids.extend(low.min(high)..=low.max(high));
                }
            }
            None => {
                if let Some(uid) = bound(item) {
                    uids.push(uid);
                }
            }
        }
    }
    uids
}

/// Parses one end of a UID range: a number, or `*` for the highest UID.
fn parse_set_bound(part: &str, highest: u32) -> Option<u32> {
    if part == "*" {
        return Some(highest);
    }
    part.parse().ok()
}

/// The header fields of a message, unfolded, as (lower-case name, value).
fn parse_header_fields(bytes: &[u8]) -> Vec<(String, String)> {
    let text = String::from_utf8_lossy(bytes);
    let header = text.split("\r\n\r\n").next().unwrap_or_default();
    let mut fields: Vec<(String, String)> = Vec::new();
    for line in header.split("\r\n") {
        if line.starts_with([' ', '\t']) {
            if let Some(last) = fields.last_mut() {
                last.1.push(' ');
                last.1.push_str(line.trim());
            }
        } else if let Some((name, value)) = line.split_once(':') {
            fields.push((name.trim().to_ascii_lowercase(), value.trim().to_owned()));
        }
    }
    fields
}

/// The raw lines of the header fields with the names, each with its
/// folded continuation lines, followed by an empty line.
fn build_header_subset(bytes: &[u8], names: &[String]) -> Vec<u8> {
    let text = String::from_utf8_lossy(bytes);
    let header = text.split("\r\n\r\n").next().unwrap_or_default();
    let mut subset = String::new();
    let mut keep = false;
    for line in header.split("\r\n") {
        if !line.starts_with([' ', '\t']) {
            keep = line.split_once(':').is_some_and(|(name, _)| {
                names
                    .iter()
                    .any(|wanted| wanted.eq_ignore_ascii_case(name.trim()))
            });
        }
        if keep {
            subset.push_str(line);
            subset.push_str("\r\n");
        }
    }
    subset.push_str("\r\n");
    subset.into_bytes()
}

/// Searches the folder with the keys, answering UIDs in ascending order.
///
/// The keys are first read against a blank message, before any message
/// of the folder is matched, so that keys the fake cannot read get `BAD`
/// in a folder without messages too; where reading them fails does not
/// depend on the message.
///
/// # Arguments
///
/// * `folder` - The folder to search.
/// * `keys` - The SEARCH command's arguments: the keys, after a `CHARSET`
///   and its name when they begin with one.
///
/// # Returns
///
/// The UIDs of the messages that match every key, or, as the text of the
/// fake's `BAD` answer, why the keys cannot be read: an `OR` or a `NOT`
/// without the keys it takes, a key without its argument, a date that
/// does not parse, or a key the fake does not know.
fn list_search_matches(folder: &FakeFolder, keys: &[String]) -> Result<Vec<u32>, String> {
    let start = if keys
        .first()
        .is_some_and(|key| key.eq_ignore_ascii_case("CHARSET"))
    {
        2
    } else {
        0
    };
    let cursor = SearchKeys { keys, index: start };
    let blank = FakeMessage {
        uid: 0,
        flags: Vec::new(),
        timestamp: 0,
        bytes: Vec::new(),
    };
    cursor.calculate_match(&blank, folder)?;
    let mut uids = Vec::new();
    for message in &folder.messages {
        if cursor.calculate_match(message, folder)? {
            uids.push(message.uid);
        }
    }
    Ok(uids)
}

/// A position in the keys of a SEARCH command.
///
/// Concurrency model: single-owner; [`list_search_matches`] holds the
/// start, and each [`Self::calculate_match`] call moves a copy of it
/// forward one key at a time.
#[derive(Clone, Copy)]
struct SearchKeys<'a> {
    /// The keys.
    keys: &'a [String],
    /// The index of the next key.
    index: usize,
}

impl SearchKeys<'_> {
    /// Calculates whether the message matches every key from this
    /// position on.
    ///
    /// # Arguments
    ///
    /// * `message` - The message to match.
    /// * `folder` - Its folder, whose highest UID a `*` in a UID set means.
    ///
    /// # Returns
    ///
    /// Whether it matches them all, or why the keys cannot be read, as
    /// [`Self::calculate_next_match`] gives it.
    fn calculate_match(
        mut self,
        message: &FakeMessage,
        folder: &FakeFolder,
    ) -> Result<bool, String> {
        let mut matched = true;
        while self.index < self.keys.len() {
            matched &= self.calculate_next_match(message, folder)?;
        }
        Ok(matched)
    }

    /// Reads the argument after a key, advancing past it.
    ///
    /// # Arguments
    ///
    /// * `key` - The key the argument belongs to, for the failure's text.
    ///
    /// # Returns
    ///
    /// The argument, or `<key> needs an argument` when the keys end first.
    fn read_argument(&mut self, key: &str) -> Result<String, String> {
        let value = self
            .keys
            .get(self.index)
            .cloned()
            .ok_or(format!("{key} needs an argument"))?;
        self.index += 1;
        Ok(value)
    }

    /// Calculates whether the message matches the next search key,
    /// advancing past the key and its arguments.
    ///
    /// # Arguments
    ///
    /// * `message` - The message to match.
    /// * `folder` - Its folder, whose highest UID a `*` in a UID set means.
    ///
    /// # Returns
    ///
    /// Whether it matches, or why the keys cannot be read: `a key is
    /// missing` when no key is left, as after an `OR` or a `NOT` without
    /// the keys it takes, `<key> needs an argument`, `a bad date` for a
    /// date that does not parse, or `unknown search key <key>`.
    fn calculate_next_match(
        &mut self,
        message: &FakeMessage,
        folder: &FakeFolder,
    ) -> Result<bool, String> {
        let key = self
            .keys
            .get(self.index)
            .ok_or("a key is missing")?
            .to_ascii_uppercase();
        self.index += 1;
        if let Some(matched) = calculate_flag_match(&key, message) {
            return Ok(matched);
        }
        let days = message.timestamp.div_euclid(86_400);
        Ok(match key.as_str() {
            "TEXT" | "BODY" | "FROM" | "TO" | "CC" | "SUBJECT" | "HEADER" => {
                self.calculate_text_match(&key, message)?
            }
            "SINCE" => days >= parse_search_date(&self.read_argument(&key)?).ok_or("a bad date")?,
            "BEFORE" => days < parse_search_date(&self.read_argument(&key)?).ok_or("a bad date")?,
            "ON" => days == parse_search_date(&self.read_argument(&key)?).ok_or("a bad date")?,
            "OR" => {
                let left = self.calculate_next_match(message, folder)?;
                let right = self.calculate_next_match(message, folder)?;
                left || right
            }
            "NOT" => !self.calculate_next_match(message, folder)?,
            "UID" => parse_set(&self.read_argument(&key)?, folder).contains(&message.uid),
            _ => return Err(format!("unknown search key {key}")),
        })
    }

    /// Calculates whether the message matches a key that searches its text,
    /// `TEXT`, `BODY`, `HEADER`, or a header field such as `SUBJECT`,
    /// advancing past the key's arguments. Letter case is ignored.
    ///
    /// # Arguments
    ///
    /// * `key` - The key, in capitals.
    /// * `message` - The message to match.
    ///
    /// # Returns
    ///
    /// Whether it matches, or `<key> needs an argument` when the keys end
    /// before the key's arguments do.
    fn calculate_text_match(&mut self, key: &str, message: &FakeMessage) -> Result<bool, String> {
        let fields = parse_header_fields(&message.bytes);
        Ok(match key {
            "TEXT" => {
                let needle = self.read_argument(key)?.to_lowercase();
                String::from_utf8_lossy(&message.bytes)
                    .to_lowercase()
                    .contains(&needle)
            }
            "BODY" => {
                let needle = self.read_argument(key)?.to_lowercase();
                let text = String::from_utf8_lossy(&message.bytes);
                text.split_once("\r\n\r\n")
                    .map(|(_, body)| body.to_lowercase().contains(&needle))
                    .unwrap_or(false)
            }
            "HEADER" => {
                let name = self.read_argument(key)?.to_ascii_lowercase();
                let needle = self.read_argument(key)?;
                has_field_containing(&fields, &name, &needle)
            }
            _ => {
                let needle = self.read_argument(key)?;
                has_field_containing(&fields, &key.to_ascii_lowercase(), &needle)
            }
        })
    }
}

/// Whether a header field of the name holds the text, in any letter case.
///
/// # Arguments
///
/// * `fields` - A message's header fields, from [`parse_header_fields`].
/// * `name` - The field's name, in lower case.
/// * `needle` - The text to find.
fn has_field_containing(fields: &[(String, String)], name: &str, needle: &str) -> bool {
    let needle = needle.to_lowercase();
    fields
        .iter()
        .filter(|(field, _)| field == name)
        .any(|(_, value)| value.to_lowercase().contains(&needle))
}

/// Calculates whether the message matches `ALL` or a key that tests a flag,
/// such as `UNSEEN`.
///
/// # Returns
///
/// Whether it matches, or `None` for any other key.
fn calculate_flag_match(key: &str, message: &FakeMessage) -> Option<bool> {
    let (flag, wanted) = match key {
        "ALL" => return Some(true),
        "SEEN" => ("\\Seen", true),
        "UNSEEN" => ("\\Seen", false),
        "FLAGGED" => ("\\Flagged", true),
        "UNFLAGGED" => ("\\Flagged", false),
        "DELETED" => ("\\Deleted", true),
        "UNDELETED" => ("\\Deleted", false),
        "DRAFT" => ("\\Draft", true),
        "UNDRAFT" => ("\\Draft", false),
        "ANSWERED" => ("\\Answered", true),
        "UNANSWERED" => ("\\Answered", false),
        _ => return None,
    };
    Some(message.has_flag(flag) == wanted)
}

/// Answers a FETCH of the set with the items.
fn handle_folder_fetch(folder: &mut FakeFolder, arguments: &[String], tag: &str) -> Vec<u8> {
    let (Some(set), Some(items)) = (arguments.first(), arguments.get(1)) else {
        return format!("{tag} BAD Missing set or items\r\n").into_bytes();
    };
    let uids = parse_set(set, folder);
    let items = parse_tokens(items.trim_start_matches('(').trim_end_matches(')'));
    let mut answer = Vec::new();
    for position in 0..folder.messages.len() {
        let message = &folder.messages[position];
        if !uids.contains(&message.uid) {
            continue;
        }
        let mut parts = Vec::new();
        let mut mark_seen = false;
        for item in &items {
            match build_fetch_part(item, message) {
                Ok((part, marks_seen)) => {
                    parts.push(part);
                    mark_seen |= marks_seen;
                }
                Err(reason) => return format!("{tag} BAD {reason}\r\n").into_bytes(),
            }
        }
        if mark_seen && !folder.messages[position].has_flag("\\Seen") {
            folder.messages[position].flags.push("\\Seen".to_owned());
        }
        answer.extend_from_slice(&build_fetch_line(position + 1, &parts));
    }
    answer.extend_from_slice(format!("{tag} OK Fetch completed\r\n").as_bytes());
    answer
}

/// Builds one item of a message's FETCH answer.
///
/// # Returns
///
/// The item's bytes with whether fetching it marks the message seen, or
/// why the item is not supported.
fn build_fetch_part(item: &str, message: &FakeMessage) -> Result<(Vec<u8>, bool), String> {
    let upper = item.to_ascii_uppercase();
    if let Some(section) = upper
        .strip_prefix("BODY.PEEK[")
        .or_else(|| upper.strip_prefix("BODY["))
    {
        let section = section.trim_end_matches(']');
        let content = build_section_content(section, message).ok_or("Unsupported section")?;
        let mut part = format!("BODY[{section}] {{{}}}\r\n", content.len()).into_bytes();
        part.extend_from_slice(&content);
        return Ok((part, !upper.starts_with("BODY.PEEK[")));
    }
    let part = match upper.as_str() {
        "UID" => format!("UID {}", message.uid),
        "FLAGS" => format!("FLAGS ({})", message.flags.join(" ")),
        "INTERNALDATE" => format!(
            "INTERNALDATE \"{}\"",
            build_internal_date(message.timestamp)
        ),
        "RFC822.SIZE" => format!("RFC822.SIZE {}", message.bytes.len()),
        _ => return Err(format!("Unsupported item {item}")),
    };
    Ok((part.into_bytes(), false))
}

/// Builds the content of a BODY section: the whole message for an empty
/// section, or the header fields a `HEADER.FIELDS` section names.
///
/// # Returns
///
/// The content, or `None` for any other section.
fn build_section_content(section: &str, message: &FakeMessage) -> Option<Vec<u8>> {
    if section.is_empty() {
        return Some(message.bytes.clone());
    }
    let names: Vec<String> = section
        .strip_prefix("HEADER.FIELDS ")?
        .trim_matches(['(', ')'])
        .split_whitespace()
        .map(str::to_owned)
        .collect();
    Some(build_header_subset(&message.bytes, &names))
}

/// Builds one message's FETCH line from its items.
///
/// # Arguments
///
/// * `number` - The message's sequence number.
/// * `parts` - The items, in the order the command named them.
fn build_fetch_line(number: usize, parts: &[Vec<u8>]) -> Vec<u8> {
    let mut line = format!("* {number} FETCH (").into_bytes();
    line.extend_from_slice(&parts.join(&b' '));
    line.extend_from_slice(b")\r\n");
    line
}

/// Answers a STORE of flags on the set.
fn handle_folder_store(folder: &mut FakeFolder, arguments: &[String], tag: &str) -> Vec<u8> {
    let (Some(set), Some(item), Some(list)) =
        (arguments.first(), arguments.get(1), arguments.get(2))
    else {
        return format!("{tag} BAD Missing set, item, or flags\r\n").into_bytes();
    };
    let uids = parse_set(set, folder);
    let flags: Vec<String> = list
        .trim_matches(['(', ')'])
        .split_whitespace()
        .map(str::to_owned)
        .collect();
    let upper = item.to_ascii_uppercase();
    let silent = upper.ends_with(".SILENT");
    let mut answer = String::new();
    for position in 0..folder.messages.len() {
        let message = &mut folder.messages[position];
        if !uids.contains(&message.uid) {
            continue;
        }
        update_message_flags(message, &upper, &flags);
        if !silent {
            answer.push_str(&format!(
                "* {} FETCH (FLAGS ({}))\r\n",
                position + 1,
                message.flags.join(" ")
            ));
        }
    }
    answer.push_str(&format!("{tag} OK Store completed\r\n"));
    answer.into_bytes()
}

/// Changes a message's flags as a STORE item says: adds them for `+FLAGS`,
/// removes them for `-FLAGS`, and replaces them for `FLAGS`.
///
/// # Arguments
///
/// * `message` - The message.
/// * `item` - The STORE item in capitals, such as `+FLAGS.SILENT`.
/// * `flags` - The flags the command lists.
fn update_message_flags(message: &mut FakeMessage, item: &str, flags: &[String]) {
    if item.starts_with('+') {
        for flag in flags {
            if !message.has_flag(flag) {
                message.flags.push(flag.clone());
            }
        }
    } else if item.starts_with('-') {
        message
            .flags
            .retain(|existing| !flags.iter().any(|flag| flag.eq_ignore_ascii_case(existing)));
    } else {
        message.flags = flags.to_vec();
    }
}

/// Writes text, ignoring a closed connection.
async fn send_line<S>(reader: &mut BufReader<S>, text: &str)
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    send_bytes(reader, text.as_bytes()).await;
}

/// Writes bytes, ignoring a closed connection.
async fn send_bytes<S>(reader: &mut BufReader<S>, bytes: &[u8])
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let _ = reader.get_mut().write_all(bytes).await;
    let _ = reader.get_mut().flush().await;
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A session on a plain connection, with no folder selected.
    fn build_session() -> Session {
        Session {
            mode: ImapMode::Plain,
            secured: false,
            capabilities: String::new(),
            selected: None,
        }
    }

    /// Sends one command line without a literal to the session, and gives
    /// the fake's answer.
    ///
    /// # Panics
    ///
    /// When the line has no tag, or the session upgrades the connection or
    /// ends instead of answering.
    fn send_command(session: &mut Session, mailbox: &mut FakeMailbox, line: &str) -> String {
        let command = parse_command(line, Vec::new()).expect("a tagged command");
        match session.handle_command(&command, mailbox) {
            Step::Answer(answer) => String::from_utf8_lossy(&answer).into_owned(),
            Step::StartTls(_) | Step::Logout(_) => panic!("the session did not answer {line}"),
        }
    }

    #[test]
    fn answers_bad_to_uid_without_a_command_name() {
        let mut mailbox = FakeMailbox::create_standard();
        let mut session = build_session();

        let answer = send_command(&mut session, &mut mailbox, "a1 UID");

        assert_eq!(answer, "a1 BAD Error in IMAP command: Unknown command\r\n");
    }

    #[test]
    fn leaves_no_folder_selected_after_a_failed_select_or_a_refused_examine() {
        let mut mailbox = FakeMailbox::create_standard();
        mailbox.add_refusal("EXAMINE", "NO [UNAVAILABLE] Try again later");
        let mut session = build_session();

        send_command(&mut session, &mut mailbox, "a1 SELECT INBOX");
        let selected = send_command(&mut session, &mut mailbox, "a2 UID SEARCH ALL");
        let missing = send_command(&mut session, &mut mailbox, "a3 SELECT Missing");
        let after_missing = send_command(&mut session, &mut mailbox, "a4 UID SEARCH ALL");
        send_command(&mut session, &mut mailbox, "a5 SELECT INBOX");
        let refused = send_command(&mut session, &mut mailbox, "a6 EXAMINE INBOX");
        let after_refused = send_command(&mut session, &mut mailbox, "a7 UID SEARCH ALL");

        assert_eq!(selected, "* SEARCH\r\na2 OK Search completed\r\n");
        assert_eq!(missing, "a3 NO Mailbox doesn't exist\r\n");
        assert_eq!(after_missing, "a4 BAD No mailbox selected\r\n");
        assert_eq!(refused, "a6 NO [UNAVAILABLE] Try again later\r\n");
        assert_eq!(after_refused, "a7 BAD No mailbox selected\r\n");
    }

    #[test]
    fn answers_a_folder_without_messages_with_no_uids_or_bad_for_keys_it_cannot_read() {
        let mailbox = FakeMailbox::create_standard();
        let readable = parse_command("a1 UID SEARCH UNSEEN SINCE 1-Nov-2026", Vec::new())
            .expect("a tagged command");
        let unreadable =
            parse_command("a2 UID SEARCH CHEAP", Vec::new()).expect("a tagged command");

        let found = handle_search(&readable, &mailbox, Some("INBOX"));
        let refused = handle_search(&unreadable, &mailbox, Some("INBOX"));

        assert_eq!(
            String::from_utf8_lossy(&found),
            "* SEARCH\r\na1 OK Search completed\r\n"
        );
        assert_eq!(
            String::from_utf8_lossy(&refused),
            "a2 BAD unknown search key CHEAP\r\n"
        );
    }
}
