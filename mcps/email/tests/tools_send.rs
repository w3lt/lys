//! `send_email` against the fake SMTP and IMAP servers: plain sends,
//! replies, forwards, the Sent copy, and refusals.

mod support;

use email::failure::{Protocol, SignInFailure, ToolFailure};
use email::message::parse_message;
use email::tools::ToolContext;
use email::tools::send::{MessageArguments, run_send_email};
use email::trust::Trust;

use support::imap::{FakeMailbox, NewMessage};
use support::{ADDRESS, Stack, TestMessage, calculate_trimmed_bytes, start_stack};

/// The time the original message was sent.
const BASE: i64 = 1_793_611_800;

/// A message with an HTML body and two attachments, to forward.
const REPORT: &str = "From: Jane Doe <jane@example.com>\r\nTo: person@example.com\r\nDate: Mon, 2 Nov 2026 12:00:00 +0000\r\nSubject: Report\r\nMessage-ID: <report@example.com>\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=\"b\"\r\n\r\n--b\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nPlease find the report attached.\r\n--b\r\nContent-Type: text/csv; name=\"data.csv\"\r\nContent-Disposition: attachment; filename=\"data.csv\"\r\n\r\na,b\r\n1,2\r\n--b\r\nContent-Type: application/pdf\r\nContent-Disposition: attachment; filename=\"report.pdf\"\r\nContent-Transfer-Encoding: base64\r\n\r\nJVBERi0=\r\n--b--\r\n";

/// A message whose sender's name needs quotes and whose Reply-To asks for
/// replies to go to two other mailboxes.
const REDIRECTED: &str = "From: \"Doe, Jane\" <jane@example.com>\r\nReply-To: a@example.com, Team <b@example.com>\r\nTo: person@example.com\r\nDate: Mon, 2 Nov 2026 12:05:00 +0000\r\nSubject: Plans\r\nMessage-ID: <plans@example.com>\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nWhat do you think?\r\n";

/// Starts the stack with one message from Jane in INBOX, `1.1001.INBOX`,
/// the report, `2.1001.INBOX`, and the redirected message,
/// `3.1001.INBOX`.
async fn start_with_originals(server_keeps_sent_copy: bool) -> Stack {
    let mut mailbox = FakeMailbox::create_standard();
    let original = TestMessage {
        subject: "Hello".to_owned(),
        body: "Original text.".to_owned(),
        message_id: "orig@example.com".to_owned(),
        timestamp: BASE,
        ..TestMessage::default()
    };
    mailbox.add_message("INBOX", original.build_new_message(&["\\Seen"]));
    mailbox.add_message(
        "INBOX",
        NewMessage {
            bytes: REPORT.as_bytes().to_vec(),
            flags: &[],
            timestamp: BASE + 60,
        },
    );
    mailbox.add_message(
        "INBOX",
        NewMessage {
            bytes: REDIRECTED.as_bytes().to_vec(),
            flags: &[],
            timestamp: BASE + 120,
        },
    );
    start_stack(mailbox, server_keeps_sent_copy).await
}

/// Asserts that nothing reached the SMTP server.
fn assert_nothing_sent(stack: &Stack) {
    assert!(stack.smtp.list_mails().is_empty());
    assert!(
        stack
            .smtp
            .state
            .lock()
            .expect("the state")
            .commands
            .is_empty()
    );
}

/// A message to Jane with the subject and body.
fn build_message_to_jane(subject: &str, body: &str) -> MessageArguments {
    MessageArguments {
        to: vec!["Jane Doe <jane@example.com>".to_owned()],
        subject: subject.to_owned(),
        body: body.to_owned(),
        ..MessageArguments::default()
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn sends_a_message_and_keeps_one_read_copy_in_sent_without_the_bcc_field() {
    let stack = start_with_originals(false).await;

    let report = run_send_email(
        &stack.context,
        MessageArguments {
            cc: vec!["cc@example.com".to_owned()],
            bcc: vec!["hidden@example.com".to_owned()],
            ..build_message_to_jane("Grüße", "Hello Jane,\n\nBye.")
        },
    )
    .await
    .expect("sent");

    assert!(
        report.text.starts_with("Sent as Message-ID <lys-"),
        "{}",
        report.text
    );
    assert!(
        report.text.ends_with("@example.com>.\nTo: Jane Doe <jane@example.com>\nCc: cc@example.com\nBcc: hidden@example.com\nSubject: Grüße\nA copy was saved in Sent."),
        "{}",
        report.text
    );
    assert_eq!(
        report.log,
        "send: 3 recipient(s), 0 attachment(s), copy saved"
    );
    let mails = stack.smtp.list_mails();
    assert_eq!(mails.len(), 1);
    assert_eq!(mails[0].from, ADDRESS);
    assert_eq!(
        mails[0].to,
        vec!["jane@example.com", "cc@example.com", "hidden@example.com"]
    );
    let text = String::from_utf8_lossy(&mails[0].bytes);
    assert!(!text.contains("hidden@example.com"), "{text}");
    assert!(
        text.contains("From: \"A Person\" <person@example.com>\r\n"),
        "{text}"
    );
    let parsed = parse_message(&mails[0].bytes).expect("parsed");
    assert_eq!(parsed.headers.subject, "Grüße");
    assert_eq!(parsed.text, "Hello Jane,\r\n\r\nBye.\r\n");
    let sent = stack.imap.list_messages("Sent");
    assert_eq!(sent.len(), 1);
    assert_eq!(sent[0].flags, vec!["\\Seen"]);
    assert_eq!(
        calculate_trimmed_bytes(&sent[0].bytes),
        calculate_trimmed_bytes(&mails[0].bytes)
    );
    let commands = stack.imap.list_commands();
    assert_eq!(
        commands
            .iter()
            .filter(|command| command.contains(" APPEND "))
            .count(),
        1,
        "{commands:?}"
    );
    assert!(
        commands
            .iter()
            .any(|command| command.contains("APPEND \"Sent\" (\\Seen) ")),
        "{commands:?}"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn keeps_no_copy_when_the_server_keeps_one() {
    let stack = start_with_originals(true).await;

    let report = run_send_email(&stack.context, build_message_to_jane("Hi", "Hello"))
        .await
        .expect("sent");

    assert!(
        report
            .text
            .ends_with("The server keeps a copy of sent mail."),
        "{}",
        report.text
    );
    assert_eq!(stack.smtp.list_mails().len(), 1);
    assert!(stack.imap.list_messages("Sent").is_empty());
    assert!(
        stack.imap.list_commands().is_empty(),
        "{:?}",
        stack.imap.list_commands()
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn refuses_a_reply_that_leaves_out_its_recipients_or_subject() {
    let stack = start_with_originals(false).await;

    let to_jane = run_send_email(
        &stack.context,
        MessageArguments {
            body: "Thanks!".to_owned(),
            reply_to_id: Some("1.1001.INBOX".to_owned()),
            ..MessageArguments::default()
        },
    )
    .await;
    let redirected = run_send_email(
        &stack.context,
        MessageArguments {
            subject: "Re: Plans".to_owned(),
            body: "Sounds good.".to_owned(),
            reply_to_id: Some("3.1001.INBOX".to_owned()),
            ..MessageArguments::default()
        },
    )
    .await;
    let untitled = run_send_email(
        &stack.context,
        MessageArguments {
            subject: " ".to_owned(),
            reply_to_id: Some("3.1001.INBOX".to_owned()),
            ..build_message_to_jane("", "Sounds good.")
        },
    )
    .await;

    assert_eq!(
        to_jane,
        Err(ToolFailure::Argument(
            "A reply needs its recipients in to, cc, or bcc. The message replied to is from [\"Jane Doe <jane@example.com>\"]. A reply needs a subject, such as \"Re: Hello\".".to_owned()
        ))
    );
    assert_eq!(
        redirected,
        Err(ToolFailure::Argument(
            "A reply needs its recipients in to, cc, or bcc. The message replied to is from [\"\\\"Doe, Jane\\\" <jane@example.com>\"] and asks for replies to go to [\"a@example.com\", \"Team <b@example.com>\"].".to_owned()
        ))
    );
    assert_eq!(
        untitled,
        Err(ToolFailure::Argument(
            "A reply needs a subject, such as \"Re: Plans\".".to_owned()
        ))
    );
    assert_nothing_sent(&stack);
}

#[tokio::test(flavor = "multi_thread")]
async fn replies_in_the_conversation_to_exactly_the_recipients_given() {
    let stack = start_with_originals(false).await;

    let report = run_send_email(
        &stack.context,
        MessageArguments {
            to: vec!["\"Doe, Jane\" <jane@example.com>".to_owned()],
            cc: vec![
                "a@example.com".to_owned(),
                "Team <b@example.com>".to_owned(),
            ],
            subject: "Re: Plans".to_owned(),
            body: "Sounds good.".to_owned(),
            reply_to_id: Some("3.1001.INBOX".to_owned()),
            ..MessageArguments::default()
        },
    )
    .await
    .expect("sent");

    assert!(
        report.text.contains(
            "\nTo: \"Doe, Jane\" <jane@example.com>\nCc: a@example.com, Team <b@example.com>\nSubject: Re: Plans\n"
        ),
        "{}",
        report.text
    );
    let mails = stack.smtp.list_mails();
    assert_eq!(mails.len(), 1);
    assert_eq!(
        mails[0].to,
        vec!["jane@example.com", "a@example.com", "b@example.com"]
    );
    let text = String::from_utf8_lossy(&mails[0].bytes);
    assert!(text.contains("Subject: Re: Plans\r\n"), "{text}");
    assert!(
        text.contains("In-Reply-To: <plans@example.com>\r\n"),
        "{text}"
    );
    assert!(
        text.contains("References: <plans@example.com>\r\n"),
        "{text}"
    );
    assert!(text.contains("Sounds good."), "{text}");
    let commands = stack.imap.list_commands();
    assert!(
        commands
            .iter()
            .any(|command| command.ends_with("UID FETCH 3 (UID FLAGS BODY.PEEK[])")),
        "{commands:?}"
    );
    assert!(
        !commands.iter().any(|command| command.contains("STORE")),
        "{commands:?}"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn refuses_a_forward_that_leaves_out_its_recipients_or_subject() {
    let stack = start_with_originals(false).await;

    let forwarded = run_send_email(
        &stack.context,
        MessageArguments {
            body: "FYI".to_owned(),
            forward_id: Some("2.1001.INBOX".to_owned()),
            ..MessageArguments::default()
        },
    )
    .await;

    assert_eq!(
        forwarded,
        Err(ToolFailure::Argument(
            "A forward needs its recipients in to, cc, or bcc. A forward needs a subject, such as \"Fwd: Report\".".to_owned()
        ))
    );
    assert_nothing_sent(&stack);
}

#[tokio::test(flavor = "multi_thread")]
async fn forwards_the_original_text_and_attachments() {
    let stack = start_with_originals(false).await;

    let report = run_send_email(
        &stack.context,
        MessageArguments {
            to: vec!["colleague@example.com".to_owned()],
            subject: "Fwd: Report".to_owned(),
            body: "FYI".to_owned(),
            forward_id: Some("2.1001.INBOX".to_owned()),
            ..MessageArguments::default()
        },
    )
    .await
    .expect("sent");

    assert!(
        report.text.contains("\nSubject: Fwd: Report\n"),
        "{}",
        report.text
    );
    assert_eq!(
        report.log,
        "send: 1 recipient(s), 2 attachment(s), copy saved"
    );
    let mails = stack.smtp.list_mails();
    let parsed = parse_message(&mails[0].bytes).expect("parsed");
    assert_eq!(parsed.headers.subject, "Fwd: Report");
    assert!(parsed.text.starts_with("FYI\r\n\r\n---------- Forwarded message ----------\r\nFrom: Jane Doe <jane@example.com>\r\nDate: 2026-11-02T12:00:00Z\r\nSubject: Report\r\nTo: person@example.com\r\n\r\nPlease find the report attached."), "{}", parsed.text);
    let names: Vec<&str> = parsed
        .attachments
        .iter()
        .map(|attachment| attachment.name.as_str())
        .collect();
    assert_eq!(names, vec!["data.csv", "report.pdf"]);
    assert_eq!(parsed.attachments[0].text.as_deref(), Some("a,b\r\n1,2"));
    assert_eq!(parsed.attachments[1].bytes, b"%PDF-");
}

#[tokio::test(flavor = "multi_thread")]
async fn reports_a_refused_recipient_and_a_refused_sign_in_without_a_sent_copy() {
    let stack = start_with_originals(false).await;
    stack.smtp.add_refused_recipient("nobody@example.com");
    let wrong_password = ToolContext::new(
        email::account::parse_account_variable(
            &support::build_account_json(
                support::TestServers {
                    imap_port: stack.imap.port,
                    imap_security: support::SecurityName::Tls,
                    smtp_port: stack.smtp.port,
                    smtp_security: support::SecurityName::Tls,
                },
                false,
            )
            .replace(support::PASSWORD, "another-synthetic-value"),
        )
        .expect("account"),
        Trust::create_with_extra_roots(vec![stack.authority.root.clone()]),
    );

    let refused = run_send_email(
        &stack.context,
        MessageArguments {
            to: vec!["nobody@example.com".to_owned()],
            ..build_message_to_jane("Hi", "Hello")
        },
    )
    .await;
    let not_signed_in = run_send_email(&wrong_password, build_message_to_jane("Hi", "Hello")).await;

    match refused {
        Err(ToolFailure::SmtpRefused { code, text }) => {
            assert_eq!(code, 550);
            assert!(text.contains("User unknown"), "{text}");
        }
        other => panic!("{other:?}"),
    }
    assert_eq!(
        not_signed_in,
        Err(ToolFailure::SignIn {
            protocol: Protocol::Smtp,
            failure: SignInFailure::WrongPassword
        })
    );
    assert!(stack.smtp.list_mails().is_empty());
    assert!(stack.imap.list_messages("Sent").is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn refuses_arguments_that_break_a_rule_before_connecting() {
    let stack = start_with_originals(false).await;

    let both = run_send_email(
        &stack.context,
        MessageArguments {
            reply_to_id: Some("1.1001.INBOX".to_owned()),
            forward_id: Some("1.1001.INBOX".to_owned()),
            ..build_message_to_jane("Hi", "Hello")
        },
    )
    .await;
    let nobody = run_send_email(
        &stack.context,
        MessageArguments {
            subject: "Hi".to_owned(),
            body: "Hello".to_owned(),
            ..MessageArguments::default()
        },
    )
    .await;
    let not_an_address = run_send_email(
        &stack.context,
        MessageArguments {
            to: vec!["not an address".to_owned()],
            ..build_message_to_jane("Hi", "Hello")
        },
    )
    .await;

    assert_eq!(
        both,
        Err(ToolFailure::Argument(
            "Give reply_to_id or forward_id, not both.".to_owned()
        ))
    );
    assert_eq!(
        nobody,
        Err(ToolFailure::Argument(
            "Give at least one recipient in to, cc, or bcc.".to_owned()
        ))
    );
    assert_eq!(
        not_an_address,
        Err(ToolFailure::Argument(
            "not an address is not an email address. Give addresses as name@example.com or Name <name@example.com>.".to_owned()
        ))
    );
    assert_nothing_sent(&stack);
    assert!(stack.imap.list_commands().is_empty());
}
