//! Ownership and Tauri commands for the local Lys backend process.
//!
//! The desktop application stores at most one child process behind a mutex.
//! Development builds launch the backend through the repository's `pnpm run
//! dev` script; release builds start the installed Node.js runtime from the
//! Lys home. Either child runs in its own Unix process group so shutdown can
//! terminate it and its descendants together while the direct child is still
//! running, and receives the host's resolved Lys home as `LYS_HOME`.
//!
//! A stop sends `SIGTERM` to that group first and gives the backend up to
//! [`BACKEND_STOP_TIMEOUT`] to exit: on `SIGTERM` the backend ends the process
//! groups of its stdio MCP servers, which run in groups of their own that a
//! signal to the backend's group does not reach, and exits. `SIGKILL` to the
//! backend's group follows in every case, for a backend that did not exit and
//! for descendants left in the group.

use std::{
    os::unix::process::CommandExt,
    path::{Path, PathBuf},
    process::{Child, Command},
    sync::Mutex,
    thread,
    time::{Duration, Instant},
};

use nix::{
    errno::Errno,
    sys::signal::{killpg, Signal},
    unistd::Pid,
};
use tauri::State;

use crate::utils::lys_home::LysHome;

/// Longest a stop waits for the backend to exit after `SIGTERM` before it
/// sends `SIGKILL` to the backend's process group.
///
/// The backend needs no more: on `SIGTERM` it sends `SIGKILL` to its MCP
/// servers' process groups without waiting and exits.
pub const BACKEND_STOP_TIMEOUT: Duration = Duration::from_secs(2);

/// How often a stop checks whether the backend has exited.
const BACKEND_EXIT_CHECK_INTERVAL: Duration = Duration::from_millis(25);

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

/// Owns the optional backend child for the Tauri application lifetime.
///
/// The mutex serializes each individual
/// process-state access; callers never receive the `Child` itself. An exited
/// direct child remains stored until `stop` removes it or a later spawn
/// replaces it. `start_backend` performs its status check and spawn in separate
/// lock acquisitions, so concurrent starts can race; `stop` holds the mutex
/// through its wait for the backend to exit after `SIGTERM`, at most its stop
/// timeout, then through group termination and its synchronous child wait.
pub struct Backend {
    /// Owned child, including an exited child not yet removed, or `None` before
    /// spawn and after lifecycle cleanup.
    process: Mutex<Option<Child>>,
    /// Longest a stop waits for the direct child to exit after `SIGTERM`.
    stop_timeout: Duration,
}

impl Default for Backend {
    /// Creates an owner without a child whose stops wait up to
    /// [`BACKEND_STOP_TIMEOUT`] after `SIGTERM`.
    fn default() -> Self {
        Self {
            process: Mutex::new(None),
            stop_timeout: BACKEND_STOP_TIMEOUT,
        }
    }
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
    /// terminated. A running child's process group receives `SIGTERM`, the
    /// child gets up to the owner's stop timeout to exit, and the group then
    /// receives `SIGKILL` whether or not it exited, which also ends any
    /// descendant left in the group. The child is waited on synchronously
    /// while the mutex remains held, and then removed from the owner.
    ///
    /// # Errors
    ///
    /// Returns an error if the process mutex is poisoned, process inspection
    /// fails, the process group cannot be signalled, or waiting for the child
    /// fails. A child that was waited on is removed even when sending
    /// `SIGTERM` or inspecting it before `SIGKILL` failed.
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
                let stopped = stop_running_backend(child, self.stop_timeout);

                if matches!(child.try_wait(), Ok(Some(_exit_status))) {
                    *process = None;
                }

                stopped.map(|()| stopped_backend_status())
            }

            Err(err) => Err(format!("Failed to inspect backend process: {err}")),
        }
    }
}

/// Stops a running backend child: `SIGTERM` to its process group, up to
/// `stop_timeout` for the child to exit, then `SIGKILL` to the group and a
/// wait for the child.
///
/// `SIGKILL` is sent even after the child exited, because descendants it
/// started can still be in the group. It follows the check that found the
/// child exited without a pause, and the group's identifier cannot name
/// another group while any process of the backend's group is left.
///
/// # Errors
///
/// Returns an error when `SIGKILL` cannot be sent or the child cannot be
/// waited on, which leaves it unreaped, or, after the child was waited on,
/// when sending `SIGTERM` or inspecting the child failed.
fn stop_running_backend(child: &mut Child, stop_timeout: Duration) -> Result<(), String> {
    let pid = child.id();
    let graceful_stop = send_backend_signal(pid, Signal::SIGTERM)
        .and_then(|()| wait_for_backend_exit(child, stop_timeout));
    send_backend_signal(pid, Signal::SIGKILL)?;
    child
        .wait()
        .map_err(|err| format!("Failed to wait for backend process {pid}: {err}"))?;
    graceful_stop.map(|_has_exited| ())
}

/// Waits until the child exits or `timeout` passes, checking every
/// [`BACKEND_EXIT_CHECK_INTERVAL`].
///
/// Returns whether the child exited; an exited child is reaped by the check.
///
/// # Errors
///
/// Returns an error when the child cannot be inspected.
fn wait_for_backend_exit(child: &mut Child, timeout: Duration) -> Result<bool, String> {
    let deadline = Instant::now() + timeout;
    loop {
        let has_exited = child
            .try_wait()
            .map_err(|err| format!("Failed to inspect backend process: {err}"))?
            .is_some();
        if has_exited {
            return Ok(true);
        }
        let now = Instant::now();
        if now >= deadline {
            return Ok(false);
        }
        thread::sleep(BACKEND_EXIT_CHECK_INTERVAL.min(deadline - now));
    }
}

/// Sends `signal` to the Unix process group whose identifier matches `pid`.
///
/// The backend command creates its child as a process-group leader, allowing
/// this operation to signal that child, such as the development `pnpm`
/// script, and its descendants as one unit.
/// A group that is already gone counts as signalled, and so does one whose
/// processes all exited but were not yet reaped, for which macOS reports
/// `EPERM`: a stop can find that state once the child it reaped was the last
/// running process of the group.
///
/// # Errors
///
/// Returns an error when the PID cannot be represented by `nix::unistd::Pid` or
/// when Unix rejects the signal for a reason other than `ESRCH` or `EPERM`.
fn send_backend_signal(pid: u32, signal: Signal) -> Result<(), String> {
    let process_group = i32::try_from(pid)
        .map(Pid::from_raw)
        .map_err(|_| format!("Backend PID {pid} is outside the supported range"))?;

    match killpg(process_group, signal) {
        Ok(()) | Err(Errno::ESRCH | Errno::EPERM) => Ok(()),
        Err(err) => Err(format!(
            "Failed to send {signal} to backend process group {pid}: {err}"
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

/// Starts the installed release backend and stores it as the owned child.
///
/// Runs the Node.js executable from the Lys home's runtime directory with the
/// installed backend bundle, in its own Unix process group and with `LYS_HOME`
/// set to `lys_home`. Locking occurs before spawning so a successfully created
/// child can always be stored; the returned status comes from a non-blocking
/// inspection of the stored child. A missing backend bundle is not detected
/// here: Node.js starts, reports the missing file, and exits.
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
    let node_executable_path = lys_home.node_executable_path();
    let backend_script_path = lys_home.backend_script_path();

    // Lock before spawning so we never create a process that we cannot store.
    let mut process = backend
        .process
        .lock()
        .map_err(|err| format!("Failed to lock backend state: {err}"))?;

    let backend_process = Command::new(node_executable_path)
        .arg(backend_script_path)
        .env("LYS_HOME", lys_home.as_path())
        .process_group(0)
        .spawn()
        .map_err(|err| format!("Failed to start backend: {err}"))?;

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
/// gets `SIGTERM` and up to [`BACKEND_STOP_TIMEOUT`] to exit, then its group
/// gets `SIGKILL` and a synchronous wait before the mutex is released; an
/// already-exited child is removed without another group kill.
///
/// # Errors
///
/// Returns an error when process-state locking, inspection, signalling the
/// process group, or child waiting fails.
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
        fs,
        path::Path,
        process::{Command, Stdio},
        sync::Mutex,
        thread,
        time::{Duration, Instant},
    };

    use nix::{sys::signal::kill, unistd::Pid};

    use super::{Backend, CommandExt};
    use crate::tools::test_directory::TestDirectory;

    /// Stop timeout of the cases whose backend ignores `SIGTERM`.
    const SHORT_STOP_TIMEOUT: Duration = Duration::from_millis(300);

    /// Stop timeout of the cases whose backend exits on `SIGTERM`; never
    /// reached, so a stop that takes this long shows that `SIGTERM` was not
    /// sent first.
    const LONG_STOP_TIMEOUT: Duration = Duration::from_secs(30);

    /// Longest a stop of a backend that exits on `SIGTERM` may take.
    const PROMPT_STOP_LIMIT: Duration = Duration::from_secs(5);

    /// Longest any case waits for a condition before it fails.
    const CONDITION_LIMIT: Duration = Duration::from_secs(10);

    /// Script of a loop that keeps a shell running.
    const KEEP_RUNNING: &str = "while :; do sleep 0.02; done";

    /// Stops the case's backend when dropped, so that a failed assertion
    /// leaves no shell running after the test.
    struct BackendStopGuard<'backend>(&'backend Backend);

    impl Drop for BackendStopGuard<'_> {
        /// Stops the case's backend and waits until it has exited.
        fn drop(&mut self) {
            if let Err(error) = self.0.stop() {
                assert!(thread::panicking(), "stop the case's backend: {error}");
            }
        }
    }

    /// Starts `script` with `sh` as the leader of a process group of its own,
    /// as the backend runs, and returns an owner of it with `stop_timeout`.
    fn start_backend(script: &str, stop_timeout: Duration) -> Backend {
        let child = Command::new("sh")
            .arg("-c")
            .arg(script)
            .stderr(Stdio::null())
            .process_group(0)
            .spawn()
            .expect("start the case's backend");
        Backend {
            process: Mutex::new(Some(child)),
            stop_timeout,
        }
    }

    /// Waits until `condition` holds, failing the case after
    /// [`CONDITION_LIMIT`].
    fn wait_for_condition(description: &str, condition: impl Fn() -> bool) {
        let deadline = Instant::now() + CONDITION_LIMIT;
        while !condition() {
            assert!(
                Instant::now() < deadline,
                "timed out waiting until {description}"
            );
            thread::sleep(Duration::from_millis(10));
        }
    }

    /// Reads the process identifier that a case's script wrote to `path`.
    fn read_pid_file(path: &Path) -> i32 {
        fs::read_to_string(path)
            .expect("read the pid file")
            .trim()
            .parse()
            .expect("a process identifier in the pid file")
    }

    /// Answers whether a process with identifier `pid` still exists.
    fn is_process_alive(pid: i32) -> bool {
        kill(Pid::from_raw(pid), None).is_ok()
    }

    /// Starts a backend that runs `trap_action` on `SIGTERM`, with a
    /// descendant in its process group that ignores `SIGTERM`, and waits
    /// until both have set their traps: a signal sent before would end them
    /// at once. Returns the owner and the descendant's pid.
    fn start_trapping_backend(
        case: &TestDirectory,
        trap_action: &str,
        stop_timeout: Duration,
    ) -> (Backend, i32) {
        let backend_ready = case.path().join("backend-ready");
        let descendant_ready = case.path().join("descendant-ready");
        let descendant = case.path().join("descendant.pid");
        let script = format!(
            "sh -c 'trap \"\" TERM; : > \"{}\"; {KEEP_RUNNING}' & echo $! > \"{}\"; trap '{trap_action}' TERM; : > \"{}\"; {KEEP_RUNNING}",
            descendant_ready.display(),
            descendant.display(),
            backend_ready.display()
        );
        let backend = start_backend(&script, stop_timeout);
        wait_for_condition(
            "the backend and its descendant have set their traps",
            || backend_ready.exists() && descendant_ready.exists(),
        );
        (backend, read_pid_file(&descendant))
    }

    #[test]
    fn stop_without_a_child_reports_stopped() {
        let status = Backend::default().stop().unwrap();

        assert_eq!((status.pid, status.running), (None, false));
    }

    #[test]
    fn stop_sends_sigterm_first_and_kills_a_descendant_left_in_the_group() {
        let case = TestDirectory::create("backend-sigterm");
        let (backend, descendant) = start_trapping_backend(&case, "exit 0", LONG_STOP_TIMEOUT);
        let _stop = BackendStopGuard(&backend);
        let started = Instant::now();

        let status = backend.stop().unwrap();

        assert!(
            started.elapsed() < PROMPT_STOP_LIMIT,
            "the backend exits on SIGTERM well before the stop timeout"
        );
        assert_eq!((status.pid, status.running), (None, false));
        assert!(!backend.status().unwrap().running);
        wait_for_condition("the descendant ignoring SIGTERM has been killed", || {
            !is_process_alive(descendant)
        });
    }

    #[test]
    fn stop_kills_the_group_of_a_backend_still_running_after_the_timeout() {
        let case = TestDirectory::create("backend-kill");
        let (backend, descendant) = start_trapping_backend(&case, "", SHORT_STOP_TIMEOUT);
        let _stop = BackendStopGuard(&backend);
        let started = Instant::now();

        let status = backend.stop().unwrap();

        assert!(started.elapsed() >= SHORT_STOP_TIMEOUT);
        assert_eq!((status.pid, status.running), (None, false));
        wait_for_condition("the backend's descendant has been killed", || {
            !is_process_alive(descendant)
        });
    }

    #[test]
    fn a_backend_that_exited_on_its_own_stops_as_stopped() {
        let backend = start_backend("exit 0", LONG_STOP_TIMEOUT);
        wait_for_condition("the backend has exited", || {
            !backend.status().unwrap().running
        });

        let status = backend.stop().unwrap();

        assert_eq!((status.pid, status.running), (None, false));
        assert!(backend.process.lock().unwrap().is_none());
    }
}
