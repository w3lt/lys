//! Ownership and Tauri commands for the local Lys backend process.
//!
//! The desktop application stores at most one child process behind a mutex.
//! Development builds launch the backend through the repository's `pnpm run
//! dev` script; release builds start the installed Node.js runtime from the
//! Lys home. Either child runs in its own Unix process group so shutdown can
//! terminate it and its descendants together while the direct child is still
//! running, and receives the host's resolved Lys home as `LYS_HOME`.
//!
//! A development child writes to the terminal that runs the app. A release
//! child's standard output and standard error are appended to `backend.log` in
//! the Lys home's `logs` directory when that log can be opened, and otherwise
//! go to the host's own streams. When the log has reached
//! [`BACKEND_LOG_ROTATION_THRESHOLD_BYTES`] as a release backend starts, the
//! host first moves it to `backend.1.log`.

use std::{
    fs::{self, File, OpenOptions},
    io,
    os::unix::{fs::OpenOptionsExt, process::CommandExt},
    path::{Path, PathBuf},
    process::{Child, Command},
    sync::Mutex,
};

use nix::{
    errno::Errno,
    sys::signal::{killpg, Signal},
    unistd::Pid,
};
use tauri::State;

use crate::utils::lys_home::LysHome;

/// Size, 10 MiB, from which the backend log is rotated when the release
/// backend starts. The log can grow past it while one backend runs.
const BACKEND_LOG_ROTATION_THRESHOLD_BYTES: u64 = 10 * 1024 * 1024;

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
/// Serializable status of the child process currently owned by the desktop.
///
/// The representation uses camelCase field names for Tauri responses. A
/// stopped process is represented with `pid: null` and `running: false`.
pub struct BackendProcessStatus {
    /// Operating-system process identifier while the child is running.
    pub pid: Option<u32>,
    /// Whether the owned child has not yet exited.
    pub running: bool,
}

/// Constructs the stopped status used when no child is owned or the child has exited.
fn stopped_backend_status() -> BackendProcessStatus {
    BackendProcessStatus {
        pid: None,
        running: false,
    }
}

/// Constructs a running status for the supplied operating-system process identifier.
fn running_backend_status(pid: u32) -> BackendProcessStatus {
    BackendProcessStatus {
        pid: Some(pid),
        running: true,
    }
}

#[derive(Default)]
/// Owns the optional backend child for the Tauri application lifetime.
///
/// The mutex serializes each individual
/// process-state access; callers never receive the `Child` itself. An exited
/// direct child remains stored until `stop` removes it or a later spawn
/// replaces it. `start_backend` performs its status check and spawn in separate
/// lock acquisitions, so concurrent starts can race; `stop` holds the mutex
/// through group termination and its synchronous child wait.
pub struct Backend {
    /// Owned child, including an exited child not yet removed, or `None` before
    /// spawn and after lifecycle cleanup.
    process: Mutex<Option<Child>>,
}

impl Backend {
    /// Inspects the owned child and returns its current process status.
    ///
    /// The mutex is held while `try_wait` observes the child. This is an
    /// observational operation: an exited child is reported as stopped but
    /// remains stored for `stop` or a later spawn to remove or replace.
    ///
    /// # Errors
    ///
    /// Returns an error if the process mutex is poisoned or the operating
    /// system cannot inspect the child.
    pub fn status(&self) -> Result<BackendProcessStatus, String> {
        let mut process = self
            .process
            .lock()
            .map_err(|err| format!("Failed to lock backend state: {err}"))?;

        inspect_process(process.as_mut())
    }

    /// Terminates the owned backend process group when its direct child is running.
    ///
    /// If no child is owned, or the direct child already exited, the operation
    /// returns the stopped status after removing the stored child; the exited
    /// path does not call `killpg`, so surviving descendants are not explicitly
    /// terminated. A running child is killed by Unix process group, waited on
    /// synchronously while the mutex remains held, and then removed from the
    /// owner.
    ///
    /// # Errors
    ///
    /// Returns an error if the process mutex is poisoned, process inspection
    /// fails, the process group cannot be terminated, or waiting for the child
    /// fails.
    pub fn stop(&self) -> Result<BackendProcessStatus, String> {
        let mut process = self
            .process
            .lock()
            .map_err(|err| format!("Failed to lock backend state: {err}"))?;

        let Some(child) = process.as_mut() else {
            return Ok(stopped_backend_status());
        };

        match child.try_wait() {
            Ok(Some(_exit_status)) => {
                // The direct child already exited
                *process = None;
                Ok(stopped_backend_status())
            }

            Ok(None) => {
                let pid = child.id();

                terminate_backend_process_group(pid)?;

                child
                    .wait()
                    .map_err(|err| format!("Failed to wait for backend process {pid}: {err}"))?;

                *process = None;

                Ok(stopped_backend_status())
            }

            Err(err) => Err(format!("Failed to inspect backend process: {err}")),
        }
    }
}

/// Sends `SIGKILL` to the Unix process group whose identifier matches `pid`.
///
/// The backend command creates its child as a process-group leader, allowing
/// this operation to terminate that child, such as the development `pnpm`
/// script, and its descendants as one unit when the direct child is still
/// running.
/// An already-missing group is treated as successfully terminated.
///
/// # Errors
///
/// Returns an error when the PID cannot be represented by `nix::unistd::Pid` or
/// when Unix rejects the group termination for a reason other than `ESRCH`.
fn terminate_backend_process_group(pid: u32) -> Result<(), String> {
    let process_group = i32::try_from(pid)
        .map(Pid::from_raw)
        .map_err(|_| format!("Backend PID {pid} is outside the supported range"))?;

    match killpg(process_group, Signal::SIGKILL) {
        Ok(()) | Err(Errno::ESRCH) => Ok(()),
        Err(err) => Err(format!(
            "Failed to terminate backend process group {pid}: {err}"
        )),
    }
}

/// Converts an optional owned child into a current running or stopped status.
///
/// `try_wait` is non-blocking. It reports an exited child as stopped while
/// leaving removal from the owner to the caller that performs lifecycle cleanup.
///
/// # Errors
///
/// Returns an error when the operating system cannot inspect the child.
fn inspect_process(process: Option<&mut Child>) -> Result<BackendProcessStatus, String> {
    let Some(child) = process else {
        return Ok(stopped_backend_status());
    };

    match child.try_wait() {
        Ok(None) => Ok(running_backend_status(child.id())),

        Ok(Some(_exited_status)) => Ok(stopped_backend_status()),

        Err(err) => Err(format!("Failed to inspect backend process: {err}")),
    }
}

/// Resolves the repository's backend directory from the Tauri crate location.
///
/// The path is the sibling `apps/backend` directory above
/// `apps/desktop/src-tauri`; it is used as the working directory for the
/// development script.
///
/// # Errors
///
/// Returns an error if the manifest path does not have the expected parent
/// structure.
fn get_backend_dir() -> Result<PathBuf, String> {
    Ok(Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(Path::parent)
        .ok_or_else(|| String::from("Failed to resolve apps directory"))?
        .join("backend"))
}

/// Starts the backend development script in its own Unix process group.
///
/// The direct child is the `pnpm run dev` process launched from `backend_dir`,
/// with `LYS_HOME` set to `lys_home` so the backend uses the host's Lys home.
/// The caller stores that child in [`Backend`] and, while it is still running,
/// later waits for it after killing the process group.
///
/// # Errors
///
/// Returns an error when the script cannot be spawned.
fn run_backend_dev_script(backend_dir: &Path, lys_home: &LysHome) -> Result<Child, String> {
    Command::new("pnpm")
        .args(["run", "dev"])
        .current_dir(backend_dir)
        .env("LYS_HOME", lys_home.as_path())
        .process_group(0)
        .spawn()
        .map_err(|err| format!("Failed to spawn backend process: {err}"))
}

/// Starts the development backend script and stores it as the owned child.
///
/// The script runs from the repository's backend directory with `LYS_HOME`
/// set to `lys_home`. Locking occurs before spawning so a successfully created
/// child can always be stored; the returned status comes from a non-blocking
/// inspection of the stored child.
///
/// # Errors
///
/// Returns an error when the backend directory cannot be resolved, process
/// state cannot be locked, the script cannot be spawned, or the child cannot
/// be inspected.
fn spawn_dev_backend_process(
    backend: &Backend,
    lys_home: &LysHome,
) -> Result<BackendProcessStatus, String> {
    let backend_dir = get_backend_dir()?;

    // Lock before spawning so we never create a process that we cannot store.
    let mut process = backend
        .process
        .lock()
        .map_err(|err| format!("Failed to lock backend state: {err}"))?;

    let backend_process = run_backend_dev_script(&backend_dir, lys_home)?;

    *process = Some(backend_process);

    // We return the status, that's why we need this
    inspect_process(process.as_mut())
}

/// Opens the backend log in `logs_dir` for appending, creating the directory
/// and the log when they are missing.
///
/// A log that has reached [`BACKEND_LOG_ROTATION_THRESHOLD_BYTES`] is first
/// renamed to the previous log, replacing it, so the returned file starts
/// empty. A new log is created readable and writable by its owner only; an
/// existing log keeps its permissions, and the directory is created with the
/// default ones.
///
/// # Errors
///
/// Returns the I/O error of creating the directory, reading the log's size,
/// renaming it, or opening it. A missing log is not an error.
fn open_backend_log(logs_dir: &Path) -> io::Result<File> {
    /// Name of the file in the logs directory that receives the release
    /// backend's standard output and standard error.
    const BACKEND_LOG_FILE_NAME: &str = "backend.log";
    /// Name of the file in the logs directory that keeps the previous backend
    /// log after a rotation; the next rotation replaces it.
    const PREVIOUS_BACKEND_LOG_FILE_NAME: &str = "backend.1.log";

    fs::create_dir_all(logs_dir)?;
    let log_path = logs_dir.join(BACKEND_LOG_FILE_NAME);

    let is_log_full = match fs::metadata(&log_path) {
        Ok(metadata) => metadata.len() >= BACKEND_LOG_ROTATION_THRESHOLD_BYTES,
        Err(err) if err.kind() == io::ErrorKind::NotFound => false,
        Err(err) => return Err(err),
    };
    if is_log_full {
        fs::rename(&log_path, logs_dir.join(PREVIOUS_BACKEND_LOG_FILE_NAME))?;
    }

    OpenOptions::new()
        .create(true)
        .append(true)
        .mode(0o600)
        .open(log_path)
}

/// Starts `command` with its standard output and standard error appended to
/// the backend log in `logs_dir`.
///
/// The log is opened by [`open_backend_log`], and both streams share its
/// handle, so their lines stay in the order the child wrote them. When the log
/// cannot be opened, the child still starts, with the host's own streams, and
/// the failure is written to the host's standard error: a log that cannot be
/// written must not keep the backend from running.
///
/// # Errors
///
/// Returns an error when the child cannot be spawned.
fn start_backend_with_log(mut command: Command, logs_dir: &Path) -> Result<Child, String> {
    let log_handles = open_backend_log(logs_dir).and_then(|stdout_log| {
        let stderr_log = stdout_log.try_clone()?;
        Ok((stdout_log, stderr_log))
    });

    match log_handles {
        Ok((stdout_log, stderr_log)) => {
            command.stdout(stdout_log).stderr(stderr_log);
        }
        Err(err) => eprintln!("{}", format_backend_log_open_problem(logs_dir, &err)),
    }

    command
        .spawn()
        .map_err(|err| format!("Failed to start backend: {err}"))
}

/// Formats the host's report that the backend log in `logs_dir` could not be
/// opened, so the backend's output is not saved; `err` is the failure
/// [`open_backend_log`] returned.
fn format_backend_log_open_problem(logs_dir: &Path, err: &io::Error) -> String {
    format!(
        "Failed to open the backend log in {}, so the backend's output is not saved: {err}",
        logs_dir.display()
    )
}

/// Builds the command that runs the installed release backend: the Node.js
/// executable from the Lys home's runtime directory with the installed backend
/// bundle, in its own Unix process group and with `LYS_HOME` set to
/// `lys_home`.
///
/// Nothing is checked or started here. A missing executable is reported when
/// the command is spawned, and a missing bundle by Node.js once it runs.
fn build_prod_backend_command(lys_home: &LysHome) -> Command {
    let mut command = Command::new(lys_home.node_executable_path());
    command
        .arg(lys_home.backend_script_path())
        .env("LYS_HOME", lys_home.as_path())
        .process_group(0);
    command
}

/// Starts the installed release backend and stores it as the owned child.
///
/// Runs the command [`build_prod_backend_command`] builds. Its standard output
/// and standard error go to the backend log in the Lys home's logs directory,
/// as [`start_backend_with_log`] describes. Locking occurs before the log is
/// opened and the child spawned, so a successfully created child can always be
/// stored; the returned status comes from a non-blocking inspection of the
/// stored child. A missing backend bundle is not detected here: Node.js
/// starts, reports the missing file on its standard error, which is the backend
/// log when the log could be opened, and exits.
///
/// # Errors
///
/// Returns an error when process state cannot be locked, the Node.js
/// executable cannot be spawned, for example because it is not installed under
/// the Lys home, or the child cannot be inspected.
fn spawn_prod_backend_process(
    backend: &Backend,
    lys_home: &LysHome,
) -> Result<BackendProcessStatus, String> {
    let command = build_prod_backend_command(lys_home);

    // Lock before spawning so we never create a process that we cannot store.
    let mut process = backend
        .process
        .lock()
        .map_err(|err| format!("Failed to lock backend state: {err}"))?;

    let backend_process = start_backend_with_log(command, &lys_home.logs_dir())?;

    *process = Some(backend_process);

    inspect_process(process.as_mut())
}

/// Spawns the backend child for the current build mode and records it under the
/// backend mutex before inspecting it.
///
/// Development builds run the repository's `pnpm run dev` script; release
/// builds run the installed runtime from the Lys home. Either child receives
/// `lys_home` as `LYS_HOME`. Locking occurs before spawning so a successfully
/// created child can always be stored by this owner. The returned status is
/// obtained with a non-blocking inspection of the stored child.
///
/// # Errors
///
/// Returns an error when the development backend directory cannot be resolved,
/// process state cannot be locked, the child cannot be spawned, or the child
/// cannot be inspected.
fn spawn_backend_process(
    backend: &Backend,
    lys_home: &LysHome,
) -> Result<BackendProcessStatus, String> {
    if tauri::is_dev() {
        spawn_dev_backend_process(backend, lys_home)
    } else {
        spawn_prod_backend_process(backend, lys_home)
    }
}

#[tauri::command]
/// Starts the local backend if it is not already running.
///
/// The command first reads the current status and releases that lock before a
/// non-running result is passed to the spawn path. A running child is left
/// untouched and its status is returned; otherwise a new backend child for the
/// current build mode is started with the Lys home resolved at startup, stored,
/// and reported to the renderer. Because the check and spawn use separate lock
/// acquisitions, concurrent starts can both observe stopped and spawn.
///
/// # Errors
///
/// Returns an error when status inspection, process-state locking, development
/// backend directory resolution, spawning, or post-spawn inspection fails.
pub fn start_backend(
    backend: State<'_, Backend>,
    lys_home: State<'_, LysHome>,
) -> Result<BackendProcessStatus, String> {
    // Step 1. Get backend process status
    let backend_status = backend.status()?;

    // Step 2. If backend process is running, we return without doing anything
    if backend_status.running {
        return Ok(backend_status);
    }

    // Step 3. If the backend process is not runnning, we spawn a new one
    spawn_backend_process(&backend, &lys_home)
}

#[tauri::command]
/// Stops the local backend process group when the direct child is running and
/// returns the stopped status.
///
/// The command delegates to the mutex-protected owner. A running direct child
/// causes Unix group termination and a synchronous wait before the mutex is
/// released; an already-exited child is removed without another group kill.
///
/// # Errors
///
/// Returns an error when process-state locking, inspection, group termination,
/// or child waiting fails.
pub fn stop_backend(backend: State<'_, Backend>) -> Result<BackendProcessStatus, String> {
    backend.stop()
}

#[tauri::command]
/// Reads the current local backend process status.
///
/// This command performs a non-blocking child inspection and does not start or
/// stop the process.
///
/// # Errors
///
/// Returns an error when the process mutex is poisoned or child inspection
/// fails.
pub fn get_backend_status(backend: State<'_, Backend>) -> Result<BackendProcessStatus, String> {
    backend.status()
}

#[cfg(test)]
mod tests {
    use std::{
        fs::{self, Permissions},
        io::{self, Write},
        os::unix::fs::PermissionsExt,
        path::{Path, PathBuf},
        process::Command,
    };

    use super::{
        format_backend_log_open_problem, open_backend_log, start_backend_with_log,
        BACKEND_LOG_ROTATION_THRESHOLD_BYTES,
    };
    use crate::tools::test_directory::TestDirectory;

    /// Creates `logs/backend.log` in `case` with a length of `size_bytes`
    /// without writing its bytes, and returns its path.
    fn create_backend_log_of_size(case: &TestDirectory, size_bytes: u64) -> PathBuf {
        let log_path = case.create_file("logs/backend.log", "");
        fs::OpenOptions::new()
            .write(true)
            .open(&log_path)
            .expect("open the test log")
            .set_len(size_bytes)
            .expect("size the test log");
        log_path
    }

    /// Reads the length of the file at `path`.
    fn read_file_size(path: &Path) -> u64 {
        fs::metadata(path).expect("read metadata").len()
    }

    #[test]
    fn opening_the_log_creates_the_logs_directory_and_an_owner_only_log() {
        let case = TestDirectory::create("backend-log-create");
        let logs_dir = case.path().join("lys-home").join("logs");

        open_backend_log(&logs_dir).expect("open the backend log");

        let mode = fs::metadata(logs_dir.join("backend.log"))
            .expect("read metadata")
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600);
    }

    #[test]
    fn opening_the_log_appends_to_the_log_of_an_earlier_run() {
        let case = TestDirectory::create("backend-log-append");
        let log_path = case.create_file("logs/backend.log", "earlier run\n");

        let mut log = open_backend_log(&case.path().join("logs")).expect("open the backend log");
        log.write_all(b"this run\n")
            .expect("write to the backend log");

        assert_eq!(
            fs::read_to_string(log_path).expect("read the backend log"),
            "earlier run\nthis run\n"
        );
    }

    #[test]
    fn opening_the_log_keeps_a_log_smaller_than_the_rotation_threshold() {
        let case = TestDirectory::create("backend-log-below-rotation");
        let log_path = create_backend_log_of_size(&case, BACKEND_LOG_ROTATION_THRESHOLD_BYTES - 1);

        open_backend_log(&case.path().join("logs")).expect("open the backend log");

        assert_eq!(
            read_file_size(&log_path),
            BACKEND_LOG_ROTATION_THRESHOLD_BYTES - 1
        );
        assert!(!case.path().join("logs/backend.1.log").exists());
    }

    #[test]
    fn opening_the_log_moves_a_log_of_the_rotation_threshold_over_the_previous_log() {
        let case = TestDirectory::create("backend-log-rotation");
        let previous_log_path = case.create_file("logs/backend.1.log", "oldest run\n");
        let log_path = create_backend_log_of_size(&case, BACKEND_LOG_ROTATION_THRESHOLD_BYTES);

        let log = open_backend_log(&case.path().join("logs")).expect("open the backend log");

        assert_eq!(
            read_file_size(&previous_log_path),
            BACKEND_LOG_ROTATION_THRESHOLD_BYTES
        );
        assert_eq!(read_file_size(&log_path), 0);
        assert_eq!(log.metadata().expect("read metadata").len(), 0);
    }

    #[test]
    fn opening_the_log_keeps_the_permissions_of_an_existing_log() {
        let case = TestDirectory::create("backend-log-existing-mode");
        let log_path = case.create_file("logs/backend.log", "earlier run\n");
        fs::set_permissions(&log_path, Permissions::from_mode(0o644)).expect("set the log mode");

        open_backend_log(&case.path().join("logs")).expect("open the backend log");

        let mode = fs::metadata(&log_path)
            .expect("read metadata")
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o644);
    }

    #[test]
    fn opening_the_log_fails_and_keeps_the_log_when_it_cannot_be_moved() {
        let case = TestDirectory::create("backend-log-rotation-failure");
        case.create_subdirectory("logs/backend.1.log");
        let log_path = create_backend_log_of_size(&case, BACKEND_LOG_ROTATION_THRESHOLD_BYTES);

        let opened = open_backend_log(&case.path().join("logs"));

        assert!(opened.is_err());
        assert_eq!(
            read_file_size(&log_path),
            BACKEND_LOG_ROTATION_THRESHOLD_BYTES
        );
    }

    #[test]
    fn opening_the_log_fails_when_the_size_of_the_log_cannot_be_read() {
        let case = TestDirectory::create("backend-log-metadata-failure");
        let log_path = case.create_file("logs/backend.log", "earlier run\n");
        let logs_dir = case.path().join("logs");
        fs::set_permissions(&logs_dir, Permissions::from_mode(0o000))
            .expect("lock the logs directory");
        let is_reading_denied = fs::metadata(&log_path).is_err();

        let opened = open_backend_log(&logs_dir);
        fs::set_permissions(&logs_dir, Permissions::from_mode(0o700))
            .expect("unlock the logs directory");

        assert!(
            is_reading_denied,
            "this test needs a user whose access to a mode-000 directory is denied"
        );
        assert!(opened.is_err());
        assert_eq!(
            fs::read_to_string(log_path).expect("read the backend log"),
            "earlier run\n"
        );
    }

    #[test]
    fn opening_the_log_fails_when_the_logs_path_is_a_file() {
        let case = TestDirectory::create("backend-log-file-path");
        let logs_path = case.create_file("logs", "not a directory");

        assert!(open_backend_log(&logs_path).is_err());
    }

    #[test]
    fn a_started_backend_appends_its_output_and_errors_to_the_log() {
        let case = TestDirectory::create("backend-log-child");
        let log_path = case.create_file("logs/backend.log", "earlier run\n");
        let mut command = Command::new("sh");
        command.arg("-c").arg("echo out; echo err >&2");

        let exit_status = start_backend_with_log(command, &case.path().join("logs"))
            .expect("start the child")
            .wait()
            .expect("wait for the child");

        assert!(exit_status.success());
        assert_eq!(
            fs::read_to_string(log_path).expect("read the backend log"),
            "earlier run\nout\nerr\n"
        );
    }

    #[test]
    fn the_backend_still_starts_when_its_log_cannot_be_opened() {
        let case = TestDirectory::create("backend-log-unavailable");
        let logs_path = case.create_file("logs", "not a directory");
        let mut command = Command::new("sh");
        command.arg("-c").arg("exit 3");

        let exit_status = start_backend_with_log(command, &logs_path)
            .expect("start the child")
            .wait()
            .expect("wait for the child");

        assert_eq!(exit_status.code(), Some(3));
    }

    #[test]
    fn starting_fails_when_the_backend_executable_is_missing() {
        let case = TestDirectory::create("backend-missing-executable");
        let command = Command::new(case.path().join("runtime/node/bin/node"));

        let started = start_backend_with_log(command, &case.path().join("logs"));

        let message = started.expect_err("the child must not start");
        assert!(
            message.starts_with("Failed to start backend: "),
            "unexpected message: {message}"
        );
    }

    #[test]
    fn the_log_open_problem_names_the_logs_directory_and_the_failure() {
        let failure = io::Error::new(io::ErrorKind::PermissionDenied, "Permission denied");

        let problem = format_backend_log_open_problem(Path::new("/Users/lys/.lys/logs"), &failure);

        assert_eq!(
            problem,
            "Failed to open the backend log in /Users/lys/.lys/logs, so the backend's output is not saved: Permission denied"
        );
    }
}
