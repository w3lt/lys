//! The `read_text_file` tool, which reads one complete UTF-8 text file for Lys.

use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::State;

use crate::utils::lys_home::LysHome;

use super::{
    approved_folders::ApprovedFolders,
    credential_files::CredentialFiles,
    definition::{
        ToolAccess, ToolArgumentDefinition, ToolArgumentType, ToolDefinition, ToolGroup, ToolRunner,
    },
    text_file::{read_regular_text_file, TextFileReadError},
};

/// Inclusive maximum size in bytes of a file that `read_text_file` returns.
///
/// A larger file is rejected with [`ReadTextFileError::FileTooLarge`] instead
/// of being truncated, so returned content is always the complete file. The
/// limit bounds the memory and IPC payload of one read. Callers cannot change
/// it; the renderer learns it only from that error.
const MAX_TEXT_FILE_SIZE_BYTES: u64 = 1024 * 1024;

/// Number of bytes in one mebibyte, used to state the read limit in MiB.
const BYTES_PER_MEBIBYTE: u64 = 1024 * 1024;

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(
    tag = "code",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
/// Expected failure of the `read_text_file` command.
///
/// The command rejects with a JSON object whose `code` is the camelCase
/// variant name, such as `{ "code": "fileNotFound" }`, followed by the
/// variant's fields in camelCase. No file content accompanies a failure.
pub enum ReadTextFileError {
    /// The path is not absolute. Relative paths are rejected instead of being
    /// resolved against the desktop process's working directory.
    PathNotAbsolute,
    /// Nothing exists at the path.
    FileNotFound,
    /// The operating system denied access to the file or one of its parent
    /// directories.
    PermissionDenied,
    /// The path names a directory, FIFO, socket, or device instead of a
    /// regular file.
    NotAFile,
    /// The file's real path has a private key or credential file or folder
    /// name as a part, or the file is Lys's settings file, so none of it is
    /// read.
    CredentialFile,
    /// The file's real path is outside every folder the person lets tools
    /// use, so none of it is read.
    OutsideApprovedFolders,
    /// The file is larger than the read limit, so none of it is returned.
    FileTooLarge {
        /// Smallest size in bytes the file was observed to have.
        size_bytes: u64,
        /// Inclusive read limit in bytes that the file exceeds.
        max_size_bytes: u64,
    },
    /// The file's bytes are not valid UTF-8, so it cannot be returned as text.
    NotUtf8Text,
    /// Opening or reading the file failed for another reason, or the read task
    /// stopped unexpectedly.
    ReadFailed {
        /// Description of the failure from the operating system or the async
        /// runtime, for display only.
        message: String,
    },
}

#[tauri::command]
/// Reads the complete UTF-8 text of the file at the absolute `path`.
///
/// The renderer invokes this command as `read_text_file` with the argument
/// object `{ path }`. Any absolute path that the desktop process can read is
/// accepted, except a file that `credential_files` refuses by its real path,
/// and a file whose real path is outside the folders the person lets tools
/// use, which are read from the settings file of `lys_home` for every call:
/// whether Lys may read any other path is decided by the caller that runs
/// tool requests. Symbolic links are followed and the file is never
/// modified. The read runs on Tauri's blocking-task pool so the window stays
/// responsive; it cannot be cancelled and is bounded by the 1 MiB read limit.
///
/// # Errors
///
/// Rejects as [`read_text_file_in_background`] does.
pub async fn read_text_file(
    path: String,
    credential_files: State<'_, CredentialFiles>,
    lys_home: State<'_, LysHome>,
) -> Result<String, ReadTextFileError> {
    read_text_file_in_background(
        path,
        credential_files.inner().clone(),
        lys_home.settings_path(),
    )
    .await
}

/// Reads the text file at `path` on Tauri's blocking-task pool.
///
/// # Errors
///
/// Rejects with a [`ReadTextFileError`] when the path is relative, nothing
/// exists there, access is denied, it is not a regular file, it is a
/// credential file or Lys's settings file, it is outside the folders saved in
/// the settings file at `settings_path`, the file exceeds the read limit or
/// is not UTF-8, or the read fails.
async fn read_text_file_in_background(
    path: String,
    credential_files: CredentialFiles,
    settings_path: PathBuf,
) -> Result<String, ReadTextFileError> {
    let read_task = tauri::async_runtime::spawn_blocking(move || {
        let approved_folders = ApprovedFolders::read(&settings_path);
        read_text_file_at(Path::new(&path), &credential_files, &approved_folders)
    });

    match read_task.await {
        Ok(read_result) => read_result,
        Err(error) => Err(ReadTextFileError::ReadFailed {
            message: format!("The file read stopped unexpectedly: {error}"),
        }),
    }
}

/// Reads the text file at `path` after confirming that the path is absolute.
///
/// # Errors
///
/// Returns the [`ReadTextFileError`] that describes why the file cannot be
/// returned as text.
fn read_text_file_at(
    path: &Path,
    credential_files: &CredentialFiles,
    approved_folders: &ApprovedFolders,
) -> Result<String, ReadTextFileError> {
    if !path.is_absolute() {
        return Err(ReadTextFileError::PathNotAbsolute);
    }

    read_regular_text_file(
        path,
        MAX_TEXT_FILE_SIZE_BYTES,
        credential_files,
        approved_folders,
    )
    .map_err(build_read_text_file_error)
}

/// Builds the command failure that reports a failed text-file read.
fn build_read_text_file_error(error: TextFileReadError) -> ReadTextFileError {
    match error {
        TextFileReadError::NotFound => ReadTextFileError::FileNotFound,
        TextFileReadError::PermissionDenied => ReadTextFileError::PermissionDenied,
        TextFileReadError::NotARegularFile => ReadTextFileError::NotAFile,
        TextFileReadError::CredentialFile => ReadTextFileError::CredentialFile,
        TextFileReadError::OutsideApprovedFolders => ReadTextFileError::OutsideApprovedFolders,
        TextFileReadError::TooLarge { size_bytes } => ReadTextFileError::FileTooLarge {
            size_bytes,
            max_size_bytes: MAX_TEXT_FILE_SIZE_BYTES,
        },
        TextFileReadError::NotUtf8 { .. } => ReadTextFileError::NotUtf8Text,
        TextFileReadError::Io(error) => ReadTextFileError::ReadFailed {
            message: error.to_string(),
        },
    }
}

/// Builds the definition of the read-text-file tool for the client tool list.
///
/// The description states the read limit taken from
/// [`MAX_TEXT_FILE_SIZE_BYTES`], in whole mebibytes, so it changes with the
/// limit the command enforces. The only argument is the command's `path`.
pub(super) fn build_read_text_file_definition() -> ToolDefinition {
    let max_size_mebibytes = MAX_TEXT_FILE_SIZE_BYTES / BYTES_PER_MEBIBYTE;
    let path_argument = ToolArgumentDefinition {
        name: "path",
        description: String::from("Absolute path of the file. Symbolic links are followed."),
        required: true,
        argument_type: ToolArgumentType::String,
    };

    ToolDefinition {
        name: "read_text_file",
        description: format!(
            "Read one UTF-8 text file and return its complete text. A file over {max_size_mebibytes} MiB or one that is not UTF-8 text is refused, never truncated. Private key and credential files, and Lys's settings file, are refused, wherever a link leads, and so is a file outside the folders the person lets tools use, when they listed any."
        ),
        group: ToolGroup::Files,
        access: ToolAccess::Reads,
        runner: ToolRunner::Client,
        arguments: vec![path_argument],
    }
}

#[cfg(test)]
mod tests {
    use std::{io, os::unix::fs::symlink, path::Path};

    use serde_json::json;

    use super::{
        build_read_text_file_error, read_text_file_in_background, ReadTextFileError,
        MAX_TEXT_FILE_SIZE_BYTES,
    };
    use crate::tools::{
        credential_files::CredentialFiles, test_directory::TestDirectory,
        text_file::TextFileReadError,
    };

    /// Reads the file at `path` as the `read_text_file` command does, for a
    /// Lys home without a settings file, blocking until the read completes.
    fn read_text_file_blocking(path: &str) -> Result<String, ReadTextFileError> {
        read_text_file_with(path, CredentialFiles::load_for_test_without_settings_file())
    }

    /// Reads the file at `path` as the `read_text_file` command does, with
    /// `credential_files` and no settings file, so no folder is listed,
    /// blocking until the read completes.
    fn read_text_file_with(
        path: &str,
        credential_files: CredentialFiles,
    ) -> Result<String, ReadTextFileError> {
        read_text_file_in_folders(path, credential_files, Path::new(MISSING_SETTINGS_PATH))
    }

    /// Reads the file at `path` as the `read_text_file` command does, with
    /// `credential_files` and the folders listed in the settings file at
    /// `settings_path`, blocking until the read completes.
    fn read_text_file_in_folders(
        path: &str,
        credential_files: CredentialFiles,
        settings_path: &Path,
    ) -> Result<String, ReadTextFileError> {
        tauri::async_runtime::block_on(read_text_file_in_background(
            path.to_owned(),
            credential_files,
            settings_path.to_path_buf(),
        ))
    }

    /// Settings path of a Lys home without a settings file.
    const MISSING_SETTINGS_PATH: &str = "/nonexistent/lys-test/settings.json";

    /// Returns the UTF-8 form of a test path.
    fn get_path_text(path: &Path) -> &str {
        path.to_str().expect("a UTF-8 test path")
    }

    #[test]
    fn returns_the_complete_text_of_a_utf8_file() {
        let directory = TestDirectory::create("read-utf8");
        let file = directory.create_file("notes.md", "Xin chào, Lys!\nSecond line\n");

        assert_eq!(
            read_text_file_blocking(get_path_text(&file)),
            Ok(String::from("Xin chào, Lys!\nSecond line\n"))
        );
    }

    #[test]
    fn follows_a_symbolic_link_to_a_file() {
        let directory = TestDirectory::create("read-symlink");
        let file = directory.create_file("target.txt", "linked text");
        let link = directory.path().join("link.txt");
        symlink(&file, &link).expect("create the test symlink");

        assert_eq!(
            read_text_file_blocking(get_path_text(&link)),
            Ok(String::from("linked text"))
        );
    }

    #[test]
    fn refuses_a_file_with_a_credential_name() {
        let directory = TestDirectory::create("read-credential-name");
        let file = directory.create_file("app/.env", "TOKEN=secret\n");

        assert_eq!(
            read_text_file_blocking(get_path_text(&file)),
            Err(ReadTextFileError::CredentialFile)
        );
    }

    #[test]
    fn refuses_a_link_that_resolves_into_a_credential_folder() {
        let directory = TestDirectory::create("read-link-into-ssh");
        let target = directory.create_file(".ssh/config", "Host example\n");
        let link = directory.path().join("notes.txt");
        symlink(&target, &link).expect("create the test symlink");

        assert_eq!(
            read_text_file_blocking(get_path_text(&link)),
            Err(ReadTextFileError::CredentialFile)
        );
    }

    #[test]
    fn refuses_a_file_reached_through_a_linked_credential_folder() {
        let directory = TestDirectory::create("read-linked-folder");
        directory.create_file(".aws/config", "[default]\n");
        let folder_link = directory.path().join("settings");
        symlink(directory.path().join(".aws"), &folder_link).expect("create the test symlink");

        assert_eq!(
            read_text_file_blocking(get_path_text(&folder_link.join("config"))),
            Err(ReadTextFileError::CredentialFile)
        );
    }

    #[test]
    fn reads_inside_an_approved_folder_and_refuses_beside_it_or_through_a_link_out() {
        let directory = TestDirectory::create("read-approved-folders");
        let app = directory.create_subdirectory("work/app");
        let inside = directory.create_file("work/app/notes.txt", "inside\n");
        let beside = directory.create_file("work/app-old/notes.txt", "beside\n");
        let outside = directory.create_file("other/notes.txt", "outside\n");
        let link_out = app.join("other.txt");
        symlink(&outside, &link_out).expect("create the test symlink");
        let settings_path = directory.create_file(
            "lys/settings.json",
            serde_json::json!({ "tools": { "approvedFolders": [get_path_text(&app)] } })
                .to_string(),
        );
        let read = |path: &Path| {
            read_text_file_in_folders(
                get_path_text(path),
                CredentialFiles::load_for_test(settings_path.clone()),
                &settings_path,
            )
        };

        assert_eq!(read(&inside), Ok(String::from("inside\n")));
        assert_eq!(
            read(&app.join("../app/notes.txt")),
            Ok(String::from("inside\n"))
        );
        for path in [&beside, &outside, &link_out] {
            assert_eq!(
                read(path),
                Err(ReadTextFileError::OutsideApprovedFolders),
                "{path:?}"
            );
        }
    }

    #[test]
    fn refuses_every_file_when_the_settings_file_cannot_be_parsed() {
        let directory = TestDirectory::create("read-unparsed-settings");
        let file = directory.create_file("notes.txt", "notes\n");
        let settings_path = directory.create_file("lys/settings.json", "{ not json");

        assert_eq!(
            read_text_file_in_folders(
                get_path_text(&file),
                CredentialFiles::load_for_test_without_settings_file(),
                &settings_path,
            ),
            Err(ReadTextFileError::OutsideApprovedFolders)
        );
    }

    #[test]
    fn refuses_the_settings_file_and_a_link_to_it() {
        let directory = TestDirectory::create("read-settings-file");
        let settings_path = directory.create_file("lys/settings.json", "{}\n");
        let link = directory.path().join("notes.json");
        symlink(&settings_path, &link).expect("create the test symlink");

        for path in [&settings_path, &link] {
            assert_eq!(
                read_text_file_with(
                    get_path_text(path),
                    CredentialFiles::load_for_test(settings_path.clone())
                ),
                Err(ReadTextFileError::CredentialFile)
            );
        }
    }

    #[test]
    fn refuses_a_credential_file_before_its_size_is_checked() {
        let directory = TestDirectory::create("read-large-key");
        let content = "a".repeat(MAX_TEXT_FILE_SIZE_BYTES as usize + 1);
        let file = directory.create_file("server.pem", content);

        assert_eq!(
            read_text_file_blocking(get_path_text(&file)),
            Err(ReadTextFileError::CredentialFile)
        );
    }

    #[test]
    fn rejects_a_relative_path() {
        assert_eq!(
            read_text_file_blocking("notes.md"),
            Err(ReadTextFileError::PathNotAbsolute)
        );
    }

    #[test]
    fn reports_a_missing_file() {
        let directory = TestDirectory::create("read-missing");
        let missing_file = directory.path().join("missing.txt");

        assert_eq!(
            read_text_file_blocking(get_path_text(&missing_file)),
            Err(ReadTextFileError::FileNotFound)
        );
    }

    #[test]
    fn reports_a_path_below_a_file_as_missing() {
        let directory = TestDirectory::create("read-below-file");
        let file = directory.create_file("notes.txt", "notes");

        assert_eq!(
            read_text_file_blocking(get_path_text(&file.join("child"))),
            Err(ReadTextFileError::FileNotFound)
        );
    }

    #[test]
    fn rejects_a_directory() {
        let directory = TestDirectory::create("read-directory");

        assert_eq!(
            read_text_file_blocking(get_path_text(directory.path())),
            Err(ReadTextFileError::NotAFile)
        );
    }

    #[test]
    fn rejects_a_fifo_without_waiting_for_a_writer() {
        let directory = TestDirectory::create("read-fifo");
        let fifo = directory.create_fifo("pipe");

        assert_eq!(
            read_text_file_blocking(get_path_text(&fifo)),
            Err(ReadTextFileError::NotAFile)
        );
    }

    #[test]
    fn rejects_a_socket() {
        let directory = TestDirectory::create("read-socket");
        let socket = directory.create_socket("socket");

        assert_eq!(
            read_text_file_blocking(get_path_text(&socket)),
            Err(ReadTextFileError::NotAFile)
        );
    }

    #[test]
    fn accepts_a_file_at_the_size_limit() {
        let directory = TestDirectory::create("read-at-limit");
        let content = "a".repeat(MAX_TEXT_FILE_SIZE_BYTES as usize);
        let file = directory.create_file("at-limit.txt", &content);

        assert_eq!(read_text_file_blocking(get_path_text(&file)), Ok(content));
    }

    #[test]
    fn rejects_a_file_one_byte_over_the_size_limit() {
        let directory = TestDirectory::create("read-over-limit");
        let content = "a".repeat(MAX_TEXT_FILE_SIZE_BYTES as usize + 1);
        let file = directory.create_file("over-limit.txt", content);

        assert_eq!(
            read_text_file_blocking(get_path_text(&file)),
            Err(ReadTextFileError::FileTooLarge {
                size_bytes: MAX_TEXT_FILE_SIZE_BYTES + 1,
                max_size_bytes: MAX_TEXT_FILE_SIZE_BYTES,
            })
        );
    }

    #[test]
    fn rejects_content_that_is_not_utf8() {
        let directory = TestDirectory::create("read-binary");
        let file = directory.create_file("image.bin", [0xff, 0xfe, 0x00, 0x41]);

        assert_eq!(
            read_text_file_blocking(get_path_text(&file)),
            Err(ReadTextFileError::NotUtf8Text)
        );
    }

    #[test]
    fn reports_denied_access_and_other_read_failures_separately() {
        assert_eq!(
            build_read_text_file_error(TextFileReadError::PermissionDenied),
            ReadTextFileError::PermissionDenied
        );
        assert_eq!(
            build_read_text_file_error(TextFileReadError::Io(io::Error::other("disk unavailable"))),
            ReadTextFileError::ReadFailed {
                message: String::from("disk unavailable")
            }
        );
    }

    #[test]
    fn serializes_failures_with_a_camel_case_code() {
        assert_eq!(
            serde_json::to_value(ReadTextFileError::PathNotAbsolute).expect("serialize"),
            json!({ "code": "pathNotAbsolute" })
        );
        assert_eq!(
            serde_json::to_value(ReadTextFileError::CredentialFile).expect("serialize"),
            json!({ "code": "credentialFile" })
        );
        assert_eq!(
            serde_json::to_value(ReadTextFileError::FileTooLarge {
                size_bytes: 2_000_000,
                max_size_bytes: MAX_TEXT_FILE_SIZE_BYTES,
            })
            .expect("serialize"),
            json!({
                "code": "fileTooLarge",
                "sizeBytes": 2_000_000,
                "maxSizeBytes": MAX_TEXT_FILE_SIZE_BYTES
            })
        );
        assert_eq!(
            serde_json::to_value(ReadTextFileError::ReadFailed {
                message: String::from("disk unavailable"),
            })
            .expect("serialize"),
            json!({ "code": "readFailed", "message": "disk unavailable" })
        );
    }
}
