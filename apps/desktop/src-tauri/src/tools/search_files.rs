//! Inert input types and no-op entry point for the current file-search module.
//!
//! The operation accepts a private filter, ignores it, and returns unit. This
//! module is not registered as a Tauri command and has no current callers.

use std::path::PathBuf;

/// Enum value carried by the inert search filter.
pub enum SearchFilesTarget {
    /// File-name target value.
    FileName,
    /// File-content target value.
    FileContent,
    /// Combined file-name and file-content target value.
    FileNameAndContent,
}

/// Private inert data accepted by the current file-search operation.
///
/// Although its fields are public within this private type, no current caller
/// constructs it and the no-op operation ignores every field.
struct SearchFilesFilter {
    /// Path value carried by the filter.
    pub root: PathBuf,
    /// Query text value carried by the filter.
    pub query: String,
    /// Target value carried by the filter.
    pub target: SearchFilesTarget,
    /// Optional numeric limit value carried by the filter.
    pub max_results: Option<usize>,
    /// Optional numeric snippet limit value carried by the filter.
    pub max_snippets_per_file: Option<usize>,
}

/// Accepts and ignores the current search filter, returning unit.
///
/// The function has no current caller and produces no results or errors.
pub fn search_files(filter: SearchFilesFilter) {}
