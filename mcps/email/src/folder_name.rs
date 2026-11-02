//! Folder names as IMAP writes them: modified UTF-7 (RFC 3501 §5.1.3).
//!
//! A server names folders in a 7-bit form where `&` opens a run of
//! base64-coded UTF-16, closed by `-`, with `,` in place of `/`, and `&-`
//! stands for `&` itself. The tools show and accept the decoded names; the
//! server's form is used only in commands and compared only with itself.

/// The base64 alphabet of modified UTF-7.
const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+,";

/// Encodes a folder name as the IMAP server expects it.
///
/// # Arguments
///
/// * `name` - The name as the person and the model see it.
///
/// # Returns
///
/// The name in modified UTF-7; a name of printable ASCII without `&` is
/// returned unchanged.
pub fn encode_folder_name(name: &str) -> String {
    let mut encoded = String::with_capacity(name.len());
    let mut run = String::new();
    for character in name.chars() {
        let is_direct = (' '..='~').contains(&character) && character != '&';
        if is_direct {
            close_run(&mut encoded, &mut run);
            encoded.push(character);
        } else if character == '&' {
            close_run(&mut encoded, &mut run);
            encoded.push_str("&-");
        } else {
            run.push(character);
        }
    }
    close_run(&mut encoded, &mut run);
    encoded
}

/// Appends the pending run of non-ASCII characters, if any, as `&…-`.
fn close_run(encoded: &mut String, run: &mut String) {
    if run.is_empty() {
        return;
    }
    let mut bytes = Vec::with_capacity(run.len() * 2);
    for unit in run.encode_utf16() {
        bytes.extend_from_slice(&unit.to_be_bytes());
    }
    encoded.push('&');
    encoded.push_str(&encode_base64(&bytes));
    encoded.push('-');
    run.clear();
}

/// Encodes bytes in the modified base64 of UTF-7, without padding.
fn encode_base64(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let value = chunk.iter().enumerate().fold(0u32, |value, (index, byte)| {
            value | (u32::from(*byte) << (16 - 8 * index))
        });
        let count = chunk.len() * 8 / 6 + usize::from(chunk.len() * 8 % 6 != 0);
        for index in 0..count {
            let sextet = (value >> (18 - 6 * index)) & 0x3F;
            out.push(char::from(ALPHABET[sextet as usize]));
        }
    }
    out
}

/// Decodes a folder name the IMAP server sent.
///
/// # Arguments
///
/// * `encoded` - The name in modified UTF-7.
///
/// # Returns
///
/// The name as the person and the model see it. A run that is not valid
/// modified UTF-7 is kept as written, so every server name decodes to
/// something.
pub fn decode_folder_name(encoded: &str) -> String {
    let mut decoded = String::with_capacity(encoded.len());
    let mut rest = encoded;
    while let Some(start) = rest.find('&') {
        decoded.push_str(&rest[..start]);
        let after = &rest[start + 1..];
        let Some(end) = after.find('-') else {
            decoded.push_str(&rest[start..]);
            return decoded;
        };
        let run = &after[..end];
        if run.is_empty() {
            decoded.push('&');
        } else {
            match decode_run(run) {
                Some(text) => decoded.push_str(&text),
                None => decoded.push_str(&rest[start..start + 2 + end]),
            }
        }
        rest = &after[end + 1..];
    }
    decoded.push_str(rest);
    decoded
}

/// Decodes one `&…-` run's base64 as UTF-16.
fn decode_run(run: &str) -> Option<String> {
    let mut bits: u32 = 0;
    let mut bit_count = 0;
    let mut bytes = Vec::with_capacity(run.len() * 3 / 4);
    for character in run.bytes() {
        let sextet = ALPHABET
            .iter()
            .position(|candidate| *candidate == character)?;
        bits = (bits << 6) | sextet as u32;
        bit_count += 6;
        if bit_count >= 8 {
            bit_count -= 8;
            bytes.push(((bits >> bit_count) & 0xFF) as u8);
        }
    }
    if bytes.len() % 2 != 0 {
        return None;
    }
    let units: Vec<u16> = bytes
        .chunks(2)
        .map(|pair| u16::from_be_bytes([pair[0], pair[1]]))
        .collect();
    String::from_utf16(&units).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_plain_ascii_names_and_escapes_the_ampersand() {
        assert_eq!(encode_folder_name("INBOX"), "INBOX");
        assert_eq!(encode_folder_name("Projects/2026"), "Projects/2026");
        assert_eq!(encode_folder_name("Tom & Jerry"), "Tom &- Jerry");
        assert_eq!(decode_folder_name("Tom &- Jerry"), "Tom & Jerry");
    }

    #[test]
    fn encodes_and_decodes_non_ascii_names_as_rfc_3501_shows() {
        assert_eq!(
            encode_folder_name("~peter/mail/台北/日本語"),
            "~peter/mail/&U,BTFw-/&ZeVnLIqe-"
        );
        assert_eq!(
            decode_folder_name("~peter/mail/&U,BTFw-/&ZeVnLIqe-"),
            "~peter/mail/台北/日本語"
        );
        assert_eq!(encode_folder_name("Entwürfe"), "Entw&APw-rfe");
        assert_eq!(decode_folder_name("Entw&APw-rfe"), "Entwürfe");
        assert_eq!(
            decode_folder_name(&encode_folder_name("Café & Bar ☕")),
            "Café & Bar ☕"
        );
    }

    #[test]
    fn keeps_a_run_that_is_not_modified_utf7() {
        assert_eq!(decode_folder_name("Open&Run"), "Open&Run");
        assert_eq!(decode_folder_name("Bad&*-x"), "Bad&*-x");
        assert_eq!(decode_folder_name("Odd&AP-x"), "Odd&AP-x");
    }
}
