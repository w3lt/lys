//! Ownership and Tauri commands for the local Lys backend process.
//!
//! The desktop application stores at most one child process behind a mutex.
//! The backend is launched through the repository's `pnpm run dev` script in
//! its own Unix process group so shutdown can terminate the script and its
//! descendants together while the direct child is still running.

use std::{
    os::unix::process::CommandExt,
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
/// this operation to terminate the `pnpm` script and descendants as one unit
/// when the direct child is still running.
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
/// The direct child is the `pnpm run dev` process launched from `backend_dir`;
/// the caller stores that child in [`Backend`] and, while it is still running,
/// later waits for it after killing the process group.
///
/// # Errors
///
/// Returns an error when the script cannot be spawned.
fn run_backend_dev_script(backend_dir: &Path) -> Result<Child, String> {
    Command::new("pnpm")
        .args(["run", "dev"])
        .current_dir(backend_dir)
        .process_group(0)
        .spawn()
        .map_err(|err| format!("Failed to spawn backend process: {err}"))
}

/// Spawns a backend child and records it under the backend mutex before inspecting it.
///
/// Locking occurs before spawning so a successfully created child can always
/// be stored by this owner. The returned status is obtained with a
/// non-blocking inspection of the stored child.
///
/// # Errors
///
/// Returns an error when the backend directory cannot be resolved, process
/// state cannot be locked, the script cannot be spawned, or the child cannot
/// be inspected.
fn spawn_backend_process(backend: &Backend) -> Result<BackendProcessStatus, String> {
    let backend_dir = get_backend_dir()?;

    // Lock before spawning so we never create a process that we cannot store.
    let mut process = backend
        .process
        .lock()
        .map_err(|err| format!("Failed to lock backend state: {err}"))?;

    let backend_process = run_backend_dev_script(&backend_dir)?;

    *process = Some(backend_process);

    inspect_process(process.as_mut())
}

#[tauri::command]
/// Starts the local backend if it is not already running.
///
/// The command first reads the current status and releases that lock before a
/// non-running result is passed to the spawn path. A running child is left
/// untouched and its status is returned; otherwise a new development-script
/// child is stored and reported to the renderer. Because the check and spawn
/// use separate lock acquisitions, concurrent starts can both observe stopped
/// and spawn.
///
/// # Errors
///
/// Returns an error when status inspection, process-state locking, backend
/// directory resolution, spawning, or post-spawn inspection fails.
pub fn start_backend(backend: State<'_, Backend>) -> Result<BackendProcessStatus, String> {
    // Step 1. Get backend process status
    let backend_status = backend.status()?;

    // Step 2. If backend process is running, we return without doing anything
    if backend_status.running {
        return Ok(backend_status);
    }

    // Step 3. If the backend process is not runnning, we spawn a new one
    spawn_backend_process(&backend)
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
