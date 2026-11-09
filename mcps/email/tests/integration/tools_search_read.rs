//! `search_emails`, `read_email`, `read_conversation`, and
//! `read_attachment` against the fake IMAP server.

use email::failure::ToolFailure;
use email::tools::read::{
    AttachmentArguments, IdArguments, run_read_attachment, run_read_conversation, run_read_email,
};
use email::tools::search::{SearchArguments, run_search_emails};
use email::tools::{ToolContext, ToolReport, ToolResult};

use crate::support::imap::{FakeMailbox, NewMessage};
use crate::support::{Stack, TestMessage, start_stack};

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

/// Gets the conversation of a message, as text.
///
/// # Arguments
///
/// * `context` - The account and trust the tool runs with.
/// * `id` - The message's id.
///
/// # Panics
///
/// When the conversation cannot be read.
async fn get_conversation_text(context: &ToolContext, id: &str) -> String {
    run_read_conversation(context, IdArguments { id: id.to_owned() })
        .await
        .expect("the conversation")
        .text
}

/// Gets one page of the search for every message in INBOX.
///
/// # Arguments
///
/// * `context` - The account and trust the tool runs with.
/// * `page` - The page, or `None` for the first.
///
/// # Panics
///
/// When the search fails.
async fn get_inbox_page(context: &ToolContext, page: Option<u32>) -> String {
    let arguments = SearchArguments {
        page,
        ..SearchArguments::default()
    };
    get_inbox_hits(context, arguments).await
}

/// Gets the hits of a search of INBOX with the arguments, whatever folder
/// they name.
///
/// # Arguments
///
/// * `context` - The account and trust the tool runs with.
/// * `arguments` - The search's other arguments.
///
/// # Panics
///
/// When the search fails.
async fn get_inbox_hits(context: &ToolContext, arguments: SearchArguments) -> String {
    get_inbox_report(context, arguments).await.text
}

/// Gets the report of a search of INBOX with the arguments, whatever
/// folder they name: the hits and the log line.
///
/// # Arguments
///
/// * `context` - The account and trust the tool runs with.
/// * `arguments` - The search's other arguments.
///
/// # Panics
///
/// When the search fails.
async fn get_inbox_report(context: &ToolContext, arguments: SearchArguments) -> ToolReport {
    let arguments = SearchArguments {
        folder: Some("INBOX".to_owned()),
        ..arguments
    };
    run_search_emails(context, arguments)
        .await
        .expect("the report")
}

/// Gets one attachment of a message.
///
/// # Arguments
///
/// * `context` - The account and trust the tool runs with.
/// * `id` - The message's id.
/// * `attachment` - The attachment's number, from 1.
async fn get_attachment(context: &ToolContext, id: &str, attachment: u32) -> ToolResult {
    let arguments = AttachmentArguments {
        id: id.to_owned(),
        attachment,
    };
    run_read_attachment(context, arguments).await
}

/// Builds a mailbox with a conversation of three messages across folders
/// and one message outside it: `a@example.com` and its reply's reply
/// `c@example.com` in INBOX, the user's reply `b@example.com` in Sent, and
/// the unrelated `d@example.com` in INBOX, sent between the first two.
fn build_conversation_mailbox() -> FakeMailbox {
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
    mailbox
}

/// Lists the ids of a conversation's entries, in the order shown.
fn list_entry_ids(text: &str) -> Vec<&str> {
    text.split("\n\n----\nid ")
        .skip(1)
        .map(|entry| entry.split_once('\n').map_or(entry, |(id, _)| id))
        .collect()
}

/// Checks that `search_emails` over one folder of 25 messages lists the
/// newest 20 as page 1 of 2, pointing to page 2, with the newest hit's
/// sender, subject, flags, and folder, and logs the folder, hit, and page
/// counts.
#[tokio::test(flavor = "multi_thread")]
async fn lists_the_first_page_of_one_folder_newest_first() {
    let stack = start_filled_stack().await;
    let arguments = SearchArguments {
        folder: Some("INBOX".to_owned()),
        ..SearchArguments::default()
    };

    let first = run_search_emails(&stack.context, arguments)
        .await
        .expect("page 1");

    let text = &first.text;
    assert!(
        text.starts_with("Page 1 of 2: 25 messages match, newest first. Ask for page 2 to see the next ones.\n\nid 25.1001.INBOX\n"),
        "{text}"
    );
    assert_eq!(calculate_hit_count(text), 20);
    assert!(
        text.contains(
            "\nfrom Jane Doe <jane@example.com>\nsubject Message 25\nflags unread\nfolder INBOX"
        ),
        "{text}"
    );
    assert!(text.contains("subject Message 6\n"), "{text}");
    assert!(!text.contains("subject Message 5\n"), "{text}");
    assert_eq!(first.log, "search: 1 folder(s), 25 hit(s), page 1 of 2");
}

/// Checks that `search_emails` lists the last 5 of a folder's 25 messages
/// as page 2 of 2 with their flags, and refuses page 3 with an argument
/// failure that names the pages there are.
#[tokio::test(flavor = "multi_thread")]
async fn lists_the_last_page_of_one_folder_and_refuses_a_page_past_it() {
    let stack = start_filled_stack().await;
    let past_the_end = SearchArguments {
        folder: Some("INBOX".to_owned()),
        page: Some(3),
        ..SearchArguments::default()
    };

    let second = get_inbox_page(&stack.context, Some(2)).await;
    let third = run_search_emails(&stack.context, past_the_end).await;

    assert!(
        second.starts_with("Page 2 of 2: 25 messages match, newest first.\n\nid 5.1001.INBOX\n"),
        "{second}"
    );
    assert_eq!(calculate_hit_count(&second), 5);
    assert!(second.contains("\nflags unread, flagged\n"), "{second}");
    assert!(second.contains("\nflags read\n"), "{second}");
    assert_eq!(
        third,
        Err(ToolFailure::Argument(
            "Only 2 pages match. Ask for a page from 1 to 2.".to_owned()
        ))
    );
}

/// Checks that `search_emails` opens a folder with `EXAMINE` and fetches
/// header fields with `BODY.PEEK`, sending no `STORE` or `SELECT`, and
/// sends a `LOGOUT` for each of three calls, the refused one included.
#[tokio::test(flavor = "multi_thread")]
async fn searches_a_folder_without_marking_anything_and_signs_out_after_each_call() {
    let stack = start_filled_stack().await;
    let past_the_end = SearchArguments {
        folder: Some("INBOX".to_owned()),
        page: Some(3),
        ..SearchArguments::default()
    };

    get_inbox_page(&stack.context, None).await;
    get_inbox_page(&stack.context, Some(2)).await;
    let refused = run_search_emails(&stack.context, past_the_end).await;

    assert!(refused.is_err(), "{refused:?}");
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

/// Checks that `search_emails` without a folder finds hits across the
/// folders, Projects and Sent among them, and leaves out the all-mail view
/// and a folder that cannot hold messages, naming neither to the server.
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

/// Checks that `search_emails` over a folder with 205 matching messages
/// lists only the newest 200, over 10 pages, and says that more match there
/// and that a narrower search shows the others.
#[tokio::test(flavor = "multi_thread")]
async fn lists_only_the_newest_200_hits_of_a_folder_and_says_so() {
    let mut mailbox = FakeMailbox::create_standard();
    for number in 1..=205 {
        let message = TestMessage {
            subject: format!("Message {number}"),
            body: "Text.".to_owned(),
            message_id: format!("n{number}@example.com"),
            timestamp: BASE + number * 60,
            ..TestMessage::default()
        };
        mailbox.add_message("INBOX", message.build_new_message(&[]));
    }
    let stack = start_stack(mailbox, false).await;

    let first = get_inbox_page(&stack.context, None).await;
    let last = get_inbox_page(&stack.context, Some(10)).await;

    assert!(
        first.starts_with("Page 1 of 10: 200 messages match, newest first. Ask for page 2 to see the next ones.\nMore than 200 messages match in INBOX; only the newest 200 of each are listed. Narrow the search to see others.\n\nid 205.1001.INBOX\n"),
        "{first}"
    );
    assert_eq!(calculate_hit_count(&last), 20, "{last}");
    assert!(last.contains("\n\nid 6.1001.INBOX\n"), "{last}");
    assert!(!last.contains("id 5.1001.INBOX\n"), "{last}");
}

/// Checks that `search_emails` narrows a search to read messages, sending
/// `SEEN`, and to flagged ones, finding the inbox's one message of each.
#[tokio::test(flavor = "multi_thread")]
async fn narrows_a_search_by_flags() {
    let stack = start_filled_stack().await;
    let read_only = SearchArguments {
        unread: Some(false),
        ..SearchArguments::default()
    };
    let flagged_only = SearchArguments {
        flagged: Some(true),
        ..SearchArguments::default()
    };

    let read = get_inbox_hits(&stack.context, read_only).await;
    let flagged = get_inbox_hits(&stack.context, flagged_only).await;

    assert_eq!(calculate_hit_count(&read), 1);
    assert!(read.contains("subject Message 3\n"), "{read}");
    assert_eq!(calculate_hit_count(&flagged), 1);
    assert!(flagged.contains("subject Message 5\n"), "{flagged}");
    let commands = stack.imap.list_commands();
    assert!(
        commands
            .iter()
            .any(|command| command.ends_with("UID SEARCH SEEN")),
        "{commands:?}"
    );
}

/// Checks that `search_emails` narrows a search by sender and subject, and
/// by a date range, sending `FROM`, `SUBJECT`, `SINCE`, and `BEFORE` with
/// the dates in IMAP's form, and finds the matching messages.
#[tokio::test(flavor = "multi_thread")]
async fn narrows_a_search_by_fields_and_dates() {
    let stack = start_filled_stack().await;
    let fields = SearchArguments {
        from: Some("jane".to_owned()),
        subject: Some("Message 1".to_owned()),
        ..SearchArguments::default()
    };
    let dates = SearchArguments {
        since: Some("2026-11-02".to_owned()),
        before: Some("2026-11-03".to_owned()),
        ..SearchArguments::default()
    };

    let by_fields = get_inbox_hits(&stack.context, fields).await;
    let by_dates = get_inbox_hits(&stack.context, dates).await;

    assert_eq!(calculate_hit_count(&by_fields), 11);
    assert!(
        by_dates.starts_with("Page 1 of 1: 14 messages match"),
        "{by_dates}"
    );
    let commands = stack.imap.list_commands();
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
}

/// Checks that `search_emails` searches for a non-ASCII subject with
/// `CHARSET UTF-8`, finding its message, and answers that no message
/// matches a text that none holds, logging 0 hits.
#[tokio::test(flavor = "multi_thread")]
async fn narrows_a_search_by_a_subject_that_is_not_ascii_or_finds_nothing() {
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
    let subject = SearchArguments {
        subject: Some("Grüße".to_owned()),
        ..SearchArguments::default()
    };
    let unmatched_text = SearchArguments {
        text: Some("nothing matches this".to_owned()),
        ..SearchArguments::default()
    };

    let non_ascii = get_inbox_hits(&stack.context, subject).await;
    let none = get_inbox_report(&stack.context, unmatched_text).await;

    assert_eq!(calculate_hit_count(&non_ascii), 1);
    assert!(
        non_ascii.contains("subject Grüße aus Wien\n"),
        "{non_ascii}"
    );
    assert_eq!(none.text, "No message matches.");
    assert_eq!(none.log, "search: 1 folder(s), 0 hits");
    let commands = stack.imap.list_commands();
    assert!(
        commands
            .iter()
            .any(|command| command.ends_with("UID SEARCH CHARSET UTF-8 SUBJECT \"Grüße\"")),
        "{commands:?}"
    );
}

/// Checks that `search_emails` sends a non-ASCII text and subject to a
/// server without `LITERAL+` so that the server reads them in one
/// `CHARSET UTF-8` search, which finds the one unread match.
#[tokio::test(flavor = "multi_thread")]
async fn sends_text_that_is_not_ascii_as_literals_a_server_without_literal_plus_reads() {
    let mut mailbox = FakeMailbox::create_standard();
    mailbox.literal_plus = false;
    for (number, subject, body) in [
        (1, "Grüße aus Wien", "Schöne Grüße"),
        (2, "Grüße aus Graz", "Bis bald"),
    ] {
        let message = TestMessage {
            subject: subject.to_owned(),
            body: body.to_owned(),
            message_id: format!("g{number}@example.com"),
            timestamp: BASE + number,
            ..TestMessage::default()
        };
        mailbox.add_message("INBOX", message.build_new_message(&[]));
    }
    let stack = start_stack(mailbox, false).await;

    let found = run_search_emails(
        &stack.context,
        SearchArguments {
            folder: Some("INBOX".to_owned()),
            text: Some("Schöne".to_owned()),
            subject: Some("Grüße".to_owned()),
            unread: Some(true),
            ..SearchArguments::default()
        },
    )
    .await
    .expect("found");

    assert_eq!(calculate_hit_count(&found.text), 1, "{}", found.text);
    assert!(
        found.text.contains("subject Grüße aus Wien\n"),
        "{}",
        found.text
    );
    let commands = stack.imap.list_commands();
    let searches: Vec<&String> = commands
        .iter()
        .filter(|command| command.contains(" SEARCH "))
        .collect();
    assert_eq!(searches.len(), 1, "{commands:?}");
    assert!(
        searches[0].ends_with("UID SEARCH CHARSET UTF-8 TEXT \"Schöne\" SUBJECT \"Grüße\" UNSEEN"),
        "{commands:?}"
    );
}

/// Checks that `search_emails` finishes a non-ASCII search when the server
/// sends an untagged `EXISTS` line before it asks for a literal, and finds
/// the one match.
#[tokio::test(flavor = "multi_thread")]
async fn searches_for_text_beyond_ascii_when_the_server_sends_untagged_data_before_asking_for_it() {
    let stack = start_filled_stack().await;
    let greeting = TestMessage {
        subject: "Grüße aus Wien".to_owned(),
        body: "Schöne Grüße".to_owned(),
        message_id: "g@example.com".to_owned(),
        timestamp: BASE + 200 * 3_600,
        ..TestMessage::default()
    };
    stack.imap.update_state(|state| {
        state.add_message("INBOX", greeting.build_new_message(&[]));
        let size = state.find_folder("INBOX").expect("INBOX").messages.len();
        state.untagged_before_continuation = Some(format!("* {size} EXISTS"));
    });
    let arguments = SearchArguments {
        text: Some("Schöne".to_owned()),
        subject: Some("Grüße".to_owned()),
        ..SearchArguments::default()
    };

    let found = get_inbox_hits(&stack.context, arguments).await;

    assert_eq!(calculate_hit_count(&found), 1, "{found}");
    assert!(found.contains("subject Grüße aus Wien\n"), "{found}");
}

/// Checks that `read_email` gives a message's headers, flags, folder,
/// attachments, and body, fetching it with `BODY.PEEK` and sending no
/// `STORE` or `SELECT`, so the message stays unread.
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

/// Checks that `read_email` lists a message's attachments and converts its
/// HTML body to text with a note saying so, and that `read_attachment`
/// reads a text attachment and refuses one that is not text and a number
/// past the last.
#[tokio::test(flavor = "multi_thread")]
async fn converts_html_lists_attachments_and_reads_text_ones() {
    let stack = start_filled_stack().await;
    let mixed = NewMessage {
        bytes: MIXED.as_bytes().to_vec(),
        flags: &[],
        timestamp: BASE,
    };
    stack.imap.update_state(|state| {
        state.add_message("Projects", mixed);
    });
    let id = "3.1006.Projects";

    let message = run_read_email(&stack.context, IdArguments { id: id.to_owned() })
        .await
        .expect("the message");
    let csv = get_attachment(&stack.context, id, 1)
        .await
        .expect("the attachment");
    let pdf = get_attachment(&stack.context, id, 2).await;
    let missing = get_attachment(&stack.context, id, 3).await;

    assert!(message.text.contains("Attachments: 2\n  #1 data.csv (text/csv, 8 B)\n  #2 report.pdf (application/pdf, 5 B)\n[The text was converted from HTML.]\n\nHello there."), "{}", message.text);
    assert_eq!(
        csv.text,
        "Attachment #1 data.csv (text/csv, 8 B)\n\na,b\r\n1,2"
    );
    assert_eq!(csv.log, "attachment: #1 of 2, 8 byte(s)");
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

/// Checks that `read_conversation` from a conversation's last message shows
/// its 3 messages from the inbox and Sent oldest first, leaves out an
/// unrelated message, and logs how many it found and showed.
#[tokio::test(flavor = "multi_thread")]
async fn reads_a_conversation_across_folders_oldest_first() {
    let stack = start_stack(build_conversation_mailbox(), false).await;
    let last = IdArguments {
        id: "3.1001.INBOX".to_owned(),
    };

    let report = run_read_conversation(&stack.context, last)
        .await
        .expect("the conversation");

    let text = &report.text;
    assert!(
        text.starts_with(
            "The conversation has 3 messages, oldest first.\n\n----\nid 1.1001.INBOX\n"
        ),
        "{text}"
    );
    let position = |needle: &str| {
        text.find(needle)
            .unwrap_or_else(|| panic!("{needle} in {text}"))
    };
    assert!(position("Message-ID: <a@example.com>") < position("Message-ID: <b@example.com>"));
    assert!(position("Message-ID: <b@example.com>") < position("Message-ID: <c@example.com>"));
    assert!(text.contains("\nid 1.1002.Sent\n"), "{text}");
    assert!(text.contains("\nid 3.1001.INBOX\n"), "{text}");
    assert!(!text.contains("d@example.com"), "{text}");
    assert_eq!(report.log, "conversation: 3 message(s), 3 shown");
}

/// Checks that `read_conversation` searches, in one `UID SEARCH`, for the
/// message's identifier in the `Message-ID`, `In-Reply-To`, and
/// `References` headers and for the identifier of the message it replies
/// to, and sends no `STORE`.
#[tokio::test(flavor = "multi_thread")]
async fn finds_a_conversation_by_its_identifiers_without_marking_anything() {
    let stack = start_stack(build_conversation_mailbox(), false).await;

    get_conversation_text(&stack.context, "3.1001.INBOX").await;

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

/// Checks that `read_conversation` shows as many of a long conversation's
/// newest messages as fit in 20,000 UTF-16 code units, so that one more
/// entry would not fit, and says how many older ones it leaves out.
#[tokio::test(flavor = "multi_thread")]
async fn fits_the_newest_messages_of_a_long_conversation_and_says_how_many_are_left_out() {
    let mut mailbox = FakeMailbox::create_standard();
    let body = "x".repeat(3_500);
    for number in 0..12 {
        let message = build_thread_message("t", number, &body);
        mailbox.add_message("INBOX", message.build_new_message(&[]));
    }
    let stack = start_stack(mailbox, false).await;

    let text = get_conversation_text(&stack.context, "12.1001.INBOX").await;

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

/// Checks that `read_conversation` shows the newest message, and says that
/// one older one is left out, when that message alone takes more than
/// 20,000 UTF-16 code units.
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

    let text = get_conversation_text(&stack.context, "2.1001.INBOX").await;

    assert!(
        text.starts_with("The conversation has 2 messages, oldest first. Only the newest is shown; 1 older one is left out.\n\n----\nid 2.1001.INBOX\n"),
        "{}",
        &text[..300]
    );
    assert_eq!(list_entry_ids(&text), vec!["2.1001.INBOX"]);
    assert!(text.encode_utf16().count() > 20_000);
}

/// Checks that `read_conversation` over a conversation of 60 messages split
/// between the inbox and Sent shows only the newest 50 and says that 10
/// older ones are left out.
#[tokio::test(flavor = "multi_thread")]
async fn shows_at_most_the_newest_50_messages_of_a_conversation_across_folders() {
    let mut mailbox = FakeMailbox::create_standard();
    for number in 0..60 {
        let folder = if number % 2 == 0 { "INBOX" } else { "Sent" };
        let message = build_thread_message("t", number, "Short.");
        mailbox.add_message(folder, message.build_new_message(&[]));
    }
    let stack = start_stack(mailbox, false).await;

    let text = get_conversation_text(&stack.context, "30.1002.Sent").await;

    assert!(
        text.starts_with("The conversation has 60 messages, oldest first. Only the newest 50 are shown; 10 older ones are left out.\n\n----\nid 6.1001.INBOX\n"),
        "{text}"
    );
    let ids = list_entry_ids(&text);
    assert_eq!(ids.len(), 50, "{text}");
    assert_eq!(ids.last(), Some(&"30.1002.Sent"), "{text}");
}

/// Checks that `read_conversation` over 55 matching messages of one folder
/// reads only the newest 50, says the conversation has at least 50, and
/// says that older ones of that folder may be missing.
#[tokio::test(flavor = "multi_thread")]
async fn says_when_a_folder_matched_more_messages_than_a_conversation_reads() {
    let mut mailbox = FakeMailbox::create_standard();
    for number in 0..55 {
        let message = build_thread_message("t", number, "Short.");
        mailbox.add_message("INBOX", message.build_new_message(&[]));
    }
    let stack = start_stack(mailbox, false).await;

    let text = get_conversation_text(&stack.context, "55.1001.INBOX").await;

    assert!(
        text.starts_with("The conversation has at least 50 messages, oldest first.\nMore than 50 messages match in INBOX; only the newest 50 of each were read, so older ones may be missing.\n\n----\nid 6.1001.INBOX\n"),
        "{text}"
    );
    assert_eq!(list_entry_ids(&text).len(), 50, "{text}");
}

/// Checks that `read_conversation` keeps only messages whose identifiers
/// equal the conversation's, leaving out ones whose identifiers merely
/// contain them, such as `11@x.example` for `1@x.example`.
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

    let text = get_conversation_text(&stack.context, "1.1001.INBOX").await;

    assert!(
        text.starts_with("The conversation has 2 messages, oldest first.\n\n----\n"),
        "{text}"
    );
    assert_eq!(list_entry_ids(&text), vec!["1.1001.INBOX", "4.1001.INBOX"]);
}

/// Checks that `read_conversation` finds a message that only the all-mail
/// view holds, and shows once, from the inbox, a message that both hold.
#[tokio::test(flavor = "multi_thread")]
async fn finds_a_conversation_message_archived_in_the_all_mail_view_once() {
    let mut mailbox = FakeMailbox::create_standard();
    let first = build_thread_message("t", 0, "Shall we?");
    let archived = build_thread_message("t", 1, "Yes.");
    mailbox.add_message("INBOX", first.build_new_message(&[]));
    mailbox.add_message("All Mail", first.build_new_message(&[]));
    mailbox.add_message("All Mail", archived.build_new_message(&["\\Seen"]));
    let stack = start_stack(mailbox, false).await;

    let text = get_conversation_text(&stack.context, "1.1001.INBOX").await;

    assert!(
        text.starts_with("The conversation has 2 messages, oldest first.\n\n----\n"),
        "{text}"
    );
    assert_eq!(
        list_entry_ids(&text),
        vec!["1.1001.INBOX", "2.1005.All Mail"]
    );
}

/// Checks that `read_conversation` shows a message that both a folder and
/// the all-mail view hold from that folder, even when the server lists the
/// folder after the view.
#[tokio::test(flavor = "multi_thread")]
async fn shows_a_conversation_message_from_its_folder_listed_after_the_all_mail_view() {
    let mut mailbox = FakeMailbox::create_standard();
    let first = build_thread_message("t", 0, "Shall we?");
    let filed = build_thread_message("t", 1, "Yes.");
    mailbox.add_message("INBOX", first.build_new_message(&[]));
    mailbox.add_message("All Mail", first.build_new_message(&[]));
    mailbox.add_message("Projects", filed.build_new_message(&["\\Seen"]));
    mailbox.add_message("All Mail", filed.build_new_message(&["\\Seen"]));
    let stack = start_stack(mailbox, false).await;

    let text = get_conversation_text(&stack.context, "1.1001.INBOX").await;

    assert_eq!(
        list_entry_ids(&text),
        vec!["1.1001.INBOX", "1.1006.Projects"]
    );
}

/// Checks that `read_conversation` keeps a message that the server removes
/// as it is fetched in its place, as an entry noting that it was removed
/// while the conversation was read.
#[tokio::test(flavor = "multi_thread")]
async fn marks_a_message_removed_while_its_conversation_was_read() {
    let mut mailbox = FakeMailbox::create_standard();
    for number in 0..3 {
        let message = build_thread_message("t", number, "Short.");
        mailbox.add_message("INBOX", message.build_new_message(&[]));
    }
    mailbox.add_removal("UID FETCH 2 (UID FLAGS BODY.PEEK[])", "INBOX", 2);
    let stack = start_stack(mailbox, false).await;

    let text = get_conversation_text(&stack.context, "3.1001.INBOX").await;

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

/// Checks that `read_email` refuses a malformed id or one with UID 0 as
/// invalid, and as stale an id whose message or folder no longer exists,
/// whose UID validity has changed, or whose folder cannot hold messages. It
/// also checks that `search_emails` refuses a folder that does not exist.
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

/// Checks that `search_emails` refuses a folder that cannot hold messages
/// with an argument failure that points to `list_folders`, sending no
/// `EXAMINE`.
#[tokio::test(flavor = "multi_thread")]
async fn refuses_to_search_a_folder_that_cannot_hold_messages_without_opening_it() {
    let stack = start_stack(FakeMailbox::create_standard(), false).await;
    let arguments = SearchArguments {
        folder: Some("[Gmail]".to_owned()),
        ..SearchArguments::default()
    };

    let searched = run_search_emails(&stack.context, arguments).await;

    assert_eq!(
        searched,
        Err(ToolFailure::Argument(
            "[Gmail] cannot hold messages. Use list_folders to see the folders.".to_owned()
        ))
    );
    let commands = stack.imap.list_commands();
    assert!(
        !commands.iter().any(|command| command.contains("EXAMINE")),
        "{commands:?}"
    );
}
