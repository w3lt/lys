//! `list_folders` and `manage_folder`: the folders, their roles and
//! counts, and creating, renaming, or deleting one.

use schemars::JsonSchema;
use serde::Deserialize;

use super::{
    ToolContext, ToolReport, ToolResult, build_imap_failure_conversion, get_changeable_folder,
    load_folders, parse_folder_name_argument,
};
use crate::failure::ToolFailure;
use crate::folder_name::build_encoded_folder_name;
use crate::folders::{Folder, find_folder, has_subfolders};
use crate::imap::ImapSession;

/// What `manage_folder` does.
#[derive(Clone, Copy, Debug, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum FolderAction {
    /// Creates a folder.
    Create,
    /// Renames a folder.
    Rename,
    /// Deletes a folder that holds no message and no other folder.
    Delete,
}

/// The arguments of `manage_folder`.
#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct FolderArguments {
    /// What to do: create, rename, or delete.
    pub action: FolderAction,
    /// The folder's name: the new folder's for create, the existing folder's otherwise.
    pub name: String,
    /// The new name, for rename.
    #[serde(default)]
    pub new_name: Option<String>,
}

/// Lists every folder with its role and message count.
///
/// # Arguments
///
/// * `context` - The account and trust.
///
/// # Returns
///
/// The report: each folder with its role and how many messages it holds,
/// or that it cannot hold any, or that the account has no folder;
/// otherwise `SignIn` when signing in to the IMAP server failed, or the
/// server's refusal of the listing or of a count (`ImapRefused`) or a
/// failure of the IMAP connection (`Connection`).
pub async fn run_list_folders(context: &ToolContext) -> ToolResult {
    let mut session = context.open_imap().await?;
    let folders = load_folders(&mut session).await?;
    let mut lines = Vec::with_capacity(folders.len());
    for folder in &folders {
        let mut line = format!("- {}", folder.name);
        if let Some(role) = folder.role {
            line.push_str(&format!(" ({})", role.name()));
        }
        if folder.selectable {
            let count = session
                .get_message_count(&folder.raw_name)
                .await
                .map_err(build_imap_failure_conversion("count the messages"))?;
            line.push_str(&format!(
                ": {count} {}",
                if count == 1 { "message" } else { "messages" }
            ));
        } else {
            line.push_str(": cannot hold messages");
        }
        lines.push(line);
    }
    session.close().await;
    Ok(ToolReport {
        text: if lines.is_empty() {
            "The account has no folder.".to_owned()
        } else {
            lines.join("\n")
        },
        log: format!("folders: {} listed", folders.len()),
    })
}

/// Creates, renames, or deletes a folder.
///
/// # Arguments
///
/// * `context` - The account and trust.
/// * `arguments` - What to do with which folder.
///
/// # Returns
///
/// The report of what was done; otherwise `Argument` for a name that
/// breaks the folder name rules, or a rename without `new_name`; `SignIn`
/// when signing in to the IMAP server failed; `FolderMissing` when no
/// folder has the name to rename or delete; `RoleFolder` when that folder
/// has a role; `FolderExists` when a folder already has the name to
/// create, or the new name; `FolderHasSubfolders` or `FolderNotEmpty` for
/// a folder to delete that holds other folders or messages; or the
/// server's refusal (`ImapRefused`) or a failure of the IMAP connection
/// (`Connection`).
pub async fn run_manage_folder(context: &ToolContext, arguments: FolderArguments) -> ToolResult {
    parse_folder_name_argument("name", &arguments.name)?;
    if let Some(new_name) = &arguments.new_name {
        parse_folder_name_argument("new_name", new_name)?;
    }
    let mut session = context.open_imap().await?;
    let folders = load_folders(&mut session).await?;
    let report = match arguments.action {
        FolderAction::Create => create_new_folder(&mut session, &folders, &arguments.name).await?,
        FolderAction::Rename => update_folder_name(&mut session, &folders, &arguments).await?,
        FolderAction::Delete => {
            delete_empty_folder(&mut session, &folders, &arguments.name).await?
        }
    };
    session.close().await;
    Ok(report)
}

/// Creates a folder no folder has the name of.
///
/// # Arguments
///
/// * `session` - The signed-in session.
/// * `folders` - The classified folders.
/// * `name` - The new folder's name.
///
/// # Returns
///
/// The report; otherwise `FolderExists` when a folder has the name, or
/// the server's refusal of the CREATE (`ImapRefused`) or a failure of the
/// IMAP connection (`Connection`).
async fn create_new_folder(
    session: &mut ImapSession,
    folders: &[Folder],
    name: &str,
) -> Result<ToolReport, ToolFailure> {
    if find_folder(folders, name).is_some() {
        return Err(ToolFailure::FolderExists(name.to_owned()));
    }
    session
        .create_folder(&build_encoded_folder_name(name))
        .await
        .map_err(build_imap_failure_conversion("create the folder"))?;
    Ok(ToolReport {
        text: format!("Folder {name} created."),
        log: "folder: created".to_owned(),
    })
}

/// Renames a folder without a role to a name no folder has.
///
/// # Arguments
///
/// * `session` - The signed-in session.
/// * `folders` - The classified folders.
/// * `arguments` - The folder's name and its new name.
///
/// # Returns
///
/// The report; otherwise `Argument` when no new name is given;
/// `FolderMissing` when no folder has the name; `RoleFolder` when the
/// folder has a role; `FolderExists` when a folder has the new name; or
/// the server's refusal of the RENAME (`ImapRefused`) or a failure of the
/// IMAP connection (`Connection`).
async fn update_folder_name(
    session: &mut ImapSession,
    folders: &[Folder],
    arguments: &FolderArguments,
) -> Result<ToolReport, ToolFailure> {
    let new_name = arguments.new_name.as_deref().ok_or_else(|| {
        ToolFailure::Argument("new_name is required to rename a folder.".to_owned())
    })?;
    let folder = get_changeable_folder(folders, &arguments.name)?;
    if find_folder(folders, new_name).is_some() {
        return Err(ToolFailure::FolderExists(new_name.to_owned()));
    }
    session
        .update_folder_name(&folder.raw_name, &build_encoded_folder_name(new_name))
        .await
        .map_err(build_imap_failure_conversion("rename the folder"))?;
    Ok(ToolReport {
        text: format!("Folder {} renamed to {new_name}.", folder.name),
        log: "folder: renamed".to_owned(),
    })
}

/// Deletes a folder without a role that holds no message and no other
/// folder: some servers delete the folders inside a folder with it, and
/// others keep them, so a folder with subfolders is refused either way.
///
/// # Arguments
///
/// * `session` - The signed-in session.
/// * `folders` - The classified folders.
/// * `name` - The folder's name.
///
/// # Returns
///
/// The report; otherwise `FolderMissing` when no folder has the name;
/// `RoleFolder` when the folder has a role; `FolderHasSubfolders` when it
/// holds other folders; `FolderNotEmpty` when it holds messages; or the
/// server's refusal of the count or the DELETE (`ImapRefused`) or a
/// failure of the IMAP connection (`Connection`).
async fn delete_empty_folder(
    session: &mut ImapSession,
    folders: &[Folder],
    name: &str,
) -> Result<ToolReport, ToolFailure> {
    let folder = get_changeable_folder(folders, name)?;
    if has_subfolders(folders, folder) {
        return Err(ToolFailure::FolderHasSubfolders(folder.name.clone()));
    }
    if folder.selectable {
        let count = session
            .get_message_count(&folder.raw_name)
            .await
            .map_err(build_imap_failure_conversion("count the messages"))?;
        if count > 0 {
            return Err(ToolFailure::FolderNotEmpty(folder.name.clone()));
        }
    }
    session
        .delete_folder(&folder.raw_name)
        .await
        .map_err(build_imap_failure_conversion("delete the folder"))?;
    Ok(ToolReport {
        text: format!("Folder {} deleted.", folder.name),
        log: "folder: deleted".to_owned(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Checks that `manage_folder` reads its action by name, such as
    /// `rename`, and refuses an unknown action or an unknown argument.
    #[test]
    fn parses_the_action_names() {
        let arguments: FolderArguments =
            serde_json::from_str(r#"{"action":"rename","name":"A","new_name":"B"}"#)
                .expect("arguments");

        assert_eq!(arguments.action, FolderAction::Rename);
        assert!(
            serde_json::from_str::<FolderArguments>(r#"{"action":"move","name":"A"}"#).is_err()
        );
        assert!(
            serde_json::from_str::<FolderArguments>(r#"{"action":"create","name":"A","extra":1}"#)
                .is_err()
        );
    }
}
