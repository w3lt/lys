//! The entry point: serves MCP over standard input and output, or runs
//! the account check, for the account in `LYS_EMAIL_ACCOUNT`.

use std::io::{self, Write};
use std::process::ExitCode;

use email::account::{ACCOUNT_VARIABLE_NAME, parse_account_variable, read_account_variable};
use email::check::{CheckReport, offer_account_sign_ins};
use email::log::send_log_line;
use email::server::EmailServer;
use email::tools::ToolContext;
use email::trust::Trust;
use rmcp::ServiceExt;

/// Exit code when the account variable is missing or breaks a rule.
const ACCOUNT_EXIT_CODE: u8 = 2;

/// Exit code when the arguments are not understood (EX_USAGE).
const USAGE_EXIT_CODE: u8 = 64;

/// What the process was started to do.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Command {
    /// Serve MCP over standard input and output.
    Serve,
    /// Check the account and print the report.
    Check,
}

/// Runs the binary for the account in `LYS_EMAIL_ACCOUNT`: with no
/// argument, it serves MCP over standard input and output until the
/// service stops; with `check`, it signs in to both servers and prints
/// the report on standard output as one JSON line.
///
/// It logs to standard error: `usage: email [check]` for any other
/// arguments; the variable's name and its problem, never its value, when
/// the account is missing or breaks a rule; `check: the report could not
/// be written:` and the reason; `server: starting failed:` and the reason;
/// `server: serving MCP over stdio` once it serves; and, once it stops,
/// `server: stopped` with the reason, or `server: stopped with a failure:`
/// and the failure.
///
/// # Returns
///
/// The exit code: [`USAGE_EXIT_CODE`] for other arguments,
/// [`ACCOUNT_EXIT_CODE`] when the account is missing or breaks a rule, 1
/// when the report could not be written, the server could not start, or
/// its service failed, and 0 once the report is printed or the server
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
    let account = match read_account_variable().and_then(|text| parse_account_variable(&text)) {
        Ok(account) => account,
        Err(problem) => {
            send_log_line(&format!("{ACCOUNT_VARIABLE_NAME}: {problem}"));
            return ExitCode::from(ACCOUNT_EXIT_CODE);
        }
    };
    let trust = Trust::create_platform();
    match command {
        Command::Check => {
            let report = offer_account_sign_ins(&account, &trust).await;
            match send_report_line(&report) {
                Ok(()) => ExitCode::SUCCESS,
                Err(error) => {
                    send_log_line(&format!("check: the report could not be written: {error}"));
                    ExitCode::FAILURE
                }
            }
        }
        Command::Serve => {
            let server = EmailServer::new(ToolContext::new(account, trust));
            let running = match server.serve(rmcp::transport::stdio()).await {
                Ok(running) => running,
                Err(error) => {
                    send_log_line(&format!("server: starting failed: {error}"));
                    return ExitCode::FAILURE;
                }
            };
            send_log_line("server: serving MCP over stdio");
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
