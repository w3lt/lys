//! `list_folders` and `manage_folder` against the fake IMAP server.

use email::failure::ToolFailure;
use email::folders::FolderRole;
use email::tools::folders::{FolderAction, FolderArguments, run_list_folders, run_manage_folder};
use email::tools::{ToolContext, ToolResult};

use crate::support::imap::{FakeFolder, FakeImapServer, FakeMailbox};
use crate::support::{TestMessage, start_stack};

/// Builds the arguments of manage_folder.
///
/// # Arguments
///
/// * `action` - What to do with the folder.
/// * `name` - The folder's name.
/// * `new_name` - The name to rename it to, if any.
fn build_folder_arguments(
    action: FolderAction,
    name: &str,
    new_name: Option<&str>,
) -> FolderArguments {
    FolderArguments {
        action,
        name: name.to_owned(),
        new_name: new_name.map(str::to_owned),
    }
}

/// Deletes a folder with manage_folder.
///
/// # Arguments
///
/// * `context` - The account and trust the tool runs with.
/// * `name` - The folder's name.
async fn delete_folder(context: &ToolContext, name: &str) -> ToolResult {
    let arguments = build_folder_arguments(FolderAction::Delete, name, None);
    run_manage_folder(context, arguments).await
}

/// Lists the commands that create, rename, or delete a folder.
///
/// # Arguments
///
/// * `imap` - The IMAP fake that recorded the commands.
fn list_folder_changes(imap: &FakeImapServer) -> Vec<String> {
    imap.list_commands()
        .into_iter()
        .filter(|command| {
            command.contains(" CREATE ")
                || command.contains(" RENAME ")
                || command.contains(" DELETE ")
        })
        .collect()
}

#[tokio::test(flavor = "multi_thread")]
async fn lists_folders_with_roles_and_counts() {
    let mut mailbox = FakeMailbox::create_standard();
    for number in 1..=2 {
        let message = TestMessage {
            subject: "Hi".to_owned(),
            body: "x".to_owned(),
            message_id: format!("{number}@example.com"),
            timestamp: number,
            ..TestMessage::default()
        };
        mailbox.add_message("INBOX", message.build_new_message(&[]));
    }
    let sent = TestMessage {
        subject: "Sent".to_owned(),
        body: "x".to_owned(),
        message_id: "s@example.com".to_owned(),
        timestamp: 3,
        ..TestMessage::default()
    };
    mailbox.add_message("Sent", sent.build_new_message(&["\\Seen"]));
    let stack = start_stack(mailbox, false).await;

    let report = run_list_folders(&stack.context).await.expect("the folders");

    assert_eq!(
        report.text,
        "- INBOX (Inbox): 2 messages\n- Sent (Sent): 1 message\n- Drafts (Drafts): 0 messages\n- Trash (Trash): 0 messages\n- All Mail (All): 0 messages\n- Projects: 0 messages\n- [Gmail]: cannot hold messages"
    );
    assert_eq!(report.log, "folders: 7 listed");
    let commands = stack.imap.list_commands();
    assert!(
        commands
            .iter()
            .any(|command| command.ends_with("STATUS \"INBOX\" (MESSAGES)")),
        "{commands:?}"
    );
    assert!(
        !commands
            .iter()
            .any(|command| command.contains("STATUS \"[Gmail]\"")),
        "{commands:?}"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn lists_the_junk_and_archive_roles_the_server_declares() {
    let mut mailbox = FakeMailbox::create_standard();
    let unwanted = FakeFolder::new("Unwanted", &["\\HasNoChildren", "\\Junk"], 1008);
    let filed = FakeFolder::new("Filed", &["\\HasNoChildren", "\\Archive"], 1009);
    mailbox.folders.extend([unwanted, filed]);
    let stack = start_stack(mailbox, false).await;

    let report = run_list_folders(&stack.context).await.expect("the folders");

    assert!(
        report
            .text
            .ends_with("\n- Unwanted (Junk): 0 messages\n- Filed (Archive): 0 messages"),
        "{}",
        report.text
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn answers_that_an_account_whose_server_lists_no_folder_has_none() {
    let stack = start_stack(FakeMailbox::create_empty(), false).await;

    let report = run_list_folders(&stack.context).await.expect("the answer");

    assert_eq!(report.text, "The account has no folder.");
    assert_eq!(report.log, "folders: 0 listed");
}

#[tokio::test(flavor = "multi_thread")]
async fn creates_renames_and_deletes_a_folder_with_a_name_that_is_not_ascii() {
    let stack = start_stack(FakeMailbox::create_standard(), false).await;
    let create = build_folder_arguments(FolderAction::Create, "Grüße", None);
    let rename = build_folder_arguments(FolderAction::Rename, "Grüße", Some("Archive 2026"));

    let created = run_manage_folder(&stack.context, create).await;
    let listed = run_list_folders(&stack.context).await.expect("the folders");
    let renamed = run_manage_folder(&stack.context, rename).await;
    let deleted = delete_folder(&stack.context, "Archive 2026").await;

    assert_eq!(
        created.map(|report| (report.text, report.log)),
        Ok((
            "Folder Grüße created.".to_owned(),
            "folder: created".to_owned()
        ))
    );
    assert!(
        listed.text.contains("\n- Grüße: 0 messages"),
        "{}",
        listed.text
    );
    assert_eq!(
        renamed.map(|report| (report.text, report.log)),
        Ok((
            "Folder Grüße renamed to Archive 2026.".to_owned(),
            "folder: renamed".to_owned()
        ))
    );
    assert_eq!(
        deleted.map(|report| (report.text, report.log)),
        Ok((
            "Folder Archive 2026 deleted.".to_owned(),
            "folder: deleted".to_owned()
        ))
    );
    let changes = list_folder_changes(&stack.imap);
    assert_eq!(changes.len(), 3, "{changes:?}");
    assert!(
        changes[0].ends_with(" CREATE \"Gr&APwA3w-e\""),
        "{changes:?}"
    );
    assert!(
        changes[1].ends_with(" RENAME \"Gr&APwA3w-e\" \"Archive 2026\""),
        "{changes:?}"
    );
    assert!(
        changes[2].ends_with(" DELETE \"Archive 2026\""),
        "{changes:?}"
    );
    assert!(stack.imap.find_folder("Archive 2026").is_none());
}

#[tokio::test(flavor = "multi_thread")]
async fn refuses_to_change_role_folders_or_to_take_a_name_in_use() {
    let stack = start_stack(FakeMailbox::create_standard(), false).await;
    let change = |action: FolderAction, name: &str, new_name: Option<&str>| {
        run_manage_folder(
            &stack.context,
            build_folder_arguments(action, name, new_name),
        )
    };

    let renamed_inbox = change(FolderAction::Rename, "INBOX", Some("Old")).await;
    let deleted_sent = change(FolderAction::Delete, "Sent", None).await;
    let created_twice = change(FolderAction::Create, "Projects", None).await;
    let renamed_onto_inbox = change(FolderAction::Rename, "Projects", Some("inbox")).await;

    assert_eq!(
        renamed_inbox,
        Err(ToolFailure::RoleFolder {
            name: "INBOX".to_owned(),
            role: FolderRole::Inbox
        })
    );
    assert_eq!(
        deleted_sent,
        Err(ToolFailure::RoleFolder {
            name: "Sent".to_owned(),
            role: FolderRole::Sent
        })
    );
    assert_eq!(
        created_twice,
        Err(ToolFailure::FolderExists("Projects".to_owned()))
    );
    assert_eq!(
        renamed_onto_inbox,
        Err(ToolFailure::FolderExists("inbox".to_owned()))
    );
    assert_eq!(list_folder_changes(&stack.imap), Vec::<String>::new());
}

#[tokio::test(flavor = "multi_thread")]
async fn refuses_missing_folders_folders_that_hold_messages_and_unusable_names() {
    let mut mailbox = FakeMailbox::create_standard();
    let message = TestMessage {
        subject: "Plan".to_owned(),
        body: "x".to_owned(),
        message_id: "p@example.com".to_owned(),
        timestamp: 1,
        ..TestMessage::default()
    };
    mailbox.add_message("Projects", message.build_new_message(&[]));
    let stack = start_stack(mailbox, false).await;
    let change = |action: FolderAction, name: &str, new_name: Option<&str>| {
        run_manage_folder(
            &stack.context,
            build_folder_arguments(action, name, new_name),
        )
    };

    let deleted_full = change(FolderAction::Delete, "Projects", None).await;
    let deleted_missing = change(FolderAction::Delete, "Nowhere", None).await;
    let renamed_to_nothing = change(FolderAction::Rename, "Projects", None).await;
    let created_spaced = change(FolderAction::Create, " Spaced", None).await;

    assert_eq!(
        deleted_full,
        Err(ToolFailure::FolderNotEmpty("Projects".to_owned()))
    );
    assert_eq!(
        deleted_missing,
        Err(ToolFailure::FolderMissing("Nowhere".to_owned()))
    );
    assert_eq!(
        renamed_to_nothing,
        Err(ToolFailure::Argument(
            "new_name is required to rename a folder.".to_owned()
        ))
    );
    assert_eq!(
        created_spaced,
        Err(ToolFailure::Argument(
            "name must be a folder name without whitespace at its edges.".to_owned()
        ))
    );
    assert_eq!(list_folder_changes(&stack.imap), Vec::<String>::new());
}

#[tokio::test(flavor = "multi_thread")]
async fn refuses_to_delete_a_folder_that_holds_other_folders() {
    let mut mailbox = FakeMailbox::create_standard();
    let projects = mailbox.find_folder_mut("Projects").expect("the folder");
    projects.attributes = vec!["\\HasChildren".to_owned()];
    let inner = FakeFolder::new("Projects/2026", &["\\HasNoChildren"], 1010);
    mailbox.folders.push(inner);
    let stack = start_stack(mailbox, false).await;

    let refused = delete_folder(&stack.context, "Projects").await;
    let inner_deleted = delete_folder(&stack.context, "Projects/2026").await;
    let outer_deleted = delete_folder(&stack.context, "Projects").await;

    assert_eq!(
        refused.as_ref().map_err(ToolFailure::class),
        Err("folder-has-subfolders".to_owned())
    );
    assert_eq!(
        refused.map_err(|failure| failure.to_string()),
        Err("Projects holds other folders, so it cannot be deleted. Delete them first.".to_owned())
    );
    assert_eq!(
        inner_deleted.map(|report| report.text),
        Ok("Folder Projects/2026 deleted.".to_owned())
    );
    assert_eq!(
        outer_deleted.map(|report| report.text),
        Ok("Folder Projects deleted.".to_owned())
    );
    let deletions: Vec<String> = stack
        .imap
        .list_commands()
        .into_iter()
        .filter(|command| command.contains(" DELETE "))
        .collect();
    assert_eq!(deletions.len(), 2, "{deletions:?}");
    assert!(
        deletions[0].ends_with(" DELETE \"Projects/2026\""),
        "{deletions:?}"
    );
}
