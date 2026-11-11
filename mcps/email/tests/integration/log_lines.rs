//! The lines the server writes to standard error when the end of a
//! session goes wrong: a QUIT or LOGOUT that fails, or that does not
//! finish within the check's limit or the exchange limit. Each case runs
//! again, in a child process of this test binary, the in-process case
//! that reaches the line, whose limits pass on the paused clock, and reads
//! the line from the child's standard error, where `send_log_line` writes
//! it past the test harness's capture.

use crate::support::binary::{BinaryProcess, read_to_end_in_thread, wait_for_stream_end};

/// Runs a case of this test binary again in a child process, its input
/// ended at once, and asserts that the case passed and that the child
/// wrote the line to standard error.
///
/// # Arguments
///
/// * `case` - The case's path in this test binary, such as
///   `check::accepts_an_smtp_sign_in_whose_quit_fails`; the case starts no
///   process of its own.
/// * `line` - The line, without its line break.
///
/// # Panics
///
/// When the child does not run exactly that one case, the case fails, the
/// child or its output does not end within
/// [`STEP_WAIT_LIMIT`](crate::support::binary::STEP_WAIT_LIMIT), or no
/// line of its standard error is the line.
fn assert_logged_by_case(case: &str, line: &str) {
    let (mut child, streams) = BinaryProcess::start_test_case(case);
    drop(streams.input);
    let report = read_to_end_in_thread(streams.output);
    let log = read_to_end_in_thread(streams.log);
    let status = child.wait_for_exit();
    let report =
        String::from_utf8_lossy(&wait_for_stream_end(&report, "standard output")).into_owned();
    let log = String::from_utf8_lossy(&wait_for_stream_end(&log, "standard error")).into_owned();
    assert!(
        status.success() && report.contains("test result: ok. 1 passed;"),
        "{report}{log}"
    );
    assert!(log.lines().any(|logged| logged == line), "{log}");
}

/// Checks that the check case whose `LOGOUT` goes unanswered passes again
/// as a child process and writes
/// `imap: logout did not finish within the check's limit` on standard
/// error.
#[test]
fn logs_an_imap_logout_past_the_check_limit() {
    assert_logged_by_case(
        "check::ends_an_unanswered_logout_at_the_check_limit_and_accepts_the_sign_in",
        "imap: logout did not finish within the check's limit",
    );
}

/// Checks that the check case whose `QUIT` goes unanswered passes again as
/// a child process and writes
/// `smtp: quit did not finish within the check's limit` on standard error.
#[test]
fn logs_an_smtp_quit_past_the_check_limit() {
    assert_logged_by_case(
        "check::ends_an_unanswered_quit_at_the_check_limit_and_accepts_the_sign_in",
        "smtp: quit did not finish within the check's limit",
    );
}

/// Checks that the check case whose `QUIT` closes the connection passes
/// again as a child process and writes `smtp: quit failed` on standard
/// error.
#[test]
fn logs_a_failed_smtp_quit() {
    assert_logged_by_case(
        "check::accepts_an_smtp_sign_in_whose_quit_fails",
        "smtp: quit failed",
    );
}

/// Checks that the send case whose `QUIT` goes unanswered after the send
/// passes again as a child process and writes `smtp: quit timed out` on
/// standard error.
#[test]
fn logs_an_smtp_quit_that_times_out_after_a_send() {
    assert_logged_by_case(
        "smtp_steps::a_quit_without_an_answer_after_the_send_reports_it_sent_after_30_seconds",
        "smtp: quit timed out",
    );
}

/// Checks that the case whose `LOGOUT` the server refuses after
/// `list_folders` passes again as a child process and writes
/// `imap: logout refused` on standard error.
#[test]
fn logs_a_refused_imap_logout_after_a_call() {
    assert_logged_by_case(
        "imap_steps::a_logout_the_server_refuses_still_lists_the_folders",
        "imap: logout refused",
    );
}

/// Checks that the case whose `LOGOUT` goes unanswered after `list_folders`
/// passes again as a child process and writes `imap: logout timed out` on
/// standard error.
#[test]
fn logs_an_imap_logout_that_times_out_after_a_call() {
    assert_logged_by_case(
        "imap_steps::a_logout_without_an_answer_lists_the_folders_after_30_seconds",
        "imap: logout timed out",
    );
}
