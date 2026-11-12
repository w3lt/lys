//! The folders the person lets tools use, as the file tools check them.
//!
//! The list is read from the settings file for every call, so a folder the
//! person adds or removes applies to the next call. Each folder is resolved
//! to its real path, with every symbolic link followed, and a file is inside
//! a folder when its real path is the folder's or lies below it by whole
//! components. The backend's tool call policy checks the paths a call names
//! by their text before the call reaches the desktop; this check covers a
//! link inside a folder that points outside it.

use std::{
    fs,
    path::{Path, PathBuf},
};

use crate::settings::{find_settings_file, tools::ApprovedFolder};

#[derive(Debug, Clone, PartialEq, Eq)]
/// Folders the file tools may read in.
pub enum ApprovedFolders {
    /// No folder is listed, so every path is approved.
    Any,
    /// Only a path inside one of these real folder paths is approved. Empty
    /// when the settings file cannot be read or parsed, so the check fails
    /// closed, or when no listed folder can be resolved.
    Listed(Vec<PathBuf>),
}

impl ApprovedFolders {
    /// Reads the folders saved in the settings file at `settings_path`,
    /// without creating or changing the file.
    ///
    /// A missing file and a file without folders give
    /// [`ApprovedFolders::Any`]. A file that cannot be read or parsed gives
    /// [`ApprovedFolders::Listed`] with no folder. A listed folder whose real
    /// path cannot be resolved, such as one that does not exist, approves
    /// nothing.
    pub fn read(settings_path: &Path) -> Self {
        match find_settings_file(settings_path) {
            Ok(None) => Self::Any,
            Ok(Some(settings)) => Self::resolve(settings.tools().approved_folders()),
            Err(_) => Self::Listed(Vec::new()),
        }
    }

    /// Resolves the listed `folders` to their real paths.
    fn resolve<'a>(folders: impl ExactSizeIterator<Item = &'a ApprovedFolder>) -> Self {
        if folders.len() == 0 {
            return Self::Any;
        }

        Self::Listed(
            folders
                .filter_map(|folder| fs::canonicalize(folder.path()).ok())
                .collect(),
        )
    }

    /// Answers whether `real_path`, a path with every symbolic link resolved,
    /// is an approved folder or lies inside one.
    ///
    /// Components are compared whole, so `/work/app-old` is not inside
    /// `/work/app`.
    pub fn holds_real_path(&self, real_path: &Path) -> bool {
        match self {
            Self::Any => true,
            Self::Listed(folders) => folders.iter().any(|folder| real_path.starts_with(folder)),
        }
    }
}

#[cfg(test)]
mod tests {
    use std::{fs, os::unix::fs::symlink, path::Path};

    use serde_json::json;

    use super::ApprovedFolders;
    use crate::tools::test_directory::TestDirectory;

    /// Name of the settings file each test writes in its own directory.
    const SETTINGS_FILE_NAME: &str = "settings.json";

    /// Writes a settings file listing `folders` in `directory` and reads it.
    fn read_listed(directory: &TestDirectory, folders: &[&Path]) -> ApprovedFolders {
        let folders: Vec<String> = folders
            .iter()
            .map(|folder| folder.to_string_lossy().into_owned())
            .collect();
        let settings_path = directory.create_file(
            SETTINGS_FILE_NAME,
            json!({ "tools": { "approvedFolders": folders } }).to_string(),
        );
        ApprovedFolders::read(&settings_path)
    }

    #[test]
    fn approves_every_path_without_a_file_or_a_listed_folder() {
        let directory = TestDirectory::create("approved-any");
        let missing = ApprovedFolders::read(&directory.path().join(SETTINGS_FILE_NAME));
        let empty = read_listed(&directory, &[]);

        assert_eq!(missing, ApprovedFolders::Any);
        assert_eq!(empty, ApprovedFolders::Any);
        assert!(empty.holds_real_path(Path::new("/etc/hosts")));
    }

    #[test]
    fn approves_no_path_when_the_settings_file_cannot_be_parsed() {
        let directory = TestDirectory::create("approved-unreadable");
        let settings_path = directory.create_file(SETTINGS_FILE_NAME, "{ not json");

        let approved = ApprovedFolders::read(&settings_path);

        assert_eq!(approved, ApprovedFolders::Listed(Vec::new()));
        assert!(!approved.holds_real_path(&directory.path().join(SETTINGS_FILE_NAME)));
    }

    #[test]
    fn approves_a_folder_and_what_is_below_it_but_not_beside_or_above_it() {
        let directory = TestDirectory::create("approved-listed");
        let app = directory.create_subdirectory("work/app");
        let app_old = directory.create_subdirectory("work/app-old");
        let real_app = fs::canonicalize(&app).expect("a real folder");
        let real_app_old = fs::canonicalize(&app_old).expect("a real folder");

        let approved = read_listed(&directory, &[&app]);

        assert!(approved.holds_real_path(&real_app));
        assert!(approved.holds_real_path(&real_app.join("src/main.rs")));
        assert!(!approved.holds_real_path(&real_app_old.join("notes.txt")));
        assert!(!approved.holds_real_path(real_app.parent().expect("a parent")));
    }

    #[test]
    fn resolves_a_listed_folder_through_its_links_and_drops_a_missing_one() {
        let directory = TestDirectory::create("approved-linked");
        let app = directory.create_subdirectory("work/app");
        let link = directory.path().join("app-link");
        symlink(&app, &link).expect("a folder link");
        let missing = directory.path().join("missing");

        let approved = read_listed(&directory, &[&link, &missing]);

        assert_eq!(
            approved,
            ApprovedFolders::Listed(vec![fs::canonicalize(&app).expect("a real folder")])
        );
    }
}
