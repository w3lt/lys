//! A fake IMAP server: folders and messages in memory, the commands the
//! email server sends, TLS or STARTTLS, and a log of every command.

use std::sync::{Arc, Mutex};

use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream};
use tokio_rustls::TlsAcceptor;

use super::{PASSWORD, USER_NAME, format_internal_date, get_current_timestamp, parse_search_date};

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
    /// Accepts the connection and never writes.
    Silent,
    /// Greets with text that is not IMAP, then closes.
    Garbage,
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
#[derive(Debug)]
pub struct FakeMailbox {
    /// The folders, in listing order.
    pub folders: Vec<FakeFolder>,
    /// Every command received, in order, with literals shown as quoted
    /// strings.
    pub commands: Vec<String>,
    /// Whether UIDPLUS is advertised.
    pub uid_plus: bool,
    /// The hierarchy delimiter.
    pub delimiter: String,
    /// The UIDVALIDITY the next created folder gets.
    next_uid_validity: u32,
}

impl FakeMailbox {
    /// A mailbox without folders.
    pub fn create_empty() -> Self {
        Self {
            folders: Vec::new(),
            commands: Vec::new(),
            uid_plus: true,
            delimiter: "/".to_owned(),
            next_uid_validity: 2001,
        }
    }

    /// The usual folders: INBOX, Sent, Drafts, Trash, an All Mail view, a
    /// plain Projects folder, and a parent that cannot hold messages.
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
    /// # Returns
    ///
    /// The message's UID.
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
}

/// What every connection of the fake shares.
#[derive(Clone)]
struct ConnectionSetup {
    /// How the fake protects its connections.
    mode: ImapMode,
    /// The TLS acceptor, for the TLS modes.
    acceptor: Option<TlsAcceptor>,
    /// The folders, the messages, and what the fake has seen.
    state: Arc<Mutex<FakeMailbox>>,
}

/// Serves one connection in the setup's mode.
async fn handle_connection(stream: TcpStream, setup: ConnectionSetup) {
    match setup.mode {
        ImapMode::Silent => {
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
/// Owned by the task that serves the connection, which handles its
/// commands one at a time.
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

/// Handles the session's commands until LOGOUT, the end of the stream,
/// or an accepted STARTTLS, which hands the stream back for the upgrade.
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
    let mut session = Session {
        mode: setup.mode,
        secured,
        capabilities: format_capabilities(setup.mode, secured, &setup.state),
        selected: None,
    };
    if !secured || setup.mode == ImapMode::Tls {
        send_line(
            &mut reader,
            &format!("* OK [CAPABILITY {}] Fake ready\r\n", session.capabilities),
        )
        .await;
    }
    loop {
        let (text, literals) = read_command(&mut reader).await?;
        setup
            .state
            .lock()
            .expect("the state")
            .commands
            .push(text.clone());
        let Some(command) = parse_command(&text, literals) else {
            continue;
        };
        let step = {
            let mut mailbox = setup.state.lock().expect("the state");
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

/// Splits a command's text into its tag, name, and arguments.
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
    let by_uid = name == "UID";
    if by_uid {
        name = arguments
            .first()
            .map(|token| token.to_ascii_uppercase())
            .unwrap_or_default();
        arguments.remove(0);
    }
    Some(Command {
        tag,
        name,
        by_uid,
        arguments,
        literals,
    })
}

impl Session {
    /// Handles one command over the mailbox, which it may change.
    fn handle_command(&mut self, command: &Command, mailbox: &mut FakeMailbox) -> Step {
        let tag = &command.tag;
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
    if mode == ImapMode::StartTls && !secured {
        return Step::StartTls(format!("{tag} OK Begin TLS negotiation now\r\n"));
    }
    Step::Answer(format!("{tag} NO STARTTLS is not available\r\n").into_bytes())
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
        return format_no_mailbox_reply(tag);
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
        None => format_no_mailbox_reply(&command.tag),
    }
}

/// Answers STORE over the selected folder.
fn handle_store(command: &Command, mailbox: &mut FakeMailbox, selected: Option<&str>) -> Vec<u8> {
    match selected.and_then(|name| mailbox.find_folder_mut(name)) {
        Some(folder) => handle_folder_store(folder, &command.arguments, &command.tag),
        None => format_no_mailbox_reply(&command.tag),
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
        return format_no_mailbox_reply(tag);
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
fn format_no_mailbox_reply(tag: &str) -> Vec<u8> {
    format!("{tag} BAD No mailbox selected\r\n").into_bytes()
}

/// The capabilities advertised in the state.
fn format_capabilities(mode: ImapMode, secured: bool, state: &Arc<Mutex<FakeMailbox>>) -> String {
    let mut capabilities = vec!["IMAP4rev1", "LITERAL+"];
    if state.lock().expect("the state").uid_plus {
        capabilities.push("UIDPLUS");
    }
    if matches!(mode, ImapMode::StartTls | ImapMode::StartTlsRefused) && !secured {
        capabilities.push("STARTTLS");
    }
    capabilities.join(" ")
}

/// Reads one command, with its literals, which are shown in the text as
/// quoted strings.
async fn read_command<S>(reader: &mut BufReader<S>) -> Option<(String, Vec<Vec<u8>>)>
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
        let cut = text.rfind('{')?;
        text.truncate(cut);
        if synchronizing {
            send_line(reader, "+ OK\r\n").await;
        }
        let mut bytes = vec![0; length];
        reader.read_exact(&mut bytes).await.ok()?;
        text.push_str(&format_quoted(&String::from_utf8_lossy(&bytes)));
        literals.push(bytes);
        let mut rest = String::new();
        reader.read_line(&mut rest).await.ok()?;
        text.push_str(rest.trim_end_matches(['\r', '\n']));
    }
    Some((text, literals))
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

/// Quotes a string as IMAP writes it.
fn format_quoted(text: &str) -> String {
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
/// Owned by one [`tokenize`] call, which feeds it one character at a time.
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
    let bound = |part: &str| -> Option<u32> {
        if part == "*" {
            Some(highest)
        } else {
            part.parse().ok()
        }
    };
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
fn list_search_matches(folder: &FakeFolder, keys: &[String]) -> Result<Vec<u32>, String> {
    let start = if keys
        .first()
        .is_some_and(|key| key.eq_ignore_ascii_case("CHARSET"))
    {
        2
    } else {
        0
    };
    let mut uids = Vec::new();
    for message in &folder.messages {
        let mut cursor = SearchKeys { keys, index: start };
        let mut matched = true;
        while cursor.index < keys.len() {
            matched &= cursor.calculate_next_match(message, folder)?;
        }
        if matched {
            uids.push(message.uid);
        }
    }
    Ok(uids)
}

/// A position in the keys of a SEARCH command.
struct SearchKeys<'a> {
    /// The keys.
    keys: &'a [String],
    /// The index of the next key.
    index: usize,
}

impl SearchKeys<'_> {
    /// Reads the next key's argument, advancing past it.
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
        let fields = parse_header_fields(&message.bytes);
        let field_contains = |name: &str, needle: &str| {
            fields
                .iter()
                .filter(|(field, _)| field == name)
                .any(|(_, value)| value.to_lowercase().contains(&needle.to_lowercase()))
        };
        let days = message.timestamp.div_euclid(86_400);
        Ok(match key.as_str() {
            "ALL" => true,
            "SEEN" => message.has_flag("\\Seen"),
            "UNSEEN" => !message.has_flag("\\Seen"),
            "FLAGGED" => message.has_flag("\\Flagged"),
            "UNFLAGGED" => !message.has_flag("\\Flagged"),
            "DELETED" => message.has_flag("\\Deleted"),
            "UNDELETED" => !message.has_flag("\\Deleted"),
            "DRAFT" => message.has_flag("\\Draft"),
            "UNDRAFT" => !message.has_flag("\\Draft"),
            "ANSWERED" => message.has_flag("\\Answered"),
            "UNANSWERED" => !message.has_flag("\\Answered"),
            "TEXT" => {
                let needle = self.read_argument(&key)?.to_lowercase();
                String::from_utf8_lossy(&message.bytes)
                    .to_lowercase()
                    .contains(&needle)
            }
            "BODY" => {
                let needle = self.read_argument(&key)?.to_lowercase();
                let text = String::from_utf8_lossy(&message.bytes);
                text.split_once("\r\n\r\n")
                    .map(|(_, body)| body.to_lowercase().contains(&needle))
                    .unwrap_or(false)
            }
            "FROM" | "TO" | "CC" | "SUBJECT" => {
                let needle = self.read_argument(&key)?;
                field_contains(&key.to_ascii_lowercase(), &needle)
            }
            "HEADER" => {
                let name = self.read_argument(&key)?.to_ascii_lowercase();
                let needle = self.read_argument(&key)?;
                field_contains(&name, &needle)
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
        if !uids.contains(&folder.messages[position].uid) {
            continue;
        }
        let mut parts: Vec<Vec<u8>> = Vec::new();
        let mut mark_seen = false;
        for item in &items {
            let upper = item.to_ascii_uppercase();
            let message = &folder.messages[position];
            if let Some(section) = upper
                .strip_prefix("BODY.PEEK[")
                .or_else(|| upper.strip_prefix("BODY["))
            {
                let section = section.trim_end_matches(']');
                mark_seen |= !upper.starts_with("BODY.PEEK[");
                let content = if section.is_empty() {
                    message.bytes.clone()
                } else if let Some(list) = section.strip_prefix("HEADER.FIELDS ") {
                    let names: Vec<String> = list
                        .trim_matches(['(', ')'])
                        .split_whitespace()
                        .map(str::to_owned)
                        .collect();
                    build_header_subset(&message.bytes, &names)
                } else {
                    return format!("{tag} BAD Unsupported section\r\n").into_bytes();
                };
                let mut part = format!("BODY[{section}] {{{}}}\r\n", content.len()).into_bytes();
                part.extend_from_slice(&content);
                parts.push(part);
            } else {
                match upper.as_str() {
                    "UID" => parts.push(format!("UID {}", message.uid).into_bytes()),
                    "FLAGS" => {
                        parts.push(format!("FLAGS ({})", message.flags.join(" ")).into_bytes())
                    }
                    "INTERNALDATE" => parts.push(
                        format!(
                            "INTERNALDATE \"{}\"",
                            format_internal_date(message.timestamp)
                        )
                        .into_bytes(),
                    ),
                    "RFC822.SIZE" => {
                        parts.push(format!("RFC822.SIZE {}", message.bytes.len()).into_bytes())
                    }
                    _ => return format!("{tag} BAD Unsupported item {item}\r\n").into_bytes(),
                }
            }
        }
        if mark_seen && !folder.messages[position].has_flag("\\Seen") {
            folder.messages[position].flags.push("\\Seen".to_owned());
        }
        answer.extend_from_slice(format!("* {} FETCH (", position + 1).as_bytes());
        for (index, part) in parts.iter().enumerate() {
            if index > 0 {
                answer.push(b' ');
            }
            answer.extend_from_slice(part);
        }
        answer.extend_from_slice(b")\r\n");
    }
    answer.extend_from_slice(format!("{tag} OK Fetch completed\r\n").as_bytes());
    answer
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
        if upper.starts_with('+') {
            for flag in &flags {
                if !message.has_flag(flag) {
                    message.flags.push(flag.clone());
                }
            }
        } else if upper.starts_with('-') {
            message
                .flags
                .retain(|existing| !flags.iter().any(|flag| flag.eq_ignore_ascii_case(existing)));
        } else {
            message.flags = flags.clone();
        }
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
