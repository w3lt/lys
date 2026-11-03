//! `search_emails`, `read_email`, `read_conversation`, and
//! `read_attachment` against the fake IMAP server.

mod support;

use email::failure::ToolFailure;
use email::tools::read::{
    AttachmentArguments, IdArguments, run_read_attachment, run_read_conversation, run_read_email,
};
use email::tools::search::{SearchArguments, run_search_emails};

use support::imap::{FakeMailbox, NewMessage};
use support::{Stack, TestMessage, start_stack};

/// The time the first message was sent.
const BASE: i64 = 1_793_611_800;

/// A message with an HTML body, a text attachment, and a binary one.
const MIXED: &str = "From: Jane Doe <jane@example.com>\r\nTo: person@example.com\r\nDate: Mon, 2 Nov 2026 12:00:00 +0000\r\nSubject: Report\r\nMessage-ID: <report@example.com>\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=\"b\"\r\n\r\n--b\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<html><body><p>Hello <b>there</b>.</p></body></html>\r\n--b\r\nContent-Type: text/csv; name=\"data.csv\"\r\nContent-Disposition: attachment; filename=\"data.csv\"\r\n\r\na,b\r\n1,2\r\n--b\r\nContent-Type: application/pdf\r\nContent-Disposition: attachment; filename=\"report.pdf\"\r\nContent-Transfer-Encoding: base64\r\n\r\nJVBERi0=\r\n--b--\r\n";

/// Starts the stack with 25 messages in INBOX, two in Projects, one in
/// Sent, and one in the All Mail view.
async fn start_filled_stack() -> Stack {
    let mut mailbox = FakeMailbox::create_standard();
    for number in 1..=25 {
        let message = TestMessage {
            subject: format!("Message {number}"),
            body: format!("Body of message {number}"),
            message_id: format!("m{number}@example.com"),
            timestamp: BASE + number * 3_600,
            ..TestMessage::default()
        };
        let flags: &[&str] = match number {
            3 => &["\\Seen"],
            5 => &["\\Flagged"],
            _ => &[],
        };
        mailbox.add_message("INBOX", message.build_new_message(flags));
    }
    for (number, subject) in [(1, "Project plan"), (2, "Project update")] {
        let message = TestMessage {
            subject: subject.to_owned(),
            body: "About the project.".to_owned(),
            message_id: format!("p{number}@example.com"),
            timestamp: BASE + 100 * 3_600 + number,
            ..TestMessage::default()
        };
        mailbox.add_message("Projects", message.build_new_message(&[]));
    }
    let sent = TestMessage {
        subject: "Sent one".to_owned(),
        body: "I wrote this.".to_owned(),
        message_id: "s1@example.com".to_owned(),
        timestamp: BASE + 50 * 3_600,
        ..TestMessage::default()
    };
    mailbox.add_message("Sent", sent.build_new_message(&["\\Seen"]));
    let everything = TestMessage {
        subject: "Everything".to_owned(),
        body: "In the view.".to_owned(),
        message_id: "all@example.com".to_owned(),
        timestamp: BASE,
        ..TestMessage::default()
    };
    mailbox.add_message("All Mail", everything.build_new_message(&[]));
    start_stack(mailbox, false).await
}

/// Counts the hits a search result lists.
fn calculate_hit_count(text: &str) -> usize {
    text.lines().filter(|line| line.starts_with("id ")).count()
}

/// Builds message `number` of a conversation, from 0: sent `number`
/// minutes after the first, with the Message-ID `<name><number>@example.com`
/// in two digits, and a reply to the one before it that also references
/// the first.
///
/// # Arguments
///
/// * `name` - What every Message-ID of the conversation starts with.
/// * `number` - Its place in the conversation.
/// * `body` - Its text.
fn build_thread_message(name: &str, number: i64, body: &str) -> TestMessage {
    let mut message = TestMessage {
        subject: "Re: Plan".to_owned(),
        body: body.to_owned(),
        message_id: format!("{name}{number:02}@example.com"),
        timestamp: BASE + number * 60,
        ..TestMessage::default()
    };
    if number > 0 {
        message.in_reply_to = format!("{name}{:02}@example.com", number - 1);
        message.references = format!("<{name}00@example.com>");
    }
    message
}

/// Reads the conversation of a message.
///
/// # Arguments
///
/// * `stack` - The running fakes and the tools' context.
/// * `id` - The message's id.
async fn read_conversation_text(stack: &Stack, id: &str) -> String {
    run_read_conversation(&stack.context, IdArguments { id: id.to_owned() })
        .await
        .expect("the conversation")
        .text
}

/// Lists the ids of a conversation's entries, in the order shown.
fn list_entry_ids(text: &str) -> Vec<&str> {
    text.split("\n\n----\nid ")
        .skip(1)
        .map(|entry| entry.split_once('\n').map_or(entry, |(id, _)| id))
        .collect()
}

#[tokio::test(flavor = "multi_thread")]
async fn searches_one_folder_in_pages_newest_first_without_marking_anything() {
    let stack = start_filled_stack().await;
    let in_inbox = |page: Option<u32>| SearchArguments {
        folder: Some("INBOX".to_owned()),
        page,
        ..SearchArguments::default()
    };

    let first = run_search_emails(&stack.context, in_inbox(None))
        .await
        .expect("page 1");
    let second = run_search_emails(&stack.context, in_inbox(Some(2)))
        .await
        .expect("page 2");
    let third = run_search_emails(&stack.context, in_inbox(Some(3))).await;

    assert!(
        first
            .text
            .starts_with("Page 1 of 2: 25 messages match, newest first. Ask for page 2 to see the next ones.\n\nid 25.1001.INBOX\n"),
        "{}",
        first.text
    );
    assert_eq!(calculate_hit_count(&first.text), 20);
    assert!(
        first.text.contains(
            "\nfrom Jane Doe <jane@example.com>\nsubject Message 25\nflags unread\nfolder INBOX"
        ),
        "{}",
        first.text
    );
    assert!(first.text.contains("subject Message 6\n"), "{}", first.text);
    assert!(
        !first.text.contains("subject Message 5\n"),
        "{}",
        first.text
    );
    assert_eq!(first.log, "search: 1 folder(s), 25 hit(s), page 1 of 2");
    assert!(
        second
            .text
            .starts_with("Page 2 of 2: 25 messages match, newest first.\n\nid 5.1001.INBOX\n"),
        "{}",
        second.text
    );
    assert_eq!(calculate_hit_count(&second.text), 5);
    assert!(
        second.text.contains("\nflags unread, flagged\n"),
        "{}",
        second.text
    );
    assert!(second.text.contains("\nflags read\n"), "{}", second.text);
    assert_eq!(
        third,
        Err(ToolFailure::Argument(
            "Only 2 pages match. Ask for a page from 1 to 2.".to_owned()
        ))
    );
    let commands = stack.imap.list_commands();
    assert!(
        commands
            .iter()
            .any(|command| command.ends_with("EXAMINE \"INBOX\"")),
        "{commands:?}"
    );
    assert!(
        commands
            .iter()
            .any(|command| command.ends_with("UID SEARCH ALL")),
        "{commands:?}"
    );
    assert!(
        commands.iter().any(|command| command.contains("UID FETCH ") && command.contains("BODY.PEEK[HEADER.FIELDS (DATE FROM TO CC SUBJECT MESSAGE-ID IN-REPLY-TO REFERENCES)]")),
        "{commands:?}"
    );
    assert!(
        !commands
            .iter()
            .any(|command| command.contains("STORE") || command.contains(" SELECT ")),
        "{commands:?}"
    );
    assert!(
        commands
            .iter()
            .filter(|command| command.ends_with(" LOGOUT"))
            .count()
            >= 3,
        "{commands:?}"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn searches_every_folder_but_the_all_view_and_folders_that_hold_nothing() {
    let stack = start_filled_stack().await;

    let projects = run_search_emails(
        &stack.context,
        SearchArguments {
            text: Some("project".to_owned()),
            ..SearchArguments::default()
        },
    )
    .await
    .expect("project hits");
    let everything = run_search_emails(&stack.context, SearchArguments::default())
        .await
        .expect("all hits");

    assert!(
        projects
            .text
            .starts_with("Page 1 of 1: 2 messages match, newest first.\n\nid 2.1006.Projects\n"),
        "{}",
        projects.text
    );
    assert_eq!(calculate_hit_count(&projects.text), 2);
    assert!(
        everything
            .text
            .starts_with("Page 1 of 2: 28 messages match, newest first."),
        "{}",
        everything.text
    );
    assert!(
        everything.text.contains("folder Projects"),
        "{}",
        everything.text
    );
    assert!(
        everything.text.contains("folder Sent"),
        "{}",
        everything.text
    );
    assert!(!everything.text.contains("All Mail"), "{}", everything.text);
    let commands = stack.imap.list_commands();
    assert!(
        !commands
            .iter()
            .any(|command| command.contains("\"All Mail\"") || command.contains("\"[Gmail]\"")),
        "{commands:?}"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn narrows_a_search_by_flags_fields_dates_and_text_that_is_not_ascii() {
    let stack = start_filled_stack().await;
    let greeting = TestMessage {
        subject: "Grüße aus Wien".to_owned(),
        body: "Servus".to_owned(),
        message_id: "g@example.com".to_owned(),
        timestamp: BASE + 200 * 3_600,
        ..TestMessage::default()
    };
    stack.imap.update_state(|state| {
        state.add_message("INBOX", greeting.build_new_message(&[]));
    });
    let search = |arguments: SearchArguments| {
        run_search_emails(
            &stack.context,
            SearchArguments {
                folder: Some("INBOX".to_owned()),
                ..arguments
            },
        )
    };

    let read = search(SearchArguments {
        unread: Some(false),
        ..SearchArguments::default()
    })
    .await
    .expect("read");
    let flagged = search(SearchArguments {
        flagged: Some(true),
        ..SearchArguments::default()
    })
    .await
    .expect("flagged");
    let by_fields = search(SearchArguments {
        from: Some("jane".to_owned()),
        subject: Some("Message 1".to_owned()),
        ..SearchArguments::default()
    })
    .await
    .expect("by fields");
    let by_dates = search(SearchArguments {
        since: Some("2026-11-02".to_owned()),
        before: Some("2026-11-03".to_owned()),
        ..SearchArguments::default()
    })
    .await
    .expect("by dates");
    let non_ascii = search(SearchArguments {
        subject: Some("Grüße".to_owned()),
        ..SearchArguments::default()
    })
    .await
    .expect("non-ASCII");
    let none = search(SearchArguments {
        text: Some("nothing matches this".to_owned()),
        ..SearchArguments::default()
    })
    .await
    .expect("none");

    assert_eq!(calculate_hit_count(&read.text), 1);
    assert!(read.text.contains("subject Message 3\n"), "{}", read.text);
    assert_eq!(calculate_hit_count(&flagged.text), 1);
    assert!(
        flagged.text.contains("subject Message 5\n"),
        "{}",
        flagged.text
    );
    assert_eq!(calculate_hit_count(&by_fields.text), 11);
    assert!(
        by_dates.text.starts_with("Page 1 of 1: 14 messages match"),
        "{}",
        by_dates.text
    );
    assert_eq!(calculate_hit_count(&non_ascii.text), 1);
    assert!(
        non_ascii.text.contains("subject Grüße aus Wien\n"),
        "{}",
        non_ascii.text
    );
    assert_eq!(none.text, "No message matches.");
    let commands = stack.imap.list_commands();
    assert!(
        commands
            .iter()
            .any(|command| command.ends_with("UID SEARCH SEEN")),
        "{commands:?}"
    );
    assert!(
        commands
            .iter()
            .any(|command| command.ends_with("UID SEARCH FROM \"jane\" SUBJECT \"Message 1\"")),
        "{commands:?}"
    );
    assert!(
        commands
            .iter()
            .any(|command| command.ends_with("UID SEARCH SINCE 2-Nov-2026 BEFORE 3-Nov-2026")),
        "{commands:?}"
    );
    assert!(
        commands
            .iter()
            .any(|command| command.ends_with("UID SEARCH CHARSET UTF-8 SUBJECT \"Grüße\"")),
        "{commands:?}"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn reads_a_message_without_marking_it_as_read() {
    let stack = start_filled_stack().await;

    let report = run_read_email(
        &stack.context,
        IdArguments {
            id: "24.1001.INBOX".to_owned(),
        },
    )
    .await
    .expect("the message");

    assert_eq!(
        report.text,
        format!(
            "id 24.1001.INBOX\nFrom: Jane Doe <jane@example.com>\nTo: person@example.com\nDate: {}\nSubject: Message 24\nMessage-ID: <m24@example.com>\nFlags: unread\nFolder: INBOX\nAttachments: none\n\nBody of message 24",
            "2026-11-03T09:30:00Z"
        )
    );
    assert!(report.log.starts_with("read: "), "{}", report.log);
    let message = &stack.imap.list_messages("INBOX")[23];
    assert_eq!(message.uid, 24);
    assert!(message.flags.is_empty(), "{:?}", message.flags);
    let commands = stack.imap.list_commands();
    assert!(
        commands
            .iter()
            .any(|command| command.ends_with("UID FETCH 24 (UID FLAGS BODY.PEEK[])")),
        "{commands:?}"
    );
    assert!(
        !commands
            .iter()
            .any(|command| command.contains("STORE") || command.contains(" SELECT ")),
        "{commands:?}"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn converts_html_lists_attachments_and_reads_text_ones() {
    let stack = start_filled_stack().await;
    stack.imap.update_state(|state| {
        state.add_message(
            "Projects",
            NewMessage {
                bytes: MIXED.as_bytes().to_vec(),
                flags: &[],
                timestamp: BASE,
            },
        );
    });
    let id = "3.1006.Projects";

    let message = run_read_email(&stack.context, IdArguments { id: id.to_owned() })
        .await
        .expect("the message");
    let csv = run_read_attachment(
        &stack.context,
        AttachmentArguments {
            id: id.to_owned(),
            attachment: 1,
        },
    )
    .await
    .expect("the attachment");
    let pdf = run_read_attachment(
        &stack.context,
        AttachmentArguments {
            id: id.to_owned(),
            attachment: 2,
        },
    )
    .await;
    let missing = run_read_attachment(
        &stack.context,
        AttachmentArguments {
            id: id.to_owned(),
            attachment: 3,
        },
    )
    .await;

    assert!(message.text.contains("Attachments: 2\n  #1 data.csv (text/csv, 8 B)\n  #2 report.pdf (application/pdf, 5 B)\n[The text was converted from HTML.]\n\nHello there."), "{}", message.text);
    assert_eq!(
        csv.text,
        "Attachment #1 data.csv (text/csv, 8 B)\n\na,b\r\n1,2"
    );
    assert_eq!(
        pdf,
        Err(ToolFailure::AttachmentNotText {
            name: "report.pdf".to_owned(),
            content_type: "application/pdf".to_owned()
        })
    );
    assert_eq!(
        missing,
        Err(ToolFailure::AttachmentMissing {
            number: 3,
            count: 2
        })
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn reads_a_conversation_across_folders_oldest_first() {
    let mut mailbox = FakeMailbox::create_standard();
    let first = TestMessage {
        subject: "Plan".to_owned(),
        body: "Shall we?".to_owned(),
        message_id: "a@example.com".to_owned(),
        timestamp: BASE,
        ..TestMessage::default()
    };
    let mut reply = TestMessage {
        subject: "Re: Plan".to_owned(),
        body: "Yes.".to_owned(),
        message_id: "b@example.com".to_owned(),
        timestamp: BASE + 60,
        ..TestMessage::default()
    };
    reply.from = "A Person <person@example.com>".to_owned();
    reply.to = "Jane Doe <jane@example.com>".to_owned();
    reply.in_reply_to = "a@example.com".to_owned();
    reply.references = "<a@example.com>".to_owned();
    let mut last = TestMessage {
        subject: "Re: Plan".to_owned(),
        body: "Great.".to_owned(),
        message_id: "c@example.com".to_owned(),
        timestamp: BASE + 120,
        ..TestMessage::default()
    };
    last.in_reply_to = "b@example.com".to_owned();
    last.references = "<a@example.com> <b@example.com>".to_owned();
    let unrelated = TestMessage {
        subject: "Other".to_owned(),
        body: "Unrelated.".to_owned(),
        message_id: "d@example.com".to_owned(),
        timestamp: BASE + 30,
        ..TestMessage::default()
    };
    mailbox.add_message("INBOX", first.build_new_message(&["\\Seen"]));
    mailbox.add_message("INBOX", unrelated.build_new_message(&[]));
    mailbox.add_message("Sent", reply.build_new_message(&["\\Seen"]));
    mailbox.add_message("INBOX", last.build_new_message(&[]));
    let stack = start_stack(mailbox, false).await;

    let report = run_read_conversation(
        &stack.context,
        IdArguments {
            id: "3.1001.INBOX".to_owned(),
        },
    )
    .await
    .expect("the conversation");

    assert!(
        report.text.starts_with(
            "The conversation has 3 messages, oldest first.\n\n----\nid 1.1001.INBOX\n"
        ),
        "{}",
        report.text
    );
    let position = |needle: &str| {
        report
            .text
            .find(needle)
            .unwrap_or_else(|| panic!("{needle} in {}", report.text))
    };
    assert!(position("Message-ID: <a@example.com>") < position("Message-ID: <b@example.com>"));
    assert!(position("Message-ID: <b@example.com>") < position("Message-ID: <c@example.com>"));
    assert!(
        report.text.contains("\nid 1.1002.Sent\n"),
        "{}",
        report.text
    );
    assert!(
        report.text.contains("\nid 3.1001.INBOX\n"),
        "{}",
        report.text
    );
    assert!(!report.text.contains("d@example.com"), "{}", report.text);
    assert_eq!(report.log, "conversation: 3 message(s), 3 shown");
    let commands = stack.imap.list_commands();
    assert!(
        commands.iter().any(|command| command.contains("UID SEARCH OR HEADER MESSAGE-ID \"c@example.com\" OR HEADER IN-REPLY-TO \"c@example.com\" OR HEADER REFERENCES \"c@example.com\" OR HEADER MESSAGE-ID \"b@example.com\"")),
        "{commands:?}"
    );
    assert!(
        !commands.iter().any(|command| command.contains("STORE")),
        "{commands:?}"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn fits_the_newest_messages_of_a_long_conversation_and_says_how_many_are_left_out() {
    let mut mailbox = FakeMailbox::create_standard();
    let body = "x".repeat(3_500);
    for number in 0..12 {
        let message = build_thread_message("t", number, &body);
        mailbox.add_message("INBOX", message.build_new_message(&[]));
    }
    let stack = start_stack(mailbox, false).await;

    let text = read_conversation_text(&stack, "12.1001.INBOX").await;

    let ids = list_entry_ids(&text);
    let shown = ids.len();
    let newest: Vec<String> = (13 - shown..=12)
        .map(|uid| format!("{uid}.1001.INBOX"))
        .collect();
    assert_eq!(ids, newest, "{text}");
    assert!(shown >= 5, "{text}");
    assert!(
        text.starts_with(&format!(
            "The conversation has 12 messages, oldest first. Only the newest {shown} are shown; {} older ones are left out.\n\n----\n",
            12 - shown
        )),
        "{text}"
    );
    let length = text.encode_utf16().count();
    let shortest_entry = text
        .split("\n\n----\n")
        .skip(1)
        .map(|entry| entry.encode_utf16().count())
        .min()
        .expect("an entry");
    assert!(length <= 20_000, "{length}");
    assert!(
        length + shortest_entry > 20_000,
        "{length} + {shortest_entry}"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn shows_the_newest_message_even_when_it_alone_is_longer_than_the_result() {
    let mut mailbox = FakeMailbox::create_standard();
    let first = build_thread_message("t", 0, "Shall we?");
    let mut crowded = build_thread_message("t", 1, "Yes.");
    crowded.to = (1..=1_100)
        .map(|number| format!("person{number}@example.com"))
        .collect::<Vec<_>>()
        .join(", ");
    mailbox.add_message("INBOX", first.build_new_message(&[]));
    mailbox.add_message("INBOX", crowded.build_new_message(&[]));
    let stack = start_stack(mailbox, false).await;

    let text = read_conversation_text(&stack, "2.1001.INBOX").await;

    assert!(
        text.starts_with("The conversation has 2 messages, oldest first. Only the newest is shown; 1 older one is left out.\n\n----\nid 2.1001.INBOX\n"),
        "{}",
        &text[..300]
    );
    assert_eq!(list_entry_ids(&text), vec!["2.1001.INBOX"]);
    assert!(text.encode_utf16().count() > 20_000);
}

#[tokio::test(flavor = "multi_thread")]
async fn shows_at_most_the_newest_50_messages_of_a_conversation_across_folders() {
    let mut mailbox = FakeMailbox::create_standard();
    for number in 0..60 {
        let folder = if number % 2 == 0 { "INBOX" } else { "Sent" };
        let message = build_thread_message("t", number, "Short.");
        mailbox.add_message(folder, message.build_new_message(&[]));
    }
    let stack = start_stack(mailbox, false).await;

    let text = read_conversation_text(&stack, "30.1002.Sent").await;

    assert!(
        text.starts_with("The conversation has 60 messages, oldest first. Only the newest 50 are shown; 10 older ones are left out.\n\n----\nid 6.1001.INBOX\n"),
        "{text}"
    );
    let ids = list_entry_ids(&text);
    assert_eq!(ids.len(), 50, "{text}");
    assert_eq!(ids.last(), Some(&"30.1002.Sent"), "{text}");
}

#[tokio::test(flavor = "multi_thread")]
async fn says_when_a_folder_matched_more_messages_than_a_conversation_reads() {
    let mut mailbox = FakeMailbox::create_standard();
    for number in 0..55 {
        let message = build_thread_message("t", number, "Short.");
        mailbox.add_message("INBOX", message.build_new_message(&[]));
    }
    let stack = start_stack(mailbox, false).await;

    let text = read_conversation_text(&stack, "55.1001.INBOX").await;

    assert!(
        text.starts_with("The conversation has at least 50 messages, oldest first.\nMore than 50 messages match in INBOX; only the newest 50 of each were read, so older ones may be missing.\n\n----\nid 6.1001.INBOX\n"),
        "{text}"
    );
    assert_eq!(list_entry_ids(&text).len(), 50, "{text}");
}

#[tokio::test(flavor = "multi_thread")]
async fn keeps_only_messages_whose_identifiers_equal_the_conversation_ones() {
    let mut mailbox = FakeMailbox::create_standard();
    for (number, message_id) in [(0, "1@x.example"), (1, "11@x.example"), (2, "21@x.example")] {
        let message = TestMessage {
            subject: "Plan".to_owned(),
            body: "Text.".to_owned(),
            message_id: message_id.to_owned(),
            timestamp: BASE + number * 60,
            ..TestMessage::default()
        };
        mailbox.add_message("INBOX", message.build_new_message(&[]));
    }
    let reply = TestMessage {
        subject: "Re: Plan".to_owned(),
        body: "Yes.".to_owned(),
        message_id: "r@x.example".to_owned(),
        in_reply_to: "1@x.example".to_owned(),
        timestamp: BASE + 600,
        ..TestMessage::default()
    };
    mailbox.add_message("INBOX", reply.build_new_message(&[]));
    let stack = start_stack(mailbox, false).await;

    let text = read_conversation_text(&stack, "1.1001.INBOX").await;

    assert!(
        text.starts_with("The conversation has 2 messages, oldest first.\n\n----\n"),
        "{text}"
    );
    assert_eq!(list_entry_ids(&text), vec!["1.1001.INBOX", "4.1001.INBOX"]);
}

#[tokio::test(flavor = "multi_thread")]
async fn finds_a_conversation_message_archived_in_the_all_mail_view_once() {
    let mut mailbox = FakeMailbox::create_standard();
    let first = build_thread_message("t", 0, "Shall we?");
    let archived = build_thread_message("t", 1, "Yes.");
    mailbox.add_message("INBOX", first.build_new_message(&[]));
    mailbox.add_message("All Mail", first.build_new_message(&[]));
    mailbox.add_message("All Mail", archived.build_new_message(&["\\Seen"]));
    let stack = start_stack(mailbox, false).await;

    let text = read_conversation_text(&stack, "1.1001.INBOX").await;

    assert!(
        text.starts_with("The conversation has 2 messages, oldest first.\n\n----\n"),
        "{text}"
    );
    assert_eq!(
        list_entry_ids(&text),
        vec!["1.1001.INBOX", "2.1005.All Mail"]
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn marks_a_message_removed_while_its_conversation_was_read() {
    let mut mailbox = FakeMailbox::create_standard();
    for number in 0..3 {
        let message = build_thread_message("t", number, "Short.");
        mailbox.add_message("INBOX", message.build_new_message(&[]));
    }
    mailbox.add_removal("UID FETCH 2 (UID FLAGS BODY.PEEK[])", "INBOX", 2);
    let stack = start_stack(mailbox, false).await;

    let text = read_conversation_text(&stack, "3.1001.INBOX").await;

    assert!(
        text.starts_with("The conversation has 3 messages, oldest first.\n\n----\n"),
        "{text}"
    );
    assert!(
        text.contains("\n\n----\nid 2.1001.INBOX\n[This message was removed while the conversation was read.]\n\n----\nid 3.1001.INBOX\n"),
        "{text}"
    );
    assert_eq!(
        list_entry_ids(&text),
        vec!["1.1001.INBOX", "2.1001.INBOX", "3.1001.INBOX"]
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn refuses_ids_that_are_not_ids_or_no_longer_valid() {
    let stack = start_filled_stack().await;
    let read = |id: &str| run_read_email(&stack.context, IdArguments { id: id.to_owned() });

    assert_eq!(read("nonsense").await, Err(ToolFailure::InvalidId));
    assert_eq!(read("0.1001.INBOX").await, Err(ToolFailure::InvalidId));
    assert_eq!(read("99.1001.INBOX").await, Err(ToolFailure::StaleId));
    assert_eq!(read("24.9999.INBOX").await, Err(ToolFailure::StaleId));
    assert_eq!(read("24.1001.Nowhere").await, Err(ToolFailure::StaleId));
    assert_eq!(read("1.1007.[Gmail]").await, Err(ToolFailure::StaleId));
    let unknown_folder = run_search_emails(
        &stack.context,
        SearchArguments {
            folder: Some("Nowhere".to_owned()),
            ..SearchArguments::default()
        },
    )
    .await;
    assert_eq!(
        unknown_folder,
        Err(ToolFailure::FolderMissing("Nowhere".to_owned()))
    );
}
