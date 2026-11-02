//! `list_folders` and `manage_folder`: the folders, their roles and
//! counts, and creating, renaming, or deleting one.

use schemars::JsonSchema;
use serde::Deserialize;

use super::{
    ToolContext, ToolReport, ToolResult, check_folder_name_argument, imap_failure, load_folders,
    require_folder,
};
use crate::failure::ToolFailure;
use crate::folder_name::encode_folder_name;
use crate::folders::{Folder, find_folder};

/// What `manage_folder` does.
#[derive(Clone, Copy, Debug, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum FolderAction {
    /// Creates a folder.
    Create,
    /// Renames a folder.
    Rename,
    /// Deletes an empty folder.
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
pub async fn list_folders(context: &ToolContext) -> ToolResult {
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
                .count_messages(&folder.raw_name)
                .await
                .map_err(imap_failure("count the messages"))?;
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
pub async fn manage_folder(context: &ToolContext, arguments: FolderArguments) -> ToolResult {
    check_folder_name_argument("name", &arguments.name)?;
    if let Some(new_name) = &arguments.new_name {
        check_folder_name_argument("new_name", new_name)?;
    }
    let mut session = context.open_imap().await?;
    let folders = load_folders(&mut session).await?;
    let report = match arguments.action {
        FolderAction::Create => {
            if find_folder(&folders, &arguments.name).is_some() {
                return Err(ToolFailure::FolderExists(arguments.name));
            }
            session
                .create_folder(&encode_folder_name(&arguments.name))
                .await
                .map_err(imap_failure("create the folder"))?;
            ToolReport {
                text: format!("Folder {} created.", arguments.name),
                log: "folder: created".to_owned(),
            }
        }
        FolderAction::Rename => {
            let new_name = arguments.new_name.ok_or_else(|| {
                ToolFailure::Argument("new_name is required to rename a folder.".to_owned())
            })?;
            let folder = require_folder(&folders, &arguments.name)?;
            refuse_role_folder(folder)?;
            if find_folder(&folders, &new_name).is_some() {
                return Err(ToolFailure::FolderExists(new_name));
            }
            session
                .rename_folder(&folder.raw_name, &encode_folder_name(&new_name))
                .await
                .map_err(imap_failure("rename the folder"))?;
            ToolReport {
                text: format!("Folder {} renamed to {new_name}.", folder.name),
                log: "folder: renamed".to_owned(),
            }
        }
        FolderAction::Delete => {
            let folder = require_folder(&folders, &arguments.name)?;
            refuse_role_folder(folder)?;
            if folder.selectable {
                let count = session
                    .count_messages(&folder.raw_name)
                    .await
                    .map_err(imap_failure("count the messages"))?;
                if count > 0 {
                    return Err(ToolFailure::FolderNotEmpty(folder.name.clone()));
                }
            }
            session
                .delete_folder(&folder.raw_name)
                .await
                .map_err(imap_failure("delete the folder"))?;
            ToolReport {
                text: format!("Folder {} deleted.", folder.name),
                log: "folder: deleted".to_owned(),
            }
        }
    };
    session.close().await;
    Ok(report)
}

/// Refuses to change a folder that has a role.
fn refuse_role_folder(folder: &Folder) -> Result<(), ToolFailure> {
    match folder.role {
        Some(role) => Err(ToolFailure::RoleFolder {
            name: folder.name.clone(),
            role,
        }),
        None => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::folders::FolderRole;

    #[test]
    fn refuses_role_folders_only() {
        let inbox = Folder {
            name: "INBOX".to_owned(),
            raw_name: "INBOX".to_owned(),
            role: Some(FolderRole::Inbox),
            selectable: true,
        };
        let projects = Folder {
            name: "Projects".to_owned(),
            raw_name: "Projects".to_owned(),
            role: None,
            selectable: true,
        };

        assert_eq!(
            refuse_role_folder(&inbox),
            Err(ToolFailure::RoleFolder {
                name: "INBOX".to_owned(),
                role: FolderRole::Inbox
            })
        );
        assert_eq!(refuse_role_folder(&projects), Ok(()));
    }

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
