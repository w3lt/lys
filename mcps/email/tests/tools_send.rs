//! `send_email` against the fake SMTP and IMAP servers: plain sends,
//! replies, forwards, the Sent copy, and refusals.

mod support;

use email::failure::{Protocol, SignInFailure, ToolFailure};
use email::message::parse_message;
use email::tools::ToolContext;
use email::tools::send::{MessageArguments, send_email};
use email::trust::Trust;

use support::imap::FakeMailbox;
use support::{ADDRESS, Stack, TestMessage, start_stack, without_trailing_line_breaks};

/// The time the original message was sent.
const BASE: i64 = 1_793_611_800;

/// A message with an HTML body and two attachments, to forward.
const REPORT: &str = "From: Jane Doe <jane@example.com>\r\nTo: person@example.com\r\nDate: Mon, 2 Nov 2026 12:00:00 +0000\r\nSubject: Report\r\nMessage-ID: <report@example.com>\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=\"b\"\r\n\r\n--b\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nPlease find the report attached.\r\n--b\r\nContent-Type: text/csv; name=\"data.csv\"\r\nContent-Disposition: attachment; filename=\"data.csv\"\r\n\r\na,b\r\n1,2\r\n--b\r\nContent-Type: application/pdf\r\nContent-Disposition: attachment; filename=\"report.pdf\"\r\nContent-Transfer-Encoding: base64\r\n\r\nJVBERi0=\r\n--b--\r\n";

/// Starts the stack with one message from Jane in INBOX and the report.
async fn start_with_originals(server_keeps_sent_copy: bool) -> Stack {
    let mut mailbox = FakeMailbox::standard();
    let original = TestMessage::new("Hello", "Original text.", "orig@example.com", BASE);
    mailbox.add_message("INBOX", original.build(), &["\\Seen"], original.timestamp);
    mailbox.add_message("INBOX", REPORT.as_bytes().to_vec(), &[], BASE + 60);
    start_stack(mailbox, server_keeps_sent_copy).await
}

/// A message to Jane with the subject and body.
fn to_jane(subject: &str, body: &str) -> MessageArguments {
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

    let report = send_email(
        &stack.context,
        MessageArguments {
            cc: vec!["cc@example.com".to_owned()],
            bcc: vec!["hidden@example.com".to_owned()],
            ..to_jane("Grüße", "Hello Jane,\n\nBye.")
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
    let mails = stack.smtp.mails();
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
    let sent = stack.imap.messages("Sent");
    assert_eq!(sent.len(), 1);
    assert_eq!(sent[0].flags, vec!["\\Seen"]);
    assert_eq!(
        without_trailing_line_breaks(&sent[0].bytes),
        without_trailing_line_breaks(&mails[0].bytes)
    );
    let commands = stack.imap.commands();
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

    let report = send_email(&stack.context, to_jane("Hi", "Hello"))
        .await
        .expect("sent");

    assert!(
        report
            .text
            .ends_with("The server keeps a copy of sent mail."),
        "{}",
        report.text
    );
    assert_eq!(stack.smtp.mails().len(), 1);
    assert!(stack.imap.messages("Sent").is_empty());
    assert!(
        stack.imap.commands().is_empty(),
        "{:?}",
        stack.imap.commands()
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn replies_in_the_conversation_to_the_sender_by_default() {
    let stack = start_with_originals(false).await;

    let report = send_email(
        &stack.context,
        MessageArguments {
            body: "Thanks!".to_owned(),
            reply_to_id: Some("1.1001.INBOX".to_owned()),
            ..MessageArguments::default()
        },
    )
    .await
    .expect("sent");

    assert!(
        report
            .text
            .contains("\nTo: Jane Doe <jane@example.com>\nSubject: Re: Hello\n"),
        "{}",
        report.text
    );
    let mails = stack.smtp.mails();
    assert_eq!(mails.len(), 1);
    assert_eq!(mails[0].to, vec!["jane@example.com"]);
    let text = String::from_utf8_lossy(&mails[0].bytes);
    assert!(text.contains("Subject: Re: Hello\r\n"), "{text}");
    assert!(
        text.contains("In-Reply-To: <orig@example.com>\r\n"),
        "{text}"
    );
    assert!(
        text.contains("References: <orig@example.com>\r\n"),
        "{text}"
    );
    assert!(text.contains("Thanks!"), "{text}");
    let commands = stack.imap.commands();
    assert!(
        commands
            .iter()
            .any(|command| command.ends_with("UID FETCH 1 (UID FLAGS BODY.PEEK[])")),
        "{commands:?}"
    );
    assert!(
        !commands.iter().any(|command| command.contains("STORE")),
        "{commands:?}"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn forwards_the_original_text_and_attachments() {
    let stack = start_with_originals(false).await;

    let report = send_email(
        &stack.context,
        MessageArguments {
            to: vec!["colleague@example.com".to_owned()],
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
    let mails = stack.smtp.mails();
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
    stack.smtp.refuse_recipient("nobody@example.com");
    let wrong_password = ToolContext::new(
        email::account::parse_account_variable(
            &support::build_account_json(
                stack.imap.port,
                support::SecurityName::Tls,
                stack.smtp.port,
                support::SecurityName::Tls,
                false,
            )
            .replace(support::PASSWORD, "another-synthetic-value"),
        )
        .expect("account"),
        Trust::with_extra_roots(vec![stack.authority.root.clone()]),
    );

    let refused = send_email(
        &stack.context,
        MessageArguments {
            to: vec!["nobody@example.com".to_owned()],
            ..to_jane("Hi", "Hello")
        },
    )
    .await;
    let not_signed_in = send_email(&wrong_password, to_jane("Hi", "Hello")).await;

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
    assert!(stack.smtp.mails().is_empty());
    assert!(stack.imap.messages("Sent").is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn refuses_arguments_that_break_a_rule_before_connecting() {
    let stack = start_with_originals(false).await;

    let both = send_email(
        &stack.context,
        MessageArguments {
            reply_to_id: Some("1.1001.INBOX".to_owned()),
            forward_id: Some("1.1001.INBOX".to_owned()),
            ..to_jane("Hi", "Hello")
        },
    )
    .await;
    let nobody = send_email(
        &stack.context,
        MessageArguments {
            subject: "Hi".to_owned(),
            body: "Hello".to_owned(),
            ..MessageArguments::default()
        },
    )
    .await;
    let not_an_address = send_email(
        &stack.context,
        MessageArguments {
            to: vec!["not an address".to_owned()],
            ..to_jane("Hi", "Hello")
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
    assert!(stack.smtp.mails().is_empty());
    assert!(
        stack
            .smtp
            .state
            .lock()
            .expect("the state")
            .commands
            .is_empty()
    );
    assert!(stack.imap.commands().is_empty());
}
