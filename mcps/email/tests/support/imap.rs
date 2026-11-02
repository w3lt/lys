//! A fake IMAP server: folders and messages in memory, the commands the
//! email server sends, TLS or STARTTLS, and a log of every command.

use std::sync::{Arc, Mutex};

use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream};
use tokio_rustls::TlsAcceptor;

use super::{PASSWORD, USER_NAME, format_internal_date, now_timestamp, parse_search_date};

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
    pub fn selectable(&self) -> bool {
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
    pub fn empty() -> Self {
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
    pub fn standard() -> Self {
        let mut mailbox = Self::empty();
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
    pub fn add_message(
        &mut self,
        folder: &str,
        bytes: Vec<u8>,
        flags: &[&str],
        timestamp: i64,
    ) -> u32 {
        let folder = self.folder_mut(folder).expect("the folder exists");
        let uid = folder.next_uid;
        folder.next_uid += 1;
        folder.messages.push(FakeMessage {
            uid,
            flags: flags.iter().map(|flag| (*flag).to_owned()).collect(),
            timestamp,
            bytes,
        });
        uid
    }

    /// Finds a folder by name.
    pub fn folder(&self, name: &str) -> Option<&FakeFolder> {
        self.folders.iter().find(|folder| folder.name == name)
    }

    /// Finds a folder by name, to change it.
    pub fn folder_mut(&mut self, name: &str) -> Option<&mut FakeFolder> {
        self.folders.iter_mut().find(|folder| folder.name == name)
    }
}

/// The running fake.
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

    /// The commands received so far.
    pub fn commands(&self) -> Vec<String> {
        self.state.lock().expect("the state").commands.clone()
    }

    /// The messages of a folder.
    pub fn messages(&self, folder: &str) -> Vec<FakeMessage> {
        self.state
            .lock()
            .expect("the state")
            .folder(folder)
            .map(|folder| folder.messages.clone())
            .unwrap_or_default()
    }

    /// Runs a closure over the state.
    pub fn with_state<T>(&self, change: impl FnOnce(&mut FakeMailbox) -> T) -> T {
        change(&mut self.state.lock().expect("the state"))
    }
}

/// Serves one connection in the mode.
async fn handle_connection(
    stream: TcpStream,
    mode: ImapMode,
    acceptor: Option<TlsAcceptor>,
    state: Arc<Mutex<FakeMailbox>>,
) {
    match mode {
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
            let Some(acceptor) = acceptor else {
                return;
            };
            if let Ok(tls) = acceptor.accept(stream).await {
                run_session(tls, mode, true, state).await;
            }
        }
        ImapMode::StartTls => {
            if let Some(plain) = run_session(stream, mode, false, Arc::clone(&state)).await {
                let Some(acceptor) = acceptor else {
                    return;
                };
                if let Ok(tls) = acceptor.accept(plain).await {
                    run_session(tls, mode, true, state).await;
                }
            }
        }
        ImapMode::StartTlsRefused | ImapMode::Plain => {
            run_session(stream, mode, false, state).await;
        }
    }
}

/// Runs the dialogue until LOGOUT, the end of the stream, or an accepted
/// STARTTLS, which hands the stream back for the upgrade.
async fn run_session<S>(
    stream: S,
    mode: ImapMode,
    secured: bool,
    state: Arc<Mutex<FakeMailbox>>,
) -> Option<S>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let mut reader = BufReader::new(stream);
    let capabilities = capabilities(mode, secured, &state);
    if !secured || mode == ImapMode::Tls {
        write(
            &mut reader,
            &format!("* OK [CAPABILITY {capabilities}] Fake ready\r\n"),
        )
        .await;
    }
    let mut selected: Option<String> = None;
    loop {
        let (text, literals) = read_command(&mut reader).await?;
        state.lock().expect("the state").commands.push(text.clone());
        let tokens = tokenize(&text);
        let Some(tag) = tokens.first().cloned() else {
            continue;
        };
        let mut command = tokens
            .get(1)
            .map(|token| token.to_ascii_uppercase())
            .unwrap_or_default();
        let mut arguments: Vec<String> = tokens.iter().skip(2).cloned().collect();
        let by_uid = command == "UID";
        if by_uid {
            command = arguments
                .first()
                .map(|token| token.to_ascii_uppercase())
                .unwrap_or_default();
            arguments.remove(0);
        }
        let answer: Vec<u8> = match command.as_str() {
            "CAPABILITY" => {
                format!("* CAPABILITY {capabilities}\r\n{tag} OK Capability completed\r\n")
                    .into_bytes()
            }
            "NOOP" => format!("{tag} OK Noop completed\r\n").into_bytes(),
            "STARTTLS" => {
                if mode == ImapMode::StartTls && !secured {
                    write(
                        &mut reader,
                        &format!("{tag} OK Begin TLS negotiation now\r\n"),
                    )
                    .await;
                    return Some(reader.into_inner());
                }
                format!("{tag} NO STARTTLS is not available\r\n").into_bytes()
            }
            "LOGIN" => {
                if arguments.first().is_some_and(|user| user == USER_NAME)
                    && arguments
                        .get(1)
                        .is_some_and(|password| password == PASSWORD)
                {
                    format!("{tag} OK [CAPABILITY {capabilities}] Logged in\r\n").into_bytes()
                } else {
                    format!("{tag} NO [AUTHENTICATIONFAILED] Authentication failed.\r\n")
                        .into_bytes()
                }
            }
            "LOGOUT" => {
                write(
                    &mut reader,
                    &format!("* BYE Logging out\r\n{tag} OK Logout completed\r\n"),
                )
                .await;
                return None;
            }
            "LIST" => {
                let state = state.lock().expect("the state");
                let mut answer = String::new();
                for folder in &state.folders {
                    answer.push_str(&format!(
                        "* LIST ({}) \"{}\" \"{}\"\r\n",
                        folder.attributes.join(" "),
                        state.delimiter,
                        folder.name
                    ));
                }
                answer.push_str(&format!("{tag} OK List completed\r\n"));
                answer.into_bytes()
            }
            "STATUS" => {
                let state = state.lock().expect("the state");
                match arguments.first().and_then(|name| state.folder(name)) {
                    Some(folder) if folder.selectable() => format!(
                        "* STATUS \"{}\" (MESSAGES {})\r\n{tag} OK Status completed\r\n",
                        folder.name,
                        folder.messages.len()
                    )
                    .into_bytes(),
                    _ => format!("{tag} NO Mailbox doesn't exist\r\n").into_bytes(),
                }
            }
            "SELECT" | "EXAMINE" => {
                let state = state.lock().expect("the state");
                match arguments.first().and_then(|name| state.folder(name)) {
                    Some(folder) if folder.selectable() => {
                        selected = Some(folder.name.clone());
                        let access = if command == "SELECT" {
                            "READ-WRITE"
                        } else {
                            "READ-ONLY"
                        };
                        format!(
                            "* FLAGS (\\Answered \\Flagged \\Deleted \\Seen \\Draft)\r\n* OK [PERMANENTFLAGS (\\Answered \\Flagged \\Deleted \\Seen \\Draft \\*)] Flags permitted.\r\n* {} EXISTS\r\n* 0 RECENT\r\n* OK [UIDVALIDITY {}] UIDs valid\r\n* OK [UIDNEXT {}] Predicted next UID\r\n{tag} OK [{access}] {} completed\r\n",
                            folder.messages.len(),
                            folder.uid_validity,
                            folder.next_uid,
                            if command == "SELECT" { "Select" } else { "Examine" }
                        )
                        .into_bytes()
                    }
                    Some(_) => format!("{tag} NO Mailbox is not selectable\r\n").into_bytes(),
                    None => format!("{tag} NO Mailbox doesn't exist\r\n").into_bytes(),
                }
            }
            "CREATE" => {
                let mut state = state.lock().expect("the state");
                match arguments.first() {
                    Some(name) if state.folder(name).is_some() => {
                        format!("{tag} NO Mailbox already exists\r\n").into_bytes()
                    }
                    Some(name) => {
                        let uid_validity = state.next_uid_validity;
                        state.next_uid_validity += 1;
                        let folder = FakeFolder::new(name, &["\\HasNoChildren"], uid_validity);
                        state.folders.push(folder);
                        format!("{tag} OK Create completed\r\n").into_bytes()
                    }
                    None => format!("{tag} BAD Missing name\r\n").into_bytes(),
                }
            }
            "DELETE" => {
                let mut state = state.lock().expect("the state");
                match arguments
                    .first()
                    .and_then(|name| state.folders.iter().position(|folder| &folder.name == name))
                {
                    Some(index) => {
                        state.folders.remove(index);
                        format!("{tag} OK Delete completed\r\n").into_bytes()
                    }
                    None => format!("{tag} NO Mailbox doesn't exist\r\n").into_bytes(),
                }
            }
            "RENAME" => {
                let mut state = state.lock().expect("the state");
                match (arguments.first().cloned(), arguments.get(1).cloned()) {
                    (Some(old), Some(new)) => match state.folder_mut(&old) {
                        Some(folder) => {
                            folder.name = new;
                            format!("{tag} OK Rename completed\r\n").into_bytes()
                        }
                        None => format!("{tag} NO Mailbox doesn't exist\r\n").into_bytes(),
                    },
                    _ => format!("{tag} BAD Missing names\r\n").into_bytes(),
                }
            }
            "SEARCH" => {
                let state = state.lock().expect("the state");
                match selected.as_deref().and_then(|name| state.folder(name)) {
                    Some(folder) => match search(folder, &arguments) {
                        Ok(uids) => {
                            let listed: Vec<String> =
                                uids.iter().map(ToString::to_string).collect();
                            format!(
                                "* SEARCH{}{}\r\n{tag} OK Search completed\r\n",
                                if listed.is_empty() { "" } else { " " },
                                listed.join(" ")
                            )
                            .into_bytes()
                        }
                        Err(problem) => format!("{tag} BAD {problem}\r\n").into_bytes(),
                    },
                    None => format!("{tag} BAD No mailbox selected\r\n").into_bytes(),
                }
            }
            "FETCH" => {
                let mut state = state.lock().expect("the state");
                match selected
                    .as_deref()
                    .and_then(|name| state.folders.iter().position(|folder| folder.name == name))
                {
                    Some(index) => fetch(&mut state.folders[index], &arguments, &tag),
                    None => format!("{tag} BAD No mailbox selected\r\n").into_bytes(),
                }
            }
            "STORE" => {
                let mut state = state.lock().expect("the state");
                match selected
                    .as_deref()
                    .and_then(|name| state.folders.iter().position(|folder| folder.name == name))
                {
                    Some(index) => store(&mut state.folders[index], &arguments, &tag),
                    None => format!("{tag} BAD No mailbox selected\r\n").into_bytes(),
                }
            }
            "EXPUNGE" | "CLOSE" => {
                let mut state = state.lock().expect("the state");
                match selected
                    .as_deref()
                    .and_then(|name| state.folders.iter().position(|folder| folder.name == name))
                {
                    Some(index) => {
                        let folder = &mut state.folders[index];
                        let only: Option<Vec<u32>> = if by_uid {
                            arguments.first().map(|set| parse_set(set, folder))
                        } else {
                            None
                        };
                        let mut answer = String::new();
                        let mut position = 0;
                        while position < folder.messages.len() {
                            let message = &folder.messages[position];
                            let chosen = only.as_ref().is_none_or(|set| set.contains(&message.uid));
                            if chosen && message.has_flag("\\Deleted") {
                                folder.messages.remove(position);
                                if command == "EXPUNGE" {
                                    answer.push_str(&format!("* {} EXPUNGE\r\n", position + 1));
                                }
                            } else {
                                position += 1;
                            }
                        }
                        if command == "CLOSE" {
                            selected = None;
                        }
                        answer.push_str(&format!(
                            "{tag} OK {} completed\r\n",
                            if command == "CLOSE" {
                                "Close"
                            } else {
                                "Expunge"
                            }
                        ));
                        answer.into_bytes()
                    }
                    None => format!("{tag} BAD No mailbox selected\r\n").into_bytes(),
                }
            }
            "APPEND" => {
                let mut state = state.lock().expect("the state");
                let flags: Vec<&str> = arguments
                    .iter()
                    .find(|token| token.starts_with('('))
                    .map(|token| token.trim_matches(['(', ')']).split_whitespace().collect())
                    .unwrap_or_default();
                match (arguments.first().cloned(), literals.last().cloned()) {
                    (Some(name), Some(bytes)) => match state.folder(&name) {
                        Some(_) => {
                            let uid = state.add_message(&name, bytes, &flags, now_timestamp());
                            let uid_validity =
                                state.folder(&name).expect("the folder").uid_validity;
                            format!(
                                "{tag} OK [APPENDUID {uid_validity} {uid}] Append completed\r\n"
                            )
                            .into_bytes()
                        }
                        None => {
                            format!("{tag} NO [TRYCREATE] Mailbox doesn't exist\r\n").into_bytes()
                        }
                    },
                    _ => format!("{tag} BAD Missing name or message\r\n").into_bytes(),
                }
            }
            _ => format!("{tag} BAD Error in IMAP command: Unknown command\r\n").into_bytes(),
        };
        write_bytes(&mut reader, &answer).await;
    }
}

/// The capabilities advertised in the state.
fn capabilities(mode: ImapMode, secured: bool, state: &Arc<Mutex<FakeMailbox>>) -> String {
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
    while let Some((length, synchronizing)) = trailing_literal(&text) {
        let cut = text.rfind('{')?;
        text.truncate(cut);
        if synchronizing {
            write(reader, "+ OK\r\n").await;
        }
        let mut bytes = vec![0; length];
        reader.read_exact(&mut bytes).await.ok()?;
        text.push_str(&quote(&String::from_utf8_lossy(&bytes)));
        literals.push(bytes);
        let mut rest = String::new();
        reader.read_line(&mut rest).await.ok()?;
        text.push_str(rest.trim_end_matches(['\r', '\n']));
    }
    Some((text, literals))
}

/// Finds a literal marker, `{n}` or `{n+}`, at the end of the text.
fn trailing_literal(text: &str) -> Option<(usize, bool)> {
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
fn quote(text: &str) -> String {
    format!("\"{}\"", text.replace('\\', "\\\\").replace('"', "\\\""))
}

/// Splits a command into tokens: atoms, the contents of quoted strings,
/// and parenthesized groups kept whole.
fn tokenize(text: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut current = String::new();
    let mut characters = text.chars();
    let mut parentheses = 0;
    let mut brackets = 0;
    let mut quoted = false;
    while let Some(character) = characters.next() {
        let nested = parentheses > 0 || brackets > 0;
        if quoted {
            match character {
                '\\' => {
                    if let Some(next) = characters.next() {
                        if nested {
                            current.push('\\');
                        }
                        current.push(next);
                    }
                }
                '"' => {
                    quoted = false;
                    if nested {
                        current.push('"');
                    } else {
                        tokens.push(std::mem::take(&mut current));
                    }
                }
                _ => current.push(character),
            }
            continue;
        }
        match character {
            '"' => {
                quoted = true;
                if nested {
                    current.push('"');
                }
            }
            '(' => {
                parentheses += 1;
                current.push(character);
            }
            ')' => {
                parentheses -= 1;
                current.push(character);
                if parentheses == 0 && brackets == 0 {
                    tokens.push(std::mem::take(&mut current));
                }
            }
            '[' => {
                brackets += 1;
                current.push(character);
            }
            ']' => {
                brackets -= 1;
                current.push(character);
            }
            ' ' if !nested => {
                if !current.is_empty() {
                    tokens.push(std::mem::take(&mut current));
                }
            }
            _ => current.push(character),
        }
    }
    if !current.is_empty() {
        tokens.push(current);
    }
    tokens
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
fn header_subset(bytes: &[u8], names: &[String]) -> Vec<u8> {
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
fn search(folder: &FakeFolder, keys: &[String]) -> Result<Vec<u32>, String> {
    let mut start = 0;
    if keys
        .first()
        .is_some_and(|key| key.eq_ignore_ascii_case("CHARSET"))
    {
        start = 2;
    }
    let mut uids = Vec::new();
    for message in &folder.messages {
        let mut index = start;
        let mut matched = true;
        while index < keys.len() {
            matched &= evaluate(keys, &mut index, message, folder)?;
        }
        if matched {
            uids.push(message.uid);
        }
    }
    Ok(uids)
}

/// Evaluates one search key, advancing the index past it.
fn evaluate(
    keys: &[String],
    index: &mut usize,
    message: &FakeMessage,
    folder: &FakeFolder,
) -> Result<bool, String> {
    let key = keys
        .get(*index)
        .ok_or("a key is missing")?
        .to_ascii_uppercase();
    *index += 1;
    let mut argument = || -> Result<String, String> {
        let value = keys
            .get(*index)
            .cloned()
            .ok_or(format!("{key} needs an argument"))?;
        *index += 1;
        Ok(value)
    };
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
            let needle = argument()?.to_lowercase();
            String::from_utf8_lossy(&message.bytes)
                .to_lowercase()
                .contains(&needle)
        }
        "BODY" => {
            let needle = argument()?.to_lowercase();
            let text = String::from_utf8_lossy(&message.bytes);
            text.split_once("\r\n\r\n")
                .map(|(_, body)| body.to_lowercase().contains(&needle))
                .unwrap_or(false)
        }
        "FROM" | "TO" | "CC" | "SUBJECT" => {
            let needle = argument()?;
            field_contains(&key.to_ascii_lowercase(), &needle)
        }
        "HEADER" => {
            let name = argument()?.to_ascii_lowercase();
            let needle = argument()?;
            field_contains(&name, &needle)
        }
        "SINCE" => days >= parse_search_date(&argument()?).ok_or("a bad date")?,
        "BEFORE" => days < parse_search_date(&argument()?).ok_or("a bad date")?,
        "ON" => days == parse_search_date(&argument()?).ok_or("a bad date")?,
        "OR" => {
            let left = evaluate(keys, index, message, folder)?;
            let right = evaluate(keys, index, message, folder)?;
            left || right
        }
        "NOT" => !evaluate(keys, index, message, folder)?,
        "UID" => parse_set(&argument()?, folder).contains(&message.uid),
        _ => return Err(format!("unknown search key {key}")),
    })
}

/// Answers a FETCH of the set with the items.
fn fetch(folder: &mut FakeFolder, arguments: &[String], tag: &str) -> Vec<u8> {
    let (Some(set), Some(items)) = (arguments.first(), arguments.get(1)) else {
        return format!("{tag} BAD Missing set or items\r\n").into_bytes();
    };
    let uids = parse_set(set, folder);
    let items = tokenize(items.trim_start_matches('(').trim_end_matches(')'));
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
                    header_subset(&message.bytes, &names)
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
fn store(folder: &mut FakeFolder, arguments: &[String], tag: &str) -> Vec<u8> {
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
async fn write<S>(reader: &mut BufReader<S>, text: &str)
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    write_bytes(reader, text.as_bytes()).await;
}

/// Writes bytes, ignoring a closed connection.
async fn write_bytes<S>(reader: &mut BufReader<S>, bytes: &[u8])
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let _ = reader.get_mut().write_all(bytes).await;
    let _ = reader.get_mut().flush().await;
}
