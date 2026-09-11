//! Provided UTF-8 text-file reading helper with no current caller.

use std::{fs, path::Path};

/// Reads the complete UTF-8 contents of `file_path`.
///
/// This helper is currently unused and is not registered as a Tauri command.
/// When called, it returns an owned `String` and does not modify the source
/// file.
///
/// # Errors
///
/// Returns an error when the path cannot be read or its bytes are not valid
/// UTF-8. The filesystem error is returned as a formatted string.
pub fn read_text_file(file_path: &Path) -> Result<String, String> {
    let content =
        fs::read_to_string(file_path).map_err(|err| format!("Error reading file {err}"))?;

    Ok(content)
}
