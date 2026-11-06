//! The binary over standard input and output, as the backend runs it:
//! the MCP handshake, the tool list, a call, a cut result, a failed
//! call, a cancelled send, a draft save cancelled while its draft is
//! stored, and the exit on the end of input.

use std::io::Write;
use std::sync::mpsc;
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use tokio::time::timeout;

use crate::support::binary::{
    BinaryProcess, STEP_WAIT_LIMIT, follow_lines, read_to_end_in_thread, wait_for_stream_end,
};
use crate::support::imap::{FakeImapServer, FakeMailbox, ImapFault, ImapMode, NewMessage};
use crate::support::smtp::{DATA_END, FakeSmtpServer, SmtpFault, SmtpMode};
use crate::support::{SecurityName, TestMessage, TestServers, build_account_json};

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
const LOG_WAIT_LIMIT: Duration = Duration::from_secs(30);

/// Builds the JSON of `LYS_EMAIL_ACCOUNT` for fakes on the ports that
/// talk without TLS.
fn build_plain_account_json(imap_port: u16, smtp_port: u16) -> String {
    build_account_json(
        TestServers {
            imap_port,
            imap_security: SecurityName::Plain,
            smtp_port,
            smtp_security: SecurityName::Plain,
        },
        false,
    )
}

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
/// collects the answers to the requests among them; each answer, the exit,
/// and the end of standard error come within [`STEP_WAIT_LIMIT`].
///
/// # Arguments
///
/// * `variable` - The JSON of `LYS_EMAIL_ACCOUNT`.
/// * `messages` - The messages, in order; each one with an id is a request
///   whose answer comes before the next message is sent.
///
/// # Panics
///
/// When a request is not answered in time, the binary does not exit in
/// time once its input ended, or its standard error does not end in time.
fn send_dialogue_messages(variable: String, messages: Vec<Value>) -> Dialogue {
    let (mut binary, streams) = BinaryProcess::start(&[], Some(&variable));
    let mut input = streams.input;
    let lines = follow_lines(streams.output);
    let log = read_to_end_in_thread(streams.log);
    let mut answers = Vec::new();
    for message in messages {
        writeln!(input, "{message}").expect("written");
        input.flush().expect("flushed");
        let Some(id) = message.get("id") else {
            continue;
        };
        let line = lines
            .recv_timeout(STEP_WAIT_LIMIT)
            .unwrap_or_else(|error| panic!("request {id} is not answered: {error}"));
        answers.push(serde_json::from_str(&line).expect("JSON"));
    }
    drop(input);
    let status = binary.wait_for_exit();
    let stderr = wait_for_stream_end(&log, "standard error");
    Dialogue {
        answers,
        exit_code: status.code(),
        stderr: String::from_utf8_lossy(&stderr).into_owned(),
    }
}

/// Waits, at most [`LOG_WAIT_LIMIT`] in real time, for the line the binary logs
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
    let deadline = Instant::now() + LOG_WAIT_LIMIT;
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

/// Runs the binary over stdio, makes the call, cancels it once `released`
/// says the fake holds the call at its fault, and stops the binary.
///
/// # Arguments
///
/// * `variable` - The JSON of `LYS_EMAIL_ACCOUNT`.
/// * `call` - The parameters of `tools/call`: the tool's name and its
///   arguments.
/// * `released` - Says that the fake holds the call at its fault.
///
/// # Returns
///
/// The line the binary logged for the call.
///
/// # Panics
///
/// When the binary does not answer `initialize` within [`STEP_WAIT_LIMIT`],
/// `released` does not say within [`STEP_WAIT_LIMIT`] that the fake holds the
/// call, or the binary does not log the call in time.
fn cancel_held_call(variable: String, call: Value, released: mpsc::Receiver<()>) -> String {
    let tool = call["name"].as_str().expect("the tool's name").to_owned();
    let (binary, streams) = BinaryProcess::start(&[], Some(&variable));
    let mut input = streams.input;
    let answers = follow_lines(streams.output);
    let lines = follow_lines(streams.log);
    let initialize = json!({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "lys-test", "version": "0"}}});
    writeln!(input, "{initialize}").expect("written");
    answers
        .recv_timeout(STEP_WAIT_LIMIT)
        .expect("initialize is answered in time");
    let messages = [
        json!({"jsonrpc": "2.0", "method": "notifications/initialized"}),
        json!({"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": call}),
    ];
    for message in messages {
        writeln!(input, "{message}").expect("written");
    }
    released
        .recv_timeout(STEP_WAIT_LIMIT)
        .expect("the fake holds the call in time");
    let cancel = json!({"jsonrpc": "2.0", "method": "notifications/cancelled", "params": {"requestId": 2, "reason": "The person stopped it."}});
    writeln!(input, "{cancel}").expect("written");
    let logged = wait_for_tool_line(&lines, &tool);
    binary.stop();
    logged
}

#[tokio::test(flavor = "multi_thread")]
async fn logs_a_send_cancelled_after_the_hand_over_as_unconfirmed() {
    let imap = FakeImapServer::start(FakeMailbox::create_standard(), ImapMode::Plain, None).await;
    let smtp = FakeSmtpServer::start(SmtpMode::Plain, None).await;
    smtp.add_fault(DATA_END, SmtpFault::Stall);
    let variable = build_plain_account_json(imap.port, smtp.port);
    let call = json!({"name": "send_email", "arguments": {"to": ["jane@example.com"], "subject": "Hi", "body": "Hello"}});
    let (release, released) = mpsc::channel();

    let dialogue = tokio::task::spawn_blocking(move || cancel_held_call(variable, call, released));
    timeout(STEP_WAIT_LIMIT, smtp.wait_for_fault())
        .await
        .expect("the fake holds the whole message in time");
    release.send(()).expect("the dialogue waits for the fake");
    let logged = dialogue.await.expect("the dialogue ends");

    assert_eq!(
        logged,
        "tool send_email: failed (cancelled-after-hand-over)"
    );
    assert_eq!(smtp.list_mails().len(), 1);
}

/// [`DRAFT`] as the fake stores it, with the `\Draft` flag.
fn build_draft_message() -> NewMessage<'static> {
    NewMessage {
        bytes: DRAFT.as_bytes().to_vec(),
        flags: &["\\Draft"],
        timestamp: 1_793_612_000,
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn logs_a_save_cancelled_once_storing_began_as_stopped_while_saving() {
    let mut mailbox = FakeMailbox::create_standard();
    mailbox.add_message("Drafts", build_draft_message());
    let imap = FakeImapServer::start(mailbox, ImapMode::Plain, None).await;
    imap.add_fault("APPEND", ImapFault::StallAfterHandling);
    let smtp = FakeSmtpServer::start(SmtpMode::Plain, None).await;
    let variable = build_plain_account_json(imap.port, smtp.port);
    let call = json!({"name": "save_draft", "arguments": {"draft_id": "1.1003.Drafts", "to": ["jane@example.com"], "subject": "Plans, again", "body": "Later."}});
    let (release, released) = mpsc::channel();

    let dialogue = tokio::task::spawn_blocking(move || cancel_held_call(variable, call, released));
    timeout(STEP_WAIT_LIMIT, imap.wait_for_fault())
        .await
        .expect("the fake stores the new draft in time");
    release.send(()).expect("the dialogue waits for the fake");
    let logged = dialogue.await.expect("the dialogue ends");

    assert_eq!(logged, "tool save_draft: failed (cancelled-while-saving)");
    let drafts = imap.list_messages("Drafts");
    assert_eq!(drafts.len(), 2);
    assert!(drafts.iter().all(|draft| !draft.has_flag("\\Deleted")));
    assert!(String::from_utf8_lossy(&drafts[1].bytes).contains("Subject: Plans, again\r\n"));
}

/// Builds the mailbox the dialogue reads: a short and a long message in
/// INBOX, `1.1001.INBOX` and `2.1001.INBOX`, and [`DRAFT`] in Drafts.
fn build_dialogue_mailbox() -> FakeMailbox {
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
    mailbox.add_message("Drafts", build_draft_message());
    mailbox
}

/// The messages of the dialogue: the handshake, the tool list, a folder
/// list, a read the result cut, a bad id, a bad page, and the draft sent
/// first without and then with the fields it holds.
fn build_dialogue_messages() -> Vec<Value> {
    vec![
        json!({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "lys-test", "version": "0"}}}),
        json!({"jsonrpc": "2.0", "method": "notifications/initialized"}),
        json!({"jsonrpc": "2.0", "id": 2, "method": "tools/list"}),
        json!({"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": "list_folders", "arguments": {}}}),
        json!({"jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": {"name": "read_email", "arguments": {"id": "2.1001.INBOX"}}}),
        json!({"jsonrpc": "2.0", "id": 5, "method": "tools/call", "params": {"name": "read_email", "arguments": {"id": "nonsense"}}}),
        json!({"jsonrpc": "2.0", "id": 6, "method": "tools/call", "params": {"name": "search_emails", "arguments": {"page": 0}}}),
        json!({"jsonrpc": "2.0", "id": 7, "method": "tools/call", "params": {"name": "send_draft", "arguments": {"draft_id": "1.1003.Drafts"}}}),
        json!({"jsonrpc": "2.0", "id": 8, "method": "tools/call", "params": {"name": "send_draft", "arguments": {"draft_id": "1.1003.Drafts", "to": ["Jane Doe <jane@example.com>"], "bcc": ["hidden@example.com"], "subject": "Plans", "body": "See you there."}}}),
    ]
}

/// Asserts that the answer to `initialize` names the server and its
/// version, gives instructions, and offers tools.
fn assert_initialized(initialized: &Value) {
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
}

/// Gets a tool by name from the answer to `tools/list`.
///
/// # Panics
///
/// When the answer lists no such tool.
fn get_listed_tool<'a>(listed: &'a Value, name: &str) -> &'a Value {
    listed["result"]["tools"]
        .as_array()
        .expect("tools")
        .iter()
        .find(|tool| tool["name"] == name)
        .expect("the tool")
}

/// Asserts that the answer to `tools/list` names every tool, each with an
/// object schema and a description, and that `search_emails` reads only
/// and takes a page.
fn assert_tools_listed(listed: &Value) {
    let tools = listed["result"]["tools"].as_array().expect("tools");
    let mut names: Vec<&str> = tools
        .iter()
        .map(|tool| tool["name"].as_str().expect("a name"))
        .collect();
    names.sort_unstable();
    assert_eq!(names, TOOL_NAMES);
    for tool in tools {
        assert_eq!(tool["inputSchema"]["type"], "object", "{tool}");
        assert!(
            tool["description"]
                .as_str()
                .is_some_and(|text| !text.is_empty()),
            "{tool}"
        );
    }
    let search = get_listed_tool(listed, "search_emails");
    assert_eq!(search["annotations"]["readOnlyHint"], true);
    assert!(
        search["inputSchema"]["properties"]["page"].is_object(),
        "{search}"
    );
}

/// Asserts that `send_draft` requires the draft's id and takes the fields
/// the draft must hold, and that `delete_draft` takes only the id.
fn assert_draft_tool_fields(listed: &Value) {
    let send_draft = get_listed_tool(listed, "send_draft");
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
    let delete_draft = get_listed_tool(listed, "delete_draft");
    assert_eq!(
        delete_draft["inputSchema"]["properties"]
            .as_object()
            .map(|properties| properties.keys().cloned().collect::<Vec<_>>()),
        Some(vec!["draft_id".to_owned()])
    );
}

/// Asserts that the folders were listed and that the long message's text
/// was cut to the result limit, in UTF-16 code units, with the note.
fn assert_read_answers(folders: &Value, long_read: &Value) {
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
    assert_eq!(long_text.encode_utf16().count(), 20_000);
    assert!(long_text.ends_with(CUT_NOTE));
}

/// Asserts that a bad id and a bad page fail as tool errors with their
/// sentences.
fn assert_failed_answers(bad_id: &Value, bad_page: &Value) {
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
}

/// Asserts that the draft was refused while the call named none of its
/// fields, and sent once to its recipients when the call named them.
fn assert_draft_answers(unshown_draft: &Value, shown_draft: &Value, smtp: &FakeSmtpServer) {
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
}

/// Asserts that the binary logged that it serves and the calls' outcomes,
/// and logged neither the password nor an address.
fn assert_logged_without_account(stderr: &str) {
    let lines = [
        "server: serving MCP over stdio\n",
        "tool list_folders: done (folders: 7 listed)\n",
        "tool read_email: failed (invalid-id)\n",
    ];
    for line in lines {
        assert!(stderr.contains(line), "{stderr}");
    }
    assert!(!stderr.contains(crate::support::PASSWORD), "{stderr}");
    assert!(!stderr.contains("example.com"), "{stderr}");
}

#[tokio::test(flavor = "multi_thread")]
async fn serves_mcp_over_stdio_and_exits_when_its_input_ends() {
    let imap = FakeImapServer::start(build_dialogue_mailbox(), ImapMode::Plain, None).await;
    let smtp = FakeSmtpServer::start(SmtpMode::Plain, None).await;
    let variable = build_plain_account_json(imap.port, smtp.port);
    let messages = build_dialogue_messages();

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
    assert_initialized(initialized);
    assert_tools_listed(listed);
    assert_draft_tool_fields(listed);
    assert_read_answers(folders, long_read);
    assert_failed_answers(bad_id, bad_page);
    assert_draft_answers(unshown_draft, shown_draft, &smtp);
    assert_logged_without_account(&dialogue.stderr);
}
