//! The entry point: serves MCP over standard input and output, or runs
//! the account check, for the account in `LYS_EMAIL_ACCOUNT`.

use std::process::ExitCode;

use email::account::{ACCOUNT_VARIABLE_NAME, parse_account_variable, read_account_variable};
use email::check::run_account_check;
use email::log::log_line;
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

#[tokio::main]
async fn main() -> ExitCode {
    let arguments: Vec<String> = std::env::args().skip(1).collect();
    let command = match arguments.as_slice() {
        [] => Command::Serve,
        [argument] if argument == "check" => Command::Check,
        _ => {
            log_line("usage: email [check]");
            return ExitCode::from(USAGE_EXIT_CODE);
        }
    };
    let account = match read_account_variable().and_then(|text| parse_account_variable(&text)) {
        Ok(account) => account,
        Err(problem) => {
            log_line(&format!("{ACCOUNT_VARIABLE_NAME}: {problem}"));
            return ExitCode::from(ACCOUNT_EXIT_CODE);
        }
    };
    let trust = Trust::of_platform();
    match command {
        Command::Check => {
            let report = run_account_check(&account, &trust).await;
            match serde_json::to_string(&report) {
                Ok(json) => {
                    println!("{json}");
                    ExitCode::SUCCESS
                }
                Err(error) => {
                    log_line(&format!("check: the report could not be written: {error}"));
                    ExitCode::FAILURE
                }
            }
        }
        Command::Serve => {
            let server = EmailServer::new(ToolContext::new(account, trust));
            let running = match server.serve(rmcp::transport::stdio()).await {
                Ok(running) => running,
                Err(error) => {
                    log_line(&format!("server: starting failed: {error}"));
                    return ExitCode::FAILURE;
                }
            };
            log_line("server: serving MCP over stdio");
            match running.waiting().await {
                Ok(reason) => {
                    log_line(&format!("server: stopped ({reason:?})"));
                    ExitCode::SUCCESS
                }
                Err(error) => {
                    log_line(&format!("server: stopped with a failure: {error}"));
                    ExitCode::FAILURE
                }
            }
        }
    }
}
