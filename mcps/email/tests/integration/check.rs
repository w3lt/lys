//! The account check against the fakes: both sign-ins, each way they
//! fail, and the process contract of the `check` subcommand.

use std::process::Output;
use std::time::Duration;

use email::account::Account;
use email::check::{CheckOutcome, offer_account_sign_ins};
use email::failure::SignInFailure;
use email::trust::Trust;

use crate::support::binary::{BinaryProcess, read_to_end_in_thread, wait_for_stream_end};
use crate::support::imap::{FakeImapServer, FakeMailbox, ImapFault, ImapMode};
use crate::support::smtp::{FakeSmtpServer, SmtpFault, SmtpMode};
use crate::support::tls::TestAuthority;
use crate::support::{
    SecurityName, TestServers, assert_about, build_account, build_account_json,
    build_account_json_for,
};

/// Runs the binary with the arguments and the variable, its input ended at
/// once, and gives its output once it exited, waiting off the runtime's
/// threads.
///
/// # Panics
///
/// When the binary does not exit within
/// [`STEP_WAIT_LIMIT`](crate::support::binary::STEP_WAIT_LIMIT), or its output does not
/// end in time once it exited.
async fn read_binary_output(arguments: &[&str], variable: Option<&str>) -> Output {
    let (mut binary, streams) = BinaryProcess::start(arguments, variable);
    drop(streams.input);
    let stdout = read_to_end_in_thread(streams.output);
    let stderr = read_to_end_in_thread(streams.log);
    tokio::task::spawn_blocking(move || Output {
        status: binary.wait_for_exit(),
        stdout: wait_for_stream_end(&stdout, "standard output"),
        stderr: wait_for_stream_end(&stderr, "standard error"),
    })
    .await
    .expect("the task finishes")
}

/// How the two fakes of a check behave, and how the account reaches
/// each.
#[derive(Clone, Copy, Debug)]
struct FakeModes {
    /// How the IMAP fake behaves.
    imap: ImapMode,
    /// How the account reaches the IMAP fake.
    imap_security: SecurityName,
    /// How the SMTP fake behaves.
    smtp: SmtpMode,
    /// How the account reaches the SMTP fake.
    smtp_security: SecurityName,
}

/// Starts fakes in the modes and offers both sign-ins to them, with the
/// trust of the authority.
///
/// # Returns
///
/// The IMAP and the SMTP outcome.
async fn offer_sign_ins_to_fakes(
    authority: &TestAuthority,
    modes: FakeModes,
) -> (CheckOutcome, CheckOutcome) {
    let imap = FakeImapServer::start(
        FakeMailbox::create_standard(),
        modes.imap,
        Some(authority.build_acceptor()),
    )
    .await;
    let smtp = FakeSmtpServer::start(modes.smtp, Some(authority.build_acceptor())).await;
    let servers = TestServers {
        imap_port: imap.port,
        imap_security: modes.imap_security,
        smtp_port: smtp.port,
        smtp_security: modes.smtp_security,
    };
    let account = build_account(servers, false);
    let trust = Trust::create_with_extra_roots(vec![authority.root.clone()]);
    let report = offer_account_sign_ins(&account, &trust).await;
    (report.imap, report.smtp)
}

/// Returns a local port that nothing listens on.
async fn get_closed_port() -> u16 {
    let closed = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("a port");
    closed.local_addr().expect("the address").port()
}

/// Builds an account whose SMTP server is the plain fake and whose IMAP
/// server is a port nothing listens on.
async fn build_account_without_imap(smtp: &FakeSmtpServer) -> Account {
    build_account(
        TestServers {
            imap_port: get_closed_port().await,
            imap_security: SecurityName::Plain,
            smtp_port: smtp.port,
            smtp_security: SecurityName::Plain,
        },
        false,
    )
}

#[tokio::test(flavor = "multi_thread")]
async fn accepts_both_sign_ins_over_tls_and_starttls() {
    let authority = TestAuthority::new();

    let over_tls = offer_sign_ins_to_fakes(
        &authority,
        FakeModes {
            imap: ImapMode::Tls,
            imap_security: SecurityName::Tls,
            smtp: SmtpMode::Tls,
            smtp_security: SecurityName::Tls,
        },
    )
    .await;
    let over_starttls = offer_sign_ins_to_fakes(
        &authority,
        FakeModes {
            imap: ImapMode::StartTls,
            imap_security: SecurityName::StartTls,
            smtp: SmtpMode::StartTls,
            smtp_security: SecurityName::StartTls,
        },
    )
    .await;
    let plain = offer_sign_ins_to_fakes(
        &authority,
        FakeModes {
            imap: ImapMode::Plain,
            imap_security: SecurityName::Plain,
            smtp: SmtpMode::Plain,
            smtp_security: SecurityName::Plain,
        },
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
        FakeMailbox::create_standard(),
        ImapMode::Tls,
        Some(authority.build_acceptor()),
    )
    .await;
    let smtp = FakeSmtpServer::start(SmtpMode::Tls, Some(authority.build_acceptor())).await;
    let json = build_account_json(
        TestServers {
            imap_port: imap.port,
            imap_security: SecurityName::Tls,
            smtp_port: smtp.port,
            smtp_security: SecurityName::Tls,
        },
        false,
    )
    .replace(crate::support::PASSWORD, "another-synthetic-value");
    let account = email::account::parse_account_variable(&json).expect("account");

    let report = offer_account_sign_ins(
        &account,
        &Trust::create_with_extra_roots(vec![authority.root.clone()]),
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
    let account = build_account(
        TestServers {
            imap_port: port,
            imap_security: SecurityName::Tls,
            smtp_port: port,
            smtp_security: SecurityName::Tls,
        },
        false,
    );

    let report = offer_account_sign_ins(
        &account,
        &Trust::create_with_extra_roots(vec![authority.root.clone()]),
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
        FakeMailbox::create_standard(),
        ImapMode::Tls,
        Some(other.build_acceptor()),
    )
    .await;
    let smtp = FakeSmtpServer::start(SmtpMode::StartTls, Some(other.build_acceptor())).await;
    let account = build_account(
        TestServers {
            imap_port: imap.port,
            imap_security: SecurityName::Tls,
            smtp_port: smtp.port,
            smtp_security: SecurityName::StartTls,
        },
        false,
    );

    let report = offer_account_sign_ins(
        &account,
        &Trust::create_with_extra_roots(vec![authority.root.clone()]),
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

    let outcome = offer_sign_ins_to_fakes(
        &authority,
        FakeModes {
            imap: ImapMode::StartTlsRefused,
            imap_security: SecurityName::StartTls,
            smtp: SmtpMode::StartTlsRefused,
            smtp_security: SecurityName::StartTls,
        },
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
async fn reports_a_tls_account_against_a_plain_text_server_as_a_protocol_error() {
    let authority = TestAuthority::new();

    let outcome = offer_sign_ins_to_fakes(
        &authority,
        FakeModes {
            imap: ImapMode::Plain,
            imap_security: SecurityName::Tls,
            smtp: SmtpMode::Plain,
            smtp_security: SecurityName::Tls,
        },
    )
    .await;

    let protocol_error = CheckOutcome::Failed {
        reason: SignInFailure::ProtocolError,
    };
    assert_eq!(outcome, (protocol_error, protocol_error));
}

#[tokio::test(flavor = "multi_thread")]
async fn reports_a_server_that_speaks_something_else() {
    let authority = TestAuthority::new();

    let outcome = offer_sign_ins_to_fakes(
        &authority,
        FakeModes {
            imap: ImapMode::Garbage,
            imap_security: SecurityName::Plain,
            smtp: SmtpMode::Plain,
            smtp_security: SecurityName::Plain,
        },
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
async fn signs_in_to_smtp_with_login_where_the_server_offers_only_login() {
    let smtp = FakeSmtpServer::start(SmtpMode::Plain, None).await;
    smtp.add_withheld_mechanism("PLAIN");
    let account = build_account_without_imap(&smtp).await;

    let report =
        offer_account_sign_ins(&account, &Trust::create_with_extra_roots(Vec::new())).await;

    assert_eq!(report.smtp, CheckOutcome::Accepted);
    assert!(smtp.list_commands().iter().any(|line| line == "AUTH LOGIN"));
}

#[tokio::test(flavor = "multi_thread")]
async fn accepts_an_smtp_sign_in_whose_quit_fails() {
    let smtp = FakeSmtpServer::start(SmtpMode::Plain, None).await;
    smtp.add_fault("QUIT", SmtpFault::Close);
    let account = build_account_without_imap(&smtp).await;

    let report =
        offer_account_sign_ins(&account, &Trust::create_with_extra_roots(Vec::new())).await;

    assert_eq!(report.smtp, CheckOutcome::Accepted);
}

#[tokio::test]
async fn ends_an_unanswered_quit_at_the_check_limit_and_accepts_the_sign_in() {
    let smtp = FakeSmtpServer::start(SmtpMode::Plain, None).await;
    smtp.add_fault("QUIT", SmtpFault::Stall);
    let account = build_account_without_imap(&smtp).await;
    let trust = Trust::create_with_extra_roots(Vec::new());

    let (report, timing) = smtp
        .run_past_fault(offer_account_sign_ins(&account, &trust))
        .await;

    assert_eq!(report.smtp, CheckOutcome::Accepted);
    assert_about(timing, Duration::from_secs(20));
}

#[tokio::test]
async fn ends_an_unanswered_logout_at_the_check_limit_and_accepts_the_sign_in() {
    let imap = FakeImapServer::start(FakeMailbox::create_standard(), ImapMode::Plain, None).await;
    imap.add_fault("LOGOUT", ImapFault::Stall);
    let servers = TestServers {
        imap_port: imap.port,
        imap_security: SecurityName::Plain,
        smtp_port: get_closed_port().await,
        smtp_security: SecurityName::Plain,
    };
    let account = build_account(servers, false);
    let trust = Trust::create_with_extra_roots(Vec::new());

    let (report, timing) = imap
        .run_past_fault(offer_account_sign_ins(&account, &trust))
        .await;

    assert_eq!(report.imap, CheckOutcome::Accepted);
    assert_about(timing, Duration::from_secs(20));
}

#[tokio::test]
async fn ends_an_imap_sign_in_without_a_greeting_at_the_check_limit() {
    let imap = FakeImapServer::start(FakeMailbox::create_standard(), ImapMode::Silent, None).await;
    let servers = TestServers {
        imap_port: imap.port,
        imap_security: SecurityName::Plain,
        smtp_port: get_closed_port().await,
        smtp_security: SecurityName::Plain,
    };
    let account = build_account(servers, false);
    let trust = Trust::create_with_extra_roots(Vec::new());

    let (report, timing) = imap
        .run_past_fault(offer_account_sign_ins(&account, &trust))
        .await;

    assert_eq!(
        report.imap,
        CheckOutcome::Failed {
            reason: SignInFailure::TimedOut
        }
    );
    assert_eq!(
        report.smtp,
        CheckOutcome::Failed {
            reason: SignInFailure::Unreachable
        }
    );
    assert_about(timing, Duration::from_secs(20));
}

#[tokio::test(flavor = "multi_thread")]
async fn the_check_subcommand_prints_one_json_line_and_exits_0() {
    let authority = TestAuthority::new();
    let imap = FakeImapServer::start(FakeMailbox::create_standard(), ImapMode::Plain, None).await;
    let smtp = FakeSmtpServer::start(SmtpMode::Plain, None).await;
    drop(authority);
    let json = build_account_json(
        TestServers {
            imap_port: imap.port,
            imap_security: SecurityName::Plain,
            smtp_port: smtp.port,
            smtp_security: SecurityName::Plain,
        },
        false,
    );

    let output = read_binary_output(&["check"], Some(&json)).await;

    assert_eq!(output.status.code(), Some(0));
    assert_eq!(
        String::from_utf8_lossy(&output.stdout),
        "{\"imap\":{\"status\":\"accepted\"},\"smtp\":{\"status\":\"accepted\"}}\n"
    );
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(!stderr.contains(crate::support::PASSWORD), "{stderr}");
}

#[tokio::test(flavor = "multi_thread")]
async fn the_check_subcommand_logs_a_report_it_cannot_write_and_exits_1() {
    let json = build_account_json(
        TestServers {
            imap_port: get_closed_port().await,
            imap_security: SecurityName::Plain,
            smtp_port: get_closed_port().await,
            smtp_security: SecurityName::Plain,
        },
        false,
    );

    let (mut binary, stderr) = BinaryProcess::start_with_closed_output(&["check"], Some(&json));
    let stderr_bytes = read_to_end_in_thread(stderr);
    let (status, log) = tokio::task::spawn_blocking(move || {
        let status = binary.wait_for_exit();
        (status, wait_for_stream_end(&stderr_bytes, "standard error"))
    })
    .await
    .expect("the task finishes");

    assert_eq!(status.code(), Some(1));
    assert_eq!(
        String::from_utf8_lossy(&log),
        "check: the report could not be written: Broken pipe (os error 32)\n"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn refuses_to_start_without_a_usable_account_and_names_the_rule_only() {
    let missing = read_binary_output(&["check"], None).await;
    let plain_remote = read_binary_output(
        &["check"],
        Some(&build_account_json_for(
            "mail.example.com",
            TestServers {
                imap_port: 143,
                imap_security: SecurityName::Plain,
                smtp_port: 587,
                smtp_security: SecurityName::StartTls,
            },
            false,
        )),
    )
    .await;
    let not_json = read_binary_output(&[], Some("{not json")).await;
    let bad_arguments = read_binary_output(&["serve"], None).await;

    assert_eq!(missing.status.code(), Some(2));
    assert_eq!(
        String::from_utf8_lossy(&missing.stderr),
        "LYS_EMAIL_ACCOUNT: is not set\n"
    );
    assert_eq!(plain_remote.status.code(), Some(2));
    let stderr = String::from_utf8_lossy(&plain_remote.stderr);
    assert!(stderr.starts_with("LYS_EMAIL_ACCOUNT: "), "{stderr}");
    assert!(
        !stderr.contains("mail.example.com") && !stderr.contains(crate::support::PASSWORD),
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
