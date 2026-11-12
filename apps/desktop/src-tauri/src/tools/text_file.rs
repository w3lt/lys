//! Bounded reads of regular UTF-8 text files, shared by the file tools.

use std::{
    fs::{self, File, Metadata, OpenOptions},
    io::{self, ErrorKind, Read},
    os::unix::fs::OpenOptionsExt,
    path::Path,
};

use super::credential_files::{CredentialFiles, FileIdentity};

/// Why the text of a regular file could not be read.
///
/// Each tool translates these failures into its own reported outcome.
#[derive(Debug)]
pub enum TextFileReadError {
    /// Nothing exists at the path.
    NotFound,
    /// The operating system denied access to the file or one of its parent
    /// directories.
    PermissionDenied,
    /// The path names a directory, FIFO, socket, or device instead of a
    /// regular file.
    NotARegularFile,
    /// The file's real path has a credential name as a part, or the file is
    /// Lys's settings file; nothing of it was read.
    CredentialFile,
    /// The file is larger than the caller's limit; its content was not read.
    TooLarge {
        /// Smallest size in bytes the file was observed to have, which exceeds
        /// the limit.
        size_bytes: u64,
    },
    /// The file was read completely, but its bytes are not valid UTF-8.
    NotUtf8 {
        /// Number of bytes read from the file.
        size_bytes: u64,
    },
    /// Opening, inspecting, or reading the file failed for another reason.
    Io(io::Error),
}

/// Reads the complete UTF-8 text of the regular file at `path`, unless
/// `credential_files` refuses it.
///
/// Symbolic links are followed. The path is looked up before it is opened, so
/// a directory, FIFO, socket, or device is rejected as
/// [`TextFileReadError::NotARegularFile`] without being opened. The file is
/// then opened without blocking and checked again, so a path replaced by a
/// FIFO or device between the two steps is rejected instead of waited on.
/// Before any byte is read, the opened file's real path is resolved and
/// checked, as [`check_opened_file`] describes. The size limit applies to the
/// opened file. At most `max_size_bytes + 1` bytes are read, so a file that
/// grows past the limit while it is read is still rejected. The file is never
/// modified, and its read-only handle is closed before returning.
///
/// # Errors
///
/// Returns the matching [`TextFileReadError`] when the path cannot be looked
/// up or opened, is not a regular file, is a credential file or Lys's
/// settings file, is larger than `max_size_bytes`, cannot be read, or is not
/// valid UTF-8.
pub fn read_regular_text_file(
    path: &Path,
    max_size_bytes: u64,
    credential_files: &CredentialFiles,
) -> Result<String, TextFileReadError> {
    let path_metadata = fs::metadata(path).map_err(build_path_error)?;

    if !path_metadata.is_file() {
        return Err(TextFileReadError::NotARegularFile);
    }

    let file = open_file_without_blocking(path).map_err(build_path_error)?;
    let file_metadata = file.metadata().map_err(TextFileReadError::Io)?;
    check_opened_file(path, &file_metadata, credential_files)?;
    let size_bytes = get_regular_file_size_bytes(&file_metadata)?;

    if size_bytes > max_size_bytes {
        return Err(TextFileReadError::TooLarge { size_bytes });
    }

    let bytes = read_bounded_bytes(file, max_size_bytes)?;
    let read_size_bytes = bytes.len() as u64;

    String::from_utf8(bytes).map_err(|_| TextFileReadError::NotUtf8 {
        size_bytes: read_size_bytes,
    })
}

/// Opens `path` read-only with `O_NONBLOCK`.
///
/// Opening a FIFO that has no writer returns immediately instead of waiting;
/// reads from a regular file are unaffected by the flag.
///
/// # Errors
///
/// Returns the operating system's error when the path cannot be opened.
fn open_file_without_blocking(path: &Path) -> io::Result<File> {
    OpenOptions::new()
        .read(true)
        .custom_flags(nix::libc::O_NONBLOCK)
        .open(path)
}

/// Checks that the file opened from `path`, which `file_metadata` describes,
/// may be read.
///
/// The real path of `path` is resolved, with every symbolic link followed,
/// and looked up again. Its identity must be the opened file's, so a path
/// changed between the open and the resolution is not checked in place of
/// the file that would be read.
///
/// # Errors
///
/// Returns [`TextFileReadError::CredentialFile`] when `credential_files`
/// refuses the real file, [`TextFileReadError::Io`] when the real path names
/// another file than the one opened, or the matching path failure when the
/// real path cannot be resolved or looked up.
fn check_opened_file(
    path: &Path,
    file_metadata: &Metadata,
    credential_files: &CredentialFiles,
) -> Result<(), TextFileReadError> {
    let real_path = fs::canonicalize(path).map_err(build_path_error)?;
    let real_metadata = fs::metadata(&real_path).map_err(build_path_error)?;
    let identity = FileIdentity::of(file_metadata);

    if FileIdentity::of(&real_metadata) != identity {
        return Err(TextFileReadError::Io(io::Error::other(
            "The file changed while it was opened",
        )));
    }

    if credential_files.refuses_real_file(&real_path, identity) {
        return Err(TextFileReadError::CredentialFile);
    }

    Ok(())
}

/// Gets the size in bytes of the opened file that `metadata` describes, after
/// confirming that it is a regular file.
///
/// # Errors
///
/// Returns [`TextFileReadError::NotARegularFile`] for any other kind of file.
fn get_regular_file_size_bytes(metadata: &Metadata) -> Result<u64, TextFileReadError> {
    if !metadata.is_file() {
        return Err(TextFileReadError::NotARegularFile);
    }

    Ok(metadata.len())
}

/// Reads all bytes of `file` when it holds at most `max_size_bytes` bytes.
///
/// Consumes `file`, which is closed when this function returns.
///
/// # Errors
///
/// Returns [`TextFileReadError::TooLarge`] when the file holds more than
/// `max_size_bytes` bytes, or [`TextFileReadError::Io`] when reading fails.
fn read_bounded_bytes(file: File, max_size_bytes: u64) -> Result<Vec<u8>, TextFileReadError> {
    let mut bytes = Vec::new();

    file.take(max_size_bytes.saturating_add(1))
        .read_to_end(&mut bytes)
        .map_err(TextFileReadError::Io)?;

    let read_size_bytes = bytes.len() as u64;

    if read_size_bytes > max_size_bytes {
        return Err(TextFileReadError::TooLarge {
            size_bytes: read_size_bytes,
        });
    }

    Ok(bytes)
}

/// Builds the failure reported when a path cannot be looked up or opened.
///
/// Missing paths, including a path that continues below a file, and denied
/// access keep their own variants; every other operating-system error is
/// preserved unchanged in [`TextFileReadError::Io`].
fn build_path_error(error: io::Error) -> TextFileReadError {
    match error.kind() {
        ErrorKind::NotFound | ErrorKind::NotADirectory => TextFileReadError::NotFound,
        ErrorKind::PermissionDenied => TextFileReadError::PermissionDenied,
        _ => TextFileReadError::Io(error),
    }
}

#[cfg(test)]
mod tests {
    use std::io::{self, ErrorKind};

    use super::{build_path_error, TextFileReadError};

    #[test]
    fn path_errors_keep_missing_and_denied_paths_distinct() {
        assert!(matches!(
            build_path_error(io::Error::from(ErrorKind::NotFound)),
            TextFileReadError::NotFound
        ));
        assert!(matches!(
            build_path_error(io::Error::from(ErrorKind::NotADirectory)),
            TextFileReadError::NotFound
        ));
        assert!(matches!(
            build_path_error(io::Error::from(ErrorKind::PermissionDenied)),
            TextFileReadError::PermissionDenied
        ));
    }

    #[test]
    fn unrecognized_path_errors_keep_the_original_error() {
        let failure = build_path_error(io::Error::other("disk unavailable"));

        let TextFileReadError::Io(error) = failure else {
            panic!("expected an I/O failure, got {failure:?}");
        };
        assert_eq!(error.to_string(), "disk unavailable");
    }
}
