//! The entry point: serves MCP over standard input and output for the
//! mailboxes whose accounts are in `LYS_EMAIL_ACCOUNT` and
//! `LYS_EMAIL_LYS_ACCOUNT`, or runs the account check for the account in
//! `LYS_EMAIL_ACCOUNT`, whichever mailbox it is for.

use std::io::{self, Write};
use std::process::ExitCode;

use email::account::{read_account, read_served_accounts};
use email::check::{CheckReport, offer_account_sign_ins};
use email::log::send_log_line;
use email::mailbox::Mailbox;
use email::server::EmailServer;
use email::tools::{SharedCalls, ToolContext};
use email::trust::Trust;
use rmcp::ServiceExt;

/// Exit code when the arguments are not understood (EX_USAGE).
const USAGE_EXIT_CODE: u8 = 64;

/// Exit code when the variables give no account the server may use.
const ACCOUNT_EXIT_CODE: u8 = 2;

/// What the process was started to do.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Command {
    /// Serve MCP over standard input and output.
    Serve,
    /// Check the account and print the report.
    Check,
}

/// Runs the binary: with no argument, it serves MCP over standard input and
/// output for each mailbox whose variable is set, the person's in
/// `LYS_EMAIL_ACCOUNT` and Lys's in `LYS_EMAIL_LYS_ACCOUNT`, until the
/// service stops; with `check`, it signs in to both servers of the account
/// in `LYS_EMAIL_ACCOUNT`, whichever mailbox it is for, and prints the
/// report on standard output as one JSON line.
///
/// It logs to standard error: `usage: email [check]` for any other
/// arguments; a variable's name and its problem, never its value, when the
/// variables give no account it may use; `check: the report could not be
/// written:` and the reason; `server: starting failed:` and the reason;
/// `server: serving MCP over stdio for` and the mailboxes, by name, once it
/// serves; and, once it stops, `server: stopped` with the reason, or
/// `server: stopped with a failure:` and the failure.
///
/// # Returns
///
/// The exit code: 64 (EX_USAGE) for other arguments; 2 when the check's
/// variable gives no account, or when serving, neither variable is set,
/// one that is set gives no account, or the two accounts are one mailbox;
/// 1 when the report could not be written, the server could not start, or
/// its service failed; and 0 once the report is printed or the server
/// stopped otherwise. The report cannot be written when the reader of
/// standard output has closed; a closed standard output takes it as
/// printed.
#[tokio::main]
async fn main() -> ExitCode {
    let arguments: Vec<String> = std::env::args().skip(1).collect();
    let command = match arguments.as_slice() {
        [] => Command::Serve,
        [argument] if argument == "check" => Command::Check,
        _ => {
            send_log_line("usage: email [check]");
            return ExitCode::from(USAGE_EXIT_CODE);
        }
    };
    let trust = Trust::create_platform();
    match command {
        Command::Check => run_check(trust).await,
        Command::Serve => run_serve(trust).await,
    }
}

/// Signs in to both servers of the account to check and prints the report.
/// The account comes in `LYS_EMAIL_ACCOUNT`, the person's variable, even
/// when it is Lys's: a check concerns one account, never a mailbox served.
///
/// # Arguments
///
/// * `trust` - Which server certificates are accepted.
///
/// # Returns
///
/// The exit code, as [`main`] describes it for `check`.
async fn run_check(trust: Trust) -> ExitCode {
    let account = match read_account(Mailbox::Person) {
        Ok(account) => account,
        Err(problem) => {
            send_log_line(&format!("{}: {problem}", Mailbox::Person.variable_name()));
            return ExitCode::from(ACCOUNT_EXIT_CODE);
        }
    };
    let report = offer_account_sign_ins(&account, &trust).await;
    match send_report_line(&report) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            send_log_line(&format!("check: the report could not be written: {error}"));
            ExitCode::FAILURE
        }
    }
}

/// Serves MCP over standard input and output for each mailbox whose
/// variable is set, until the service stops.
///
/// # Arguments
///
/// * `trust` - Which server certificates are accepted.
///
/// # Returns
///
/// The exit code, as [`main`] describes it for serving.
async fn run_serve(trust: Trust) -> ExitCode {
    let accounts = match read_served_accounts() {
        Ok(accounts) => accounts,
        Err(problem) => {
            send_log_line(&problem.to_string());
            return ExitCode::from(ACCOUNT_EXIT_CODE);
        }
    };
    let names: Vec<&str> = accounts
        .iter()
        .map(|(mailbox, _)| mailbox.log_name())
        .collect();
    let shared = SharedCalls::new(trust);
    let contexts = accounts
        .into_iter()
        .map(|(mailbox, account)| ToolContext::new(mailbox, account, shared.clone()))
        .collect();
    let running = match EmailServer::new(contexts)
        .serve(rmcp::transport::stdio())
        .await
    {
        Ok(running) => running,
        Err(error) => {
            send_log_line(&format!("server: starting failed: {error}"));
            return ExitCode::FAILURE;
        }
    };
    send_log_line(&format!(
        "server: serving MCP over stdio for {}",
        names.join(" and ")
    ));
    match running.waiting().await {
        Ok(reason) => {
            send_log_line(&format!("server: stopped ({reason:?})"));
            ExitCode::SUCCESS
        }
        Err(error) => {
            send_log_line(&format!("server: stopped with a failure: {error}"));
            ExitCode::FAILURE
        }
    }
}

/// Writes the report on standard output as one JSON line, and flushes it.
/// A closed standard output takes the line as written, as Rust's standard
/// library treats a closed descriptor.
///
/// # Errors
///
/// When the report cannot be serialized, or the line cannot be written or
/// flushed, as when the reader of standard output has closed.
fn send_report_line(report: &CheckReport) -> io::Result<()> {
    let json = serde_json::to_string(report)?;
    let mut output = io::stdout().lock();
    writeln!(output, "{json}")?;
    output.flush()
}
