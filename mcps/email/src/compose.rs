//! Outgoing mail: a message built from the model's arguments, a reply, a
//! forward, or a draft, as bytes and an envelope.
//!
//! The `From` field is the account's display name and address. A message
//! gets a `Message-ID` of its own, made from the time, the process, and a
//! sequence number, under the address's domain, so a saved draft can be
//! found again by it.

use std::fmt::Write;
use std::str::FromStr;
use std::time::{SystemTime, UNIX_EPOCH};

use lettre::address::Envelope;
use lettre::message::header::ContentType;
use lettre::message::{Attachment, Mailbox, Message, MessageBuilder, MultiPart, SinglePart};

use crate::account::Account;
use crate::message::{MessageView, ParsedMailbox};

/// The prefix a reply's subject gets, unless it has one.
const REPLY_PREFIX: &str = "Re: ";

/// The prefix a forward's subject gets, unless it has one.
const FORWARD_PREFIX: &str = "Fwd: ";

/// Prefixes that mean a subject is already a reply's, in lower case.
const REPLY_PREFIXES: [&str; 3] = ["re:", "aw:", "antw:"];

/// Prefixes that mean a subject is already a forward's, in lower case.
const FORWARD_PREFIXES: [&str; 3] = ["fwd:", "fw:", "wg:"];

/// An attachment of an outgoing message.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OutgoingAttachment {
    /// Its file name.
    pub name: String,
    /// Its content type as `type/subtype`.
    pub content_type: String,
    /// Its content.
    pub bytes: Vec<u8>,
}

/// What an outgoing message is made of.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Composition {
    /// The `To` recipients, as `Name <address>` or `address`.
    pub to: Vec<String>,
    /// The `Cc` recipients.
    pub cc: Vec<String>,
    /// The `Bcc` recipients.
    pub bcc: Vec<String>,
    /// The subject.
    pub subject: String,
    /// The text body.
    pub body: String,
    /// The identifier of the message replied to.
    pub in_reply_to: Option<String>,
    /// The identifiers of the conversation, oldest first.
    pub references: Vec<String>,
    /// The attachments.
    pub attachments: Vec<OutgoingAttachment>,
}

/// An outgoing message, ready to send and to store.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ComposedMessage {
    /// The message (RFC 5322); with its `Bcc` field only when asked.
    pub bytes: Vec<u8>,
    /// The sender and every recipient, `Bcc` ones included.
    pub envelope: Envelope,
    /// The message's identifier, without angle brackets; empty for a
    /// stored draft that has no `Message-ID` field.
    pub message_id: String,
}

/// Why a composition could not become a message.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CompositionProblem {
    /// No `To`, `Cc`, or `Bcc` recipient was given.
    NoRecipient,
    /// A recipient is not an email address; the text is the one given.
    InvalidRecipient(String),
    /// The account's own address is not one lettre accepts.
    InvalidSender,
    /// An attachment's content type is not one lettre accepts.
    InvalidAttachmentType(String),
    /// lettre refused the message, with its reason.
    Build(String),
}

impl CompositionProblem {
    /// Returns the problem as the sentence the model reads.
    pub fn format_sentence(&self) -> String {
        match self {
            Self::NoRecipient => "Give at least one recipient in to, cc, or bcc.".to_owned(),
            Self::InvalidRecipient(text) => format!(
                "{text} is not an email address. Give addresses as name@example.com or Name <name@example.com>."
            ),
            Self::InvalidSender => {
                "The account's address cannot be used as a sender. Check it in Settings → MCP."
                    .to_owned()
            }
            Self::InvalidAttachmentType(content_type) => {
                format!("The attachment type {content_type} cannot be attached.")
            }
            Self::Build(reason) => format!("The message could not be built: {reason}."),
        }
    }
}

/// When, and as which within the process, a message is built: the parts
/// of its `Date` field and of its identifier.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MessageStamp {
    /// The time for the `Date` field and the identifier.
    pub now: SystemTime,
    /// A number unique within the process at `now`, for the identifier.
    pub sequence: u64,
}

/// Builds a message to send from a composition: its bytes leave out the
/// `Bcc` field, which only the envelope keeps.
///
/// # Arguments
///
/// * `account` - The sender.
/// * `composition` - What the message is made of.
/// * `stamp` - When the message is built.
///
/// # Returns
///
/// The message, or why it could not be built.
pub fn build_sent_message(
    account: &Account,
    composition: &Composition,
    stamp: MessageStamp,
) -> Result<ComposedMessage, CompositionProblem> {
    let (builder, message_id) = build_message_header(account, composition, stamp)?;
    build_message_body(builder, composition, message_id)
}

/// Builds a draft from a composition: its bytes keep the `Bcc` field, so
/// the stored draft still names every recipient.
///
/// # Arguments
///
/// * `account` - The sender.
/// * `composition` - What the message is made of.
/// * `stamp` - When the message is built.
///
/// # Returns
///
/// The draft, or why it could not be built.
pub fn build_draft_message(
    account: &Account,
    composition: &Composition,
    stamp: MessageStamp,
) -> Result<ComposedMessage, CompositionProblem> {
    let (builder, message_id) = build_message_header(account, composition, stamp)?;
    build_message_body(builder.keep_bcc(), composition, message_id)
}

/// Builds the header fields of a message: sender, recipients, subject,
/// date, identifier, and the conversation fields.
///
/// # Returns
///
/// The builder with the header fields and the message's identifier, or
/// why a field could not be built.
fn build_message_header(
    account: &Account,
    composition: &Composition,
    stamp: MessageStamp,
) -> Result<(MessageBuilder, String), CompositionProblem> {
    if composition.to.is_empty() && composition.cc.is_empty() && composition.bcc.is_empty() {
        return Err(CompositionProblem::NoRecipient);
    }
    let sender = build_sender(account)?;
    let message_id = create_message_id(&account.address, stamp);
    let mut builder = Message::builder()
        .from(sender)
        .subject(composition.subject.clone())
        .date(stamp.now)
        .message_id(Some(format!("<{message_id}>")));
    for recipient in &composition.to {
        builder = builder.to(parse_recipient(recipient)?);
    }
    for recipient in &composition.cc {
        builder = builder.cc(parse_recipient(recipient)?);
    }
    for recipient in &composition.bcc {
        builder = builder.bcc(parse_recipient(recipient)?);
    }
    if let Some(in_reply_to) = &composition.in_reply_to {
        builder = builder.in_reply_to(format!("<{in_reply_to}>"));
    }
    if !composition.references.is_empty() {
        let references: Vec<String> = composition
            .references
            .iter()
            .map(|reference| format!("<{reference}>"))
            .collect();
        builder = builder.references(references.join(" "));
    }
    Ok((builder, message_id))
}

/// Adds the text and the attachments to a message's header fields.
///
/// # Arguments
///
/// * `builder` - The header fields.
/// * `composition` - The text and the attachments.
/// * `message_id` - The message's identifier, without angle brackets.
///
/// # Returns
///
/// The message, or why it could not be built: `InvalidAttachmentType`
/// for an attachment whose content type lettre does not accept, or
/// `Build` with lettre's reason when lettre refuses the message.
fn build_message_body(
    builder: MessageBuilder,
    composition: &Composition,
    message_id: String,
) -> Result<ComposedMessage, CompositionProblem> {
    let message = if composition.attachments.is_empty() {
        builder
            .header(ContentType::TEXT_PLAIN)
            .body(composition.body.clone())
    } else {
        let mut parts = MultiPart::mixed().singlepart(SinglePart::plain(composition.body.clone()));
        for attachment in &composition.attachments {
            let content_type = ContentType::parse(&attachment.content_type).map_err(|_| {
                CompositionProblem::InvalidAttachmentType(attachment.content_type.clone())
            })?;
            parts = parts.singlepart(
                Attachment::new(attachment.name.clone())
                    .body(attachment.bytes.clone(), content_type),
            );
        }
        builder.multipart(parts)
    }
    .map_err(|error| CompositionProblem::Build(error.to_string()))?;
    Ok(ComposedMessage {
        bytes: message.formatted(),
        envelope: message.envelope().clone(),
        message_id,
    })
}

/// Builds the `From` mailbox of the account, with its display name when
/// it has one.
///
/// # Arguments
///
/// * `account` - The sender.
///
/// # Returns
///
/// The mailbox, or `InvalidSender` when lettre does not accept the
/// account's address.
fn build_sender(account: &Account) -> Result<Mailbox, CompositionProblem> {
    let address = lettre::Address::from_str(&account.address)
        .map_err(|_| CompositionProblem::InvalidSender)?;
    let name = (!account.display_name.is_empty()).then(|| account.display_name.clone());
    Ok(Mailbox::new(name, address))
}

/// Parses a recipient the model gave.
///
/// # Arguments
///
/// * `text` - The recipient, as `name@example.com` or
///   `Name <name@example.com>`.
///
/// # Returns
///
/// The mailbox, or `InvalidRecipient` with the text as given when lettre
/// does not read it as a mailbox.
pub(crate) fn parse_recipient(text: &str) -> Result<Mailbox, CompositionProblem> {
    Mailbox::from_str(text.trim())
        .map_err(|_| CompositionProblem::InvalidRecipient(text.to_owned()))
}

/// Builds the recipient text of a fetched message's mailbox, which the
/// model can give back: `Name <address>` as lettre writes it, with the
/// name quoted when it needs to be, or the address alone when there is no
/// name or the name does not survive that form.
///
/// # Arguments
///
/// * `mailbox` - The mailbox, as parsed.
///
/// # Returns
///
/// The recipient, which [`parse_recipient`] reads back to the same
/// address, or `None` when the mailbox has no address lettre accepts.
pub(crate) fn build_recipient(mailbox: &ParsedMailbox) -> Option<String> {
    let address = lettre::Address::from_str(mailbox.address.as_deref()?).ok()?;
    mailbox
        .name
        .as_deref()
        .map(str::trim)
        .filter(|name| !name.is_empty() && !name.chars().any(char::is_control))
        .and_then(|name| {
            build_readable_mailbox(Mailbox::new(Some(name.to_owned()), address.clone()))
        })
        .or_else(|| build_readable_mailbox(Mailbox::new(None, address)))
}

/// Builds a mailbox's text as lettre writes it, when lettre reads that
/// text back to the same mailbox.
fn build_readable_mailbox(mailbox: Mailbox) -> Option<String> {
    let mut text = String::new();
    write!(text, "{mailbox}").ok()?;
    let read_back = Mailbox::from_str(&text).ok()?;
    (read_back == mailbox).then_some(text)
}

/// Creates a message identifier under the address's domain.
///
/// # Arguments
///
/// * `address` - The sender's address, whose domain the identifier is
///   under.
/// * `stamp` - When, and as which within the process, the message is
///   built.
///
/// # Returns
///
/// The identifier without angle brackets, such as
/// `lys-1793611800.123456789-4242-7@example.com`.
fn create_message_id(address: &str, stamp: MessageStamp) -> String {
    let domain = address
        .rsplit_once('@')
        .map_or("localhost", |(_, domain)| domain);
    let since_epoch = stamp.now.duration_since(UNIX_EPOCH).unwrap_or_default();
    format!(
        "lys-{}.{:09}-{}-{}@{domain}",
        since_epoch.as_secs(),
        since_epoch.subsec_nanos(),
        std::process::id(),
        stamp.sequence
    )
}

/// Builds the subject of a reply: the original's with `Re: ` in front,
/// unless it already is a reply's.
///
/// # Arguments
///
/// * `subject` - The original's subject.
pub fn build_reply_subject(subject: &str) -> String {
    build_prefixed_subject(subject, REPLY_PREFIX, &REPLY_PREFIXES)
}

/// Builds the subject of a forward: the original's with `Fwd: ` in front,
/// unless it already is a forward's.
///
/// # Arguments
///
/// * `subject` - The original's subject.
pub fn build_forward_subject(subject: &str) -> String {
    build_prefixed_subject(subject, FORWARD_PREFIX, &FORWARD_PREFIXES)
}

/// Prefixes a subject unless it starts with one of the known prefixes.
fn build_prefixed_subject(subject: &str, prefix: &str, known: &[&str]) -> String {
    let trimmed = subject.trim();
    let lowercase = trimmed.to_lowercase();
    if known.iter().any(|known| lowercase.starts_with(known)) {
        return trimmed.to_owned();
    }
    format!("{prefix}{trimmed}")
}

/// Builds the conversation fields of a reply to a message.
///
/// # Arguments
///
/// * `original` - The message replied to.
///
/// # Returns
///
/// The identifier for `In-Reply-To`, when the original has one, and the
/// identifiers for `References`: the original's references, then its
/// identifier.
pub fn build_reply_references(original: &MessageView) -> (Option<String>, Vec<String>) {
    let mut references = original.headers.references.clone();
    if let Some(message_id) = &original.headers.message_id
        && !references.contains(message_id)
    {
        references.push(message_id.clone());
    }
    (original.headers.message_id.clone(), references)
}

/// Builds the body of a forward: the new text, then the original's header
/// fields and text as a quoted block.
///
/// # Arguments
///
/// * `body` - The text written for the forward.
/// * `original` - The message forwarded.
pub fn build_forward_body(body: &str, original: &MessageView) -> String {
    let headers = &original.headers;
    let mut text = String::new();
    text.push_str(body.trim_end());
    text.push_str("\n\n---------- Forwarded message ----------\n");
    text.push_str(&format!("From: {}\n", headers.from));
    text.push_str(&format!(
        "Date: {}\n",
        headers.date.as_deref().unwrap_or("unknown")
    ));
    text.push_str(&format!("Subject: {}\n", headers.subject));
    text.push_str(&format!("To: {}\n", headers.to));
    if !headers.cc.is_empty() {
        text.push_str(&format!("Cc: {}\n", headers.cc));
    }
    text.push('\n');
    text.push_str(original.text.trim_end());
    text.push('\n');
    text
}

/// Builds the attachments of a forward: the original's, as they are.
///
/// # Arguments
///
/// * `original` - The message forwarded.
pub fn build_forward_attachments(original: &MessageView) -> Vec<OutgoingAttachment> {
    original
        .attachments
        .iter()
        .map(|attachment| OutgoingAttachment {
            name: attachment.name.clone(),
            content_type: attachment.content_type.clone(),
            bytes: attachment.bytes.clone(),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::*;
    use crate::account::parse_account_variable;
    use crate::message::parse_message;

    /// The account every test composes from.
    fn build_account() -> Account {
        build_account_with_address("person@example.com")
    }

    /// The account of [`build_account`] with another address, which the
    /// account rules accept.
    ///
    /// # Arguments
    ///
    /// * `address` - The account's address.
    ///
    /// # Panics
    ///
    /// When the account rules refuse the address.
    fn build_account_with_address(address: &str) -> Account {
        parse_account_variable(&format!(
            "{{\"address\":\"{address}\",\"displayName\":\"A Person\",\"userName\":\"person@example.com\",\"password\":\"correct horse\",\"imap\":{{\"host\":\"imap.example.com\",\"port\":993,\"security\":\"tls\"}},\"smtp\":{{\"host\":\"smtp.example.com\",\"port\":587,\"security\":\"starttls\"}},\"serverKeepsSentCopy\":false}}",
        ))
        .expect("account")
    }

    /// A fixed time for the `Date` field, as the message with the number.
    fn build_stamp(sequence: u64) -> MessageStamp {
        MessageStamp {
            now: UNIX_EPOCH + Duration::from_secs(1_793_611_800),
            sequence,
        }
    }

    /// A reply with every recipient field, a subject that is not ASCII, and
    /// a body of two paragraphs.
    fn build_plain_composition() -> Composition {
        Composition {
            to: vec!["Jane Doe <jane@example.com>".to_owned()],
            cc: vec!["cc@example.com".to_owned()],
            bcc: vec!["hidden@example.com".to_owned()],
            subject: "Grüße".to_owned(),
            body: "Hello Jane,\n\nBye.\n".to_owned(),
            in_reply_to: Some("one@example.com".to_owned()),
            references: vec!["zero@example.com".to_owned(), "one@example.com".to_owned()],
            attachments: Vec::new(),
        }
    }

    /// Checks that a composed message carries its sender, To, Cc, and reply
    /// headers with no trace of Bcc. Its `Message-ID` holds the stamp's
    /// time and count and the account's domain, and its non-ASCII subject
    /// and its body parse back.
    #[test]
    fn composes_a_plain_message_with_every_field_but_bcc() {
        let composition = build_plain_composition();

        let sent =
            build_sent_message(&build_account(), &composition, build_stamp(7)).expect("message");

        let text = String::from_utf8(sent.bytes.clone()).expect("utf-8");
        assert!(
            text.contains("From: \"A Person\" <person@example.com>\r\n"),
            "{text}"
        );
        assert!(
            text.contains("To: \"Jane Doe\" <jane@example.com>\r\n"),
            "{text}"
        );
        assert!(text.contains("Cc: cc@example.com\r\n"), "{text}");
        assert!(!text.contains("hidden@example.com"), "{text}");
        assert!(
            text.contains("In-Reply-To: <one@example.com>\r\n"),
            "{text}"
        );
        assert!(
            text.contains("References: <zero@example.com> <one@example.com>\r\n"),
            "{text}"
        );
        assert!(
            text.contains(&format!("Message-ID: <{}>\r\n", sent.message_id)),
            "{text}"
        );
        let message_id = &sent.message_id;
        assert!(
            message_id.starts_with("lys-1793611800.000000000-"),
            "{message_id}"
        );
        assert!(message_id.ends_with("-7@example.com"), "{message_id}");
        let parsed = parse_message(&sent.bytes).expect("parsed");
        assert_eq!(parsed.headers.subject, "Grüße");
        assert_eq!(parsed.text, "Hello Jane,\r\n\r\nBye.\r\n");
    }

    /// Checks that a sent message's envelope goes from the account's
    /// address to every To, Cc, and Bcc recipient, and that a draft of the
    /// same composition keeps its `Bcc` header.
    #[test]
    fn sends_to_every_recipient_and_keeps_bcc_only_in_a_draft() {
        let composition = build_plain_composition();

        let sent =
            build_sent_message(&build_account(), &composition, build_stamp(7)).expect("message");
        let draft =
            build_draft_message(&build_account(), &composition, build_stamp(8)).expect("draft");

        let recipients: Vec<String> = sent.envelope.to().iter().map(ToString::to_string).collect();
        assert_eq!(
            recipients,
            vec!["jane@example.com", "cc@example.com", "hidden@example.com"]
        );
        assert_eq!(
            sent.envelope.from().map(ToString::to_string),
            Some("person@example.com".to_owned())
        );
        let draft_text = String::from_utf8(draft.bytes).expect("utf-8");
        assert!(
            draft_text.contains("Bcc: hidden@example.com\r\n"),
            "{draft_text}"
        );
    }

    /// Checks that a message with a CSV and a PDF attachment parses back to
    /// its body, both names, the CSV's text, and the PDF's bytes.
    #[test]
    fn composes_a_message_with_attachments_that_parses_back() {
        let composition = Composition {
            to: vec!["jane@example.com".to_owned()],
            subject: "Report".to_owned(),
            body: "See attached.".to_owned(),
            attachments: vec![
                OutgoingAttachment {
                    name: "data.csv".to_owned(),
                    content_type: "text/csv".to_owned(),
                    bytes: b"a,b\r\n1,2\r\n".to_vec(),
                },
                OutgoingAttachment {
                    name: "report.pdf".to_owned(),
                    content_type: "application/pdf".to_owned(),
                    bytes: b"%PDF-".to_vec(),
                },
            ],
            ..Composition::default()
        };

        let composed =
            build_sent_message(&build_account(), &composition, build_stamp(1)).expect("message");

        let parsed = parse_message(&composed.bytes).expect("parsed");
        assert_eq!(parsed.text.trim_end(), "See attached.");
        assert_eq!(parsed.attachments.len(), 2);
        assert_eq!(parsed.attachments[0].name, "data.csv");
        assert_eq!(
            parsed.attachments[0].text.as_deref(),
            Some("a,b\r\n1,2\r\n")
        );
        assert_eq!(parsed.attachments[1].name, "report.pdf");
        assert_eq!(parsed.attachments[1].bytes, b"%PDF-");
    }

    /// Checks that a composition without a recipient gives `NoRecipient`, a
    /// recipient that is not an address `InvalidRecipient`, and a draft
    /// attachment whose type does not parse `InvalidAttachmentType`.
    #[test]
    fn refuses_a_message_without_recipient_or_with_a_bad_one() {
        let account = build_account();
        let empty = Composition {
            subject: "Hi".to_owned(),
            ..Composition::default()
        };
        let bad = Composition {
            to: vec!["not an address".to_owned()],
            ..Composition::default()
        };
        let bad_type = Composition {
            to: vec!["jane@example.com".to_owned()],
            attachments: vec![OutgoingAttachment {
                name: "x".to_owned(),
                content_type: "not a type".to_owned(),
                bytes: Vec::new(),
            }],
            ..Composition::default()
        };

        assert_eq!(
            build_sent_message(&account, &empty, build_stamp(1)),
            Err(CompositionProblem::NoRecipient)
        );
        assert_eq!(
            build_sent_message(&account, &bad, build_stamp(1)),
            Err(CompositionProblem::InvalidRecipient(
                "not an address".to_owned()
            ))
        );
        assert_eq!(
            build_draft_message(&account, &bad_type, build_stamp(1)),
            Err(CompositionProblem::InvalidAttachmentType(
                "not a type".to_owned()
            ))
        );
    }

    /// Checks that an account address that lettre refuses,
    /// `john..doe@example.com`, gives `InvalidSender` for a sent message
    /// and for a draft.
    #[test]
    fn refuses_an_account_address_that_lettre_cannot_send_from() {
        let account = build_account_with_address("john..doe@example.com");
        let composition = build_plain_composition();

        assert_eq!(
            build_sent_message(&account, &composition, build_stamp(1)),
            Err(CompositionProblem::InvalidSender)
        );
        assert_eq!(
            build_draft_message(&account, &composition, build_stamp(1)),
            Err(CompositionProblem::InvalidSender)
        );
    }

    /// Checks that each `CompositionProblem` reads as the sentence the
    /// model gets.
    #[test]
    fn describes_every_composition_problem_as_the_model_reads_it() {
        let sentences = [
            (
                CompositionProblem::NoRecipient,
                "Give at least one recipient in to, cc, or bcc.",
            ),
            (
                CompositionProblem::InvalidRecipient("nobody".to_owned()),
                "nobody is not an email address. Give addresses as name@example.com or Name <name@example.com>.",
            ),
            (
                CompositionProblem::InvalidSender,
                "The account's address cannot be used as a sender. Check it in Settings → MCP.",
            ),
            (
                CompositionProblem::InvalidAttachmentType("not a type".to_owned()),
                "The attachment type not a type cannot be attached.",
            ),
            (
                CompositionProblem::Build("missing To".to_owned()),
                "The message could not be built: missing To.",
            ),
        ];

        for (problem, sentence) in sentences {
            assert_eq!(problem.format_sentence(), sentence, "{problem:?}");
        }
    }

    /// Checks that a recipient built from a mailbox's name and address,
    /// quoted and escaped where needed, parses back to the same address. A
    /// blank name, or one with a control character, is left out, and a
    /// mailbox without a usable address gives none.
    #[test]
    fn builds_recipients_that_read_back_to_the_same_mailbox() {
        let cases = [
            (
                Some("Jane Doe"),
                "jane@example.com",
                "Jane Doe <jane@example.com>",
            ),
            (
                Some("Doe, Jane"),
                "jane@example.com",
                "\"Doe, Jane\" <jane@example.com>",
            ),
            (
                Some("O'Brien \"Bob\""),
                "bob@example.com",
                "\"O'Brien \\\"Bob\\\"\" <bob@example.com>",
            ),
            (
                Some("Jürgen Müller"),
                "juergen@example.com",
                "Jürgen Müller <juergen@example.com>",
            ),
            (
                Some("😀 Fan"),
                "fan@example.com",
                "😀 Fan <fan@example.com>",
            ),
            (Some("  "), "a@example.com", "a@example.com"),
            (None, "a@example.com", "a@example.com"),
            (Some("Line\r\nBreak"), "a@example.com", "a@example.com"),
            (Some("Bell\u{7}"), "a@example.com", "a@example.com"),
        ];

        for (name, address, expected) in cases {
            let recipient = build_recipient(&ParsedMailbox {
                name: name.map(str::to_owned),
                address: Some(address.to_owned()),
            });

            assert_eq!(recipient.as_deref(), Some(expected), "{name:?}");
            let parsed = parse_recipient(expected).expect("reads back");
            assert_eq!(parsed.email.to_string(), address);
        }
        for address in [Some("nobody"), None] {
            let mailbox = ParsedMailbox {
                name: Some("Nobody".to_owned()),
                address: address.map(str::to_owned),
            };
            assert_eq!(build_recipient(&mailbox), None, "{address:?}");
        }
    }

    /// Checks that a reply's subject gains `Re:` and a forward's `Fwd:`
    /// unless one is there, that a reply refers to the original after its
    /// references, and that a forward quotes the original's headers and
    /// text below the note, with no attachment for a message that has none.
    #[test]
    fn builds_reply_and_forward_subjects_references_and_bodies() {
        assert_eq!(build_reply_subject("Hello"), "Re: Hello");
        assert_eq!(build_reply_subject("RE: Hello"), "RE: Hello");
        assert_eq!(build_reply_subject("AW: Hello "), "AW: Hello");
        assert_eq!(build_forward_subject("Hello"), "Fwd: Hello");
        assert_eq!(build_forward_subject("Fw: Hello"), "Fw: Hello");
        let original = parse_message(b"From: Jane <jane@example.com>\r\nTo: person@example.com\r\nDate: Sun, 2 Nov 2026 10:30:00 +0000\r\nSubject: Hello\r\nMessage-ID: <one@example.com>\r\nReferences: <zero@example.com>\r\n\r\nOriginal text.\r\n").expect("original");

        let (in_reply_to, references) = build_reply_references(&original);
        let body = build_forward_body("Please read.\n", &original);

        assert_eq!(in_reply_to.as_deref(), Some("one@example.com"));
        assert_eq!(references, vec!["zero@example.com", "one@example.com"]);
        assert_eq!(
            body,
            "Please read.\n\n---------- Forwarded message ----------\nFrom: Jane <jane@example.com>\nDate: 2026-11-02T10:30:00Z\nSubject: Hello\nTo: person@example.com\n\nOriginal text.\n"
        );
        assert!(build_forward_attachments(&original).is_empty());
    }
}
