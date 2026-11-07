//! IMAP commands the server refuses, against the fakes: every tool reads
//! the tagged status of each command and fails with the server's code and
//! text instead of reading a refusal as an empty answer.

use email::failure::ToolFailure;
use email::tools::ToolResult;
use email::tools::drafts::{
    DraftIdArguments, DraftProgress, SaveDraftArguments, run_delete_draft, run_save_draft,
};
use email::tools::folders::{FolderAction, FolderArguments, run_list_folders, run_manage_folder};
use email::tools::read::{
    AttachmentArguments, IdArguments, run_read_attachment, run_read_conversation, run_read_email,
};
use email::tools::search::{SearchArguments, run_search_emails};

use crate::support::imap::FakeMailbox;
use crate::support::{TestMessage, start_stack};

/// A mailbox with one message from Jane in INBOX, `1.1001.INBOX`, and one
/// draft in Drafts, `1.1003.Drafts`.
fn build_mailbox() -> FakeMailbox {
    let mut mailbox = FakeMailbox::create_standard();
    let message = TestMessage {
        subject: "Grüße".to_owned(),
        message_id: "one@example.com".to_owned(),
        body: "Hello".to_owned(),
        ..TestMessage::default()
    };
    mailbox.add_message("INBOX", message.build_new_message(&[]));
    let draft = TestMessage {
        from: "A Person <person@example.com>".to_owned(),
        to: "jane@example.com".to_owned(),
        subject: "Draft".to_owned(),
        message_id: "draft@example.com".to_owned(),
        ..TestMessage::default()
    };
    mailbox.add_message("Drafts", draft.build_new_message(&["\\Draft"]));
    mailbox
}

/// The failure a refusal of the operation with the text gives.
fn build_refusal(operation: &'static str, text: &str) -> ToolFailure {
    ToolFailure::ImapRefused {
        operation,
        text: text.to_owned(),
    }
}

/// Gets the result of search_emails over INBOX from a fake that serves the
/// mailbox.
///
/// # Arguments
///
/// * `mailbox` - What the fake serves, with its refusals.
async fn get_inbox_result(mailbox: FakeMailbox) -> ToolResult {
    let stack = start_stack(mailbox, false).await;
    let arguments = SearchArguments {
        folder: Some("INBOX".to_owned()),
        ..SearchArguments::default()
    };
    run_search_emails(&stack.context, arguments).await
}

#[tokio::test(flavor = "multi_thread")]
async fn a_refused_search_fails_instead_of_matching_nothing() {
    let mut mailbox = build_mailbox();
    mailbox.add_refusal("SEARCH", "NO [BADCHARSET (US-ASCII)] Unsupported charset");
    let stack = start_stack(mailbox, false).await;

    let searched = run_search_emails(
        &stack.context,
        SearchArguments {
            folder: Some("INBOX".to_owned()),
            subject: Some("Grüße".to_owned()),
            ..SearchArguments::default()
        },
    )
    .await;

    assert_eq!(
        searched,
        Err(build_refusal(
            "search",
            "[BADCHARSET (US-ASCII)] Unsupported charset"
        ))
    );
    let commands = stack.imap.list_commands();
    assert!(
        commands
            .last()
            .is_some_and(|command| command.ends_with("UID SEARCH CHARSET UTF-8 SUBJECT ")),
        "{commands:?}"
    );
    assert!(
        !commands.iter().any(|command| command.contains("Grüße")),
        "{commands:?}"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_search_whose_folder_or_summaries_are_refused_fails_instead_of_matching_nothing() {
    let mut unopenable = build_mailbox();
    unopenable.add_refusal("EXAMINE", "NO [NONEXISTENT] Unknown mailbox");
    let mut unfetchable = build_mailbox();
    unfetchable.add_refusal("FETCH", "NO [SERVERBUG] Internal error");

    let opened = get_inbox_result(unopenable).await;
    let fetched = get_inbox_result(unfetchable).await;

    assert_eq!(
        opened,
        Err(build_refusal(
            "select the folder",
            "[NONEXISTENT] Unknown mailbox"
        ))
    );
    assert_eq!(
        fetched,
        Err(build_refusal(
            "fetch the message summaries",
            "[SERVERBUG] Internal error"
        ))
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_refused_store_fails_and_keeps_the_draft() {
    let mut mailbox = build_mailbox();
    mailbox.add_refusal("STORE", "NO [READ-ONLY] Mailbox is read-only");
    let stack = start_stack(mailbox, false).await;
    let arguments = DraftIdArguments {
        draft_id: "1.1003.Drafts".to_owned(),
    };

    let first = run_delete_draft(&stack.context, arguments.clone()).await;
    let second = run_delete_draft(&stack.context, arguments).await;

    let refusal = build_refusal("delete the draft", "[READ-ONLY] Mailbox is read-only");
    assert_eq!(first, Err(refusal.clone()));
    assert_eq!(second, Err(refusal));
    let drafts = stack.imap.list_messages("Drafts");
    assert_eq!(drafts.len(), 1);
    assert!(!drafts[0].has_flag("\\Deleted"));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_refused_expunge_fails() {
    let mut mailbox = build_mailbox();
    mailbox.add_refusal("EXPUNGE", "NO Expunge failed");
    let stack = start_stack(mailbox, false).await;

    let deleted = run_delete_draft(
        &stack.context,
        DraftIdArguments {
            draft_id: "1.1003.Drafts".to_owned(),
        },
    )
    .await;

    assert_eq!(
        deleted,
        Err(build_refusal("delete the draft", "Expunge failed"))
    );
    assert_eq!(stack.imap.list_messages("Drafts").len(), 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_refused_capability_fails_before_anything_changes() {
    let mut mailbox = build_mailbox();
    mailbox.add_refusal("CAPABILITY", "BAD Command not allowed now");
    let stack = start_stack(mailbox, false).await;

    let deleted = run_delete_draft(
        &stack.context,
        DraftIdArguments {
            draft_id: "1.1003.Drafts".to_owned(),
        },
    )
    .await;

    assert_eq!(
        deleted,
        Err(build_refusal("delete the draft", "Command not allowed now"))
    );
    let drafts = stack.imap.list_messages("Drafts");
    assert_eq!(drafts.len(), 1);
    assert!(!drafts[0].has_flag("\\Deleted"));
    assert!(
        !stack
            .imap
            .list_commands()
            .iter()
            .any(|command| command.contains("STORE")),
        "{:?}",
        stack.imap.list_commands()
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_refused_fetch_fails_instead_of_reading_as_a_stale_id() {
    let mut mailbox = build_mailbox();
    mailbox.add_refusal("FETCH", "NO [SERVERBUG] Internal error");
    let stack = start_stack(mailbox, false).await;

    let read = run_read_email(
        &stack.context,
        IdArguments {
            id: "1.1001.INBOX".to_owned(),
        },
    )
    .await;

    assert_eq!(
        read,
        Err(build_refusal(
            "fetch the message",
            "[SERVERBUG] Internal error"
        ))
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_refused_examine_fails_each_read_by_id_instead_of_reading_as_a_stale_id() {
    let mut mailbox = build_mailbox();
    mailbox.add_refusal("EXAMINE", "NO [UNAVAILABLE] Try again later");
    let stack = start_stack(mailbox, false).await;
    let id = IdArguments {
        id: "1.1001.INBOX".to_owned(),
    };
    let attachment = AttachmentArguments {
        id: id.id.clone(),
        attachment: 1,
    };

    let read = run_read_email(&stack.context, id.clone()).await;
    let conversation = run_read_conversation(&stack.context, id).await;
    let attachment = run_read_attachment(&stack.context, attachment).await;

    let refusal = build_refusal("select the folder", "[UNAVAILABLE] Try again later");
    assert_eq!(read, Err(refusal.clone()));
    assert_eq!(conversation, Err(refusal.clone()));
    assert_eq!(attachment, Err(refusal));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_refused_fetch_of_a_message_of_the_conversation_fails_instead_of_reading_as_removed() {
    let mut mailbox = build_mailbox();
    let reply = TestMessage {
        subject: "Re: Grüße".to_owned(),
        message_id: "two@example.com".to_owned(),
        in_reply_to: "one@example.com".to_owned(),
        body: "Hello again".to_owned(),
        timestamp: 60,
        ..TestMessage::default()
    };
    mailbox.add_message("INBOX", reply.build_new_message(&[]));
    mailbox.add_line_refusal(
        "UID FETCH 2 (UID FLAGS BODY.PEEK[])",
        "NO [SERVERBUG] Internal error",
    );
    let stack = start_stack(mailbox, false).await;

    let read = run_read_conversation(
        &stack.context,
        IdArguments {
            id: "1.1001.INBOX".to_owned(),
        },
    )
    .await;

    assert_eq!(
        read,
        Err(build_refusal(
            "fetch the message",
            "[SERVERBUG] Internal error"
        ))
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_refused_listing_fails_instead_of_reading_as_no_folder() {
    let mut mailbox = build_mailbox();
    mailbox.add_refusal("LIST", "NO [UNAVAILABLE] Try again later");
    let stack = start_stack(mailbox, false).await;

    let listed = run_list_folders(&stack.context).await;

    assert_eq!(
        listed,
        Err(build_refusal(
            "list the folders",
            "[UNAVAILABLE] Try again later"
        ))
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn refusals_pass_on_the_server_code_and_text() {
    let mut mailbox = build_mailbox();
    mailbox.add_refusal("STATUS", "NO [NOPERM] Permission denied");
    mailbox.add_refusal("CREATE", "NO [ALREADYEXISTS] Mailbox exists");
    let stack = start_stack(mailbox, false).await;

    let counted = run_list_folders(&stack.context).await;
    let created = run_manage_folder(
        &stack.context,
        FolderArguments {
            action: FolderAction::Create,
            name: "Archive".to_owned(),
            new_name: None,
        },
    )
    .await;

    assert_eq!(
        counted,
        Err(build_refusal(
            "count the messages",
            "[NOPERM] Permission denied"
        ))
    );
    assert_eq!(
        created,
        Err(build_refusal(
            "create the folder",
            "[ALREADYEXISTS] Mailbox exists"
        ))
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_refused_rename_or_delete_fails_and_keeps_the_folder() {
    let mut mailbox = build_mailbox();
    mailbox.add_refusal("RENAME", "NO [CANNOT] Rename not allowed");
    mailbox.add_refusal("DELETE", "NO [INUSE] Mailbox in use");
    let stack = start_stack(mailbox, false).await;
    let rename = FolderArguments {
        action: FolderAction::Rename,
        name: "Projects".to_owned(),
        new_name: Some("Archive 2026".to_owned()),
    };
    let delete = FolderArguments {
        action: FolderAction::Delete,
        new_name: None,
        ..rename.clone()
    };

    let renamed = run_manage_folder(&stack.context, rename).await;
    let deleted = run_manage_folder(&stack.context, delete).await;

    assert_eq!(
        renamed,
        Err(build_refusal(
            "rename the folder",
            "[CANNOT] Rename not allowed"
        ))
    );
    assert_eq!(
        deleted,
        Err(build_refusal("delete the folder", "[INUSE] Mailbox in use"))
    );
    assert!(stack.imap.find_folder("Projects").is_some());
    assert!(stack.imap.find_folder("Archive 2026").is_none());
}

#[tokio::test(flavor = "multi_thread")]
async fn a_refused_count_fails_a_delete_before_the_folder_is_deleted() {
    let mut mailbox = build_mailbox();
    mailbox.add_refusal("STATUS", "NO [NOPERM] Permission denied");
    let stack = start_stack(mailbox, false).await;
    let delete = FolderArguments {
        action: FolderAction::Delete,
        name: "Projects".to_owned(),
        new_name: None,
    };

    let deleted = run_manage_folder(&stack.context, delete).await;

    assert_eq!(
        deleted,
        Err(build_refusal(
            "count the messages",
            "[NOPERM] Permission denied"
        ))
    );
    assert!(stack.imap.find_folder("Projects").is_some());
    let commands = stack.imap.list_commands();
    assert!(
        !commands.iter().any(|command| command.contains(" DELETE ")),
        "{commands:?}"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn an_append_refused_before_its_literal_passes_on_the_reason() {
    let mut mailbox = build_mailbox();
    mailbox.add_refusal("APPEND", "NO [OVERQUOTA] Quota exceeded");
    let stack = start_stack(mailbox, false).await;

    let saved = run_save_draft(
        &stack.context,
        SaveDraftArguments {
            to: vec!["jane@example.com".to_owned()],
            subject: "Full".to_owned(),
            body: "No room.".to_owned(),
            ..SaveDraftArguments::default()
        },
        &DraftProgress::default(),
    )
    .await;

    assert_eq!(
        saved,
        Err(build_refusal(
            "save the draft",
            "[OVERQUOTA] Quota exceeded"
        ))
    );
    assert_eq!(stack.imap.list_messages("Drafts").len(), 1);
}
