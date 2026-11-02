//! Fakes and builders shared by the integration tests: a certificate
//! authority, an IMAP server, an SMTP server, and accounts pointing at
//! them.

#![allow(dead_code)]

pub mod imap;
pub mod smtp;
pub mod tls;

use std::time::{SystemTime, UNIX_EPOCH};

use email::account::{Account, parse_account_variable};
use email::tools::ToolContext;
use email::trust::Trust;

use self::imap::{FakeImapServer, FakeMailbox, ImapMode};
use self::smtp::{FakeSmtpServer, SmtpMode};
use self::tls::TestAuthority;

/// The address of the account the fakes serve.
pub const ADDRESS: &str = "person@example.com";

/// The user name the fakes accept.
pub const USER_NAME: &str = "person@example.com";

/// The password the fakes accept; a synthetic value, not a credential.
pub const PASSWORD: &str = "synthetic-password-7f3a";

/// The display name of the account.
pub const DISPLAY_NAME: &str = "A Person";

/// Month names as mail writes them.
pub const MONTH_NAMES: [&str; 12] = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/// Weekday names as mail writes them, from Sunday.
pub const WEEKDAY_NAMES: [&str; 7] = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/// How a server of an account is reached, as the settings name it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SecurityName {
    Tls,
    StartTls,
    Plain,
}

impl SecurityName {
    /// The value the settings file stores.
    pub fn value(self) -> &'static str {
        match self {
            Self::Tls => "tls",
            Self::StartTls => "starttls",
            Self::Plain => "plain",
        }
    }
}

/// Builds the JSON of `LYS_EMAIL_ACCOUNT` for servers on localhost.
pub fn build_account_json(
    imap_port: u16,
    imap_security: SecurityName,
    smtp_port: u16,
    smtp_security: SecurityName,
    server_keeps_sent_copy: bool,
) -> String {
    build_account_json_for(
        "localhost",
        imap_port,
        imap_security,
        smtp_port,
        smtp_security,
        server_keeps_sent_copy,
    )
}

/// Builds the JSON of `LYS_EMAIL_ACCOUNT` for servers on the host.
pub fn build_account_json_for(
    host: &str,
    imap_port: u16,
    imap_security: SecurityName,
    smtp_port: u16,
    smtp_security: SecurityName,
    server_keeps_sent_copy: bool,
) -> String {
    format!(
        r#"{{"address":"{ADDRESS}","displayName":"{DISPLAY_NAME}","userName":"{USER_NAME}","password":"{PASSWORD}","imap":{{"host":"{host}","port":{imap_port},"security":"{}"}},"smtp":{{"host":"{host}","port":{smtp_port},"security":"{}"}},"serverKeepsSentCopy":{server_keeps_sent_copy}}}"#,
        imap_security.value(),
        smtp_security.value()
    )
}

/// Parses an account for servers on localhost.
pub fn build_account(
    imap_port: u16,
    imap_security: SecurityName,
    smtp_port: u16,
    smtp_security: SecurityName,
    server_keeps_sent_copy: bool,
) -> Account {
    parse_account_variable(&build_account_json(
        imap_port,
        imap_security,
        smtp_port,
        smtp_security,
        server_keeps_sent_copy,
    ))
    .expect("the test account follows the rules")
}

/// The fakes a tool test runs against, over TLS.
pub struct Stack {
    /// The certificate authority both fakes' certificates come from.
    pub authority: TestAuthority,
    /// The IMAP fake.
    pub imap: FakeImapServer,
    /// The SMTP fake.
    pub smtp: FakeSmtpServer,
    /// The account and trust the tools run with.
    pub context: ToolContext,
}

/// Starts both fakes over TLS and builds the tools' context.
///
/// # Arguments
///
/// * `mailbox` - The IMAP fake's folders and messages.
/// * `server_keeps_sent_copy` - The account's Sent copy rule.
pub async fn start_stack(mailbox: FakeMailbox, server_keeps_sent_copy: bool) -> Stack {
    let authority = TestAuthority::new();
    let imap =
        FakeImapServer::start(mailbox, ImapMode::Tls, Some(authority.build_acceptor())).await;
    let smtp = FakeSmtpServer::start(SmtpMode::Tls, Some(authority.build_acceptor())).await;
    let account = build_account(
        imap.port,
        SecurityName::Tls,
        smtp.port,
        SecurityName::Tls,
        server_keeps_sent_copy,
    );
    let context = ToolContext::new(
        account,
        Trust::with_extra_roots(vec![authority.root.clone()]),
    );
    Stack {
        authority,
        imap,
        smtp,
        context,
    }
}

/// The fields of a test message.
#[derive(Clone, Debug, Default)]
pub struct TestMessage {
    pub from: String,
    pub to: String,
    pub cc: String,
    pub subject: String,
    pub message_id: String,
    pub in_reply_to: String,
    pub references: String,
    pub timestamp: i64,
    pub body: String,
}

impl TestMessage {
    /// A plain message from Jane with the subject and body, sent at the
    /// time, with the identifier.
    pub fn new(subject: &str, body: &str, message_id: &str, timestamp: i64) -> Self {
        Self {
            from: "Jane Doe <jane@example.com>".to_owned(),
            to: ADDRESS.to_owned(),
            subject: subject.to_owned(),
            message_id: message_id.to_owned(),
            timestamp,
            body: body.to_owned(),
            ..Self::default()
        }
    }

    /// Writes the message (RFC 5322).
    pub fn build(&self) -> Vec<u8> {
        let mut text = format!("From: {}\r\nTo: {}\r\n", self.from, self.to);
        if !self.cc.is_empty() {
            text.push_str(&format!("Cc: {}\r\n", self.cc));
        }
        text.push_str(&format!(
            "Date: {}\r\nSubject: {}\r\nMessage-ID: <{}>\r\n",
            format_rfc2822(self.timestamp),
            self.subject,
            self.message_id
        ));
        if !self.in_reply_to.is_empty() {
            text.push_str(&format!("In-Reply-To: <{}>\r\n", self.in_reply_to));
        }
        if !self.references.is_empty() {
            text.push_str(&format!("References: {}\r\n", self.references));
        }
        text.push_str("MIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n");
        text.push_str(&self.body);
        text.push_str("\r\n");
        text.into_bytes()
    }
}

/// The bytes without their trailing line breaks, to compare a message as
/// SMTP received it with one as IMAP stored it.
pub fn without_trailing_line_breaks(bytes: &[u8]) -> &[u8] {
    let mut end = bytes.len();
    while end > 0 && (bytes[end - 1] == b'\n' || bytes[end - 1] == b'\r') {
        end -= 1;
    }
    &bytes[..end]
}

/// Seconds since the Unix epoch, now.
pub fn now_timestamp() -> i64 {
    i64::try_from(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs(),
    )
    .unwrap_or_default()
}

/// Converts days since the Unix epoch to a calendar day.
pub fn civil_from_days(days: i64) -> (i64, u8, u8) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let day_of_era = z - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let shifted_month = (5 * day_of_year + 2) / 153;
    let day = u8::try_from(day_of_year - (153 * shifted_month + 2) / 5 + 1).expect("a day");
    let month = u8::try_from(if shifted_month < 10 {
        shifted_month + 3
    } else {
        shifted_month - 9
    })
    .expect("a month");
    (if month <= 2 { year + 1 } else { year }, month, day)
}

/// Converts a calendar day to days since the Unix epoch.
pub fn days_from_civil(year: i64, month: u8, day: u8) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let year_of_era = year - era * 400;
    let shifted_month = if month > 2 {
        i64::from(month) - 3
    } else {
        i64::from(month) + 9
    };
    let day_of_year = (153 * shifted_month + 2) / 5 + i64::from(day) - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

/// Formats a timestamp as a `Date` field writes it, in UTC.
pub fn format_rfc2822(timestamp: i64) -> String {
    let days = timestamp.div_euclid(86_400);
    let seconds = timestamp.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    let weekday = WEEKDAY_NAMES[usize::try_from((days + 4).rem_euclid(7)).expect("a weekday")];
    format!(
        "{weekday}, {day} {} {year} {:02}:{:02}:{:02} +0000",
        MONTH_NAMES[usize::from(month) - 1],
        seconds / 3_600,
        seconds % 3_600 / 60,
        seconds % 60
    )
}

/// Formats a timestamp as IMAP's INTERNALDATE writes it, in UTC.
pub fn format_internal_date(timestamp: i64) -> String {
    let days = timestamp.div_euclid(86_400);
    let seconds = timestamp.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    format!(
        "{day:02}-{}-{year} {:02}:{:02}:{:02} +0000",
        MONTH_NAMES[usize::from(month) - 1],
        seconds / 3_600,
        seconds % 3_600 / 60,
        seconds % 60
    )
}

/// Parses an IMAP search date, `D-Mon-YYYY`, to days since the epoch.
pub fn parse_search_date(text: &str) -> Option<i64> {
    let mut parts = text.split('-');
    let day: u8 = parts.next()?.parse().ok()?;
    let month_name = parts.next()?;
    let month = MONTH_NAMES
        .iter()
        .position(|name| name.eq_ignore_ascii_case(month_name))?;
    let year: i64 = parts.next()?.parse().ok()?;
    Some(days_from_civil(year, u8::try_from(month + 1).ok()?, day))
}
