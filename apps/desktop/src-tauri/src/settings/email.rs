//! The email account stored under the `email` settings group.
//!
//! The person saves one email account in Settings → Email: the address mail
//! is sent from and received at, the name sent with it, the user name the
//! account signs in with, and the IMAP and SMTP servers Lys reaches. A
//! missing group, a missing `account` field, and a settings file written
//! before the group existed all mean no account. The backend reads the group
//! from the saved file and starts the built-in email MCP server with it; this
//! module only stores it. The password is not here: it lives in the
//! `secrets` group as `emailPassword`.
//!
//! Every rule matches `emailSettingsSchema` in `@lys/share`, which the
//! renderer and the backend check. A text with a lone surrogate, which that
//! schema refuses, never reaches these rules: the JSON reader refuses its
//! escape, so the whole settings file fails to load.
//!
//! The account is personal data. It is stored as plain text in the
//! owner-only settings file, `Debug` never shows its texts, and a validation
//! error about the account never quotes a value. An error about the group
//! itself, such as an `account` value that is a list, can quote that value,
//! because it is the JSON reader's own message.

use std::fmt;

use serde::de::Error;
use serde::{Deserialize, Deserializer, Serialize};

use super::host_name::is_host_name;
use super::json_object::parse_json_object;

/// Most characters an email address may have, inclusive. Matches
/// `MAXIMUM_EMAIL_ADDRESS_LENGTH` in `@lys/share`.
const ADDRESS_MAX_LENGTH: usize = 254;

/// Most characters the part of an address before `@` may have, inclusive.
/// Matches `MAXIMUM_EMAIL_LOCAL_PART_LENGTH` in `@lys/share`.
const ADDRESS_NAME_MAX_LENGTH: usize = 64;

/// Most characters, counted as Unicode scalar values, a display name may
/// have, inclusive. Matches `MAXIMUM_EMAIL_DISPLAY_NAME_LENGTH` in
/// `@lys/share`.
const DISPLAY_NAME_MAX_LENGTH: usize = 100;

/// Most characters, counted as Unicode scalar values, a user name may have,
/// inclusive. Matches `MAXIMUM_EMAIL_USER_NAME_LENGTH` in `@lys/share`.
const USER_NAME_MAX_LENGTH: usize = 254;

/// Most characters an IPv6 address in brackets may have, inclusive. Matches
/// `MAXIMUM_BRACKETED_IPV6_LENGTH` in `@lys/share`.
const BRACKETED_IPV6_MAX_LENGTH: usize = 47;

/// Hosts a mail server may be reached on without TLS, in lowercase: the
/// machine Lys runs on. Matches `LOOPBACK_EMAIL_HOSTS` in `@lys/share`.
const LOOPBACK_HOSTS: [&str; 3] = ["localhost", "127.0.0.1", "[::1]"];

/// Error for an account value that is not an account object.
const ACCOUNT_SHAPE_ERROR: &str = "an email account must be an object holding address, displayName, userName, imap, smtp, and serverKeepsSentCopy of the right types, and no other field";

/// Rule of an address, as an error message.
const ADDRESS_RULE: &str =
    "an email address must be a name of visible characters, @, and a host name, up to 254 characters";

/// Rule of a display name, as an error message.
const DISPLAY_NAME_RULE: &str = "a display name must be up to 100 characters, without control characters or white space at either end";

/// Rule of a user name, as an error message.
const USER_NAME_RULE: &str = "a user name must be 1 to 254 characters, without control characters or white space at either end";

/// Rule of a mail server host, as an error message.
const HOST_RULE: &str =
    "a mail server host must be a host name, an IPv4 address, or an IPv6 address in brackets";

/// Rule of a mail server port, as an error message.
const PORT_RULE: &str = "a mail server port must be a whole number from 1 to 65535";

/// Rule of a mail server's security, as an error message.
const SECURITY_RULE: &str = "a mail server security must be tls, starttls, or plain";

/// Rule of a connection without TLS, as an error message.
const PLAIN_RULE: &str =
    "a connection without TLS is allowed only to localhost, 127.0.0.1, or [::1]";

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize)]
/// Email account persisted under the `email` JSON object.
///
/// A missing group or a missing `account` field means no account. The group
/// may not be `null`, and unknown fields are rejected.
pub struct EmailSettings {
    /// The saved account; `None`, JSON `null`, when none is saved.
    account: Option<EmailAccount>,
}

/// Deserializes the group and applies its rules.
impl<'de> Deserialize<'de> for EmailSettings {
    /// Reads the `email` object and rejects a group that breaks a rule.
    ///
    /// # Errors
    ///
    /// Returns the deserializer's error when the input is not an object with
    /// only an `account` field, or the account breaks a rule.
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let stored: StoredEmailSettings = parse_json_object(deserializer)?;

        Ok(Self {
            account: stored.account,
        })
    }
}

#[derive(Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
/// The `email` JSON object before the group's own rules apply.
struct StoredEmailSettings {
    /// The saved account, already valid on its own; a missing field means
    /// none.
    account: Option<EmailAccount>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
/// The email account: who the person is, how the account signs in, and the
/// servers it reaches.
///
/// `Debug` shows each server's port and security and hides every text.
struct EmailAccount {
    /// Address mail is sent from and received at.
    address: EmailAddress,
    /// Name sent with the address; empty sends the address alone.
    display_name: DisplayName,
    /// Name the account signs in with, often the address itself.
    user_name: UserName,
    /// Server mail is read from.
    imap: MailServer,
    /// Server mail is sent through.
    smtp: MailServer,
    /// Whether the SMTP server files a copy of each sent message in the Sent
    /// folder itself, as Gmail does; when false, Lys files the copy.
    server_keeps_sent_copy: bool,
}

/// Deserializes one account and applies its rules.
impl<'de> Deserialize<'de> for EmailAccount {
    /// Reads one account object and rejects one that breaks a rule.
    ///
    /// # Errors
    ///
    /// Returns the deserializer's error when the input is not an account
    /// object with only its fields, each of the right type, or a field
    /// breaks its rule. The error names the rule and never contains a value,
    /// because the deserializer's own messages can quote one.
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let stored: StoredEmailAccount =
            parse_json_object(deserializer).map_err(|_| D::Error::custom(ACCOUNT_SHAPE_ERROR))?;

        Self::try_from(stored).map_err(D::Error::custom)
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
/// An account object before its rules apply.
struct StoredEmailAccount {
    /// Address text.
    address: String,
    /// Display name text.
    display_name: String,
    /// User name text.
    user_name: String,
    /// IMAP server object.
    #[serde(deserialize_with = "parse_json_object")]
    imap: StoredMailServer,
    /// SMTP server object.
    #[serde(deserialize_with = "parse_json_object")]
    smtp: StoredMailServer,
    /// Sent copy switch.
    server_keeps_sent_copy: bool,
}

impl TryFrom<StoredEmailAccount> for EmailAccount {
    type Error = &'static str;

    /// Applies the address, display name, user name, and server rules.
    ///
    /// # Errors
    ///
    /// Returns the message of the first broken rule, without any value.
    fn try_from(stored: StoredEmailAccount) -> Result<Self, Self::Error> {
        Ok(Self {
            address: EmailAddress::new(stored.address).ok_or(ADDRESS_RULE)?,
            display_name: DisplayName::new(stored.display_name).ok_or(DISPLAY_NAME_RULE)?,
            user_name: UserName::new(stored.user_name).ok_or(USER_NAME_RULE)?,
            imap: MailServer::try_from(stored.imap)?,
            smtp: MailServer::try_from(stored.smtp)?,
            server_keeps_sent_copy: stored.server_keeps_sent_copy,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
/// One mail server of the account: where it is and how the connection to it
/// is secured.
struct MailServer {
    /// Host name, dotted IPv4 address, or IPv6 address in brackets.
    host: MailHost,
    /// TCP port, such as 993 for IMAP or 465 for SMTP over TLS.
    port: u16,
    /// How the connection is secured.
    security: Security,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
/// A mail server object before its rules apply.
struct StoredMailServer {
    /// Host text.
    host: String,
    /// Port number, however the JSON number is written: `993`, `993.0`, and
    /// `9.93e2` are one number, as they are to `emailSettingsSchema` in
    /// `@lys/share`. serde_json's `float_roundtrip` feature reads a number
    /// with many digits, such as `587.00000000000005`, correctly rounded, as
    /// `JSON.parse` does.
    port: f64,
    /// Security text.
    security: String,
}

impl TryFrom<StoredMailServer> for MailServer {
    type Error = &'static str;

    /// Applies the host, port, security, and plain-connection rules.
    ///
    /// # Errors
    ///
    /// Returns the message of the first broken rule, without any value.
    fn try_from(stored: StoredMailServer) -> Result<Self, Self::Error> {
        let host = MailHost::new(stored.host).ok_or(HOST_RULE)?;
        let port = parse_port(stored.port).ok_or(PORT_RULE)?;
        let security = Security::parse(&stored.security).ok_or(SECURITY_RULE)?;
        if security == Security::Plain && !host.is_loopback() {
            return Err(PLAIN_RULE);
        }

        Ok(Self {
            host,
            port,
            security,
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
/// How Lys secures its connection to a mail server.
///
/// Matches `emailSecuritySchema` in `@lys/share`; adding a value is a
/// compatibility change for every consumer that branches on it.
enum Security {
    /// TLS from the first byte.
    Tls,
    /// Plain text first, then an upgrade with STARTTLS, which must succeed.
    #[serde(rename = "starttls")]
    StartTls,
    /// Never encrypted; only a loopback host may use it.
    Plain,
}

impl Security {
    /// Parses the stored text of a security: `tls`, `starttls`, or `plain`,
    /// exactly.
    ///
    /// Returns `None` for any other text.
    fn parse(value: &str) -> Option<Self> {
        match value {
            "tls" => Some(Self::Tls),
            "starttls" => Some(Self::StartTls),
            "plain" => Some(Self::Plain),
            _ => None,
        }
    }
}

#[derive(Clone, PartialEq, Eq, Serialize)]
#[serde(transparent)]
/// Address of the account, as the person typed it.
///
/// Holds a name of 1 to 64 visible ASCII characters other than `@`, then
/// `@`, then a host name, at most 254 characters in all. A host with letters
/// beyond ASCII is not accepted: SMTP sends the address as typed, without
/// the extension that carries them. It serializes as a JSON string. `Debug`
/// never shows the address.
struct EmailAddress(
    /// The validated address.
    String,
);

impl EmailAddress {
    /// Creates an address when `value` follows the address rule.
    ///
    /// Returns `None` otherwise; the value is never trimmed or changed.
    fn new(value: String) -> Option<Self> {
        let is_valid = value.len() <= ADDRESS_MAX_LENGTH
            && value
                .rsplit_once('@')
                .is_some_and(|(name, host)| is_address_name(name) && is_host_name(host));

        is_valid.then_some(Self(value))
    }
}

impl fmt::Debug for EmailAddress {
    /// Writes a placeholder instead of the address.
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("EmailAddress(<redacted>)")
    }
}

#[derive(Clone, PartialEq, Eq, Serialize)]
#[serde(transparent)]
/// Name sent with the account's address, as the person typed it.
///
/// Holds up to 100 characters, none of them a control character, with no
/// white space at either end; empty sends the address alone. It serializes
/// as a JSON string. `Debug` never shows the name.
struct DisplayName(
    /// The validated name.
    String,
);

impl DisplayName {
    /// Creates a name when `value` follows the display name rule.
    ///
    /// Returns `None` otherwise; the value is never trimmed or changed.
    fn new(value: String) -> Option<Self> {
        is_account_text(&value, DISPLAY_NAME_MAX_LENGTH).then_some(Self(value))
    }
}

impl fmt::Debug for DisplayName {
    /// Writes a placeholder instead of the name.
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("DisplayName(<redacted>)")
    }
}

#[derive(Clone, PartialEq, Eq, Serialize)]
#[serde(transparent)]
/// Name the account signs in to its servers with, as the person typed it.
///
/// Holds 1 to 254 characters, none of them a control character, with no
/// white space at either end. It serializes as a JSON string. `Debug` never
/// shows the name.
struct UserName(
    /// The validated name.
    String,
);

impl UserName {
    /// Creates a name when `value` follows the user name rule.
    ///
    /// Returns `None` otherwise; the value is never trimmed or changed.
    fn new(value: String) -> Option<Self> {
        let is_valid = !value.is_empty() && is_account_text(&value, USER_NAME_MAX_LENGTH);

        is_valid.then_some(Self(value))
    }
}

impl fmt::Debug for UserName {
    /// Writes a placeholder instead of the name.
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("UserName(<redacted>)")
    }
}

#[derive(Clone, PartialEq, Eq, Serialize)]
#[serde(transparent)]
/// Host of a mail server, as the person typed it.
///
/// Holds a host name, which also covers a dotted IPv4 address, or an IPv6
/// address in brackets of up to 47 characters. It serializes as a JSON
/// string. `Debug` never shows the host.
struct MailHost(
    /// The validated host.
    String,
);

impl MailHost {
    /// Creates a host when `value` follows the mail server host rule.
    ///
    /// Returns `None` otherwise; the value is never trimmed or changed.
    fn new(value: String) -> Option<Self> {
        let is_valid = is_host_name(&value) || is_bracketed_ipv6(&value);

        is_valid.then_some(Self(value))
    }

    /// Reports whether the host is the machine Lys runs on, which may be
    /// reached without TLS: `localhost`, `127.0.0.1`, or `[::1]`, in any
    /// case.
    fn is_loopback(&self) -> bool {
        LOOPBACK_HOSTS.contains(&self.0.to_ascii_lowercase().as_str())
    }
}

impl fmt::Debug for MailHost {
    /// Writes a placeholder instead of the host.
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("MailHost(<redacted>)")
    }
}

/// Reports whether `name` is the part of an address before `@`: 1 to 64
/// visible ASCII characters other than `@`.
fn is_address_name(name: &str) -> bool {
    (1..=ADDRESS_NAME_MAX_LENGTH).contains(&name.len())
        && name
            .bytes()
            .all(|byte| byte.is_ascii_graphic() && byte != b'@')
}

/// Reports whether `value` is a saved text of the account: at most
/// `max_length` characters, none of them a control character, with no white
/// space at either end. An empty text is.
fn is_account_text(value: &str, max_length: usize) -> bool {
    value.chars().count() <= max_length
        && !value.chars().any(char::is_control)
        && !value.starts_with(char::is_whitespace)
        && !value.ends_with(char::is_whitespace)
}

/// Reports whether `value` is an IPv6 address in brackets: up to 47
/// characters, `[`, hexadecimal digits, colons, and the dots of an embedded
/// IPv4 address with at least one colon, and `]`.
fn is_bracketed_ipv6(value: &str) -> bool {
    value.len() <= BRACKETED_IPV6_MAX_LENGTH
        && value
            .strip_prefix('[')
            .and_then(|rest| rest.strip_suffix(']'))
            .is_some_and(|inside| {
                inside.contains(':')
                    && inside.chars().all(|character| {
                        character.is_ascii_hexdigit() || character == ':' || character == '.'
                    })
            })
}

/// Parses a stored port number: a whole number from 1 to 65535, however it
/// is written, so `993.0` and `9.93e2` are the port 993.
///
/// Returns `None` for a fraction or a number outside that range.
fn parse_port(number: f64) -> Option<u16> {
    if number.fract() != 0.0 || !(1.0..=f64::from(u16::MAX)).contains(&number) {
        return None;
    }

    // The check above proves a whole number that `u16` holds, so the cast
    // loses nothing.
    Some(number as u16)
}

#[cfg(test)]
mod tests {
    use serde_json::{json, Value};

    use super::EmailSettings;

    /// Reads `stored` as the `email` group.
    fn parse_email_settings(stored: Value) -> Result<EmailSettings, serde_json::Error> {
        serde_json::from_value(stored)
    }

    /// Returns a valid account with every field written, whose SMTP server
    /// upgrades with STARTTLS.
    fn get_account() -> Value {
        json!({
            "address": "person@example.com",
            "displayName": "A Person",
            "userName": "person@example.com",
            "imap": { "host": "imap.example.com", "port": 993, "security": "tls" },
            "smtp": { "host": "smtp.example.com", "port": 587, "security": "starttls" },
            "serverKeepsSentCopy": true
        })
    }

    /// Returns the account with one field replaced.
    fn get_account_with(field: &str, value: Value) -> Value {
        let mut account = get_account();
        account[field] = value;

        account
    }

    /// Returns the account with one field of its IMAP server replaced.
    fn get_account_with_imap(field: &str, value: Value) -> Value {
        let mut account = get_account();
        account["imap"][field] = value;

        account
    }

    /// Reads a group holding only `account`.
    fn parse_account(account: Value) -> Result<EmailSettings, serde_json::Error> {
        parse_email_settings(json!({ "account": account }))
    }

    /// Asserts that a group holding only `account` is accepted.
    fn assert_account_accepted(account: Value) {
        let parsed = parse_account(account.clone());

        assert!(parsed.is_ok(), "{account}: {parsed:?}");
    }

    /// Asserts that a group holding only `account` is refused without
    /// quoting `personal`.
    fn assert_account_refused(account: Value, personal: &str) {
        let failure = parse_account(account.clone()).expect_err("an invalid account");

        assert!(!failure.to_string().contains(personal), "{failure}");
    }

    /// Groups that the host and `emailSettingsSchema` in `@lys/share` must
    /// judge alike; the backend's tests of its account reader read the same
    /// file.
    const SHARED_CASES: &str =
        include_str!("../../../../../packages/share/test/fixtures/email-settings-groups.json");

    #[derive(serde::Deserialize)]
    #[serde(deny_unknown_fields)]
    /// One case of the shared groups.
    struct SharedCase {
        /// What the case checks.
        case: String,
        /// Value of the `email` group.
        group: Value,
        /// Whether the rules accept the group.
        accepted: bool,
        /// What the host writes back for an accepted group.
        written: Option<Value>,
    }

    /// Describes how the host's judgement of `case` differs from the shared
    /// one, or returns `None` when it matches.
    fn find_shared_case_mismatch(case: SharedCase) -> Option<String> {
        match (parse_email_settings(case.group), case.accepted) {
            (Ok(_), false) => Some(format!("{}: accepted", case.case)),
            (Err(error), true) => Some(format!("{}: refused ({error})", case.case)),
            (Err(_), false) => None,
            (Ok(settings), true) => {
                let written = serde_json::to_value(&settings).expect("serialize");

                (case.written.as_ref() != Some(&written))
                    .then(|| format!("{}: writes {written}", case.case))
            }
        }
    }

    #[test]
    fn reads_a_missing_account_as_none_and_writes_a_null_account() {
        for stored in [json!({}), json!({ "account": null })] {
            let settings = parse_email_settings(stored).expect("a group without an account");

            assert_eq!(
                serde_json::to_value(&settings).expect("serialize"),
                json!({ "account": null })
            );
        }
        assert_eq!(
            serde_json::to_value(EmailSettings::default()).expect("serialize"),
            json!({ "account": null })
        );
    }

    #[test]
    fn writes_an_account_back_unchanged() {
        let stored = json!({ "account": get_account() });

        let settings = parse_email_settings(stored.clone()).expect("a valid group");

        assert_eq!(serde_json::to_value(&settings).expect("serialize"), stored);
    }

    #[test]
    fn rejects_a_null_group_unknown_fields_and_accounts_that_are_not_objects() {
        for stored in [
            Value::Null,
            json!([]),
            json!("person@example.com"),
            json!({ "account": null, "signature": "Regards" }),
            json!({ "account": [] }),
            json!({ "account": "person@example.com" }),
            json!({ "account": {} }),
        ] {
            assert!(parse_email_settings(stored.clone()).is_err(), "{stored}");
        }
    }

    #[test]
    fn rejects_an_account_with_a_missing_null_or_unknown_field_without_quoting_it() {
        for field in [
            "address",
            "displayName",
            "userName",
            "imap",
            "smtp",
            "serverKeepsSentCopy",
        ] {
            let mut missing = get_account();
            missing.as_object_mut().expect("an object").remove(field);
            assert_account_refused(missing, "person@example.com");
            assert_account_refused(get_account_with(field, Value::Null), "person@example.com");
        }
        assert_account_refused(
            get_account_with("signature", json!("Regards")),
            "person@example.com",
        );
        assert_account_refused(
            get_account_with("serverKeepsSentCopy", json!("true")),
            "person@example.com",
        );
    }

    #[test]
    fn accepts_addresses_of_a_visible_name_and_a_host_name_up_to_254_characters() {
        let longest = format!(
            "{}@{}.{}.{}",
            "a".repeat(64),
            "b".repeat(63),
            "c".repeat(63),
            "d".repeat(61)
        );

        for address in [
            "a@b",
            "person@example.com",
            "o'neil+tag.1_2-3@example.com",
            "person@Mail-2.Example.COM",
            "person@192.0.2.10",
            longest.as_str(),
        ] {
            assert_account_accepted(get_account_with("address", json!(address)));
        }
    }

    #[test]
    fn rejects_other_addresses_without_quoting_them() {
        let too_long = format!(
            "{}@{}.{}.{}",
            "a".repeat(64),
            "b".repeat(63),
            "c".repeat(63),
            "d".repeat(62)
        );
        let too_long_name = format!("{}@example.com", "a".repeat(65));

        for address in [
            String::new(),
            too_long,
            too_long_name,
            "person.example.com".to_string(),
            "@example.com".to_string(),
            "person@".to_string(),
            "per@son@example.com".to_string(),
            "per son@example.com".to_string(),
            "pérson@example.com".to_string(),
            "person@exämple.com".to_string(),
            "person@example..com".to_string(),
            "person@my_mail.example.com".to_string(),
            "person@example.com:25".to_string(),
            "person@[::1]".to_string(),
            "person@example.com\n".to_string(),
            "person@example.com ".to_string(),
        ] {
            assert_account_refused(get_account_with("address", json!(address)), "person");
        }
        assert_account_refused(get_account_with("address", json!(42)), "person");
    }

    #[test]
    fn accepts_display_names_up_to_100_characters_including_an_empty_one() {
        for name in ["", "A", "Jeanne d'Arc Épée", "東京 太郎", &"é".repeat(100)] {
            assert_account_accepted(get_account_with("displayName", json!(name)));
        }
    }

    #[test]
    fn rejects_long_padded_and_control_character_display_names_without_quoting_them() {
        for name in [
            "é".repeat(101),
            " Secret".to_string(),
            "Secret ".to_string(),
            "Secret\u{00a0}".to_string(),
            "Sec\nret".to_string(),
            "Sec\tret".to_string(),
            "Sec\u{0000}ret".to_string(),
        ] {
            assert_account_refused(get_account_with("displayName", json!(name)), "Secret");
        }
        assert_account_refused(get_account_with("displayName", json!(1)), "Secret");
    }

    #[test]
    fn accepts_user_names_of_one_to_254_characters() {
        for name in [
            "p",
            "person",
            "person@example.com",
            "DOMAIN\\person",
            &"é".repeat(254),
        ] {
            assert_account_accepted(get_account_with("userName", json!(name)));
        }
    }

    #[test]
    fn rejects_empty_long_padded_and_control_character_user_names_without_quoting_them() {
        for name in [
            String::new(),
            "é".repeat(255),
            " secret".to_string(),
            "secret ".to_string(),
            "sec\nret".to_string(),
            "sec\u{0000}ret".to_string(),
        ] {
            assert_account_refused(get_account_with("userName", json!(name)), "secret");
        }
    }

    #[test]
    fn accepts_host_names_ipv4_addresses_and_bracketed_ipv6_addresses() {
        let longest_name = format!(
            "{}.{}.{}.{}",
            "a".repeat(63),
            "b".repeat(63),
            "c".repeat(63),
            "d".repeat(61)
        );

        for host in [
            "imap.example.com",
            "IMAP.Example.COM",
            "localhost",
            "192.0.2.10",
            "[::1]",
            "[2001:db8::10]",
            "[::ffff:192.0.2.10]",
            "[0:0:0:0:0:0:0:1]",
            "[2001:0db8:0000:0000:0000:ffff:192.168.100.228]",
            longest_name.as_str(),
        ] {
            assert_account_accepted(get_account_with_imap("host", json!(host)));
        }
    }

    #[test]
    fn rejects_other_hosts_without_quoting_them() {
        let too_long_name = format!(
            "{}.{}.{}.{}",
            "a".repeat(63),
            "b".repeat(63),
            "c".repeat(63),
            "d".repeat(62)
        );
        let too_long_address = format!("[{}:]", "0".repeat(45));

        for host in [
            String::new(),
            too_long_name,
            too_long_address,
            "secret.example.com:993".to_string(),
            "imaps://secret.example.com".to_string(),
            "secret example.com".to_string(),
            "secret.exämple.com".to_string(),
            "::1".to_string(),
            "[::1".to_string(),
            "::1]".to_string(),
            "[]".to_string(),
            "[1234]".to_string(),
            "[2001:db8::g]".to_string(),
            "[::1 ]".to_string(),
            "[secret]".to_string(),
        ] {
            assert_account_refused(get_account_with_imap("host", json!(host)), "secret");
        }
        assert_account_refused(get_account_with_imap("host", Value::Null), "secret");
    }

    #[test]
    fn accepts_ports_from_1_to_65535_and_rejects_the_rest() {
        for port in [
            json!(1),
            json!(143),
            json!(65535),
            json!(1.0),
            json!(65535.0),
        ] {
            assert_account_accepted(get_account_with_imap("port", port));
        }
        for port in [
            json!(0),
            json!(65536),
            json!(-1),
            json!(0.0),
            json!(-0.0),
            json!(65536.0),
            json!("993"),
            json!(993.5),
            Value::Null,
        ] {
            assert!(
                parse_account(get_account_with_imap("port", port.clone())).is_err(),
                "{port}"
            );
        }
    }

    #[test]
    fn accepts_tls_and_starttls_everywhere_and_plain_only_on_loopback_hosts() {
        for (host, security) in [
            ("imap.example.com", "tls"),
            ("imap.example.com", "starttls"),
            ("localhost", "plain"),
            ("LOCALHOST", "plain"),
            ("127.0.0.1", "plain"),
            ("[::1]", "plain"),
        ] {
            let mut account = get_account();
            account["imap"] = json!({ "host": host, "port": 143, "security": security });
            account["smtp"] = json!({ "host": host, "port": 25, "security": security });
            assert_account_accepted(account);
        }
    }

    #[test]
    fn rejects_other_securities_and_plain_connections_to_other_hosts() {
        for security in [
            json!("TLS"),
            json!("ssl"),
            json!("STARTTLS"),
            json!(""),
            Value::Null,
            json!(true),
        ] {
            assert_account_refused(get_account_with_imap("security", security), "person");
        }
        for host in [
            "127.0.0.2",
            "localhost.example",
            "[0:0:0:0:0:0:0:1]",
            "imap.example.com",
        ] {
            let mut account = get_account();
            account["imap"] = json!({ "host": host, "port": 143, "security": "plain" });
            let failure = parse_account(account).expect_err("a plain connection to another host");
            assert!(failure.to_string().contains("without TLS"), "{failure}");
        }
        let mut plain_smtp = get_account();
        plain_smtp["smtp"]["security"] = json!("plain");
        assert!(parse_account(plain_smtp).is_err());
    }

    #[test]
    fn rejects_servers_that_are_not_objects_or_have_other_fields_without_quoting_them() {
        for server in [
            Value::Null,
            json!([]),
            json!("secret.example.com"),
            json!({}),
            json!({ "host": "secret.example.com", "port": 993 }),
            json!({ "host": "secret.example.com", "port": 993, "security": "tls", "timeoutSeconds": 30 }),
        ] {
            assert_account_refused(get_account_with("imap", server.clone()), "secret");
            assert_account_refused(get_account_with("smtp", server), "secret");
        }
    }

    #[test]
    fn reports_the_broken_rule_of_a_field() {
        for (account, rule) in [
            (
                get_account_with("address", json!("person")),
                "an email address must be",
            ),
            (
                get_account_with("displayName", json!(" A Person")),
                "a display name must be",
            ),
            (
                get_account_with("userName", json!("")),
                "a user name must be",
            ),
            (
                get_account_with_imap("host", json!("::1")),
                "a mail server host must be",
            ),
            (
                get_account_with_imap("port", json!(0)),
                "a mail server port must be",
            ),
            (
                get_account_with_imap("port", json!(65536)),
                "a mail server port must be",
            ),
            (
                get_account_with_imap("port", json!(993.5)),
                "a mail server port must be",
            ),
            (
                get_account_with_imap("security", json!("ssl")),
                "a mail server security must be",
            ),
            (
                get_account_with("signature", json!("Regards")),
                "an email account must be an object",
            ),
        ] {
            let failure = parse_account(account).expect_err("an invalid account");

            assert!(failure.to_string().contains(rule), "{failure}");
        }
    }

    #[test]
    fn debug_output_hides_every_text_and_shows_ports_and_securities() {
        let settings =
            parse_email_settings(json!({ "account": get_account() })).expect("a valid group");

        let debug_output = format!("{settings:?}");

        for hidden in ["person", "example.com", "A Person", "993\"", "<redacted>\""] {
            assert!(!debug_output.contains(hidden), "{debug_output}");
        }
        for shown in [
            "EmailAddress(<redacted>)",
            "MailHost(<redacted>)",
            "port: 993",
            "port: 587",
            "StartTls",
            "server_keeps_sent_copy: true",
        ] {
            assert!(debug_output.contains(shown), "{debug_output}");
        }
    }

    #[test]
    fn judges_and_writes_every_shared_group_as_the_share_package_rules_do() {
        let cases: Vec<SharedCase> = serde_json::from_str(SHARED_CASES).expect("the shared groups");
        assert!(cases.len() >= 100, "{}", cases.len());

        let mismatches: Vec<String> = cases
            .into_iter()
            .filter_map(find_shared_case_mismatch)
            .collect();

        assert!(mismatches.is_empty(), "{mismatches:#?}");
    }
}
