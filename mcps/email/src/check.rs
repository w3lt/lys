//! The `check` subcommand: signs in to both servers and reports each
//! outcome, for the desktop's account card.

use std::time::Duration;

use serde::Serialize;
use tokio::time::timeout;

use crate::account::Account;
use crate::failure::SignInFailure;
use crate::imap::open_imap_session;
use crate::smtp::{build_smtp_transport, offer_transport_sign_in};
use crate::trust::Trust;

/// Longest one sign-in of the check may take as a whole.
pub const CHECK_LIMIT: Duration = Duration::from_secs(20);

/// The outcome of one sign-in, as the report prints it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "status", rename_all = "kebab-case")]
pub enum CheckOutcome {
    /// The server accepted the credentials.
    Accepted,
    /// Signing in failed for the reason.
    Failed {
        /// Why.
        reason: SignInFailure,
    },
}

impl From<Result<(), SignInFailure>> for CheckOutcome {
    fn from(result: Result<(), SignInFailure>) -> Self {
        match result {
            Ok(()) => Self::Accepted,
            Err(reason) => Self::Failed { reason },
        }
    }
}

/// The report of both sign-ins.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct CheckReport {
    /// The IMAP sign-in.
    pub imap: CheckOutcome,
    /// The SMTP sign-in.
    pub smtp: CheckOutcome,
}

/// Signs in to the IMAP and the SMTP server, at the same time, and
/// reports each outcome.
///
/// # Arguments
///
/// * `account` - The account to check.
/// * `trust` - Which server certificates are accepted.
pub async fn offer_account_sign_ins(account: &Account, trust: &Trust) -> CheckReport {
    let (imap, smtp) = tokio::join!(
        offer_imap_sign_in(account, trust),
        offer_smtp_sign_in(account, trust)
    );
    CheckReport {
        imap: imap.into(),
        smtp: smtp.into(),
    }
}

/// Signs in to the IMAP server and logs out.
async fn offer_imap_sign_in(account: &Account, trust: &Trust) -> Result<(), SignInFailure> {
    let session = timeout(CHECK_LIMIT, open_imap_session(account, trust))
        .await
        .map_err(|_| SignInFailure::TimedOut)??;
    session.close().await;
    Ok(())
}

/// Signs in to the SMTP server and disconnects.
async fn offer_smtp_sign_in(account: &Account, trust: &Trust) -> Result<(), SignInFailure> {
    let transport = build_smtp_transport(account, trust)?;
    offer_transport_sign_in(&transport, CHECK_LIMIT).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prints_the_report_as_the_backend_reads_it() {
        let report = CheckReport {
            imap: CheckOutcome::Accepted,
            smtp: CheckOutcome::Failed {
                reason: SignInFailure::WrongPassword,
            },
        };

        assert_eq!(
            serde_json::to_string(&report).expect("json"),
            r#"{"imap":{"status":"accepted"},"smtp":{"status":"failed","reason":"wrong-password"}}"#
        );
        assert_eq!(CheckOutcome::from(Ok(())), CheckOutcome::Accepted);
    }
}
