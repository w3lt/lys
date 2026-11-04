//! `send_email` against an SMTP server that fails one step: each failure
//! is classed by how far the send came, the progress shows how far that
//! was when the call is stopped, and each step ends within its own time
//! limit, measured on the paused clock.

use std::time::Duration;

use email::failure::{ConnectionFailure, Protocol, SignInFailure, SmtpExtension, ToolFailure};
use email::smtp::{SendProgress, SendStage};
use email::tools::send::{MessageArguments, run_send_email};
use email::tools::{ToolContext, ToolReport};
use email::trust::Trust;

use crate::support::imap::{FakeImapServer, FakeMailbox, ImapMode};
use crate::support::smtp::{DATA_END, FakeSmtpServer, SmtpFault, SmtpMode};
use crate::support::tls::TestAuthority;
use crate::support::{SecurityName, Stack, TestServers, assert_about, build_account, start_stack};

/// A message to Jane.
fn build_message() -> MessageArguments {
    MessageArguments {
        to: vec!["Jane Doe <jane@example.com>".to_owned()],
        subject: "Hi".to_owned(),
        body: "Hello".to_owned(),
        ..MessageArguments::default()
    }
}

/// Builds the tools' context for an account whose SMTP server is the fake,
/// reached as the security says, and whose IMAP server is a plain fake.
async fn build_smtp_context(
    smtp: &FakeSmtpServer,
    smtp_security: SecurityName,
    authority: &TestAuthority,
) -> ToolContext {
    let imap = FakeImapServer::start(FakeMailbox::create_standard(), ImapMode::Plain, None).await;
    let servers = TestServers {
        imap_port: imap.port,
        imap_security: SecurityName::Plain,
        smtp_port: smtp.port,
        smtp_security,
    };
    ToolContext::new(
        build_account(servers, false),
        Trust::create_with_extra_roots(vec![authority.root.clone()]),
    )
}

/// The failure of a sign-in to the SMTP server that took too long.
fn build_sign_in_timeout() -> ToolFailure {
    ToolFailure::SignIn {
        protocol: Protocol::Smtp,
        failure: SignInFailure::TimedOut,
    }
}

/// The failure of a signed-in SMTP connection.
fn build_connection_failure(failure: ConnectionFailure) -> ToolFailure {
    ToolFailure::Connection {
        protocol: Protocol::Smtp,
        failure,
    }
}

/// Asserts that the fake has no mail and Sent no copy.
fn assert_nothing_delivered(stack: &Stack) {
    assert!(stack.smtp.list_mails().is_empty());
    assert!(stack.imap.list_messages("Sent").is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn a_connection_that_ends_before_the_data_ends_sends_nothing() {
    let stack = start_stack(FakeMailbox::create_standard(), false).await;
    stack.smtp.add_fault("RCPT", SmtpFault::Close);
    let progress = SendProgress::default();

    let sent = run_send_email(&stack.context, build_message(), &progress).await;

    assert_eq!(sent, Err(build_connection_failure(ConnectionFailure::Lost)));
    assert_eq!(progress.stage(), SendStage::NotHandedOver);
    assert_nothing_delivered(&stack);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_plain_text_connection_that_ends_before_a_reply_is_lost_too() {
    let authority = TestAuthority::new();
    let smtp = FakeSmtpServer::start(SmtpMode::Plain, None).await;
    smtp.add_fault("RCPT", SmtpFault::Close);
    let context = build_smtp_context(&smtp, SecurityName::Plain, &authority).await;
    let progress = SendProgress::default();

    let sent = run_send_email(&context, build_message(), &progress).await;

    assert_eq!(sent, Err(build_connection_failure(ConnectionFailure::Lost)));
    assert_eq!(progress.stage(), SendStage::NotHandedOver);
    assert!(smtp.list_mails().is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn a_connection_that_ends_after_the_data_ended_leaves_the_send_unconfirmed() {
    let stack = start_stack(FakeMailbox::create_standard(), false).await;
    stack.smtp.add_fault(DATA_END, SmtpFault::Close);
    let progress = SendProgress::default();

    let sent = run_send_email(&stack.context, build_message(), &progress).await;

    assert_eq!(sent, Err(ToolFailure::SendUnconfirmed));
    assert_eq!(progress.stage(), SendStage::HandedOver);
    assert_eq!(stack.smtp.list_mails().len(), 1);
    assert!(stack.imap.list_messages("Sent").is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn a_reply_that_is_not_smtp_fails_the_send_as_unreadable_and_sends_nothing() {
    let stack = start_stack(FakeMailbox::create_standard(), false).await;
    stack.smtp.add_fault("RCPT", SmtpFault::Garbage);
    let progress = SendProgress::default();

    let sent = run_send_email(&stack.context, build_message(), &progress).await;

    assert_eq!(
        sent,
        Err(build_connection_failure(ConnectionFailure::Unreadable))
    );
    assert_eq!(progress.stage(), SendStage::NotHandedOver);
    assert_nothing_delivered(&stack);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_send_the_server_accepted_reaches_the_accepted_stage() {
    let stack = start_stack(FakeMailbox::create_standard(), false).await;
    let progress = SendProgress::default();

    let sent = run_send_email(&stack.context, build_message(), &progress).await;

    assert!(sent.is_ok(), "{sent:?}");
    assert_eq!(progress.stage(), SendStage::Accepted);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_send_stopped_while_a_recipient_waits_was_not_handed_over() {
    let stack = start_stack(FakeMailbox::create_standard(), false).await;
    stack.smtp.add_fault("RCPT", SmtpFault::Stall);
    let progress = SendProgress::default();

    stack
        .smtp
        .stop_at_fault(run_send_email(&stack.context, build_message(), &progress))
        .await;

    assert_eq!(progress.stage(), SendStage::NotHandedOver);
    assert_nothing_delivered(&stack);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_send_stopped_while_the_server_answers_the_data_was_handed_over() {
    let stack = start_stack(FakeMailbox::create_standard(), false).await;
    stack.smtp.add_fault(DATA_END, SmtpFault::Stall);
    let progress = SendProgress::default();

    stack
        .smtp
        .stop_at_fault(run_send_email(&stack.context, build_message(), &progress))
        .await;

    assert_eq!(progress.stage(), SendStage::HandedOver);
    assert_eq!(stack.smtp.list_mails().len(), 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn an_address_beyond_ascii_is_not_offered_to_a_server_without_smtputf8() {
    let stack = start_stack(FakeMailbox::create_standard(), false).await;
    let progress = SendProgress::default();

    let sent = run_send_email(
        &stack.context,
        MessageArguments {
            to: vec!["jöran@example.com".to_owned()],
            ..build_message()
        },
        &progress,
    )
    .await;

    assert_eq!(
        sent,
        Err(ToolFailure::SmtpExtensionMissing(SmtpExtension::SmtpUtf8))
    );
    assert_eq!(progress.stage(), SendStage::NotHandedOver);
    assert!(
        !stack
            .smtp
            .list_commands()
            .iter()
            .any(|command| command.starts_with("MAIL")),
        "{:?}",
        stack.smtp.list_commands()
    );
    assert_nothing_delivered(&stack);
}

#[tokio::test]
async fn a_server_that_never_answers_the_tls_handshake_fails_the_sign_in_after_15_seconds() {
    let authority = TestAuthority::new();
    let smtp = FakeSmtpServer::start(SmtpMode::Silent, None).await;
    let context = build_smtp_context(&smtp, SecurityName::Tls, &authority).await;
    let progress = SendProgress::default();

    let (sent, elapsed) = smtp
        .run_past_fault(run_send_email(&context, build_message(), &progress))
        .await;

    assert_eq!(sent, Err(build_sign_in_timeout()));
    assert_about(elapsed, Duration::from_secs(15));
}

#[tokio::test]
async fn a_greeting_without_an_answer_to_ehlo_fails_the_sign_in_after_30_seconds() {
    let stack = start_stack(FakeMailbox::create_standard(), false).await;
    stack.smtp.add_fault("EHLO", SmtpFault::Stall);
    let progress = SendProgress::default();

    let (sent, elapsed) = stack
        .smtp
        .run_past_fault(run_send_email(&stack.context, build_message(), &progress))
        .await;

    assert_eq!(sent, Err(build_sign_in_timeout()));
    assert_about(elapsed, Duration::from_secs(30));
    assert_nothing_delivered(&stack);
}

#[tokio::test]
async fn starttls_without_an_answer_fails_the_sign_in_after_30_seconds() {
    let authority = TestAuthority::new();
    let smtp = FakeSmtpServer::start(SmtpMode::StartTls, Some(authority.build_acceptor())).await;
    smtp.add_fault("STARTTLS", SmtpFault::Stall);
    let context = build_smtp_context(&smtp, SecurityName::StartTls, &authority).await;
    let progress = SendProgress::default();

    let (sent, elapsed) = smtp
        .run_past_fault(run_send_email(&context, build_message(), &progress))
        .await;

    assert_eq!(sent, Err(build_sign_in_timeout()));
    assert_about(elapsed, Duration::from_secs(30));
}

#[tokio::test]
async fn a_sign_in_without_an_answer_fails_after_30_seconds() {
    let stack = start_stack(FakeMailbox::create_standard(), false).await;
    stack.smtp.add_fault("AUTH", SmtpFault::Stall);
    let progress = SendProgress::default();

    let (sent, elapsed) = stack
        .smtp
        .run_past_fault(run_send_email(&stack.context, build_message(), &progress))
        .await;

    assert_eq!(sent, Err(build_sign_in_timeout()));
    assert_about(elapsed, Duration::from_secs(30));
    assert_nothing_delivered(&stack);
}

#[tokio::test]
async fn a_recipient_without_an_answer_fails_the_send_after_30_seconds_and_sends_nothing() {
    let stack = start_stack(FakeMailbox::create_standard(), false).await;
    stack.smtp.add_fault("RCPT", SmtpFault::Stall);
    let progress = SendProgress::default();

    let (sent, elapsed) = stack
        .smtp
        .run_past_fault(run_send_email(&stack.context, build_message(), &progress))
        .await;

    assert_eq!(
        sent,
        Err(build_connection_failure(ConnectionFailure::TimedOut))
    );
    assert_about(elapsed, Duration::from_secs(30));
    assert_nothing_delivered(&stack);
}

#[tokio::test]
async fn data_without_an_answer_leaves_the_send_unconfirmed_after_120_seconds() {
    let stack = start_stack(FakeMailbox::create_standard(), false).await;
    stack.smtp.add_fault(DATA_END, SmtpFault::Stall);
    let progress = SendProgress::default();

    let (sent, elapsed) = stack
        .smtp
        .run_past_fault(run_send_email(&stack.context, build_message(), &progress))
        .await;

    assert_eq!(sent, Err(ToolFailure::SendUnconfirmed));
    assert_about(elapsed, Duration::from_secs(120));
    assert_eq!(progress.stage(), SendStage::HandedOver);
    assert_eq!(stack.smtp.list_mails().len(), 1);
    assert!(stack.imap.list_messages("Sent").is_empty());
}

#[tokio::test]
async fn a_quit_without_an_answer_after_the_send_reports_it_sent_after_30_seconds() {
    let stack = start_stack(FakeMailbox::create_standard(), true).await;
    stack.smtp.add_fault("QUIT", SmtpFault::Stall);
    let progress = SendProgress::default();

    let (sent, elapsed) = stack
        .smtp
        .run_past_fault(run_send_email(&stack.context, build_message(), &progress))
        .await;

    let report: ToolReport = sent.expect("sent");
    assert!(
        report.text.starts_with("Sent as Message-ID <"),
        "{report:?}"
    );
    assert_about(elapsed, Duration::from_secs(30));
    assert_eq!(progress.stage(), SendStage::Accepted);
    assert_eq!(stack.smtp.list_mails().len(), 1);
}
