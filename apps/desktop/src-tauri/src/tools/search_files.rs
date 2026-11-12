//! The search-files tool, which finds files under a directory by name or by
//! UTF-8 text content.
//!
//! The renderer invokes it as the `find_files` command. A search walks the
//! directory tree breadth-first without following symbolic links, compares
//! names and lines case-insensitively, and stops at fixed result and scan
//! budgets so that one request cannot read an unbounded amount of the disk.
//! It never starts inside a credential folder or outside the folders the
//! person lets tools use, and it leaves credential files and folders and
//! Lys's settings file out of its walk.

use std::{
    collections::VecDeque,
    fs::{self, DirEntry},
    io,
    os::unix::fs::DirEntryExt,
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::utils::lys_home::LysHome;

use super::{
    approved_folders::{ApprovedFolderRefusal, ApprovedFolders},
    credential_files::{CredentialFiles, FileIdentity},
    definition::{
        ToolAccess, ToolArgumentDefinition, ToolArgumentType, ToolDefinition, ToolGroup, ToolRunner,
    },
    text_file::{read_regular_text_file, TextFileReadError},
};

/// Number of matching files reported when the filter omits `maxResults`.
const DEFAULT_MAX_RESULTS: usize = 50;

/// Inclusive upper bound accepted for `maxResults`; the lower bound is 1.
const MAX_RESULTS_LIMIT: usize = 200;

/// Number of matching lines reported per file when the filter omits
/// `maxSnippetsPerFile`.
const DEFAULT_MAX_SNIPPETS_PER_FILE: usize = 3;

/// Inclusive upper bound accepted for `maxSnippetsPerFile`; the lower bound
/// is 1.
const MAX_SNIPPETS_PER_FILE_LIMIT: usize = 20;

/// Inclusive maximum query length, counted in Unicode scalar values.
const MAX_QUERY_CHARS: usize = 200;

/// Number of directory entries after which a search stops examining entries.
///
/// Every listed entry counts, including subdirectories and entries that are
/// ignored, so the limit bounds the traversal of large trees.
const MAX_SCANNED_ENTRY_COUNT: usize = 20_000;

/// Number of content bytes after which a search stops examining entries.
///
/// The check happens before each entry, so the total read can exceed this
/// value by at most one file of [`MAX_SEARCHED_FILE_SIZE_BYTES`].
const MAX_SCANNED_CONTENT_BYTES: u64 = 64 * 1024 * 1024;

/// Inclusive maximum size in bytes of a file whose content is searched.
///
/// Larger files are counted in `oversizedFileCount` and only their names can
/// match.
const MAX_SEARCHED_FILE_SIZE_BYTES: u64 = 1024 * 1024;

/// Inclusive maximum length of a snippet's text, counted in Unicode scalar
/// values.
const MAX_SNIPPET_CHARS: usize = 200;

/// Number of characters kept before the first match when a line longer than
/// [`MAX_SNIPPET_CHARS`] is cut down to a snippet.
const SNIPPET_LEADING_CHARS: usize = 40;

/// Every [`SearchFilesTarget`] as the filter's `target` key spells it, in the
/// order the search-files tool offers them to a model.
const SEARCH_FILES_TARGET_VALUES: [&str; 3] = ["name", "content", "nameAndContent"];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
/// Part of each file that a search compares with its query.
pub enum SearchFilesTarget {
    /// The file's name, which is the last component of its path.
    Name,
    /// The file's lines, when the file is UTF-8 text no larger than the content
    /// search limit.
    Content,
    /// Both; a file matches when its name or any of its lines matches.
    NameAndContent,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
/// Search request received as the `filter` argument of `find_files`.
///
/// Keys are camelCase and unknown keys are rejected when the argument is
/// deserialized. The values are untrusted until `parse_search_files_filter`
/// validates them; no filesystem access happens before the query and limits
/// are valid.
pub struct SearchFilesFilter {
    /// Directory whose tree is searched; must be an absolute path to a
    /// directory that the desktop process can list. Symbolic links are
    /// followed for the root only.
    root: PathBuf,
    /// Text to find, compared after Unicode lowercasing of both sides. It must
    /// contain a non-whitespace character, no line break, and at most
    /// `MAX_QUERY_CHARS` characters.
    query: String,
    /// Part of each file compared with `query`.
    target: SearchFilesTarget,
    /// Maximum number of matching files to report, from 1 to
    /// `MAX_RESULTS_LIMIT`; omission or `null` selects `DEFAULT_MAX_RESULTS`.
    max_results: Option<usize>,
    /// Maximum number of matching lines reported per file, from 1 to
    /// `MAX_SNIPPETS_PER_FILE_LIMIT`; omission or `null` selects
    /// `DEFAULT_MAX_SNIPPETS_PER_FILE`. Unused when `target` is `name`.
    max_snippets_per_file: Option<usize>,
}

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(
    tag = "code",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
/// Expected failure of the `find_files` command.
///
/// The command rejects with a JSON object whose `code` is the camelCase
/// variant name, such as `{ "code": "emptyQuery" }`, followed by the variant's
/// fields in camelCase. A failure means that no search ran or that it stopped
/// without a report; no partial matches accompany it.
pub enum SearchFilesError {
    /// The root is not an absolute path.
    RootNotAbsolute,
    /// Nothing exists at the root path.
    RootNotFound,
    /// The root exists but is not a directory.
    RootNotADirectory,
    /// The root's real path has a private key or credential file or folder
    /// name as a part, so nothing under it is searched.
    RootInCredentialFolder,
    /// The root's real path is outside every folder the person lets tools
    /// use, so nothing under it is searched.
    RootOutsideApprovedFolders,
    /// The folders the person lets tools use cannot be read from Lys's
    /// settings file, so nothing is searched until the file is fixed.
    SettingsUnreadable,
    /// The operating system denied access to the root directory.
    PermissionDenied,
    /// The query is empty or contains only whitespace.
    EmptyQuery,
    /// The query contains a line break, so it could never match one line.
    MultilineQuery,
    /// The query is longer than the query limit.
    QueryTooLong {
        /// Inclusive query limit, counted in Unicode scalar values.
        max_chars: usize,
    },
    /// The requested maximum number of results is 0 or above the limit.
    MaxResultsOutOfRange {
        /// Inclusive upper bound; the lower bound is 1.
        maximum: usize,
    },
    /// The requested maximum number of snippets per file is 0 or above the
    /// limit.
    MaxSnippetsPerFileOutOfRange {
        /// Inclusive upper bound; the lower bound is 1.
        maximum: usize,
    },
    /// Inspecting the root failed for another reason, or the search task
    /// stopped unexpectedly.
    SearchFailed {
        /// Description of the failure from the operating system or the async
        /// runtime, for display only.
        message: String,
    },
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
/// Successful result of one search.
///
/// The report observes the tree while it was walked; files created, changed,
/// or deleted during the search may or may not be reflected.
pub struct SearchFilesReport {
    /// Matching files in traversal order: directories breadth-first, and the
    /// entries of each directory in byte order of their names. Holds at most
    /// the requested maximum number of results.
    matches: Vec<FileMatch>,
    /// Why the search ended, which tells whether more matches may exist.
    completion: SearchCompletion,
    /// Entries that could not be examined: directories that could not be
    /// listed, entries whose type or content could not be read, and entries
    /// whose path is not valid UTF-8 and therefore cannot be reported.
    skipped_path_count: usize,
    /// Files whose content was not searched because they are larger than
    /// `MAX_SEARCHED_FILE_SIZE_BYTES`; their names were still compared when
    /// the target includes names.
    oversized_file_count: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
/// Reason a search ended.
pub enum SearchCompletion {
    /// Every entry under the root was examined, apart from the skipped ones.
    Complete,
    /// The requested number of matches was found; more matches may exist.
    ResultLimitReached,
    /// The entry or content-byte budget ran out before the tree was fully
    /// examined; more matches may exist.
    ScanLimitReached,
}

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
/// One matching regular file, identified by what matched.
pub enum FileMatch {
    /// The file's name contains the query; its content does not, or was not
    /// compared.
    Name {
        /// Absolute path of the file, starting with the search root as given.
        path: String,
    },
    /// The file's content contains the query; its name does not, or was not
    /// compared.
    Content {
        /// Absolute path of the file, starting with the search root as given.
        path: String,
        /// The first matching lines in file order; never empty.
        snippets: Vec<ContentSnippet>,
    },
    /// Both the file's name and its content contain the query.
    NameAndContent {
        /// Absolute path of the file, starting with the search root as given.
        path: String,
        /// The first matching lines in file order; never empty.
        snippets: Vec<ContentSnippet>,
    },
}

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
/// One line of a file that contains the query.
pub struct ContentSnippet {
    /// One-based number of the line, where lines end at `\n` or `\r\n`.
    line_number: usize,
    /// The whole line without its line ending, or, for a line longer than
    /// `MAX_SNIPPET_CHARS` characters, the `MAX_SNIPPET_CHARS`-character part
    /// that starts up to `SNIPPET_LEADING_CHARS` characters before the first
    /// match.
    text: String,
    /// Whether `text` is only part of a longer line.
    is_partial_line: bool,
}

/// Validated search performed by `find_matching_files`.
#[derive(Debug)]
struct FileSearch {
    /// Absolute path of a directory that could be listed when the search was
    /// parsed.
    root: PathBuf,
    /// Query after Unicode lowercasing, compared with lowercased names and
    /// lines.
    folded_query: String,
    /// Part of each file compared with the query.
    target: SearchFilesTarget,
    /// Number of matches after which the search stops, from 1 to
    /// `MAX_RESULTS_LIMIT`.
    max_results: usize,
    /// Number of snippets collected per file, from 1 to
    /// `MAX_SNIPPETS_PER_FILE_LIMIT`.
    max_snippets_per_file: usize,
    /// Names the walk leaves out, and the check of every file it reads.
    credential_files: CredentialFiles,
    /// Folders every file the walk reads must be inside, as when the search
    /// was parsed.
    approved_folders: ApprovedFolders,
    /// Identity of Lys's settings file when the search was parsed, or `None`
    /// when there was none; the walk leaves the file out.
    settings_file: Option<FileIdentity>,
    /// Identity of the folder that holds Lys's settings file when the search
    /// was parsed, or `None` when there was none; the walk leaves out the
    /// copies of the settings file that stopped saves left in it.
    settings_folder: Option<FileIdentity>,
}

/// One directory entry, classified without following symbolic links.
///
/// A credential file or folder, Lys's settings file, or a copy of it that a
/// stopped save left, is [`ListedEntry::Ignored`] whatever its type.
enum ListedEntry {
    /// A subdirectory, searched after the current directory level.
    Directory(PathBuf),
    /// A regular file whose path is valid UTF-8.
    File(ListedFile),
    /// An entry whose type could not be read or whose path is not valid UTF-8.
    Unexaminable,
    /// A symbolic link, FIFO, socket, or device, or a credential file or
    /// folder, or Lys's settings file, which is never followed, read, or
    /// reported.
    Ignored,
}

/// Regular file found while listing a directory.
struct ListedFile {
    /// Absolute path reported when the file matches.
    path: String,
    /// The file's name after Unicode lowercasing.
    folded_name: String,
}

/// What reading a file's content established for the search totals.
enum ContentScanOutcome {
    /// The target does not include content, so nothing was read.
    NotSearched,
    /// The content was read, whether or not it is UTF-8 text.
    Read {
        /// Number of bytes read.
        size_bytes: u64,
    },
    /// The file is larger than `MAX_SEARCHED_FILE_SIZE_BYTES`; nothing was
    /// read.
    Oversized,
    /// The file could not be opened or read.
    Unreadable,
}

/// Result of reading one file's content for a search.
struct ContentScan {
    /// What the read established for the search totals.
    outcome: ContentScanOutcome,
    /// Matching lines in file order; empty unless UTF-8 content was read and
    /// matched.
    snippets: Vec<ContentSnippet>,
}

/// Result of comparing one file with a search.
struct FileExamination {
    /// Match to report, or `None` when neither the name nor the content
    /// matched.
    file_match: Option<FileMatch>,
    /// What reading the file's content established.
    content_scan_outcome: ContentScanOutcome,
}

/// Running totals of one search, written only by `find_matching_files` and the
/// update functions it passes them to.
#[derive(Default)]
struct SearchTally {
    /// Matches found so far, in traversal order.
    matches: Vec<FileMatch>,
    /// Directory entries examined so far.
    scanned_entry_count: usize,
    /// Content bytes read so far.
    scanned_content_bytes: u64,
    /// Entries that could not be examined so far.
    skipped_path_count: usize,
    /// Files whose content was too large to search so far.
    oversized_file_count: usize,
}

#[tauri::command]
/// Finds regular files under `filter.root` whose name or content contains
/// `filter.query`.
///
/// The renderer invokes this command as `find_files` with the argument object
/// `{ filter }`. Any absolute root that the desktop process can list is
/// accepted, except one whose real path `credential_files` refuses, and one
/// whose real path is outside the folders the person lets tools use, which
/// are read from the settings file of `lys_home` for every call: whether Lys
/// may search any other directory is decided by the caller that runs tool
/// requests. Nothing is modified. The search runs on Tauri's blocking-task
/// pool so the window stays responsive; it cannot be cancelled and is bounded
/// by the result, entry, and content-byte budgets reported through
/// [`SearchCompletion`].
///
/// # Errors
///
/// Rejects as [`find_files_in_background`] does.
pub async fn find_files(
    filter: SearchFilesFilter,
    credential_files: State<'_, CredentialFiles>,
    lys_home: State<'_, LysHome>,
) -> Result<SearchFilesReport, SearchFilesError> {
    find_files_in_background(
        filter,
        credential_files.inner().clone(),
        lys_home.settings_path(),
    )
    .await
}

/// Searches with `filter` on Tauri's blocking-task pool.
///
/// # Errors
///
/// Rejects with a [`SearchFilesError`] when the filter is invalid, the root is
/// missing, not a directory, inside a credential folder, outside the folders
/// saved in the settings file at `settings_path`, or cannot be listed, or the
/// search task fails.
async fn find_files_in_background(
    filter: SearchFilesFilter,
    credential_files: CredentialFiles,
    settings_path: PathBuf,
) -> Result<SearchFilesReport, SearchFilesError> {
    let search_task = tauri::async_runtime::spawn_blocking(move || {
        let approved_folders = ApprovedFolders::read(&settings_path);
        find_files_under_root(filter, credential_files, approved_folders)
    });

    match search_task.await {
        Ok(search_result) => search_result,
        Err(error) => Err(SearchFilesError::SearchFailed {
            message: format!("The file search stopped unexpectedly: {error}"),
        }),
    }
}

/// Validates `filter` and searches the tree under its root.
///
/// # Errors
///
/// Returns the [`SearchFilesError`] that describes why the search cannot run.
fn find_files_under_root(
    filter: SearchFilesFilter,
    credential_files: CredentialFiles,
    approved_folders: ApprovedFolders,
) -> Result<SearchFilesReport, SearchFilesError> {
    let search = parse_search_files_filter(filter, credential_files, approved_folders)?;

    Ok(find_matching_files(&search))
}

/// Parses a raw filter into a search that `credential_files` and
/// `approved_folders` limit, applying the documented defaults.
///
/// The query and limits are checked before the root is inspected on disk.
/// The identity of Lys's settings file is looked up once, after the root.
///
/// # Errors
///
/// Returns the [`SearchFilesError`] for the first invalid value, checked in
/// the order query, `maxResults`, `maxSnippetsPerFile`, root.
fn parse_search_files_filter(
    filter: SearchFilesFilter,
    credential_files: CredentialFiles,
    approved_folders: ApprovedFolders,
) -> Result<FileSearch, SearchFilesError> {
    let folded_query = parse_search_query(&filter.query)?;
    let max_results = filter.max_results.unwrap_or(DEFAULT_MAX_RESULTS);

    if !is_limit_in_range(max_results, MAX_RESULTS_LIMIT) {
        return Err(SearchFilesError::MaxResultsOutOfRange {
            maximum: MAX_RESULTS_LIMIT,
        });
    }

    let max_snippets_per_file = filter
        .max_snippets_per_file
        .unwrap_or(DEFAULT_MAX_SNIPPETS_PER_FILE);

    if !is_limit_in_range(max_snippets_per_file, MAX_SNIPPETS_PER_FILE_LIMIT) {
        return Err(SearchFilesError::MaxSnippetsPerFileOutOfRange {
            maximum: MAX_SNIPPETS_PER_FILE_LIMIT,
        });
    }

    let root = parse_search_root(filter.root, &credential_files, &approved_folders)?;
    let settings_file = credential_files.find_settings_file();
    let settings_folder = credential_files.find_settings_folder();

    Ok(FileSearch {
        root,
        folded_query,
        target: filter.target,
        max_results,
        max_snippets_per_file,
        credential_files,
        approved_folders,
        settings_file,
        settings_folder,
    })
}

/// Validates a query and lowercases it for case-insensitive comparison.
///
/// # Errors
///
/// Returns [`SearchFilesError::EmptyQuery`],
/// [`SearchFilesError::MultilineQuery`], or
/// [`SearchFilesError::QueryTooLong`] for a query the search cannot use.
fn parse_search_query(query: &str) -> Result<String, SearchFilesError> {
    if query.trim().is_empty() {
        return Err(SearchFilesError::EmptyQuery);
    }

    if query.contains(['\n', '\r']) {
        return Err(SearchFilesError::MultilineQuery);
    }

    if query.chars().count() > MAX_QUERY_CHARS {
        return Err(SearchFilesError::QueryTooLong {
            max_chars: MAX_QUERY_CHARS,
        });
    }

    Ok(query.to_lowercase())
}

/// Validates that `root` is an absolute path to a directory that the desktop
/// process can list, that is not inside a credential folder, and that is
/// inside an approved folder.
///
/// Symbolic links in the root path are followed. The root's real path, with
/// every link resolved, must have no part that `credential_files` names a
/// credential, and `approved_folders` must hold it. The directory is then
/// listed once to prove access and closed.
/// The root keeps the form it was given in, so reported paths start with it.
///
/// # Errors
///
/// Returns [`SearchFilesError::RootNotAbsolute`],
/// [`SearchFilesError::RootNotFound`],
/// [`SearchFilesError::RootNotADirectory`],
/// [`SearchFilesError::RootInCredentialFolder`],
/// [`SearchFilesError::RootOutsideApprovedFolders`],
/// [`SearchFilesError::SettingsUnreadable`],
/// [`SearchFilesError::PermissionDenied`], or
/// [`SearchFilesError::SearchFailed`] for any other operating-system failure.
fn parse_search_root(
    root: PathBuf,
    credential_files: &CredentialFiles,
    approved_folders: &ApprovedFolders,
) -> Result<PathBuf, SearchFilesError> {
    if !root.is_absolute() {
        return Err(SearchFilesError::RootNotAbsolute);
    }

    let metadata = fs::metadata(&root).map_err(build_root_error)?;

    if !metadata.is_dir() {
        return Err(SearchFilesError::RootNotADirectory);
    }

    let real_root = fs::canonicalize(&root).map_err(build_root_error)?;

    if credential_files.holds_credential_part(&real_root) {
        return Err(SearchFilesError::RootInCredentialFolder);
    }

    approved_folders
        .check_real_path(&real_root)
        .map_err(|refusal| match refusal {
            ApprovedFolderRefusal::Outside => SearchFilesError::RootOutsideApprovedFolders,
            ApprovedFolderRefusal::SettingsUnreadable => SearchFilesError::SettingsUnreadable,
        })?;

    fs::read_dir(&root).map_err(build_root_error)?;

    Ok(root)
}

/// Builds the failure reported when the search root cannot be inspected.
fn build_root_error(error: io::Error) -> SearchFilesError {
    match error.kind() {
        io::ErrorKind::NotFound | io::ErrorKind::NotADirectory => SearchFilesError::RootNotFound,
        io::ErrorKind::PermissionDenied => SearchFilesError::PermissionDenied,
        _ => SearchFilesError::SearchFailed {
            message: error.to_string(),
        },
    }
}

/// Returns whether a requested result or snippet limit lies within
/// `1..=maximum`.
fn is_limit_in_range(limit: usize, maximum: usize) -> bool {
    (1..=maximum).contains(&limit)
}

/// Walks the tree under the search root and collects matches within the
/// search budgets.
///
/// Directories are visited breadth-first and the entries of each directory in
/// byte order of their names, so an unchanged tree whose directories each hold
/// at most [`MAX_SCANNED_ENTRY_COUNT`] entries always yields the same matches
/// in the same order. Subdirectories that cannot be listed are counted as
/// skipped. Because no link is followed, the real path of every entry is the
/// root's real path followed by the names walked, so leaving out each
/// credential name keeps every credential file and folder out of the walk.
fn find_matching_files(search: &FileSearch) -> SearchFilesReport {
    let mut pending_directories = VecDeque::from([search.root.clone()]);
    let mut tally = SearchTally::default();

    while let Some(directory) = pending_directories.pop_front() {
        let Ok(entries) = list_directory_entries(&directory, search) else {
            tally.skipped_path_count += 1;
            continue;
        };

        for entry in entries {
            if let Some(completion) = find_search_stop(&tally, search) {
                return build_search_report(tally, completion);
            }

            tally.scanned_entry_count += 1;

            match entry {
                ListedEntry::Directory(path) => pending_directories.push_back(path),
                ListedEntry::File(file) => {
                    tally = update_search_tally(tally, find_file_match(file, search))
                }
                ListedEntry::Unexaminable => tally.skipped_path_count += 1,
                ListedEntry::Ignored => {}
            }
        }
    }

    build_search_report(tally, SearchCompletion::Complete)
}

/// Lists the entries of `directory` for `search`, sorted in byte order of
/// their names.
///
/// At most [`MAX_SCANNED_ENTRY_COUNT`] + 1 entries are read: a search never
/// examines more than [`MAX_SCANNED_ENTRY_COUNT`], and the one extra entry
/// makes a search that reaches the end of a truncated listing stop with
/// [`SearchCompletion::ScanLimitReached`] instead of reporting it complete. In
/// a larger directory, only the entries the operating system returns first are
/// listed. Entries that the operating system fails to return are listed last
/// as [`ListedEntry::Unexaminable`].
///
/// # Errors
///
/// Returns the operating system's error when the directory cannot be opened.
fn list_directory_entries(directory: &Path, search: &FileSearch) -> io::Result<Vec<ListedEntry>> {
    let mut named_entries = Vec::new();
    let mut unreadable_entry_count = 0;

    for entry in fs::read_dir(directory)?.take(MAX_SCANNED_ENTRY_COUNT + 1) {
        match entry {
            Ok(entry) => {
                named_entries.push((entry.file_name(), build_listed_entry(&entry, search)))
            }
            Err(_) => unreadable_entry_count += 1,
        }
    }

    named_entries.sort_by(|(left_name, _), (right_name, _)| left_name.cmp(right_name));

    let unreadable_entries =
        std::iter::repeat_with(|| ListedEntry::Unexaminable).take(unreadable_entry_count);

    Ok(named_entries
        .into_iter()
        .map(|(_, listed_entry)| listed_entry)
        .chain(unreadable_entries)
        .collect())
}

/// Classifies one directory entry without following symbolic links.
///
/// An entry with a credential name is ignored before its type is read, and a
/// regular file that is Lys's settings file, or a copy of it that a stopped
/// save left, is ignored too.
fn build_listed_entry(entry: &DirEntry, search: &FileSearch) -> ListedEntry {
    if search
        .credential_files
        .is_credential_name(&entry.file_name())
    {
        return ListedEntry::Ignored;
    }

    let Ok(file_type) = entry.file_type() else {
        return ListedEntry::Unexaminable;
    };

    if file_type.is_dir() {
        return ListedEntry::Directory(entry.path());
    }

    if !file_type.is_file() {
        return ListedEntry::Ignored;
    }

    if is_settings_file_entry(entry, search.settings_file)
        || search
            .credential_files
            .is_settings_file_copy(&entry.path(), search.settings_folder)
    {
        return ListedEntry::Ignored;
    }

    build_listed_file(entry.path()).map_or(ListedEntry::Unexaminable, ListedEntry::File)
}

/// Answers whether the regular file `entry` is Lys's settings file, whose
/// identity is `settings_file`.
///
/// The entry's inode number comes with the listing, so the entry is looked up
/// only when that number is the settings file's. An entry that cannot be
/// looked up then is treated as the settings file.
fn is_settings_file_entry(entry: &DirEntry, settings_file: Option<FileIdentity>) -> bool {
    let Some(settings_file) = settings_file else {
        return false;
    };

    if entry.ino() != settings_file.inode() {
        return false;
    }

    entry.metadata().map_or(true, |metadata| {
        FileIdentity::of(&metadata) == settings_file
    })
}

/// Builds the listed form of a regular file, or `None` when its path or name
/// is not valid UTF-8.
fn build_listed_file(path: PathBuf) -> Option<ListedFile> {
    let path = path.into_os_string().into_string().ok()?;
    let folded_name = Path::new(&path).file_name()?.to_str()?.to_lowercase();

    Some(ListedFile { path, folded_name })
}

/// Finds the reason to stop the search before examining another entry, if
/// there is one.
fn find_search_stop(tally: &SearchTally, search: &FileSearch) -> Option<SearchCompletion> {
    if tally.matches.len() >= search.max_results {
        return Some(SearchCompletion::ResultLimitReached);
    }

    let is_scan_budget_spent = tally.scanned_entry_count >= MAX_SCANNED_ENTRY_COUNT
        || tally.scanned_content_bytes >= MAX_SCANNED_CONTENT_BYTES;

    is_scan_budget_spent.then_some(SearchCompletion::ScanLimitReached)
}

/// Finds whether one listed file matches by comparing its name and, when the
/// target includes it, its content with the search query.
///
/// The examination also reports what reading the content established, so the
/// caller can update the search totals whether or not the file matched.
fn find_file_match(file: ListedFile, search: &FileSearch) -> FileExamination {
    let is_name_match =
        should_match_file_name(search.target) && file.folded_name.contains(&search.folded_query);
    let content_scan = if should_search_file_content(search.target) {
        read_content_snippets(&file.path, search)
    } else {
        ContentScan {
            outcome: ContentScanOutcome::NotSearched,
            snippets: Vec::new(),
        }
    };

    FileExamination {
        file_match: build_file_match(file.path, is_name_match, content_scan.snippets),
        content_scan_outcome: content_scan.outcome,
    }
}

/// Returns whether a search with `target` compares file names.
fn should_match_file_name(target: SearchFilesTarget) -> bool {
    match target {
        SearchFilesTarget::Name | SearchFilesTarget::NameAndContent => true,
        SearchFilesTarget::Content => false,
    }
}

/// Returns whether a search with `target` compares file content.
fn should_search_file_content(target: SearchFilesTarget) -> bool {
    match target {
        SearchFilesTarget::Content | SearchFilesTarget::NameAndContent => true,
        SearchFilesTarget::Name => false,
    }
}

/// Reads the text of the file at `path` and collects snippets of its lines
/// that contain the query.
fn read_content_snippets(path: &str, search: &FileSearch) -> ContentScan {
    match read_regular_text_file(
        Path::new(path),
        MAX_SEARCHED_FILE_SIZE_BYTES,
        &search.credential_files,
        &search.approved_folders,
    ) {
        Ok(content) => ContentScan {
            outcome: ContentScanOutcome::Read {
                size_bytes: content.len() as u64,
            },
            snippets: list_matching_line_snippets(&content, search),
        },
        Err(error) => ContentScan {
            outcome: build_unsearched_content_outcome(error),
            snippets: Vec::new(),
        },
    }
}

/// Builds the totals outcome of a file whose content could not be searched.
///
/// Content that is not UTF-8 was still read, so its bytes count toward the
/// content budget. A credential file, or a file outside the approved
/// folders, reaches a read only when the tree changed after it was listed,
/// and counts as unreadable.
fn build_unsearched_content_outcome(error: TextFileReadError) -> ContentScanOutcome {
    match error {
        TextFileReadError::NotUtf8 { size_bytes } => ContentScanOutcome::Read { size_bytes },
        TextFileReadError::TooLarge { .. } => ContentScanOutcome::Oversized,
        TextFileReadError::NotFound
        | TextFileReadError::PermissionDenied
        | TextFileReadError::NotARegularFile
        | TextFileReadError::CredentialFile
        | TextFileReadError::OutsideApprovedFolders
        | TextFileReadError::SettingsUnreadable
        | TextFileReadError::Io(_) => ContentScanOutcome::Unreadable,
    }
}

/// Lists snippets of the first lines of `content` that contain the folded
/// query, at most `search.max_snippets_per_file` of them.
fn list_matching_line_snippets(content: &str, search: &FileSearch) -> Vec<ContentSnippet> {
    content
        .lines()
        .enumerate()
        .filter_map(|(line_index, line)| {
            build_line_snippet(line_index + 1, line, &search.folded_query)
        })
        .take(search.max_snippets_per_file)
        .collect()
}

/// Builds the snippet of one line, or `None` when the line does not contain
/// the folded query.
fn build_line_snippet(
    line_number: usize,
    line: &str,
    folded_query: &str,
) -> Option<ContentSnippet> {
    let match_char_index = find_folded_match_char_index(line, folded_query)?;
    let line_char_count = line.chars().count();

    if line_char_count <= MAX_SNIPPET_CHARS {
        return Some(ContentSnippet {
            line_number,
            text: line.to_owned(),
            is_partial_line: false,
        });
    }

    let start_char_index = match_char_index
        .saturating_sub(SNIPPET_LEADING_CHARS)
        .min(line_char_count - MAX_SNIPPET_CHARS);
    let partial_line: String = line
        .chars()
        .skip(start_char_index)
        .take(MAX_SNIPPET_CHARS)
        .collect();

    Some(ContentSnippet {
        line_number,
        text: partial_line,
        is_partial_line: true,
    })
}

/// Finds the character index in `line` where the first case-insensitive match
/// of `folded_query` starts, or `None` when the line does not contain it.
///
/// Lowercasing can change the byte length of a character, so the match is
/// located in the lowercased line and its byte offset is mapped back to a
/// character of the original line. `str::to_lowercase` produces, for every
/// character, the same number of bytes as `char::to_lowercase`, which makes
/// that mapping exact.
fn find_folded_match_char_index(line: &str, folded_query: &str) -> Option<usize> {
    let match_byte_index = line.to_lowercase().find(folded_query)?;
    let mut folded_byte_index = 0;

    let char_count_before_match = line
        .chars()
        .take_while(|character| {
            let is_before_match = folded_byte_index < match_byte_index;
            folded_byte_index += character.to_lowercase().map(char::len_utf8).sum::<usize>();
            is_before_match
        })
        .count();

    Some(char_count_before_match)
}

/// Builds the reported match for a file from what matched, or `None` when
/// nothing did.
fn build_file_match(
    path: String,
    is_name_match: bool,
    snippets: Vec<ContentSnippet>,
) -> Option<FileMatch> {
    match (is_name_match, snippets.is_empty()) {
        (true, true) => Some(FileMatch::Name { path }),
        (true, false) => Some(FileMatch::NameAndContent { path, snippets }),
        (false, false) => Some(FileMatch::Content { path, snippets }),
        (false, true) => None,
    }
}

/// Updates the search totals with one file's examination.
fn update_search_tally(mut tally: SearchTally, examination: FileExamination) -> SearchTally {
    tally.matches.extend(examination.file_match);

    match examination.content_scan_outcome {
        ContentScanOutcome::NotSearched => {}
        ContentScanOutcome::Read { size_bytes } => tally.scanned_content_bytes += size_bytes,
        ContentScanOutcome::Oversized => tally.oversized_file_count += 1,
        ContentScanOutcome::Unreadable => tally.skipped_path_count += 1,
    }

    tally
}

/// Builds the report of a search that ended for `completion`.
fn build_search_report(tally: SearchTally, completion: SearchCompletion) -> SearchFilesReport {
    SearchFilesReport {
        matches: tally.matches,
        completion,
        skipped_path_count: tally.skipped_path_count,
        oversized_file_count: tally.oversized_file_count,
    }
}

/// Builds the definition of the search-files tool for the client tool list.
///
/// The tool is named `search_files`, the name the protocol and Settings use,
/// although its command is `find_files`. Its arguments are the keys of the
/// command's `filter` argument, so a model's arguments can be passed on
/// unchanged.
pub(super) fn build_search_files_definition() -> ToolDefinition {
    ToolDefinition {
        name: "search_files",
        description: String::from(
            "Find files under a directory whose name or content contains the query, ignoring case. Returns each matching file's absolute path and, for content matches, its first matching lines with their line numbers. Private key and credential files and folders, and Lys's settings file, are never searched or returned. When the person listed the folders tools may use, a directory outside them is refused.",
        ),
        group: ToolGroup::Files,
        access: ToolAccess::Reads,
        runner: ToolRunner::Client,
        arguments: build_search_files_arguments(),
    }
}

/// Builds the arguments of the search-files tool in the filter's key order.
///
/// The descriptions state the query and result limits taken from the
/// constants that `parse_search_files_filter` enforces, so they change with
/// those limits.
fn build_search_files_arguments() -> Vec<ToolArgumentDefinition> {
    let root_argument = ToolArgumentDefinition {
        name: "root",
        description: String::from(
            "Absolute path of the directory whose tree is searched. Symbolic links below it are not followed.",
        ),
        required: true,
        argument_type: ToolArgumentType::String,
    };
    let query_argument = ToolArgumentDefinition {
        name: "query",
        description: format!("Text to find, on one line, at most {MAX_QUERY_CHARS} characters."),
        required: true,
        argument_type: ToolArgumentType::String,
    };
    let target_type = ToolArgumentType::Enum {
        values: SEARCH_FILES_TARGET_VALUES.to_vec(),
    };
    let target_argument = ToolArgumentDefinition {
        name: "target",
        description: String::from(
            "What is compared with the query: file names, file contents, or both.",
        ),
        required: true,
        argument_type: target_type,
    };
    let max_results_argument = ToolArgumentDefinition {
        name: "maxResults",
        description: format!(
            "Most matching files to return, 1–{MAX_RESULTS_LIMIT}. Defaults to {DEFAULT_MAX_RESULTS}."
        ),
        required: false,
        argument_type: ToolArgumentType::Integer,
    };
    let max_snippets_per_file_argument = ToolArgumentDefinition {
        name: "maxSnippetsPerFile",
        description: format!(
            "Most matching lines per file, 1–{MAX_SNIPPETS_PER_FILE_LIMIT}. Defaults to {DEFAULT_MAX_SNIPPETS_PER_FILE}. Unused when target is name."
        ),
        required: false,
        argument_type: ToolArgumentType::Integer,
    };

    vec![
        root_argument,
        query_argument,
        target_argument,
        max_results_argument,
        max_snippets_per_file_argument,
    ]
}

#[cfg(test)]
mod tests {
    use std::{
        fs::{self, Permissions},
        os::unix::fs::{symlink, PermissionsExt},
        path::Path,
    };

    use serde_json::{json, Value};

    use super::{
        find_files_in_background, find_folded_match_char_index, find_search_stop,
        parse_search_files_filter, FileMatch, FileSearch, SearchCompletion, SearchFilesError,
        SearchFilesFilter, SearchFilesReport, SearchFilesTarget, SearchTally, MAX_QUERY_CHARS,
        MAX_RESULTS_LIMIT, MAX_SCANNED_CONTENT_BYTES, MAX_SCANNED_ENTRY_COUNT,
        MAX_SEARCHED_FILE_SIZE_BYTES, MAX_SNIPPETS_PER_FILE_LIMIT, MAX_SNIPPET_CHARS,
        SEARCH_FILES_TARGET_VALUES,
    };
    use crate::tools::{
        approved_folders::ApprovedFolders, credential_files::CredentialFiles,
        test_directory::TestDirectory,
    };

    /// Deserializes `filter` as Tauri does for the `filter` argument and finds
    /// files as the `find_files` command does, for a Lys home without a
    /// settings file, blocking until the search completes.
    fn find_files_blocking(filter: Value) -> Result<SearchFilesReport, SearchFilesError> {
        find_files_with(
            filter,
            CredentialFiles::load_for_test_without_settings_file(),
        )
    }

    /// Deserializes `filter` and finds files as the `find_files` command does,
    /// with `credential_files` and no settings file, so no folder is listed,
    /// blocking until the search completes.
    fn find_files_with(
        filter: Value,
        credential_files: CredentialFiles,
    ) -> Result<SearchFilesReport, SearchFilesError> {
        find_files_in_folders(filter, credential_files, Path::new(MISSING_SETTINGS_PATH))
    }

    /// Deserializes `filter` and finds files as the `find_files` command does,
    /// with `credential_files` and the folders listed in the settings file at
    /// `settings_path`, blocking until the search completes.
    fn find_files_in_folders(
        filter: Value,
        credential_files: CredentialFiles,
        settings_path: &Path,
    ) -> Result<SearchFilesReport, SearchFilesError> {
        let filter: SearchFilesFilter =
            serde_json::from_value(filter).expect("a filter that deserializes");

        tauri::async_runtime::block_on(find_files_in_background(
            filter,
            credential_files,
            settings_path.to_path_buf(),
        ))
    }

    /// Settings path of a Lys home without a settings file.
    const MISSING_SETTINGS_PATH: &str = "/nonexistent/lys-test/settings.json";

    /// Deserializes and parses `filter` without searching.
    fn parse_filter(filter: Value) -> Result<FileSearch, SearchFilesError> {
        let filter: SearchFilesFilter =
            serde_json::from_value(filter).expect("a filter that deserializes");

        parse_search_files_filter(
            filter,
            CredentialFiles::load_for_test_without_settings_file(),
            ApprovedFolders::Any,
        )
    }

    /// Returns the UTF-8 form of a test path.
    fn get_path_text(path: &Path) -> String {
        path.to_str().expect("a UTF-8 test path").to_owned()
    }

    /// Returns the path of one match.
    fn get_match_path(file_match: &FileMatch) -> &str {
        match file_match {
            FileMatch::Name { path }
            | FileMatch::Content { path, .. }
            | FileMatch::NameAndContent { path, .. } => path,
        }
    }

    /// Lists the paths of a report's matches in report order.
    fn list_match_paths(report: &SearchFilesReport) -> Vec<&str> {
        report.matches.iter().map(get_match_path).collect()
    }

    /// Creates `count` empty files directly under `directory`. Their names are
    /// zero-padded numbers, so none contains the query `todo`.
    fn create_unmatched_empty_files(directory: &TestDirectory, count: usize) {
        for file_index in 0..count {
            directory.create_file(&format!("{file_index:05}"), "");
        }
    }

    #[test]
    fn parses_camel_case_filter_keys() {
        let directory = TestDirectory::create("filter-keys");

        let search = parse_filter(json!({
            "root": get_path_text(directory.path()),
            "query": "Todo",
            "target": "nameAndContent",
            "maxResults": 7,
            "maxSnippetsPerFile": 2
        }))
        .expect("a valid filter");

        assert_eq!(search.root, directory.path());
        assert_eq!(search.folded_query, "todo");
        assert_eq!(search.target, SearchFilesTarget::NameAndContent);
        assert_eq!(search.max_results, 7);
        assert_eq!(search.max_snippets_per_file, 2);
    }

    #[test]
    fn applies_default_limits_when_they_are_omitted_or_null() {
        let directory = TestDirectory::create("filter-defaults");
        let root = get_path_text(directory.path());

        let omitted = parse_filter(json!({ "root": root, "query": "a", "target": "name" }))
            .expect("a valid filter");
        let null = parse_filter(json!({
            "root": root,
            "query": "a",
            "target": "content",
            "maxResults": null,
            "maxSnippetsPerFile": null
        }))
        .expect("a valid filter");

        assert_eq!(
            (omitted.max_results, omitted.max_snippets_per_file),
            (50, 3)
        );
        assert_eq!((null.max_results, null.max_snippets_per_file), (50, 3));
    }

    #[test]
    fn rejects_unknown_filter_keys_and_targets() {
        let unknown_key = serde_json::from_value::<SearchFilesFilter>(json!({
            "root": "/",
            "query": "a",
            "target": "name",
            "maxDepth": 2
        }));
        let unknown_target = serde_json::from_value::<SearchFilesFilter>(json!({
            "root": "/",
            "query": "a",
            "target": "fileName"
        }));

        assert!(unknown_key.is_err());
        assert!(unknown_target.is_err());
    }

    #[test]
    fn rejects_invalid_roots() {
        let directory = TestDirectory::create("filter-roots");
        let file = directory.create_file("notes.txt", "notes");
        let parse_root = |root: String| {
            parse_filter(json!({ "root": root, "query": "a", "target": "name" })).err()
        };

        assert_eq!(
            parse_root(String::from("relative/dir")),
            Some(SearchFilesError::RootNotAbsolute)
        );
        assert_eq!(
            parse_root(get_path_text(&directory.path().join("missing"))),
            Some(SearchFilesError::RootNotFound)
        );
        assert_eq!(
            parse_root(get_path_text(&file)),
            Some(SearchFilesError::RootNotADirectory)
        );
        assert_eq!(
            parse_root(get_path_text(&file.join("child"))),
            Some(SearchFilesError::RootNotFound)
        );
    }

    #[test]
    fn refuses_a_root_whose_real_path_is_inside_a_credential_folder() {
        let directory = TestDirectory::create("filter-credential-root");
        let keys = directory.create_subdirectory(".ssh/keys");
        let link = directory.path().join("projects");
        symlink(directory.path().join(".ssh"), &link).expect("link a credential folder");
        let parse_root = |root: &Path| {
            parse_filter(json!({ "root": get_path_text(root), "query": "a", "target": "name" }))
                .err()
        };

        for root in [&directory.path().join(".ssh"), &keys, &link] {
            assert_eq!(
                parse_root(root),
                Some(SearchFilesError::RootInCredentialFolder),
                "{} is inside a credential folder",
                root.display()
            );
        }
    }

    #[test]
    fn searches_under_an_approved_folder_and_refuses_a_root_beside_it_or_linked_out() {
        let directory = TestDirectory::create("search-approved-folders");
        let app = directory.create_subdirectory("work/app");
        directory.create_file("work/app/notes.txt", "todo\n");
        let beside = directory.create_subdirectory("work/app-old");
        let outside = directory.create_subdirectory("other");
        let link_out = app.join("other");
        symlink(&outside, &link_out).expect("link a folder outside");
        let settings_path = directory.create_file(
            "lys/settings.json",
            json!({ "tools": { "approvedFolders": [get_path_text(&app)] } }).to_string(),
        );
        let search = |root: &Path| {
            find_files_in_folders(
                json!({ "root": get_path_text(root), "query": "todo", "target": "content" }),
                CredentialFiles::load_for_test(settings_path.clone()),
                &settings_path,
            )
        };

        let report = search(&app).expect("a search inside the approved folder");
        assert_eq!(
            list_match_paths(&report),
            [get_path_text(&app.join("notes.txt"))]
        );
        for root in [&beside, &outside, &link_out, &directory.path().join("work")] {
            assert_eq!(
                search(root).err(),
                Some(SearchFilesError::RootOutsideApprovedFolders),
                "{} is outside the approved folder",
                root.display()
            );
        }
    }

    #[test]
    fn searches_nothing_when_the_settings_file_cannot_be_parsed() {
        let directory = TestDirectory::create("search-unparsed-settings");
        let work = directory.create_subdirectory("work");
        directory.create_file("work/notes.txt", "todo\n");
        let settings_path = directory.create_file("lys/settings.json", "{ not json");

        let search_result = find_files_in_folders(
            json!({ "root": get_path_text(&work), "query": "todo", "target": "content" }),
            CredentialFiles::load_for_test_without_settings_file(),
            &settings_path,
        );

        assert_eq!(
            search_result.err(),
            Some(SearchFilesError::SettingsUnreadable)
        );
    }

    #[test]
    fn reports_a_root_that_cannot_be_listed_as_permission_denied() {
        let directory = TestDirectory::create("search-locked-root");
        let locked = directory.create_subdirectory("locked");
        fs::set_permissions(&locked, Permissions::from_mode(0o000)).expect("lock the directory");
        let is_listing_denied = fs::read_dir(&locked).is_err();

        let search_result = find_files_blocking(json!({
            "root": get_path_text(&locked),
            "query": "todo",
            "target": "name"
        }));
        fs::set_permissions(&locked, Permissions::from_mode(0o700)).expect("unlock the directory");

        assert!(
            is_listing_denied,
            "this test needs a user whose access to a mode-000 directory is denied"
        );
        assert_eq!(
            search_result.err(),
            Some(SearchFilesError::PermissionDenied)
        );
    }

    #[test]
    fn reports_a_root_that_cannot_be_resolved_as_a_search_failure() {
        let directory = TestDirectory::create("search-looped-root");
        let looped_root = directory.path().join("loop");
        symlink(&looped_root, &looped_root).expect("link the root to itself");

        let search_result = find_files_blocking(json!({
            "root": get_path_text(&looped_root),
            "query": "todo",
            "target": "name"
        }));

        assert!(matches!(
            search_result,
            Err(SearchFilesError::SearchFailed { .. })
        ));
    }

    #[test]
    fn rejects_blank_and_multiline_queries() {
        let parse_query = |query: &str| {
            parse_filter(json!({ "root": "/", "query": query, "target": "name" })).err()
        };

        assert_eq!(parse_query(""), Some(SearchFilesError::EmptyQuery));
        assert_eq!(parse_query(" \t"), Some(SearchFilesError::EmptyQuery));
        assert_eq!(
            parse_query("first\nsecond"),
            Some(SearchFilesError::MultilineQuery)
        );
        assert_eq!(
            parse_query("first\rsecond"),
            Some(SearchFilesError::MultilineQuery)
        );
    }

    #[test]
    fn limits_query_length_in_characters() {
        let parse_query = |query: String| {
            parse_filter(json!({ "root": "/", "query": query, "target": "name" })).err()
        };

        assert_eq!(parse_query("đ".repeat(MAX_QUERY_CHARS)), None);
        assert_eq!(
            parse_query("đ".repeat(MAX_QUERY_CHARS + 1)),
            Some(SearchFilesError::QueryTooLong {
                max_chars: MAX_QUERY_CHARS
            })
        );
    }

    #[test]
    fn limits_max_results_to_its_range() {
        let parse_max_results = |max_results: usize| {
            parse_filter(json!({
                "root": "/",
                "query": "a",
                "target": "name",
                "maxResults": max_results
            }))
            .err()
        };
        let out_of_range = Some(SearchFilesError::MaxResultsOutOfRange {
            maximum: MAX_RESULTS_LIMIT,
        });

        assert_eq!(parse_max_results(0), out_of_range);
        assert_eq!(parse_max_results(1), None);
        assert_eq!(parse_max_results(MAX_RESULTS_LIMIT), None);
        assert_eq!(parse_max_results(MAX_RESULTS_LIMIT + 1), out_of_range);
    }

    #[test]
    fn limits_max_snippets_per_file_to_its_range() {
        let parse_max_snippets = |max_snippets_per_file: usize| {
            parse_filter(json!({
                "root": "/",
                "query": "a",
                "target": "content",
                "maxSnippetsPerFile": max_snippets_per_file
            }))
            .err()
        };
        let out_of_range = Some(SearchFilesError::MaxSnippetsPerFileOutOfRange {
            maximum: MAX_SNIPPETS_PER_FILE_LIMIT,
        });

        assert_eq!(parse_max_snippets(0), out_of_range);
        assert_eq!(parse_max_snippets(1), None);
        assert_eq!(parse_max_snippets(MAX_SNIPPETS_PER_FILE_LIMIT), None);
        assert_eq!(
            parse_max_snippets(MAX_SNIPPETS_PER_FILE_LIMIT + 1),
            out_of_range
        );
    }

    #[test]
    fn finds_file_names_case_insensitively_breadth_first() {
        let directory = TestDirectory::create("search-names");
        directory.create_file("b-Report.txt", "");
        directory.create_file("c-notes.txt", "report");
        directory.create_file("a/report-2024.md", "");
        directory.create_file("a/deep/REPORT.csv", "");
        directory.create_subdirectory("reports");

        let report = find_files_blocking(json!({
            "root": get_path_text(directory.path()),
            "query": "rEpOrT",
            "target": "name"
        }))
        .expect("a completed search");

        assert_eq!(
            list_match_paths(&report),
            [
                get_path_text(&directory.path().join("b-Report.txt")),
                get_path_text(&directory.path().join("a/report-2024.md")),
                get_path_text(&directory.path().join("a/deep/REPORT.csv")),
            ]
        );
        assert!(report
            .matches
            .iter()
            .all(|file_match| matches!(file_match, FileMatch::Name { .. })));
        assert_eq!(report.completion, SearchCompletion::Complete);
    }

    #[test]
    fn reports_matching_lines_with_their_numbers() {
        let directory = TestDirectory::create("search-content");
        let file = directory.create_file(
            "plan.md",
            "alpha\r\nTODO one\nbeta\n    todo two\nTODO three\n",
        );

        let report = find_files_blocking(json!({
            "root": get_path_text(directory.path()),
            "query": "todo",
            "target": "content",
            "maxSnippetsPerFile": 2
        }))
        .expect("a completed search");

        assert_eq!(
            serde_json::to_value(&report.matches).expect("serialize"),
            json!([{
                "kind": "content",
                "path": get_path_text(&file),
                "snippets": [
                    { "lineNumber": 2, "text": "TODO one", "isPartialLine": false },
                    { "lineNumber": 4, "text": "    todo two", "isPartialLine": false }
                ]
            }])
        );
    }

    #[test]
    fn reports_whether_the_name_the_content_or_both_matched() {
        let directory = TestDirectory::create("search-both");
        let name_only = directory.create_file("a-todo.txt", "nothing here");
        let content_only = directory.create_file("b-notes.txt", "a todo item");
        let both = directory.create_file("c-todo-list.txt", "todo: ship it");
        directory.create_file("d-other.txt", "unrelated");

        let report = find_files_blocking(json!({
            "root": get_path_text(directory.path()),
            "query": "todo",
            "target": "nameAndContent"
        }))
        .expect("a completed search");

        assert!(matches!(
            &report.matches[..],
            [
                FileMatch::Name { path: first },
                FileMatch::Content { path: second, .. },
                FileMatch::NameAndContent { path: third, .. },
            ] if *first == get_path_text(&name_only)
                && *second == get_path_text(&content_only)
                && *third == get_path_text(&both)
        ));
    }

    #[test]
    fn compares_names_only_for_the_name_target() {
        let directory = TestDirectory::create("search-name-target");
        directory.create_file("notes.txt", "todo");

        let report = find_files_blocking(json!({
            "root": get_path_text(directory.path()),
            "query": "todo",
            "target": "name"
        }))
        .expect("a completed search");

        assert!(report.matches.is_empty());
        assert_eq!(report.completion, SearchCompletion::Complete);
    }

    #[test]
    fn matches_unicode_text_case_insensitively() {
        let directory = TestDirectory::create("search-unicode");
        let file = directory.create_file("trip.txt", "Chuyến đi Đà Nẵng\n");

        let report = find_files_blocking(json!({
            "root": get_path_text(directory.path()),
            "query": "ĐÀ NẴNG",
            "target": "content"
        }))
        .expect("a completed search");

        assert_eq!(list_match_paths(&report), [get_path_text(&file)]);
    }

    #[test]
    fn does_not_match_content_that_is_not_utf8() {
        let directory = TestDirectory::create("search-binary");
        directory.create_file("data.bin", b"todo\xff\xfe");

        let report = find_files_blocking(json!({
            "root": get_path_text(directory.path()),
            "query": "todo",
            "target": "content"
        }))
        .expect("a completed search");

        assert!(report.matches.is_empty());
        assert_eq!(report.skipped_path_count, 0);
        assert_eq!(report.oversized_file_count, 0);
    }

    #[test]
    fn searches_content_up_to_the_file_size_limit() {
        let directory = TestDirectory::create("search-oversized");
        let at_limit_content = format!(
            "todo{}",
            "a".repeat(MAX_SEARCHED_FILE_SIZE_BYTES as usize - 4)
        );
        let at_limit = directory.create_file("at-limit.txt", at_limit_content);
        directory.create_file(
            "over-limit.txt",
            format!(
                "todo{}",
                "a".repeat(MAX_SEARCHED_FILE_SIZE_BYTES as usize - 3)
            ),
        );

        let report = find_files_blocking(json!({
            "root": get_path_text(directory.path()),
            "query": "todo",
            "target": "content"
        }))
        .expect("a completed search");

        assert_eq!(list_match_paths(&report), [get_path_text(&at_limit)]);
        assert_eq!(report.oversized_file_count, 1);
        assert_eq!(report.skipped_path_count, 0);
    }

    #[test]
    fn stops_after_the_requested_number_of_matches() {
        let directory = TestDirectory::create("search-max-results");
        let first = directory.create_file("a-todo.txt", "");
        let second = directory.create_file("b-todo.txt", "");
        directory.create_file("c-todo.txt", "");

        let report = find_files_blocking(json!({
            "root": get_path_text(directory.path()),
            "query": "todo",
            "target": "name",
            "maxResults": 2
        }))
        .expect("a completed search");

        assert_eq!(
            list_match_paths(&report),
            [get_path_text(&first), get_path_text(&second)]
        );
        assert_eq!(report.completion, SearchCompletion::ResultLimitReached);
    }

    #[test]
    fn neither_follows_nor_reports_symbolic_links() {
        let directory = TestDirectory::create("search-symlinks");
        let target = directory.create_file("real/todo.txt", "todo");
        symlink(&target, directory.path().join("link-todo.txt")).expect("link a file");
        symlink(
            directory.path().join("real"),
            directory.path().join("linked-dir"),
        )
        .expect("link a directory");
        symlink(directory.path(), directory.path().join("real/loop")).expect("link the root");

        let report = find_files_blocking(json!({
            "root": get_path_text(directory.path()),
            "query": "todo",
            "target": "nameAndContent"
        }))
        .expect("a completed search");

        assert_eq!(list_match_paths(&report), [get_path_text(&target)]);
        assert_eq!(report.completion, SearchCompletion::Complete);
    }

    #[test]
    fn leaves_credential_files_and_folders_and_the_settings_file_out_of_the_walk() {
        let directory = TestDirectory::create("search-credentials");
        let hidden_match = directory.create_file(".hidden/todo.md", "todo");
        let notes_match = directory.create_file("notes/todo.txt", "todo");
        directory.create_file(".hidden/.gnupg/todo.txt", "todo");
        directory.create_file(".ssh/todo.txt", "todo");
        directory.create_file("app/.env", "todo");
        directory.create_file("app/.env.production", "todo");
        directory.create_file("certs/todo.pem", "todo");
        directory.create_file("vault/todo.KDBX", "todo");
        let settings_path = directory.create_file("lys/settings.json", "todo");
        fs::hard_link(
            &settings_path,
            directory.path().join("notes/todo-settings.json"),
        )
        .expect("link the settings file");
        let expected = [get_path_text(&hidden_match), get_path_text(&notes_match)];

        for target in ["name", "content", "nameAndContent"] {
            let report = find_files_with(
                json!({
                    "root": get_path_text(directory.path()),
                    "query": "todo",
                    "target": target
                }),
                CredentialFiles::load_for_test(settings_path.clone()),
            )
            .expect("a completed search");

            assert_eq!(list_match_paths(&report), expected, "target {target}");
            assert_eq!(report.completion, SearchCompletion::Complete);
            assert_eq!(report.skipped_path_count, 0);
        }
    }

    #[test]
    fn leaves_a_leftover_copy_of_the_settings_file_out_but_not_its_name_elsewhere() {
        let directory = TestDirectory::create("search-settings-copy");
        let settings_path = directory.create_file("lys/settings.json", "todo");
        directory.create_file("lys/settings.json.4242.0.tmp", "todo");
        directory.create_file("lys/todo.txt", "todo");
        let same_name_elsewhere = directory.create_file("notes/settings.json.4242.0.tmp", "todo");
        let todo_path = directory.path().join("lys/todo.txt");
        let elsewhere = get_path_text(&same_name_elsewhere);
        let content_matches = vec![get_path_text(&todo_path), elsewhere.clone()];

        for (target, query, expected) in [
            ("name", "settings", vec![elsewhere]),
            ("content", "todo", content_matches.clone()),
            ("nameAndContent", "todo", content_matches),
        ] {
            let report = find_files_with(
                json!({
                    "root": get_path_text(directory.path()),
                    "query": query,
                    "target": target
                }),
                CredentialFiles::load_for_test(settings_path.clone()),
            )
            .expect("a completed search");

            assert_eq!(list_match_paths(&report), expected, "target {target}");
            assert_eq!(report.skipped_path_count, 0);
        }
    }

    #[test]
    fn leaves_credential_files_out_of_a_root_reached_through_a_link() {
        let directory = TestDirectory::create("search-linked-root");
        let real_root = directory.create_subdirectory("real");
        directory.create_file("real/.netrc", "machine todo");
        directory.create_file("real/id_rsa", "todo");
        directory.create_file("real/todo.txt", "todo");
        let linked_root = directory.path().join("linked");
        symlink(&real_root, &linked_root).expect("link the root");

        let report = find_files_blocking(json!({
            "root": get_path_text(&linked_root),
            "query": "todo",
            "target": "nameAndContent"
        }))
        .expect("a completed search");

        assert_eq!(
            list_match_paths(&report),
            [get_path_text(&linked_root.join("todo.txt"))]
        );
    }

    #[test]
    fn ignores_a_fifo_without_waiting_for_a_writer() {
        let directory = TestDirectory::create("search-fifo");
        directory.create_fifo("todo-pipe");

        let report = find_files_blocking(json!({
            "root": get_path_text(directory.path()),
            "query": "todo",
            "target": "nameAndContent"
        }))
        .expect("a completed search");

        assert!(report.matches.is_empty());
        assert_eq!(report.skipped_path_count, 0);
    }

    #[test]
    fn counts_a_directory_that_cannot_be_listed_as_skipped() {
        let directory = TestDirectory::create("search-unlistable");
        let locked = directory.create_subdirectory("locked");
        directory.create_file("locked/todo.txt", "todo");
        fs::set_permissions(&locked, Permissions::from_mode(0o000)).expect("lock the directory");
        let is_listing_denied = fs::read_dir(&locked).is_err();

        let search_result = find_files_blocking(json!({
            "root": get_path_text(directory.path()),
            "query": "todo",
            "target": "name"
        }));
        fs::set_permissions(&locked, Permissions::from_mode(0o700)).expect("unlock the directory");

        assert!(
            is_listing_denied,
            "this test needs a user whose access to a mode-000 directory is denied"
        );
        let report = search_result.expect("a completed search");
        assert!(report.matches.is_empty());
        assert_eq!(report.skipped_path_count, 1);
        assert_eq!(report.completion, SearchCompletion::Complete);
    }

    #[test]
    fn counts_a_file_that_cannot_be_read_as_skipped() {
        let directory = TestDirectory::create("search-unreadable");
        let locked = directory.create_file("notes.txt", "todo");
        fs::set_permissions(&locked, Permissions::from_mode(0o000)).expect("lock the file");
        let is_reading_denied = fs::read(&locked).is_err();

        let search_result = find_files_blocking(json!({
            "root": get_path_text(directory.path()),
            "query": "todo",
            "target": "content"
        }));
        fs::set_permissions(&locked, Permissions::from_mode(0o600)).expect("unlock the file");

        assert!(
            is_reading_denied,
            "this test needs a user whose access to a mode-000 file is denied"
        );
        let report = search_result.expect("a completed search");
        assert!(report.matches.is_empty());
        assert_eq!(report.skipped_path_count, 1);
        assert_eq!(report.completion, SearchCompletion::Complete);
    }

    #[test]
    fn stops_at_the_entry_budget_in_a_larger_root() {
        let directory = TestDirectory::create("search-entry-budget");
        create_unmatched_empty_files(&directory, MAX_SCANNED_ENTRY_COUNT + 1);

        let report = find_files_blocking(json!({
            "root": get_path_text(directory.path()),
            "query": "todo",
            "target": "name"
        }))
        .expect("a completed search");

        assert!(report.matches.is_empty());
        assert_eq!(report.completion, SearchCompletion::ScanLimitReached);
    }

    #[test]
    fn completes_a_root_that_holds_exactly_the_entry_budget() {
        let directory = TestDirectory::create("search-entry-budget-exact");
        create_unmatched_empty_files(&directory, MAX_SCANNED_ENTRY_COUNT);

        let report = find_files_blocking(json!({
            "root": get_path_text(directory.path()),
            "query": "todo",
            "target": "name"
        }))
        .expect("a completed search");

        assert!(report.matches.is_empty());
        assert_eq!(report.completion, SearchCompletion::Complete);
    }

    #[test]
    fn stops_at_the_content_budget_before_the_next_file() {
        let directory = TestDirectory::create("search-content-budget");
        let full_file_content = "a".repeat(MAX_SEARCHED_FILE_SIZE_BYTES as usize);
        let full_file_count = MAX_SCANNED_CONTENT_BYTES / MAX_SEARCHED_FILE_SIZE_BYTES;
        for file_index in 0..full_file_count {
            directory.create_file(&format!("a-{file_index:02}.txt"), &full_file_content);
        }
        directory.create_file("b.txt", "todo");

        let report = find_files_blocking(json!({
            "root": get_path_text(directory.path()),
            "query": "todo",
            "target": "content"
        }))
        .expect("a completed search");

        assert!(report.matches.is_empty());
        assert_eq!(report.completion, SearchCompletion::ScanLimitReached);
    }

    #[test]
    fn cuts_a_long_line_to_a_window_that_starts_before_the_match() {
        let directory = TestDirectory::create("search-long-line");
        directory.create_file(
            "minified.js",
            format!("{}Needle{}", "x".repeat(300), "y".repeat(300)),
        );

        let report = find_files_blocking(json!({
            "root": get_path_text(directory.path()),
            "query": "needle",
            "target": "content"
        }))
        .expect("a completed search");

        let [FileMatch::Content { snippets, .. }] = &report.matches[..] else {
            panic!("expected one content match, got {:?}", report.matches);
        };
        let expected_text = format!("{}Needle{}", "x".repeat(40), "y".repeat(154));
        assert_eq!(snippets[0].text, expected_text);
        assert_eq!(snippets[0].text.chars().count(), MAX_SNIPPET_CHARS);
        assert!(snippets[0].is_partial_line);
    }

    #[test]
    fn keeps_a_full_window_when_the_match_is_near_the_line_end() {
        let directory = TestDirectory::create("search-line-end");
        directory.create_file("minified.js", format!("{}Needle", "x".repeat(300)));

        let report = find_files_blocking(json!({
            "root": get_path_text(directory.path()),
            "query": "needle",
            "target": "content"
        }))
        .expect("a completed search");

        let [FileMatch::Content { snippets, .. }] = &report.matches[..] else {
            panic!("expected one content match, got {:?}", report.matches);
        };
        assert_eq!(
            snippets[0].text,
            format!("{}Needle", "x".repeat(MAX_SNIPPET_CHARS - 6))
        );
        assert!(snippets[0].is_partial_line);
    }

    #[test]
    fn maps_a_match_after_characters_whose_lowercase_is_longer() {
        // "İ" is 2 bytes, but its lowercase form "i̇" is 3 bytes.
        assert_eq!(find_folded_match_char_index("İİNeedle", "needle"), Some(2));
        assert_eq!(find_folded_match_char_index("Needle", "needle"), Some(0));
        assert_eq!(find_folded_match_char_index("haystack", "needle"), None);
    }

    #[test]
    fn stops_when_the_entry_or_content_budget_is_spent() {
        let search = FileSearch {
            root: Path::new("/").to_path_buf(),
            folded_query: String::from("todo"),
            target: SearchFilesTarget::Content,
            max_results: 10,
            max_snippets_per_file: 3,
            credential_files: CredentialFiles::load_for_test_without_settings_file(),
            approved_folders: ApprovedFolders::Any,
            settings_file: None,
            settings_folder: None,
        };
        let find_stop = |scanned_entry_count: usize, scanned_content_bytes: u64| {
            let tally = SearchTally {
                scanned_entry_count,
                scanned_content_bytes,
                ..SearchTally::default()
            };
            find_search_stop(&tally, &search)
        };

        assert_eq!(find_stop(MAX_SCANNED_ENTRY_COUNT - 1, 0), None);
        assert_eq!(
            find_stop(MAX_SCANNED_ENTRY_COUNT, 0),
            Some(SearchCompletion::ScanLimitReached)
        );
        assert_eq!(find_stop(0, MAX_SCANNED_CONTENT_BYTES - 1), None);
        assert_eq!(
            find_stop(0, MAX_SCANNED_CONTENT_BYTES),
            Some(SearchCompletion::ScanLimitReached)
        );
    }

    #[test]
    fn serializes_the_report_in_camel_case() {
        let directory = TestDirectory::create("search-report-json");
        let file = directory.create_file("todo.txt", "nothing");

        let report = find_files_blocking(json!({
            "root": get_path_text(directory.path()),
            "query": "todo",
            "target": "name"
        }))
        .expect("a completed search");

        assert_eq!(
            serde_json::to_value(&report).expect("serialize"),
            json!({
                "matches": [{ "kind": "name", "path": get_path_text(&file) }],
                "completion": "complete",
                "skippedPathCount": 0,
                "oversizedFileCount": 0
            })
        );
    }

    #[test]
    fn offers_every_target_value_the_filter_accepts() {
        let mut spelled_values = Vec::new();
        for target in [
            SearchFilesTarget::Name,
            SearchFilesTarget::Content,
            SearchFilesTarget::NameAndContent,
        ] {
            // No wildcard arm: a new target fails to compile until it is
            // spelled here. Listed above too, it then fails the comparison
            // below until SEARCH_FILES_TARGET_VALUES offers it.
            let value = match target {
                SearchFilesTarget::Name => "name",
                SearchFilesTarget::Content => "content",
                SearchFilesTarget::NameAndContent => "nameAndContent",
            };
            let parsed: SearchFilesTarget =
                serde_json::from_value(json!(value)).expect("a target the filter accepts");
            assert_eq!(parsed, target);
            spelled_values.push(value);
        }

        assert_eq!(spelled_values, SEARCH_FILES_TARGET_VALUES);
    }

    #[test]
    fn serializes_failures_with_a_camel_case_code() {
        assert_eq!(
            serde_json::to_value(SearchFilesError::EmptyQuery).expect("serialize"),
            json!({ "code": "emptyQuery" })
        );
        assert_eq!(
            serde_json::to_value(SearchFilesError::RootInCredentialFolder).expect("serialize"),
            json!({ "code": "rootInCredentialFolder" })
        );
        assert_eq!(
            serde_json::to_value(SearchFilesError::QueryTooLong {
                max_chars: MAX_QUERY_CHARS
            })
            .expect("serialize"),
            json!({ "code": "queryTooLong", "maxChars": MAX_QUERY_CHARS })
        );
        assert_eq!(
            serde_json::to_value(SearchFilesError::MaxSnippetsPerFileOutOfRange {
                maximum: MAX_SNIPPETS_PER_FILE_LIMIT
            })
            .expect("serialize"),
            json!({
                "code": "maxSnippetsPerFileOutOfRange",
                "maximum": MAX_SNIPPETS_PER_FILE_LIMIT
            })
        );
    }
}
