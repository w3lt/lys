//! The `read_text_file` tool, which reads one complete UTF-8 text file for Lys.

use std::path::Path;

use serde::Serialize;

use super::text_file::{read_regular_text_file, TextFileReadError};

/// Inclusive maximum size in bytes of a file that `read_text_file` returns.
///
/// A larger file is rejected with [`ReadTextFileError::FileTooLarge`] instead
/// of being truncated, so returned content is always the complete file. The
/// limit bounds the memory and IPC payload of one read. Callers cannot change
/// it; the renderer learns it only from that error.
const MAX_TEXT_FILE_SIZE_BYTES: u64 = 1024 * 1024;

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
/// accepted: deciding whether Lys may read a path belongs to the caller that
/// runs tool requests. Symbolic links are followed and the file is never
/// modified. The read runs on Tauri's blocking-task pool so the window stays
/// responsive; it cannot be cancelled and is bounded by the 1 MiB read limit.
///
/// # Errors
///
/// Rejects with a [`ReadTextFileError`] when the path is relative, nothing
/// exists there, access is denied, it is not a regular file, the file exceeds
/// the read limit or is not UTF-8, or the read fails.
pub async fn read_text_file(path: String) -> Result<String, ReadTextFileError> {
    let read_task =
        tauri::async_runtime::spawn_blocking(move || read_text_file_at(Path::new(&path)));

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
fn read_text_file_at(path: &Path) -> Result<String, ReadTextFileError> {
    if !path.is_absolute() {
        return Err(ReadTextFileError::PathNotAbsolute);
    }

    read_regular_text_file(path, MAX_TEXT_FILE_SIZE_BYTES).map_err(build_read_text_file_error)
}

/// Builds the command failure that reports a failed text-file read.
fn build_read_text_file_error(error: TextFileReadError) -> ReadTextFileError {
    match error {
        TextFileReadError::NotFound => ReadTextFileError::FileNotFound,
        TextFileReadError::PermissionDenied => ReadTextFileError::PermissionDenied,
        TextFileReadError::NotARegularFile => ReadTextFileError::NotAFile,
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

#[cfg(test)]
mod tests {
    use std::{io, os::unix::fs::symlink, path::Path};

    use serde_json::json;

    use super::{
        build_read_text_file_error, read_text_file, ReadTextFileError, MAX_TEXT_FILE_SIZE_BYTES,
    };
    use crate::tools::{test_directory::TestDirectory, text_file::TextFileReadError};

    /// Reads the file at `path` through the `read_text_file` command, blocking
    /// until the command completes.
    fn read_text_file_blocking(path: &str) -> Result<String, ReadTextFileError> {
        tauri::async_runtime::block_on(read_text_file(path.to_owned()))
    }

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
