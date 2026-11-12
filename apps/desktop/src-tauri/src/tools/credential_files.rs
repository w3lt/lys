//! The private key and credential files that the file tools never read or
//! list, decided by a file's real path.
//!
//! The names come from `packages/protocol/src/tools/credentialFiles.json`,
//! which the backend's tool call policy reads too, so both sides refuse the
//! same names. Lys's own settings file, which holds its API keys and
//! passwords, is recognized by its identity on disk instead of its name.

use std::{
    ffi::OsStr,
    fs::{self, Metadata},
    os::unix::fs::MetadataExt,
    path::{Component, Path, PathBuf},
    sync::Arc,
};

use serde::Deserialize;

/// The shared credential file list, embedded when the host is built.
const CREDENTIAL_FILE_LIST_JSON: &str =
    include_str!("../../../../../packages/protocol/src/tools/credentialFiles.json");

/// Private key and credential file names, in lowercase, as the shared list
/// holds them.
///
/// The backend's `CREDENTIAL_FILE_LIST` checks that every name is lowercase,
/// non-empty, without a path separator, and listed once; this reader only
/// requires the list's shape.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CredentialFileList {
    /// Folders whose every file is a private key or credential.
    folder_names: Vec<String>,
    /// Names of private keys and of files that hold passwords or tokens.
    file_names: Vec<String>,
    /// Starts of such file names, such as `.env.`.
    file_name_prefixes: Vec<String>,
    /// Ends of such file names, such as `.pem`.
    file_name_endings: Vec<String>,
}

/// Identity of one file on this machine: its device and inode numbers.
///
/// Every path and hard link that leads to a file shares its identity.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FileIdentity {
    /// Number of the device that holds the file.
    device: u64,
    /// Number of the file on its device.
    inode: u64,
}

impl FileIdentity {
    /// Returns the identity of the file that `metadata` describes.
    pub fn of(metadata: &Metadata) -> Self {
        Self {
            device: metadata.dev(),
            inode: metadata.ino(),
        }
    }

    /// Returns the inode number, which a directory listing gives without
    /// another look-up.
    pub fn inode(self) -> u64 {
        self.inode
    }
}

/// The files the file tools refuse: every path that has a credential name as
/// a part, and Lys's settings file.
///
/// Built once at startup and managed by Tauri. Cloning shares the parsed
/// list.
#[derive(Debug, Clone)]
pub struct CredentialFiles {
    /// The shared names.
    list: Arc<CredentialFileList>,
    /// Path of Lys's settings file, which may not exist yet.
    settings_path: PathBuf,
}

impl CredentialFiles {
    /// Parses the embedded credential file list, for the Lys settings file at
    /// `settings_path`.
    ///
    /// # Errors
    ///
    /// Returns an error when the embedded list is not JSON of the expected
    /// shape; the host then refuses to start.
    pub fn load(settings_path: PathBuf) -> Result<Self, String> {
        Self::parse(CREDENTIAL_FILE_LIST_JSON, settings_path)
    }

    /// Parses `list_json` as the credential file list, for the Lys settings
    /// file at `settings_path`.
    ///
    /// # Errors
    ///
    /// Returns an error naming the list when `list_json` is not JSON of the
    /// expected shape, including when it has a key the list does not define.
    fn parse(list_json: &str, settings_path: PathBuf) -> Result<Self, String> {
        let list: CredentialFileList = serde_json::from_str(list_json)
            .map_err(|error| format!("The credential file list cannot be read: {error}"))?;

        Ok(Self {
            list: Arc::new(list),
            settings_path,
        })
    }

    /// Answers whether one file or folder name is a credential name.
    ///
    /// The name is compared in lowercase with the folder and file names, the
    /// starts, and the ends of the shared list. A name that is not UTF-8 is
    /// compared with its invalid bytes replaced, which keeps the list's ASCII
    /// parts intact.
    pub fn is_credential_name(&self, name: &OsStr) -> bool {
        let name = name.to_string_lossy().to_lowercase();
        let list = &self.list;

        list.folder_names.contains(&name)
            || list.file_names.contains(&name)
            || list
                .file_name_prefixes
                .iter()
                .any(|prefix| name.starts_with(prefix.as_str()))
            || list
                .file_name_endings
                .iter()
                .any(|ending| name.ends_with(ending.as_str()))
    }

    /// Answers whether one of the parts of `path` is a credential name.
    pub fn holds_credential_part(&self, path: &Path) -> bool {
        path.components().any(|component| match component {
            Component::Normal(name) => self.is_credential_name(name),
            _ => false,
        })
    }

    /// Finds the identity of Lys's settings file, following symbolic links.
    ///
    /// Returns `None` when the file does not exist or cannot be looked up;
    /// a file the host cannot look up, it cannot read either.
    pub fn find_settings_file(&self) -> Option<FileIdentity> {
        fs::metadata(&self.settings_path)
            .ok()
            .map(|metadata| FileIdentity::of(&metadata))
    }

    /// Answers whether the file at the real path `real_path`, whose identity
    /// is `identity`, is a credential file or Lys's settings file.
    ///
    /// `real_path` must have no symbolic link left in it, as
    /// [`fs::canonicalize`] returns it.
    pub fn refuses_real_file(&self, real_path: &Path, identity: FileIdentity) -> bool {
        self.holds_credential_part(real_path) || self.find_settings_file() == Some(identity)
    }
}

#[cfg(test)]
impl CredentialFiles {
    /// Loads the shared list for a settings file a test owns.
    ///
    /// # Panics
    ///
    /// Panics when the embedded list cannot be parsed.
    pub fn load_for_test(settings_path: PathBuf) -> Self {
        Self::load(settings_path).expect("the embedded credential file list parses")
    }

    /// Loads the shared list for a Lys home that has no settings file.
    ///
    /// # Panics
    ///
    /// Panics when the embedded list cannot be parsed.
    pub fn load_for_test_without_settings_file() -> Self {
        Self::load_for_test(PathBuf::from("/nonexistent/lys/settings.json"))
    }
}

#[cfg(test)]
mod tests {
    use std::{
        ffi::OsStr,
        fs,
        os::unix::ffi::OsStrExt,
        path::{Path, PathBuf},
    };

    use super::{CredentialFiles, FileIdentity};
    use crate::tools::test_directory::TestDirectory;

    #[test]
    fn loads_every_part_of_the_shared_list() {
        let credential_files = CredentialFiles::load_for_test_without_settings_file();

        assert!(!credential_files.list.folder_names.is_empty());
        assert!(!credential_files.list.file_names.is_empty());
        assert!(!credential_files.list.file_name_prefixes.is_empty());
        assert!(!credential_files.list.file_name_endings.is_empty());
    }

    /// Names that the host and the backend's tool call policy must judge
    /// alike; the policy's tests read the same file.
    const SHARED_NAME_CASES: &str =
        include_str!("../../../../../packages/share/test/fixtures/credential-file-names.json");

    #[derive(serde::Deserialize)]
    #[serde(deny_unknown_fields)]
    /// One case of the shared names.
    struct SharedNameCase {
        /// What the case checks.
        case: String,
        /// One file or folder name.
        name: String,
        /// Whether the name is a credential name.
        credential: bool,
    }

    #[test]
    fn judges_the_shared_names_as_the_backend_policy_does() {
        let credential_files = CredentialFiles::load_for_test_without_settings_file();
        let cases: Vec<SharedNameCase> =
            serde_json::from_str(SHARED_NAME_CASES).expect("the shared name cases parse");
        let mismatches: Vec<String> = cases
            .into_iter()
            .filter(|name_case| {
                credential_files.is_credential_name(OsStr::new(&name_case.name))
                    != name_case.credential
            })
            .map(|name_case| name_case.case)
            .collect();

        assert_eq!(mismatches, Vec::<String>::new());
    }

    #[test]
    fn refuses_a_list_that_is_not_json_of_the_list_shape() {
        let parse = |list_json: &str| {
            CredentialFiles::parse(list_json, PathBuf::from("/nonexistent/lys/settings.json")).err()
        };
        let complete_list = r#"{"folderNames":[".ssh"],"fileNames":[".env"],"fileNamePrefixes":[".env."],"fileNameEndings":[".pem"]}"#;
        let unknown_key = complete_list.replace("{", r#"{"directories":[],"#);

        assert_eq!(parse(complete_list), None);
        for list_json in [
            "not json",
            r#"{"folderNames":[".ssh"]}"#,
            unknown_key.as_str(),
        ] {
            let error = parse(list_json).expect("a refused list");
            assert!(
                error.starts_with("The credential file list cannot be read: "),
                "{list_json}: {error}"
            );
        }
    }

    #[test]
    fn compares_a_name_that_is_not_utf8_by_its_ascii_parts() {
        let credential_files = CredentialFiles::load_for_test_without_settings_file();

        assert!(credential_files.is_credential_name(OsStr::from_bytes(b"\xffserver.pem")));
        assert!(!credential_files.is_credential_name(OsStr::from_bytes(b"\xffnotes.md")));
    }

    #[test]
    fn finds_a_credential_name_in_any_part_of_a_path() {
        let credential_files = CredentialFiles::load_for_test_without_settings_file();

        assert!(credential_files.holds_credential_part(Path::new("/home/me/.ssh/config")));
        assert!(credential_files.holds_credential_part(Path::new("/home/me/app/.env")));
        assert!(!credential_files.holds_credential_part(Path::new("/home/me/notes/todo.md")));
    }

    #[test]
    fn refuses_the_settings_file_by_identity() {
        let directory = TestDirectory::create("credential-settings");
        let settings_path = directory.create_file("settings.json", "{}");
        let other_path = directory.create_file("notes.md", "notes");
        let hard_link = directory.path().join("copy.txt");
        fs::hard_link(&settings_path, &hard_link).expect("create the test hard link");
        let credential_files = CredentialFiles::load_for_test(settings_path.clone());
        let identity_of = |path: &Path| FileIdentity::of(&fs::metadata(path).expect("metadata"));

        assert!(credential_files.refuses_real_file(&settings_path, identity_of(&settings_path)));
        assert!(credential_files.refuses_real_file(&hard_link, identity_of(&hard_link)));
        assert!(!credential_files.refuses_real_file(&other_path, identity_of(&other_path)));
    }

    #[test]
    fn refuses_nothing_by_identity_when_there_is_no_settings_file() {
        let directory = TestDirectory::create("credential-no-settings");
        let file = directory.create_file("notes.md", "notes");
        let credential_files =
            CredentialFiles::load_for_test(directory.path().join("settings.json"));

        assert_eq!(credential_files.find_settings_file(), None);
        assert!(!credential_files.refuses_real_file(
            &file,
            FileIdentity::of(&fs::metadata(&file).expect("metadata"))
        ));
    }
}
