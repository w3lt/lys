use std::path::PathBuf;

pub enum SearchFilesTarget {
    FileName,
    FileContent,
    FileNameAndContent,
}

struct SearchFilesFilter {
    pub root: PathBuf,
    pub query: String,
    pub target: SearchFilesTarget,
    pub max_results: Option<usize>,
    pub max_snippets_per_file: Option<usize>,
}

pub fn search_files(filter: SearchFilesFilter) {}
