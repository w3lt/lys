//! Lines written to standard error, which the backend keeps as the
//! server's log.
//!
//! A line names an operation, a folder, counts, or the class of a failure.
//! No line holds the password, an address, a subject, or a body: the
//! backend keeps these lines and shows them to the person.

use std::io::{self, Write};

/// Writes one line to standard error.
///
/// A write failure, such as a closed standard error, is ignored: logging
/// never stops the server.
///
/// # Arguments
///
/// * `line` - The text of the line, without a line break.
pub fn log_line(line: &str) {
    let stderr = io::stderr();
    let mut handle = stderr.lock();
    let _ = writeln!(handle, "{line}");
}
