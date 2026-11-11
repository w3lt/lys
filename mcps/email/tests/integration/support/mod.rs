//! Fakes and builders shared by the integration tests: a certificate
//! authority, an IMAP server, an SMTP server, accounts pointing at them,
//! and the binary's process.

pub mod binary;
pub mod imap;
pub mod smtp;
pub mod tls;

use std::fmt::Debug;
use std::future::Future;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use email::account::{Account, parse_account_variable};
use email::tools::ToolContext;
use email::trust::Trust;
use tokio::io::{AsyncRead, AsyncReadExt, BufReader};
use tokio::time::{Instant, timeout};

use self::imap::{FakeImapServer, FakeMailbox, ImapMode, NewMessage};
use self::smtp::{FakeSmtpServer, SmtpMode};
use self::tls::TestAuthority;

/// The address of the account the fakes serve.
pub const ADDRESS: &str = "person@example.com";

/// The user name the fakes accept.
pub const USER_NAME: &str = "person@example.com";

/// The password the fakes accept; a synthetic value, not a credential.
pub const PASSWORD: &str = "synthetic-password-7f3a";

/// Month names as mail writes them.
pub const MONTH_NAMES: [&str; 12] = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/// Seconds in one day of the Unix clock, which has no leap seconds.
pub const SECONDS_PER_DAY: i64 = 86_400;

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

/// Where the two fakes of an account listen, and how each is reached.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TestServers {
    /// The IMAP fake's port.
    pub imap_port: u16,
    /// How the IMAP fake is reached.
    pub imap_security: SecurityName,
    /// The SMTP fake's port.
    pub smtp_port: u16,
    /// How the SMTP fake is reached.
    pub smtp_security: SecurityName,
}

/// How long a run past a fault took, on the two clocks it ran on.
///
/// The run starts on the real clock, which tokio's clock follows until
/// the pause. The paused clock then stands still while the runtime has
/// work and jumps to the next timer's deadline when it has none, so after
/// the pause it counts the rest of the limit of the wait the fault caused
/// and none of the real time.
#[derive(Clone, Copy, Debug)]
pub struct FaultTiming {
    /// The whole run on tokio's clock: the real time until the pause, then
    /// the paused clock's jumps.
    elapsed: Duration,
    /// The real time from the run's start until the fault struck, such as
    /// connecting, a TLS handshake, and the steps before the fault.
    real_before_fault: Duration,
    /// The real time from the run's start until the clock paused: the
    /// time before the fault, then the future taking up the input it
    /// already had.
    real_before_pause: Duration,
}

/// Runs a future until a fake's fault strikes, lets it take up the input
/// it already has, pauses the clock, and runs it to its end, so that the
/// limit of the wait the fault caused passes at once.
///
/// The clock stays paused for the rest of the case: each later timer of
/// the case fires as soon as the runtime has no other work, and a second
/// run in the same case panics.
///
/// # Arguments
///
/// * `fault` - Ends when the fault strikes.
/// * `future` - The code under test.
///
/// # Returns
///
/// The future's output and how long the run took, on the real clock until
/// the pause and on the paused clock after it.
///
/// # Panics
///
/// When the case runs on a runtime other than a current-thread one, the
/// default of `#[tokio::test]`, or the clock is already paused, as by an
/// earlier run in the same case: tokio's `pause` panics then. Also when
/// the future ends before the clock paused, or waits on the paused clock
/// longer than 600 seconds.
pub async fn run_past_fault<F>(
    fault: impl Future<Output = ()>,
    future: F,
) -> (F::Output, FaultTiming)
where
    F: Future,
    F::Output: Debug,
{
    /// How many times a future may take up input its connection already has,
    /// after a fake met its fault and before the clock pauses: enough for a
    /// connection the fake accepted to finish connecting, so that only the
    /// wait the fault caused is left.
    const SETTLING_TURNS: usize = 3;

    /// Longest a future may wait on the paused clock before the test fails it:
    /// longer than any limit of the code under test, so that a step without a
    /// limit fails the test instead of hanging it.
    const GUARD_LIMIT: Duration = Duration::from_secs(600);

    let started = Instant::now();
    tokio::pin!(future);
    tokio::select! {
        () = fault => {}
        outcome = &mut future => panic!("the future ended before the fault: {outcome:?}"),
    }
    let real_before_fault = started.elapsed();
    for _ in 0..SETTLING_TURNS {
        tokio::select! {
            () = tokio::task::yield_now() => {}
            outcome = &mut future => panic!("the future ended before the clock paused: {outcome:?}"),
        }
    }
    let real_before_pause = started.elapsed();
    tokio::time::pause();
    let outcome = timeout(GUARD_LIMIT, future)
        .await
        .expect("a limit of the code under test ends the future");
    let timing = FaultTiming {
        elapsed: started.elapsed(),
        real_before_fault,
        real_before_pause,
    };
    (outcome, timing)
}

/// Reads and drops bytes, text or not, such as a TLS handshake, until the
/// stream ends or fails.
pub async fn read_until_end<S>(reader: &mut BufReader<S>)
where
    S: AsyncRead + Unpin,
{
    let mut buffer = [0_u8; 1024];
    while reader.read(&mut buffer).await.is_ok_and(|count| count > 0) {}
}

/// Asserts that a run past a fault took the limit of the wait the fault
/// caused, counted from the fault, so that a limit wrong by a second fails
/// however long the machine took before the fault, such as for a TLS
/// handshake.
///
/// From the fault on, the run takes the limit:
///
/// - less the part of the wait that ran before the fault, at most 500
///   milliseconds;
/// - plus at most the real time from the fault to the pause, in which a
///   wait that starts after the fault, such as for a greeting, begins;
/// - plus how far the paused clock lands past the deadline, at most 2
///   milliseconds.
///
/// # Arguments
///
/// * `timing` - How long the run took, from [`run_past_fault`].
/// * `limit` - The limit the code under test sets on the wait.
pub fn assert_about(timing: FaultTiming, limit: Duration) {
    /// How long the wait a fault causes may have run before the fault struck,
    /// at most: under a second, so that a limit a second short still fails.
    /// It holds while nothing slow comes before the fault within its wait.
    /// The code starts a step's wait just before the step's first exchange,
    /// the command it writes or the greeting it reads, and an account check's
    /// wait when the check starts, before it connects, which the check's
    /// timing cases do in plain text; over loopback, either takes far less
    /// than this. A TLS handshake can take seconds, so a case must not strike
    /// after one within the same wait, such as at the second EHLO of SMTP's
    /// STARTTLS step, whose one wait also covers the STARTTLS command and the
    /// handshake.
    const LONGEST_WAIT_BEFORE_FAULT: Duration = Duration::from_millis(500);

    /// How far past a timer's deadline the paused clock may land, at most.
    /// tokio's timers fire on whole milliseconds since the runtime started:
    /// a deadline is rounded up to the next one, and the paused clock moves
    /// by whole milliseconds from where it paused, keeping the part of a
    /// millisecond it stood at then; each adds less than a millisecond.
    const LONGEST_PAUSED_CLOCK_OVERSHOOT: Duration = Duration::from_millis(2);

    let after_fault = timing.elapsed - timing.real_before_fault;
    let settling = timing.real_before_pause - timing.real_before_fault;
    assert!(
        after_fault + LONGEST_WAIT_BEFORE_FAULT >= limit
            && after_fault <= limit + settling + LONGEST_PAUSED_CLOCK_OVERSHOOT,
        "{timing:?} is not about {limit:?}"
    );
}

/// Builds the JSON of `LYS_EMAIL_ACCOUNT` for servers on localhost.
pub fn build_account_json(servers: TestServers, server_keeps_sent_copy: bool) -> String {
    build_account_json_for("localhost", servers, server_keeps_sent_copy)
}

/// Builds the JSON of `LYS_EMAIL_ACCOUNT` for servers on the host.
pub fn build_account_json_for(
    host: &str,
    servers: TestServers,
    server_keeps_sent_copy: bool,
) -> String {
    /// The display name of the account.
    const DISPLAY_NAME: &str = "A Person";

    format!(
        r#"{{"address":"{ADDRESS}","displayName":"{DISPLAY_NAME}","userName":"{USER_NAME}","password":"{PASSWORD}","imap":{{"host":"{host}","port":{},"security":"{}"}},"smtp":{{"host":"{host}","port":{},"security":"{}"}},"serverKeepsSentCopy":{server_keeps_sent_copy}}}"#,
        servers.imap_port,
        servers.imap_security.value(),
        servers.smtp_port,
        servers.smtp_security.value()
    )
}

/// Parses an account for servers on localhost.
pub fn build_account(servers: TestServers, server_keeps_sent_copy: bool) -> Account {
    parse_account_variable(&build_account_json(servers, server_keeps_sent_copy))
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
        TestServers {
            imap_port: imap.port,
            imap_security: SecurityName::Tls,
            smtp_port: smtp.port,
            smtp_security: SecurityName::Tls,
        },
        server_keeps_sent_copy,
    );
    let context = ToolContext::new(
        account,
        Trust::create_with_extra_roots(vec![authority.root.clone()]),
    );
    Stack {
        authority,
        imap,
        smtp,
        context,
    }
}

/// Asserts that no command, so no message, reached the SMTP server.
///
/// # Arguments
///
/// * `smtp` - The SMTP fake that recorded the commands.
pub fn assert_nothing_sent(smtp: &FakeSmtpServer) {
    let commands = smtp.list_commands();
    assert!(commands.is_empty(), "{commands:?}");
    assert!(smtp.list_mails().is_empty());
}

/// The fields of a test message; by default, an empty plain message from
/// Jane to the account.
#[derive(Clone, Debug)]
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

impl Default for TestMessage {
    /// Builds an empty plain message from Jane to the account, dated at the
    /// Unix epoch.
    fn default() -> Self {
        Self {
            from: "Jane Doe <jane@example.com>".to_owned(),
            to: ADDRESS.to_owned(),
            cc: String::new(),
            subject: String::new(),
            message_id: String::new(),
            in_reply_to: String::new(),
            references: String::new(),
            timestamp: 0,
            body: String::new(),
        }
    }
}

impl TestMessage {
    /// Builds the message to store in a folder with the flags, arrived
    /// when it was sent.
    pub fn build_new_message<'a>(&self, flags: &'a [&'a str]) -> NewMessage<'a> {
        NewMessage {
            bytes: self.build_bytes(),
            flags,
            timestamp: self.timestamp,
        }
    }

    /// Builds the message's bytes (RFC 5322).
    pub fn build_bytes(&self) -> Vec<u8> {
        let mut text = format!("From: {}\r\nTo: {}\r\n", self.from, self.to);
        if !self.cc.is_empty() {
            text.push_str(&format!("Cc: {}\r\n", self.cc));
        }
        text.push_str(&format!(
            "Date: {}\r\nSubject: {}\r\nMessage-ID: <{}>\r\n",
            build_rfc2822_date(self.timestamp),
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
pub fn calculate_trimmed_bytes(bytes: &[u8]) -> &[u8] {
    let mut end = bytes.len();
    while end > 0 && (bytes[end - 1] == b'\n' || bytes[end - 1] == b'\r') {
        end -= 1;
    }
    &bytes[..end]
}

/// Seconds since the Unix epoch, now.
pub fn get_current_timestamp() -> i64 {
    i64::try_from(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs(),
    )
    .unwrap_or_default()
}

/// Converts days since the Unix epoch to a calendar day.
pub fn calculate_civil_day(days: i64) -> (i64, u8, u8) {
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
pub fn calculate_epoch_days(year: i64, month: u8, day: u8) -> i64 {
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

/// Builds the text a `Date` field writes for a timestamp, in UTC.
pub fn build_rfc2822_date(timestamp: i64) -> String {
    /// Weekday names as mail writes them, from Sunday.
    const WEEKDAY_NAMES: [&str; 7] = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

    let days = timestamp.div_euclid(SECONDS_PER_DAY);
    let seconds = timestamp.rem_euclid(SECONDS_PER_DAY);
    let (year, month, day) = calculate_civil_day(days);
    let weekday = WEEKDAY_NAMES[usize::try_from((days + 4).rem_euclid(7)).expect("a weekday")];
    format!(
        "{weekday}, {day} {} {year} {:02}:{:02}:{:02} +0000",
        MONTH_NAMES[usize::from(month) - 1],
        seconds / 3_600,
        seconds % 3_600 / 60,
        seconds % 60
    )
}

/// Builds the text IMAP's INTERNALDATE writes for a timestamp, in UTC.
pub fn build_internal_date(timestamp: i64) -> String {
    let days = timestamp.div_euclid(SECONDS_PER_DAY);
    let seconds = timestamp.rem_euclid(SECONDS_PER_DAY);
    let (year, month, day) = calculate_civil_day(days);
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
    Some(calculate_epoch_days(
        year,
        u8::try_from(month + 1).ok()?,
        day,
    ))
}
