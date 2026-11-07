//! Folders and their roles: Inbox, Sent, Drafts, Trash, Junk, Archive,
//! and All.
//!
//! A role comes from the server's `LIST` attributes (RFC 6154) first, then
//! from the folder's name, as mail clients do for servers without the
//! extension. Each role is given to one folder at most.

use crate::folder_name::parse_encoded_folder_name;

/// What a folder is for.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FolderRole {
    /// Where new mail arrives.
    Inbox,
    /// Where sent mail is kept.
    Sent,
    /// Where unsent drafts are kept.
    Drafts,
    /// Where deleted mail waits.
    Trash,
    /// Where unwanted mail is put.
    Junk,
    /// Where read mail is filed.
    Archive,
    /// A view of every message (Gmail's All Mail), which searches skip.
    All,
}

impl FolderRole {
    /// Every role, in the order roles are given.
    const ALL_ROLES: [Self; 7] = [
        Self::Inbox,
        Self::Sent,
        Self::Drafts,
        Self::Trash,
        Self::Junk,
        Self::Archive,
        Self::All,
    ];

    /// Returns the role's name as shown to the model.
    pub fn name(self) -> &'static str {
        match self {
            Self::Inbox => "Inbox",
            Self::Sent => "Sent",
            Self::Drafts => "Drafts",
            Self::Trash => "Trash",
            Self::Junk => "Junk",
            Self::Archive => "Archive",
            Self::All => "All",
        }
    }

    /// Whether a folder of the role holds messages of its own, which a
    /// search of every folder reads; an All Mail view shows the messages
    /// the other folders hold.
    pub fn has_own_messages(self) -> bool {
        match self {
            Self::Inbox | Self::Sent | Self::Drafts | Self::Trash | Self::Junk | Self::Archive => {
                true
            }
            Self::All => false,
        }
    }

    /// Finds the role a `LIST` attribute declares.
    fn find_for_attribute(attribute: &str) -> Option<Self> {
        match attribute.to_ascii_lowercase().as_str() {
            "\\sent" => Some(Self::Sent),
            "\\drafts" => Some(Self::Drafts),
            "\\trash" => Some(Self::Trash),
            "\\junk" => Some(Self::Junk),
            "\\archive" => Some(Self::Archive),
            "\\all" => Some(Self::All),
            "\\inbox" => Some(Self::Inbox),
            _ => None,
        }
    }

    /// Finds the role a folder's name suggests, by its last path component.
    fn find_for_name(name: &str, delimiter: Option<&str>) -> Option<Self> {
        if name.eq_ignore_ascii_case("INBOX") {
            return Some(Self::Inbox);
        }
        let last = delimiter
            .filter(|delimiter| !delimiter.is_empty())
            .and_then(|delimiter| name.rsplit(delimiter).next())
            .unwrap_or(name)
            .to_lowercase();
        match last.as_str() {
            "sent" | "sent items" | "sent messages" | "sent mail" | "gesendet"
            | "gesendete objekte" => Some(Self::Sent),
            "drafts" | "draft" | "entwürfe" => Some(Self::Drafts),
            "trash" | "deleted items" | "deleted messages" | "deleted" | "bin" | "papierkorb" => {
                Some(Self::Trash)
            }
            "junk" | "spam" | "junk e-mail" | "junk email" => Some(Self::Junk),
            "archive" | "archives" | "archiv" => Some(Self::Archive),
            "all mail" => Some(Self::All),
            _ => None,
        }
    }
}

/// One folder as the server listed it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FolderListing {
    /// The name as the server wrote it, for commands.
    pub raw_name: String,
    /// The `LIST` attributes, such as `\Noselect` or `\Sent`.
    pub attributes: Vec<String>,
    /// The hierarchy delimiter, when the server has one.
    pub delimiter: Option<String>,
}

/// One folder as the tools see it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Folder {
    /// The name as the person and the model see it.
    pub name: String,
    /// The name as the server wrote it, for commands.
    pub raw_name: String,
    /// What the folder is for, when it has a role.
    pub role: Option<FolderRole>,
    /// Whether messages can be read from it (`\Noselect` is absent).
    pub selectable: bool,
    /// The hierarchy delimiter the server listed it with, when it has one.
    pub delimiter: Option<String>,
}

/// Builds the folders from the server's listing, giving each role to one
/// folder at most: the one declaring it in its attributes, else the first
/// whose name suggests it.
///
/// # Arguments
///
/// * `listings` - The server's `LIST` responses, in the server's order.
pub fn build_folders(listings: &[FolderListing]) -> Vec<Folder> {
    let mut folders: Vec<Folder> = listings.iter().map(build_folder).collect();
    for role in FolderRole::ALL_ROLES {
        let by_attribute = listings.iter().position(|listing| {
            listing
                .attributes
                .iter()
                .any(|attribute| FolderRole::find_for_attribute(attribute) == Some(role))
        });
        let by_name = || {
            listings.iter().enumerate().position(|(index, listing)| {
                folders[index].role.is_none()
                    && FolderRole::find_for_name(&folders[index].name, listing.delimiter.as_deref())
                        == Some(role)
            })
        };
        if let Some(index) = by_attribute.or_else(by_name)
            && folders[index].role.is_none()
        {
            folders[index].role = Some(role);
        }
    }
    folders
}

/// Builds a folder from its listing, still without a role.
fn build_folder(listing: &FolderListing) -> Folder {
    Folder {
        name: parse_encoded_folder_name(&listing.raw_name),
        raw_name: listing.raw_name.clone(),
        role: None,
        selectable: !listing
            .attributes
            .iter()
            .any(|attribute| attribute.eq_ignore_ascii_case("\\Noselect")),
        delimiter: listing.delimiter.clone(),
    }
}

/// Finds the folder with the name, as the person and the model see it;
/// `INBOX` matches in any letter case, as IMAP defines it.
///
/// # Arguments
///
/// * `folders` - The classified folders.
/// * `name` - The name asked for.
pub fn find_folder<'a>(folders: &'a [Folder], name: &str) -> Option<&'a Folder> {
    let exact = folders.iter().find(|folder| folder.name == name);
    if exact.is_some() || !name.eq_ignore_ascii_case("INBOX") {
        return exact;
    }
    folders
        .iter()
        .find(|folder| folder.name.eq_ignore_ascii_case("INBOX"))
}

/// Calculates whether other listed folders are inside a folder: their
/// names start with its name and its hierarchy delimiter. A folder listed
/// without a delimiter has none.
///
/// # Arguments
///
/// * `folders` - The classified folders, as the server listed them all.
/// * `folder` - The folder.
pub fn has_subfolders(folders: &[Folder], folder: &Folder) -> bool {
    let Some(delimiter) = &folder.delimiter else {
        return false;
    };
    let prefix = format!("{}{delimiter}", folder.raw_name);
    folders
        .iter()
        .any(|other| other.raw_name.starts_with(&prefix))
}

/// Finds the folder with the role.
///
/// # Arguments
///
/// * `folders` - The classified folders.
/// * `role` - The role asked for.
pub fn find_role_folder(folders: &[Folder], role: FolderRole) -> Option<&Folder> {
    folders.iter().find(|folder| folder.role == Some(role))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Builds a listing with the attributes.
    fn build_listing(raw_name: &str, attributes: &[&str]) -> FolderListing {
        FolderListing {
            raw_name: raw_name.to_owned(),
            attributes: attributes
                .iter()
                .map(|attribute| (*attribute).to_owned())
                .collect(),
            delimiter: Some("/".to_owned()),
        }
    }

    #[test]
    fn gives_roles_by_attribute_before_name_and_each_role_once() {
        let listings = [
            build_listing("INBOX", &["\\HasNoChildren"]),
            build_listing("Sent", &[]),
            build_listing("[Gmail]", &["\\Noselect", "\\HasChildren"]),
            build_listing("[Gmail]/Sent Mail", &["\\Sent"]),
            build_listing("[Gmail]/All Mail", &["\\All"]),
            build_listing("Entw&APw-rfe", &[]),
            build_listing("Projects/Trash", &[]),
            build_listing("Deleted Items", &["\\Trash"]),
        ];

        let folders = build_folders(&listings);

        let roles: Vec<(&str, Option<FolderRole>, bool)> = folders
            .iter()
            .map(|folder| (folder.name.as_str(), folder.role, folder.selectable))
            .collect();
        assert_eq!(
            roles,
            vec![
                ("INBOX", Some(FolderRole::Inbox), true),
                ("Sent", None, true),
                ("[Gmail]", None, false),
                ("[Gmail]/Sent Mail", Some(FolderRole::Sent), true),
                ("[Gmail]/All Mail", Some(FolderRole::All), true),
                ("Entwürfe", Some(FolderRole::Drafts), true),
                ("Projects/Trash", None, true),
                ("Deleted Items", Some(FolderRole::Trash), true),
            ]
        );
        assert_eq!(folders[5].raw_name, "Entw&APw-rfe");
        assert_eq!(find_role_folder(&folders, FolderRole::Junk), None);
        assert_eq!(
            find_role_folder(&folders, FolderRole::Sent).map(|folder| folder.name.as_str()),
            Some("[Gmail]/Sent Mail")
        );
    }

    #[test]
    fn says_that_every_role_but_the_all_view_holds_messages_of_its_own() {
        let answers: Vec<(FolderRole, bool)> = FolderRole::ALL_ROLES
            .into_iter()
            .map(|role| (role, role.has_own_messages()))
            .collect();

        assert_eq!(
            answers,
            vec![
                (FolderRole::Inbox, true),
                (FolderRole::Sent, true),
                (FolderRole::Drafts, true),
                (FolderRole::Trash, true),
                (FolderRole::Junk, true),
                (FolderRole::Archive, true),
                (FolderRole::All, false),
            ]
        );
    }

    #[test]
    fn finds_folders_by_name_with_inbox_in_any_case() {
        let folders = build_folders(&[build_listing("INBOX", &[]), build_listing("Sent", &[])]);

        assert_eq!(
            find_folder(&folders, "inbox").map(|folder| folder.name.as_str()),
            Some("INBOX")
        );
        assert_eq!(
            find_folder(&folders, "Sent").map(|folder| folder.name.as_str()),
            Some("Sent")
        );
        assert_eq!(find_folder(&folders, "sent"), None);
    }

    #[test]
    fn finds_subfolders_only_below_the_folder_name_and_its_delimiter() {
        let flat = FolderListing {
            delimiter: None,
            ..build_listing("Flat", &[])
        };
        let folders = build_folders(&[
            build_listing("Projects", &[]),
            build_listing("Projects/2026", &[]),
            build_listing("Notes", &[]),
            build_listing("Notes 2025", &[]),
            flat,
            build_listing("Flat/Inside", &[]),
        ]);

        let with_subfolders: Vec<&str> = folders
            .iter()
            .filter(|folder| has_subfolders(&folders, folder))
            .map(|folder| folder.name.as_str())
            .collect();
        assert_eq!(with_subfolders, vec!["Projects"]);
    }
}
