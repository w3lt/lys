//! A tool call against an IMAP server that does not answer one step of
//! the sign-in, or that refuses or does not answer the LOGOUT after the
//! call: each sign-in step ends within its own time limit, measured on
//! the paused clock, as a sign-in that took too long; a refused LOGOUT
//! leaves the call's result as it was, and an unanswered one does too,
//! after its own limit.

use std::time::Duration;

use email::failure::{Protocol, SignInFailure, ToolFailure};
use email::tools::ToolContext;
use email::tools::folders::run_list_folders;
use email::trust::Trust;

use crate::support::imap::{FakeImapServer, FakeMailbox, ImapFault, ImapMode};
use crate::support::tls::TestAuthority;
use crate::support::{SecurityName, TestServers, assert_about, build_account, start_stack};

/// Builds the tools' context for an account whose IMAP server is the fake,
/// reached as the security says; its SMTP server is never reached.
fn build_imap_context(
    imap: &FakeImapServer,
    imap_security: SecurityName,
    authority: &TestAuthority,
) -> ToolContext {
    let servers = TestServers {
        imap_port: imap.port,
        imap_security,
        smtp_port: imap.port,
        smtp_security: SecurityName::Plain,
    };
    ToolContext::new(
        build_account(servers, false),
        Trust::create_with_extra_roots(vec![authority.root.clone()]),
    )
}

/// The failure of a sign-in to the IMAP server that took too long.
fn build_sign_in_timeout() -> ToolFailure {
    ToolFailure::SignIn {
        protocol: Protocol::Imap,
        failure: SignInFailure::TimedOut,
    }
}

#[tokio::test]
async fn a_server_that_never_answers_the_tls_handshake_fails_the_sign_in_after_15_seconds() {
    let authority = TestAuthority::new();
    let imap = FakeImapServer::start(FakeMailbox::create_standard(), ImapMode::Silent, None).await;
    let context = build_imap_context(&imap, SecurityName::Tls, &authority);

    let (listed, elapsed) = imap.run_past_fault(run_list_folders(&context)).await;

    assert_eq!(listed, Err(build_sign_in_timeout()));
    assert_about(elapsed, Duration::from_secs(15));
}

#[tokio::test]
async fn a_server_that_never_greets_fails_the_sign_in_after_30_seconds() {
    let authority = TestAuthority::new();
    let imap = FakeImapServer::start(FakeMailbox::create_standard(), ImapMode::Silent, None).await;
    let context = build_imap_context(&imap, SecurityName::Plain, &authority);

    let (listed, elapsed) = imap.run_past_fault(run_list_folders(&context)).await;

    assert_eq!(listed, Err(build_sign_in_timeout()));
    assert_about(elapsed, Duration::from_secs(30));
}

#[tokio::test]
async fn a_login_without_an_answer_fails_the_sign_in_after_30_seconds() {
    let stack = start_stack(FakeMailbox::create_standard(), false).await;
    stack.imap.add_fault("LOGIN", ImapFault::Stall);

    let (listed, elapsed) = stack
        .imap
        .run_past_fault(run_list_folders(&stack.context))
        .await;

    assert_eq!(listed, Err(build_sign_in_timeout()));
    assert_about(elapsed, Duration::from_secs(30));
    assert!(
        !stack
            .imap
            .list_commands()
            .iter()
            .any(|command| command.contains(" LIST ")),
        "{:?}",
        stack.imap.list_commands()
    );
}

#[tokio::test]
async fn a_logout_the_server_refuses_still_lists_the_folders() {
    let mut mailbox = FakeMailbox::create_standard();
    mailbox.add_refusal("LOGOUT", "NO Logout refused");
    let stack = start_stack(mailbox, false).await;

    let listed = run_list_folders(&stack.context).await;

    assert_eq!(listed.expect("the folders").log, "folders: 7 listed");
    let commands = stack.imap.list_commands();
    assert!(
        commands.iter().any(|command| command.ends_with(" LOGOUT")),
        "{commands:?}"
    );
}

#[tokio::test]
async fn a_logout_without_an_answer_lists_the_folders_after_30_seconds() {
    let stack = start_stack(FakeMailbox::create_standard(), false).await;
    stack.imap.add_fault("LOGOUT", ImapFault::Stall);

    let (listed, elapsed) = stack
        .imap
        .run_past_fault(run_list_folders(&stack.context))
        .await;

    assert_eq!(listed.expect("the folders").log, "folders: 7 listed");
    assert_about(elapsed, Duration::from_secs(30));
}
