//! `send_email` against the fake SMTP and IMAP servers: plain sends,
//! replies, forwards, the Sent copy, and refusals.

use email::failure::{Protocol, SignInFailure, ToolFailure};
use email::message::parse_message;
use email::smtp::SendProgress;
use email::tools::send::{MessageArguments, run_send_email};
use email::tools::{ToolContext, ToolResult};
use email::trust::Trust;

use crate::support::imap::{FakeImapServer, FakeMailbox, ImapFault, NewMessage};
use crate::support::smtp::SentMail;
use crate::support::{
    ADDRESS, Stack, TestMessage, assert_nothing_sent, calculate_trimmed_bytes, start_stack,
};

/// The time the original message was sent.
const BASE: i64 = 1_793_611_800;

/// Starts the stack with one message from Jane in INBOX, `1.1001.INBOX`,
/// the report, `2.1001.INBOX`, and the redirected message,
/// `3.1001.INBOX`.
async fn start_with_originals(server_keeps_sent_copy: bool) -> Stack {
    /// A message with an HTML body and two attachments, to forward.
    const REPORT: &str = "From: Jane Doe <jane@example.com>\r\nTo: person@example.com\r\nDate: Mon, 2 Nov 2026 12:00:00 +0000\r\nSubject: Report\r\nMessage-ID: <report@example.com>\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=\"b\"\r\n\r\n--b\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nPlease find the report attached.\r\n--b\r\nContent-Type: text/csv; name=\"data.csv\"\r\nContent-Disposition: attachment; filename=\"data.csv\"\r\n\r\na,b\r\n1,2\r\n--b\r\nContent-Type: application/pdf\r\nContent-Disposition: attachment; filename=\"report.pdf\"\r\nContent-Transfer-Encoding: base64\r\n\r\nJVBERi0=\r\n--b--\r\n";

    /// A message whose sender's name needs quotes and whose Reply-To asks for
    /// replies to go to two other mailboxes.
    const REDIRECTED: &str = "From: \"Doe, Jane\" <jane@example.com>\r\nReply-To: a@example.com, Team <b@example.com>\r\nTo: person@example.com\r\nDate: Mon, 2 Nov 2026 12:05:00 +0000\r\nSubject: Plans\r\nMessage-ID: <plans@example.com>\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nWhat do you think?\r\n";

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

/// Sends a message with send_email, without a stop.
///
/// # Arguments
///
/// * `context` - The account and trust the tool runs with.
/// * `arguments` - The message's fields.
async fn send_message(context: &ToolContext, arguments: MessageArguments) -> ToolResult {
    run_send_email(context, arguments, &SendProgress::default()).await
}

/// Asserts that Sent holds one read copy of the mail, which one APPEND
/// put there.
///
/// # Arguments
///
/// * `imap` - The IMAP fake that holds Sent.
/// * `mail` - The mail as the SMTP fake received it.
fn assert_one_read_copy_in_sent(imap: &FakeImapServer, mail: &SentMail) {
    let sent = imap.list_messages("Sent");
    assert_eq!(sent.len(), 1);
    assert_eq!(sent[0].flags, vec!["\\Seen"]);
    assert_eq!(
        calculate_trimmed_bytes(&sent[0].bytes),
        calculate_trimmed_bytes(&mail.bytes)
    );
    let commands = imap.list_commands();
    let appends: Vec<&String> = commands
        .iter()
        .filter(|command| command.contains(" APPEND "))
        .collect();
    assert_eq!(appends.len(), 1, "{commands:?}");
    assert!(
        appends[0].contains(" APPEND \"Sent\" (\\Seen) "),
        "{commands:?}"
    );
}

/// A reply to the redirected message, `3.1001.INBOX`, to its sender, with
/// the mailboxes its Reply-To names in Cc.
fn build_reply_to_plans() -> MessageArguments {
    MessageArguments {
        from: crate::support::ADDRESS.to_owned(),
        to: vec!["\"Doe, Jane\" <jane@example.com>".to_owned()],
        cc: vec![
            "a@example.com".to_owned(),
            "Team <b@example.com>".to_owned(),
        ],
        subject: "Re: Plans".to_owned(),
        body: "Sounds good.".to_owned(),
        reply_to_id: Some("3.1001.INBOX".to_owned()),
        ..MessageArguments::default()
    }
}

/// A message to Jane with the subject and body.
fn build_message_to_jane(subject: &str, body: &str) -> MessageArguments {
    MessageArguments {
        from: crate::support::ADDRESS.to_owned(),
        to: vec!["Jane Doe <jane@example.com>".to_owned()],
        subject: subject.to_owned(),
        body: body.to_owned(),
        ..MessageArguments::default()
    }
}

/// Checks that `send_email` sends one mail to the `To`, `Cc`, and `Bcc`
/// recipients, with no `Bcc` field in it, saves one read copy of it in Sent
/// with one `APPEND`, and reports the Message-ID, the fields, and the copy.
#[tokio::test(flavor = "multi_thread")]
async fn sends_a_message_and_keeps_one_read_copy_in_sent_without_the_bcc_field() {
    let stack = start_with_originals(false).await;

    let report = send_message(
        &stack.context,
        MessageArguments {
            from: crate::support::ADDRESS.to_owned(),
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
    assert_one_read_copy_in_sent(&stack.imap, &mails[0]);
}

/// Checks that `send_email`, for an account whose server keeps a copy of
/// sent mail, sends the mail, sends no IMAP command, and says that the
/// server keeps the copy.
#[tokio::test(flavor = "multi_thread")]
async fn keeps_no_copy_when_the_server_keeps_one() {
    let stack = start_with_originals(true).await;

    let report = run_send_email(
        &stack.context,
        build_message_to_jane("Hi", "Hello"),
        &SendProgress::default(),
    )
    .await
    .expect("sent");

    assert!(
        report
            .text
            .ends_with("The server keeps a copy of sent mail."),
        "{}",
        report.text
    );
    assert_eq!(
        report.log,
        "send: 1 recipient(s), 0 attachment(s), copy kept by the server"
    );
    assert_eq!(stack.smtp.list_mails().len(), 1);
    assert!(stack.imap.list_messages("Sent").is_empty());
    assert!(
        stack.imap.list_commands().is_empty(),
        "{:?}",
        stack.imap.list_commands()
    );
}

/// Checks that `send_email` refuses a reply without recipients, naming the
/// original's sender and any `Reply-To` mailboxes, and one with a blank
/// subject, suggesting a `Re:` subject, and sends no SMTP command.
#[tokio::test(flavor = "multi_thread")]
async fn refuses_a_reply_that_leaves_out_its_recipients_or_subject() {
    let stack = start_with_originals(false).await;

    let to_jane = run_send_email(
        &stack.context,
        MessageArguments {
            from: crate::support::ADDRESS.to_owned(),
            body: "Thanks!".to_owned(),
            reply_to_id: Some("1.1001.INBOX".to_owned()),
            ..MessageArguments::default()
        },
        &SendProgress::default(),
    )
    .await;
    let redirected = run_send_email(
        &stack.context,
        MessageArguments {
            from: crate::support::ADDRESS.to_owned(),
            subject: "Re: Plans".to_owned(),
            body: "Sounds good.".to_owned(),
            reply_to_id: Some("3.1001.INBOX".to_owned()),
            ..MessageArguments::default()
        },
        &SendProgress::default(),
    )
    .await;
    let untitled = run_send_email(
        &stack.context,
        MessageArguments {
            from: crate::support::ADDRESS.to_owned(),
            subject: " ".to_owned(),
            reply_to_id: Some("3.1001.INBOX".to_owned()),
            ..build_message_to_jane("", "Sounds good.")
        },
        &SendProgress::default(),
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
    assert_nothing_sent(&stack.smtp);
}

/// Checks that `send_email` refuses a reply without recipients to a message
/// with no `From` field by naming only its `Reply-To` mailbox, and sends no
/// SMTP command.
#[tokio::test(flavor = "multi_thread")]
async fn tells_a_reply_without_recipients_only_where_replies_go_when_no_sender_is_named() {
    /// A message without a From field whose Reply-To asks for replies to go
    /// to one mailbox.
    const NO_SENDER: &str = "Reply-To: a@example.com\r\nTo: person@example.com\r\nDate: Mon, 2 Nov 2026 12:10:00 +0000\r\nSubject: Notice\r\nMessage-ID: <notice@example.com>\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nPlease answer.\r\n";

    let mut mailbox = FakeMailbox::create_standard();
    mailbox.add_message(
        "INBOX",
        NewMessage {
            bytes: NO_SENDER.as_bytes().to_vec(),
            flags: &[],
            timestamp: BASE,
        },
    );
    let stack = start_stack(mailbox, false).await;

    let refused = send_message(
        &stack.context,
        MessageArguments {
            from: crate::support::ADDRESS.to_owned(),
            subject: "Re: Notice".to_owned(),
            body: "Done.".to_owned(),
            reply_to_id: Some("1.1001.INBOX".to_owned()),
            ..MessageArguments::default()
        },
    )
    .await;

    assert_eq!(
        refused,
        Err(ToolFailure::Argument(
            "A reply needs its recipients in to, cc, or bcc. The message replied to asks for replies to go to [\"a@example.com\"].".to_owned()
        ))
    );
    assert_nothing_sent(&stack.smtp);
}

/// Checks that `send_email` sends a reply to exactly the recipients given,
/// in the original's conversation through `In-Reply-To` and `References`,
/// fetching the original with `BODY.PEEK` and sending no `STORE`.
#[tokio::test(flavor = "multi_thread")]
async fn replies_in_the_conversation_to_exactly_the_recipients_given() {
    let stack = start_with_originals(false).await;

    let report = send_message(&stack.context, build_reply_to_plans())
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
    let parts = [
        "Subject: Re: Plans\r\n",
        "In-Reply-To: <plans@example.com>\r\n",
        "References: <plans@example.com>\r\n",
        "Sounds good.",
    ];
    for part in parts {
        assert!(text.contains(part), "{text}");
    }
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

/// Checks that `send_email` refuses a forward without recipients and
/// subject with one failure that names both and suggests a `Fwd:` subject,
/// and sends no SMTP command.
#[tokio::test(flavor = "multi_thread")]
async fn refuses_a_forward_that_leaves_out_its_recipients_or_subject() {
    let stack = start_with_originals(false).await;

    let forwarded = run_send_email(
        &stack.context,
        MessageArguments {
            from: crate::support::ADDRESS.to_owned(),
            body: "FYI".to_owned(),
            forward_id: Some("2.1001.INBOX".to_owned()),
            ..MessageArguments::default()
        },
        &SendProgress::default(),
    )
    .await;

    assert_eq!(
        forwarded,
        Err(ToolFailure::Argument(
            "A forward needs its recipients in to, cc, or bcc. A forward needs a subject, such as \"Fwd: Report\".".to_owned()
        ))
    );
    assert_nothing_sent(&stack.smtp);
}

/// Checks that `send_email` forwards a message with the given text, then
/// the original's header fields and text, and the original's two
/// attachments with their contents.
#[tokio::test(flavor = "multi_thread")]
async fn forwards_the_original_text_and_attachments() {
    let stack = start_with_originals(false).await;

    let report = run_send_email(
        &stack.context,
        MessageArguments {
            from: crate::support::ADDRESS.to_owned(),
            to: vec!["colleague@example.com".to_owned()],
            subject: "Fwd: Report".to_owned(),
            body: "FYI".to_owned(),
            forward_id: Some("2.1001.INBOX".to_owned()),
            ..MessageArguments::default()
        },
        &SendProgress::default(),
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

/// Checks that `send_email` reports a recipient the SMTP server refuses
/// with the server's code and text, and a refused SMTP sign-in as a wrong
/// password, with no mail received and no copy in Sent.
#[tokio::test(flavor = "multi_thread")]
async fn reports_a_refused_recipient_and_a_refused_sign_in_without_a_sent_copy() {
    let stack = start_with_originals(false).await;
    stack.smtp.add_refused_recipient("nobody@example.com");
    let wrong_password = ToolContext::new(
        email::mailbox::Mailbox::Person,
        email::account::parse_account_variable(
            &crate::support::build_account_json(
                crate::support::TestServers {
                    imap_port: stack.imap.port,
                    imap_security: crate::support::SecurityName::Tls,
                    smtp_port: stack.smtp.port,
                    smtp_security: crate::support::SecurityName::Tls,
                },
                false,
            )
            .replace(crate::support::PASSWORD, "another-synthetic-value"),
        )
        .expect("account"),
        email::tools::SharedCalls::new(Trust::create_with_extra_roots(vec![
            stack.authority.root.clone(),
        ])),
    );

    let refused = run_send_email(
        &stack.context,
        MessageArguments {
            from: crate::support::ADDRESS.to_owned(),
            to: vec!["nobody@example.com".to_owned()],
            ..build_message_to_jane("Hi", "Hello")
        },
        &SendProgress::default(),
    )
    .await;
    let not_signed_in = run_send_email(
        &wrong_password,
        build_message_to_jane("Hi", "Hello"),
        &SendProgress::default(),
    )
    .await;

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

/// Checks that `send_email` refuses both a reply and a forward id, no
/// recipient, and a recipient that is not an address, each with its own
/// sentence, and sends no SMTP or IMAP command.
#[tokio::test(flavor = "multi_thread")]
async fn refuses_arguments_that_break_a_rule_before_connecting() {
    let stack = start_with_originals(false).await;

    let both = run_send_email(
        &stack.context,
        MessageArguments {
            from: crate::support::ADDRESS.to_owned(),
            reply_to_id: Some("1.1001.INBOX".to_owned()),
            forward_id: Some("1.1001.INBOX".to_owned()),
            ..build_message_to_jane("Hi", "Hello")
        },
        &SendProgress::default(),
    )
    .await;
    let nobody = run_send_email(
        &stack.context,
        MessageArguments {
            from: crate::support::ADDRESS.to_owned(),
            subject: "Hi".to_owned(),
            body: "Hello".to_owned(),
            ..MessageArguments::default()
        },
        &SendProgress::default(),
    )
    .await;
    let not_an_address = run_send_email(
        &stack.context,
        MessageArguments {
            from: crate::support::ADDRESS.to_owned(),
            to: vec!["not an address".to_owned()],
            ..build_message_to_jane("Hi", "Hello")
        },
        &SendProgress::default(),
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
    assert_nothing_sent(&stack.smtp);
    assert!(stack.imap.list_commands().is_empty());
}

/// Checks that `send_email` sends the mail when no folder is the Sent one,
/// says that no copy was saved, and sends no `APPEND`.
#[tokio::test(flavor = "multi_thread")]
async fn sends_a_message_without_a_copy_when_no_folder_is_the_sent_one() {
    let mut mailbox = FakeMailbox::create_standard();
    mailbox.folders.retain(|folder| folder.name != "Sent");
    let stack = start_stack(mailbox, false).await;

    let report = run_send_email(
        &stack.context,
        build_message_to_jane("Hi", "Hello"),
        &SendProgress::default(),
    )
    .await
    .expect("sent");

    assert!(
        report
            .text
            .ends_with("\nNo Sent folder was found, so no copy was saved."),
        "{}",
        report.text
    );
    assert_eq!(
        report.log,
        "send: 1 recipient(s), 0 attachment(s), copy no folder"
    );
    assert_eq!(stack.smtp.list_mails().len(), 1);
    assert!(
        !stack
            .imap
            .list_commands()
            .iter()
            .any(|command| command.contains(" APPEND ")),
        "{:?}",
        stack.imap.list_commands()
    );
}

/// Checks that `send_email` reports a mail as sent when the IMAP server
/// closes the connection on its copy's `APPEND` without saving it, says why
/// the copy could not be saved, and logs the failure's class.
#[tokio::test(flavor = "multi_thread")]
async fn reports_a_message_sent_before_its_copy_failed_as_sent() {
    let stack = start_stack(FakeMailbox::create_standard(), false).await;
    stack.imap.add_fault("APPEND", ImapFault::Close);

    let report = run_send_email(
        &stack.context,
        build_message_to_jane("Hi", "Hello"),
        &SendProgress::default(),
    )
    .await
    .expect("sent");

    assert!(
        report.text.ends_with(
            "\nThe copy could not be saved in Sent: The connection to the IMAP server ended before it answered."
        ),
        "{}",
        report.text
    );
    assert_eq!(
        report.log,
        "send: 1 recipient(s), 0 attachment(s), copy failed (imap-connection-lost)"
    );
    assert_eq!(stack.smtp.list_mails().len(), 1);
    assert!(stack.imap.list_messages("Sent").is_empty());
}

/// Checks that `send_email` reports a mail as sent when the IMAP server
/// refuses its copy's `APPEND`, giving the server's reason, and logs the
/// failure's class.
#[tokio::test(flavor = "multi_thread")]
async fn reports_a_message_sent_before_the_server_refused_its_copy_as_sent_with_the_reason() {
    let mut mailbox = FakeMailbox::create_standard();
    mailbox.add_refusal("APPEND", "NO [OVERQUOTA] Quota exceeded");
    let stack = start_stack(mailbox, false).await;

    let report = send_message(&stack.context, build_message_to_jane("Hi", "Hello"))
        .await
        .expect("sent");

    assert!(
        report.text.ends_with(
            "\nThe copy could not be saved in Sent: The IMAP server refused to save the copy: [OVERQUOTA] Quota exceeded."
        ),
        "{}",
        report.text
    );
    assert_eq!(
        report.log,
        "send: 1 recipient(s), 0 attachment(s), copy failed (imap-refused-to-save-the-copy)"
    );
    assert_eq!(stack.smtp.list_mails().len(), 1);
    assert!(stack.imap.list_messages("Sent").is_empty());
}

/// Checks that `send_email` says a copy may or may not have been saved when
/// the IMAP server saves it but closes the connection before answering the
/// `APPEND`, and logs the copy as unconfirmed.
#[tokio::test(flavor = "multi_thread")]
async fn reports_a_copy_whose_answer_was_lost_once_all_of_it_was_sent_as_maybe_saved() {
    let stack = start_stack(FakeMailbox::create_standard(), false).await;
    stack
        .imap
        .add_fault("APPEND", ImapFault::CloseAfterHandling);

    let report = send_message(&stack.context, build_message_to_jane("Hi", "Hello"))
        .await
        .expect("sent");

    assert!(
        report.text.ends_with(
            "\nThe copy may or may not have been saved in Sent: The connection to the IMAP server ended before it answered."
        ),
        "{}",
        report.text
    );
    assert_eq!(
        report.log,
        "send: 1 recipient(s), 0 attachment(s), copy unconfirmed (imap-connection-lost)"
    );
    assert_eq!(stack.smtp.list_mails().len(), 1);
    assert_eq!(stack.imap.list_messages("Sent").len(), 1);
}
