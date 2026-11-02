//! The binary over standard input and output, as the backend runs it:
//! the MCP handshake, the tool list, a call, a cut result, a failed
//! call, a cancelled send, and the exit on the end of input.

mod support;

use std::io::{BufRead, BufReader, Write};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use serde_json::{Value, json};

use support::imap::{FakeImapServer, FakeMailbox, ImapMode, NewMessage};
use support::smtp::{DATA_END, FakeSmtpServer, SmtpFault, SmtpMode};
use support::{SecurityName, TestMessage, TestServers, build_account_json};

/// The note a cut result ends with.
const CUT_NOTE: &str = "\n\n[The result was cut at 20,000 characters.]";

/// A draft another client saved, `1.1003.Drafts`.
const DRAFT: &str = "From: A Person <person@example.com>\r\nTo: Jane Doe <jane@example.com>\r\nBcc: hidden@example.com\r\nSubject: Plans\r\nMessage-ID: <draft@example.com>\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nSee you there.\r\n";

/// The names of the tools.
const TOOL_NAMES: [&str; 10] = [
    "delete_draft",
    "list_folders",
    "manage_folder",
    "read_attachment",
    "read_conversation",
    "read_email",
    "save_draft",
    "search_emails",
    "send_draft",
    "send_email",
];

/// Longest the binary may take, in real time, to log a call it was told to
/// cancel.
const LOG_WAIT: Duration = Duration::from_secs(30);

/// What the dialogue with the binary produced.
struct Dialogue {
    /// The answers, in order.
    answers: Vec<Value>,
    /// The exit code.
    exit_code: Option<i32>,
    /// Standard error.
    stderr: String,
}

/// Runs the binary over stdio, sends the messages, closes its input, and
/// collects the answers to the requests among them.
fn send_dialogue_messages(variable: String, messages: Vec<Value>) -> Dialogue {
    let mut child = Command::new(env!("CARGO_BIN_EXE_email"))
        .env("LYS_EMAIL_ACCOUNT", variable)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("the binary starts");
    let mut stdin = child.stdin.take().expect("stdin");
    let stdout = child.stdout.take().expect("stdout");
    let mut reader = BufReader::new(stdout);
    let mut answers = Vec::new();
    for message in messages {
        writeln!(stdin, "{message}").expect("written");
        stdin.flush().expect("flushed");
        if message.get("id").is_some() {
            let mut line = String::new();
            reader.read_line(&mut line).expect("an answer");
            answers.push(serde_json::from_str(&line).expect("JSON"));
        }
    }
    drop(stdin);
    let output = child.wait_with_output().expect("the binary ends");
    Dialogue {
        answers,
        exit_code: output.status.code(),
        stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
    }
}

/// Sends each line the reader gives to the receiver, until the reader
/// ends or the receiver is gone.
fn forward_lines(reader: impl BufRead, sender: &mpsc::Sender<String>) {
    for line in reader.lines().map_while(Result::ok) {
        if sender.send(line).is_err() {
            return;
        }
    }
}

/// Waits, at most [`LOG_WAIT`] in real time, for the line the binary logs
/// for a call of the tool.
///
/// # Returns
///
/// The line.
///
/// # Panics
///
/// When no such line comes in time.
fn wait_for_tool_line(lines: &mpsc::Receiver<String>, tool: &str) -> String {
    let deadline = Instant::now() + LOG_WAIT;
    let prefix = format!("tool {tool}: ");
    loop {
        let line = lines
            .recv_timeout(deadline.saturating_duration_since(Instant::now()))
            .expect("the call is logged in time");
        if line.starts_with(&prefix) {
            return line;
        }
    }
}

/// Runs the binary over stdio, calls `send_email`, cancels the call once
/// `released` says the fake holds the whole message, and closes its input.
///
/// # Returns
///
/// The line the binary logged for the call.
fn read_cancelled_send_line(variable: String, released: mpsc::Receiver<()>) -> String {
    let mut child = Command::new(env!("CARGO_BIN_EXE_email"))
        .env("LYS_EMAIL_ACCOUNT", variable)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("the binary starts");
    let mut stdin = child.stdin.take().expect("stdin");
    let mut stdout = BufReader::new(child.stdout.take().expect("stdout"));
    let stderr = BufReader::new(child.stderr.take().expect("stderr"));
    let (line_sender, lines) = mpsc::channel();
    std::thread::spawn(move || forward_lines(stderr, &line_sender));
    let initialize = json!({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "lys-test", "version": "0"}}});
    writeln!(stdin, "{initialize}").expect("written");
    let mut answer = String::new();
    stdout.read_line(&mut answer).expect("an answer");
    let messages = [
        json!({"jsonrpc": "2.0", "method": "notifications/initialized"}),
        json!({"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {"name": "send_email", "arguments": {"to": ["jane@example.com"], "subject": "Hi", "body": "Hello"}}}),
    ];
    for message in messages {
        writeln!(stdin, "{message}").expect("written");
    }
    released.recv().expect("the fake holds the message");
    let cancel = json!({"jsonrpc": "2.0", "method": "notifications/cancelled", "params": {"requestId": 2, "reason": "The person stopped it."}});
    writeln!(stdin, "{cancel}").expect("written");
    let logged = wait_for_tool_line(&lines, "send_email");
    drop(stdin);
    child.wait().expect("the binary ends");
    logged
}

#[tokio::test(flavor = "multi_thread")]
async fn logs_a_send_cancelled_after_the_hand_over_as_unconfirmed() {
    let imap = FakeImapServer::start(FakeMailbox::create_standard(), ImapMode::Plain, None).await;
    let smtp = FakeSmtpServer::start(SmtpMode::Plain, None).await;
    smtp.add_fault(DATA_END, SmtpFault::Stall);
    let variable = build_account_json(
        TestServers {
            imap_port: imap.port,
            imap_security: SecurityName::Plain,
            smtp_port: smtp.port,
            smtp_security: SecurityName::Plain,
        },
        false,
    );
    let (release, released) = mpsc::channel();

    let dialogue =
        tokio::task::spawn_blocking(move || read_cancelled_send_line(variable, released));
    smtp.wait_for_fault().await;
    release.send(()).expect("the dialogue waits for the fake");
    let logged = dialogue.await.expect("the dialogue ends");

    assert_eq!(
        logged,
        "tool send_email: failed (cancelled-after-hand-over)"
    );
    assert_eq!(smtp.list_mails().len(), 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn serves_mcp_over_stdio_and_exits_when_its_input_ends() {
    let mut mailbox = FakeMailbox::create_standard();
    let short = TestMessage {
        subject: "Short".to_owned(),
        body: "Short body.".to_owned(),
        message_id: "short@example.com".to_owned(),
        timestamp: 1_793_611_800,
        ..TestMessage::default()
    };
    let long = TestMessage {
        subject: "Long".to_owned(),
        body: "y".repeat(25_000),
        message_id: "long@example.com".to_owned(),
        timestamp: 1_793_611_900,
        ..TestMessage::default()
    };
    mailbox.add_message("INBOX", short.build_new_message(&[]));
    mailbox.add_message("INBOX", long.build_new_message(&[]));
    mailbox.add_message(
        "Drafts",
        NewMessage {
            bytes: DRAFT.as_bytes().to_vec(),
            flags: &["\\Draft"],
            timestamp: 1_793_612_000,
        },
    );
    let imap = FakeImapServer::start(mailbox, ImapMode::Plain, None).await;
    let smtp = FakeSmtpServer::start(SmtpMode::Plain, None).await;
    let variable = build_account_json(
        TestServers {
            imap_port: imap.port,
            imap_security: SecurityName::Plain,
            smtp_port: smtp.port,
            smtp_security: SecurityName::Plain,
        },
        false,
    );
    let messages = vec![
        json!({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "lys-test", "version": "0"}}}),
        json!({"jsonrpc": "2.0", "method": "notifications/initialized"}),
        json!({"jsonrpc": "2.0", "id": 2, "method": "tools/list"}),
        json!({"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": "list_folders", "arguments": {}}}),
        json!({"jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": {"name": "read_email", "arguments": {"id": "2.1001.INBOX"}}}),
        json!({"jsonrpc": "2.0", "id": 5, "method": "tools/call", "params": {"name": "read_email", "arguments": {"id": "nonsense"}}}),
        json!({"jsonrpc": "2.0", "id": 6, "method": "tools/call", "params": {"name": "search_emails", "arguments": {"page": 0}}}),
        json!({"jsonrpc": "2.0", "id": 7, "method": "tools/call", "params": {"name": "send_draft", "arguments": {"draft_id": "1.1003.Drafts"}}}),
        json!({"jsonrpc": "2.0", "id": 8, "method": "tools/call", "params": {"name": "send_draft", "arguments": {"draft_id": "1.1003.Drafts", "to": ["Jane Doe <jane@example.com>"], "bcc": ["hidden@example.com"], "subject": "Plans", "body": "See you there."}}}),
    ];

    let dialogue = tokio::task::spawn_blocking(move || send_dialogue_messages(variable, messages))
        .await
        .expect("the dialogue ends");

    assert_eq!(dialogue.exit_code, Some(0), "{}", dialogue.stderr);
    let [
        initialized,
        listed,
        folders,
        long_read,
        bad_id,
        bad_page,
        unshown_draft,
        shown_draft,
    ] = dialogue.answers.as_slice()
    else {
        panic!("{:?}", dialogue.answers);
    };
    assert_eq!(initialized["result"]["serverInfo"]["name"], "lys-email");
    assert_eq!(
        initialized["result"]["serverInfo"]["version"],
        env!("CARGO_PKG_VERSION")
    );
    assert!(
        initialized["result"]["instructions"]
            .as_str()
            .is_some_and(|text| text.contains("search_emails"))
    );
    assert!(initialized["result"]["capabilities"]["tools"].is_object());
    let mut names: Vec<&str> = listed["result"]["tools"]
        .as_array()
        .expect("tools")
        .iter()
        .map(|tool| tool["name"].as_str().expect("a name"))
        .collect();
    names.sort_unstable();
    assert_eq!(names, TOOL_NAMES);
    for tool in listed["result"]["tools"].as_array().expect("tools") {
        assert_eq!(tool["inputSchema"]["type"], "object", "{tool}");
        assert!(
            tool["description"]
                .as_str()
                .is_some_and(|text| !text.is_empty()),
            "{tool}"
        );
    }
    let search = listed["result"]["tools"]
        .as_array()
        .expect("tools")
        .iter()
        .find(|tool| tool["name"] == "search_emails")
        .expect("the search tool");
    assert_eq!(search["annotations"]["readOnlyHint"], true);
    assert!(
        search["inputSchema"]["properties"]["page"].is_object(),
        "{search}"
    );
    let find_tool = |name: &str| {
        listed["result"]["tools"]
            .as_array()
            .expect("tools")
            .iter()
            .find(|tool| tool["name"] == name)
            .cloned()
            .expect("the tool")
    };
    let send_draft = find_tool("send_draft");
    let mut send_draft_fields: Vec<&str> = send_draft["inputSchema"]["properties"]
        .as_object()
        .expect("properties")
        .keys()
        .map(String::as_str)
        .collect();
    send_draft_fields.sort_unstable();
    assert_eq!(
        send_draft_fields,
        ["bcc", "body", "cc", "draft_id", "subject", "to"]
    );
    assert_eq!(send_draft["inputSchema"]["required"], json!(["draft_id"]));
    let delete_draft = find_tool("delete_draft");
    assert_eq!(
        delete_draft["inputSchema"]["properties"]
            .as_object()
            .map(|properties| properties.keys().cloned().collect::<Vec<_>>()),
        Some(vec!["draft_id".to_owned()])
    );
    assert_ne!(folders["result"]["isError"], true, "{folders}");
    assert!(
        folders["result"]["content"][0]["text"]
            .as_str()
            .is_some_and(|text| text.starts_with("- INBOX (Inbox): 2 messages\n")),
        "{folders}"
    );
    let long_text = long_read["result"]["content"][0]["text"]
        .as_str()
        .expect("text");
    assert_eq!(long_text.chars().count(), 20_000 + CUT_NOTE.chars().count());
    assert!(long_text.ends_with(CUT_NOTE));
    assert_eq!(bad_id["result"]["isError"], true, "{bad_id}");
    assert_eq!(
        bad_id["result"]["content"][0]["text"],
        "That is not a message id. Use an id from search_emails, such as 12.345.INBOX."
    );
    assert_eq!(bad_page["result"]["isError"], true, "{bad_page}");
    assert_eq!(
        bad_page["result"]["content"][0]["text"],
        "page must be 1 or more."
    );
    assert_eq!(unshown_draft["result"]["isError"], true, "{unshown_draft}");
    assert!(
        unshown_draft["result"]["content"][0]["text"]
            .as_str()
            .is_some_and(|text| text.starts_with(
                "The draft differs from this call in to, bcc, subject, body, so nothing was sent."
            )),
        "{unshown_draft}"
    );
    assert_ne!(shown_draft["result"]["isError"], true, "{shown_draft}");
    let mails = smtp.list_mails();
    assert_eq!(mails.len(), 1, "{shown_draft}");
    assert_eq!(mails[0].to, vec!["jane@example.com", "hidden@example.com"]);
    assert!(
        dialogue.stderr.contains("server: serving MCP over stdio\n"),
        "{}",
        dialogue.stderr
    );
    assert!(
        dialogue
            .stderr
            .contains("tool list_folders: done (folders: 7 listed)\n"),
        "{}",
        dialogue.stderr
    );
    assert!(
        dialogue
            .stderr
            .contains("tool read_email: failed (invalid-id)\n"),
        "{}",
        dialogue.stderr
    );
    assert!(
        !dialogue.stderr.contains(support::PASSWORD) && !dialogue.stderr.contains("example.com"),
        "{}",
        dialogue.stderr
    );
}
