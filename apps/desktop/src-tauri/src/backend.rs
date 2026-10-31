//! Ownership and Tauri commands for the local Lys backend process.
//!
//! The desktop application stores at most one child process behind a mutex.
//! Development builds launch the backend through the repository's `pnpm run
//! dev` script; release builds start the installed Node.js runtime from the
//! Lys home. Either child runs in its own Unix process group so shutdown can
//! terminate it and its descendants together while the direct child is still
//! running, and receives the host's resolved Lys home as `LYS_HOME`.
//!
//! A stop sends `SIGTERM` to that group first and gives it up to
//! [`BACKEND_STOP_TIMEOUT`] to end: on `SIGTERM` the backend ends the process
//! groups of its stdio MCP servers, which run in groups of their own that a
//! signal to the backend's group does not reach, and exits. `SIGKILL` to the
//! backend's group follows in every case, for a backend that did not exit and
//! for descendants left in the group.
//!
//! The backend also lists the process groups of its MCP servers in a file in
//! the Lys home. Once the backend's process is gone, the stop sends `SIGKILL`
//! to every group still listed, which reaches the servers of a backend that
//! hung or was killed before it could end them, and deletes the list. A start
//! deletes a list an earlier backend left before it starts the new one.

use std::{
    fs,
    io::ErrorKind,
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
    unistd::{getpgrp, Pid},
};
use tauri::{AppHandle, Manager, State};

use crate::utils::lys_home::LysHome;

/// Longest a stop waits for the backend's process group to end after
/// `SIGTERM` before it sends `SIGKILL` to that group.
///
/// The backend needs no more: on `SIGTERM` it sends `SIGKILL` to its MCP
/// servers' process groups without waiting and exits.
const BACKEND_STOP_TIMEOUT: Duration = Duration::from_secs(2);

/// How often a stop checks whether the backend's process group has ended.
const BACKEND_EXIT_CHECK_INTERVAL: Duration = Duration::from_millis(25);

/// Most problems with lines of the MCP server process group list that one
/// stop error names; it counts the others.
const LIST_LINE_PROBLEM_LIMIT: usize = 5;

#[derive(Debug, serde::Serialize)]
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
/// through its wait for the backend's process group to end after `SIGTERM`, at
/// most its stop timeout, then through group termination, its synchronous child
/// wait, and the `SIGKILL` to the MCP server process groups the backend still
/// listed. A spawn deletes that list under the same mutex before it starts the
/// child, so a stop never reads a list an earlier backend left.
pub struct Backend {
    /// Owned child, including an exited child not yet removed, or `None` before
    /// spawn and after lifecycle cleanup.
    process: Mutex<Option<Child>>,
    /// Longest a stop waits for the backend's process group to end after
    /// `SIGTERM`.
    stop_timeout: Duration,
    /// File in which the backend lists the process groups of its stdio MCP
    /// servers, one decimal group identifier per line.
    mcp_process_groups_path: PathBuf,
}

impl Backend {
    /// Creates an owner without a child whose stops wait up to
    /// [`BACKEND_STOP_TIMEOUT`] after `SIGTERM` and read the backend's list of
    /// MCP server process groups from `mcp_process_groups_path`, the file
    /// [`LysHome::mcp_process_groups_path`] names.
    pub fn new(mcp_process_groups_path: PathBuf) -> Self {
        Self {
            process: Mutex::new(None),
            stop_timeout: BACKEND_STOP_TIMEOUT,
            mcp_process_groups_path,
        }
    }

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
    /// path does not call `killpg` or read the MCP server process group list,
    /// so surviving descendants and servers are not explicitly terminated. A
    /// running child's process group receives `SIGTERM` and gets up to the
    /// owner's stop timeout until no process of it is left, and the group then
    /// receives `SIGKILL` whether or not it ended, which also ends any
    /// descendant left in the group. The child is waited on synchronously
    /// while the mutex remains held. Every MCP server process group the
    /// backend still listed then receives `SIGKILL`, the list is deleted, and
    /// the child is removed from the owner.
    ///
    /// # Errors
    ///
    /// Returns an error if the process mutex is poisoned, process inspection
    /// fails, the process group cannot be signalled, or waiting for the child
    /// fails, and, after the child was waited on, when the MCP server process
    /// group list cannot be read or deleted, holds a line that names no MCP
    /// server's group, or names a group that cannot be signalled. A child that
    /// was waited on is removed even when sending `SIGTERM`, checking its group
    /// before `SIGKILL`, or ending the listed MCP server groups failed.
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
                let stopped =
                    stop_running_backend(child, self.stop_timeout, &self.mcp_process_groups_path);

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
/// `stop_timeout` for that group to end, then `SIGKILL` to the group, a wait
/// for the child, and `SIGKILL` to the MCP server process groups the backend
/// still listed in `mcp_process_groups_path`.
///
/// `SIGKILL` is sent whether or not the wait saw the group end, so a wait that
/// gave up while processes were still in the group takes the same path; a
/// group that ended counts as signalled, as [`send_process_group_signal`]
/// describes. A group that ended frees its identifier for reuse, so `SIGKILL`
/// follows the check that saw the end at once. The list is read only once
/// `SIGKILL` was sent to the backend's whole group and the child was waited
/// on, so the backend can no longer change it.
///
/// # Errors
///
/// Returns an error when the child's PID is not a process group identifier,
/// `SIGKILL` cannot be sent, or the child cannot be waited on, which leaves it
/// unreaped and the list unread, or, after the child was waited on, when
/// sending `SIGTERM`, checking the group, or ending the listed MCP server
/// groups failed; the error then names every such failure.
fn stop_running_backend(
    child: &mut Child,
    stop_timeout: Duration,
    mcp_process_groups_path: &Path,
) -> Result<(), String> {
    let process_group = get_backend_process_group(child)?;
    let graceful_stop = send_backend_signal(process_group, Signal::SIGTERM)
        .and_then(|()| wait_for_backend_group_end(child, process_group, stop_timeout));
    send_backend_signal(process_group, Signal::SIGKILL)?;
    child
        .wait()
        .map_err(|err| format!("Failed to wait for backend process {process_group}: {err}"))?;
    let mcp_server_stop = stop_listed_mcp_server_groups(mcp_process_groups_path);
    build_backend_stop_outcome(graceful_stop.map(|_has_ended| ()), mcp_server_stop)
}

/// Returns the identifier of the backend's process group, which is the PID of
/// the child that leads it.
///
/// # Errors
///
/// Returns an error when the PID cannot be represented by `nix::unistd::Pid`.
fn get_backend_process_group(child: &Child) -> Result<Pid, String> {
    let pid = child.id();
    i32::try_from(pid)
        .map(Pid::from_raw)
        .map_err(|_| format!("Backend PID {pid} is outside the supported range"))
}

/// Waits until no process of the backend's process group is left, or
/// `timeout` passes, checking every [`BACKEND_EXIT_CHECK_INTERVAL`].
///
/// The direct child's exit alone does not end the wait: in development the
/// child is the `pnpm` script, which can exit before the backend it runs, and
/// a descendant left in the group can still be running. Each check reaps the
/// child once it exited and only then asks whether any other process of the
/// group is left, as [`has_process_group`] answers. Returns whether the group
/// ended.
///
/// # Errors
///
/// Returns an error when the child cannot be inspected or the group cannot be
/// checked.
fn wait_for_backend_group_end(
    child: &mut Child,
    process_group: Pid,
    timeout: Duration,
) -> Result<bool, String> {
    let deadline = Instant::now() + timeout;
    loop {
        let has_child_exited = child
            .try_wait()
            .map_err(|err| format!("Failed to inspect backend process: {err}"))?
            .is_some();
        if has_child_exited && !has_backend_process_group(process_group)? {
            return Ok(true);
        }
        let now = Instant::now();
        if now >= deadline {
            return Ok(false);
        }
        thread::sleep(BACKEND_EXIT_CHECK_INTERVAL.min(deadline - now));
    }
}

/// Answers whether any process of the backend's process group is left that a
/// stop has to wait for, as [`has_process_group`] answers.
///
/// # Errors
///
/// Returns an error when Unix rejects the check for a reason other than
/// `ESRCH` or `EPERM`.
fn has_backend_process_group(process_group: Pid) -> Result<bool, String> {
    has_process_group(process_group)
        .map_err(|err| format!("Failed to check backend process group {process_group}: {err}"))
}

/// Sends `signal` to the backend's Unix process group.
///
/// The backend command creates its child as a process-group leader, allowing
/// this operation to signal that child, such as the development `pnpm`
/// script, and its descendants as one unit. A group that is gone, or holds
/// only processes that exited but were not yet reaped, counts as signalled, as
/// [`send_process_group_signal`] describes: a stop finds that state once the
/// child it reaped was the last running process of the group.
///
/// # Errors
///
/// Returns an error when Unix rejects the signal for a reason other than
/// `ESRCH` or `EPERM`.
fn send_backend_signal(process_group: Pid, signal: Signal) -> Result<(), String> {
    send_process_group_signal(process_group, signal).map_err(|err| {
        format!("Failed to send {signal} to backend process group {process_group}: {err}")
    })
}

/// Sends `signal` to every process of a Unix process group.
///
/// A group that is gone, for which Unix reports `ESRCH`, counts as signalled,
/// and so does a group of which no process may receive the signal, for which
/// it reports `EPERM`; macOS reports `EPERM` for a group whose processes all
/// exited but were not yet reaped by their parents, which no signal can end.
///
/// # Errors
///
/// Returns the error Unix reports for any other reason.
fn send_process_group_signal(process_group: Pid, signal: Signal) -> Result<(), Errno> {
    match killpg(process_group, signal) {
        Ok(()) | Err(Errno::ESRCH | Errno::EPERM) => Ok(()),
        Err(err) => Err(err),
    }
}

/// Answers whether any process of a Unix process group is left that a stop
/// has to wait for.
///
/// A group that is gone answers `ESRCH`, and one of which no process may be
/// signalled answers `EPERM`, which macOS also answers for a group whose
/// processes all exited but were not yet reaped; neither has a process left
/// that a signal could end, so both answer `false`.
///
/// # Errors
///
/// Returns the error Unix reports for any other reason.
fn has_process_group(process_group: Pid) -> Result<bool, Errno> {
    match killpg(process_group, None) {
        Ok(()) => Ok(true),
        Err(Errno::ESRCH | Errno::EPERM) => Ok(false),
        Err(err) => Err(err),
    }
}

/// Sends `SIGKILL` to every MCP server process group the stopped backend still
/// listed in `list_path`, then deletes the list.
///
/// The backend lists, one decimal identifier per line, the groups of the stdio
/// MCP servers it has not seen end, so this reaches the servers of a backend
/// that did not end them before it was killed. A missing list holds no group.
/// A line that names no MCP server's group, as [`parse_mcp_server_group`]
/// defines it, is skipped, so a damaged list can never signal the host's own
/// group or every process the host may signal; the other lines are still
/// signalled, and the list is deleted in every case where it was read.
///
/// # Errors
///
/// Returns an error when the list cannot be read or deleted, when a line was
/// skipped, or when a listed group cannot be signalled for a reason other than
/// `ESRCH` or `EPERM`. The error names the first problems with lines, as
/// [`format_list_line_problems`] bounds them, and a failed deletion.
fn stop_listed_mcp_server_groups(list_path: &Path) -> Result<(), String> {
    let listing = match fs::read_to_string(list_path) {
        Ok(listing) => listing,
        Err(err) if err.kind() == ErrorKind::NotFound => return Ok(()),
        Err(err) => {
            return Err(format!(
                "Failed to read the MCP server process group list {}: {err}",
                list_path.display()
            ))
        }
    };
    let line_problems = send_listed_mcp_server_groups_sigkill(&listing, getpgrp());
    let deletion = delete_mcp_process_group_list(list_path);
    let problems: Vec<String> = format_list_line_problems(&line_problems)
        .into_iter()
        .chain(deletion.err())
        .collect();
    if problems.is_empty() {
        Ok(())
    } else {
        Err(problems.join("; "))
    }
}

/// Formats the problems with lines of the MCP server process group list,
/// naming at most [`LIST_LINE_PROBLEM_LIMIT`] of them, the first ones, and
/// counting the rest, or returns `None` when there is none.
fn format_list_line_problems(problems: &[String]) -> Option<String> {
    let (named, unnamed) = problems.split_at(problems.len().min(LIST_LINE_PROBLEM_LIMIT));
    match (named.is_empty(), unnamed.len()) {
        (true, _) => None,
        (false, 0) => Some(named.join("; ")),
        (false, count) => Some(format!(
            "{}; and {count} more problems with lines of the MCP server process group list",
            named.join("; ")
        )),
    }
}

/// Sends `SIGKILL` to the group each line of `listing` names, skipping lines
/// that name no MCP server's group.
///
/// Returns a description of each skipped line, by its number from 1, and of
/// each group that could not be signalled; empty when every line was signalled.
fn send_listed_mcp_server_groups_sigkill(listing: &str, host_process_group: Pid) -> Vec<String> {
    listing
        .lines()
        .enumerate()
        .filter_map(|(index, line)| {
            send_mcp_server_group_sigkill(line, index + 1, host_process_group).err()
        })
        .collect()
}

/// Sends `SIGKILL` to the MCP server process group one line of the list names.
///
/// # Errors
///
/// Returns an error when the line, number `line_number` of the list, names no
/// MCP server's group, or when Unix rejects the signal for a reason other
/// than `ESRCH` or `EPERM`.
fn send_mcp_server_group_sigkill(
    line: &str,
    line_number: usize,
    host_process_group: Pid,
) -> Result<(), String> {
    let process_group = parse_mcp_server_group(line, host_process_group).ok_or_else(|| {
        format!("Skipped line {line_number} of the MCP server process group list, which names no MCP server's process group")
    })?;
    send_process_group_signal(process_group, Signal::SIGKILL).map_err(|err| {
        format!("Failed to send SIGKILL to MCP server process group {process_group}: {err}")
    })
}

/// Parses one line of the MCP server process group list as the identifier of
/// a group a stop may signal.
///
/// Returns `None` for a line that is not a decimal number written with ASCII
/// digits only, for a number too large for a process identifier, for 0, which
/// `killpg` reads as the caller's own group, for 1, which it reads on Linux as
/// every process the caller may signal, and for `host_process_group`, the
/// host's own group.
fn parse_mcp_server_group(line: &str, host_process_group: Pid) -> Option<Pid> {
    if line.is_empty() || !line.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    let process_group = line
        .parse::<i32>()
        .ok()
        .filter(|&identifier| identifier > 1)
        .map(Pid::from_raw)?;
    (process_group != host_process_group).then_some(process_group)
}

/// Deletes the backend's list of MCP server process groups at `list_path`.
///
/// A list that does not exist counts as deleted.
///
/// # Errors
///
/// Returns an error when the file exists but cannot be deleted.
fn delete_mcp_process_group_list(list_path: &Path) -> Result<(), String> {
    match fs::remove_file(list_path) {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == ErrorKind::NotFound => Ok(()),
        Err(err) => Err(format!(
            "Failed to delete the MCP server process group list {}: {err}",
            list_path.display()
        )),
    }
}

/// Builds the outcome of a stop from its graceful part, `SIGTERM` and the wait
/// for the backend's group, and the stop of the listed MCP server groups.
///
/// Returns `Ok` when both succeeded, the one failure when one failed, and both
/// failures, the graceful one first, when both failed.
fn build_backend_stop_outcome(
    graceful_stop: Result<(), String>,
    mcp_server_stop: Result<(), String>,
) -> Result<(), String> {
    match (graceful_stop, mcp_server_stop) {
        (Ok(()), Ok(())) => Ok(()),
        (Err(failure), Ok(())) | (Ok(()), Err(failure)) => Err(failure),
        (Err(graceful_failure), Err(mcp_server_failure)) => {
            Err(format!("{graceful_failure}; {mcp_server_failure}"))
        }
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
/// child can always be stored, and the MCP server process group list an
/// earlier backend left is deleted under that lock before the spawn; the
/// returned status comes from a non-blocking inspection of the stored child.
///
/// # Errors
///
/// Returns an error when the backend directory cannot be resolved, process
/// state cannot be locked, an earlier backend's MCP server process group list
/// cannot be deleted, the script cannot be spawned, or the child cannot be
/// inspected; nothing is started after a failed deletion.
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

    // A list left by an earlier backend would let this backend's stop signal
    // groups that are not its servers'.
    delete_mcp_process_group_list(&backend.mcp_process_groups_path)?;

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
/// child can always be stored, and the MCP server process group list an
/// earlier backend left is deleted under that lock before the spawn; the
/// returned status comes from a non-blocking inspection of the stored child. A
/// missing backend bundle is not detected here: Node.js starts, reports the
/// missing file, and exits.
///
/// # Errors
///
/// Returns an error when process state cannot be locked, an earlier backend's
/// MCP server process group list cannot be deleted, the Node.js executable
/// cannot be spawned, for example because it is not installed under the Lys
/// home, or the child cannot be inspected; nothing is started after a failed
/// deletion.
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

    // A list left by an earlier backend would let this backend's stop signal
    // groups that are not its servers'.
    delete_mcp_process_group_list(&backend.mcp_process_groups_path)?;

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
/// created child can always be stored by this owner, and the MCP server
/// process group list an earlier backend left is deleted first. The returned
/// status is obtained with a non-blocking inspection of the stored child.
///
/// # Errors
///
/// Returns an error when the development backend directory cannot be resolved,
/// process state cannot be locked, an earlier backend's MCP server process
/// group list cannot be deleted, the child cannot be spawned, or the child
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
/// backend directory resolution, deleting an earlier backend's MCP server
/// process group list, spawning, or post-spawn inspection fails.
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
/// The command delegates to the mutex-protected owner, as [`Backend::stop`]
/// describes. A running backend's group gets `SIGTERM` and up to
/// [`BACKEND_STOP_TIMEOUT`] to end, then `SIGKILL` and a wait for the child,
/// and the MCP server process groups the backend still listed get `SIGKILL`;
/// an already-exited child is removed without another group kill. The stop
/// runs on Tauri's blocking-task pool, so the window stays responsive while it
/// waits; it cannot be cancelled. A stop called while another runs waits for
/// the owner's mutex and then finds no running child.
///
/// # Errors
///
/// Returns an error when process-state locking, inspection, signalling the
/// process group, child waiting, or ending the listed MCP server groups fails,
/// or when the blocking task ends unexpectedly.
pub async fn stop_backend(app: AppHandle) -> Result<BackendProcessStatus, String> {
    tauri::async_runtime::spawn_blocking(move || app.state::<Backend>().stop())
        .await
        .map_err(|err| format!("The backend stop ended unexpectedly: {err}"))?
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
        os::unix::{fs::PermissionsExt, process::ExitStatusExt},
        path::{Path, PathBuf},
        process::{Child, Command, ExitStatus, Stdio},
        sync::Mutex,
        thread,
        time::{Duration, Instant},
    };

    use nix::{
        sys::signal::{kill, killpg, Signal},
        unistd::Pid,
    };

    use super::{
        delete_mcp_process_group_list, format_list_line_problems, parse_mcp_server_group,
        spawn_prod_backend_process, Backend, CommandExt, LIST_LINE_PROBLEM_LIMIT,
    };
    use crate::{tools::test_directory::TestDirectory, utils::lys_home::LysHome};

    /// Stop timeout of the cases whose backend ignores `SIGTERM` or leaves a
    /// process that ignores it in its group.
    const SHORT_STOP_TIMEOUT: Duration = Duration::from_millis(300);

    /// Stop timeout of the cases whose backend group ends on `SIGTERM`; never
    /// reached, so a stop that takes this long shows that the group did not
    /// end or that the stop did not see it end.
    const LONG_STOP_TIMEOUT: Duration = Duration::from_secs(30);

    /// Longest a stop of a backend whose group ends on `SIGTERM` may take.
    const PROMPT_STOP_LIMIT: Duration = Duration::from_secs(5);

    /// Longest any case waits for a condition before it fails.
    const CONDITION_LIMIT: Duration = Duration::from_secs(10);

    /// Script of a loop that keeps a shell running.
    const KEEP_RUNNING: &str = "while :; do sleep 0.02; done";

    /// Name of the file in a case's directory in which its backend lists the
    /// process groups of its MCP servers.
    const MCP_PROCESS_GROUPS_FILE: &str = "mcp-process-groups";

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

    /// Stand-in for a stdio MCP server: a shell that the case starts as the
    /// leader of a process group of its own, as the backend starts its
    /// servers. Dropping it kills its group if it still runs and waits for it.
    struct McpServerStandIn(Child);

    impl McpServerStandIn {
        /// Starts a shell that keeps running in a process group of its own.
        fn start() -> Self {
            let child = Command::new("sh")
                .arg("-c")
                .arg(KEEP_RUNNING)
                .stderr(Stdio::null())
                .process_group(0)
                .spawn()
                .expect("start the MCP server stand-in");
            Self(child)
        }

        /// Returns the identifier of the stand-in's process group, which is
        /// the pid of the shell that leads it.
        fn get_process_group(&self) -> Pid {
            Pid::from_raw(i32::try_from(self.0.id()).expect("a pid that fits in i32"))
        }

        /// Waits until the stand-in has exited, failing the case after
        /// [`CONDITION_LIMIT`], and returns its exit status.
        fn wait_for_exit(&mut self) -> ExitStatus {
            let deadline = Instant::now() + CONDITION_LIMIT;
            loop {
                if let Some(status) = self.0.try_wait().expect("inspect the MCP server stand-in") {
                    return status;
                }
                assert!(
                    Instant::now() < deadline,
                    "timed out waiting until the MCP server stand-in has exited"
                );
                thread::sleep(Duration::from_millis(10));
            }
        }
    }

    impl Drop for McpServerStandIn {
        /// Kills the stand-in's group while its leader still runs, since the
        /// group's identifier can be reused once the leader was reaped, and
        /// waits for the leader.
        fn drop(&mut self) {
            if !matches!(self.0.try_wait(), Ok(None)) {
                return;
            }
            if let Err(error) = killpg(self.get_process_group(), Signal::SIGKILL) {
                assert!(thread::panicking(), "kill the MCP server stand-in: {error}");
            }
            if let Err(error) = self.0.wait() {
                assert!(
                    thread::panicking(),
                    "wait for the MCP server stand-in: {error}"
                );
            }
        }
    }

    /// Sends `SIGKILL` when dropped to a process a case started but cannot
    /// wait for, so that a failed assertion leaves it running no longer.
    #[cfg(target_os = "macos")]
    struct ProcessKillGuard(Pid);

    #[cfg(target_os = "macos")]
    impl Drop for ProcessKillGuard {
        /// Sends `SIGKILL` to the process, which may have exited already.
        fn drop(&mut self) {
            if let Err(error) = kill(self.0, Signal::SIGKILL) {
                assert!(
                    thread::panicking() || error == nix::errno::Errno::ESRCH,
                    "kill the case's process {}: {error}",
                    self.0
                );
            }
        }
    }

    /// Returns the case's MCP server process group list.
    fn get_mcp_process_groups_path(case: &TestDirectory) -> PathBuf {
        case.path().join(MCP_PROCESS_GROUPS_FILE)
    }

    /// Starts `script` with `sh`, in `case`'s directory, as the leader of a
    /// process group of its own, as the backend runs, and returns an owner of
    /// it with `stop_timeout` whose MCP server process group list is in that
    /// directory.
    fn start_backend(case: &TestDirectory, script: &str, stop_timeout: Duration) -> Backend {
        let child = Command::new("sh")
            .arg("-c")
            .arg(script)
            .current_dir(case.path())
            .stderr(Stdio::null())
            .process_group(0)
            .spawn()
            .expect("start the case's backend");
        Backend {
            process: Mutex::new(Some(child)),
            stop_timeout,
            mcp_process_groups_path: get_mcp_process_groups_path(case),
        }
    }

    /// Returns the script of a backend that sets `trap_action` as its
    /// `SIGTERM` trap, then writes `backend-ready` and keeps running.
    fn build_backend_script(trap_action: &str) -> String {
        format!("trap '{trap_action}' TERM; : > backend-ready; {KEEP_RUNNING}")
    }

    /// Starts `script` as [`start_backend`] does and waits until it wrote
    /// `backend-ready`, which a script built by [`build_backend_script`] does
    /// once it set its trap: a signal sent before would end it at once.
    fn start_ready_backend(case: &TestDirectory, script: &str, stop_timeout: Duration) -> Backend {
        let backend = start_backend(case, script, stop_timeout);
        wait_for_condition("the backend has set its trap", || {
            case.path().join("backend-ready").exists()
        });
        backend
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
        let descendant_ready = case.path().join("descendant-ready");
        let descendant = case.path().join("descendant.pid");
        let script = format!(
            "sh -c 'trap \"\" TERM; : > descendant-ready; {KEEP_RUNNING}' & echo $! > descendant.pid; {}",
            build_backend_script(trap_action)
        );
        let backend = start_ready_backend(case, &script, stop_timeout);
        wait_for_condition("the backend's descendant has set its trap", || {
            descendant_ready.exists()
        });
        (backend, read_pid_file(&descendant))
    }

    /// Creates, under the Lys home `case`, a stand-in for the release Node.js
    /// executable that writes `node-saw-no-list` there when it starts while
    /// the MCP server process group list does not exist, and exits.
    fn create_node_stand_in(case: &TestDirectory) {
        let node = case.create_file(
            "runtime/node/bin/node",
            format!(
                "#!/bin/sh\n[ -e \"$LYS_HOME/{MCP_PROCESS_GROUPS_FILE}\" ] || : > \"$LYS_HOME/node-saw-no-list\"\n"
            ),
        );
        fs::set_permissions(node, fs::Permissions::from_mode(0o755))
            .expect("make the Node.js stand-in executable");
    }

    #[test]
    fn stop_without_a_child_reports_stopped() {
        let case = TestDirectory::create("backend-no-child");
        let status = Backend::new(get_mcp_process_groups_path(&case))
            .stop()
            .unwrap();

        assert_eq!((status.pid, status.running), (None, false));
    }

    #[test]
    fn stop_succeeds_once_a_backend_that_exits_on_sigterm_leaves_its_group_empty() {
        let case = TestDirectory::create("backend-empty-group");
        let backend =
            start_ready_backend(&case, &build_backend_script("exit 0"), LONG_STOP_TIMEOUT);
        let _stop = BackendStopGuard(&backend);
        let started = Instant::now();

        let status = backend.stop().unwrap();

        assert!(
            started.elapsed() < PROMPT_STOP_LIMIT,
            "the stop returns once the backend's group is empty"
        );
        assert_eq!((status.pid, status.running), (None, false));
        assert!(backend.process.lock().unwrap().is_none());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn stop_succeeds_once_only_an_unreaped_process_is_left_in_the_group() {
        let case = TestDirectory::create("backend-zombie-group");
        // A member of the backend's group forks a child that exits at once,
        // never reaps it, and moves itself to a group of its own, so that the
        // unreaped child is all that the group holds once the backend exits.
        let member = "perl -e 'use POSIX (); my $zombie = fork(); POSIX::_exit(0) if $zombie == 0; setpgrp(0, 0); open(my $pids, \">\", \"zombie.tmp\") or die; print $pids \"$$ $zombie\"; close($pids); rename(\"zombie.tmp\", \"zombie.pids\") or die; sleep 30' &";
        let backend = start_ready_backend(
            &case,
            &format!("{member} {}", build_backend_script("exit 0")),
            LONG_STOP_TIMEOUT,
        );
        let _stop = BackendStopGuard(&backend);
        let pids_path = case.path().join("zombie.pids");
        wait_for_condition("the member has moved to a group of its own", || {
            pids_path.exists()
        });
        let pids = fs::read_to_string(&pids_path).expect("read the member's pids");
        let (member_pid, zombie_pid) = pids.split_once(' ').expect("two pids");
        let _member =
            ProcessKillGuard(Pid::from_raw(member_pid.parse().expect("the member's pid")));
        let started = Instant::now();

        let status = backend.stop().unwrap();

        assert!(
            started.elapsed() < PROMPT_STOP_LIMIT,
            "the stop returns once only an unreaped process is left in the group"
        );
        assert_eq!((status.pid, status.running), (None, false));
        let state = Command::new("ps")
            .args(["-o", "stat=", "-p", zombie_pid])
            .output()
            .expect("read the unreaped process's state");
        assert!(
            String::from_utf8_lossy(&state.stdout)
                .trim_start()
                .starts_with('Z'),
            "the group still held the unreaped process when the stop returned"
        );
    }

    #[test]
    fn stop_waits_for_a_group_member_that_outlives_the_direct_child() {
        let case = TestDirectory::create("backend-member");
        let member = format!(
            "sh -c 'trap \"sleep 0.3; : > member-ended; exit 0\" TERM; : > member-ready; {KEEP_RUNNING}' &"
        );
        let backend = start_ready_backend(
            &case,
            &format!("{member} {}", build_backend_script("exit 0")),
            LONG_STOP_TIMEOUT,
        );
        let _stop = BackendStopGuard(&backend);
        wait_for_condition("the group member has set its trap", || {
            case.path().join("member-ready").exists()
        });

        let status = backend.stop().unwrap();

        assert!(
            case.path().join("member-ended").exists(),
            "the stop waits until the member that outlived the direct child ended"
        );
        assert_eq!((status.pid, status.running), (None, false));
    }

    #[test]
    fn stop_sends_sigterm_first_and_kills_a_descendant_left_in_the_group() {
        let case = TestDirectory::create("backend-sigterm");
        let (backend, descendant) =
            start_trapping_backend(&case, ": > sigterm-received; exit 0", SHORT_STOP_TIMEOUT);
        let _stop = BackendStopGuard(&backend);

        let status = backend.stop().unwrap();

        assert!(
            case.path().join("sigterm-received").exists(),
            "the backend got SIGTERM before SIGKILL"
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
        let case = TestDirectory::create("backend-exited");
        let backend = start_backend(&case, "exit 0", LONG_STOP_TIMEOUT);
        wait_for_condition("the backend has exited", || {
            !backend.status().unwrap().running
        });

        let status = backend.stop().unwrap();

        assert_eq!((status.pid, status.running), (None, false));
        assert!(backend.process.lock().unwrap().is_none());
    }

    #[test]
    fn stop_kills_the_mcp_server_groups_a_hung_backend_still_listed() {
        let case = TestDirectory::create("backend-listed-servers");
        let mut server = McpServerStandIn::start();
        let backend = start_ready_backend(&case, &build_backend_script(""), SHORT_STOP_TIMEOUT);
        let _stop = BackendStopGuard(&backend);
        let list = case.create_file(
            MCP_PROCESS_GROUPS_FILE,
            format!("{}\n", server.get_process_group()),
        );

        backend.stop().unwrap();

        assert_eq!(
            server.wait_for_exit().signal(),
            Some(Signal::SIGKILL as i32)
        );
        assert!(!list.exists());
    }

    #[test]
    fn stop_reports_list_lines_that_name_no_mcp_server_group_and_kills_the_others() {
        let case = TestDirectory::create("backend-damaged-list");
        let mut server = McpServerStandIn::start();
        let backend =
            start_ready_backend(&case, &build_backend_script("exit 0"), LONG_STOP_TIMEOUT);
        let _stop = BackendStopGuard(&backend);
        let list = case.create_file(
            MCP_PROCESS_GROUPS_FILE,
            format!("abc\n+5\n99999999999\n{}\n", server.get_process_group()),
        );

        let error = backend.stop().unwrap_err();

        let skipped_lines = (1..=3)
            .map(|line| format!("Skipped line {line} of the MCP server process group list, which names no MCP server's process group"))
            .collect::<Vec<_>>();
        assert_eq!(error, skipped_lines.join("; "));
        assert_eq!(
            server.wait_for_exit().signal(),
            Some(Signal::SIGKILL as i32)
        );
        assert!(!list.exists());
        assert!(backend.process.lock().unwrap().is_none());
    }

    #[test]
    fn a_stop_that_cannot_read_the_list_still_removes_the_stopped_backend() {
        let case = TestDirectory::create("backend-unreadable-list");
        let backend =
            start_ready_backend(&case, &build_backend_script("exit 0"), LONG_STOP_TIMEOUT);
        let _stop = BackendStopGuard(&backend);
        let list = case.create_subdirectory(MCP_PROCESS_GROUPS_FILE);

        let error = backend.stop().unwrap_err();

        let expected_start = format!(
            "Failed to read the MCP server process group list {}: ",
            list.display()
        );
        assert!(error.starts_with(&expected_start), "{error}");
        assert!(backend.process.lock().unwrap().is_none());
    }

    #[test]
    fn a_list_line_names_an_mcp_server_group_only_as_ascii_digits_above_1() {
        let host_process_group = Pid::from_raw(4242);

        for line in [
            "",
            "abc",
            "12a",
            " 12",
            "12 ",
            "+5",
            "-5",
            "0",
            "1",
            "00",
            "٣",
            "2147483648",
        ] {
            assert_eq!(
                parse_mcp_server_group(line, host_process_group),
                None,
                "line {line:?}"
            );
        }
        assert_eq!(
            parse_mcp_server_group("2", host_process_group),
            Some(Pid::from_raw(2))
        );
        assert_eq!(
            parse_mcp_server_group("2147483647", host_process_group),
            Some(Pid::from_raw(i32::MAX))
        );
    }

    #[test]
    fn a_list_line_naming_the_hosts_own_group_names_no_mcp_server_group() {
        let host_process_group = Pid::from_raw(4242);

        assert_eq!(parse_mcp_server_group("4242", host_process_group), None);
        assert_eq!(
            parse_mcp_server_group("4243", host_process_group),
            Some(Pid::from_raw(4243))
        );
    }

    #[test]
    fn list_line_problems_name_the_first_ones_up_to_the_limit_and_count_the_rest() {
        let problems = (1..=LIST_LINE_PROBLEM_LIMIT + 2)
            .map(|line| format!("problem {line}"))
            .collect::<Vec<_>>();
        let named = problems[..LIST_LINE_PROBLEM_LIMIT].join("; ");

        assert_eq!(format_list_line_problems(&[]), None);
        assert_eq!(
            format_list_line_problems(&problems[..LIST_LINE_PROBLEM_LIMIT]),
            Some(named.clone())
        );
        assert_eq!(
            format_list_line_problems(&problems),
            Some(format!(
                "{named}; and 2 more problems with lines of the MCP server process group list"
            ))
        );
    }

    #[test]
    fn deleting_the_mcp_process_group_list_removes_it_and_accepts_a_missing_one() {
        let case = TestDirectory::create("backend-delete-list");
        let list = case.create_file(MCP_PROCESS_GROUPS_FILE, "1234\n");

        delete_mcp_process_group_list(&list).unwrap();
        assert!(!list.exists());
        delete_mcp_process_group_list(&list).unwrap();
    }

    #[test]
    fn deleting_an_mcp_process_group_list_that_cannot_be_removed_fails() {
        let case = TestDirectory::create("backend-delete-directory");
        let list = case.create_subdirectory(MCP_PROCESS_GROUPS_FILE);

        let error = delete_mcp_process_group_list(&list).unwrap_err();

        let expected_start = format!(
            "Failed to delete the MCP server process group list {}: ",
            list.display()
        );
        assert!(error.starts_with(&expected_start), "{error}");
        assert!(list.is_dir());
    }

    #[test]
    fn a_start_deletes_the_list_an_earlier_backend_left_before_it_starts_the_backend() {
        let case = TestDirectory::create("backend-start-stale-list");
        let lys_home = LysHome::from_test_directory(case.path());
        create_node_stand_in(&case);
        case.create_file(MCP_PROCESS_GROUPS_FILE, "1234\n");
        let backend = Backend::new(lys_home.mcp_process_groups_path());
        let _stop = BackendStopGuard(&backend);

        spawn_prod_backend_process(&backend, &lys_home).unwrap();

        wait_for_condition("the started backend saw no list", || {
            case.path().join("node-saw-no-list").exists()
        });
        assert!(!lys_home.mcp_process_groups_path().exists());
    }

    #[test]
    fn a_start_that_cannot_delete_the_earlier_list_starts_no_backend() {
        let case = TestDirectory::create("backend-start-undeletable-list");
        let lys_home = LysHome::from_test_directory(case.path());
        create_node_stand_in(&case);
        case.create_subdirectory(MCP_PROCESS_GROUPS_FILE);
        let backend = Backend::new(lys_home.mcp_process_groups_path());

        let error = spawn_prod_backend_process(&backend, &lys_home).unwrap_err();

        assert!(
            error.starts_with("Failed to delete the MCP server process group list"),
            "{error}"
        );
        assert!(backend.process.lock().unwrap().is_none());
    }
}
