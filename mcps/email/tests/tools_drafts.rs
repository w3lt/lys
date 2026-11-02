//! `save_draft`, `send_draft`, and `delete_draft` against the fakes.

mod support;

use email::failure::ToolFailure;
use email::folders::FolderRole;
use email::tools::drafts::{
    DraftIdArguments, SaveDraftArguments, run_delete_draft, run_save_draft, run_send_draft,
};

use support::imap::{FakeFolder, FakeMailbox, NewMessage};
use support::{Stack, calculate_trimmed_bytes, start_stack};

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

/// Saves the draft and gives its id.
async fn save(stack: &Stack, draft: SaveDraftArguments) -> String {
    let report = run_save_draft(&stack.context, draft).await.expect("saved");
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

    let report = run_save_draft(&stack.context, build_draft("First"))
        .await
        .expect("saved");

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
    let stale = run_save_draft(
        &stack.context,
        SaveDraftArguments {
            draft_id: Some(first.clone()),
            ..build_draft("Third")
        },
    )
    .await;

    assert_eq!(first, "1.1003.Drafts");
    assert_eq!(second, "2.1003.Drafts");
    let drafts = stack.imap.list_messages("Drafts");
    assert_eq!(drafts.len(), 1);
    assert_eq!(drafts[0].uid, 2);
    assert!(String::from_utf8_lossy(&drafts[0].bytes).contains("Subject: Second\r\n"));
    assert_eq!(stale, Err(ToolFailure::StaleId));
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
async fn sends_a_draft_without_its_bcc_field_keeps_a_copy_and_deletes_it() {
    let stack = start_stack(FakeMailbox::create_standard(), false).await;
    let id = save(&stack, build_draft("Ready")).await;

    let report = run_send_draft(
        &stack.context,
        DraftIdArguments {
            draft_id: id.clone(),
        },
    )
    .await
    .expect("sent");

    assert_eq!(
        report.text,
        "Sent draft 1.1003.Drafts.\nTo: Jane Doe <jane@example.com>, hidden@example.com\nSubject: Ready\nA copy was saved in Sent.\nThe draft was deleted from Drafts."
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
        DraftIdArguments {
            draft_id: "1.1001.INBOX".to_owned(),
        },
    )
    .await;

    assert_eq!(deleted.text, "Draft 1.1003.Drafts deleted.");
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

    let saved = run_save_draft(&stack.context, build_draft("Nowhere")).await;

    assert_eq!(saved, Err(ToolFailure::NoRoleFolder(FolderRole::Drafts)));
}
