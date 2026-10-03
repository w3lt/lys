//! Client tools that let Lys read files on the machine running the desktop app.
//!
//! Each tool is a Tauri command that the renderer invokes on Lys's behalf:
//! `read_text_file` returns the text of one file and `find_files` searches a
//! directory tree by file name or content. The commands accept any absolute
//! path that the desktop process can read. They do not decide whether Lys may
//! use a tool or a path; that decision belongs to the caller that runs tool
//! requests. File work runs on Tauri's blocking-task pool so the window stays
//! responsive.

/// Provides the `read_text_file` command.
pub mod read_text_file;
/// Provides the `find_files` command of the search-files tool.
pub mod search_files;
/// Reads regular UTF-8 text files for both tools.
mod text_file;

/// Creates and deletes the temporary directory trees used by the tool tests.
#[cfg(test)]
mod test_directory;
