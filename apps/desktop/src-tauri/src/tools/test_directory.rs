//! Temporary directory trees that the file-tool tests create and delete.

use std::{
    ffi::CString,
    fs,
    os::unix::ffi::OsStrExt,
    path::{Path, PathBuf},
    sync::atomic::{AtomicUsize, Ordering},
};

/// Number given to the next directory this test process creates, so that
/// tests running in parallel never share a directory.
static NEXT_DIRECTORY_NUMBER: AtomicUsize = AtomicUsize::new(0);

/// Empty directory under the system temporary directory that the test owns.
///
/// The directory and everything created inside it are deleted when the value
/// is dropped. A deletion failure fails the test unless the test is already
/// failing, so that the original failure stays the reported one.
pub struct TestDirectory(PathBuf);

impl TestDirectory {
    /// Creates a new empty directory whose name includes `label`.
    ///
    /// # Panics
    ///
    /// Panics when the directory cannot be created, including when a directory
    /// with the same name is left over from an earlier test process.
    pub fn create(label: &str) -> Self {
        let directory_number = NEXT_DIRECTORY_NUMBER.fetch_add(1, Ordering::Relaxed);
        let directory_name = format!(
            "lys-file-tools-{}-{label}-{directory_number}",
            std::process::id()
        );
        let path = std::env::temp_dir().join(directory_name);

        fs::create_dir(&path).expect("create the test directory");

        Self(path)
    }

    /// Returns the absolute path of the directory.
    pub fn path(&self) -> &Path {
        &self.0
    }

    /// Writes `contents` to the file at `relative_path`, creating missing
    /// parent directories, and returns the file's absolute path.
    ///
    /// # Panics
    ///
    /// Panics when a directory or the file cannot be written.
    pub fn write_file(&self, relative_path: &str, contents: impl AsRef<[u8]>) -> PathBuf {
        let path = self.0.join(relative_path);

        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("create the file's parent directories");
        }
        fs::write(&path, contents).expect("write the test file");

        path
    }

    /// Creates the directory at `relative_path`, including missing parents,
    /// and returns its absolute path.
    ///
    /// # Panics
    ///
    /// Panics when the directory cannot be created.
    pub fn create_subdirectory(&self, relative_path: &str) -> PathBuf {
        let path = self.0.join(relative_path);

        fs::create_dir_all(&path).expect("create the test subdirectory");

        path
    }

    /// Creates a FIFO that has no writer at `relative_path` and returns its
    /// absolute path.
    ///
    /// # Panics
    ///
    /// Panics when the FIFO cannot be created.
    pub fn create_fifo(&self, relative_path: &str) -> PathBuf {
        let path = self.0.join(relative_path);
        let c_path = CString::new(path.as_os_str().as_bytes()).expect("a path without NUL bytes");

        // SAFETY: `c_path` is a valid NUL-terminated string that outlives the call.
        let status = unsafe { nix::libc::mkfifo(c_path.as_ptr(), 0o600) };
        assert_eq!(
            status,
            0,
            "create the test FIFO: {}",
            std::io::Error::last_os_error()
        );

        path
    }
}

impl Drop for TestDirectory {
    /// Deletes the directory and its contents.
    fn drop(&mut self) {
        if let Err(error) = fs::remove_dir_all(&self.0) {
            assert!(
                std::thread::panicking(),
                "remove the test directory {}: {error}",
                self.0.display()
            );
        }
    }
}
