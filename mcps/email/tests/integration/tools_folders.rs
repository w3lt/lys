//! `list_folders` and `manage_folder` against the fake IMAP server.

use email::failure::ToolFailure;
use email::folders::FolderRole;
use email::tools::ToolResult;
use email::tools::folders::{FolderAction, FolderArguments, run_list_folders, run_manage_folder};

use crate::support::imap::{FakeFolder, FakeMailbox};
use crate::support::{Stack, TestMessage, start_stack};

/// Deletes a folder with manage_folder.
///
/// # Arguments
///
/// * `stack` - The running fakes and the tools' context.
/// * `name` - The folder's name.
async fn delete_folder(stack: &Stack, name: &str) -> ToolResult {
    let arguments = FolderArguments {
        action: FolderAction::Delete,
        name: name.to_owned(),
        new_name: None,
    };
    run_manage_folder(&stack.context, arguments).await
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
async fn creates_renames_and_deletes_a_folder_with_a_name_that_is_not_ascii() {
    let stack = start_stack(FakeMailbox::create_standard(), false).await;

    let created = run_manage_folder(
        &stack.context,
        FolderArguments {
            action: FolderAction::Create,
            name: "Grüße".to_owned(),
            new_name: None,
        },
    )
    .await
    .expect("created");
    let listed = run_list_folders(&stack.context).await.expect("the folders");
    let renamed = run_manage_folder(
        &stack.context,
        FolderArguments {
            action: FolderAction::Rename,
            name: "Grüße".to_owned(),
            new_name: Some("Archive 2026".to_owned()),
        },
    )
    .await
    .expect("renamed");
    let deleted = run_manage_folder(
        &stack.context,
        FolderArguments {
            action: FolderAction::Delete,
            name: "Archive 2026".to_owned(),
            new_name: None,
        },
    )
    .await
    .expect("deleted");

    assert_eq!(created.text, "Folder Grüße created.");
    assert!(
        listed.text.contains("\n- Grüße: 0 messages"),
        "{}",
        listed.text
    );
    assert_eq!(renamed.text, "Folder Grüße renamed to Archive 2026.");
    assert_eq!(deleted.text, "Folder Archive 2026 deleted.");
    let commands = stack.imap.list_commands();
    assert!(
        commands
            .iter()
            .any(|command| command.ends_with("CREATE \"Gr&APwA3w-e\"")),
        "{commands:?}"
    );
    assert!(
        commands
            .iter()
            .any(|command| command.ends_with("RENAME \"Gr&APwA3w-e\" \"Archive 2026\"")),
        "{commands:?}"
    );
    assert!(
        commands
            .iter()
            .any(|command| command.ends_with("DELETE \"Archive 2026\"")),
        "{commands:?}"
    );
    assert!(stack.imap.find_folder("Archive 2026").is_none());
}

#[tokio::test(flavor = "multi_thread")]
async fn refuses_role_folders_taken_names_missing_folders_and_folders_that_hold_messages() {
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
            FolderArguments {
                action,
                name: name.to_owned(),
                new_name: new_name.map(str::to_owned),
            },
        )
    };

    assert_eq!(
        change(FolderAction::Rename, "INBOX", Some("Old")).await,
        Err(ToolFailure::RoleFolder {
            name: "INBOX".to_owned(),
            role: FolderRole::Inbox
        })
    );
    assert_eq!(
        change(FolderAction::Delete, "Sent", None).await,
        Err(ToolFailure::RoleFolder {
            name: "Sent".to_owned(),
            role: FolderRole::Sent
        })
    );
    assert_eq!(
        change(FolderAction::Create, "Projects", None).await,
        Err(ToolFailure::FolderExists("Projects".to_owned()))
    );
    assert_eq!(
        change(FolderAction::Rename, "Projects", Some("inbox")).await,
        Err(ToolFailure::FolderExists("inbox".to_owned()))
    );
    assert_eq!(
        change(FolderAction::Delete, "Projects", None).await,
        Err(ToolFailure::FolderNotEmpty("Projects".to_owned()))
    );
    assert_eq!(
        change(FolderAction::Delete, "Nowhere", None).await,
        Err(ToolFailure::FolderMissing("Nowhere".to_owned()))
    );
    assert_eq!(
        change(FolderAction::Rename, "Projects", None).await,
        Err(ToolFailure::Argument(
            "new_name is required to rename a folder.".to_owned()
        ))
    );
    assert_eq!(
        change(FolderAction::Create, " Spaced", None).await,
        Err(ToolFailure::Argument(
            "name must be a folder name without whitespace at its edges.".to_owned()
        ))
    );
    assert!(!stack.imap.list_commands().iter().any(|command| {
        command.contains(" CREATE ") || command.contains(" RENAME ") || command.contains(" DELETE ")
    }));
}

#[tokio::test(flavor = "multi_thread")]
async fn refuses_to_delete_a_folder_that_holds_other_folders() {
    let mut mailbox = FakeMailbox::create_standard();
    let projects = mailbox.find_folder_mut("Projects").expect("the folder");
    projects.attributes = vec!["\\HasChildren".to_owned()];
    let inner = FakeFolder::new("Projects/2026", &["\\HasNoChildren"], 1010);
    mailbox.folders.push(inner);
    let stack = start_stack(mailbox, false).await;

    let refused = delete_folder(&stack, "Projects").await;
    let inner_deleted = delete_folder(&stack, "Projects/2026").await;
    let outer_deleted = delete_folder(&stack, "Projects").await;

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
