//! The account the server signs in with, read from `LYS_EMAIL_ACCOUNT`.
//!
//! The backend starts the server with one environment variable holding the
//! saved account and its password as one line of JSON, the only channel a
//! stdio MCP launch offers. The rules here repeat those of
//! `emailAccountSchema` in `@lys/share`: the backend checked them before
//! starting the server, and the server checks them again, because anyone
//! on the machine can start the binary with a variable of their own, and
//! the rule that a plain connection reaches only the machine itself is a
//! security rule.
//!
//! A failed rule is reported by name only, never with the value that broke
//! it: the report goes to standard error, which the backend keeps as a log.

use std::env;
use std::fmt;

use serde::Deserialize;

/// Environment variable holding the account and its password as JSON.
pub const ACCOUNT_VARIABLE_NAME: &str = "LYS_EMAIL_ACCOUNT";

/// Most bytes an email address may have, inclusive: the longest path SMTP
/// carries.
const MAXIMUM_ADDRESS_LENGTH: usize = 254;

/// Most bytes the part of an address before `@` may have, inclusive.
const MAXIMUM_LOCAL_PART_LENGTH: usize = 64;

/// Most characters, counted as Unicode code points, a display name may
/// have, inclusive.
const MAXIMUM_DISPLAY_NAME_LENGTH: usize = 100;

/// Most characters, counted as Unicode code points, a user name may have,
/// inclusive.
const MAXIMUM_USER_NAME_LENGTH: usize = 254;

/// Most characters, counted as Unicode code points, a password may have,
/// inclusive.
const MAXIMUM_PASSWORD_LENGTH: usize = 1024;

/// Most bytes a host name may have, inclusive.
const MAXIMUM_HOST_NAME_LENGTH: usize = 253;

/// Most bytes one label of a host name may have, inclusive.
const MAXIMUM_HOST_LABEL_LENGTH: usize = 63;

/// Most bytes an IPv6 address in brackets may have, inclusive.
const MAXIMUM_BRACKETED_IPV6_LENGTH: usize = 47;

/// Hosts a mail server may be reached on without TLS, in lowercase: the
/// machine Lys runs on.
const LOOPBACK_HOSTS: [&str; 3] = ["localhost", "127.0.0.1", "[::1]"];

/// How a connection to a mail server is protected.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Security {
    /// TLS from the first byte (IMAPS on 993, SMTPS on 465).
    Tls,
    /// A plain connection upgraded with STARTTLS before any credential.
    StartTls,
    /// No TLS; allowed only to the machine itself.
    Plain,
}

impl Security {
    /// Parses the value the settings file stores.
    ///
    /// # Arguments
    ///
    /// * `value` - `tls`, `starttls`, or `plain`.
    ///
    /// # Returns
    ///
    /// The security, or `None` for any other text.
    fn parse(value: &str) -> Option<Self> {
        match value {
            "tls" => Some(Self::Tls),
            "starttls" => Some(Self::StartTls),
            "plain" => Some(Self::Plain),
            _ => None,
        }
    }
}

/// One mail server of the account: the IMAP or the SMTP one.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MailServer {
    /// Host name, or an IPv6 address in brackets.
    pub host: String,
    /// TCP port, 1 to 65535.
    pub port: u16,
    /// How the connection is protected.
    pub security: Security,
}

impl MailServer {
    /// Returns the host as TLS and TCP name it: an IPv6 address without
    /// its brackets, any other host unchanged.
    pub fn server_name(&self) -> &str {
        self.host
            .strip_prefix('[')
            .and_then(|rest| rest.strip_suffix(']'))
            .unwrap_or(&self.host)
    }
}

/// The password of the account; a secret that `Debug` never shows.
#[derive(Clone)]
pub struct Password(String);

impl Password {
    /// Returns the password's text, for the sign-in that needs it.
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for Password {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("<redacted>")
    }
}

/// The account the server signs in with, as the backend wrote it.
#[derive(Clone)]
pub struct Account {
    /// Address mail is sent from and received at.
    pub address: String,
    /// Name sent with the address; may be empty.
    pub display_name: String,
    /// User name the account signs in with on both servers.
    pub user_name: String,
    /// Password of both servers.
    pub password: Password,
    /// Server mail is read from.
    pub imap: MailServer,
    /// Server mail is sent through.
    pub smtp: MailServer,
    /// Whether the SMTP server stores sent mail itself, so no copy is
    /// appended to the Sent folder.
    pub server_keeps_sent_copy: bool,
}

impl fmt::Debug for Account {
    /// Shows the servers and the sent-copy switch; the address, the names,
    /// and the password are personal data and stay hidden.
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("Account")
            .field("address", &"<redacted>")
            .field("display_name", &"<redacted>")
            .field("user_name", &"<redacted>")
            .field("password", &self.password)
            .field("imap", &self.imap)
            .field("smtp", &self.smtp)
            .field("server_keeps_sent_copy", &self.server_keeps_sent_copy)
            .finish()
    }
}

/// Why the account variable gave no account; named without any value.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AccountProblem {
    /// The variable is not set.
    Missing,
    /// The variable's value is not Unicode text.
    NotUnicode,
    /// The value is not JSON.
    NotJson,
    /// The JSON is not the account the backend writes: a field is missing,
    /// unknown, or of the wrong type.
    NotAnAccount,
    /// A field breaks the named rule.
    Rule(&'static str),
}

impl fmt::Display for AccountProblem {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Missing => formatter.write_str("is not set"),
            Self::NotUnicode => formatter.write_str("is not Unicode text"),
            Self::NotJson => formatter.write_str("is not JSON"),
            Self::NotAnAccount => formatter.write_str(
                "is not the account the backend writes: a field is missing, unknown, or of the wrong type",
            ),
            Self::Rule(rule) => write!(formatter, "breaks a rule: {rule}"),
        }
    }
}

impl std::error::Error for AccountProblem {}

/// The account as the JSON names its fields, before the rules.
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct StoredAccount {
    address: String,
    display_name: String,
    user_name: String,
    password: String,
    imap: StoredServer,
    smtp: StoredServer,
    server_keeps_sent_copy: bool,
}

/// One server as the JSON names its fields, before the rules.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct StoredServer {
    host: String,
    /// The port as any JSON number, as the shared rules read it: `993.0`
    /// and `9.93e2` are the port 993, and serde_json's `float_roundtrip`
    /// feature rounds a number with many digits as `JSON.parse` does.
    port: f64,
    security: String,
}

/// Reads the raw text of the account variable.
///
/// # Returns
///
/// The variable's value, or why there is none.
pub fn read_account_variable() -> Result<String, AccountProblem> {
    match env::var_os(ACCOUNT_VARIABLE_NAME) {
        None => Err(AccountProblem::Missing),
        Some(value) => value.into_string().map_err(|_| AccountProblem::NotUnicode),
    }
}

/// Parses the account variable's text into an account that passes every
/// rule.
///
/// # Arguments
///
/// * `text` - The JSON the backend writes: `address`, `displayName`,
///   `userName`, `password`, `imap` and `smtp` (`host`, `port`,
///   `security`), and `serverKeepsSentCopy`.
///
/// # Returns
///
/// The account, or the first problem found, named without its value.
pub fn parse_account_variable(text: &str) -> Result<Account, AccountProblem> {
    let stored: StoredAccount = match serde_json::from_str(text) {
        Ok(stored) => stored,
        Err(error) if error.is_syntax() || error.is_eof() => return Err(AccountProblem::NotJson),
        Err(_) => return Err(AccountProblem::NotAnAccount),
    };
    if !is_address(&stored.address) {
        return Err(AccountProblem::Rule(
            "address is a local part of 1 to 64 visible ASCII characters, @, and a host name, 254 characters at most",
        ));
    }
    if !is_display_name(&stored.display_name) {
        return Err(AccountProblem::Rule(
            "displayName has at most 100 characters, no control character, and no white space at its ends",
        ));
    }
    if !is_user_name(&stored.user_name) {
        return Err(AccountProblem::Rule(
            "userName has 1 to 254 characters, no control character, and no white space at its ends",
        ));
    }
    if !is_password(&stored.password) {
        return Err(AccountProblem::Rule(
            "password has 1 to 1024 characters and no control character",
        ));
    }
    let imap = parse_server(stored.imap, "imap")?;
    let smtp = parse_server(stored.smtp, "smtp")?;
    Ok(Account {
        address: stored.address,
        display_name: stored.display_name,
        user_name: stored.user_name,
        password: Password(stored.password),
        imap,
        smtp,
        server_keeps_sent_copy: stored.server_keeps_sent_copy,
    })
}

/// Applies the rules of one server.
///
/// # Arguments
///
/// * `stored` - The server as stored.
/// * `name` - `imap` or `smtp`, named in a failed rule.
fn parse_server(stored: StoredServer, name: &'static str) -> Result<MailServer, AccountProblem> {
    if !is_host_name(&stored.host) && !is_bracketed_ipv6(&stored.host) {
        return Err(AccountProblem::Rule(match name {
            "imap" => "imap.host is a host name or an IPv6 address in brackets",
            _ => "smtp.host is a host name or an IPv6 address in brackets",
        }));
    }
    let Some(port) = parse_port(stored.port) else {
        return Err(AccountProblem::Rule(match name {
            "imap" => "imap.port is a whole number from 1 to 65535",
            _ => "smtp.port is a whole number from 1 to 65535",
        }));
    };
    let Some(security) = Security::parse(&stored.security) else {
        return Err(AccountProblem::Rule(match name {
            "imap" => "imap.security is tls, starttls, or plain",
            _ => "smtp.security is tls, starttls, or plain",
        }));
    };
    if security == Security::Plain && !is_loopback_host(&stored.host) {
        return Err(AccountProblem::Rule(match name {
            "imap" => "imap.security may be plain only for localhost, 127.0.0.1, or [::1]",
            _ => "smtp.security may be plain only for localhost, 127.0.0.1, or [::1]",
        }));
    }
    Ok(MailServer {
        host: stored.host,
        port,
        security,
    })
}

/// Parses a port: a whole number from 1 to 65535, however the JSON writes
/// it.
///
/// # Returns
///
/// The port, or `None` for a fraction or a number outside that range.
fn parse_port(number: f64) -> Option<u16> {
    if number.fract() != 0.0 || !(1.0..=f64::from(u16::MAX)).contains(&number) {
        return None;
    }
    // The check above leaves a whole number that `u16` holds, so the cast
    // keeps its value.
    Some(number as u16)
}

/// Whether the text is an email address by the shared rule.
fn is_address(value: &str) -> bool {
    if value.len() > MAXIMUM_ADDRESS_LENGTH {
        return false;
    }
    let Some((local_part, host)) = value.rsplit_once('@') else {
        return false;
    };
    !local_part.is_empty()
        && local_part.len() <= MAXIMUM_LOCAL_PART_LENGTH
        && local_part
            .bytes()
            .all(|byte| (b'!'..=b'~').contains(&byte) && byte != b'@')
        && is_host_name(host)
}

/// Whether the text is a display name: at most
/// [`MAXIMUM_DISPLAY_NAME_LENGTH`] characters, no control character, and no
/// white space at its ends. It may be empty.
fn is_display_name(value: &str) -> bool {
    is_account_text(value, MAXIMUM_DISPLAY_NAME_LENGTH) && !has_edge_white_space(value)
}

/// Whether the text is a user name: 1 to [`MAXIMUM_USER_NAME_LENGTH`]
/// characters, no control character, and no white space at its ends.
fn is_user_name(value: &str) -> bool {
    !value.is_empty()
        && is_account_text(value, MAXIMUM_USER_NAME_LENGTH)
        && !has_edge_white_space(value)
}

/// Whether the text is a password: 1 to [`MAXIMUM_PASSWORD_LENGTH`]
/// characters and no control character.
fn is_password(value: &str) -> bool {
    !value.is_empty() && is_account_text(value, MAXIMUM_PASSWORD_LENGTH)
}

/// Whether the text has at most `maximum_length` code points and no
/// control character.
fn is_account_text(value: &str, maximum_length: usize) -> bool {
    value.chars().count() <= maximum_length && !value.chars().any(char::is_control)
}

/// Whether the text starts or ends with white space.
fn has_edge_white_space(value: &str) -> bool {
    value.starts_with(char::is_whitespace) || value.ends_with(char::is_whitespace)
}

/// Whether the text is a host name: labels of letters, digits, and inner
/// hyphens, 63 bytes each, joined by dots, 253 bytes at most.
fn is_host_name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAXIMUM_HOST_NAME_LENGTH
        && value.split('.').all(is_host_label)
}

/// Whether the text is one label of a host name.
fn is_host_label(label: &str) -> bool {
    !label.is_empty()
        && label.len() <= MAXIMUM_HOST_LABEL_LENGTH
        && label
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        && !label.starts_with('-')
        && !label.ends_with('-')
}

/// Whether the text is an IPv6 address in brackets: hexadecimal digits,
/// colons, and the dots of an embedded IPv4 address, with at least one
/// colon.
fn is_bracketed_ipv6(value: &str) -> bool {
    let Some(inner) = value
        .strip_prefix('[')
        .and_then(|rest| rest.strip_suffix(']'))
    else {
        return false;
    };
    value.len() <= MAXIMUM_BRACKETED_IPV6_LENGTH
        && inner.contains(':')
        && inner
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() || byte == b':' || byte == b'.')
}

/// Whether the host names the machine itself, in any letter case.
fn is_loopback_host(host: &str) -> bool {
    let lowercase = host.to_ascii_lowercase();
    LOOPBACK_HOSTS.contains(&lowercase.as_str())
}

#[cfg(test)]
mod tests {
    use serde_json::{Value, json};

    use super::*;

    /// Password of the test account; not a real credential.
    const SYNTHETIC_PASSWORD: &str = "correct horse battery staple";

    /// Accounts with the value of `LYS_EMAIL_ACCOUNT` the backend writes for
    /// each; the backend's tests check that it writes these values.
    const SHARED_VARIABLES: &str =
        include_str!("../../../packages/share/test/fixtures/email-account-variables.json");

    /// Groups of the settings file that `emailSettingsSchema` in
    /// `@lys/share`, the host, and the backend judge alike.
    const SHARED_GROUPS: &str =
        include_str!("../../../packages/share/test/fixtures/email-settings-groups.json");

    /// One shared account variable; the account and the password the
    /// backend writes it from are the backend's to check.
    #[derive(Deserialize)]
    struct SharedVariable {
        /// What the case checks.
        case: String,
        /// The JSON the variable holds.
        variable: Value,
    }

    /// One case of the shared groups; what the host writes back for an
    /// accepted group is the host's to check.
    #[derive(Deserialize)]
    struct SharedGroup {
        /// What the case checks.
        case: String,
        /// The value of the settings file's `email` group.
        group: Value,
        /// Whether the shared rules accept the group.
        accepted: bool,
    }

    /// Writes a server back with the variable's field names.
    fn format_server_value(server: &MailServer) -> Value {
        let security = match server.security {
            Security::Tls => "tls",
            Security::StartTls => "starttls",
            Security::Plain => "plain",
        };
        json!({"host": server.host, "port": server.port, "security": security})
    }

    /// Writes an account back with the variable's field names, to compare
    /// with the variable it was parsed from.
    fn format_account_value(account: &Account) -> Value {
        let imap = format_server_value(&account.imap);
        let smtp = format_server_value(&account.smtp);
        json!({
            "address": account.address,
            "displayName": account.display_name,
            "userName": account.user_name,
            "password": account.password.as_str(),
            "imap": imap,
            "smtp": smtp,
            "serverKeepsSentCopy": account.server_keeps_sent_copy,
        })
    }

    /// Builds the variable the backend writes for the account of a shared
    /// group: an account object gains the test password, and any other
    /// value stays as it is.
    ///
    /// # Returns
    ///
    /// The variable's text, or `None` for a group that holds no account or
    /// more than one field, whose case is about the group rather than the
    /// account.
    fn build_group_variable(group: &Value) -> Option<String> {
        let fields = group.as_object().filter(|fields| fields.len() == 1)?;
        match fields.get("account")? {
            Value::Null => None,
            Value::Object(account) => {
                let mut account = account.clone();
                account.insert("password".to_owned(), Value::from(SYNTHETIC_PASSWORD));
                Some(Value::Object(account).to_string())
            }
            other @ (Value::Bool(_) | Value::Number(_) | Value::String(_) | Value::Array(_)) => {
                Some(other.to_string())
            }
        }
    }

    /// Judges a shared group's account as the server would.
    ///
    /// # Returns
    ///
    /// Whether the server accepts the account, or `None` for a group whose
    /// case is not about the account.
    fn judge_shared_group(shared: &SharedGroup) -> Option<bool> {
        let variable = build_group_variable(&shared.group)?;
        Some(parse_account_variable(&variable).is_ok())
    }

    /// Builds the JSON the backend writes, with one field replaced.
    fn build_variable(field: &str, value: &str) -> String {
        let mut fields = vec![
            ("address", "\"person@example.com\"".to_owned()),
            ("displayName", "\"A Person\"".to_owned()),
            ("userName", "\"person@example.com\"".to_owned()),
            ("password", format!("\"{SYNTHETIC_PASSWORD}\"")),
            (
                "imap",
                "{\"host\":\"imap.example.com\",\"port\":993,\"security\":\"tls\"}".to_owned(),
            ),
            (
                "smtp",
                "{\"host\":\"smtp.example.com\",\"port\":587,\"security\":\"starttls\"}".to_owned(),
            ),
            ("serverKeepsSentCopy", "true".to_owned()),
        ];
        for (name, stored) in &mut fields {
            if *name == field {
                *stored = value.to_owned();
            }
        }
        let body: Vec<String> = fields
            .iter()
            .map(|(name, stored)| format!("\"{name}\":{stored}"))
            .collect();
        format!("{{{}}}", body.join(","))
    }

    #[test]
    fn parses_the_account_the_backend_writes() {
        let account = parse_account_variable(&build_variable("", "")).expect("account");

        assert_eq!(account.address, "person@example.com");
        assert_eq!(account.display_name, "A Person");
        assert_eq!(account.user_name, "person@example.com");
        assert_eq!(account.password.as_str(), SYNTHETIC_PASSWORD);
        assert_eq!(
            account.imap,
            MailServer {
                host: "imap.example.com".to_owned(),
                port: 993,
                security: Security::Tls
            }
        );
        assert_eq!(account.smtp.security, Security::StartTls);
        assert!(account.server_keeps_sent_copy);
    }

    #[test]
    fn hides_the_texts_and_the_password_from_debug_output() {
        let account = parse_account_variable(&build_variable("", "")).expect("account");

        let debug = format!("{account:?}");

        assert!(!debug.contains("person"));
        assert!(!debug.contains("correct horse"));
        assert!(debug.contains("imap.example.com"));
        assert!(debug.contains("<redacted>"));
    }

    #[test]
    fn reports_text_that_is_not_json_or_not_an_account_by_kind() {
        assert_eq!(
            parse_account_variable("{").map(|_| ()),
            Err(AccountProblem::NotJson)
        );
        assert_eq!(
            parse_account_variable("[]").map(|_| ()),
            Err(AccountProblem::NotAnAccount)
        );
        assert_eq!(
            parse_account_variable(&build_variable("serverKeepsSentCopy", "\"yes\"")).map(|_| ()),
            Err(AccountProblem::NotAnAccount)
        );
        assert_eq!(
            parse_account_variable(&build_variable(
                "imap",
                "{\"host\":\"h\",\"port\":1,\"security\":\"tls\",\"x\":1}"
            ))
            .map(|_| ()),
            Err(AccountProblem::NotAnAccount)
        );
    }

    #[test]
    fn refuses_a_field_that_breaks_a_rule_and_names_the_rule_without_the_value() {
        let cases = [
            ("address", "\"person\""),
            ("address", "\"a@b@example.com\""),
            ("displayName", "\" A Person\""),
            ("displayName", "\"A\\nPerson\""),
            ("userName", "\"\""),
            ("password", "\"\""),
            ("password", "\"a\\tb\""),
            (
                "imap",
                "{\"host\":\"-bad.example.com\",\"port\":993,\"security\":\"tls\"}",
            ),
            (
                "imap",
                "{\"host\":\"imap.example.com\",\"port\":0,\"security\":\"tls\"}",
            ),
            (
                "smtp",
                "{\"host\":\"smtp.example.com\",\"port\":25,\"security\":\"ssl\"}",
            ),
            (
                "smtp",
                "{\"host\":\"smtp.example.com\",\"port\":25,\"security\":\"plain\"}",
            ),
        ];
        for (field, value) in cases {
            let problem = parse_account_variable(&build_variable(field, value))
                .map(|_| ())
                .expect_err(field);
            let AccountProblem::Rule(rule) = problem else {
                panic!("{field}: expected a rule, got {problem:?}");
            };
            assert!(rule.starts_with(field), "{field}: {rule}");
            assert!(!rule.contains("example"), "{field}: {rule}");
        }
    }

    /// Parses the account whose IMAP port is written as the JSON number.
    fn parse_with_imap_port(port: &str) -> Result<Account, AccountProblem> {
        parse_account_variable(&build_variable(
            "imap",
            &format!("{{\"host\":\"imap.example.com\",\"port\":{port},\"security\":\"tls\"}}"),
        ))
    }

    #[test]
    fn reads_a_port_written_as_any_whole_number_from_1_to_65535_and_refuses_the_rest() {
        for (written, port) in [
            ("993", 993),
            ("993.0", 993),
            ("9.93e2", 993),
            ("1", 1),
            ("65535", 65_535),
            ("6.5535E4", 65_535),
        ] {
            let account = parse_with_imap_port(written).expect(written);
            assert_eq!(account.imap.port, port, "{written}");
        }
        for written in ["993.5", "0", "0.0", "65536", "65535.5", "-993", "1e10"] {
            assert_eq!(
                parse_with_imap_port(written).map(|_| ()),
                Err(AccountProblem::Rule(
                    "imap.port is a whole number from 1 to 65535"
                )),
                "{written}"
            );
        }
        assert_eq!(
            parse_with_imap_port("\"993\"").map(|_| ()),
            Err(AccountProblem::NotAnAccount)
        );
    }

    #[test]
    fn allows_a_plain_connection_to_the_machine_itself_and_an_ipv6_host() {
        for host in ["localhost", "127.0.0.1", "[::1]", "LOCALHOST"] {
            let value = format!("{{\"host\":\"{host}\",\"port\":1143,\"security\":\"plain\"}}");
            let account = parse_account_variable(&build_variable("imap", &value)).expect(host);
            assert_eq!(account.imap.security, Security::Plain);
        }
        let account = parse_account_variable(&build_variable(
            "smtp",
            "{\"host\":\"[2001:db8::25]\",\"port\":465,\"security\":\"tls\"}",
        ))
        .expect("ipv6");

        assert_eq!(account.smtp.server_name(), "2001:db8::25");
        assert_eq!(account.imap.server_name(), "imap.example.com");
    }

    #[test]
    fn parses_each_variable_the_backend_writes_into_the_same_fields() {
        let shared: Vec<SharedVariable> =
            serde_json::from_str(SHARED_VARIABLES).expect("the shared variables");

        assert!(!shared.is_empty());
        for case in shared {
            let account = parse_account_variable(&case.variable.to_string()).expect(&case.case);
            assert_eq!(
                format_account_value(&account),
                case.variable,
                "{}",
                case.case
            );
        }
    }

    #[test]
    fn judges_each_account_of_the_shared_groups_as_the_shared_rules_do() {
        let shared: Vec<SharedGroup> =
            serde_json::from_str(SHARED_GROUPS).expect("the shared groups");

        let judged: Vec<(&str, bool, bool)> = shared
            .iter()
            .filter_map(|case| {
                judge_shared_group(case).map(|parsed| (case.case.as_str(), case.accepted, parsed))
            })
            .collect();

        let mismatches: Vec<&(&str, bool, bool)> = judged
            .iter()
            .filter(|(_, accepted, parsed)| accepted != parsed)
            .collect();
        assert!(mismatches.is_empty(), "{mismatches:#?}");
        assert!(judged.iter().any(|(_, accepted, _)| *accepted));
        assert!(judged.iter().any(|(_, accepted, _)| !*accepted));
    }

    /// Parses the account with one text field set to `count` copies of a
    /// character outside the Basic Multilingual Plane: one code point, two
    /// UTF-16 code units, and four bytes each.
    fn parse_with_long_text(field: &str, count: usize) -> Result<Account, AccountProblem> {
        let text = "\u{1F600}".repeat(count);
        parse_account_variable(&build_variable(field, &format!("\"{text}\"")))
    }

    #[test]
    fn counts_names_and_the_password_in_code_points_up_to_the_shared_limits() {
        for (field, limit) in [("displayName", 100), ("userName", 254), ("password", 1024)] {
            assert!(
                parse_with_long_text(field, limit).is_ok(),
                "{field} at {limit}"
            );
            let problem = parse_with_long_text(field, limit + 1)
                .map(|_| ())
                .expect_err(field);
            assert!(
                matches!(problem, AccountProblem::Rule(rule) if rule.starts_with(field)),
                "{field} over {limit}: {problem:?}"
            );
        }
    }

    #[test]
    fn allows_an_ipv6_host_in_brackets_up_to_47_characters() {
        let at_limit = format!("[{}0]", "0:".repeat(22));
        let over_limit = format!("[{}00]", "0:".repeat(22));
        assert_eq!(at_limit.len(), 47);
        let server =
            |host: &str| format!("{{\"host\":\"{host}\",\"port\":993,\"security\":\"tls\"}}");

        let accepted = parse_account_variable(&build_variable("imap", &server(&at_limit)));
        let refused = parse_account_variable(&build_variable("imap", &server(&over_limit)));

        assert_eq!(accepted.map(|account| account.imap.host), Ok(at_limit));
        assert_eq!(
            refused.map(|_| ()),
            Err(AccountProblem::Rule(
                "imap.host is a host name or an IPv6 address in brackets"
            ))
        );
    }

    #[test]
    fn describes_every_problem_without_a_value() {
        assert_eq!(AccountProblem::Missing.to_string(), "is not set");
        assert_eq!(
            AccountProblem::NotUnicode.to_string(),
            "is not Unicode text"
        );
        assert_eq!(AccountProblem::NotJson.to_string(), "is not JSON");
        assert!(
            AccountProblem::NotAnAccount
                .to_string()
                .starts_with("is not the account")
        );
        assert_eq!(
            AccountProblem::Rule("imap.port is a whole number from 1 to 65535").to_string(),
            "breaks a rule: imap.port is a whole number from 1 to 65535"
        );
    }
}
