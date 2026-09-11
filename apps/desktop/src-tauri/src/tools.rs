//! File-oriented Tauri tool modules.
//!
//! The submodules provide an unused text-file reader and inert search-files
//! input/no-op code. Neither module is registered as a Tauri command in the
//! application handler.

/// Provides the currently unused UTF-8 text-file helper module.
pub mod read_text_file;
/// Provides the current inert file-search input and no-op operation.
pub mod search_files;
