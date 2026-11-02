//! The account check against the fakes: both sign-ins, each way they
//! fail, and the process contract of the `check` subcommand.

mod support;

use email::check::{CheckOutcome, run_account_check};
use email::failure::SignInFailure;
use email::trust::Trust;

use support::imap::{FakeImapServer, FakeMailbox, ImapMode};
use support::smtp::{FakeSmtpServer, SmtpMode};
use support::tls::TestAuthority;
use support::{SecurityName, build_account, build_account_json, build_account_json_for};

/// Runs the binary with the arguments and the variable, off the runtime's
/// threads, and gives its output.
async fn run_binary(arguments: &[&str], variable: Option<&str>) -> std::process::Output {
    let mut command = std::process::Command::new(env!("CARGO_BIN_EXE_email"));
    command.args(arguments);
    match variable {
        Some(value) => command.env("LYS_EMAIL_ACCOUNT", value),
        None => command.env_remove("LYS_EMAIL_ACCOUNT"),
    };
    tokio::task::spawn_blocking(move || command.output().expect("the binary runs"))
        .await
        .expect("the task finishes")
}

/// Runs the check against fakes in the modes, with the trust of the
/// authority.
async fn check(
    authority: &TestAuthority,
    imap_mode: ImapMode,
    imap_security: SecurityName,
    smtp_mode: SmtpMode,
    smtp_security: SecurityName,
) -> (CheckOutcome, CheckOutcome) {
    let imap = FakeImapServer::start(
        FakeMailbox::standard(),
        imap_mode,
        Some(authority.build_acceptor()),
    )
    .await;
    let smtp = FakeSmtpServer::start(smtp_mode, Some(authority.build_acceptor())).await;
    let account = build_account(imap.port, imap_security, smtp.port, smtp_security, false);
    let trust = Trust::with_extra_roots(vec![authority.root.clone()]);
    let report = run_account_check(&account, &trust).await;
    (report.imap, report.smtp)
}

#[tokio::test(flavor = "multi_thread")]
async fn accepts_both_sign_ins_over_tls_and_starttls() {
    let authority = TestAuthority::new();

    let over_tls = check(
        &authority,
        ImapMode::Tls,
        SecurityName::Tls,
        SmtpMode::Tls,
        SecurityName::Tls,
    )
    .await;
    let over_starttls = check(
        &authority,
        ImapMode::StartTls,
        SecurityName::StartTls,
        SmtpMode::StartTls,
        SecurityName::StartTls,
    )
    .await;
    let plain = check(
        &authority,
        ImapMode::Plain,
        SecurityName::Plain,
        SmtpMode::Plain,
        SecurityName::Plain,
    )
    .await;

    assert_eq!(over_tls, (CheckOutcome::Accepted, CheckOutcome::Accepted));
    assert_eq!(
        over_starttls,
        (CheckOutcome::Accepted, CheckOutcome::Accepted)
    );
    assert_eq!(plain, (CheckOutcome::Accepted, CheckOutcome::Accepted));
}

#[tokio::test(flavor = "multi_thread")]
async fn reports_a_wrong_password_on_each_server() {
    let authority = TestAuthority::new();
    let imap = FakeImapServer::start(
        FakeMailbox::standard(),
        ImapMode::Tls,
        Some(authority.build_acceptor()),
    )
    .await;
    let smtp = FakeSmtpServer::start(SmtpMode::Tls, Some(authority.build_acceptor())).await;
    let json = build_account_json(
        imap.port,
        SecurityName::Tls,
        smtp.port,
        SecurityName::Tls,
        false,
    )
    .replace(support::PASSWORD, "another-synthetic-value");
    let account = email::account::parse_account_variable(&json).expect("account");

    let report = run_account_check(
        &account,
        &Trust::with_extra_roots(vec![authority.root.clone()]),
    )
    .await;

    assert_eq!(
        report.imap,
        CheckOutcome::Failed {
            reason: SignInFailure::WrongPassword
        }
    );
    assert_eq!(
        report.smtp,
        CheckOutcome::Failed {
            reason: SignInFailure::WrongPassword
        }
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn reports_servers_that_cannot_be_reached() {
    let authority = TestAuthority::new();
    let closed = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("a port");
    let port = closed.local_addr().expect("the address").port();
    drop(closed);
    let account = build_account(port, SecurityName::Tls, port, SecurityName::Tls, false);

    let report = run_account_check(
        &account,
        &Trust::with_extra_roots(vec![authority.root.clone()]),
    )
    .await;

    assert_eq!(
        report.imap,
        CheckOutcome::Failed {
            reason: SignInFailure::Unreachable
        }
    );
    assert_eq!(
        report.smtp,
        CheckOutcome::Failed {
            reason: SignInFailure::Unreachable
        }
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn reports_certificates_the_trust_refuses() {
    let authority = TestAuthority::new();
    let other = TestAuthority::new();
    let imap = FakeImapServer::start(
        FakeMailbox::standard(),
        ImapMode::Tls,
        Some(other.build_acceptor()),
    )
    .await;
    let smtp = FakeSmtpServer::start(SmtpMode::StartTls, Some(other.build_acceptor())).await;
    let account = build_account(
        imap.port,
        SecurityName::Tls,
        smtp.port,
        SecurityName::StartTls,
        false,
    );

    let report = run_account_check(
        &account,
        &Trust::with_extra_roots(vec![authority.root.clone()]),
    )
    .await;

    assert_eq!(
        report.imap,
        CheckOutcome::Failed {
            reason: SignInFailure::CertificateRefused
        }
    );
    assert_eq!(
        report.smtp,
        CheckOutcome::Failed {
            reason: SignInFailure::CertificateRefused
        }
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn reports_servers_that_do_not_offer_starttls() {
    let authority = TestAuthority::new();

    let outcome = check(
        &authority,
        ImapMode::StartTlsRefused,
        SecurityName::StartTls,
        SmtpMode::StartTlsRefused,
        SecurityName::StartTls,
    )
    .await;

    assert_eq!(
        outcome,
        (
            CheckOutcome::Failed {
                reason: SignInFailure::EncryptionNotOffered
            },
            CheckOutcome::Failed {
                reason: SignInFailure::EncryptionNotOffered
            }
        )
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn reports_a_server_that_speaks_something_else() {
    let authority = TestAuthority::new();

    let outcome = check(
        &authority,
        ImapMode::Garbage,
        SecurityName::Plain,
        SmtpMode::Plain,
        SecurityName::Plain,
    )
    .await;

    assert_eq!(
        outcome.0,
        CheckOutcome::Failed {
            reason: SignInFailure::ProtocolError
        }
    );
    assert_eq!(outcome.1, CheckOutcome::Accepted);
}

#[tokio::test(flavor = "multi_thread")]
async fn the_check_subcommand_prints_one_json_line_and_exits_0() {
    let authority = TestAuthority::new();
    let imap = FakeImapServer::start(FakeMailbox::standard(), ImapMode::Plain, None).await;
    let smtp = FakeSmtpServer::start(SmtpMode::Plain, None).await;
    drop(authority);
    let json = build_account_json(
        imap.port,
        SecurityName::Plain,
        smtp.port,
        SecurityName::Plain,
        false,
    );

    let output = run_binary(&["check"], Some(&json)).await;

    assert_eq!(output.status.code(), Some(0));
    assert_eq!(
        String::from_utf8_lossy(&output.stdout),
        "{\"imap\":{\"status\":\"accepted\"},\"smtp\":{\"status\":\"accepted\"}}\n"
    );
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(!stderr.contains(support::PASSWORD), "{stderr}");
}

#[tokio::test(flavor = "multi_thread")]
async fn refuses_to_start_without_a_usable_account_and_names_the_rule_only() {
    let missing = run_binary(&["check"], None).await;
    let plain_remote = run_binary(
        &["check"],
        Some(&build_account_json_for(
            "mail.example.com",
            143,
            SecurityName::Plain,
            587,
            SecurityName::StartTls,
            false,
        )),
    )
    .await;
    let not_json = run_binary(&[], Some("{not json")).await;
    let bad_arguments = run_binary(&["serve"], None).await;

    assert_eq!(missing.status.code(), Some(2));
    assert_eq!(
        String::from_utf8_lossy(&missing.stderr),
        "LYS_EMAIL_ACCOUNT: is not set\n"
    );
    assert_eq!(plain_remote.status.code(), Some(2));
    let stderr = String::from_utf8_lossy(&plain_remote.stderr);
    assert!(stderr.starts_with("LYS_EMAIL_ACCOUNT: "), "{stderr}");
    assert!(
        !stderr.contains("mail.example.com") && !stderr.contains(support::PASSWORD),
        "{stderr}"
    );
    assert!(plain_remote.stdout.is_empty());
    assert_eq!(not_json.status.code(), Some(2));
    assert_eq!(bad_arguments.status.code(), Some(64));
    assert_eq!(
        String::from_utf8_lossy(&bad_arguments.stderr),
        "usage: email [check]\n"
    );
}
