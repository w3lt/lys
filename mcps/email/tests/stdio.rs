//! The binary over standard input and output, as the backend runs it:
//! the MCP handshake, the tool list, a call, a cut result, a failed
//! call, and the exit on the end of input.

mod support;

use std::io::{BufRead, BufReader, Write};
use std::process::{Command, Stdio};

use serde_json::{Value, json};

use support::imap::{FakeImapServer, FakeMailbox, ImapMode};
use support::smtp::{FakeSmtpServer, SmtpMode};
use support::{SecurityName, TestMessage, TestServers, build_account_json};

/// The note a cut result ends with.
const CUT_NOTE: &str = "\n\n[The result was cut at 20,000 characters.]";

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
    ];

    let dialogue = tokio::task::spawn_blocking(move || send_dialogue_messages(variable, messages))
        .await
        .expect("the dialogue ends");

    assert_eq!(dialogue.exit_code, Some(0), "{}", dialogue.stderr);
    let [initialized, listed, folders, long_read, bad_id, bad_page] = dialogue.answers.as_slice()
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
