//! The host name rule shared by the settings groups that name a server: the
//! provider addresses and the email account's mail servers.
//!
//! The rule matches `isHostName` in `@lys/share`, which the renderer and the
//! backend check. Changing it changes which settings files load and requires
//! a coordinated desktop and backend release.

/// Most characters a host name may have, inclusive. Matches
/// `MAXIMUM_HOST_NAME_LENGTH` in `@lys/share`.
const HOST_NAME_MAX_LENGTH: usize = 253;

/// Most characters one host name label may have, inclusive. Matches
/// `MAXIMUM_HOST_LABEL_LENGTH` in `@lys/share`.
const HOST_LABEL_MAX_LENGTH: usize = 63;

/// Reports whether `host` is a host name: 1 to 253 characters of labels
/// separated by dots, each label 1 to 63 ASCII letters, digits, or inner
/// hyphens, which also covers a dotted IPv4 address.
///
/// An empty text, a scheme, a path, a port, an IPv6 address, and a label
/// outside the rule are not host names.
pub fn is_host_name(host: &str) -> bool {
    !host.is_empty() && host.len() <= HOST_NAME_MAX_LENGTH && host.split('.').all(is_host_label)
}

/// Reports whether `label` is one host name label: 1 to 63 ASCII letters,
/// digits, or hyphens, starting and ending with a letter or digit.
fn is_host_label(label: &str) -> bool {
    let bytes = label.as_bytes();
    let (Some(first), Some(last)) = (bytes.first(), bytes.last()) else {
        return false;
    };

    label.len() <= HOST_LABEL_MAX_LENGTH
        && first.is_ascii_alphanumeric()
        && last.is_ascii_alphanumeric()
        && bytes
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || *byte == b'-')
}

#[cfg(test)]
mod tests {
    use super::is_host_name;

    #[test]
    fn accepts_names_of_letters_digits_and_inner_hyphens_and_dotted_ipv4_addresses() {
        let longest_name = format!(
            "{}.{}.{}.{}",
            "a".repeat(63),
            "b".repeat(63),
            "c".repeat(63),
            "d".repeat(61)
        );

        for host in [
            "localhost",
            "imap.example.com",
            "Mail-2.Example.COM",
            "127.0.0.1",
            "xn--bcher-kva.example",
            longest_name.as_str(),
        ] {
            assert!(is_host_name(host), "{host}");
        }
    }

    #[test]
    fn rejects_empty_long_spaced_schemed_ported_bracketed_and_non_ascii_names() {
        let too_long_name = format!(
            "{}.{}.{}.{}",
            "a".repeat(63),
            "b".repeat(63),
            "c".repeat(63),
            "d".repeat(62)
        );
        let too_long_label = format!("{}.example", "a".repeat(64));

        for host in [
            "",
            too_long_name.as_str(),
            too_long_label.as_str(),
            "imap example.com",
            "imaps://imap.example.com",
            "imap.example.com:993",
            "imap.example.com/inbox",
            "[::1]",
            "::1",
            "-example.com",
            "example-.com",
            "example..com",
            ".example.com",
            "my_mail.example.com",
            "exämple.com",
        ] {
            assert!(!is_host_name(host), "{host}");
        }
    }
}
