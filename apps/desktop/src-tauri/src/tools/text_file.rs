//! Bounded reads of regular UTF-8 text files, shared by the file tools.

use std::{
    fs::{File, OpenOptions},
    io::{self, ErrorKind, Read},
    os::unix::fs::OpenOptionsExt,
    path::Path,
};

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

/// Reads the complete UTF-8 text of the regular file at `path`.
///
/// Symbolic links are followed. The file is opened without blocking, so a FIFO
/// or device at the path is rejected as [`TextFileReadError::NotARegularFile`]
/// instead of waiting for a writer. The regular-file check and the size limit
/// apply to the opened file rather than to an earlier lookup of the path. At
/// most `max_size_bytes + 1` bytes are read, so a file that grows past the
/// limit while it is read is still rejected. The file is never modified, and
/// its read-only handle is closed before returning.
///
/// # Errors
///
/// Returns the matching [`TextFileReadError`] when the file cannot be opened,
/// is not a regular file, is larger than `max_size_bytes`, cannot be read, or
/// is not valid UTF-8.
pub fn read_regular_text_file(
    path: &Path,
    max_size_bytes: u64,
) -> Result<String, TextFileReadError> {
    let file = open_file_without_blocking(path).map_err(build_open_error)?;
    let size_bytes = get_regular_file_size_bytes(&file)?;

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

/// Gets the size in bytes of `file` after confirming that it is a regular file.
///
/// # Errors
///
/// Returns [`TextFileReadError::NotARegularFile`] for any other kind of file,
/// or [`TextFileReadError::Io`] when the file's metadata cannot be read.
fn get_regular_file_size_bytes(file: &File) -> Result<u64, TextFileReadError> {
    let metadata = file.metadata().map_err(TextFileReadError::Io)?;

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

/// Builds the failure reported when a file cannot be opened.
///
/// Missing paths and denied access keep their own variants; every other
/// operating-system error is preserved unchanged in [`TextFileReadError::Io`].
fn build_open_error(error: io::Error) -> TextFileReadError {
    match error.kind() {
        ErrorKind::NotFound => TextFileReadError::NotFound,
        ErrorKind::PermissionDenied => TextFileReadError::PermissionDenied,
        _ => TextFileReadError::Io(error),
    }
}

#[cfg(test)]
mod tests {
    use std::io::{self, ErrorKind};

    use super::{build_open_error, TextFileReadError};

    #[test]
    fn open_errors_keep_missing_and_denied_paths_distinct() {
        assert!(matches!(
            build_open_error(io::Error::from(ErrorKind::NotFound)),
            TextFileReadError::NotFound
        ));
        assert!(matches!(
            build_open_error(io::Error::from(ErrorKind::PermissionDenied)),
            TextFileReadError::PermissionDenied
        ));
    }

    #[test]
    fn unrecognized_open_errors_keep_the_original_error() {
        let failure = build_open_error(io::Error::other("disk unavailable"));

        let TextFileReadError::Io(error) = failure else {
            panic!("expected an I/O failure, got {failure:?}");
        };
        assert_eq!(error.to_string(), "disk unavailable");
    }
}
