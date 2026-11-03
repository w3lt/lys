//! Fetched mail as the tools read it: the header fields, the text, and
//! the attachments of one message.
//!
//! A message is parsed with `mail-parser`; the text body is the first
//! text part of the message's text body, which `mail-parser` fills with
//! the HTML part when there is no plain one, converted to text then. Attachments are numbered from 1 in the order the
//! message lists them; only text-like ones can be read as text.

use std::borrow::Cow;

use mail_parser::decoders::html::html_to_text;
use mail_parser::{
    Address, AddressList, ContentType, Message, MessageParser, MessagePart, PartKind, TextList,
};

/// Content types read as text besides `text/*`.
const TEXT_LIKE_TYPES: [&str; 5] = [
    "application/json",
    "application/xml",
    "application/csv",
    "application/x-yaml",
    "application/yaml",
];

/// Suffixes of structured content types read as text, such as
/// `application/ld+json`.
const TEXT_LIKE_SUFFIXES: [&str; 2] = ["+json", "+xml"];

/// The header fields the tools show, from a whole message or from a
/// fetched header block.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Headers {
    /// The `From` field, formatted; empty when the message has none.
    pub from: String,
    /// The `To` field, formatted; empty when the message has none.
    pub to: String,
    /// The `Cc` field, formatted; empty when the message has none.
    pub cc: String,
    /// The `Reply-To` field, formatted; empty when the message has none.
    pub reply_to: String,
    /// The `Date` field as RFC 3339 text, when it parses.
    pub date: Option<String>,
    /// The `Date` field as seconds since the Unix epoch, when it parses.
    pub timestamp: Option<i64>,
    /// The `Subject` field, decoded; empty when absent.
    pub subject: String,
    /// The `Message-ID` field.
    pub message_id: Option<String>,
    /// The identifiers of the `In-Reply-To` field.
    pub in_reply_to: Vec<String>,
    /// The identifiers of the `References` field.
    pub references: Vec<String>,
}

/// One attachment of a message.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Attachment {
    /// The attachment's number, from 1, as `read_email` lists it.
    pub number: u32,
    /// Its file name, or a name made from its number.
    pub name: String,
    /// Its content type as `type/subtype`.
    pub content_type: String,
    /// Its content, transfer-decoded.
    pub bytes: Vec<u8>,
    /// Its content as text, when it is text-like.
    pub text: Option<String>,
}

/// One mailbox of an address field.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ParsedMailbox {
    /// Its display name, decoded; `None` when it has none.
    pub name: Option<String>,
    /// Its address; `None` when the entry names none, as a bare name does.
    pub address: Option<String>,
}

/// The mailboxes of a message's address fields, in the order the message
/// lists them, with the members of a group in its place; a list is empty
/// when the message has no such field.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct AddressFields {
    /// The mailboxes of the `From` field.
    pub from: Vec<ParsedMailbox>,
    /// The mailboxes of the `Reply-To` field.
    pub reply_to: Vec<ParsedMailbox>,
    /// The mailboxes of the `To` field.
    pub to: Vec<ParsedMailbox>,
    /// The mailboxes of the `Cc` field.
    pub cc: Vec<ParsedMailbox>,
    /// The mailboxes of the `Bcc` field, which only a draft keeps.
    pub bcc: Vec<ParsedMailbox>,
}

/// A message as the tools read it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MessageView {
    /// Its header fields.
    pub headers: Headers,
    /// Its address fields, mailbox by mailbox.
    pub addresses: AddressFields,
    /// Its text: the plain text body, or the HTML body as text.
    pub text: String,
    /// Whether the text came from HTML, having no plain text part.
    pub text_from_html: bool,
    /// Its attachments, numbered from 1.
    pub attachments: Vec<Attachment>,
}

/// Parses a whole message.
///
/// # Arguments
///
/// * `bytes` - The message (RFC 5322) as fetched.
///
/// # Returns
///
/// The message, or `None` when the bytes are not a message at all.
pub fn parse_message(bytes: &[u8]) -> Option<MessageView> {
    let message = MessageParser::default().parse(bytes)?;
    Some(build_message_view(&message))
}

/// Builds the view of a parsed message.
///
/// # Arguments
///
/// * `message` - The message as `mail-parser` parsed it.
pub(crate) fn build_message_view(message: &Message<'_>) -> MessageView {
    let headers = read_headers(message);
    let (text, text_from_html) = message
        .text_body()
        .find_map(read_body_text)
        .unwrap_or_default();
    let attachments = message
        .attachments()
        .enumerate()
        .map(|(index, part)| build_attachment(index, &part))
        .collect();
    MessageView {
        headers,
        addresses: read_address_fields(message),
        text,
        text_from_html,
        attachments,
    }
}

/// Reads the text of a body part, with whether it was converted from HTML.
///
/// # Arguments
///
/// * `part` - A part of the message's text body.
///
/// # Returns
///
/// The text and whether it came from HTML, or `None` when the part is
/// neither plain text nor HTML.
fn read_body_text(part: MessagePart<'_>) -> Option<(String, bool)> {
    match part.kind() {
        PartKind::Text => Some((part.text().map(Cow::into_owned).unwrap_or_default(), false)),
        PartKind::Html => Some((
            part.text()
                .map(|html| html_to_text(&html))
                .unwrap_or_default(),
            true,
        )),
        _ => None,
    }
}

/// Reads the mailboxes of the address fields.
fn read_address_fields(message: &Message<'_>) -> AddressFields {
    AddressFields {
        from: list_mailboxes(message.from()),
        reply_to: list_mailboxes(message.reply_to()),
        to: list_mailboxes(message.to()),
        cc: list_mailboxes(message.cc()),
        bcc: list_mailboxes(message.bcc()),
    }
}

/// Lists the mailboxes of an address field, the members of a group in its
/// place, or none when the message has no such field.
fn list_mailboxes(list: Option<AddressList<'_>>) -> Vec<ParsedMailbox> {
    list.map(|list| {
        list.mailboxes()
            .map(|mailbox| ParsedMailbox {
                name: mailbox.name().map(str::to_owned),
                address: mailbox.address().map(str::to_owned),
            })
            .collect()
    })
    .unwrap_or_default()
}

/// Parses a fetched header block.
///
/// # Arguments
///
/// * `bytes` - The header fields as `BODY.PEEK[HEADER.FIELDS (...)]`
///   returns them.
pub fn parse_headers(bytes: &[u8]) -> Headers {
    MessageParser::default()
        .parse_headers(bytes)
        .map(|message| read_headers(&message))
        .unwrap_or_default()
}

/// Reads the header fields the tools show.
fn read_headers(message: &Message<'_>) -> Headers {
    let date = message.date();
    Headers {
        from: message.from().map(format_addresses).unwrap_or_default(),
        to: message.to().map(format_addresses).unwrap_or_default(),
        cc: message.cc().map(format_addresses).unwrap_or_default(),
        reply_to: message.reply_to().map(format_addresses).unwrap_or_default(),
        date: date.as_ref().map(mail_parser::DateTime::to_rfc3339),
        timestamp: date.as_ref().map(mail_parser::DateTime::to_timestamp),
        subject: message.subject().unwrap_or_default().to_owned(),
        message_id: message.message_id().map(str::to_owned),
        in_reply_to: message
            .in_reply_to()
            .map(list_identifiers)
            .unwrap_or_default(),
        references: message
            .references()
            .map(list_identifiers)
            .unwrap_or_default(),
    }
}

/// Lists the identifiers of a `Message-ID`-like field.
fn list_identifiers(list: TextList<'_>) -> Vec<String> {
    list.iter().map(str::to_owned).collect()
}

/// Formats an address list as `Name <address>, address`.
///
/// # Arguments
///
/// * `list` - The parsed field.
fn format_addresses(list: AddressList<'_>) -> String {
    let mut parts = Vec::new();
    for address in list.iter() {
        match address {
            Address::Mailbox(mailbox) => {
                parts.push(format_mailbox(mailbox.name(), mailbox.address()))
            }
            Address::Group(group) => {
                let members: Vec<String> = group
                    .mailboxes()
                    .map(|mailbox| format_mailbox(mailbox.name(), mailbox.address()))
                    .collect();
                parts.push(format!(
                    "{}: {};",
                    group.name().unwrap_or("group"),
                    members.join(", ")
                ));
            }
        }
    }
    parts.join(", ")
}

/// Formats one mailbox as `Name <address>`, or the address alone.
fn format_mailbox(name: Option<&str>, address: Option<&str>) -> String {
    match (name.filter(|name| !name.is_empty()), address) {
        (Some(name), Some(address)) => format!("{name} <{address}>"),
        (None, Some(address)) => address.to_owned(),
        (Some(name), None) => name.to_owned(),
        (None, None) => String::new(),
    }
}

/// Formats a part's content type as `type/subtype` in lowercase, or as the
/// type alone when it has no subtype.
fn format_content_type(content_type: ContentType<'_>) -> String {
    match content_type.subtype() {
        Some(subtype) => format!("{}/{}", content_type.ctype(), subtype).to_ascii_lowercase(),
        None => content_type.ctype().to_ascii_lowercase(),
    }
}

/// Builds an attachment from its part.
fn build_attachment(index: usize, part: &MessagePart<'_>) -> Attachment {
    let number = u32::try_from(index + 1).unwrap_or(u32::MAX);
    let content_type = part
        .content_type()
        .map(format_content_type)
        .unwrap_or_else(|| "application/octet-stream".to_owned());
    let name = part
        .attachment_name()
        .map(str::to_owned)
        .or_else(|| {
            part.content_type()
                .and_then(|content_type| content_type.attribute("name"))
                .map(str::to_owned)
        })
        .unwrap_or_else(|| format!("attachment-{number}"));
    let bytes = part.decoded().into_owned();
    let text = if is_text_like(&content_type) {
        Some(
            part.text()
                .map(|text| text.into_owned())
                .unwrap_or_else(|| String::from_utf8_lossy(&bytes).into_owned()),
        )
    } else {
        None
    };
    Attachment {
        number,
        name,
        content_type,
        bytes,
        text,
    }
}

/// Whether a content type is read as text.
///
/// # Arguments
///
/// * `content_type` - The type as `type/subtype`, in lower case.
fn is_text_like(content_type: &str) -> bool {
    content_type.starts_with("text/")
        || TEXT_LIKE_TYPES.contains(&content_type)
        || TEXT_LIKE_SUFFIXES
            .iter()
            .any(|suffix| content_type.ends_with(suffix))
}

/// Formats a byte count for the model, such as `12.3 kB`.
///
/// # Arguments
///
/// * `size` - The count.
pub fn format_size(size: usize) -> String {
    if size < 1000 {
        return format!("{size} B");
    }
    let kilobytes = size as f64 / 1000.0;
    if kilobytes < 1000.0 {
        return format!("{kilobytes:.1} kB");
    }
    format!("{:.1} MB", kilobytes / 1000.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A plain message with every field the tools read.
    const PLAIN: &str = "From: Jane Doe <jane@example.com>\r\nTo: person@example.com, Team: a@example.com, b@example.com;\r\nCc: =?UTF-8?Q?J=C3=BCrgen?= <juergen@example.com>\r\nDate: Sun, 2 Nov 2026 10:30:00 +0100\r\nSubject: =?UTF-8?B?R3LDvMOfZQ==?= from Jane\r\nMessage-ID: <one@example.com>\r\nIn-Reply-To: <zero@example.com>\r\nReferences: <minus@example.com> <zero@example.com>\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nHello there.\r\n";

    /// A message with an HTML body, a text attachment, and a binary one.
    const MIXED: &str = "From: jane@example.com\r\nTo: person@example.com\r\nSubject: Report\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=\"b\"\r\n\r\n--b\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<html><body><p>Hello <b>there</b>.</p><p>Bye &amp; thanks.</p></body></html>\r\n--b\r\nContent-Type: text/csv; name=\"data.csv\"\r\nContent-Disposition: attachment; filename=\"data.csv\"\r\n\r\na,b\r\n1,2\r\n--b\r\nContent-Type: application/pdf\r\nContent-Disposition: attachment; filename=\"report.pdf\"\r\nContent-Transfer-Encoding: base64\r\n\r\nJVBERi0=\r\n--b--\r\n";

    #[test]
    fn reads_the_headers_and_the_text_of_a_plain_message() {
        let message = parse_message(PLAIN.as_bytes()).expect("message");

        assert_eq!(message.headers.from, "Jane Doe <jane@example.com>");
        assert_eq!(
            message.headers.to,
            "person@example.com, Team: a@example.com, b@example.com;"
        );
        assert_eq!(message.headers.cc, "Jürgen <juergen@example.com>");
        assert_eq!(
            message.headers.date.as_deref(),
            Some("2026-11-02T10:30:00+01:00")
        );
        assert_eq!(message.headers.timestamp, Some(1_793_611_800));
        assert_eq!(message.headers.subject, "Grüße from Jane");
        assert_eq!(
            message.headers.message_id.as_deref(),
            Some("one@example.com")
        );
        assert_eq!(message.headers.in_reply_to, vec!["zero@example.com"]);
        assert_eq!(
            message.headers.references,
            vec!["minus@example.com", "zero@example.com"]
        );
        assert_eq!(message.text, "Hello there.\r\n");
        assert!(!message.text_from_html);
        assert!(message.attachments.is_empty());
    }

    /// A mailbox of a test's address field.
    fn build_mailbox(name: Option<&str>, address: Option<&str>) -> ParsedMailbox {
        ParsedMailbox {
            name: name.map(str::to_owned),
            address: address.map(str::to_owned),
        }
    }

    #[test]
    fn lists_the_mailboxes_of_every_address_field_in_order() {
        let message = parse_message(b"From: \"Doe, Jane\" <jane@example.com>\r\nReply-To: a@example.com, b@example.com\r\nTo: Team: c@example.com, D <d@example.com>;, nobody\r\nBcc: hidden@example.com\r\nSubject: Hi\r\n\r\nHello\r\n").expect("message");

        assert_eq!(
            message.addresses,
            AddressFields {
                from: vec![build_mailbox(Some("Doe, Jane"), Some("jane@example.com"))],
                reply_to: vec![
                    build_mailbox(None, Some("a@example.com")),
                    build_mailbox(None, Some("b@example.com"))
                ],
                to: vec![
                    build_mailbox(None, Some("c@example.com")),
                    build_mailbox(Some("D"), Some("d@example.com")),
                    build_mailbox(Some("nobody"), None)
                ],
                cc: Vec::new(),
                bcc: vec![build_mailbox(None, Some("hidden@example.com"))],
            }
        );
        assert_eq!(message.headers.from, "Doe, Jane <jane@example.com>");
    }

    #[test]
    fn converts_html_to_text_and_lists_attachments_with_text_when_text_like() {
        let message = parse_message(MIXED.as_bytes()).expect("message");

        assert!(message.text_from_html);
        assert!(message.text.contains("Hello there."), "{}", message.text);
        assert!(message.text.contains("Bye & thanks."), "{}", message.text);
        assert_eq!(message.attachments.len(), 2);
        assert_eq!(message.attachments[0].number, 1);
        assert_eq!(message.attachments[0].name, "data.csv");
        assert_eq!(message.attachments[0].content_type, "text/csv");
        assert_eq!(message.attachments[0].text.as_deref(), Some("a,b\r\n1,2"));
        assert_eq!(message.attachments[1].number, 2);
        assert_eq!(message.attachments[1].name, "report.pdf");
        assert_eq!(message.attachments[1].content_type, "application/pdf");
        assert_eq!(message.attachments[1].bytes, b"%PDF-");
        assert_eq!(message.attachments[1].text, None);
    }

    #[test]
    fn reads_a_fetched_header_block_and_tolerates_what_is_not_a_message() {
        let headers = parse_headers(
            b"Subject: Hi\r\nFrom: a@example.com\r\nDate: Sun, 2 Nov 2026 10:30:00 +0000\r\n\r\n",
        );

        assert_eq!(headers.subject, "Hi");
        assert_eq!(headers.from, "a@example.com");
        assert_eq!(headers.date.as_deref(), Some("2026-11-02T10:30:00Z"));
        assert_eq!(parse_headers(b"").subject, "");
        assert!(parse_message(b"").is_none_or(|message| message.text.is_empty()));
        assert!(
            parse_message(b"\xff\xfe no message")
                .is_none_or(|message| message.headers.subject.is_empty())
        );
    }

    #[test]
    fn classifies_text_like_types_and_formats_sizes() {
        assert!(is_text_like("text/plain"));
        assert!(is_text_like("application/json"));
        assert!(is_text_like("application/ld+json"));
        assert!(!is_text_like("application/pdf"));
        assert!(!is_text_like("image/png"));
        assert_eq!(format_size(999), "999 B");
        assert_eq!(format_size(12_345), "12.3 kB");
        assert_eq!(format_size(2_500_000), "2.5 MB");
    }
}
