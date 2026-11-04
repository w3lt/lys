//! `save_draft`, `send_draft`, and `delete_draft` against the fakes.

use std::time::Duration;

use email::email_id::EmailId;
use email::failure::ToolFailure;
use email::folders::FolderRole;
use email::smtp::SendProgress;
use email::tools::ToolResult;
use email::tools::drafts::{
    DraftIdArguments, DraftProgress, DraftStage, SaveDraftArguments, SendDraftArguments,
    run_delete_draft, run_save_draft, run_send_draft,
};

use crate::support::imap::{FakeFolder, FakeMailbox, ImapFault, NewMessage};
use crate::support::{
    Stack, assert_about, assert_nothing_sent, calculate_trimmed_bytes, start_stack,
};

/// The reason a step reports when the IMAP server ended its connection.
const LOST: &str = "The connection to the IMAP server ended before it answered.";

/// The reason a step reports when the IMAP server did not answer in time.
const TIMED_OUT: &str = "The IMAP server did not answer in time.";

/// A draft to Jane with a hidden recipient.
fn build_draft(subject: &str) -> SaveDraftArguments {
    SaveDraftArguments {
        to: vec!["Jane Doe <jane@example.com>".to_owned()],
        bcc: vec!["hidden@example.com".to_owned()],
        subject: subject.to_owned(),
        body: "Not sent yet.".to_owned(),
        ..SaveDraftArguments::default()
    }
}

/// The arguments that send the draft with the id, naming the draft's
/// fields.
fn build_send(draft_id: &str, draft: &SaveDraftArguments) -> SendDraftArguments {
    SendDraftArguments {
        draft_id: draft_id.to_owned(),
        to: draft.to.clone(),
        cc: draft.cc.clone(),
        bcc: draft.bcc.clone(),
        subject: draft.subject.clone(),
        body: draft.body.clone(),
    }
}

/// The arguments that send the draft with the id without naming any of
/// its fields.
fn build_unnamed_send(draft_id: &str) -> SendDraftArguments {
    SendDraftArguments {
        draft_id: draft_id.to_owned(),
        to: Vec::new(),
        cc: Vec::new(),
        bcc: Vec::new(),
        subject: String::new(),
        body: String::new(),
    }
}

/// Sends a draft with send_draft, without a stop.
async fn send(stack: &Stack, arguments: SendDraftArguments) -> ToolResult {
    run_send_draft(&stack.context, arguments, &SendProgress::default()).await
}

/// Asserts that nothing was sent and that the one draft is still in
/// Drafts, not marked deleted, with no copy in Sent.
fn assert_draft_kept_unsent(stack: &Stack) {
    assert_nothing_sent(stack);
    let drafts = stack.imap.list_messages("Drafts");
    assert_eq!(drafts.len(), 1);
    assert!(!drafts[0].has_flag("\\Deleted"));
    assert!(stack.imap.list_messages("Sent").is_empty());
}

/// Saves the draft and gives its id.
async fn save(stack: &Stack, draft: SaveDraftArguments) -> String {
    let report = run_save_draft(&stack.context, draft, &DraftProgress::default())
        .await
        .expect("saved");
    report
        .text
        .strip_prefix("Draft saved as ")
        .and_then(|rest| rest.split_once(".\n"))
        .map(|(id, _)| id.to_owned())
        .unwrap_or_else(|| panic!("{}", report.text))
}

#[tokio::test(flavor = "multi_thread")]
async fn saves_a_draft_with_its_bcc_field_and_answers_its_id() {
    let stack = start_stack(FakeMailbox::create_standard(), false).await;

    let progress = DraftProgress::default();

    let report = run_save_draft(&stack.context, build_draft("First"), &progress)
        .await
        .expect("saved");

    assert_eq!(
        progress.read_stage(),
        DraftStage::Storing { replaced: None }
    );

    assert_eq!(
        report.text,
        "Draft saved as 1.1003.Drafts.\nTo: Jane Doe <jane@example.com>\nBcc: hidden@example.com\nSubject: First\nSend it with send_draft, replace it with save_draft and this draft_id, or delete it with delete_draft."
    );
    assert_eq!(report.log, "draft: saved, id found");
    let drafts = stack.imap.list_messages("Drafts");
    assert_eq!(drafts.len(), 1);
    assert_eq!(drafts[0].flags, vec!["\\Draft"]);
    let text = String::from_utf8_lossy(&drafts[0].bytes);
    assert!(text.contains("Bcc: hidden@example.com\r\n"), "{text}");
    assert!(text.contains("Subject: First\r\n"), "{text}");
    assert!(stack.smtp.list_mails().is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn replaces_a_draft_and_answers_the_new_id() {
    let stack = start_stack(FakeMailbox::create_standard(), false).await;
    let first = save(&stack, build_draft("First")).await;

    let second = save(
        &stack,
        SaveDraftArguments {
            draft_id: Some(first.clone()),
            ..build_draft("Second")
        },
    )
    .await;
    let stale_progress = DraftProgress::default();
    let stale = run_save_draft(
        &stack.context,
        SaveDraftArguments {
            draft_id: Some(first.clone()),
            ..build_draft("Third")
        },
        &stale_progress,
    )
    .await;

    assert_eq!(first, "1.1003.Drafts");
    assert_eq!(second, "2.1003.Drafts");
    let drafts = stack.imap.list_messages("Drafts");
    assert_eq!(drafts.len(), 1);
    assert_eq!(drafts[0].uid, 2);
    assert!(String::from_utf8_lossy(&drafts[0].bytes).contains("Subject: Second\r\n"));
    assert_eq!(stale, Err(ToolFailure::StaleId));
    assert_eq!(stale_progress.read_stage(), DraftStage::BeforeStoring);
    let commands = stack.imap.list_commands();
    assert!(
        commands
            .iter()
            .any(|command| command.ends_with("UID STORE 1 +FLAGS.SILENT (\\Deleted)")),
        "{commands:?}"
    );
    assert!(
        commands
            .iter()
            .any(|command| command.ends_with("UID EXPUNGE 1")),
        "{commands:?}"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn replaces_a_draft_when_the_server_sends_untagged_data_before_asking_for_it() {
    let stack = start_stack(FakeMailbox::create_standard(), false).await;
    let first = save(&stack, build_draft("First")).await;
    stack.imap.update_state(|state| {
        let size = state.find_folder("Drafts").expect("Drafts").messages.len();
        state.untagged_before_continuation = Some(format!("* {size} EXISTS"));
    });

    let second = save(
        &stack,
        SaveDraftArguments {
            draft_id: Some(first),
            ..build_draft("Second")
        },
    )
    .await;

    assert_eq!(second, "2.1003.Drafts");
    let drafts = stack.imap.list_messages("Drafts");
    assert_eq!(drafts.len(), 1);
    assert_eq!(drafts[0].uid, 2);
    assert!(String::from_utf8_lossy(&drafts[0].bytes).contains("Subject: Second\r\n"));
}

#[tokio::test(flavor = "multi_thread")]
async fn sends_a_draft_without_its_bcc_field_keeps_a_copy_and_deletes_it() {
    let stack = start_stack(FakeMailbox::create_standard(), false).await;
    let id = save(&stack, build_draft("Ready")).await;

    let report = run_send_draft(
        &stack.context,
        build_send(&id, &build_draft("Ready")),
        &SendProgress::default(),
    )
    .await
    .expect("sent");

    assert_eq!(
        report.text,
        "Sent draft 1.1003.Drafts.\nTo: Jane Doe <jane@example.com>\nBcc: hidden@example.com\nSubject: Ready\nA copy was saved in Sent.\nThe draft was deleted from Drafts."
    );
    assert_eq!(
        report.log,
        "draft: sent to 2 recipient(s), copy saved, deleted true"
    );
    let mails = stack.smtp.list_mails();
    assert_eq!(mails.len(), 1);
    assert_eq!(mails[0].to, vec!["jane@example.com", "hidden@example.com"]);
    let text = String::from_utf8_lossy(&mails[0].bytes);
    assert!(!text.contains("Bcc"), "{text}");
    assert!(text.contains("Subject: Ready\r\n"), "{text}");
    let sent = stack.imap.list_messages("Sent");
    assert_eq!(sent.len(), 1);
    assert_eq!(sent[0].flags, vec!["\\Seen"]);
    assert_eq!(
        calculate_trimmed_bytes(&sent[0].bytes),
        calculate_trimmed_bytes(&mails[0].bytes)
    );
    assert!(stack.imap.list_messages("Drafts").is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn deletes_a_draft_and_refuses_ids_outside_drafts() {
    let mut mailbox = FakeMailbox::create_standard();
    mailbox.add_message(
        "INBOX",
        NewMessage {
            bytes: b"Subject: Inbox\r\n\r\nx".to_vec(),
            flags: &[],
            timestamp: 0,
        },
    );
    let stack = start_stack(mailbox, false).await;
    let id = save(&stack, build_draft("Gone")).await;

    let deleted = run_delete_draft(
        &stack.context,
        DraftIdArguments {
            draft_id: id.clone(),
        },
    )
    .await
    .expect("deleted");
    let again = run_delete_draft(&stack.context, DraftIdArguments { draft_id: id }).await;
    let in_inbox = run_delete_draft(
        &stack.context,
        DraftIdArguments {
            draft_id: "1.1001.INBOX".to_owned(),
        },
    )
    .await;
    let sent_from_inbox = run_send_draft(
        &stack.context,
        build_send("1.1001.INBOX", &build_draft("Gone")),
        &SendProgress::default(),
    )
    .await;

    assert_eq!(deleted.text, "Draft 1.1003.Drafts was deleted from Drafts.");
    assert!(stack.imap.list_messages("Drafts").is_empty());
    assert_eq!(again, Err(ToolFailure::StaleId));
    assert_eq!(in_inbox, Err(ToolFailure::NotInDrafts));
    assert_eq!(sent_from_inbox, Err(ToolFailure::NotInDrafts));
    assert_eq!(stack.imap.list_messages("INBOX").len(), 1);
    assert!(stack.smtp.list_mails().is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn needs_a_drafts_folder() {
    let mut mailbox = FakeMailbox::create_empty();
    mailbox
        .folders
        .push(FakeFolder::new("INBOX", &["\\HasNoChildren"], 1));
    let stack = start_stack(mailbox, false).await;

    let progress = DraftProgress::default();

    let saved = run_save_draft(&stack.context, build_draft("Nowhere"), &progress).await;

    assert_eq!(saved, Err(ToolFailure::NoRoleFolder(FolderRole::Drafts)));
    assert_eq!(progress.read_stage(), DraftStage::BeforeStoring);
}

/// A standard mailbox whose server lacks UIDPLUS, with a message in
/// Drafts that another client marked `\Deleted` and kept, `1.1003.Drafts`.
fn build_mailbox_without_uid_plus() -> FakeMailbox {
    let mut mailbox = FakeMailbox::create_standard();
    mailbox.uid_plus = false;
    mailbox.add_message(
        "Drafts",
        NewMessage {
            bytes: b"Subject: Kept by another client\r\n\r\nx".to_vec(),
            flags: &["\\Deleted"],
            timestamp: 0,
        },
    );
    mailbox
}

/// The clause that says a draft is only marked as deleted.
const MARKED_ONLY: &str = "is marked as deleted but stays in Drafts until the folder is expunged, as the server cannot remove one message on its own";

#[tokio::test(flavor = "multi_thread")]
async fn without_uidplus_delete_draft_only_marks_the_draft() {
    let stack = start_stack(build_mailbox_without_uid_plus(), false).await;
    let id = save(&stack, build_draft("Gone")).await;

    let deleted = run_delete_draft(&stack.context, DraftIdArguments { draft_id: id })
        .await
        .expect("marked");

    assert_eq!(deleted.text, format!("Draft 2.1003.Drafts {MARKED_ONLY}."));
    assert_eq!(deleted.log, "draft: marked as deleted");
    let drafts = stack.imap.list_messages("Drafts");
    assert_eq!(drafts.len(), 2);
    assert!(drafts.iter().all(|draft| draft.has_flag("\\Deleted")));
    let commands = stack.imap.list_commands();
    assert!(
        !commands.iter().any(|command| command.contains("EXPUNGE")),
        "{commands:?}"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn without_uidplus_send_draft_and_save_draft_only_mark_the_old_draft() {
    let stack = start_stack(build_mailbox_without_uid_plus(), false).await;
    let first = save(&stack, build_draft("First")).await;

    let replaced = run_save_draft(
        &stack.context,
        SaveDraftArguments {
            draft_id: Some(first),
            ..build_draft("Second")
        },
        &DraftProgress::default(),
    )
    .await
    .expect("saved");
    let sent = run_send_draft(
        &stack.context,
        build_send("3.1003.Drafts", &build_draft("Second")),
        &SendProgress::default(),
    )
    .await
    .expect("sent");

    assert!(
        replaced.text.contains(&format!(
            "It replaces draft 2.1003.Drafts, which {MARKED_ONLY}."
        )),
        "{}",
        replaced.text
    );
    assert!(
        sent.text.ends_with(&format!("\nThe draft {MARKED_ONLY}.")),
        "{}",
        sent.text
    );
    let drafts = stack.imap.list_messages("Drafts");
    assert_eq!(drafts.len(), 3);
    assert!(drafts.iter().all(|draft| draft.has_flag("\\Deleted")));
    let commands = stack.imap.list_commands();
    assert!(
        !commands.iter().any(|command| command.contains("EXPUNGE")),
        "{commands:?}"
    );
}

/// The fields of the draft `build_draft("Ready")` saves, as a refusal to
/// send it names them, up to what it says of the body.
const READY_FIELDS: &str = "Its own fields are:\nto: [\"Jane Doe <jane@example.com>\"]\ncc: []\nbcc: [\"hidden@example.com\"]\nsubject: \"Ready\"\nbody: its text as read_email shows it, which the body given";

#[tokio::test(flavor = "multi_thread")]
async fn refuses_to_send_a_draft_whose_text_the_call_leaves_out_or_changes() {
    let stack = start_stack(FakeMailbox::create_standard(), false).await;
    let id = save(&stack, build_draft("Ready")).await;
    let rewritten = SendDraftArguments {
        body: "Not sent yet!".to_owned(),
        ..build_send(&id, &build_draft("Ready"))
    };

    let unnamed = send(&stack, build_unnamed_send(&id)).await;
    let changed = send(&stack, rewritten).await;

    assert_eq!(
        unnamed,
        Err(ToolFailure::Argument(format!(
            "The draft differs from this call in to, bcc, subject, body, so nothing was sent. {READY_FIELDS} differs from at character 1, counting a line break as one.\nCall send_draft with these to send it."
        )))
    );
    assert_eq!(
        changed,
        Err(ToolFailure::Argument(format!(
            "The draft differs from this call in body, so nothing was sent. {READY_FIELDS} differs from at character 13, counting a line break as one.\nCall send_draft with these to send it."
        )))
    );
    assert_draft_kept_unsent(&stack);
}

#[tokio::test(flavor = "multi_thread")]
async fn refuses_to_send_a_draft_to_recipients_the_draft_does_not_hold() {
    let stack = start_stack(FakeMailbox::create_standard(), false).await;
    let id = save(&stack, build_draft("Ready")).await;
    let named = build_send(&id, &build_draft("Ready"));
    let added = SendDraftArguments {
        to: vec![
            "Jane Doe <jane@example.com>".to_owned(),
            "attacker@example.net".to_owned(),
        ],
        ..named.clone()
    };
    let substituted = SendDraftArguments {
        bcc: vec!["attacker@example.net".to_owned()],
        ..named
    };

    let redirected = send(&stack, added).await;
    let replaced = send(&stack, substituted).await;

    assert_eq!(
        redirected,
        Err(ToolFailure::Argument(format!(
            "The draft differs from this call in to, so nothing was sent. {READY_FIELDS} matches.\nCall send_draft with these to send it."
        )))
    );
    assert_eq!(
        replaced,
        Err(ToolFailure::Argument(format!(
            "The draft differs from this call in bcc, so nothing was sent. {READY_FIELDS} matches.\nCall send_draft with these to send it."
        )))
    );
    assert_draft_kept_unsent(&stack);
}

/// A draft another client saved, `1.1003.Drafts`: a quoted name, a group,
/// an encoded subject, and a Bcc field.
const OTHER_CLIENT_DRAFT: &str = "From: A Person <person@example.com>\r\nTo: \"Doe, Jane\" <jane@example.com>, Team: a@example.com, B <b@example.com>;\r\nCc: =?UTF-8?Q?J=C3=BCrgen?= <juergen@example.com>\r\nBcc: hidden@example.com\r\nSubject: =?UTF-8?Q?Gr=C3=BC=C3=9Fe?=\r\nMessage-ID: <other@example.com>\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nLine one\r\nLine two\r\n";

/// Starts the stack with the other client's draft in Drafts.
async fn start_with_other_client_draft() -> Stack {
    let mut mailbox = FakeMailbox::create_standard();
    mailbox.add_message(
        "Drafts",
        NewMessage {
            bytes: OTHER_CLIENT_DRAFT.as_bytes().to_vec(),
            flags: &["\\Draft"],
            timestamp: 0,
        },
    );
    start_stack(mailbox, false).await
}

/// The arguments that send the other client's draft, naming its fields
/// as the refusal to send it without them gives them.
fn build_other_client_send() -> SendDraftArguments {
    SendDraftArguments {
        to: vec![
            "\"Doe, Jane\" <jane@example.com>".to_owned(),
            "a@example.com".to_owned(),
            "B <b@example.com>".to_owned(),
        ],
        cc: vec!["Jürgen <juergen@example.com>".to_owned()],
        bcc: vec!["hidden@example.com".to_owned()],
        subject: "Grüße".to_owned(),
        body: "Line one\nLine two".to_owned(),
        ..build_unnamed_send("1.1003.Drafts")
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn sends_a_draft_another_client_saved_with_the_fields_the_refusal_names() {
    let stack = start_with_other_client_draft().await;

    let refused = send(&stack, build_unnamed_send("1.1003.Drafts")).await;
    let sent = send(&stack, build_other_client_send()).await.expect("sent");

    assert_eq!(
        refused,
        Err(ToolFailure::Argument(
            "The draft differs from this call in to, cc, bcc, subject, body, so nothing was sent. Its own fields are:\nto: [\"\\\"Doe, Jane\\\" <jane@example.com>\", \"a@example.com\", \"B <b@example.com>\"]\ncc: [\"Jürgen <juergen@example.com>\"]\nbcc: [\"hidden@example.com\"]\nsubject: \"Grüße\"\nbody: its text as read_email shows it, which the body given differs from at character 1, counting a line break as one.\nCall send_draft with these to send it.".to_owned()
        ))
    );
    assert_eq!(
        sent.text,
        "Sent draft 1.1003.Drafts.\nTo: \"Doe, Jane\" <jane@example.com>, a@example.com, B <b@example.com>\nCc: Jürgen <juergen@example.com>\nBcc: hidden@example.com\nSubject: Grüße\nA copy was saved in Sent.\nThe draft was deleted from Drafts."
    );
    let mails = stack.smtp.list_mails();
    assert_eq!(mails.len(), 1);
    assert_eq!(
        mails[0].to,
        vec![
            "jane@example.com",
            "a@example.com",
            "b@example.com",
            "juergen@example.com",
            "hidden@example.com"
        ]
    );
    let text = String::from_utf8_lossy(&mails[0].bytes);
    assert!(!text.contains("Bcc"), "{text}");
    assert!(
        text.contains("Team: a@example.com, B <b@example.com>;"),
        "{text}"
    );
}

/// The end of the report of a sent draft whose IMAP session ended at its
/// Sent copy for the reason.
fn format_kept_draft_end(reason: &str) -> String {
    format!(
        "\nThe copy could not be saved in Sent: {reason}\nThe draft could not be deleted and may still be in Drafts: {reason} Delete it with delete_draft; do not send it again."
    )
}

#[tokio::test(flavor = "multi_thread")]
async fn reports_a_draft_sent_before_the_imap_connection_ended_as_sent_and_kept() {
    let stack = start_stack(FakeMailbox::create_standard(), false).await;
    let id = save(&stack, build_draft("Ready")).await;
    stack.imap.add_fault("APPEND", ImapFault::Close);

    let report = run_send_draft(
        &stack.context,
        build_send(&id, &build_draft("Ready")),
        &SendProgress::default(),
    )
    .await
    .expect("sent");

    assert_eq!(
        report.text,
        format!(
            "Sent draft 1.1003.Drafts.\nTo: Jane Doe <jane@example.com>\nBcc: hidden@example.com\nSubject: Ready{}",
            format_kept_draft_end(LOST)
        )
    );
    assert_eq!(
        report.log,
        "draft: sent to 2 recipient(s), copy failed (imap-connection-lost), deleted false (imap-connection-lost)"
    );
    assert_eq!(stack.smtp.list_mails().len(), 1);
    assert!(stack.imap.list_messages("Sent").is_empty());
    assert_eq!(stack.imap.list_messages("Drafts").len(), 1);
}

#[tokio::test]
async fn sends_nothing_more_over_an_imap_session_whose_sent_copy_timed_out() {
    let stack = start_stack(FakeMailbox::create_standard(), false).await;
    let id = save(&stack, build_draft("Ready")).await;
    stack.imap.add_fault("APPEND", ImapFault::Stall);
    let progress = SendProgress::default();

    let (sent, elapsed) = stack
        .imap
        .run_past_fault(run_send_draft(
            &stack.context,
            build_send(&id, &build_draft("Ready")),
            &progress,
        ))
        .await;

    let commands = stack.imap.list_commands();
    assert!(
        commands
            .last()
            .is_some_and(|command| command.contains(" APPEND ")),
        "{commands:?}"
    );
    assert_about(elapsed, Duration::from_secs(30));
    let report = sent.expect("sent");
    assert!(
        report.text.ends_with(&format_kept_draft_end(TIMED_OUT)),
        "{}",
        report.text
    );
    assert_eq!(stack.smtp.list_mails().len(), 1);
    assert_eq!(stack.imap.list_messages("Drafts").len(), 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn answers_a_stored_draft_as_saved_when_its_id_cannot_be_found() {
    for (refused, operation) in [
        ("SELECT", "select the Drafts folder"),
        ("SEARCH", "find the saved draft"),
    ] {
        let mut mailbox = FakeMailbox::create_standard();
        mailbox.add_refusal(refused, "NO [SERVERBUG] Not now");
        let stack = start_stack(mailbox, false).await;

        let report = run_save_draft(
            &stack.context,
            build_draft("First"),
            &DraftProgress::default(),
        )
        .await
        .expect("saved");

        assert_eq!(
            report.text,
            format!(
                "Draft saved in Drafts, but its id could not be found: The IMAP server refused to {operation}: [SERVERBUG] Not now. Search that folder to find it."
            )
        );
        assert_eq!(
            report.log,
            format!(
                "draft: saved, id not found (imap-refused-to-{})",
                operation.replace(' ', "-")
            )
        );
        assert_eq!(stack.imap.list_messages("Drafts").len(), 1);
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn answers_a_replacing_draft_with_its_id_when_the_old_one_cannot_be_deleted() {
    let stack = start_stack(FakeMailbox::create_standard(), false).await;
    let first = save(&stack, build_draft("First")).await;
    stack
        .imap
        .update_state(|mailbox| mailbox.add_refusal("STORE", "NO [CANNOT] Not allowed"));

    let report = run_save_draft(
        &stack.context,
        SaveDraftArguments {
            draft_id: Some(first),
            ..build_draft("Second")
        },
        &DraftProgress::default(),
    )
    .await
    .expect("saved");

    assert_eq!(
        report.text,
        "Draft saved as 2.1003.Drafts.\nTo: Jane Doe <jane@example.com>\nBcc: hidden@example.com\nSubject: Second\nIt replaces draft 1.1003.Drafts, which could not be deleted and may still be in Drafts: The IMAP server refused to delete the replaced draft: [CANNOT] Not allowed. Delete it with delete_draft.\nSend it with send_draft, replace it with save_draft and this draft_id, or delete it with delete_draft."
    );
    assert_eq!(
        report.log,
        "draft: saved, replaced one not deleted (imap-refused-to-delete-the-replaced-draft), id found"
    );
    assert_eq!(stack.imap.list_messages("Drafts").len(), 2);
}

#[tokio::test]
async fn answers_a_stored_draft_as_saved_when_a_later_step_times_out() {
    let stack = start_stack(FakeMailbox::create_standard(), false).await;
    let first = save(&stack, build_draft("First")).await;
    stack.imap.add_fault("STORE", ImapFault::Stall);

    let (saved, elapsed) = stack
        .imap
        .run_past_fault(run_save_draft(
            &stack.context,
            SaveDraftArguments {
                draft_id: Some(first),
                ..build_draft("Second")
            },
            &DraftProgress::default(),
        ))
        .await;

    let commands = stack.imap.list_commands();
    assert!(
        commands
            .last()
            .is_some_and(|command| command.contains(" UID STORE 1 ")),
        "{commands:?}"
    );
    assert_about(elapsed, Duration::from_secs(30));
    let report = saved.expect("saved");
    assert_eq!(
        report.text,
        format!(
            "Draft saved in Drafts, but its id could not be found: {TIMED_OUT} Search that folder to find it.\nIt replaces draft 1.1003.Drafts, which could not be deleted and may still be in Drafts: {TIMED_OUT} Delete it with delete_draft."
        )
    );
    assert_eq!(
        report.log,
        "draft: saved, replaced one not deleted (imap-connection-timed-out), id not found (imap-connection-timed-out)"
    );
    assert_eq!(stack.imap.list_messages("Drafts").len(), 2);
}

#[tokio::test]
async fn answers_a_draft_whose_answer_never_came_once_all_of_it_was_sent_as_maybe_saved() {
    let stack = start_stack(FakeMailbox::create_standard(), false).await;
    stack
        .imap
        .add_fault("APPEND", ImapFault::StallAfterHandling);
    let progress = DraftProgress::default();

    let (saved, elapsed) = stack
        .imap
        .run_past_fault(run_save_draft(
            &stack.context,
            build_draft("Pending"),
            &progress,
        ))
        .await;

    assert_about(elapsed, Duration::from_secs(30));
    assert_eq!(
        saved.map_err(|failure| failure.to_string()),
        Err(format!(
            "{TIMED_OUT} The whole draft had been handed over, so it may or may not be in the Drafts folder; search that folder before saving it again."
        ))
    );
    assert_eq!(stack.imap.list_messages("Drafts").len(), 1);
    assert_eq!(
        progress.read_stage(),
        DraftStage::Storing { replaced: None }
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn answers_a_replacing_draft_whose_answer_was_lost_with_the_draft_it_replaces() {
    let stack = start_stack(FakeMailbox::create_standard(), false).await;
    let first = save(&stack, build_draft("First")).await;
    stack
        .imap
        .add_fault("APPEND", ImapFault::CloseAfterHandling);
    let progress = DraftProgress::default();

    let saved = run_save_draft(
        &stack.context,
        SaveDraftArguments {
            draft_id: Some(first),
            ..build_draft("Second")
        },
        &progress,
    )
    .await;

    assert_eq!(
        saved.map_err(|failure| failure.to_string()),
        Err(format!(
            "{LOST} The whole draft had been handed over, so it may or may not be in the Drafts folder; search that folder before saving it again. The draft it replaces, 1.1003.Drafts, is still in the Drafts folder."
        ))
    );
    let drafts = stack.imap.list_messages("Drafts");
    assert_eq!(drafts.len(), 2);
    assert!(drafts.iter().all(|draft| !draft.has_flag("\\Deleted")));
    let replaced = EmailId {
        uid: 1,
        uid_validity: 1003,
        folder: "Drafts".to_owned(),
    };
    assert_eq!(
        progress.read_stage(),
        DraftStage::Storing {
            replaced: Some(replaced)
        }
    );
}
